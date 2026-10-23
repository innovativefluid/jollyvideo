import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { UserError } from "../../src/server/errors";
import { QUALITIES } from "../../src/server/settings";
import { commonArgs, createYouTube, describeFailure, parseInfo, parsePlaylist, parseQuery, parseStart, pickFormat, pickLive, sourceArg, ytDlpEnv } from "../../src/server/youtube";

import { script } from "../helpers/fake-host";

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

  it("queues a playlist page, but plays the video of a link that is in one", () => {
    expect(parseQuery("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toEqual({ kind: "playlist", listId: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" });
    expect(parseQuery("https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf").kind).toBe("video");
    expect(sourceArg({ kind: "playlist", listId: "PL123456789" })).toBe("https://www.youtube.com/playlist?list=PL123456789");
    expect(() => parseQuery("https://www.youtube.com/playlist?list=../x")).toThrow(UserError);
  });

  it("searches for anything that is not a link", () => {
    expect(parseQuery("lofi  hip hop\nradio")).toEqual({ kind: "search", text: "lofi hip hop radio" });
    expect(parseQuery("\u0001lofi\u0000\u009bradio\u007f")).toEqual({ kind: "search", text: "lofi radio" });
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
    expect(args).toEqual(["--ignore-config", "--no-warnings", "--js-runtimes", "bun:/bun"]);
  });

  it("shows yt-dlp only what it needs of the environment, and its own temp folder", () => {
    const env = ytDlpEnv(
      { path: "/y", scratch: "/data/cache/tmp", jsRuntime: { args: [], env: { BUN_BE_BUN: "1" } } },
      "/data/cache/tmp/run",
      { PATH: "/usr/bin", HOME: "/home/bun", HTTPS_PROXY: "http://proxy", no_proxy: "local", LANG: "C.UTF-8", SHARKORD_OIDC_CLIENT_SECRET: "s3cret", DATABASE_URL: "x", TMPDIR: "/tmp" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      HTTPS_PROXY: "http://proxy",
      no_proxy: "local",
      LANG: "C.UTF-8",
      TMPDIR: "/data/cache/tmp/run",
      TEMP: "/data/cache/tmp/run",
      TMP: "/data/cache/tmp/run",
      BUN_BE_BUN: "1",
    });
  });
});

