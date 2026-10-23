import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { TEncodeOptions, TEncoderEvents, TExit } from "../../src/server/encoder";
import { UserError } from "../../src/server/errors";
import type { TConnection, TLabel } from "../../src/server/output";
import { ChannelPlayer, type TPlayerDeps } from "../../src/server/player";
import { QUALITIES, type TSettings } from "../../src/server/settings";
import type { TPart, TPlaylistEntry, TProgress, TResolved, TSource } from "../../src/server/youtube";

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

const PARTS = {
  video: { formatId: "v", format: "v/bv", codec: "avc1", copy: false, ext: "mp4", size: 100 },
  audio: { formatId: "a", format: "a/ba", codec: "opus", copy: true, ext: "webm", size: 10 },
};

const vod = (id: string, duration = 200, extra: Partial<TResolved> = {}): TResolved => ({
  videoId: id.padEnd(11, "x"),
  title: `Video ${id}`,
  duration,
  live: false,
  start: 0,
  url: `https://www.youtube.com/watch?v=${id}`,
  parts: PARTS,
  format: "bv*+ba/b",
  fps: 30,
  ...extra,
});
const live = (id: string): TResolved => ({ ...vod(id, 0), live: true, parts: null, hls: { url: `https://m/${id}.m3u8`, headers: {} } });

type TFakeDownload = { video: TResolved; part: TPart | null; file: string; progress: TProgress; signal: AbortSignal; done: ReturnType<typeof deferred<string>> };

type TFakeEncoder = {
  options: TEncodeOptions;
  events: TEncoderEvents;
  start(): void;
  elapsed: number;
  exit(code: number): void;
  stopped: boolean;
};

const keyOf = (source: TSource) => (source.kind === "search" ? source.text : source.kind === "video" ? source.videoId : source.kind === "playlist" ? source.listId : source.url);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type TSetup = { settings?: Partial<TSettings>; playlists?: Record<string, TPlaylistEntry[]>; prefetchDelayMs?: number; private?: boolean };

const setup = (videos: Record<string, TResolved | Error>, options: TSetup = {}) => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "jv-player-"));
  cleanup.push(cacheDir);
  const encoders: TFakeEncoder[] = [];
  const downloads: TFakeDownload[] = [];
  const resolves: string[] = [];
  const urgent: string[] = [];
  const urgency = new Map<string, () => boolean>();
  const published: TLabel[] = [];
  const connections: (TConnection & { closed: boolean })[] = [];
  const playlistLookups: { listId: string; signal: AbortSignal; done: ReturnType<typeof deferred<TPlaylistEntry[]>> }[] = [];
  let removed = 0;
  let slots = true;
  let freed = 0;
  let free: number | null = null;
  let encodeError: Error | null = null;
  let clock = 0;
  const errors: unknown[] = [];

  const download = (video: TResolved, part: TPart | null, file: string, progress: TProgress, signal: AbortSignal) => {
    const done = deferred<string>();
    signal.addEventListener("abort", () => done.reject(new Error("aborted")));
    downloads.push({ video, part, file, progress, signal, done });
    return done.promise;
  };

  const deps: TPlayerDeps = {
    settings: () => ({ quality: QUALITIES["720p30"]!, maxSeconds: 3600, maxStreams: 2, updateYtDlp: false, ...options.settings }),
    ready: async () => {},
    ffmpeg: () => "/ffmpeg",
    cacheDir,
    disk: { free: async () => free, reserved: 0 },
    youtube: {
      async resolve(source, _quality, _signal, lookup) {
        const key = keyOf(source);
        resolves.push(key);
        const isUrgent = typeof lookup?.urgent === "function" ? lookup.urgent : () => !!lookup?.urgent;
        if (isUrgent()) urgent.push(key);
        urgency.set(key, isUrgent);
        const found = videos[key];
        if (!found) throw new UserError("yt.nothingFound");
        if (found instanceof Error) throw found;
        return structuredClone(found);
      },
      playlist(listId, signal) {
        const done = deferred<TPlaylistEntry[]>();
        signal.addEventListener("abort", () => done.reject(new Error("aborted")));
        playlistLookups.push({ listId, signal, done });
        return done.promise;
      },
      downloadPart: async (video, part, file, progress, signal) => void (await download(video, part, file, progress, signal)),
      downloadMerged: (video, dir, progress, signal) => download(video, null, path.join(dir, "merged.mkv"), progress, signal),
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
        events,
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
    channelPrivate: async () => options.private ?? false,
    prefetchDelayMs: options.prefetchDelayMs ?? 0,
    slotFree: () => slots,
    slotFreed: () => freed++,
    changed: () => {},
    log: { log() {}, error: (...args) => errors.push(args) },
    now: () => clock,
  };
  const player = new ChannelPlayer(7, deps);
  const of = (id: string) => downloads.filter((d) => d.video.title === `Video ${id}`);

  return {
    player,
    encoders,
    downloads,
    resolves,
    urgent,
    urgency,
    published,
    connections,
    errors,
    cacheDir,
    playlistLookups,
    of,
    deps,
    removed: () => removed,
    freed: () => freed,
    setSlots: (value: boolean) => (slots = value),
    setFree: (bytes: number | null) => (free = bytes),
    failEncode: (error: Error | null) => (encodeError = error),
    tick: (ms: number) => (clock += ms),
    /** video `id` has downloaded this much (0..1) of each of its files */
    grow: async (id: string, fraction: number) => {
      await waitFor(() => of(id).length > 0);
      for (const d of of(id)) d.progress(fraction * (d.part?.size ?? 100), d.part?.size ?? 100);
      await flush();
    },
    /** video `id` has downloaded completely */
    downloaded: async (id: string) => {
      await waitFor(() => of(id).length > 0);
      for (const d of of(id)) {
        d.progress(d.part?.size ?? 100, d.part?.size ?? 100);
        d.done.resolve(d.file);
      }
      await flush();
    },
  };
};

