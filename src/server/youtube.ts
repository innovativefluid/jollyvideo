/**
 * Turning what someone typed into something to play: YouTube links and
 * searches only, looked up and downloaded with yt-dlp.
 */
import { existsSync } from "fs";
import path from "path";
import { MAX_QUERY_LENGTH } from "../contract";
import { UserError } from "./errors";
import { run, type TRunOptions } from "./proc";
import type { TQuality } from "./settings";

export type TSource =
  | { kind: "video"; videoId: string; start: number }
  | { kind: "channelLive"; url: string }
  | { kind: "search"; text: string };

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
  /** yt-dlp format selector for the download */
  format: string;
  /** frame rate of the picked video format, when known */
  fps: number | null;
  /** livestreams: the HLS playlist to read, and the headers it wants */
  hls?: { url: string; headers: Record<string, string> };
};

/** what the YouTube functions need from the server */
export type TYtDlp = {
  path: string;
  ffmpeg?: string;
  cookies?: string;
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
    throw new UserError("That link doesn't look right");
  }
  return null;
};

export const parseQuery = (input: string): TSource => {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) throw new UserError("Paste a YouTube link or type a search");
  if (text.length > MAX_QUERY_LENGTH) throw new UserError("That's too long");
  const url = toUrl(text);
  if (!url) return { kind: "search", text };
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !HOSTS.has(url.hostname.toLowerCase())) {
    throw new UserError("Only YouTube links work");
  }
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const parts = url.pathname.split("/").filter(Boolean);
  let videoId: string | undefined;
  if (url.hostname.toLowerCase() === "youtu.be") videoId = parts[0];
  else if (parts[0] === "watch") videoId = url.searchParams.get("v") ?? undefined;
  else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "") && parts.length === 2) videoId = parts[1];
  else if (CHANNEL_LIVE.test(url.pathname)) return { kind: "channelLive", url: `https://www.youtube.com${url.pathname.replace(/\/$/, "")}` };
  if (!videoId || !VIDEO_ID.test(videoId)) throw new UserError("That YouTube link isn't a video");
  return { kind: "video", videoId, start };
};

export const sourceArg = (source: TSource): string => {
  if (source.kind === "video") return `https://www.youtube.com/watch?v=${source.videoId}`;
  if (source.kind === "channelLive") return source.url;
  return `ytsearch1:${source.text}`;
};

/** options every yt-dlp call shares: nothing from a config file, one video, our runtime and cookies */
export const commonArgs = (tools: TYtDlp): string[] => [
  "--ignore-config",
  "--no-playlist",
  "--no-warnings",
  ...tools.jsRuntime.args,
  ...(tools.cookies ? ["--cookies", tools.cookies] : []),
];

/** turns yt-dlp's last error into something worth showing */
export const describeFailure = (stderr: string): string => {
  const line = stderr.split("\n").reverse().find((item) => item.startsWith("ERROR:")) ?? stderr;
  if (/confirm you.re not a bot|Sign in to confirm/i.test(line)) return "YouTube wants the server to sign in";
  if (/private video/i.test(line)) return "This video is private";
  if (/age|inappropriate/i.test(line) && /sign in|confirm/i.test(line)) return "This video is age-restricted";
  if (/members[- ]only|join this channel/i.test(line)) return "This video is for channel members";
  if (/live event will begin|premieres? in|is_upcoming/i.test(line)) return "This hasn't started yet";
  if (/unavailable|not available|removed|terminated/i.test(line)) return "This video isn't available";
  return "Couldn't load this video";
};

