/**
 * Turning what someone typed into something to play: YouTube links, playlists
 * and searches only, looked up and downloaded with yt-dlp.
 */
import { existsSync } from "fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { MAX_QUERY_LENGTH, MAX_QUEUE, type TCaptionTrack, type TChapter, type TCue } from "../contract";
import type { TMessageKey } from "../i18n";
import { UserError } from "./errors";
import { isYouTubeImage } from "./thumbnails";
import { limiter, run, type TRunOptions } from "./proc";
import type { TQuality } from "./settings";

export type TSource =
  | { kind: "video"; videoId: string; start: number }
  | { kind: "channelLive"; url: string }
  | { kind: "playlist"; listId: string }
  | { kind: "search"; text: string };

/**
 * One stream of a video, downloaded on its own so playback can start early.
 * `format` falls back to a similar one if YouTube no longer offers it.
 * `copy`: stereo or mono Opus, which goes to Sharkord as it is.
 */
export type TPart = { formatId: string; format: string; codec: string; copy: boolean; ext: string; size: number | null };

export type TResolved = {
  videoId: string;
  title: string;
  /** seconds; 0 when unknown or live */
  duration: number;
  live: boolean;
  /** seconds to start at, from a link's `t=` */
  start: number;
  /** canonical watch URL */
  url: string;
  /** separate video and audio formats, when YouTube has them (it nearly always does) */
  parts: { video: TPart; audio: TPart } | null;
  /** otherwise: a yt-dlp format selector, downloaded and merged before playing */
  format: string;
  /** frame rate of the picked video format, when known */
  fps: number | null;
  /** livestreams: the HLS playlist to read, and the headers it wants */
  hls?: { url: string; headers: Record<string, string> };
  /** the lookup's info JSON on disk, so the downloads need not look the video up again */
  info?: string;
  /** caption languages: the uploader's, then YouTube's automatic ones in the video's language */
  captions: TCaptionTrack[];
  chapters: TChapter[];
  /** YouTube's storyboard for the time bar's preview, its sheets still on YouTube */
  storyboard: TSourceStoryboard | null;
};

export type TSourceStoryboard = { sheets: string[]; width: number; height: number; columns: number; rows: number; interval: number };

export type TLookupOptions = {
  /** jumps the queue of lookups: the video is needed now; asked again while it waits */
  urgent?: boolean | (() => boolean);
  /** where to keep the lookup's info JSON for the downloads */
  saveTo?: string;
};

export type TPlaylistEntry = { videoId: string; title: string; duration: number };

/** what the YouTube functions need from the server */
export type TYtDlp = {
  path: string;
  ffmpeg?: string;
  cookies?: string;
  /** where each run gets a temp folder of its own, with its copy of the cookies; cleared on load */
  scratch: string;
  jsRuntime: { args: string[]; env: Record<string, string> };
};

/**
 * What yt-dlp and the JavaScript it runs for YouTube get to see of the
 * server's environment: enough to run and to reach the internet, not
 * Sharkord's secrets.
 */
const PASSED_ENV = /^(PATH|PATHEXT|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_\w+|TZ|XDG_\w+|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|(HTTPS?|ALL|NO)_PROXY)$/i;

export const ytDlpEnv = (tools: TYtDlp, tmp: string, from: Record<string, string | undefined> = process.env): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) if (value !== undefined && PASSED_ENV.test(name)) env[name] = value;
  // PyInstaller unpacks itself into the run's own temp folder, which goes with the run
  return { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...tools.jsRuntime.env };
};

/** how long a stopped yt-dlp has to clean up before it is killed (proc.ts) and its folder removed */
const STOP_GRACE_MS = 3_000;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{10,64}$/;
const CHANNEL_LIVE = /^\/(@[\w.-]{1,100}|channel\/UC[\w-]{22}|c\/[\w.-]{1,100}|user\/[\w.-]{1,100})\/live\/?$/;

/** `90`, `90s`, `1m30s`, `1h2m3s` */
export const parseStart = (value: string | null): number => {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || value === "") return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
};

const toUrl = (text: string): URL | null => {
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return new URL(text);
    if (/^([\w-]+\.)*(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(text)) return new URL(`https://${text}`);
  } catch {
    throw new UserError("query.badLink");
  }
  return null;
};

