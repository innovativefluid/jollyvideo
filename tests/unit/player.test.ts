import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { TEncodeOptions, TExit } from "../../src/server/encoder";
import { UserError } from "../../src/server/errors";
import type { TConnection, TLabel } from "../../src/server/output";
import { ChannelPlayer, type TPlayerDeps } from "../../src/server/player";
import { QUALITIES, type TSettings } from "../../src/server/settings";
import type { TResolved, TSource } from "../../src/server/youtube";

/** lets the player's promises, and its file system calls, settle */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Bun.sleep(1);
};

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(1);
  if (!condition()) throw new Error("timed out");
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const vod = (id: string, duration = 200, extra: Partial<TResolved> = {}): TResolved => ({
  videoId: id.padEnd(11, "x"),
  title: `Video ${id}`,
  duration,
  live: false,
  start: 0,
  url: `https://www.youtube.com/watch?v=${id}`,
  format: "136+251/b",
  fps: 30,
  ...extra,
});
const live = (id: string): TResolved => ({ ...vod(id, 0), live: true, hls: { url: `https://m/${id}.m3u8`, headers: {} } });

type TFakeEncoder = {
  options: TEncodeOptions;
  start(): void;
  elapsed: number;
  exit(code: number): void;
  stopped: boolean;
};

const setup = (videos: Record<string, TResolved | Error>, settingsOverride: Partial<TSettings> = {}) => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "jv-player-"));
  const encoders: TFakeEncoder[] = [];
  const downloads: { video: TResolved; signal: AbortSignal; done: ReturnType<typeof deferred<string>> }[] = [];
  const resolves: string[] = [];
  const published: TLabel[] = [];
  const connections: (TConnection & { closed: boolean })[] = [];
  let removed = 0;
  let slots = true;
  let freed = 0;
  let encodeError: Error | null = null;
  let clock = 0;
  const errors: unknown[] = [];

  const deps: TPlayerDeps = {
    settings: () => ({ quality: QUALITIES["720p30"]!, maxSeconds: 3600, maxStreams: 2, updateYtDlp: false, ...settingsOverride }),
    ready: async () => {},
    ffmpeg: () => "/ffmpeg",
    cacheDir,
    youtube: {
      async resolve(source: TSource) {
        const key = source.kind === "search" ? source.text : source.kind === "video" ? source.videoId : source.url;
        resolves.push(key);
        const found = videos[key];
        if (!found) throw new UserError("Nothing found");
        if (found instanceof Error) throw found;
        return { ...found };
      },
      download(video, _dir, onProgress, signal) {
        const done = deferred<string>();
        signal.addEventListener("abort", () => done.reject(new Error("aborted")));
        downloads.push({ video, signal, done });
        onProgress(0.5);
        return done.promise;
      },
    },
    createOutput: () => ({
      async connect() {
        const n = connections.length;
        const connection = {
          video: { port: 1000 + n, payloadType: 96, ssrc: n },
          audio: { port: 2000 + n, payloadType: 111, ssrc: n },
          closed: false,
          close() {
            connection.closed = true;
          },
        };
        connections.push(connection);
        return connection;
      },
      publish(_connection, label) {
        published.push(label);
      },
      relabel() {},
      remove() {
        removed++;
      },
    }),
    encode(options, events) {
      if (encodeError) throw encodeError;
      const exited = deferred<TExit>();
      const fake: TFakeEncoder = {
        options,
        elapsed: 0,
        stopped: false,
        start: () => events.started(),
        exit: (code) => exited.resolve({ code, error: "" }),
      };
      encoders.push(fake);
      return {
        elapsed: () => fake.elapsed,
        exited: exited.promise,
        async stop() {
          fake.stopped = true;
          exited.resolve({ code: 255, error: "" });
        },
      };
    },
    thumbnail: (videoId) => `/thumb/${videoId}.jpg`,
    slotFree: () => slots,
    slotFreed: () => freed++,
    changed: () => {},
    log: { log() {}, error: (...args) => errors.push(args) },
    now: () => clock,
  };
  const player = new ChannelPlayer(7, deps);
  return {
    player,
    encoders,
    downloads,
    resolves,
    published,
    connections,
    errors,
    cacheDir,
    removed: () => removed,
    setSlots: (value: boolean) => (slots = value),
    freed: () => freed,
    failEncode: (error: Error | null) => (encodeError = error),
    tick: (ms: number) => (clock += ms),
    /** finishes the download of video `id`, into file<id>.mkv */
    downloaded: async (id: string) => {
      await waitFor(() => downloads.some((d) => d.video.title === `Video ${id}`));
      downloads.find((d) => d.video.title === `Video ${id}`)!.done.resolve(path.join(cacheDir, `file${id}.mkv`));
      await flush();
    },
    download: (id: string) => downloads.find((d) => d.video.title === `Video ${id}`),
  };
};

let cleanup: string[] = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const start = async (videos: Record<string, TResolved | Error>, settings: Partial<TSettings> = {}) => {
  const t = setup(videos, settings);
  cleanup.push(t.cacheDir);
  return t;
};

