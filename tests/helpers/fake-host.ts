/**
 * A stand-in for what Sharkord hands `onLoad`, recording what the plugin does
 * with it. Voice is a real mediasoup router when one is given.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { Router } from "mediasoup/types";

type THandler = (...args: never[]) => unknown;

export type TFakeStream = {
  options: Record<string, unknown>;
  updates: Record<string, unknown>[];
  removed: boolean;
};

export const fakeHost = (options: { router?: Router; moderators?: number[]; dataPath?: string } = {}) => {
  const actions = new Map<string, { requires?: string; executes: THandler }>();
  const commands = new Map<string, { requires?: string; ephemeral?: boolean; executes: THandler }>();
  const routes = new Map<string, THandler>();
  const events = new Map<string, THandler>();
  const pushes: { channelId: number; data: unknown }[] = [];
  const streams: TFakeStream[] = [];
  const logs: string[] = [];
  const settings = new Map<string, unknown>();
  let ui: unknown;
  const moderators = new Set(options.moderators ?? []);
  let permissionError: Error | null = null;

  const ctx = {
    path: "/plugins/jollyvideo",
    dataPath: options.dataPath ?? mkdtempSync(path.join(os.tmpdir(), "jv-data-")),
    pluginId: "jollyvideo",
    logger: {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      debug: () => {},
      error: (...args: unknown[]) => logs.push(`ERROR ${args.join(" ")}`),
    },
    settings: {
      register: async (definitions: readonly { key: string; defaultValue: unknown }[]) => {
        for (const definition of definitions) if (!settings.has(definition.key)) settings.set(definition.key, definition.defaultValue);
        return { get: (key: string) => settings.get(key), set: (key: string, value: unknown) => settings.set(key, value) };
      },
    },
    actions: { register: (action: { name: string; requires?: string; executes: THandler }) => actions.set(action.name, action) },
    commands: { register: (command: { name: string; requires?: string; ephemeral?: boolean; executes: THandler }) => commands.set(command.name, command) },
    http: { get: (route: string, handler: THandler) => routes.set(route, handler) },
    events: {
      on: (event: string, handler: THandler) => {
        events.set(event, handler);
        return () => events.delete(event);
      },
    },
    push: { toVoiceChannel: (channelId: number, data: unknown) => pushes.push({ channelId, data }) },
    permissions: {
      userCan: async (userId: number, permission: string) => {
        if (permissionError) throw permissionError;
        return permission === "MOVE_MEMBERS" && moderators.has(userId);
      },
    },
    voice: {
      getRouter: (channelId: number) => {
        if (!options.router) throw new Error(`no voice runtime for channel ${channelId}`);
        return options.router;
      },
      createStream: (streamOptions: Record<string, unknown>) => {
        const stream: TFakeStream = { options: streamOptions, updates: [], removed: false };
        streams.push(stream);
        return {
          streamId: streams.length,
          update: (update: Record<string, unknown>) => {
            // like Sharkord: swapping producers closes the old ones
            const producers = update.producers as { audio?: { close(): void }; video?: { close(): void } } | undefined;
            const current = (stream.updates.findLast((u) => u.producers)?.producers ?? stream.options.producers) as typeof producers;
            if (producers?.audio) current?.audio?.close();
            if (producers?.video) current?.video?.close();
            stream.updates.push(update);
          },
          remove: () => {
            stream.removed = true;
          },
        };
      },
    },
    ui: { enable: (requirements: unknown) => (ui = requirements), disable: () => (ui = undefined) },
  };

  const invoker = (userId: number, currentVoiceChannelId?: number) => ({ userId, source: "api", currentVoiceChannelId, locale: "en" });

  return {
    ctx,
    actions,
    commands,
    routes,
    events,
    pushes,
    streams,
    logs,
    settings,
    ui: () => ui,
    invoker,
    failPermissions: (error: Error | null) => (permissionError = error),
    action: (name: string, userId: number, channelId: number | undefined, payload?: unknown) =>
      (actions.get(name)!.executes as (...args: unknown[]) => Promise<unknown>)(invoker(userId, channelId), payload),
    command: (name: string, userId: number, channelId: number | undefined, args?: unknown) =>
      (commands.get(name)!.executes as (...args: unknown[]) => Promise<unknown>)(invoker(userId, channelId), args),
  };
};

/** writes an executable shell script and returns its path */
export const script = (dir: string, name: string, body: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

/**
 * A yt-dlp that knows one video (or playlist), as a Bun script.
 *
 * - `-j` prints `info`, `-J` prints `info` with its `entries` (a playlist).
 *   `info.byQuery` changes it for queries containing a word: `{ word: { id, title } }`.
 * - `-f <id> -o <file>` downloads one format: `$JV_FIXTURE_VIDEO` for a video
 *   format, `$JV_FIXTURE_AUDIO` for an audio one, or a placeholder. With
 *   `$JV_RATE` (bytes per second) the file grows at that rate, like a real
 *   download.
 * - an `-o` with a template merges: `$JV_FIXTURE` (or a placeholder) into
 *   `video.mkv`, and prints its path.
 */
export const fakeYtDlp = (dir: string, info: { formats?: Record<string, unknown>[] } & Record<string, unknown>): string => {
  const program = path.join(dir, "fake-yt-dlp.ts");
  writeFileSync(
    program,
    `
import { closeSync, copyFileSync, openSync, writeFileSync, writeSync } from "fs";
import path from "path";
const info = ${JSON.stringify(info)};
const args = process.argv.slice(2);
const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
if (args.includes("-j") || args.includes("-J")) {
  const query = args.at(-1);
  const match = Object.entries(info.byQuery ?? {}).find(([word]) => query.includes(word));
  console.log(JSON.stringify(match ? { ...info, ...match[1] } : info));
  process.exit(0);
}
const out = value("-o");
const format = info.formats?.find((f) => f.format_id === value("-f")?.split("/")[0]);
if (!out.includes("%(")) {
  const source = format?.vcodec && format.vcodec !== "none" ? process.env.JV_FIXTURE_VIDEO : process.env.JV_FIXTURE_AUDIO;
  const bytes = source ? await Bun.file(source).bytes() : new TextEncoder().encode("placeholder");
  const rate = Number(process.env.JV_RATE ?? 0);
  const fd = openSync(out, "w");
  const step = rate ? Math.max(1, Math.floor(rate / 10)) : bytes.length;
  for (let at = 0; at < bytes.length; at += step) {
    writeSync(fd, bytes.subarray(at, Math.min(bytes.length, at + step)));
    console.log("[jv] " + Math.min(bytes.length, at + step) + " " + bytes.length + " NA");
    if (rate) await Bun.sleep(100);
  }
  closeSync(fd);
  process.exit(0);
}
const file = path.join(path.dirname(out), "video.mkv");
if (process.env.JV_FIXTURE) copyFileSync(process.env.JV_FIXTURE, file);
else writeFileSync(file, "placeholder");
console.log("[jv] 50 100 NA");
console.log("[jv] 100 100 NA");
console.log(file);
`,
  );
  return script(dir, "yt-dlp", `exec "${process.execPath}" "${program}" "$@"`);
};