/** control characters: nothing to show, and six bytes each in a push */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export const parseQuery = (input: string): TSource => {
  const text = input.replace(CONTROL, " ").trim().replace(/\s+/g, " ");
  if (!text) throw new UserError("query.empty");
  if (text.length > MAX_QUERY_LENGTH) throw new UserError("query.tooLong");
  const url = toUrl(text);
  if (!url) return { kind: "search", text };
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !HOSTS.has(url.hostname.toLowerCase())) {
    throw new UserError("query.notYouTube");
  }
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const parts = url.pathname.split("/").filter(Boolean);
  let videoId: string | undefined;
  if (url.hostname.toLowerCase() === "youtu.be") videoId = parts[0];
  // a video in a playlist plays that video; only the playlist page queues the list
  else if (parts[0] === "watch") videoId = url.searchParams.get("v") ?? undefined;
  else if (parts[0] === "playlist" && parts.length === 1) {
    const listId = url.searchParams.get("list");
    if (listId && LIST_ID.test(listId)) return { kind: "playlist", listId };
  } else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "") && parts.length === 2) videoId = parts[1];
  else if (CHANNEL_LIVE.test(url.pathname)) return { kind: "channelLive", url: `https://www.youtube.com${url.pathname.replace(/\/$/, "")}` };
  if (!videoId || !VIDEO_ID.test(videoId)) throw new UserError("query.notVideo");
  return { kind: "video", videoId, start };
};

export const sourceArg = (source: TSource): string => {
  if (source.kind === "video") return `https://www.youtube.com/watch?v=${source.videoId}`;
  if (source.kind === "channelLive") return source.url;
  if (source.kind === "playlist") return `https://www.youtube.com/playlist?list=${source.listId}`;
  return `ytsearch1:${source.text}`;
};

/** options every yt-dlp call shares: nothing from a config file, our JavaScript runtime */
export const commonArgs = (tools: TYtDlp): string[] => ["--ignore-config", "--no-warnings", ...tools.jsRuntime.args];

/** lookups across the whole server; each one is a yt-dlp with a JavaScript runtime */
const LOOKUPS_AT_ONCE = 2;

/** turns yt-dlp's last error into something worth showing */
export const describeFailure = (stderr: string): TMessageKey => {
  const line = stderr.split("\n").reverse().find((item) => item.startsWith("ERROR:")) ?? stderr;
  if (/no space left/i.test(stderr)) return "error.disk";
  if (/confirm you.re not a bot|Sign in to confirm/i.test(line)) return "yt.signIn";
  if (/private video/i.test(line)) return "yt.private";
  if (/age|inappropriate/i.test(line) && /sign in|confirm/i.test(line)) return "yt.ageRestricted";
  if (/members[- ]only|join this channel/i.test(line)) return "yt.members";
  if (/live event will begin|premieres? in|is_upcoming/i.test(line)) return "yt.notStarted";
  if (/unavailable|not available|removed|terminated/i.test(line)) return "yt.unavailable";
  return "yt.failed";
};

type TFormat = {
  format_id?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  protocol?: string;
  url?: string;
  dynamic_range?: string | null;
  language_preference?: number | null;
  audio_channels?: number | null;
  format_note?: string | null;
  has_drm?: boolean | string;
  http_headers?: Record<string, string>;
};

const hasVideo = (f: TFormat) => !!f.vcodec && f.vcodec !== "none";
const hasAudio = (f: TFormat) => !!f.acodec && f.acodec !== "none";
const usable = (f: TFormat) => !!f.format_id && !f.has_drm;
const codecRank = (vcodec = "") =>
  vcodec.startsWith("avc1") ? 0 : /^vp0?9/.test(vcodec) ? 1 : vcodec.startsWith("av01") ? 2 : 3;

type TKey = (number | boolean)[];
const compare = (a: TKey, b: TKey): number => {
  for (let i = 0; i < a.length; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff) return diff;
  }
  return 0;
};
const best = <T>(items: T[], key: (item: T) => TKey): T | undefined =>
  items.reduce<T | undefined>((top, item) => (top === undefined || compare(key(item), key(top)) < 0 ? item : top), undefined);

/**
 * The video format closest to the quality setting: as tall as allowed, at the
 * allowed frame rate, SDR (x264 has nothing to map HDR with), and the codec
 * that is cheapest to decode. Smaller keys win.
 */
