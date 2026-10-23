/**
 * The arguments the plugin gives yt-dlp, read by a real yt-dlp. Its network
 * goes to a closed port, so it fails right after reading them: exit code 1 for
 * that, 2 for arguments it does not understand. Needs yt-dlp:
 * JOLLYVIDEO_YT_DLP, or one on PATH.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { QUALITIES } from "../../src/server/settings";
import { createYouTube, parseQuery, type TResolved } from "../../src/server/youtube";
import { script } from "../helpers/fake-host";

const ytDlp = process.env.JOLLYVIDEO_YT_DLP ?? Bun.which("yt-dlp");
const dir = mkdtempSync(path.join(os.tmpdir(), "jv-ytdlp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ytDlp)("yt-dlp", () => {
  // runs the real yt-dlp through a dead proxy, and notes how it exited
  const wrapper = script(
    dir,
    "yt-dlp",
    `args=()
for arg in "$@"; do
  if [ "$arg" = "--" ]; then args+=("--proxy" "http://127.0.0.1:9" "--socket-timeout" "2" "--retries" "0" "--extractor-retries" "0"); fi
  args+=("$arg")
done
"${ytDlp}" "\${args[@]}" > "${dir}/out.txt" 2>&1
echo $? > "${dir}/code.txt"
exit 0`,
  );
  const youtube = createYouTube(
    () => ({ path: wrapper, ffmpeg: "/usr/bin/ffmpeg", cookies: path.join(dir, "cookies.txt"), jsRuntime: { args: ["--js-runtimes", `bun:${process.execPath}`], env: process.env } }),
    { error() {} },
  );
  const accepted = () => ({ code: readFileSync(path.join(dir, "code.txt"), "utf-8").trim(), output: readFileSync(path.join(dir, "out.txt"), "utf-8") });

  it("accepts the lookup's arguments", async () => {
    await youtube.resolve(parseQuery("--exec touch /tmp/x"), QUALITIES["720p60"]!, new AbortController().signal).catch(() => {});
    const { code, output } = accepted();
    expect(output).not.toContain("Usage:");
    expect(code).toBe("1");
  });

  it("accepts the download's arguments", async () => {
    const video: TResolved = {
      videoId: "dQw4w9WgXcQ",
      title: "t",
      duration: 1,
      live: false,
      start: 0,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      format: "136+251/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
      fps: 30,
    };
    await youtube.download(video, dir, () => {}, new AbortController().signal).catch(() => {});
    const { code, output } = accepted();
    expect(output).not.toContain("Usage:");
    expect(code).toBe("1");
  });
});
