import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { formatTime } from "../../src/client/format";
import { boxWidth, encoderArgs, h264Level, type TEncodeOptions } from "../../src/server/encoder";
import { parseControl } from "../../src/server/index";
import { closeWhenEmpty, fitted } from "../../src/server/players";
import { QUALITIES, readSettings } from "../../src/server/settings";
import { isYouTubeImage, Thumbnails } from "../../src/server/thumbnails";

const options = (extra: Partial<TEncodeOptions> = {}): TEncodeOptions => ({
  ffmpeg: "/ffmpeg",
  input: "/cache/a/video.mkv",
  live: false,
  start: 0,
  quality: QUALITIES["720p60"]!,
  video: { port: 5000, payloadType: 96, ssrc: 11 },
  audio: { port: 6000, payloadType: 111, ssrc: 22 },
  ...extra,
});

describe("encoder arguments", () => {
  it("scales into a 16:9 box and caps the frame rate", () => {
    const args = encoderArgs(options()).join(" ");
    expect(args).toContain("scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1");
    expect(args).toContain("-fpsmax 60");
    expect(args).toContain("-level:v 3.2");
    expect(args).toContain("-b:v 4000k -maxrate 4000k -bufsize 4000k");
    expect(args).toContain("-force_key_frames expr:gte(t,n_forced*1)");
  });

  it("sends picture and sound from one process to two ports, without RTCP to port + 1", () => {
    const args = encoderArgs(options());
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(args.filter((arg) => arg.startsWith("rtp://"))).toEqual(["rtp://127.0.0.1:5000?pkt_size=1200", "rtp://127.0.0.1:6000?pkt_size=1200"]);
    expect(args.filter((arg) => arg === "skip_rtcp")).toHaveLength(2);
    expect(args.join(" ")).toContain("-payload_type 96 -ssrc 11");
    expect(args.join(" ")).toContain("-payload_type 111 -ssrc 22");
  });

  it("seeks files before opening them, reads in real time, and passes the user agent for livestreams", () => {
    const vod = encoderArgs(options({ start: 95 }));
    expect(vod.slice(0, vod.indexOf("-i"))).toEqual(expect.arrayContaining(["-ss", "95", "-re"]));
    const live = encoderArgs(options({ live: true, start: 95, input: "https://m/x.m3u8", headers: { "User-Agent": "UA" } }));
    expect(live).not.toContain("-ss");
    expect(live.slice(0, live.indexOf("-i"))).toEqual(expect.arrayContaining(["-user_agent", "UA", "-re"]));
  });

  it("reads separate video and audio files that are still growing, and stops at the video's end", () => {
    const args = encoderArgs(options({ input: { video: "/c/video.mp4", audio: "/c/audio.webm" }, follow: true, start: 30, length: 171 }));
    const inputs = args.slice(0, args.indexOf("-map"));
    expect(inputs.join(" ")).toContain("-follow 1 -ss 30 -re -i /c/video.mp4 -protocol_whitelist file -format_whitelist mov,matroska -follow 1 -ss 30 -re -i /c/audio.webm");
    expect(args[args.indexOf("-map", args.indexOf("rtp://127.0.0.1:5000?pkt_size=1200")) + 1]).toBe("1:a:0");
    expect(args.filter((arg) => arg === "-t")).toHaveLength(2);
    expect(args[args.indexOf("-t") + 1]).toBe("171");
    // a finished file needs neither
    const done = encoderArgs(options({ input: { video: "/v", audio: "/a" } }));
    expect(done).not.toContain("-follow");
    expect(done).not.toContain("-t");
  });

  it("opens only local files of YouTube's containers, or a livestream's HLS", () => {
    const vod = encoderArgs(options());
    expect(vod.slice(0, vod.indexOf("-i")).join(" ")).toContain("-protocol_whitelist file -format_whitelist mov,matroska");
    const live = encoderArgs(options({ live: true, input: "https://m/x.m3u8" }));
    expect(live.slice(0, live.indexOf("-i")).join(" ")).toContain("-protocol_whitelist http,https,httpproxy,tls,tcp,crypto -format_whitelist hls,mpegts,mov,aac");
  });

  it("passes Opus through, and encodes anything else to Opus", () => {
    const encoded = encoderArgs(options()).join(" ");
    expect(encoded).toContain("-c:a libopus -b:a 128k -ar 48000 -ac 2");
    const copied = encoderArgs(options({ copyAudio: true })).join(" ");
    expect(copied).toContain("-c:a copy -payload_type 111");
    expect(copied).not.toContain("libopus");
  });

  it("signals a level each quality fits in", () => {
    expect(boxWidth(480)).toBe(854);
    expect(boxWidth(1080)).toBe(1920);
    expect(h264Level(QUALITIES["480p30"]!).profileLevelId).toBe("42e01f");
    expect(h264Level(QUALITIES["720p30"]!)).toEqual({ ffmpeg: "3.1", profileLevelId: "42e01f" });
    expect(h264Level(QUALITIES["720p60"]!)).toEqual({ ffmpeg: "3.2", profileLevelId: "42e020" });
    expect(h264Level(QUALITIES["1080p30"]!)).toEqual({ ffmpeg: "4.0", profileLevelId: "42e028" });
    expect(h264Level(QUALITIES["1080p60"]!)).toEqual({ ffmpeg: "4.2", profileLevelId: "42e02a" });
  });
});