const video = (id: string, height: number, vcodec: string, fps = 30, extra: object = {}) => ({
  format_id: id,
  vcodec,
  acodec: "none",
  height,
  fps,
  tbr: height,
  ext: "mp4",
  protocol: "https",
  ...extra,
});
const audio = (id: string, acodec: string, abr: number, extra: object = {}) => ({ format_id: id, ext: "webm", vcodec: "none", acodec, abr, filesize: 1000, protocol: "https", ...extra });
const ids = (picked: ReturnType<typeof pickFormat>) => `${picked.parts?.video.formatId}+${picked.parts?.audio.formatId}`;

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
    expect(pickFormat(formats, q720p60)).toEqual({
      parts: {
        video: { formatId: "298", format: "298/bv[height<=720]", codec: expect.stringMatching(/^avc1/), copy: false, ext: "mp4", size: null },
        audio: { formatId: "251", format: "251/ba[acodec=opus][audio_channels<=?2]", codec: "opus", copy: true, ext: "webm", size: 1000 },
      },
      format: "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
      fps: 60,
    });
    expect(ids(pickFormat(formats, q720p30))).toBe("136+251");
    expect(ids(pickFormat(formats, q480))).toBe("135+251");
  });

  it("prefers stereo sound, and passes only stereo Opus through", () => {
    const stereo = audio("251", "opus", 130, { audio_channels: 2 });
    const surround = audio("338", "opus", 480, { audio_channels: 6 });
    const picked = pickFormat([video("136", 720, "avc1"), surround, stereo], q720p30).parts!.audio;
    expect(picked).toMatchObject({ formatId: "251", copy: true });
    const onlySurround = pickFormat([video("136", 720, "avc1"), surround], q720p30).parts!.audio;
    expect(onlySurround).toMatchObject({ formatId: "338", format: "338/ba", copy: false });
    const aac = pickFormat([video("136", 720, "avc1"), audio("140", "mp4a.40.2", 128)], q720p30).parts!.audio;
    expect(aac.copy).toBe(false);
  });

  it("takes the shortest video when nothing is short enough", () => {
    expect(ids(pickFormat([video("137", 1080, "avc1"), video("136", 720, "vp9"), audio("251", "opus", 130)], q480))).toBe("136+251");
  });

  it("leaves the choice to yt-dlp without separate video and audio", () => {
    expect(pickFormat([{ format_id: "18", vcodec: "avc1", acodec: "mp4a", height: 360 }], q720p30)).toEqual({
      parts: null,
      format: "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
      fps: null,
    });
  });

  it("skips DRM and HLS formats for downloads", () => {
    const picked = pickFormat([video("drm", 720, "avc1", 30, { has_drm: true }), video("hls", 720, "avc1", 30, { protocol: "m3u8_native" }), video("ok", 480, "vp9"), audio("251", "opus", 1)], q720p30);
    expect(ids(picked)).toBe("ok+251");
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
  const info = (extra: object) => JSON.stringify({ id: "dQw4w9WgXcQ", title: " Title\u0007 ", duration: 212.4, formats: [video("136", 720, "avc1"), audio("251", "opus", 1)], ...extra });

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

describe("parsePlaylist", () => {
  it("keeps the playable entries in order", () => {
    const entries = [
      { id: "aaaaaaaaaaa", title: "One", duration: 61.2 },
      { id: "bbbbbbbbbbb", title: "[Private video]", duration: null },
      { id: "ccccccccccc", title: "[Deleted video]" },
      { id: "bad", title: "Bad id" },
      { id: "ddddddddddd", title: " Two ", duration: null },
    ];
    expect(parsePlaylist(`${JSON.stringify({ _type: "playlist", entries })}\n`)).toEqual([
      { videoId: "aaaaaaaaaaa", title: "One", duration: 61 },
      { videoId: "ddddddddddd", title: "Two", duration: 0 },
    ]);
    expect(parsePlaylist("")).toEqual([]);
  });
});

describe("describeFailure", () => {
  it("says what went wrong without yt-dlp's details", () => {
    expect(describeFailure("WARNING: x\nERROR: [youtube] abc: Sign in to confirm you’re not a bot.")).toBe("yt.signIn");
    expect(describeFailure("ERROR: [youtube] abc: Private video. Sign in if you've been granted access")).toBe("yt.private");
    expect(describeFailure("ERROR: [youtube] abc: Video unavailable")).toBe("yt.unavailable");
    expect(describeFailure("ERROR: unable to write data: [Errno 28] No space left on device")).toBe("error.disk");
    expect(describeFailure("ERROR: something new")).toBe("yt.failed");
  });
});

describe("yt-dlp runs", () => {
  it("each get a temp folder of their own, as their working folder, with a copy of the cookies, removed afterwards", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jv-runs-"));
    const scratch = path.join(dir, "scratch");
    mkdirSync(scratch);
    writeFileSync(path.join(dir, "cookies.txt"), "# cookies");
    // notes where it ran, what it was given, and leaves something behind like a stopped PyInstaller program
    const ytDlp = script(
      dir,
      "yt-dlp",
      `pwd > "${dir}/pwd.txt"; echo "$TMPDIR" > "${dir}/tmp.txt"; for a in "$@"; do [ "$prev" = "--cookies" ] && cat "$a" > "${dir}/cookies-seen.txt"; prev="$a"; done
mkdir -p "$TMPDIR/_MEI123"; echo x > "$TMPDIR/_MEI123/lib"
echo '{"id":"dQw4w9WgXcQ","title":"t","duration":1,"formats":[]}'`,
    );
    const youtube = createYouTube(() => ({ path: ytDlp, cookies: path.join(dir, "cookies.txt"), scratch, jsRuntime: { args: [], env: {} } }), { error() {} });
    await youtube.resolve(parseQuery("anything"), q720p30, new AbortController().signal);
    const ran = readFileSync(path.join(dir, "pwd.txt"), "utf-8").trim();
    expect(path.dirname(ran)).toBe(scratch);
    expect(readFileSync(path.join(dir, "tmp.txt"), "utf-8").trim()).toBe(ran);
    expect(readFileSync(path.join(dir, "cookies-seen.txt"), "utf-8")).toBe("# cookies");
    expect(readdirSync(scratch)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
