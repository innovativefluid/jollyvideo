/**
 * Real ffmpeg into a real mediasoup router, checked the way a viewer receives
 * it. Needs an ffmpeg with libx264 and libopus: JOLLYVIDEO_FFMPEG, or one on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import * as mediasoup from "mediasoup";
import type { Producer, Router, Worker } from "mediasoup/types";
import os from "os";
import path from "path";
import type { TPlayer } from "../../src/contract";
import { h264Level, startEncoder, type TEncoder } from "../../src/server/encoder";
import { onLoad, onUnload } from "../../src/server/index";
import { createOutput, type TVoice } from "../../src/server/output";
import { QUALITIES, type TQuality } from "../../src/server/settings";
import { fakeHost, fakeYtDlp } from "../helpers/fake-host";
import { capture } from "../helpers/rtp";
import { SHARKORD_CODECS } from "../helpers/sharkord";

const ffmpeg = process.env.JOLLYVIDEO_FFMPEG ?? Bun.which("ffmpeg");
if (!ffmpeg) throw new Error("the media tests need ffmpeg: set JOLLYVIDEO_FFMPEG or put it on PATH");

const dir = mkdtempSync(path.join(os.tmpdir(), "jv-media-"));
const fixture = path.join(dir, "fixture.mkv");
let worker: Worker;
let router: Router;

const run = async (args: string[]) => {
  const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

/** a voice runtime that keeps the streams it is given */
const recordingVoice = () => {
  const streams: { producers: { audio?: Producer; video?: Producer }; removed: boolean }[] = [];
  const voice: TVoice = {
    getRouter: () => router,
    createStream: (options) => {
      const stream = { producers: options.producers, removed: false };
      streams.push(stream);
      return {
        update: (update) => {
          if (update.producers) {
            stream.producers.audio?.close();
            stream.producers.video?.close();
            stream.producers = update.producers;
          }
        },
        remove: () => {
          stream.removed = true;
        },
      };
    },
  };
  return { voice, streams };
};

/** plays `input` until ffmpeg has sent media, and returns what is on air */
const play = async (quality: TQuality, input: string, extra: { live?: boolean; start?: number } = {}) => {
  const { voice, streams } = recordingVoice();
  const output = createOutput(voice, 1, "test");
  const connection = await output.connect(h264Level(quality).profileLevelId);
  let onAir!: () => void;
  const started = new Promise<void>((resolve) => (onAir = resolve));
  const encoder: TEncoder = startEncoder(
    { ffmpeg, input, live: extra.live ?? false, start: extra.start ?? 0, quality, video: connection.video, audio: connection.audio },
    {
      started: () => {
        output.publish(connection, { title: "t" });
        onAir();
      },
    },
  );
  await Promise.race([started, encoder.exited.then((exit) => Promise.reject(new Error(`ffmpeg exited ${exit.code}: ${exit.error}`)))]);
  return { output, encoder, stream: streams[0]!, streams };
};

const measure = async (producer: Producer, ms: number) => {
  const captured = await capture(router, producer);
  await Bun.sleep(ms);
  captured.close();
  return captured;
};

beforeAll(async () => {
  // 1080p60 with stereo sound, long enough for every test
  await run([
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-c:a", "libopus", "-ac", "2", fixture,
  ]);
  worker = await mediasoup.createWorker({ logLevel: "error" });
  router = await worker.createRouter({ mediaCodecs: SHARKORD_CODECS });
}, 60_000);

