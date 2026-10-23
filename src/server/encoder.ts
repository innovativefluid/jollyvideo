/**
 * One ffmpeg per playing video: reads the downloaded file (or a livestream's
 * HLS playlist) in real time and sends H.264 and Opus as RTP to the two
 * mediasoup ports it is given.
 */
import { readLines, tail } from "./proc";
import type { TQuality } from "./settings";

export type TRtpTarget = { port: number; payloadType: number; ssrc: number };

export type TEncodeOptions = {
  ffmpeg: string;
  /** a file path, or an HLS URL for livestreams */
  input: string;
  live: boolean;
  /** seconds into the file to start at */
  start: number;
  quality: TQuality;
  /** request headers for the HLS playlist */
  headers?: Record<string, string>;
  video: TRtpTarget;
  audio: TRtpTarget;
};

export type TExit = { code: number; error: string };

export type TEncoder = {
  /** seconds of media sent so far */
  elapsed(): number;
  readonly exited: Promise<TExit>;
  stop(): Promise<void>;
};

export type TEncoderEvents = {
  /** the first media went out */
  started(): void;
};

/** the 16:9 box a quality fits video into, so ultrawide and portrait stay within the H.264 level */
export const boxWidth = (height: number): number => Math.round((height * 16) / 9 / 2) * 2;

/** the H.264 level each quality needs, as ffmpeg and the SDP profile-level-id spell it (Constrained Baseline) */
export const h264Level = (q: TQuality): { ffmpeg: string; profileLevelId: string } => {
  const macroblocksPerSecond = Math.ceil(boxWidth(q.height) / 16) * Math.ceil(q.height / 16) * q.fps;
  if (macroblocksPerSecond <= 108_000) return { ffmpeg: "3.1", profileLevelId: "42e01f" };
  if (macroblocksPerSecond <= 216_000) return { ffmpeg: "3.2", profileLevelId: "42e020" };
  if (macroblocksPerSecond <= 245_760) return { ffmpeg: "4.0", profileLevelId: "42e028" };
  return { ffmpeg: "4.2", profileLevelId: "42e02a" };
};

const rtpUrl = (port: number) => `rtp://127.0.0.1:${port}?pkt_size=1200`;

export const encoderArgs = (o: TEncodeOptions): string[] => {
  const q = o.quality;
  const kbps = `${q.videoKbps}k`;
  const userAgent = o.headers?.["User-Agent"];
  return [
    o.ffmpeg,
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-progress", "pipe:1",
    ...(!o.live && o.start > 0 ? ["-ss", String(o.start)] : []),
    ...(o.live && userAgent ? ["-user_agent", userAgent] : []),
    // real time for files, and for livestreams too: without it ffmpeg rushes
    // through the segments that are already out and then stalls
    "-re",
    "-i", o.input,

    "-map", "0:v:0",
    "-vf", `scale=w='min(iw,${boxWidth(q.height)})':h='min(ih,${q.height})':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
    "-fpsmax", String(q.fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level:v", h264Level(q).ffmpeg,
    "-pix_fmt", "yuv420p",
    "-b:v", kbps,
    "-maxrate", kbps,
    "-bufsize", kbps,
    // a keyframe every second: viewers who join, or a producer swap after a
    // seek, get a picture right away since nothing can ask ffmpeg for one
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-payload_type", String(o.video.payloadType),
    "-ssrc", String(o.video.ssrc),
    // mediasoup reports to viewers on its own; ffmpeg's reports would go to
    // port + 1, which can be another transport's port
    "-rtpflags", "skip_rtcp",
    "-f", "rtp", rtpUrl(o.video.port),

    "-map", "0:a:0",
    "-c:a", "libopus",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-payload_type", String(o.audio.payloadType),
    "-ssrc", String(o.audio.ssrc),
    "-rtpflags", "skip_rtcp",
    "-f", "rtp", rtpUrl(o.audio.port),
  ];
};

/** a livestream that stops moving for this long is treated as ended, so it can be restarted */
const STALL_MS = 20_000;

export const startEncoder = (options: TEncodeOptions, events: TEncoderEvents): TEncoder => {
  const child = Bun.spawn(encoderArgs(options), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let elapsed = 0;
  let started = false;
  let lastMove = Date.now();

  const watchdog = setInterval(() => {
    if (Date.now() - lastMove > STALL_MS) child.kill("SIGKILL");
  }, 2_000);

  const progress = readLines(child.stdout, (line) => {
    const match = /^out_time_us=(\d+)/.exec(line);
    if (!match) return;
    const seconds = Number(match[1]) / 1e6;
    if (seconds > elapsed) lastMove = Date.now();
    elapsed = Math.max(elapsed, seconds);
    if (!started && seconds > 0) {
      started = true;
      try {
        events.started();
      } catch {
        // the player deals with its own failures; reading must go on
      }
    }
  }).catch(() => {});

  const exited = (async (): Promise<TExit> => {
    const [error, code] = await Promise.all([tail(child.stderr, 1024), child.exited, progress]);
    clearInterval(watchdog);
    return { code, error: error.trim() };
  })();

  return {
    elapsed: () => elapsed,
    exited,
    async stop() {
      child.kill("SIGTERM");
      const done = await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
      if (!done) child.kill("SIGKILL");
      await exited;
    },
  };
};