const videoKey = (q: TQuality) => (f: TFormat): TKey => {
  const height = f.height ?? 0;
  const fps = f.fps ?? 30;
  return [height > q.height, height > q.height ? height : -height, (f.dynamic_range ?? "SDR") !== "SDR", fps > q.fps, -Math.min(fps, q.fps), codecRank(f.vcodec), -(f.tbr ?? 0)];
};

/** the original language over dubs, stereo over surround (Sharkord's audio is stereo), full range over YouTube's "drc" variant, Opus over AAC */
const audioKey = (f: TFormat): TKey => [
  -(f.language_preference ?? 0),
  (f.audio_channels ?? 2) > 2,
  /drc/i.test(`${f.format_id} ${f.format_note ?? ""}`),
  !(f.acodec ?? "").startsWith("opus"),
  -(f.abr ?? f.tbr ?? 0),
];

/** the containers YouTube serves, as file names; ffmpeg reads the content, not the name */
const SAFE_EXT = /^(mp4|m4a|webm|mkv|mov|3gp)$/;
const part = (f: TFormat, fallback: string, copy = false): TPart => ({
  formatId: f.format_id!,
  format: `${f.format_id}/${fallback}`,
  codec: (hasVideo(f) ? f.vcodec : f.acodec) ?? "",
  copy,
  ext: SAFE_EXT.test(f.ext ?? "") ? f.ext! : "bin",
  size: f.filesize ?? f.filesize_approx ?? null,
});

export const pickFormat = (formats: TFormat[], q: TQuality): Pick<TResolved, "parts" | "format" | "fps"> => {
  const format = `bv*[height<=${q.height}]+ba/b[height<=${q.height}]/bv*+ba/b`;
  const https = formats.filter((f) => usable(f) && (f.protocol ?? "https").startsWith("http"));
  const video = best(https.filter((f) => hasVideo(f) && !hasAudio(f) && f.height), videoKey(q));
  const audio = best(https.filter((f) => hasAudio(f) && !hasVideo(f)), audioKey);
  if (!video || !audio) return { parts: null, format, fps: null };
  // the download looks the video up again, and YouTube's formats can differ from one lookup to the next
  // stereo Opus is passed through to Sharkord as it is (RTP takes no surround Opus), so its stand-in has to be the same
  const copy = (audio.acodec ?? "").startsWith("opus") && (audio.audio_channels ?? 2) <= 2;
  return {
    parts: { video: part(video, `bv[height<=${q.height}]`), audio: part(audio, copy ? "ba[acodec=opus][audio_channels<=?2]" : "ba", copy) },
    format,
    fps: video.fps ?? null,
  };
};

export const pickLive = (formats: TFormat[], q: TQuality): TFormat | undefined =>
  best(
    formats.filter((f) => usable(f) && !!f.url && (f.protocol ?? "").startsWith("m3u8") && hasVideo(f) && hasAudio(f)),
    videoKey(q),
  );

type TInfo = {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  live_status?: unknown;
  is_live?: unknown;
  formats?: unknown;
  entries?: unknown;
  language?: unknown;
  subtitles?: unknown;
  automatic_captions?: unknown;
  chapters?: unknown;
};

/** frames this wide or less make a preview; the next larger set is a lot more to download */
const STORYBOARD_WIDTH = 160;
const MAX_SHEETS = 300;

type TStoryboardFormat = { format_note?: unknown; width?: unknown; height?: unknown; rows?: unknown; columns?: unknown; fragments?: unknown };

const whole = (value: unknown, max: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : 0);

/** the storyboard closest to STORYBOARD_WIDTH from below (else the smallest), with sheets on YouTube's image hosts */
export const pickStoryboard = (formats: unknown[]): TSourceStoryboard | null => {
  const boards = (formats as TStoryboardFormat[]).flatMap((format): TSourceStoryboard[] => {
    if (format?.format_note !== "storyboard" || !Array.isArray(format.fragments)) return [];
    const [width, height, columns, rows] = [whole(format.width, 1280), whole(format.height, 720), whole(format.columns, 20), whole(format.rows, 20)];
    const fragments = format.fragments as { url?: unknown; duration?: unknown }[];
    const first = Number(fragments[0]?.duration);
    if (!width || !height || !columns || !rows || !(first > 0) || !fragments.length || fragments.length > MAX_SHEETS) return [];
    const sheets = fragments.map((fragment) => (typeof fragment?.url === "string" ? fragment.url : ""));
    if (!sheets.every(isYouTubeImage)) return [];
    return [{ sheets, width, height, columns, rows, interval: first / (columns * rows) }];
  });
  const fitting = boards.filter((board) => board.width <= STORYBOARD_WIDTH).sort((a, b) => b.width - a.width);
  return fitting[0] ?? boards.sort((a, b) => a.width - b.width)[0] ?? null;
};

