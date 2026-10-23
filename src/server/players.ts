/** One player per voice channel, and getting their state to the people in it. */
import type { TPlayer } from "../contract";
import type { ChannelPlayer } from "./player";

/**
 * Closes a channel's player once the channel has been empty for `delayMs`.
 * Sharkord keeps a voice runtime until its channel is deleted, so without
 * this an empty channel would play to nobody and keep its slot.
 */
export const closeWhenEmpty = (options: {
  isEmpty(channelId: number): boolean;
  hasPlayer(channelId: number): boolean;
  close(channelId: number): void;
  delayMs: number;
}) => {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    left(channelId: number) {
      if (!options.hasPlayer(channelId) || timers.has(channelId) || !options.isEmpty(channelId)) return;
      timers.set(
        channelId,
        setTimeout(() => {
          timers.delete(channelId);
          if (options.isEmpty(channelId)) options.close(channelId);
        }, options.delayMs),
      );
    },
    joined(channelId: number) {
      clearTimeout(timers.get(channelId));
      timers.delete(channelId);
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};
const PUSH_DELAY_MS = 100;
/** clients count the position up themselves; this corrects their drift */
const RESYNC_MS = 30_000;
/** Sharkord drops a push over 64 KB */
const PUSH_MAX_BYTES = 60 * 1024;

/** the state as it fits into one push: a long queue of long titles loses its end */
export const fitted = (state: TPlayer): TPlayer => {
  let fitting = state;
  while (fitting.queue.length && Buffer.byteLength(JSON.stringify(fitting)) > PUSH_MAX_BYTES) {
    fitting = { ...fitting, queue: fitting.queue.slice(0, Math.floor(fitting.queue.length * 0.8)) };
  }
  return fitting;
};

export class Players {
  private readonly players = new Map<number, ChannelPlayer>();
  private readonly pushes = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly resync: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(
    private readonly create: (channelId: number) => ChannelPlayer,
    private readonly push: (player: ChannelPlayer) => void,
  ) {
    this.resync = setInterval(() => {
      for (const player of this.players.values()) if (player.playing) this.push(player);
    }, RESYNC_MS);
  }

  get(channelId: number): ChannelPlayer | undefined {
    return this.players.get(channelId);
  }

  open(channelId: number): ChannelPlayer {
    let player = this.players.get(channelId);
    if (!player) {
      player = this.create(channelId);
      this.players.set(channelId, player);
    }
    return player;
  }

  /** videos playing, paused or loading across the server */
  busyCount(): number {
    let count = 0;
    for (const player of this.players.values()) if (player.busy) count++;
    return count;
  }

  /** a burst of changes goes out as one push */
  changed(player: ChannelPlayer): void {
    if (this.players.get(player.channelId) !== player || this.pushes.has(player.channelId)) return;
    this.pushes.set(
      player.channelId,
      setTimeout(() => {
        this.pushes.delete(player.channelId);
        if (this.players.get(player.channelId) === player) this.push(player);
      }, PUSH_DELAY_MS),
    );
  }

  /** players whose queue waits for a slot try again */
  slotFreed(): void {
    if (this.closing) return;
    for (const player of this.players.values()) player.retry();
  }

  /** resolves once the channel's ffmpeg has exited */
  close(channelId: number): Promise<void> {
    const player = this.players.get(channelId);
    this.players.delete(channelId);
    clearTimeout(this.pushes.get(channelId));
    this.pushes.delete(channelId);
    if (!player) return Promise.resolve();
    const stopped = player.destroy();
    this.slotFreed();
    return stopped;
  }

  closeAll(): Promise<void> {
    this.closing = true;
    clearInterval(this.resync);
    return Promise.all([...this.players.keys()].map((channelId) => this.close(channelId))).then(() => {});
  }
}
