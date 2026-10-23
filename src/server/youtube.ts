/**
 * Turning what someone typed into something to play: YouTube links, playlists
 * and searches only, looked up and downloaded with yt-dlp.
 */
import { existsSync } from "fs";
import { chmod, copyFile, rm } from "fs/promises";
import path from "path";
import { MAX_QUERY_LENGTH, MAX_QUEUE } from "../contract";
import type { TMessageKey } from "../i18n";
import { UserError } from "./errors";
import { limiter, run, type TRunOptions } from "./proc";
import type { TQuality } from "./settings";

export type TSource =
  | { kind: "video"; videoId: string; start: number }
  | { kind: "channelLive"; url: string }
  | { kind: "playlist"; listId: string }
  | { kind: "search"; text: string };

/** one stream of a video, downloaded on its own so playback can start early */
/** one format to download; `format` falls back to a similar one if YouTube no longer offers it */
export type TPart = { formatId: string; format: string; ext: string; size: number | null };

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
};

export type TPlaylistEntry = { videoId: string; title: string; duration: number };

/** what the YouTube functions need from the server */
export type TYtDlp = {
  path: string;
  ffmpeg?: string;
  cookies?: string;
  /** where each run gets its own copy of the cookies */
  scratch: string;
  jsRuntime: { args: string[]; env: Record<string, string | undefined> };
};

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

export const parseQuery = (input: string): TSource => {
  const text = input.trim().replace(/\s+/g, " ");
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

/** the original language over dubs, full range over YouTube's "drc" variant, Opus over AAC */
const audioKey = (f: TFormat): TKey => [
  -(f.language_preference ?? 0),
  /drc/i.test(`${f.format_id} ${f.format_note ?? ""}`),
  !(f.acodec ?? "").startsWith("opus"),
  -(f.abr ?? f.tbr ?? 0),
];

const SAFE_EXT = /^[a-z0-9]{2,5}$/;
const part = (f: TFormat, fallback: string): TPart => ({
  formatId: f.format_id!,
  format: `${f.format_id}/${fallback}`,
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
  return { parts: { video: part(video, `bv[height<=${q.height}]`), audio: part(audio, "ba") }, format, fps: video.fps ?? null };
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
};

const titleOf = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : fallback);
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
    if (!hls?.url) throw new UserError("yt.liveFailed");
    return { videoId, title, duration: 0, live, start: 0, url, parts: null, format: "", fps: hls.fps ?? null, hls: { url: hls.url, headers: hls.http_headers ?? {} } };
  }
  const duration = secondsOf(info.duration);
  const start = source.kind === "video" && source.start < duration ? source.start : 0;
  return { videoId, title, duration, live, start, url, ...pickFormat(formats, q) };
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
  resolve(source: TSource, q: TQuality, signal: AbortSignal): Promise<TResolved>;
  playlist(listId: string, signal: AbortSignal): Promise<TPlaylistEntry[]>;
  /** one format into `file`, written in order as it arrives, so it can be read while it grows */
  downloadPart(video: TResolved, part: TPart, file: string, onProgress: TProgress, signal: AbortSignal): Promise<void>;
  /** the whole video, merged into one file in `dir`, for videos without separate formats */
  downloadMerged(video: TResolved, dir: string, onProgress: TProgress, signal: AbortSignal): Promise<string>;
};

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
   * yt-dlp writes its cookies file back when it exits; runs at the same time,
   * or one killed halfway, would garble the admin's file. Each run gets a copy.
   */
  const exec = async (args: string[], options: TRunOptions) => {
    const ytDlp = tools();
    const cookies = ytDlp.cookies ? path.join(ytDlp.scratch, `cookies-${crypto.randomUUID()}.txt`) : undefined;
    try {
      if (cookies) {
        await copyFile(ytDlp.cookies!, cookies);
        await chmod(cookies, 0o600);
      }
      const cookieArgs = cookies ? ["--cookies", cookies] : [];
      return await run([ytDlp.path, ...commonArgs(ytDlp), ...cookieArgs, ...args], { ...options, env: ytDlp.jsRuntime.env });
    } finally {
      if (cookies) await rm(cookies, { force: true });
    }
  };

  const fail = (stderr: string): never => {
    log.error("[yt-dlp]", stderr.trim().split("\n").slice(-3).join(" | "));
    throw new UserError(describeFailure(stderr));
  };

  const downloadArgs = ["--max-filesize", "8G", "--no-part", "--progress", "--newline", "--progress-template", PROGRESS_TEMPLATE];

  return {
    async resolve(source, q, signal) {
      const result = await lookups(() => exec(["--no-playlist", "--no-progress", "-j", "--", sourceArg(source)], { signal, timeoutMs: 90_000 }), signal);
      if (result.code !== 0 && !result.stdout.startsWith("{")) fail(result.stderr);
      return parseInfo(result.stdout, source, q);
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
        ["--no-playlist", "-f", part.format, "--fixup", "never", ...downloadArgs, "-o", outputName(path.basename(file)), "--", video.url],
        { signal, timeoutMs: 3 * 3600_000, onLine, cwd: path.dirname(file) },
      );
      if (result.code !== 0) fail(result.stderr);
      if (!existsSync(file)) throw new UserError("yt.tooLarge");
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
          "--", video.url,
        ],
        { signal, timeoutMs: 3 * 3600_000, onLine, cwd: dir },
      );
      if (result.code !== 0) fail(result.stderr);
      if (!file || !file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) throw new UserError("yt.tooLarge");
      return file;
    },
  };
};