describe("settings", () => {
  it("falls back to defaults and keeps numbers in range", () => {
    expect(readSettings(undefined)).toEqual({ quality: QUALITIES["720p60"]!, maxSeconds: 240 * 60, maxStreams: 2, updateYtDlp: true });
    const values: Record<string, unknown> = { quality: "4k", maxMinutes: -5, maxStreams: "99", updateYtDlp: false };
    expect(readSettings({ get: (key) => values[key] })).toEqual({ quality: QUALITIES["720p60"]!, maxSeconds: 0, maxStreams: 20, updateYtDlp: false });
  });
});

describe("parseControl", () => {
  it("accepts the known controls and nothing else", () => {
    expect(parseControl({ op: "pause", extra: 1 })).toEqual({ op: "pause" });
    expect(parseControl({ op: "seek", position: 12.5 })).toEqual({ op: "seek", position: 12.5 });
    expect(parseControl({ op: "lock", locked: true })).toEqual({ op: "lock", locked: true });
    expect(parseControl({ op: "move", id: "x", to: 2 })).toEqual({ op: "move", id: "x", to: 2 });
    expect(() => parseControl({ op: "move", id: "x", to: 1.5 })).toThrow("Unknown control");
    for (const bad of [null, "pause", { op: "seek", position: Infinity }, { op: "seek", position: "1" }, { op: "remove", id: "x".repeat(65) }, { op: "lock" }, { op: "eval" }]) {
      expect(() => parseControl(bad)).toThrow("Unknown control");
    }
  });
});

const fakeResponse = () => {
  const result = { status: 0, headers: {} as Record<string, unknown>, body: undefined as unknown };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      result.status = status;
      result.headers = headers;
      return res;
    },
    end(body?: unknown) {
      result.body = body;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, result };
};
const request = (url: string) => ({ url }) as IncomingMessage;

