import { describe, expect, it } from "bun:test";
import { UserError } from "../../src/server/errors";
import { QUALITIES } from "../../src/server/settings";
import { commonArgs, describeFailure, parseInfo, parseQuery, parseStart, pickFormat, pickLive, sourceArg } from "../../src/server/youtube";

const q720p60 = QUALITIES["720p60"]!;
const q720p30 = QUALITIES["720p30"]!;
const q480 = QUALITIES["480p30"]!;

describe("parseQuery", () => {
  it("reads video links in their usual shapes", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2",
      "http://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?si=abc",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "  youtu.be/dQw4w9WgXcQ  ",
    ]) {
      expect(parseQuery(link)).toEqual({ kind: "video", videoId: "dQw4w9WgXcQ", start: 0 });
    }
  });

  it("keeps the start time", () => {
    expect(parseQuery("https://youtu.be/dQw4w9WgXcQ?t=90")).toMatchObject({ start: 90 });
    expect(parseQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toMatchObject({ start: 90 });
    expect(parseStart("1h2m3s")).toBe(3723);
    expect(parseStart("90s")).toBe(90);
    expect(parseStart("soon")).toBe(0);
    expect(parseStart(null)).toBe(0);
  });

  it("takes a channel's live page", () => {
    expect(parseQuery("https://www.youtube.com/@LofiGirl/live")).toEqual({ kind: "channelLive", url: "https://www.youtube.com/@LofiGirl/live" });
    expect(sourceArg(parseQuery("youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live/"))).toBe(
      "https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live",
    );
  });

  it("searches for anything that is not a link", () => {
    expect(parseQuery("lofi  hip hop\nradio")).toEqual({ kind: "search", text: "lofi hip hop radio" });
    expect(sourceArg(parseQuery("--exec rm"))).toBe("ytsearch1:--exec rm");
  });

  it("refuses other sites, other schemes and non-video pages", () => {
    for (const bad of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "file:///etc/passwd",
      "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/@channel",
      "https://user:pass@evil.example/@youtube.com/watch",
    ]) {
      expect(() => parseQuery(bad)).toThrow(UserError);
    }
    expect(() => parseQuery("   ")).toThrow(UserError);
    expect(() => parseQuery("x".repeat(501))).toThrow("too long");
  });

  it("ignores config files and passes the JavaScript runtime", () => {
    const args = commonArgs({ path: "/y", cookies: "/c.txt", scratch: "/tmp", jsRuntime: { args: ["--js-runtimes", "bun:/bun"], env: {} } });
    expect(args).toEqual(["--ignore-config", "--no-playlist", "--no-warnings", "--js-runtimes", "bun:/bun"]);
  });
});

const video = (id: string, height: number, vcodec: string, fps = 30, extra: object = {}) => ({
  format_id: id,
  vcodec,
  acodec: "none",
  height,
  fps,
  tbr: height,
  protocol: "https",
  ...extra,
});
const audio = (id: string, acodec: string, abr: number, extra: object = {}) => ({ format_id: id, vcodec: "none", acodec, abr, protocol: "https", ...extra });

describe("pickFormat", () => {
  const formats = [
    video("137", 1080, "avc1.640028"),
    video("136", 720, "avc1.4d401f"),
    video("298", 720, "avc1.4d4020", 60),
    video("302", 720, "vp9", 60),
    video("398", 720, "av01.0.05M.08", 60),
    video("247", 720, "vp9"),
    video("135", 480, "avc1.4d401e"),
    video("hdr", 720, "vp09.02", 60, { dynamic_range: "HDR10" }),
    audio("140", "mp4a.40.2", 129),
    audio("251", "opus", 130),
    audio("251-drc", "opus", 140, { format_note: "medium, DRC" }),
    audio("251-dub", "opus", 160, { language_preference: -1 }),
    { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, protocol: "https" },
    { format_id: "sb0", vcodec: "none", acodec: "none", protocol: "mhtml" },
  ];

  it("goes as tall as allowed at the allowed frame rate, preferring H.264, SDR and the original full-range Opus track", () => {
    expect(pickFormat(formats, q720p60)).toEqual({ format: "298+251/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b", fps: 60 });
    expect(pickFormat(formats, q720p30).format.split("/")[0]).toBe("136+251");
    expect(pickFormat(formats, q480).format.split("/")[0]).toBe("135+251");
  });

  it("takes the shortest video when nothing is short enough", () => {
    expect(pickFormat([video("137", 1080, "avc1"), video("136", 720, "vp9"), audio("251", "opus", 130)], q480).format.split("/")[0]).toBe("136+251");
  });

  it("leaves the choice to yt-dlp without separate video and audio", () => {
    expect(pickFormat([{ format_id: "18", vcodec: "avc1", acodec: "mp4a", height: 360 }], q720p30)).toEqual({
      format: "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
      fps: null,
    });
  });

  it("skips DRM and HLS formats for downloads", () => {
    const picked = pickFormat([video("drm", 720, "avc1", 30, { has_drm: true }), video("hls", 720, "avc1", 30, { protocol: "m3u8_native" }), video("ok", 480, "vp9"), audio("251", "opus", 1)], q720p30);
    expect(picked.format.split("/")[0]).toBe("ok+251");
  });
});