afterAll(() => {
  worker?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a file", () => {
  it("arrives at 30 fps in Constrained Baseline 3.1, with a keyframe every second, and sound", async () => {
    const { encoder, stream, output } = await play(QUALITIES["720p30"]!, fixture);
    // past ffmpeg's initial half second burst
    await Bun.sleep(1000);
    const [video, audio] = await Promise.all([measure(stream.producers.video!, 3000), measure(stream.producers.audio!, 3000)]);
    await encoder.stop();
    output.remove();
    expect(video.frames).toBeGreaterThanOrEqual(80);
    expect(video.frames).toBeLessThanOrEqual(95);
    expect(video.keyframes).toBeGreaterThanOrEqual(2);
    expect([video.profile, video.level]).toEqual([66, 31]);
    // Opus in 20 ms packets
    expect(audio.packets).toBeGreaterThanOrEqual(130);
    expect(stream.removed).toBe(true);
  }, 20_000);

  it("keeps 60 fps at a 60 fps quality, at level 3.2", async () => {
    const { encoder, stream, output } = await play(QUALITIES["720p60"]!, fixture);
    const video = await measure(stream.producers.video!, 2000);
    await encoder.stop();
    output.remove();
    expect(video.frames).toBeGreaterThanOrEqual(105);
    expect(video.level).toBe(32);
  }, 20_000);

  it("plays from a seek position in real time", async () => {
    const { encoder, output } = await play(QUALITIES["480p30"]!, fixture, { start: 20 });
    await Bun.sleep(2000);
    const elapsed = encoder.elapsed();
    await encoder.stop();
    output.remove();
    expect(elapsed).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(3.5);
  }, 20_000);

  it("ends by itself at the end of the file", async () => {
    const short = path.join(dir, "short.mkv");
    await run(["-i", fixture, "-t", "2", "-c", "copy", short]);
    const { encoder, output } = await play(QUALITIES["480p30"]!, short);
    expect((await encoder.exited).code).toBe(0);
    output.remove();
  }, 20_000);

  it("swaps to a new ffmpeg and new producers without losing the stream", async () => {
    const quality = QUALITIES["480p30"]!;
    const { voice, streams } = recordingVoice();
    const output = createOutput(voice, 1, "test");
    const runs: TEncoder[] = [];
    for (const start of [0, 10]) {
      const connection = await output.connect(h264Level(quality).profileLevelId);
      await new Promise<void>((resolve) => {
        runs.push(
          startEncoder({ ffmpeg, input: fixture, live: false, start, quality, video: connection.video, audio: connection.audio }, {
            started: () => {
              output.publish(connection, { title: "t" });
              resolve();
            },
          }),
        );
      });
      if (start === 0) await runs[0]!.stop();
    }
    expect(streams).toHaveLength(1);
    const video = await measure(streams[0]!.producers.video!, 1500);
    expect(video.frames).toBeGreaterThan(20);
    expect(video.keyframes).toBeGreaterThanOrEqual(1);
    await runs[1]!.stop();
    output.remove();
  }, 20_000);
});

describe("a livestream", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let source: ReturnType<typeof Bun.spawn> | undefined;

  afterAll(() => {
    source?.kill();
    void server?.stop(true);
  });

  it("is read from its HLS playlist in real time", async () => {
    const hls = path.join(dir, "hls");
    mkdirSync(hls);
    // a live playlist that keeps growing, like YouTube's
    source = Bun.spawn(
      [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-re",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac",
        "-f", "hls", "-hls_time", "1", "-hls_list_size", "6", "-hls_flags", "delete_segments",
        path.join(hls, "live.m3u8"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(Bun.file(path.join(hls, path.basename(new URL(req.url).pathname)))) });
    for (let i = 0; i < 100 && !(await Bun.file(path.join(hls, "live.m3u8")).exists()); i++) await Bun.sleep(100);
    await Bun.sleep(3000);

    const { encoder, stream, output } = await play(QUALITIES["720p30"]!, `http://127.0.0.1:${server.port}/live.m3u8`, { live: true });
    const begun = encoder.elapsed();
    const video = await measure(stream.producers.video!, 3000);
    const elapsed = encoder.elapsed() - begun;
    await encoder.stop();
    output.remove();
    expect(video.frames).toBeGreaterThan(60);
    // real time: not rushing through the segments already out
    expect(elapsed).toBeGreaterThan(2);
    expect(elapsed).toBeLessThan(4);
  }, 30_000);
});

describe("the whole plugin", () => {
  it("downloads with yt-dlp and plays into the voice channel", async () => {
    process.env.JV_FIXTURE = fixture;
    process.env.JOLLYVIDEO_YT_DLP = fakeYtDlp(dir, {
      id: "aqz-KE-bpKQ",
      title: "Fixture",
      duration: 30,
      formats: [],
    });
    process.env.JOLLYVIDEO_FFMPEG = ffmpeg;
    const host = fakeHost({ router, dataPath: path.join(dir, "data") });
    try {
      await onLoad(host.ctx as never);
      await host.action("add", 1, 3, { query: "fixture" });
      for (let i = 0; i < 100 && (host.pushes.at(-1)?.data as TPlayer | undefined)?.now?.state !== "playing"; i++) await Bun.sleep(100);
      expect((host.pushes.at(-1)?.data as TPlayer).now).toMatchObject({ title: "Fixture", state: "playing" });
      const producers = host.streams[0]!.options.producers as { audio: Producer; video: Producer };
      const video = await measure(producers.video, 1500);
      expect(video.frames).toBeGreaterThan(30);
      await host.command("watch-stop", 1, 3);
      expect(host.streams[0]!.removed).toBe(true);
    } finally {
      onUnload();
      delete process.env.JV_FIXTURE;
      delete process.env.JOLLYVIDEO_YT_DLP;
      delete process.env.JOLLYVIDEO_FFMPEG;
    }
  }, 30_000);
});
