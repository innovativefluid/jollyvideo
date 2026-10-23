/**
 * The packed release, unpacked the way Sharkord's installer does it, then
 * loaded. Run after `bun run build`.
 */
import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import * as React from "react";
import * as JSX from "react/jsx-runtime";
import manifest from "../../manifest.json";
import { fakeHost, fakeYtDlp, script } from "../helpers/fake-host";

const dist = path.join(import.meta.dir, "../../dist");
const archive = path.join(dist, `${manifest.id}-${manifest.version}.tar.gz`);
const dir = mkdtempSync(path.join(os.tmpdir(), "jv-package-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("is one plugin folder with a checksum", async () => {
  expect(existsSync(archive)).toBe(true);
  const bytes = await Bun.file(archive).bytes();
  const [sum] = readFileSync(`${archive}.sha256`, "utf-8").split(" ");
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sum!);
  const unpacked = new Bun.Archive(bytes);
  for (const name of (await unpacked.files()).keys()) expect(path.resolve(dir, name).startsWith(dir + path.sep)).toBe(true);
  await unpacked.extract(dir);
  expect(readdirSync(dir)).toEqual([manifest.id]);
  expect(readdirSync(path.join(dir, manifest.id)).sort()).toEqual(["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "client", "manifest.json", "server"]);
  expect(JSON.parse(readFileSync(path.join(dir, manifest.id, "manifest.json"), "utf-8"))).toEqual(manifest);
});

it("loads and unloads its server half", async () => {
  process.env.JOLLYVIDEO_YT_DLP = fakeYtDlp(dir, { id: "dQw4w9WgXcQ", title: "t", duration: 1, formats: [] });
  process.env.JOLLYVIDEO_FFMPEG = script(dir, "ffmpeg", "exit 1");
  const plugin = await import(path.join(dir, manifest.id, "server/index.js"));
  const host = fakeHost({ dataPath: path.join(dir, "data") });
  await plugin.onLoad(host.ctx);
  expect([...host.actions.keys()]).toEqual(["state", "add", "control"]);
  expect(await host.action("state", 1, 2)).toMatchObject({ player: { channelId: 2 } });
  plugin.onUnload();
  delete process.env.JOLLYVIDEO_YT_DLP;
  delete process.env.JOLLYVIDEO_FFMPEG;
});

it("hands Sharkord one voice controls button, on Sharkord's React", async () => {
  const globals = globalThis as Record<string, unknown>;
  globals.window = { __SHARKORD_REACT__: React, __SHARKORD_REACT_JSX__: JSX };
  const client = await import(path.join(dir, manifest.id, "client/index.js"));
  expect(Object.keys(client.components)).toEqual(["voice_controls"]);
  expect(client.components.voice_controls).toHaveLength(1);
  // no React of its own inside
  expect(readFileSync(path.join(dir, manifest.id, "client/index.js"), "utf-8")).not.toContain("react.production");
  delete globals.window;
});