type TFormat = {
  format_id?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
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

export const pickFormat = (formats: TFormat[], q: TQuality): { format: string; fps: number | null } => {
  const fallback = `bv*[height<=${q.height}]+ba/b[height<=${q.height}]/bv*+ba/b`;
  const https = formats.filter((f) => usable(f) && (f.protocol ?? "https").startsWith("http"));
  const video = best(https.filter((f) => hasVideo(f) && !hasAudio(f) && f.height), videoKey(q));
  const audio = best(https.filter((f) => hasAudio(f) && !hasVideo(f)), audioKey);
  if (!video || !audio) return { format: fallback, fps: null };
  return { format: `${video.format_id}+${audio.format_id}/${fallback}`, fps: video.fps ?? null };
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
};

export const parseInfo = (stdout: string, source: TSource, q: TQuality): TResolved => {
  const line = stdout.split("\n").find((item) => item.startsWith("{"));
  if (!line) throw new UserError(source.kind === "search" ? "Nothing found" : "Couldn't load this video");
  const info = JSON.parse(line) as TInfo;
  const videoId = typeof info.id === "string" && VIDEO_ID.test(info.id) ? info.id : undefined;
  if (!videoId) throw new UserError("Couldn't load this video");
  if (info.live_status === "is_upcoming") throw new UserError("This hasn't started yet");
  const formats = Array.isArray(info.formats) ? (info.formats as TFormat[]) : [];
  const title = typeof info.title === "string" && info.title.trim() ? info.title.trim().slice(0, 200) : "YouTube video";
  const live = info.live_status === "is_live" || info.is_live === true;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  if (live) {
    const hls = pickLive(formats, q);
    if (!hls?.url) throw new UserError("Couldn't load this livestream");
    return { videoId, title, duration: 0, live, start: 0, url, format: "", fps: hls.fps ?? null, hls: { url: hls.url, headers: hls.http_headers ?? {} } };
  }
  const duration = typeof info.duration === "number" && Number.isFinite(info.duration) ? Math.max(0, Math.round(info.duration)) : 0;
  const start = source.kind === "video" && source.start < duration ? source.start : 0;
  return { videoId, title, duration, live, start, url, ...pickFormat(formats, q) };
};

export type TYouTube = {
  resolve(source: TSource, q: TQuality, signal: AbortSignal): Promise<TResolved>;
  download(video: TResolved, dir: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string>;
};

export const createYouTube = (tools: () => TYtDlp, log: { error(...args: unknown[]): void }): TYouTube => {
  const exec = (args: string[], options: TRunOptions) => {
    const ytDlp = tools();
    return run([ytDlp.path, ...commonArgs(ytDlp), ...args], { ...options, env: ytDlp.jsRuntime.env });
  };

  const fail = (stderr: string): never => {
    log.error("[yt-dlp]", stderr.trim().split("\n").slice(-3).join(" | "));
    throw new UserError(describeFailure(stderr));
  };

  return {
    async resolve(source, q, signal) {
      const result = await exec(["--no-progress", "-j", "--", sourceArg(source)], { signal, timeoutMs: 90_000 });
      if (result.code !== 0 && !result.stdout.startsWith("{")) fail(result.stderr);
      return parseInfo(result.stdout, source, q);
    },

    async download(video, dir, onProgress, signal) {
      const parts = video.format.split("/")[0]?.includes("+") ? 2 : 1;
      let part = 0;
      let last = 0;
      let file: string | undefined;
      const onLine = (line: string) => {
        const progress = /^\[jv\] (\d+) (\S+) (\S+)/.exec(line);
        if (!progress) {
          if (path.isAbsolute(line.trim())) file = line.trim();
          return;
        }
        const total = Number(progress[2]) || Number(progress[3]);
        if (!total) return;
        const fraction = Math.min(1, Number(progress[1]) / total);
        if (fraction < last - 0.5 && part < parts - 1) part++;
        last = fraction;
        onProgress(Math.min(0.99, (part + fraction) / parts));
      };
      const ytDlp = tools();
      const result = await exec(
        [
          "-f", video.format,
          "--merge-output-format", "mkv",
          "--max-filesize", "8G",
          "--no-part",
          "-o", path.join(dir, "%(id)s.%(ext)s"),
          ...(ytDlp.ffmpeg ? ["--ffmpeg-location", ytDlp.ffmpeg] : []),
          "--progress", "--newline",
          "--progress-template", "download:[jv] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
          "--print", "after_move:filepath",
          "--", video.url,
        ],
        { signal, timeoutMs: 3 * 3600_000, onLine },
      );
      if (result.code !== 0) fail(result.stderr);
      const resolved = file && path.resolve(file);
      if (!resolved || !resolved.startsWith(path.resolve(dir) + path.sep) || !existsSync(resolved)) {
        throw new UserError("This video is too large");
      }
      return resolved;
    },
  };
};
