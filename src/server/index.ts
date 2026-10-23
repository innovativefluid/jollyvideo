/** Jollyvideo's server half: actions for the panel, a few chat commands, the players. */
import type { PluginContext, TInvokerContext } from "@sharkord/plugin-sdk";
import type { Permission } from "@sharkord/shared";
import { mkdir, rm, statfs } from "fs/promises";
import path from "path";
import { MAX_QUERY_LENGTH, type TControl, type TJollyvideo, type TPlayer, type TViewer } from "../contract";
import { startEncoder } from "./encoder";
import { encodeForPanel, errorText, UserError, userMessage } from "./errors";
import { createOutput } from "./output";
import { ChannelPlayer, currentRevision, type TDisk } from "./player";
import { closeWhenEmpty, fitted, Players } from "./players";
import { readSettings, SETTINGS } from "./settings";
import { Thumbnails } from "./thumbnails";
import { Toolbox } from "./tools";
import { createYouTube } from "./youtube";

const IN_VOICE = "JOIN_VOICE_CHANNELS" as Permission;
/** moderators lock the player, and still control it while it is locked */
const MODERATOR = "MOVE_MEMBERS" as Permission;
const ADMIN = "MANAGE_PLUGINS" as Permission;

const DAY_MS = 86_400_000;
/** a channel left empty this long stops playing, so it gives its slot back */
const EMPTY_CHANNEL_MS = 60_000;
/** after a failed install, adding a video does not try again for this long */
const INSTALL_RETRY_MS = 5 * 60_000;

let unload: (() => Promise<void>) | null = null;

export const parseControl = (payload: unknown): TControl => {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (p.op) {
    case "pause":
    case "resume":
    case "skip":
    case "stop":
    case "clear":
      return { op: p.op };
    case "seek":
      if (typeof p.position === "number" && Number.isFinite(p.position)) return { op: "seek", position: p.position };
      break;
    case "remove":
      if (typeof p.id === "string" && p.id.length <= 64) return { op: "remove", id: p.id };
      break;
    case "move":
      if (typeof p.id === "string" && p.id.length <= 64 && typeof p.to === "number" && Number.isInteger(p.to)) return { op: "move", id: p.id, to: p.to };
      break;
    case "lock":
      if (typeof p.locked === "boolean") return { op: "lock", locked: p.locked };
      break;
  }
  throw new UserError("error.unknownControl");
};

const idle = (channelId: number): TPlayer => ({ channelId, rev: currentRevision(), now: null, queue: [], locked: false, error: null });

