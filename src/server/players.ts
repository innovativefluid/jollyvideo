/** One player per voice channel, and getting their state to the people in it. */
import type { ChannelPlayer } from "./player";

const PUSH_DELAY_MS = 100;
/** clients count the position up themselves; this corrects their drift */
const RESYNC_MS = 10_000;

export class Players {
  private readonly players = new Map<number, ChannelPlayer>();
  private readonly pushes = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly resync: ReturnType<typeof setInterval>;

  constructor(
    private readonly create: (channelId: number) => ChannelPlayer,
    private readonly push: (player: ChannelPlayer) => void,
  ) {
    this.resync = setInterval(() => {
      for (const player of this.players.values()) if (player.busy) this.push(player);
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

  close(channelId: number): void {
    const player = this.players.get(channelId);
    this.players.delete(channelId);
    clearTimeout(this.pushes.get(channelId));
    this.pushes.delete(channelId);
    player?.destroy();
  }

  closeAll(): void {
    clearInterval(this.resync);
    for (const channelId of [...this.players.keys()]) this.close(channelId);
  }
}