describe("ChannelPlayer", () => {
  it("looks a video up, downloads it, plays it, and goes on air once ffmpeg sends", async () => {
    const t = await start({ a: vod("a") });
    t.player.add("a", 1);
    await flush();
    expect(t.player.snapshot().now).toMatchObject({ title: "Video a", state: "loading", progress: 0.5, thumbnail: "/thumb/axxxxxxxxxx.jpg" });
    await t.downloaded("a");
    expect(t.encoders).toHaveLength(1);
    expect(t.encoders[0]!.options).toMatchObject({ input: path.join(t.cacheDir, "filea.mkv"), start: 0, live: false });
    expect(t.published).toHaveLength(0);
    t.encoders[0]!.start();
    expect(t.published).toEqual([{ title: "Video a", bannerUrl: "/thumb/axxxxxxxxxx.jpg" }]);
    t.encoders[0]!.elapsed = 12.6;
    expect(t.player.snapshot().now).toMatchObject({ state: "playing", position: 12 });
    expect(t.player.busy).toBe(true);
  });

  it("starts at the link's time", async () => {
    const t = await start({ a: vod("a", 200, { start: 42 }) });
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    expect(t.encoders[0]!.options.start).toBe(42);
  });

  it("downloads the next video while one plays, then plays it, then takes the stream down", async () => {
    const t = await start({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.add("b", 2);
    await flush();
    expect(t.downloads.map((d) => d.video.title).sort()).toEqual(["Video a", "Video b"]);
    expect(t.player.snapshot().queue).toMatchObject([{ title: "Video b", state: "ready", progress: 0.5, addedBy: 2 }]);
    await t.downloaded("b");
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.encoders).toHaveLength(2);
    expect(t.encoders[1]!.options.input).toBe(path.join(t.cacheDir, "fileb.mkv"));
    t.encoders[1]!.start();
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video b" }, queue: [] });
    t.encoders[1]!.exit(0);
    await flush();
    expect(t.player.snapshot().now).toBeNull();
    expect(t.removed()).toBe(1);
    expect(t.player.busy).toBe(false);
  });

  it("pauses where it is and resumes from there with a new ffmpeg", async () => {
    const t = await start({ a: vod("a") });
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.encoders[0]!.elapsed = 30.4;
    t.player.pause();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.player.snapshot().now).toMatchObject({ state: "paused", position: 30 });
    await flush();
    expect(t.player.snapshot().now?.state).toBe("paused");
    t.player.resume();
    await flush();
    expect(t.encoders[1]!.options.start).toBeCloseTo(30.4);
    t.encoders[1]!.start();
    expect(t.player.snapshot().now?.state).toBe("playing");
    // the paused connection stayed on air (a still picture) until the new one replaced it
    expect(t.connections[0]!.closed).toBe(false);
    expect(t.published).toHaveLength(2);
  });

  it("seeks by restarting at the new place, within the video", async () => {
    const t = await start({ a: vod("a", 100) });
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.seek(500);
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.encoders[1]!.options.start).toBe(99);
    t.player.seek(-3);
    t.player.seek(20);
    await flush();
    // only the last of several quick seeks plays
    expect(t.encoders).toHaveLength(3);
    expect(t.encoders[2]!.options.start).toBe(20);
    expect(t.connections.filter((c) => c.closed)).toHaveLength(2);
  });

  it("remembers a seek made while downloading", async () => {
    const t = await start({ a: vod("a", 100) });
    t.player.add("a", 1);
    await flush();
    t.player.seek(50);
    await t.downloaded("a");
    expect(t.encoders[0]!.options.start).toBe(50);
  });

  it("retries a crashed video once from where it was", async () => {
    const t = await start({ a: vod("a", 200), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.encoders[0]!.elapsed = 50;
    t.encoders[0]!.exit(1);
    await flush();
    expect(t.encoders[1]!.options.start).toBe(50);
    t.encoders[1]!.start();
    t.encoders[1]!.exit(1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video b" }, error: "Playback failed" });
  });

  it("restarts a dropped livestream with a fresh playlist, but not forever", async () => {
    const t = await start({ l: live("l") });
    t.player.add("l", 1);
    await flush();
    expect(t.downloads).toHaveLength(0);
    expect(t.encoders[0]!.options).toMatchObject({ input: "https://m/l.m3u8", live: true });
    for (let i = 1; i <= 3; i++) {
      t.encoders[i - 1]!.start();
      t.encoders[i - 1]!.exit(1);
      t.tick(1000);
      await flush();
      expect(t.encoders).toHaveLength(i + 1);
    }
    expect(t.resolves).toEqual(["l", "l", "l", "l"]);
    t.encoders[3]!.exit(1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, error: "The livestream keeps dropping out" });
  });

  it("ends a livestream that is over without an error", async () => {
    const videos: Record<string, TResolved> = { l: live("l") };
    const t = await start(videos);
    t.player.add("l", 1);
    await flush();
    t.encoders[0]!.start();
    videos.l = vod("l", 3600);
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, error: null });
  });

  it("refuses to pause or seek a livestream", async () => {
    const t = await start({ l: live("l") });
    t.player.add("l", 1);
    await flush();
    expect(() => t.player.pause()).toThrow("can't be paused");
    expect(() => t.player.seek(10)).toThrow("can't be seeked");
  });

  it("drops what cannot be found or is too long, and says why", async () => {
    const t = await start({ long: vod("long", 7200), ok: vod("ok") }, { maxSeconds: 3600 });
    t.player.add("missing", 1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [], error: "Nothing found" });
    t.player.add("long", 1);
    await flush();
    expect(t.player.snapshot().error).toBe("Videos can be up to 60 minutes long");
    t.player.add("ok", 1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video ok" }, error: null });
  });

  it("logs unexpected failures and shows a plain message", async () => {
    const t = await start({ boom: new Error("spawn ENOENT /secret/path") });
    t.player.add("boom", 1);
    await flush();
    expect(t.player.snapshot().error).toBe("Something went wrong");
    expect(JSON.stringify(t.errors)).toContain("ENOENT");
  });

  it("leaves livestreams out of the length limit", async () => {
    const t = await start({ l: live("l") }, { maxSeconds: 60 });
    t.player.add("l", 1);
    await flush();
    expect(t.encoders).toHaveLength(1);
  });

  it("refuses a new video when the server is at its limit", async () => {
    const t = await start({ a: vod("a") });
    t.setSlots(false);
    expect(() => t.player.add("a", 1)).toThrow("Too many videos");
  });

  it("removes a queued video and stops its download", async () => {
    const t = await start({ a: vod("a"), b: vod("b"), c: vod("c") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    t.player.add("c", 1);
    await flush();
    const b = t.player.snapshot().queue[0]!;
    expect(b.title).toBe("Video b");
    expect(t.download("b")).toBeDefined();
    expect(t.download("c")).toBeUndefined();
    t.player.remove(b.id);
    await flush();
    expect(t.download("b")!.signal.aborted).toBe(true);
    // the next one in line downloads instead
    expect(t.download("c")).toBeDefined();
    expect(t.player.snapshot().queue.map((entry) => entry.title)).toEqual(["Video c"]);
  });

  it("stops everything at once", async () => {
    const t = await start({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.stop();
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.download("b")!.signal.aborted).toBe(true);
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [] });
    expect(t.removed()).toBe(1);
    expect(t.encoders).toHaveLength(1);
  });

  it("skips to the next video", async () => {
    const t = await start({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.skip();
    await t.downloaded("b");
    expect(t.encoders[1]!.options.input).toBe(path.join(t.cacheDir, "fileb.mkv"));
  });

  it("keeps the lock until it is lifted", async () => {
    const t = await start({});
    t.player.setLocked(true);
    expect(t.player.snapshot().locked).toBe(true);
    expect(t.player.isLocked).toBe(true);
    t.player.setLocked(false);
    expect(t.player.isLocked).toBe(false);
  });

  it("is done after destroy", async () => {
    const t = await start({ a: vod("a") });
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.destroy();
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.removed()).toBe(1);
    expect(() => t.player.add("a", 1)).toThrow(UserError);
  });

  it("says when it is too early to pause or seek", async () => {
    const t = await start({ a: vod("a") });
    t.player.add("a", 1);
    // not looked up yet
    expect(() => t.player.seek(10)).toThrow("Still loading");
    await flush();
    // looked up, still downloading
    expect(() => t.player.pause()).toThrow("Still loading");
    expect(t.player.snapshot().now?.state).toBe("loading");
  });

  it("closes the transports when ffmpeg cannot even start", async () => {
    const t = await start({ a: vod("a") });
    t.failEncode(new Error("spawn ENOENT"));
    t.player.add("a", 1);
    await flush();
    await t.downloaded("a");
    expect(t.connections).toHaveLength(1);
    expect(t.connections[0]!.closed).toBe(true);
    expect(t.player.snapshot()).toMatchObject({ now: null, error: "Something went wrong" });
  });

  it("waits for a free slot, and starts when it gets one", async () => {
    const t = await start({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.setSlots(false);
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [{ title: "Video b" }], error: "Too many videos are playing on this server" });
    expect(t.player.busy).toBe(false);
    t.setSlots(true);
    t.player.retry();
    await t.downloaded("b");
    expect(t.player.snapshot().now?.title).toBe("Video b");
    t.encoders[1]!.exit(0);
    await flush();
    expect(t.freed()).toBe(1);
  });

  it("counts its revision up with every change", async () => {
    const t = await start({ a: vod("a") });
    const before = t.player.snapshot().rev;
    t.player.setLocked(true);
    expect(t.player.snapshot().rev).toBeGreaterThan(before);
  });

  it("refuses more than a full queue", async () => {
    const t = await start({ a: vod("a") });
    for (let i = 0; i < 51; i++) t.player.add("a", 1);
    expect(() => t.player.add("a", 1)).toThrow("queue is full");
  });
});
