/**
 * Everything the end-to-end test needs around Sharkord: the demo video as
 * YouTube serves it (separate video and audio), a yt-dlp stand-in that
 * "downloads" it, and the plugin installed and enabled in Sharkord's seeded
 * data. Prints the environment for the Sharkord server.
 *
 *   bun e2e/setup.ts <sharkord e2e data dir> <work dir>
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { fakeYtDlp } from "../tests/helpers/fake-host";

const [data, work] = process.argv.slice(2) as [string, string];
const ffmpeg = process.env.JOLLYVIDEO_FFMPEG;
if (!data || !work || !ffmpeg) throw new Error("usage: JOLLYVIDEO_FFMPEG=… bun e2e/setup.ts <data dir> <work dir>");
mkdirSync(work, { recursive: true });

const run = async (args: string[]) => {
  const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
};

// two minutes of slowly drifting colour with a soft tone
const video = path.join(work, "video.mp4");
const audio = path.join(work, "audio.webm");
await run([
  "-f", "lavfi", "-i", "gradients=s=1280x720:r=30:c0=0xf97316:c1=0x7c3aed:c2=0x0ea5e9:nb_colors=3:speed=0.01:duration=120",
  "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p",
  "-f", "mp4", "-movflags", "+dash+global_sidx", video,
]);
// like YouTube's: each with its index up front
await run(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=120", "-af", "volume=0.2", "-c:a", "libopus", "-f", "webm", "-dash", "1", "-cues_to_front", "1", audio]);

const ytDlp = fakeYtDlp(work, {
  id: "jvDemo00001",
  title: "Sunset over the bay",
  duration: 120,
  // more videos for the queue, from the same files
  byQuery: { harbor: { id: "jvDemo00002", title: "Harbor lights" }, night: { id: "jvDemo00003", title: "Night drive" } },
  formats: [
    { format_id: "v", ext: "mp4", vcodec: "avc1.64001f", acodec: "none", height: 720, fps: 30, protocol: "https", filesize: Bun.file(video).size },
    { format_id: "a", ext: "webm", vcodec: "none", acodec: "opus", abr: 64, protocol: "https", filesize: Bun.file(audio).size },
  ],
});

// installed like a dropped-in plugin, and switched on
cpSync(path.join(import.meta.dir, "../dist/jollyvideo"), path.join(data, "plugins/jollyvideo"), { recursive: true });
const db = new Database(path.join(data, "db.sqlite"));
db.run("INSERT INTO plugin_data (plugin_id, enabled, settings) VALUES ('jollyvideo', 1, '{}')");

// a tidier server for the screenshot: no test plugin, friendlier names
rmSync(path.join(data, "plugins/e2e-plugin"), { recursive: true, force: true });
db.run("DELETE FROM plugin_data WHERE plugin_id = 'e2e-plugin'");
db.run("UPDATE settings SET name = 'Movie Night'");
db.run("UPDATE users SET name = 'Alex' WHERE identity = 'testowner'");
db.run("UPDATE categories SET name = 'Hangout' WHERE name = 'E2E Channels'");
for (const [from, to] of [["Infinite Scroll", "clips"], ["Messages Render", "memes"], ["Live Messages", "off-topic"]] as const) {
  db.run("UPDATE channels SET name = ? WHERE name = ?", [to, from]);
}
db.close();

const env = {
  JOLLYVIDEO_YT_DLP: ytDlp,
  JV_FIXTURE_VIDEO: video,
  JV_FIXTURE_AUDIO: audio,
  // the video arrives over 5 seconds, so playback starts before it is all in
  JV_RATE: String(Math.ceil(Bun.file(video).size / 5)),
  SHARKORD_WEBRTC_ANNOUNCED_ADDRESS: "127.0.0.1",
};
for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