const MAX_CHAPTERS = 100;

/** the uploader's chapters, in order, each starting inside the video */
export const parseChapters = (value: unknown, duration: number): TChapter[] => {
  if (!Array.isArray(value) || duration <= 0) return [];
  const chapters: TChapter[] = [];
  for (const chapter of value as { start_time?: unknown; title?: unknown }[]) {
    const start = typeof chapter?.start_time === "number" && Number.isFinite(chapter.start_time) ? Math.max(0, Math.round(chapter.start_time)) : NaN;
    if (!(start < duration) || (chapters.length && start <= chapters.at(-1)!.start)) continue;
    chapters.push({ start, title: titleOf(chapter.title, "").slice(0, 100) });
    if (chapters.length >= MAX_CHAPTERS) break;
  }
  // one chapter is no chapters
  return chapters.length > 1 ? chapters : [];
};

const MAX_TRACKS = 30;
export const CAPTION_ID = /^[\w-]{1,32}$/;

/** the tracks of a captions map that come as json3, which is what is downloaded */
const tracksOf = (value: unknown): [string, { name?: unknown }][] =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>).flatMap(([id, formats]) => {
        if (!CAPTION_ID.test(id) || id === "live_chat" || !Array.isArray(formats)) return [];
        const json3 = (formats as { ext?: unknown; name?: unknown }[]).find((format) => format?.ext === "json3");
        return json3 ? [[id, json3] as [string, { name?: unknown }]] : [];
      })
    : [];

/**
 * The uploader's captions, and YouTube's automatic ones in the video's own
 * language only: it offers machine translations into some hundred more.
 */
export const parseCaptionTracks = (info: TInfo): TCaptionTrack[] => {
  const label = (id: string, name: unknown) => titleOf(name, id).slice(0, 60);
  const own = tracksOf(info.subtitles).map(([id, format]): TCaptionTrack => ({ id, label: label(id, format.name), auto: false }));
  const language = typeof info.language === "string" ? info.language : "";
  const automatic = new Map(tracksOf(info.automatic_captions));
  const autoId = [`${language}-orig`, language].find((id) => id && id !== "-orig" && automatic.has(id));
  const auto = autoId ? [{ id: autoId, label: label(autoId, automatic.get(autoId)!.name), auto: true }] : [];
  return [...own.slice(0, MAX_TRACKS - auto.length), ...auto];
};

const MAX_CUES = 20_000;
const MAX_CUE_TEXT = 300;

/** YouTube's json3 captions as lines; lines that only make room for the next are dropped */
export const parseCaptions = (text: string): TCue[] => {
  const events = (JSON.parse(text) as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const cues: TCue[] = [];
  for (const event of events as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown }[]) {
    if (cues.length >= MAX_CUES) break;
    const start = Number(event?.tStartMs);
    const duration = Number(event?.dDurationMs);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(event.segs)) continue;
    const line = (event.segs as { utf8?: unknown }[])
      .map((seg) => (typeof seg?.utf8 === "string" ? seg.utf8 : ""))
      .join("")
      .replace(CONTROL, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CUE_TEXT);
    if (line) cues.push([start, start + duration, line]);
  }
  return cues.sort((a, b) => a[0] - b[0]);
};

const titleOf = (value: unknown, fallback: string) => {
  const title = typeof value === "string" ? value.replace(CONTROL, " ").trim() : "";
  return title ? title.slice(0, 200) : fallback;
};
const secondsOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export const parseInfo = (stdout: string, source: TSource, q: TQuality): TResolved => {
  const line = stdout.split("\n").find((item) => item.startsWith("{"));
  if (!line) throw new UserError(source.kind === "search" ? "yt.nothingFound" : "yt.failed");
  const info = JSON.parse(line) as TInfo;
  const videoId = typeof info.id === "string" && VIDEO_ID.test(info.id) ? info.id : undefined;
  if (!videoId) throw new UserError("yt.failed");
  if (info.live_status === "is_upcoming") throw new UserError("yt.notStarted");
  const formats = Array.isArray(info.formats) ? (info.formats as TFormat[]) : [];
  const title = titleOf(info.title, "YouTube video");
  const live = info.live_status === "is_live" || info.is_live === true;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  if (live) {
    const hls = pickLive(formats, q);
    if (!hls?.url?.startsWith("https://")) throw new UserError("yt.liveFailed");
    return { videoId, title, duration: 0, live, start: 0, url, parts: null, format: "", fps: hls.fps ?? null, hls: { url: hls.url, headers: hls.http_headers ?? {} }, captions: [], chapters: [], storyboard: null };
  }
  const duration = secondsOf(info.duration);
  const start = source.kind === "video" && source.start < duration ? source.start : 0;
  return { videoId, title, duration, live, start, url, ...pickFormat(formats, q), captions: parseCaptionTracks(info), chapters: parseChapters(info.chapters, duration), storyboard: pickStoryboard(formats) };
};