describe("ChannelPlayer", () => {
  it("downloads video and audio side by side and starts once 20 seconds are in", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    await flush();
    expect(t.of("a").map((d) => [d.part?.formatId, path.basename(d.file)])).toEqual([
      ["v", "video.mp4"],
      ["a", "audio.webm"],
    ]);
    expect(t.player.snapshot().now).toMatchObject({ title: "Video a", state: "loading", thumbnail: "/thumb/axxxxxxxxxx.jpg" });
    await t.grow("a", 0.05);
    expect(t.encoders).toHaveLength(0);
    expect(t.player.snapshot().now?.progress).toBeCloseTo(0.05);
    await t.grow("a", 0.11);
    expect(t.encoders).toHaveLength(1);
    expect(t.encoders[0]!.options).toMatchObject({
      input: { video: t.of("a")[0]!.file, audio: t.of("a")[1]!.file },
      follow: true,
      start: 0,
      length: 201,
      live: false,
    });
    expect(t.published).toHaveLength(0);
    t.encoders[0]!.start();
    expect(t.published).toEqual([{ title: "Video a", bannerUrl: "/thumb/axxxxxxxxxx.jpg" }]);
    t.encoders[0]!.elapsed = 12.6;
    expect(t.player.snapshot().now).toMatchObject({ state: "playing", position: 12 });
    await t.downloaded("a");
    expect(t.player.snapshot().now?.progress).toBeNull();
    expect(t.encoders).toHaveLength(1);
  });

  it("plays a download that finished while it waited without following it", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    await t.downloaded("b");
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.encoders[1]!.options).toMatchObject({ follow: false, length: 201 });
  });

  it("starts at the link's time once that much is in", async () => {
    const t = setup({ a: vod("a", 200, { start: 42 }) });
    t.player.add("a", 1);
    await t.grow("a", 0.25);
    expect(t.encoders).toHaveLength(0);
    await t.grow("a", 0.32);
    expect(t.encoders[0]!.options).toMatchObject({ start: 42, length: 159 });
  });

  it("waits for the whole file when YouTube has no separate formats", async () => {
    const t = setup({ a: vod("a", 200, { parts: null }) });
    t.player.add("a", 1);
    await t.grow("a", 0.9);
    expect(t.encoders).toHaveLength(0);
    await t.downloaded("a");
    const options = t.encoders[0]!.options;
    expect(options.follow).toBe(false);
    expect(options.copyAudio).toBe(false);
    expect(path.relative(path.join(t.cacheDir, t.player.snapshot().now!.id), options.input as string)).toMatch(/^\d+\/merged\.mkv$/);
  });

  it("downloads the next video while one plays, then plays it, then takes the stream down", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.add("b", 2);
    await t.grow("b", 0.5);
    expect(t.player.snapshot().queue).toEqual([{ id: expect.any(String), title: "Video b", duration: 200, live: false, state: "ready", progress: 0.5 }]);
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.encoders).toHaveLength(2);
    expect(t.encoders[1]!.options.input).toEqual({ video: t.of("b")[0]!.file, audio: t.of("b")[1]!.file });
    t.encoders[1]!.start();
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video b" }, queue: [] });
    t.encoders[1]!.exit(0);
    await flush();
    expect(t.player.snapshot().now).toBeNull();
    expect(t.removed()).toBe(1);
    expect(t.player.busy).toBe(false);
  });

  it("pauses where it is and resumes from there with a new ffmpeg", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.encoders[0]!.elapsed = 30.4;
    t.player.pause();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.player.snapshot().now).toMatchObject({ state: "paused", position: 30 });
    await flush();
    t.player.resume();
    await flush();
    expect(t.encoders[1]!.options.start).toBeCloseTo(30.4);
    t.encoders[1]!.start();
    expect(t.player.snapshot().now?.state).toBe("playing");
    // the paused connection stayed on air (a still picture) until the new one replaced it
    expect(t.connections[0]!.closed).toBe(false);
    expect(t.published).toHaveLength(2);
  });

  it("seeks by restarting at the new place, and only the last of quick seeks plays", async () => {
    const t = setup({ a: vod("a", 100) });
    t.player.add("a", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.seek(500);
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.encoders[1]!.options.start).toBe(99);
    t.player.seek(-3);
    t.player.seek(20);
    await flush();
    expect(t.encoders).toHaveLength(3);
    expect(t.encoders[2]!.options.start).toBe(20);
    expect(t.connections.filter((c) => c.closed)).toHaveLength(2);
  });

  it("waits with a seek past the download until that part is in", async () => {
    const t = setup({ a: vod("a", 200) });
    t.player.add("a", 1);
    await t.grow("a", 0.2);
    t.encoders[0]!.start();
    t.player.seek(150);
    await flush();
    expect(t.encoders).toHaveLength(1);
    expect(t.player.snapshot().now).toMatchObject({ state: "loading", position: 150 });
    await t.grow("a", 0.9);
    expect(t.encoders[1]!.options).toMatchObject({ start: 150, follow: true });
  });

  it("retries a crashed video once from where it was", async () => {
    const t = setup({ a: vod("a", 200), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.encoders[0]!.elapsed = 50;
    t.encoders[0]!.exit(1);
    await flush();
    expect(t.encoders[1]!.options.start).toBe(50);
    t.encoders[1]!.start();
    t.encoders[1]!.exit(1);
    await t.downloaded("b");
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video b" }, error: { key: "error.playback" } });
  });

  it("retries again after playing a while since the last retry", async () => {
    const t = setup({ a: vod("a", 600) });
    t.player.add("a", 1);
    await t.downloaded("a");
    for (const [index, start] of [[0, 0], [1, 100], [2, 200]] as const) {
      expect(t.encoders[index]!.options.start).toBe(start);
      t.encoders[index]!.start();
      t.encoders[index]!.elapsed = 100;
      t.encoders[index]!.exit(1);
      await flush();
    }
    expect(t.encoders).toHaveLength(4);
    expect(t.player.snapshot().error).toBeNull();
  });

  it("tells ffmpeg whether the files it follows are still growing", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    await t.grow("a", 0.5);
    expect(t.encoders[0]!.options.follow).toBe(true);
    // the Opus part goes through as it is
    expect(t.encoders[0]!.options.copyAudio).toBe(true);
    expect(t.encoders[0]!.events.growing?.()).toBe(true);
    await t.downloaded("a");
    expect(t.encoders[0]!.events.growing?.()).toBe(false);
  });

  it("ends the video when its download fails", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    await t.grow("a", 0.5);
    t.encoders[0]!.start();
    t.of("a")[0]!.done.reject(new UserError("yt.unavailable"));
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.player.snapshot()).toMatchObject({ now: null, error: { key: "yt.unavailable" } });
    expect(t.of("a")[1]!.signal.aborted).toBe(true);
  });

  it("restarts a dropped livestream with a fresh playlist, but not forever", async () => {
    const t = setup({ l: live("l") });
    t.player.add("l", 1);
    await flush();
    expect(t.downloads).toHaveLength(0);
    expect(t.encoders[0]!.options).toMatchObject({ input: "https://m/l.m3u8", live: true, follow: false, length: undefined });
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
    expect(t.player.snapshot()).toMatchObject({ now: null, error: { key: "error.liveDropping" } });
  });

  it("ends a livestream that is over without an error", async () => {
    const videos: Record<string, TResolved> = { l: live("l") };
    const t = setup(videos);
    t.player.add("l", 1);
    await flush();
    t.encoders[0]!.start();
    videos.l = vod("l", 3600);
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, error: null });
  });

  it("refuses to pause or seek a livestream", async () => {
    const t = setup({ l: live("l") });
    t.player.add("l", 1);
    await flush();
    expect(() => t.player.pause()).toThrow("can't be paused");
    expect(() => t.player.seek(10)).toThrow("can't be seeked");
  });

  it("says when it is too early to pause or seek", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    expect(() => t.player.seek(10)).toThrow("Still loading");
    await flush();
    expect(() => t.player.pause()).toThrow("Still loading");
  });

  it("drops what cannot be found or is too long, and says why", async () => {
    const t = setup({ long: vod("long", 7200), ok: vod("ok") }, { settings: { maxSeconds: 3600 } });
    t.player.add("missing", 1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [], error: { key: "yt.nothingFound" } });
    t.player.add("long", 1);
    await flush();
    expect(t.player.snapshot().error).toEqual({ key: "error.tooLong", params: { minutes: 60 } });
    t.player.add("ok", 1);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: { title: "Video ok" }, error: null });
  });

  it("logs unexpected failures and shows a plain message", async () => {
    const t = setup({ boom: new Error("spawn ENOENT /secret/path") });
    t.player.add("boom", 1);
    await flush();
    expect(t.player.snapshot().error).toEqual({ key: "error.generic" });
    expect(JSON.stringify(t.errors)).toContain("ENOENT");
  });

  it("refuses a download the disk has no room for", async () => {
    const t = setup({ a: vod("a") });
    t.setFree(300 * 1024 * 1024);
    t.player.add("a", 1);
    await flush();
    expect(t.downloads).toHaveLength(0);
    expect(t.player.snapshot()).toMatchObject({ now: null, error: { key: "error.disk" } });
    t.setFree(10 * 1024 ** 3);
    t.player.add("a", 1);
    await flush();
    expect(t.downloads).toHaveLength(2);
  });

  it("leaves livestreams out of the length limit", async () => {
    const t = setup({ l: live("l") }, { settings: { maxSeconds: 60 } });
    t.player.add("l", 1);
    await flush();
    expect(t.encoders).toHaveLength(1);
  });

  it("refuses a new video when the server is at its limit", () => {
    const t = setup({ a: vod("a") });
    t.setSlots(false);
    expect(() => t.player.add("a", 1)).toThrow("Too many videos");
  });

  it("removes a queued video and stops its download", async () => {
    const t = setup({ a: vod("a"), b: vod("b"), c: vod("c") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    t.player.add("c", 1);
    await t.downloaded("a");
    await t.grow("b", 0.1);
    expect(t.of("c")).toHaveLength(0);
    t.player.remove(t.player.snapshot().queue[0]!.id);
    await flush();
    expect(t.of("b").every((d) => d.signal.aborted)).toBe(true);
    // the next one in line downloads instead
    expect(t.of("c")).toHaveLength(2);
    expect(t.player.snapshot().queue.map((entry) => entry.title)).toEqual(["Video c"]);
  });

  it("moves queued videos, and downloads whichever is next", async () => {
    const t = setup({ a: vod("a"), b: vod("b"), c: vod("c"), d: vod("d") });
    for (const id of ["a", "b", "c", "d"]) t.player.add(id, 1);
    await t.downloaded("a");
    const ids = () => t.player.snapshot().queue.map((entry) => entry.title.at(-1));
    const id = (title: string) => t.player.snapshot().queue.find((entry) => entry.title === `Video ${title}`)!.id;
    t.player.move(id("d"), 0);
    expect(ids()).toEqual(["d", "b", "c"]);
    await flush();
    expect(t.of("d")).toHaveLength(2);
    t.player.move(id("d"), 99);
    expect(ids()).toEqual(["b", "c", "d"]);
    t.player.move(id("c"), -5);
    expect(ids()).toEqual(["c", "b", "d"]);
    t.player.move("nope", 0);
    expect(ids()).toEqual(["c", "b", "d"]);
  });

  it("downloads the next video only once the one playing is in and it has been next a while", async () => {
    const t = setup({ a: vod("a"), b: vod("b"), c: vod("c"), d: vod("d") }, { prefetchDelayMs: 40 });
    for (const id of ["a", "b", "c", "d"]) t.player.add(id, 1);
    await t.grow("a", 0.5);
    await Bun.sleep(60);
    expect(t.of("b")).toHaveLength(0);
    await t.downloaded("a");
    expect(t.of("b")).toHaveLength(0);
    await Bun.sleep(60);
    expect(t.of("b")).toHaveLength(2);

    const id = (title: string) => t.player.snapshot().queue.find((entry) => entry.title === `Video ${title}`)!.id;
    // quick reordering starts nothing; b keeps going while it is one of the next two
    for (const title of ["c", "d", "c", "d", "c"]) {
      t.player.move(id(title), 0);
      await Bun.sleep(5);
    }
    expect(t.player.snapshot().queue.map((entry) => entry.title.at(-1))).toEqual(["c", "d", "b"]);
    expect(t.of("c")).toHaveLength(0);
    // b is third now: its download stops, without an error
    expect(t.of("b").every((d) => d.signal.aborted)).toBe(true);
    await Bun.sleep(60);
    expect(t.of("c")).toHaveLength(2);
    expect(t.of("d")).toHaveLength(0);
    expect(t.player.snapshot()).toMatchObject({ error: null, queue: [{ title: "Video c", progress: 0 }, { title: "Video d" }, { title: "Video b" }] });
  });

  it("keeps room on the disk for downloads still running, across channels", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    const other = new ChannelPlayer(8, t.deps);
    // room for one 110 byte video next to the reserve, not two
    t.setFree(512 * 1024 * 1024 + 150);
    t.player.add("a", 1);
    await waitFor(() => t.of("a").length === 2);
    other.add("b", 1);
    await waitFor(() => other.snapshot().error !== null);
    expect(t.of("b")).toHaveLength(0);
    expect(other.snapshot()).toMatchObject({ now: null, error: { key: "error.disk" } });
    // the space comes back once the download is done
    await t.downloaded("a");
    other.add("b", 1);
    await waitFor(() => t.of("b").length === 2);
  });

  it("looks up only the first few queued videos ahead, the one playing first", async () => {
    const videos = Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, vod(id)]));
    const t = setup(videos);
    for (const id of ["a", "b", "c", "d", "e"]) t.player.add(id, 1);
    await flush();
    expect(t.resolves.toSorted()).toEqual(["a", "b", "c", "d"]);
    expect(t.urgent).toEqual(["a"]);
    // not looked up yet: shown as typed, without a spinner
    expect(t.player.snapshot().queue[3]).toMatchObject({ title: "e", state: "ready", duration: 0 });
    t.player.remove(t.player.snapshot().queue[0]!.id);
    await flush();
    expect(t.resolves.toSorted()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("hurries a lookup asked for ahead once its video is about to play", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    expect(t.urgency.get("b")!()).toBe(false);
    t.player.skip();
    await flush();
    // a lookup still waiting for its turn would now go first
    expect(t.urgency.get("b")!()).toBe(true);
  });

  it("reads at most two playlists at once per channel, and hurries the lookup of the first video", async () => {
    const t = setup({ aaaaaaaaaaa: vod("aaaaaaaaaaa") });
    t.player.add("https://www.youtube.com/playlist?list=PL0123456789", 1);
    t.player.add("https://www.youtube.com/playlist?list=PL0123456780", 1);
    expect(() => t.player.add("https://www.youtube.com/playlist?list=PL0123456781", 1)).toThrow(UserError);
    await waitFor(() => t.playlistLookups.length === 2);
    t.playlistLookups[0]!.done.resolve([{ videoId: "aaaaaaaaaaa", title: "First", duration: 100 }]);
    await flush();
    expect(t.urgent).toEqual(["aaaaaaaaaaa"]);
  });

  it("looks a video up again before downloading it when its lookup is old", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await flush();
    expect(t.resolves.toSorted()).toEqual(["a", "b"]);
    t.tick(2 * 3600_000);
    await t.downloaded("a");
    await flush();
    expect(t.resolves.toSorted()).toEqual(["a", "b", "b"]);
    expect(t.urgent).toEqual(["a", "b"]);
    expect(t.of("b")).toHaveLength(2);
  });

  it("refuses a video of unknown length while there is a length limit", async () => {
    const t = setup({ a: vod("a", 0) }, { settings: { maxSeconds: 3600 } });
    t.player.add("a", 1);
    await flush();
    expect(t.downloads).toHaveLength(0);
    expect(t.player.snapshot().error).toEqual({ key: "error.unknownLength" });
  });

  it("names the video on the stream only in a channel everyone can see", async () => {
    for (const hidden of [false, true]) {
      const t = setup({ a: vod("a") }, { private: hidden });
      t.player.add("a", 1);
      await t.downloaded("a");
      t.encoders[0]!.start();
      expect(t.published).toEqual([hidden ? { title: "Jollyvideo", bannerUrl: "" } : { title: "Video a", bannerUrl: "/thumb/axxxxxxxxxx.jpg" }]);
    }
  });

  it("keeps the state it pushes small", () => {
    const t = setup({});
    t.player.add("first", 1);
    t.player.add("x".repeat(400), 1);
    const [entry] = t.player.snapshot().queue;
    expect(entry!.title).toHaveLength(100);
    expect(Object.keys(entry!).sort()).toEqual(["duration", "id", "live", "progress", "state", "title"]);
  });

  it("queues a playlist's videos once it is looked up, leaving out the too long ones", async () => {
    const t = setup({ aaaaaaaaaaa: vod("aaaaaaaaaaa", 100, { title: "First" }), ccccccccccc: vod("ccccccccccc", 100, { title: "Third" }) }, { settings: { maxSeconds: 600 } });
    t.player.add("https://www.youtube.com/playlist?list=PL0123456789", 3);
    expect(t.player.snapshot().queue).toMatchObject([{ playlist: true, state: "resolving" }]);
    await waitFor(() => t.playlistLookups.length === 1);
    t.playlistLookups[0]!.done.resolve([
      { videoId: "aaaaaaaaaaa", title: "First", duration: 100 },
      { videoId: "bbbbbbbbbbb", title: "Long", duration: 9000 },
      { videoId: "ccccccccccc", title: "Third", duration: 0 },
    ]);
    await flush();
    const snapshot = t.player.snapshot();
    // the first one is up, and the next one is looked up ahead
    expect(snapshot.now?.title).toBe("First");
    expect(snapshot.queue).toMatchObject([{ title: "Third", state: "ready" }]);
    expect(snapshot.queue[0]!.playlist).toBeUndefined();
    expect(snapshot.error).toEqual({ key: "error.someTooLong", params: { minutes: 10 } });
    expect(t.resolves.toSorted()).toEqual(["aaaaaaaaaaa", "ccccccccccc"]);
  });

  it("says when a playlist did not fit into the queue", async () => {
    const t = setup({ a: vod("a") });
    // one playing, 47 waiting
    for (let i = 0; i < 48; i++) t.player.add("a", 1);
    t.player.add("https://www.youtube.com/playlist?list=PL0123456789", 1);
    await waitFor(() => t.playlistLookups.length === 1);
    t.playlistLookups[0]!.done.resolve(["bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee", "fffffffffff"].map((videoId) => ({ videoId, title: videoId, duration: 60 })));
    await flush();
    expect(t.player.snapshot().queue).toHaveLength(50);
    expect(t.player.snapshot().error).toEqual({ key: "error.queueFullSome", params: { count: 3, total: 5 } });
  });

  it("forgets a playlist removed while it is looked up", async () => {
    const t = setup({});
    t.player.add("https://www.youtube.com/playlist?list=PL0123456789", 1);
    await waitFor(() => t.playlistLookups.length === 1);
    t.player.remove(t.player.snapshot().queue[0]!.id);
    expect(t.playlistLookups[0]!.signal.aborted).toBe(true);
    expect(t.player.snapshot().queue).toEqual([]);
  });

  it("stops everything at once", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.stop();
    await flush();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.of("b").every((d) => d.signal.aborted)).toBe(true);
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [] });
    expect(t.removed()).toBe(1);
    expect(t.encoders).toHaveLength(1);
  });

  it("skips to the next video", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.player.skip();
    await t.downloaded("b");
    expect(t.encoders[1]!.options.input).toEqual({ video: t.of("b")[0]!.file, audio: t.of("b")[1]!.file });
  });

  it("closes the transports when ffmpeg cannot even start", async () => {
    const t = setup({ a: vod("a") });
    t.failEncode(new Error("spawn ENOENT"));
    t.player.add("a", 1);
    await t.downloaded("a");
    expect(t.connections).toHaveLength(1);
    expect(t.connections[0]!.closed).toBe(true);
    expect(t.player.snapshot()).toMatchObject({ now: null, error: { key: "error.generic" } });
  });

  it("waits for a free slot, and starts when it gets one", async () => {
    const t = setup({ a: vod("a"), b: vod("b") });
    t.player.add("a", 1);
    t.player.add("b", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    t.setSlots(false);
    t.encoders[0]!.exit(0);
    await flush();
    expect(t.player.snapshot()).toMatchObject({ now: null, queue: [{ title: "Video b" }], error: { key: "error.slots" } });
    expect(t.player.busy).toBe(false);
    t.setSlots(true);
    t.player.retry();
    await t.downloaded("b");
    expect(t.player.snapshot().now?.title).toBe("Video b");
    t.encoders[1]!.exit(0);
    await flush();
    expect(t.freed()).toBe(1);
  });

  it("keeps the lock until it is lifted, and counts its revision up", () => {
    const t = setup({});
    const before = t.player.snapshot().rev;
    t.player.setLocked(true);
    expect(t.player.snapshot()).toMatchObject({ locked: true });
    expect(t.player.snapshot().rev).toBeGreaterThan(before);
    t.player.setLocked(false);
    expect(t.player.isLocked).toBe(false);
  });

  it("is done after destroy", async () => {
    const t = setup({ a: vod("a") });
    t.player.add("a", 1);
    await t.downloaded("a");
    t.encoders[0]!.start();
    await t.player.destroy();
    expect(t.encoders[0]!.stopped).toBe(true);
    expect(t.removed()).toBe(1);
    expect(() => t.player.add("a", 1)).toThrow(UserError);
  });

  it("refuses more than a full queue", () => {
    const t = setup({ a: vod("a") });
    for (let i = 0; i < 51; i++) t.player.add("a", 1);
    expect(() => t.player.add("a", 1)).toThrow("queue is full");
  });
});
