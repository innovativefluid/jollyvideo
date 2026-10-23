import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { formatTime } from "../../src/client/format";
import { boxWidth, encoderArgs, h264Level, type TEncodeOptions } from "../../src/server/encoder";
import { parseControl } from "../../src/server/index";
import { closeWhenEmpty } from "../../src/server/players";
import { QUALITIES, readSettings } from "../../src/server/settings";
import { Thumbnails } from "../../src/server/thumbnails";

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
    expect(inputs.join(" ")).toContain("-follow 1 -ss 30 -re -i /c/video.mp4 -follow 1 -ss 30 -re -i /c/audio.webm");
    expect(args[args.indexOf("-map", args.indexOf("rtp://127.0.0.1:5000?pkt_size=1200")) + 1]).toBe("1:a:0");
    expect(args.filter((arg) => arg === "-t")).toHaveLength(2);
    expect(args[args.indexOf("-t") + 1]).toBe("171");
    // a finished file needs neither
    const done = encoderArgs(options({ input: { video: "/v", audio: "/a" } }));
    expect(done).not.toContain("-follow");
    expect(done).not.toContain("-t");
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

  it("serves only videos someone queued, behind a key, fetched once", async () => {
    const fetched: string[] = [];
    const thumbs = new Thumbnails("/plugins/jollyvideo", console, async (id) => {
      fetched.push(id);
      return jpeg;
    });
    const url = thumbs.url("dQw4w9WgXcQ");
    expect(url).toMatch(/^\/plugins\/jollyvideo\/thumb\/[0-9a-f]{32}\/dQw4w9WgXcQ\.jpg$/);
    const key = url.split("/")[4]!;

    for (let i = 0; i < 2; i++) {
      const { res, result } = fakeResponse();
      await thumbs.handle(request(url), res);
      expect(result.status).toBe(200);
      expect(result.headers["Content-Type"]).toBe("image/jpeg");
      expect(result.body).toBe(jpeg);
    }
    expect(fetched).toEqual(["dQw4w9WgXcQ"]);

    for (const url of [
      `/plugins/jollyvideo/thumb/${key}/aaaaaaaaaaa.jpg`,
      `/plugins/jollyvideo/thumb/${"0".repeat(32)}/dQw4w9WgXcQ.jpg`,
      "/plugins/jollyvideo/thumb/dQw4w9WgXcQ.jpg",
      `/plugins/jollyvideo/thumb/${key}/../x.jpg`,
    ]) {
      const { res, result } = fakeResponse();
      await thumbs.handle(request(url), res);
      expect(result.status).toBe(404);
    }
    expect(fetched).toEqual(["dQw4w9WgXcQ"]);
  });

  it("does not ask YouTube again right after a failure", async () => {
    let calls = 0;
    const thumbs = new Thumbnails("/p", { error() {} }, async () => (++calls === 1 ? null : jpeg));
    const url = thumbs.url("dQw4w9WgXcQ");
    const first = fakeResponse();
    await thumbs.handle(request(url), first.res);
    const second = fakeResponse();
    await thumbs.handle(request(url), second.res);
    expect([first.result.status, second.result.status, calls]).toEqual([404, 404, 1]);
  });

  it("forgets the oldest of many", async () => {
    const thumbs = new Thumbnails("/p", console, async () => jpeg);
    const first = thumbs.url("v0000000000");
    for (let i = 1; i < 201; i++) thumbs.url(`v${String(i).padStart(10, "0")}`);
    const { res, result } = fakeResponse();
    await thumbs.handle(request(first), res);
    expect(result.status).toBe(404);
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