/** a flat playlist: what can be played, without the private and deleted ones */
export const parsePlaylist = (stdout: string): TPlaylistEntry[] => {
  const line = stdout.split("\n").find((item) => item.startsWith("{"));
  const entries = line ? (JSON.parse(line) as TInfo).entries : undefined;
  if (!Array.isArray(entries)) return [];
  return (entries as TInfo[]).flatMap((entry) => {
    const title = titleOf(entry.title, "");
    if (typeof entry.id !== "string" || !VIDEO_ID.test(entry.id) || !title || /^\[(private|deleted) video\]$/i.test(title)) return [];
    return [{ videoId: entry.id, title, duration: secondsOf(entry.duration) }];
  });
};

/** downloaded and total bytes so far; total is null until yt-dlp knows it */
export type TProgress = (bytes: number, total: number | null) => void;

export type TYouTube = {
  resolve(source: TSource, q: TQuality, signal: AbortSignal, options?: TLookupOptions): Promise<TResolved>;
  playlist(listId: string, signal: AbortSignal): Promise<TPlaylistEntry[]>;
  /** one format into `file`, written in order as it arrives, so it can be read while it grows */
  downloadPart(video: TResolved, part: TPart, file: string, onProgress: TProgress, signal: AbortSignal): Promise<void>;
  /** the whole video, merged into one file in `dir`, for videos without separate formats */
  downloadMerged(video: TResolved, dir: string, onProgress: TProgress, signal: AbortSignal): Promise<string>;
  /** one caption track of the video, downloaded into `dir` and read */
  captions(video: TResolved, track: TCaptionTrack, dir: string, signal: AbortSignal): Promise<TCue[]>;
};

/** a captions file larger than this is not read */
const MAX_CAPTIONS_BYTES = 8 * 1024 * 1024;

/**
 * A file name for `-o`, which is a template: % is escaped. Downloads run in
 * their folder and get a bare name, since yt-dlp also expands $VARIABLES in
 * paths.
 */
const outputName = (name: string) => name.replaceAll("%", "%%");

const PROGRESS_TEMPLATE = "download:[jv] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s";

const progressLine = (line: string): { bytes: number; total: number | null } | null => {
  const match = /^\[jv\] (\d+) (\S+) (\S+)/.exec(line);
  if (!match) return null;
  return { bytes: Number(match[1]), total: Number(match[2]) || Number(match[3]) || null };
};

