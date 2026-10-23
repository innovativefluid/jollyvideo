import type { RouterRtpCodecCapability } from "mediasoup/types";

/** the codecs of Sharkord's voice routers (apps/server/src/runtimes/voice.ts, v0.0.28) */
export const SHARKORD_CODECS: RouterRtpCodecCapability[] = [
  { kind: "video", mimeType: "video/VP9", clockRate: 90000, parameters: { "profile-id": 0, "x-google-start-bitrate": 2000 } },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 2000 } },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1, "x-google-start-bitrate": 2000 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: { "packetization-mode": 1, "profile-level-id": "640032", "level-asymmetry-allowed": 1, "x-google-start-bitrate": 2000 },
  },
  { kind: "video", mimeType: "video/AV1", clockRate: 90000, parameters: { "x-google-start-bitrate": 2000 } },
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: { useinbandfec: 1, usedtx: 1, stereo: 1, "sprop-stereo": 1, maxplaybackrate: 48000, maxaveragebitrate: 128000 },
  },
];
