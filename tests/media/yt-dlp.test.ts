/**
 * The arguments the plugin gives yt-dlp, read by a real yt-dlp. Its network
 * goes to a closed port, so it fails right after reading them: exit code 1 for
 * that, 2 for arguments it does not understand. Needs yt-dlp:
 * JOLLYVIDEO_YT_DLP, or one on PATH.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { QUALITIES } from "../../src/server/settings";
import { createYouTube, parseQuery, type TResolved } from "../../src/server/youtube";
import { script } from "../helpers/fake-host";

const ytDlp = process.env.JOLLYVIDEO_YT_DLP ?? Bun.which("yt-dlp");
const dir = mkdtempSync(path.join(os.tmpdir(), "jv-ytdlp-"));
writeFileSync(path.join(dir, "cookies.txt"), "# Netscape HTTP Cookie File\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ytDlp)("yt-dlp", () => {
  // runs the real yt-dlp through a dead proxy, and notes how it exited
  const wrapper = script(
    dir,
    "yt-dlp",
    `"${ytDlp}" --proxy http://127.0.0.1:9 --socket-timeout 2 --retries 0 --extractor-retries 0 "$@" > "${dir}/out.txt" 2>&1
echo $? > "${dir}/code.txt"
exit 0`,
  );
  const youtube = createYouTube(
    () => ({ path: wrapper, ffmpeg: "/usr/bin/ffmpeg", cookies: path.join(dir, "cookies.txt"), scratch: dir, jsRuntime: { args: ["--js-runtimes", `bun:${process.execPath}`], env: {} } }),
    { error() {} },
  );
  const accepted = () => ({ code: readFileSync(path.join(dir, "code.txt"), "utf-8").trim(), output: readFileSync(path.join(dir, "out.txt"), "utf-8") });

  it("accepts the lookup's arguments", async () => {
    await youtube.resolve(parseQuery("--exec touch /tmp/x"), QUALITIES["720p60"]!, new AbortController().signal).catch(() => {});
    const { code, output } = accepted();
    expect(output).not.toContain("Usage:");
    expect(code).toBe("1");
  });

  const video: TResolved = {
    videoId: "dQw4w9WgXcQ",
    title: "t",
    duration: 1,
    live: false,
    start: 0,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    parts: {
      video: { formatId: "136", format: "136/bv[height<=720]", codec: "avc1", copy: false, ext: "mp4", size: null },
      audio: { formatId: "251", format: "251/ba[acodec=opus][audio_channels<=?2]", codec: "opus", copy: true, ext: "webm", size: null },
    },
    format: "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    fps: 30,
  };
  const parsed = () => {
    const { code, output } = accepted();
    expect(output).not.toContain("Usage:");
    expect(code).toBe("1");
  };

  it("accepts the arguments of a single format's download", async () => {
    await youtube.downloadPart(video, video.parts!.video, path.join(dir, "video.mp4"), () => {}, new AbortController().signal).catch(() => {});
    parsed();
  });

  it("downloads from the lookup's info JSON without looking the video up again", async () => {
    const info = path.join(dir, "info.json");
    writeFileSync(
      info,
      JSON.stringify({
        id: "dQw4w9WgXcQ",
        title: "t",
        extractor: "youtube",
        extractor_key: "Youtube",
        webpage_url: video.url,
        formats: [{ format_id: "136", url: "https://127.0.0.1:9/v.mp4", ext: "mp4", vcodec: "avc1", acodec: "none", protocol: "https", height: 720 }],
      }),
    );
    const parts = path.join(dir, "parts");
    mkdirSync(parts, { recursive: true });
    await youtube.downloadPart({ ...video, info }, video.parts!.video, path.join(parts, "video.mp4"), () => {}, new AbortController().signal).catch(() => {});
    parsed();
    expect(accepted().output).toContain("Downloading 1 format(s): 136");
  });

  it("accepts the arguments of a merged download", async () => {
    await youtube.downloadMerged(video, dir, () => {}, new AbortController().signal).catch(() => {});
    parsed();
    // each run used its own copy of the cookies, and removed it
    expect(readdirSync(dir).filter((name) => /^[0-9a-f-]{36}$/.test(name))).toEqual([]);
  });

  it("accepts the arguments of a playlist lookup", async () => {
    await youtube.playlist("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf", new AbortController().signal).catch(() => {});
    parsed();
  });
});
