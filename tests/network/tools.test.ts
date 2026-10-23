/**
 * Downloads the real yt-dlp and ffmpeg the way a fresh server does, and checks
 * they run. Needs GitHub: `bun run test:network`.
 */
import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { Toolbox } from "../../src/server/tools";

const dir = mkdtempSync(path.join(os.tmpdir(), "jv-tools-"));
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

const output = async (cmd: string[]) => {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return text;
};

const fresh = () => {
  // nothing installed to fall back on
  process.env.PATH = "/nonexistent";
  delete process.env.JOLLYVIDEO_YT_DLP;
  delete process.env.JOLLYVIDEO_FFMPEG;
  return new Toolbox(mkdtempSync(path.join(dir, "data-")), console);
};
const leftovers = async (tools: Toolbox) => Array.fromAsync(new Bun.Glob(".*").scan({ cwd: tools.binDir, dot: true }));

it("installs the pinned ffmpeg, with x264 and Opus", async () => {
  const tools = fresh();
  tools.ytDlp = () => "/present";
  await tools.ensure();
  process.env.PATH = savedPath;
  expect(tools.ffmpeg()).toBe(path.join(tools.binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  const encoders = await output([tools.ffmpeg()!, "-hide_banner", "-encoders"]);
  expect(encoders).toContain("libx264");
  expect(encoders).toContain("libopus");
  expect(Object.keys(JSON.parse(readFileSync(path.join(tools.binDir, "installed.json"), "utf-8")))).toEqual(["ffmpeg"]);
  expect(await leftovers(tools)).toEqual([]);
}, 600_000);

it("installs the latest yt-dlp, checked against GitHub's digest", async () => {
  const tools = fresh();
  tools.ffmpeg = () => "/present";
  await tools.ensure();
  process.env.PATH = savedPath;
  expect(tools.ytDlp()).toBe(path.join(tools.binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
  expect(await output([tools.ytDlp()!, "--version"])).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  expect(await tools.ytDlpAge()).toBeLessThan(0.01);
  expect(existsSync(path.join(tools.binDir, "installed.json"))).toBe(true);
  expect(await leftovers(tools)).toEqual([]);
}, 600_000);