describe("pickLive", () => {
  const hls = (id: string, height: number, fps = 30) => ({
    format_id: id,
    vcodec: "avc1.4d401f",
    acodec: "mp4a.40.2",
    height,
    fps,
    protocol: "m3u8_native",
    url: `https://manifest.googlevideo.com/${id}.m3u8`,
  });
  it("picks the tallest muxed playlist within the quality", () => {
    const formats = [hls("96", 1080, 60), hls("95", 720, 60), hls("94", 480), video("x", 720, "avc1")];
    expect(pickLive(formats, q720p60)?.format_id).toBe("95");
    expect(pickLive(formats, q480)?.format_id).toBe("94");
  });
});

describe("parseInfo", () => {
  const info = (extra: object) => JSON.stringify({ id: "dQw4w9WgXcQ", title: " Title ", duration: 212.4, formats: [video("136", 720, "avc1"), audio("251", "opus", 1)], ...extra });

  it("reads a video", () => {
    const parsed = parseInfo(`${info({})}\n`, { kind: "video", videoId: "dQw4w9WgXcQ", start: 30 }, q720p30);
    expect(parsed).toMatchObject({ videoId: "dQw4w9WgXcQ", title: "Title", duration: 212, live: false, start: 30, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("ignores a start time past the end", () => {
    expect(parseInfo(info({}), { kind: "video", videoId: "dQw4w9WgXcQ", start: 999 }, q720p30).start).toBe(0);
  });

  it("reads a livestream's playlist", () => {
    const parsed = parseInfo(
      info({ live_status: "is_live", formats: [{ format_id: "95", vcodec: "avc1", acodec: "mp4a", height: 720, protocol: "m3u8_native", url: "https://m/95.m3u8", http_headers: { "User-Agent": "UA" } }] }),
      { kind: "search", text: "x" },
      q720p30,
    );
    expect(parsed).toMatchObject({ live: true, duration: 0, hls: { url: "https://m/95.m3u8", headers: { "User-Agent": "UA" } } });
  });

  it("refuses what cannot be played", () => {
    expect(() => parseInfo(info({ live_status: "is_upcoming" }), { kind: "search", text: "x" }, q720p30)).toThrow("hasn't started");
    expect(() => parseInfo(info({ id: "../../etc" }), { kind: "search", text: "x" }, q720p30)).toThrow(UserError);
    expect(() => parseInfo("", { kind: "search", text: "x" }, q720p30)).toThrow("Nothing found");
    expect(() => parseInfo(info({ live_status: "is_live", formats: [] }), { kind: "search", text: "x" }, q720p30)).toThrow(UserError);
  });
});

describe("describeFailure", () => {
  it("says what went wrong without yt-dlp's details", () => {
    expect(describeFailure("WARNING: x\nERROR: [youtube] abc: Sign in to confirm you’re not a bot.")).toBe("YouTube wants the server to sign in");
    expect(describeFailure("ERROR: [youtube] abc: Private video. Sign in if you've been granted access")).toBe("This video is private");
    expect(describeFailure("ERROR: [youtube] abc: Video unavailable")).toBe("This video isn't available");
    expect(describeFailure("ERROR: something new")).toBe("Couldn't load this video");
  });
});
