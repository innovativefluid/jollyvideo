import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { Toolbox } from "../../src/server/tools";

const quiet = { log() {}, error() {} };
const realFetch = globalThis.fetch;
let dir: string;
const saved = { PATH: process.env.PATH, yt: process.env.JOLLYVIDEO_YT_DLP, ff: process.env.JOLLYVIDEO_FFMPEG };

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const binary = new TextEncoder().encode("#!/bin/sh\necho 2099.01.01\n");

/** GitHub's release API and download, with the asset digest given */
const fakeGitHub = (digest: string | undefined) => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url === "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest") {
      const names = ["yt-dlp_linux", "yt-dlp_linux_aarch64", "yt-dlp.exe", "yt-dlp_macos"];
      return Response.json({
        tag_name: "2099.01.01",
        assets: names.map((name) => ({ name, browser_download_url: `https://github.com/download/${name}`, digest })),
      });
    }
    if (url.startsWith("https://github.com/download/")) return new Response(binary);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return requests;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jv-tools-"));
  process.env.PATH = "/nonexistent";
  delete process.env.JOLLYVIDEO_YT_DLP;
  delete process.env.JOLLYVIDEO_FFMPEG;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PATH = saved.PATH;
  if (saved.yt) process.env.JOLLYVIDEO_YT_DLP = saved.yt;
  if (saved.ff) process.env.JOLLYVIDEO_FFMPEG = saved.ff;
  rmSync(dir, { recursive: true, force: true });
});

describe("Toolbox", () => {
  it("prefers the environment, then its own copy, then PATH", () => {
    const tools = new Toolbox(dir, quiet);
    const onPath = path.join(dir, "path");
    mkdirSync(onPath);
    writeFileSync(path.join(onPath, "ffmpeg"), "", { mode: 0o755 });
    process.env.PATH = onPath;
    expect(tools.ffmpeg()).toBe(path.join(onPath, "ffmpeg"));
    mkdirSync(tools.binDir, { recursive: true });
    writeFileSync(path.join(tools.binDir, "ffmpeg"), "", { mode: 0o755 });
    expect(tools.ffmpeg()).toBe(path.join(tools.binDir, "ffmpeg"));
    process.env.JOLLYVIDEO_FFMPEG = "/opt/ffmpeg";
    expect(tools.ffmpeg()).toBe("/opt/ffmpeg");
    expect(tools.cookies()).toBeUndefined();
    writeFileSync(path.join(tools.binDir, "cookies.txt"), "# cookies");
    expect(tools.cookies()).toBe(path.join(tools.binDir, "cookies.txt"));
  });

  it("falls back to the server's own Bun for yt-dlp's JavaScript", () => {
    expect(new Toolbox(dir, quiet).jsRuntime()).toEqual({
      args: ["--js-runtimes", `bun:${process.execPath}`],
      env: expect.objectContaining({ BUN_BE_BUN: "1" }),
    });
  });

  it("installs yt-dlp when its SHA-256 matches GitHub's", async () => {
    process.env.JOLLYVIDEO_FFMPEG = "/opt/ffmpeg";
    const requests = fakeGitHub(`sha256:${sha256(binary)}`);
    const tools = new Toolbox(dir, quiet);
    await tools.ensure();
    expect(tools.ytDlp()).toBe(path.join(tools.binDir, "yt-dlp"));
    expect(readFileSync(tools.ytDlp()!)).toEqual(Buffer.from(binary));
    expect(JSON.parse(readFileSync(path.join(tools.binDir, "installed.json"), "utf-8"))["yt-dlp"]).toMatchObject({ version: "2099.01.01" });
    expect(requests).toHaveLength(2);
    expect(await tools.ytDlpAge()).toBeLessThan(0.01);
  });

  it("throws a download away when its SHA-256 differs, and keeps nothing", async () => {
    process.env.JOLLYVIDEO_FFMPEG = "/opt/ffmpeg";
    fakeGitHub(`sha256:${"0".repeat(64)}`);
    const tools = new Toolbox(dir, quiet);
    await expect(tools.ensure()).rejects.toThrow("does not match its SHA-256");
    expect(tools.ytDlp()).toBeUndefined();
    expect(readdirSync(tools.binDir)).toEqual([]);
  });

  it("refuses a release without a digest", async () => {
    process.env.JOLLYVIDEO_FFMPEG = "/opt/ffmpeg";
    fakeGitHub(undefined);
    await expect(new Toolbox(dir, quiet).ensure()).rejects.toThrow("has no checksummed");
  });

  it("runs one install at a time", async () => {
    process.env.JOLLYVIDEO_FFMPEG = "/opt/ffmpeg";
    const requests = fakeGitHub(`sha256:${sha256(binary)}`);
    const tools = new Toolbox(dir, quiet);
    const first = tools.ensure();
    expect(tools.installing).toBe(true);
    expect(tools.ensure()).toBe(first);
    await first;
    expect(tools.installing).toBe(false);
    expect(requests).toHaveLength(2);
    expect(existsSync(path.join(tools.binDir, "yt-dlp"))).toBe(true);
  });
});
