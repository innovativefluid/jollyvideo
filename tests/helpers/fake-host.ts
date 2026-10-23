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
 * A yt-dlp that knows one video. `-j` prints its info; a download copies
 * `$JV_FIXTURE` (or writes a placeholder) and prints the file's path.
 */
export const fakeYtDlp = (dir: string, info: object): string =>
  script(
    dir,
    "yt-dlp",
    `
out=""; mode=download
while [ $# -gt 0 ]; do
  case "$1" in
    -j) mode=json ;;
    -o) out="$2"; shift ;;
  esac
  shift
done
if [ "$mode" = json ]; then
  cat <<'JSON'
${JSON.stringify(info)}
JSON
  exit 0
fi
file="$(dirname "$out")/video.mkv"
if [ -n "$JV_FIXTURE" ]; then cp "$JV_FIXTURE" "$file"; else echo placeholder > "$file"; fi
echo "[jv] 50 100 NA"
echo "[jv] 100 100 NA"
echo "$file"
`,
  );