describe("thumbnails", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2]);

  it("serves only videos someone queued, behind a key per channel, fetched once", async () => {
    const fetched: string[] = [];
    const thumbs = new Thumbnails("/plugins/jollyvideo", console, async (id) => {
      fetched.push(id);
      return jpeg;
    });
    const url = thumbs.url(1, "dQw4w9WgXcQ");
    const otherChannel = thumbs.url(2, "bbbbbbbbbbb");
    expect(url).toMatch(/^\/plugins\/jollyvideo\/thumb\/[0-9a-f]{32}\/dQw4w9WgXcQ\.jpg$/);
    const key = url.split("/")[4]!;

    for (let i = 0; i < 2; i++) {
      const { res, result } = fakeResponse();
      await thumbs.handle(request(url), res);
      expect(result.status).toBe(200);
      expect(result.headers["Content-Type"]).toBe("image/jpeg");
      expect(result.body).toBe(jpeg);
    }
    expect(fetched).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"]);

    for (const url of [
      `/plugins/jollyvideo/thumb/${key}/aaaaaaaaaaa.jpg`,
      `/plugins/jollyvideo/thumb/${"0".repeat(32)}/dQw4w9WgXcQ.jpg`,
      "/plugins/jollyvideo/thumb/dQw4w9WgXcQ.jpg",
      `/plugins/jollyvideo/thumb/${key}/../x.jpg`,
      // channel 1's key does not reach channel 2's video
      `/plugins/jollyvideo/thumb/${key}/bbbbbbbbbbb.jpg`,
      otherChannel.replace("bbbbbbbbbbb", "dQw4w9WgXcQ"),
    ]) {
      const { res, result } = fakeResponse();
      await thumbs.handle(request(url), res);
      expect(result.status).toBe(404);
    }
    expect(fetched).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"]);
  });

  it("serves a playing video's storyboard sheets, from YouTube's image hosts only", async () => {
    const fetched: string[] = [];
    const thumbs = new Thumbnails("/p", console, async (url) => {
      fetched.push(url);
      return jpeg;
    });
    const sheets = ["https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sigh=a", "https://evil.example/M1.jpg", "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M2.jpg?sigh=c"];
    const template = thumbs.storyboard(1, "dQw4w9WgXcQ", sheets);
    expect(template).toMatch(/^\/p\/thumb\/[0-9a-f]{32}\/dQw4w9WgXcQ\/sb\{n\}\.jpg$/);
    const status = async (n: number | string) => {
      const { res, result } = fakeResponse();
      await thumbs.handle(request(template.replace("{n}", String(n))), res);
      return result.status;
    };
    expect([await status(0), await status(1), await status(2), await status(3), await status("x")]).toEqual([200, 404, 200, 404, 404]);
    expect(fetched).toEqual([sheets[0]!, sheets[2]!]);
    // the channel's key only
    const other = thumbs.storyboard(2, "dQw4w9WgXcQ", []);
    const { res, result } = fakeResponse();
    await thumbs.handle(request(other.replace("{n}", "0")), res);
    expect(result.status).toBe(404);
  });

  it("knows YouTube's image hosts", () => {
    expect(isYouTubeImage("https://i.ytimg.com/vi/x/mqdefault.jpg")).toBe(true);
    expect(isYouTubeImage("https://i9.ytimg.com/sb/x/M0.jpg")).toBe(true);
    for (const url of ["http://i.ytimg.com/x.jpg", "https://i.ytimg.com.evil.example/x.jpg", "https://a@i.ytimg.com/x.jpg", "https://i.ytimg.com:8443/x.jpg", "nope"]) {
      expect(isYouTubeImage(url)).toBe(false);
    }
  });

  it("does not ask YouTube again right after a failure", async () => {
    let calls = 0;
    const thumbs = new Thumbnails("/p", { error() {} }, async () => (++calls === 1 ? null : jpeg));
    const url = thumbs.url(1, "dQw4w9WgXcQ");
    const first = fakeResponse();
    await thumbs.handle(request(url), first.res);
    const second = fakeResponse();
    await thumbs.handle(request(url), second.res);
    expect([first.result.status, second.result.status, calls]).toEqual([404, 404, 1]);
  });

  it("forgets the oldest of many", async () => {
    const thumbs = new Thumbnails("/p", console, async () => jpeg);
    const first = thumbs.url(1, "v0000000000");
    for (let i = 1; i < 2001; i++) thumbs.url(1, `v${String(i).padStart(10, "0")}`);
    const { res, result } = fakeResponse();
    await thumbs.handle(request(first), res);
    expect(result.status).toBe(404);
  });
});

describe("fitted", () => {
  it("shortens the queue until the state fits into one push", () => {
    const entry = (i: number) => ({ id: String(i), title: "字".repeat(500), duration: 1, live: false, state: "ready" as const, progress: null });
    const state = { channelId: 1, rev: 1, now: null, queue: Array.from({ length: 50 }, (_, i) => entry(i)), locked: false, error: null };
    expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(64 * 1024);
    const fit = fitted(state);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(60 * 1024);
    expect(fit.queue.length).toBeGreaterThan(20);
    expect(fit.queue[0]).toBe(state.queue[0]);
    const small = { ...state, queue: state.queue.slice(0, 3) };
    expect(fitted(small)).toBe(small);
  });
});

describe("closeWhenEmpty", () => {
  it("closes a player once its channel stayed empty, unless someone came back", async () => {
    const people = new Map([[1, 0], [2, 0]]);
    const closed: number[] = [];
    const empty = closeWhenEmpty({ isEmpty: (id) => people.get(id) === 0, hasPlayer: (id) => id !== 3, close: (id) => closed.push(id), delayMs: 20 });
    empty.left(1);
    empty.left(2);
    empty.left(3);
    empty.joined(2);
    people.set(2, 1);
    await Bun.sleep(50);
    expect(closed).toEqual([1]);
    empty.left(2);
    expect(closed).toEqual([1]);
    empty.stop();
  });
});

describe("formatTime", () => {
  it("formats like a player", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(75.9)).toBe("1:15");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});
