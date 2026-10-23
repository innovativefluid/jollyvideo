/** Admin settings: one quality choice instead of separate size, rate and bitrate knobs. */

export type TQuality = {
  height: number;
  fps: number;
  videoKbps: number;
};

export const QUALITIES: Record<string, TQuality> = {
  "480p30": { height: 480, fps: 30, videoKbps: 1200 },
  "720p30": { height: 720, fps: 30, videoKbps: 2500 },
  "720p60": { height: 720, fps: 60, videoKbps: 4000 },
  "1080p30": { height: 1080, fps: 30, videoKbps: 4500 },
  "1080p60": { height: 1080, fps: 60, videoKbps: 6500 },
};

const DEFAULT_QUALITY = "720p60";

export const SETTINGS = [
  {
    key: "quality",
    name: "Video quality",
    description: "Higher quality needs more CPU on the server.",
    type: "enum",
    defaultValue: DEFAULT_QUALITY,
    options: [
      { value: "480p30", label: "480p, 30 fps" },
      { value: "720p30", label: "720p, 30 fps" },
      { value: "720p60", label: "720p, 60 fps" },
      { value: "1080p30", label: "1080p, 30 fps" },
      { value: "1080p60", label: "1080p, 60 fps" },
    ],
  },
  {
    key: "maxMinutes",
    name: "Longest video (minutes)",
    description: "0 means no limit. Livestreams are never limited.",
    type: "number",
    defaultValue: 240,
  },
  {
    key: "maxStreams",
    name: "Videos at once",
    description: "Across all voice channels. Each one keeps a CPU core busy.",
    type: "number",
    defaultValue: 2,
  },
  {
    key: "updateYtDlp",
    name: "Update yt-dlp weekly",
    description: "YouTube changes often; an old yt-dlp stops working.",
    type: "boolean",
    defaultValue: true,
  },
] as const;

export type TSettings = {
  quality: TQuality;
  /** 0 = no limit */
  maxSeconds: number;
  maxStreams: number;
  updateYtDlp: boolean;
};

type TReader = { get(key: string): unknown };

const wholeNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

export const readSettings = (reader: TReader | undefined): TSettings => {
  const quality = QUALITIES[String(reader?.get("quality") ?? DEFAULT_QUALITY)] ?? QUALITIES[DEFAULT_QUALITY]!;
  const updateYtDlp = reader?.get("updateYtDlp");
  return {
    quality,
    maxSeconds: wholeNumber(reader?.get("maxMinutes"), 240, 0, 24 * 60) * 60,
    maxStreams: wholeNumber(reader?.get("maxStreams"), 2, 1, 20),
    updateYtDlp: typeof updateYtDlp === "boolean" ? updateYtDlp : true,
  };
};
