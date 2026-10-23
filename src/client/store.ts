/**
 * The player of the voice channel the user is in, kept current from the
 * server's pushes. One store for the page, started by the first component.
 */
import type {} from "@sharkord/plugin-sdk/client";
import { PLUGIN_ID, type TControl, type TJollyvideo, type TPlayer, type TViewer } from "../contract";

type TActions = TJollyvideo["actions"];

export type TView = {
  channelId: number | undefined;
  player: TPlayer | null;
  canModerate: boolean;
  /** `performance.now()` when `player` arrived, for counting the position up */
  receivedAt: number;
  /** an action is on its way */
  busy: boolean;
  /** why the user's last action failed */
  failure: string | null;
};

const FAILURE_SHOWN_MS = 6_000;

let view: TView = { channelId: undefined, player: null, canModerate: false, receivedAt: 0, busy: false, failure: null };
const listeners = new Set<() => void>();
let started = false;
let failureTimer: ReturnType<typeof setTimeout> | undefined;
/** answers to older requests must not overwrite newer state */
let generation = 0;

const host = () => window.__SHARKORD_STORE__;

const set = (next: Partial<TView>) => {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
};

const takePlayer = (player: TPlayer) => {
  if (player.channelId === view.channelId) set({ player, receivedAt: performance.now() });
};

const takeViewer = (viewer: TViewer | null) => {
  if (viewer && viewer.player.channelId === view.channelId) {
    set({ player: viewer.player, canModerate: viewer.canModerate, receivedAt: performance.now() });
  }
};

const call = <K extends keyof TActions>(name: K, payload?: TActions[K]["payload"]): Promise<TActions[K]["response"]> =>
  host().actions.executePluginAction<TActions[K]["response"]>(PLUGIN_ID, name, payload);

const fail = (error: unknown) => {
  clearTimeout(failureTimer);
  const message = error instanceof Error && error.message ? error.message : "Something went wrong";
  set({ failure: message });
  failureTimer = setTimeout(() => set({ failure: null }), FAILURE_SHOWN_MS);
};

export const refresh = async (): Promise<void> => {
  const asked = ++generation;
  try {
    const viewer = await call("state");
    if (asked === generation) takeViewer(viewer);
  } catch {
    // the next push or channel change tries again
  }
};

const follow = () => {
  const channelId = host().getState().currentVoiceChannelId;
  if (channelId === view.channelId) return;
  generation++;
  set({ channelId, player: null, canModerate: false, failure: null });
  if (channelId !== undefined) void refresh();
};

/** starts listening once; components call it on mount */
export const start = (): void => {
  if (started) return;
  started = true;
  host().actions.onPush(PLUGIN_ID, (data) => takePlayer(data as TPlayer));
  host().subscribe(follow);
  follow();
};

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getView = (): TView => view;

const run = async (send: () => Promise<TViewer>): Promise<boolean> => {
  set({ busy: true });
  try {
    takeViewer(await send());
    clearTimeout(failureTimer);
    set({ failure: null });
    return true;
  } catch (error) {
    fail(error);
    return false;
  } finally {
    set({ busy: false });
  }
};

export const add = (query: string): Promise<boolean> => run(() => call("add", { query }));
export const control = (op: TControl): Promise<boolean> => run(() => call("control", op));

/** where the video is now: the last known position, counted up while it plays */
export const positionOf = (current: TView, now = performance.now()): number => {
  const playing = current.player?.now;
  if (!playing) return 0;
  if (playing.state !== "playing") return playing.position;
  const position = playing.position + (now - current.receivedAt) / 1000;
  return playing.duration > 0 ? Math.min(position, playing.duration) : position;
};

/** for tests */
export const reset = (): void => {
  started = false;
  generation = 0;
  clearTimeout(failureTimer);
  listeners.clear();
  view = { channelId: undefined, player: null, canModerate: false, receivedAt: 0, busy: false, failure: null };
};