export const onLoad = async (ctx: PluginContext<TJollyvideo>): Promise<void> => {
  await unload?.();
  const log = ctx.logger;

  const settingsStore = await ctx.settings.register(SETTINGS);
  const settings = () => readSettings(settingsStore);

  const toolbox = new Toolbox(ctx.dataPath, log);
  const jsRuntime = toolbox.jsRuntime();
  const cacheDir = path.join(ctx.dataPath, "cache");
  // downloads only live as long as their video; anything here is left over
  await rm(cacheDir, { recursive: true, force: true });
  const scratch = path.join(cacheDir, "tmp");
  await mkdir(scratch, { recursive: true });
  await rm(path.join(toolbox.binDir, "download-info.json"), { force: true });

  let installFailedAt = 0;
  const install = (refreshYtDlp = false) =>
    toolbox.ensure({ refreshYtDlp }).catch((error) => {
      installFailedAt = Date.now();
      log.error("[tools]", errorText(error));
      throw error;
    });
  const refreshWeekly = async () => {
    try {
      const age = await toolbox.ytDlpAge();
      if (settings().updateYtDlp && age !== undefined && age > 7) await install(true);
    } catch {
      // logged by install; tried again later
    }
  };
  void install()
    .catch(() => {})
    .then(refreshWeekly);
  const updater = setInterval(() => void refreshWeekly(), DAY_MS / 2);

  const ready = async () => {
    if (toolbox.ytDlp() && toolbox.ffmpeg()) return;
    // a failed install downloads a lot; it is not tried again on every add
    if (!toolbox.installing && Date.now() - installFailedAt < INSTALL_RETRY_MS) throw new UserError("error.tools");
    try {
      await install();
    } catch {
      throw new UserError("error.tools");
    }
  };

  const youtube = createYouTube(
    () => ({ path: toolbox.ytDlp() ?? "yt-dlp", ffmpeg: toolbox.ffmpeg(), cookies: toolbox.cookies(), scratch, jsRuntime }),
    log,
  );
  const thumbnails = new Thumbnails(`/plugins/${ctx.pluginId}`, log);
  ctx.http.get("/thumb/*", thumbnails.handle);

  // one disk for every channel's downloads
  const disk: TDisk = {
    free: async (dir) => {
      try {
        const stats = await statfs(dir);
        return stats.bavail * stats.bsize;
      } catch {
        return null;
      }
    },
    reserved: 0,
  };
  const players: Players = new Players(
    (channelId) =>
      new ChannelPlayer(channelId, {
        settings,
        youtube,
        ready,
        ffmpeg: toolbox.ffmpeg,
        cacheDir,
        disk,
        createOutput: (id) => createOutput(ctx.voice, id, `${ctx.pluginId}:${id}`),
        encode: startEncoder,
        thumbnail: (videoId) => thumbnails.url(channelId, videoId),
        channelPrivate: async () => (await ctx.channels.get(channelId))?.private ?? true,
        slotFree: () => players.busyCount() < settings().maxStreams,
        slotFreed: () => players.slotFreed(),
        changed: (player) => players.changed(player),
        log,
        now: Date.now,
      }),
    (player) => {
      try {
        ctx.push.toVoiceChannel(player.channelId, fitted(player.snapshot()));
      } catch (error) {
        log.error("[push]", errorText(error));
      }
    },
  );
  const closePlayer = (channelId: number) => {
    players.close(channelId).catch((error) => log.error("[players]", errorText(error)));
  };

  const empty = closeWhenEmpty({
    isEmpty: (channelId) => {
      try {
        return ctx.voice.getState(channelId).users.length === 0;
      } catch {
        return true;
      }
    },
    hasPlayer: (channelId) => !!players.get(channelId),
    close: (channelId) => closePlayer(channelId),
    delayMs: EMPTY_CHANNEL_MS,
  });
  ctx.events.on("user:left_voice", ({ channelId }) => empty.left(channelId));
  ctx.events.on("user:joined_voice", ({ channelId }) => empty.joined(channelId));
  ctx.events.on("voice:runtime_closed", ({ channelId }) => closePlayer(channelId));

  const canModerate = (userId: number) => ctx.permissions.userCan(userId, MODERATOR);

  /** the caller's voice channel, if they are really in it: Sharkord keeps it set after a moderator disconnects them */
  const voiceChannel = (invoker: TInvokerContext): number => {
    const channelId = invoker.currentVoiceChannelId;
    if (!channelId) throw new UserError("error.joinVoice");
    let present = false;
    try {
      present = ctx.voice.getState(channelId).users.some((user) => user.userId === invoker.userId);
    } catch {
      // no voice runtime: the channel is gone
    }
    if (!present) throw new UserError("error.joinVoice");
    return channelId;
  };

  /** the player of the caller's voice channel, if the lock lets them control it */
  const controllable = async (invoker: TInvokerContext): Promise<ChannelPlayer> => {
    const player = players.open(voiceChannel(invoker));
    if (player.isLocked && !(await canModerate(invoker.userId))) throw new UserError("error.locked");
    return player;
  };

  const viewer = async (invoker: TInvokerContext, player: ChannelPlayer): Promise<TViewer> => ({
    player: player.snapshot(),
    canModerate: await canModerate(invoker.userId),
  });

  /**
   * What users read is ours; anything unexpected is logged and stays vague.
   * The panel gets keys to translate, chat commands get English.
   */
  const guarded =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>, kind: "action" | "command" = "action") =>
    async (...args: A): Promise<R> => {
      try {
        return await run(...args);
      } catch (error) {
        if (!(error instanceof UserError)) log.error(`[${name}]`, errorText(error));
        const message = userMessage(error);
        throw new Error(kind === "action" ? encodeForPanel(message) : error instanceof UserError ? error.message : "Something went wrong");
      }
    };

  const control = async (invoker: TInvokerContext, op: TControl): Promise<ChannelPlayer> => {
    if (op.op === "lock") {
      if (!(await canModerate(invoker.userId))) throw new UserError("error.lockModerators");
      const player = players.open(voiceChannel(invoker));
      player.setLocked(op.locked);
      return player;
    }
    const player = await controllable(invoker);
    switch (op.op) {
      case "pause":
        player.pause();
        break;
      case "resume":
        player.resume();
        break;
      case "seek":
        player.seek(op.position);
        break;
      case "skip":
        player.skip();
        break;
      case "stop":
        player.stop();
        break;
      case "clear":
        player.clear();
        break;
      case "remove":
        player.remove(op.id);
        break;
      case "move":
        player.move(op.id, op.to);
        break;
    }
    return player;
  };

  const add = async (invoker: TInvokerContext, query: unknown): Promise<ChannelPlayer> => {
    if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH * 2) throw new UserError("query.empty");
    const player = await controllable(invoker);
    player.add(query, invoker.userId);
    return player;
  };

  ctx.actions.register({
    name: "state",
    requires: IN_VOICE,
    executes: guarded("state", async (invoker) => {
      let channelId: number;
      try {
        channelId = voiceChannel(invoker);
      } catch {
        return null;
      }
      const player = players.get(channelId);
      return player ? viewer(invoker, player) : { player: idle(channelId), canModerate: await canModerate(invoker.userId) };
    }),
  });

  ctx.actions.register({
    name: "add",
    requires: IN_VOICE,
    executes: guarded("add", async (invoker, payload) => viewer(invoker, await add(invoker, payload?.query))),
  });

  ctx.actions.register({
    name: "control",
    requires: IN_VOICE,
    executes: guarded("control", async (invoker, payload) => viewer(invoker, await control(invoker, parseControl(payload)))),
  });

  ctx.commands.register({
    name: "watch",
    description: "Play a YouTube video, playlist or livestream in your voice channel",
    args: [{ name: "query", description: "YouTube link or search", type: "string", required: true }],
    requires: IN_VOICE,
    executes: guarded("watch", async (invoker, args) => {
      await add(invoker, args?.query);
      return "Added";
    }, "command"),
  });

  ctx.commands.register({
    name: "watch-skip",
    description: "Skip the video playing in your voice channel",
    requires: IN_VOICE,
    executes: guarded("watch-skip", async (invoker) => {
      await control(invoker, { op: "skip" });
      return "Skipped";
    }, "command"),
  });

  ctx.commands.register({
    name: "watch-stop",
    description: "Stop the video and clear the queue",
    requires: IN_VOICE,
    executes: guarded("watch-stop", async (invoker) => {
      await control(invoker, { op: "stop" });
      return "Stopped";
    }, "command"),
  });

  ctx.commands.register({
    name: "watch-lock",
    description: "Lock or unlock the player: while locked, only moderators control it",
    requires: MODERATOR,
    executes: guarded("watch-lock", async (invoker) => {
      const locked = !players.open(voiceChannel(invoker)).isLocked;
      await control(invoker, { op: "lock", locked });
      return locked ? "Locked" : "Unlocked";
    }, "command"),
  });

  ctx.commands.register({
    name: "watch-update",
    description: "Update yt-dlp now",
    requires: ADMIN,
    ephemeral: true,
    executes: guarded("watch-update", async (invoker) => {
      // also when an admin opened the command to more people
      if (!(await ctx.permissions.userCan(invoker.userId, ADMIN))) throw new UserError("error.adminsOnly");
      // commands time out after 30 seconds; a slow download carries on regardless
      const update = install(true).then(
        () => "yt-dlp is up to date",
        () => "The update failed, see the plugin log",
      );
      return Promise.race([update, Bun.sleep(25_000).then(() => "Updating yt-dlp, this takes a moment")]);
    }, "command"),
  });

  ctx.ui.enable({ voice_controls: IN_VOICE });

  unload = async () => {
    unload = null;
    clearInterval(updater);
    empty.stop();
    // ffmpeg has to let go of the downloads before the next load clears them
    await Promise.race([players.closeAll(), Bun.sleep(5_000)]);
  };
  log.log("[jollyvideo] loaded");
};

export const onUnload = async (): Promise<void> => {
  await unload?.();
};