export const createYouTube = (tools: () => TYtDlp, log: { error(...args: unknown[]): void }): TYouTube => {
  const lookups = limiter(LOOKUPS_AT_ONCE);

  /**
   * Each run gets a temp folder of its own: for what yt-dlp unpacks when it
   * starts (left behind when it is stopped early), and for a copy of the
   * cookies, since yt-dlp writes its cookies file back when it exits and runs
   * at the same time, or one killed halfway, would garble the admin's file.
   * Lookups also run in it, so a JavaScript runtime finds no .env of the
   * server's there.
   */
  const exec = async (args: string[], options: TRunOptions) => {
    const ytDlp = tools();
    const tmp = path.join(ytDlp.scratch, crypto.randomUUID());
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    try {
      let cookieArgs: string[] = [];
      if (ytDlp.cookies) {
        const cookies = path.join(tmp, "cookies.txt");
        await copyFile(ytDlp.cookies, cookies);
        await chmod(cookies, 0o600);
        cookieArgs = ["--cookies", cookies];
      }
      return await run([ytDlp.path, ...commonArgs(ytDlp), ...cookieArgs, ...args], { cwd: tmp, ...options, env: ytDlpEnv(ytDlp, tmp) });
    } finally {
      const remove = () => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      await remove();
      // a stopped run's last processes may still be cleaning up
      setTimeout(remove, STOP_GRACE_MS).unref?.();
    }
  };

  const fail = (stderr: string): never => {
    log.error("[yt-dlp]", stderr.trim().split("\n").slice(-3).join(" | "));
    throw new UserError(describeFailure(stderr));
  };

  const downloadArgs = ["--max-filesize", "8G", "--no-part", "--progress", "--newline", "--progress-template", PROGRESS_TEMPLATE];
  /** the lookup's info JSON when there is one (no second lookup), the video's page otherwise */
  const videoArgs = (video: TResolved, cwd: string) => (video.info ? ["--load-info-json", path.relative(cwd, video.info)] : ["--", video.url]);

  return {
    async resolve(source, q, signal, options = {}) {
      const result = await lookups(
        () => exec(["--no-playlist", "--no-progress", "-j", "--", sourceArg(source)], { signal, timeoutMs: 90_000 }),
        signal,
        options.urgent,
      );
      if (result.code !== 0 && !result.stdout.startsWith("{")) fail(result.stderr);
      const video = parseInfo(result.stdout, source, q);
      if (options.saveTo && !video.live) {
        await writeFile(options.saveTo, result.stdout.split("\n").find((line) => line.startsWith("{"))!);
        video.info = options.saveTo;
      }
      return video;
    },

    async playlist(listId, signal) {
      const url = sourceArg({ kind: "playlist", listId });
      const result = await lookups(
        () => exec(["--flat-playlist", "--playlist-items", `1:${MAX_QUEUE}`, "--no-progress", "-J", "--", url], { signal, timeoutMs: 90_000 }),
        signal,
      );
      if (result.code !== 0 && !result.stdout.startsWith("{")) fail(result.stderr);
      const entries = parsePlaylist(result.stdout);
      if (!entries.length) throw new UserError("yt.playlistEmpty");
      return entries;
    },

    async downloadPart(video, part, file, onProgress, signal) {
      const onLine = (line: string) => {
        const progress = progressLine(line);
        if (progress) onProgress(progress.bytes, progress.total);
      };
      const result = await exec(
        // no fixups: they would rewrite the file while ffmpeg reads it
        ["--no-playlist", "-f", part.format, "--fixup", "never", ...downloadArgs, "-o", outputName(path.basename(file)), ...videoArgs(video, path.dirname(file))],
        { signal, timeoutMs: 3 * 3600_000, onLine, cwd: path.dirname(file) },
      );
      if (result.code !== 0) fail(result.stderr);
      if (!existsSync(file)) throw new UserError("yt.tooLarge");
    },

    async captions(video, track, dir, signal) {
      const result = await lookups(
        () =>
          exec(
            [
              "--no-playlist",
              "--skip-download",
              track.auto ? "--write-auto-subs" : "--write-subs",
              "--sub-langs", track.id,
              "--sub-format", "json3",
              "-o", "captions",
              ...videoArgs(video, dir),
            ],
            { signal, timeoutMs: 90_000, cwd: dir },
          ),
        signal,
        true,
      );
      const file = Bun.file(path.join(dir, `captions.${track.id}.json3`));
      if (result.code !== 0) fail(result.stderr);
      if (!(await file.exists())) throw new UserError("error.captions");
      if (file.size > MAX_CAPTIONS_BYTES) throw new UserError("error.captions");
      return parseCaptions(await file.text());
    },

    async downloadMerged(video, dir, onProgress, signal) {
      let file: string | undefined;
      const onLine = (line: string) => {
        const progress = progressLine(line);
        if (progress) onProgress(progress.bytes, progress.total);
        // the --print line: where the merged file went
        else if (line.trim()) file = path.resolve(dir, line.trim());
      };
      const ytDlp = tools();
      const result = await exec(
        [
          "--no-playlist",
          "-f", video.format,
          "--merge-output-format", "mkv",
          ...downloadArgs,
          "-o", "%(id)s.%(ext)s",
          ...(ytDlp.ffmpeg ? ["--ffmpeg-location", ytDlp.ffmpeg] : []),
          "--print", "after_move:filepath",
          ...videoArgs(video, dir),
        ],
        { signal, timeoutMs: 3 * 3600_000, onLine, cwd: dir },
      );
      if (result.code !== 0) fail(result.stderr);
      if (!file || !file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) throw new UserError("yt.tooLarge");
      return file;
    },
  };
};
