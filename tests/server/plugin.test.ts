/**
 * The server half loaded the way Sharkord loads it, with stand-in tools: a
 * yt-dlp script, an ffmpeg script that only reports progress, and a real
 * mediasoup router.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import * as mediasoup from "mediasoup";
import type { Router, Worker } from "mediasoup/types";
import os from "os";
import path from "path";
import type { TCaptions, TPlayer, TViewer } from "../../src/contract";
import { onLoad, onUnload } from "../../src/server/index";
import { fakeHost, fakeYtDlp, script } from "../helpers/fake-host";
import { SHARKORD_CODECS } from "../helpers/sharkord";

const dir = mkdtempSync(path.join(os.tmpdir(), "jv-server-"));
let worker: Worker;
let router: Router;
let host: ReturnType<typeof fakeHost>;

const CHANNEL = 5;
const USER = 1;
const MODERATOR = 9;

const waitFor = async <T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};
const lastPush = () => host.pushes.findLast((push) => push.channelId === CHANNEL)?.data as TPlayer | undefined;

beforeAll(async () => {
  process.env.JOLLYVIDEO_YT_DLP = fakeYtDlp(dir, {
    id: "dQw4w9WgXcQ",
    title: "Test video",
    duration: 120,
    formats: [
      { format_id: "136", vcodec: "avc1", acodec: "none", height: 720, fps: 30, protocol: "https" },
      { format_id: "251", vcodec: "none", acodec: "opus", abr: 130, protocol: "https" },
      {
        format_id: "sb1",
        format_note: "storyboard",
        protocol: "mhtml",
        vcodec: "none",
        acodec: "none",
        width: 160,
        height: 90,
        columns: 5,
        rows: 5,
        fragments: [0, 1].map((n) => ({ url: `https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M${n}.jpg?sigh=x`, duration: 100 })),
      },
    ],
    subtitles: { en: [{ ext: "json3", url: "https://www.youtube.com/api/timedtext", name: "English" }] },
    chapters: [
      { start_time: 0, end_time: 60, title: "Verse" },
      { start_time: 60, end_time: 120, title: "Chorus" },
    ],
  });
  // reports a second of progress, then waits to be stopped
  process.env.JOLLYVIDEO_FFMPEG = script(dir, "ffmpeg", "echo out_time_us=1000000\nexec sleep 60");
  worker = await mediasoup.createWorker({ logLevel: "error" });
  router = await worker.createRouter({ mediaCodecs: SHARKORD_CODECS });
  host = fakeHost({ router, moderators: [MODERATOR], dataPath: path.join(dir, "data") });
  await onLoad(host.ctx as never);
});

afterAll(async () => {
  await onUnload();
  worker.close();
  delete process.env.JOLLYVIDEO_YT_DLP;
  delete process.env.JOLLYVIDEO_FFMPEG;
  rmSync(dir, { recursive: true, force: true });
});

describe("the server half", () => {
  it("registers its actions, commands, route and button", () => {
    expect([...host.actions.keys()]).toEqual(["state", "add", "control", "captions"]);
    expect([...host.actions.values()].every((action) => action.requires === "JOIN_VOICE_CHANNELS")).toBe(true);
    expect(Object.fromEntries([...host.commands].map(([name, command]) => [name, command.requires]))).toEqual({
      watch: "JOIN_VOICE_CHANNELS",
      "watch-skip": "JOIN_VOICE_CHANNELS",
      "watch-stop": "JOIN_VOICE_CHANNELS",
      "watch-lock": "MOVE_MEMBERS",
      "watch-update": "MANAGE_PLUGINS",
    });
    expect(host.commands.get("watch-update")!.ephemeral).toBe(true);
    expect([...host.routes.keys()]).toEqual(["/thumb/*"]);
    expect([...host.events.keys()]).toEqual(["user:left_voice", "user:joined_voice", "voice:runtime_closed"]);
    expect(host.ui()).toEqual({ voice_controls: "JOIN_VOICE_CHANNELS" });
    expect([...host.settings.keys()]).toEqual(["quality", "maxMinutes", "maxStreams", "updateYtDlp"]);
  });

  it("only works from a voice channel", async () => {
    expect(await host.action("state", USER, undefined)).toBeNull();
    expect(await host.action("state", USER, CHANNEL)).toEqual({
      player: { channelId: CHANNEL, rev: expect.any(Number), now: null, queue: [], locked: false, error: null },
      canModerate: false,
    });
    await expect(host.action("add", USER, undefined, { query: "x" })).rejects.toThrow("error.joinVoice");
  });

  it("updates yt-dlp only for admins, even if others may use the command", async () => {
    await expect(host.command("watch-update", MODERATOR, CHANNEL)).rejects.toThrow("Only server admins");
  });

  it("does not take orders from someone a moderator disconnected", async () => {
    const OTHER = 7;
    const ELSEWHERE = 6;
    expect(await host.action("state", OTHER, ELSEWHERE)).not.toBeNull();
    // Sharkord still has the channel as theirs
    host.disconnect(OTHER, ELSEWHERE);
    expect(await host.action("state", OTHER, ELSEWHERE)).toBeNull();
    await expect(host.action("add", OTHER, ELSEWHERE, { query: "x" })).rejects.toThrow("error.joinVoice");
    await expect(host.command("watch-skip", OTHER, ELSEWHERE)).rejects.toThrow("Join a voice channel");
  });

  it("plays what someone adds, as a stream in the channel", async () => {
    const viewer = (await host.action("add", USER, CHANNEL, { query: "https://youtu.be/dQw4w9WgXcQ" })) as TViewer;
    expect(viewer.player.now).toMatchObject({ state: "loading" });
    const playing = await waitFor(() => (lastPush()?.now?.state === "playing" ? lastPush() : undefined));
    expect(playing.now).toMatchObject({ title: "Test video", duration: 120 });
    expect(playing.now!.thumbnail).toMatch(/^\/plugins\/jollyvideo\/thumb\/[0-9a-f]{32}\/dQw4w9WgXcQ\.jpg$/);
    expect(host.streams).toHaveLength(1);
    expect(host.streams[0]!.options).toMatchObject({ channelId: CHANNEL, title: "Test video", bannerUrl: playing.now!.thumbnail });
  });

  it("serves the playing video's captions to whoever is in the channel", async () => {
    const now = lastPush()!.now!;
    expect(now.captions).toEqual([{ id: "en", label: "English", auto: false }]);
    expect(now.storyboard).toEqual({ url: expect.stringMatching(/^\/plugins\/jollyvideo\/thumb\/[0-9a-f]{32}\/dQw4w9WgXcQ\/sb\{n\}\.jpg$/), count: 2, width: 160, height: 90, columns: 5, rows: 5, interval: 4 });
    // the sheets share the thumbnail's key
    expect(now.storyboard!.url.split("/")[4]).toBe(now.thumbnail.split("/")[4]);
    expect(now.chapters).toEqual([
      { start: 0, title: "Verse" },
      { start: 60, title: "Chorus" },
    ]);
    const captions = (await host.action("captions", USER, CHANNEL, { id: now.id, track: "en", from: 30 })) as TCaptions;
    expect(captions.from).toBe(30);
    expect(captions.until).toBe(330);
    expect(captions.cues[0]).toEqual([30000, 32500, "en line 10"]);
    expect(captions.cues.at(-1)![2]).toBe("en line 109");
    for (const payload of [{ id: now.id, track: "../x", from: 0 }, { id: now.id, track: "en", from: -1 }, null]) {
      await expect(host.action("captions", USER, CHANNEL, payload)).rejects.toThrow("error.captions");
    }
    await expect(host.action("captions", USER, 99, { id: now.id, track: "en", from: 0 })).rejects.toThrow("error.nothingPlaying");
  });

  it("serves no thumbnail it was not asked for", async () => {
    let status = 0;
    const res = { writeHead: (code: number) => ((status = code), res), end: () => res };
    await host.routes.get("/thumb/*")!({ url: "/plugins/jollyvideo/thumb/AAAAAAAAAAA.jpg" } as never, res as never);
    expect(status).toBe(404);
  });

  it("lets only moderators lock, and then only them control", async () => {
    await expect(host.action("control", USER, CHANNEL, { op: "lock", locked: true })).rejects.toThrow("error.lockModerators");
    const locked = (await host.action("control", MODERATOR, CHANNEL, { op: "lock", locked: true })) as TViewer;
    expect(locked).toMatchObject({ player: { locked: true }, canModerate: true });
    await expect(host.action("control", USER, CHANNEL, { op: "pause" })).rejects.toThrow("error.locked");
    await expect(host.action("add", USER, CHANNEL, { query: "more" })).rejects.toThrow("error.locked");
    await expect(host.command("watch-skip", USER, CHANNEL)).rejects.toThrow("Only moderators");
    const paused = (await host.action("control", MODERATOR, CHANNEL, { op: "pause" })) as TViewer;
    expect(paused.player.now?.state).toBe("paused");
    expect(await host.command("watch-lock", MODERATOR, CHANNEL)).toBe("Unlocked");
    const resumed = (await host.action("control", USER, CHANNEL, { op: "resume" })) as TViewer;
    expect(resumed.player.now?.state).toBe("loading");
    await waitFor(() => (lastPush()?.now?.state === "playing" ? true : undefined));
  });

  it("swaps the stream's producers after a seek", async () => {
    const before = host.streams[0]!.updates.length;
    await host.action("control", USER, CHANNEL, { op: "seek", position: 60 });
    await waitFor(() => (host.streams[0]!.updates.length > before ? true : undefined));
    expect(host.streams[0]!.updates.at(-1)).toMatchObject({ title: "Test video" });
    expect(host.streams[0]!.updates.at(-1)!.producers).toBeDefined();
  });

  it("refuses unknown controls and keeps unexpected errors vague", async () => {
    await expect(host.action("control", USER, CHANNEL, { op: "rm -rf" })).rejects.toThrow("error.unknownControl");
    host.failPermissions(new Error("database is down"));
    await expect(host.action("state", USER, CHANNEL)).rejects.toThrow("error.generic");
    host.failPermissions(null);
    expect(host.logs.some((line) => line.includes("database is down"))).toBe(true);
  });

  it("takes the stream down and forgets the lock when the voice channel closes", async () => {
    await host.action("control", MODERATOR, CHANNEL, { op: "lock", locked: true });
    (host.events.get("voice:runtime_closed") as (payload: { channelId: number }) => void)({ channelId: CHANNEL });
    expect(host.streams[0]!.removed).toBe(true);
    expect(((await host.action("state", USER, CHANNEL)) as TViewer).player).toMatchObject({ channelId: CHANNEL, now: null, queue: [], locked: false, error: null });
  });

  it("answers /watch in the chat", async () => {
    expect(await host.command("watch", USER, CHANNEL, { query: "never gonna" })).toBe("Added");
    expect(await host.command("watch-stop", USER, CHANNEL)).toBe("Stopped");
  });
});
