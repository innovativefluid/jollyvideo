/**
 * The player of one voice channel: a queue, the video playing, and the lock.
 *
 * Everything outside (yt-dlp, ffmpeg, mediasoup, the clock) comes in through
 * `TPlayerDeps`, so the state machine can be tested on its own.
 */
import { mkdir, rm } from "fs/promises";
import path from "path";
import { MAX_QUEUE, type TPlayer, type TQueueEntry } from "../contract";
import type { TEncodeOptions, TEncoder, TEncoderEvents, TExit } from "./encoder";
import { h264Level } from "./encoder";
import { errorText, UserError, userText } from "./errors";
import type { TConnection, TOutput } from "./output";
import type { TSettings } from "./settings";
import { parseQuery, type TResolved, type TSource, type TYouTube } from "./youtube";

export type TPlayerDeps = {
  settings(): TSettings;
  youtube: TYouTube;
  /** resolves once yt-dlp and ffmpeg are there */
  ready(): Promise<void>;
  ffmpeg(): string | undefined;
  cacheDir: string;
  createOutput(channelId: number): TOutput;
  encode(options: TEncodeOptions, events: TEncoderEvents): TEncoder;
  thumbnail(videoId: string): string;
  /** whether one more video may start playing on the server */
  slotFree(): boolean;
  /** this player stopped holding a slot, so a waiting one may start */
  slotFreed(): void;
  changed(player: ChannelPlayer): void;
  log: { log(...args: unknown[]): void; error(...args: unknown[]): void };
  now(): number;
};

type TItem = {
  id: string;
  source: TSource;
  addedBy: number;
  video: TResolved | null;
  progress: number | null;
  resolving: Promise<TResolved> | null;
  fetching: Promise<string | null> | null;
  file: string | null;
  abort: AbortController;
};

type TRun = { encoder: TEncoder; connection: TConnection; onAir: boolean };

type TCurrent = {
  item: TItem;
  state: "loading" | "playing" | "paused";
  /** seconds into the video where the current run started, or where it is paused */
  base: number;
  run: TRun | null;
  /** bumped by every start and stop, so a start that finishes late knows it is stale */
  attempt: number;
  /** when livestream restarts happened, for the restart limit */
  restarts: number[];
  retried: boolean;
};

const LIVE_RESTARTS = 3;
const LIVE_RESTART_WINDOW_MS = 10 * 60_000;
const ERROR_SHOWN_MS = 15_000;

const minutes = (seconds: number) => Math.round(seconds / 60);

/** one count across every player, so a new player never goes back in time */
let revisions = 0;
export const currentRevision = (): number => revisions;

export class ChannelPlayer {
  private queue: TItem[] = [];
  private current: TCurrent | null = null;
  private output: TOutput | null = null;
  private locked = false;
  private error: string | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private rev = ++revisions;

  constructor(
    readonly channelId: number,
    private readonly deps: TPlayerDeps,
  ) {}

  get isLocked(): boolean {
    return this.locked;
  }

  /** a video is playing, paused or loading, which takes one of the server's slots */
  get busy(): boolean {
    return this.current !== null;
  }

  get idle(): boolean {
    return !this.current && this.queue.length === 0;
  }

  // -- what people can do --------------------------------------------------

  add(query: string, userId: number): void {
    this.assertAlive();
    const source = parseQuery(query);
    if (this.queue.length >= MAX_QUEUE) throw new UserError("The queue is full");
    if (!this.current && !this.deps.slotFree()) throw new UserError("Too many videos are playing on this server");
    const item: TItem = {
      id: crypto.randomUUID(),
      source,
      addedBy: userId,
      video: null,
      progress: null,
      resolving: null,
      fetching: null,
      file: null,
      abort: new AbortController(),
    };
    this.queue.push(item);
    this.setError(null);
    this.resolve(item).catch((error) => this.dropQueued(item, error));
    if (!this.current) void this.advance();
    else this.prefetch();
    this.changed();
  }

  pause(): void {
    const current = this.requireCurrent();
    if (current.item.video?.live) throw new UserError("Livestreams can't be paused");
    if (current.state === "paused") return;
    if (current.state !== "playing") throw new UserError("Still loading");
    current.base = this.position(current);
    current.state = "paused";
    this.stopRun(current);
    this.changed();
  }

  resume(): void {
    const current = this.requireCurrent();
    if (current.state !== "paused") return;
    current.state = "loading";
    this.changed();
    // still downloading: it starts once the file is in
    if (this.canStart(current)) this.startRun(current, current.base);
  }

  seek(position: number): void {
    const current = this.requireCurrent();
    const video = current.item.video;
    if (!video) throw new UserError("Still loading");
    if (video.live) throw new UserError("Livestreams can't be seeked");
    const end = video.duration > 0 ? video.duration - 1 : Number.MAX_SAFE_INTEGER;
    const target = Math.max(0, Math.min(end, Math.floor(position)));
    current.base = target;
    // paused, or still downloading: it starts there later
    if (current.state === "paused" || !this.canStart(current)) {
      this.changed();
      return;
    }
    current.state = "loading";
    this.stopRun(current);
    this.changed();
    this.startRun(current, target);
  }

  skip(): void {
    if (this.current) this.finish(this.current, null);
  }

  stop(): void {
    this.clear();
    if (this.current) this.finish(this.current, null);
    else this.takeDown();
  }

  clear(): void {
    for (const item of this.queue.splice(0)) this.discard(item);
    this.changed();
  }

  remove(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index === -1) return;
    const [item] = this.queue.splice(index, 1);
    this.discard(item!);
    this.prefetch();
    this.changed();
  }

  /** starts the queue again after it waited for a free slot */
  retry(): void {
    if (!this.current && this.queue.length && !this.destroyed) void this.advance();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.changed();
  }

  /** stops everything and takes the stream down; the player is unusable afterwards. Resolves once ffmpeg is gone. */
  destroy(): Promise<void> {
    this.destroyed = true;
    for (const item of this.queue.splice(0)) this.discard(item);
    const current = this.current;
    this.current = null;
    const stopped = current ? this.stopRun(current) : Promise.resolve();
    if (current) this.discard(current.item, stopped);
    this.takeDown();
    clearTimeout(this.errorTimer);
    return stopped;
  }

  snapshot(): TPlayer {
    const current = this.current;
    const entry = (item: TItem) => ({
      id: item.id,
      title: item.video?.title ?? (item.source.kind === "search" ? item.source.text : "YouTube video"),
      duration: item.video?.duration ?? 0,
      live: item.video?.live ?? false,
      thumbnail: item.video ? this.deps.thumbnail(item.video.videoId) : "",
      addedBy: item.addedBy,
      progress: item.progress,
    });
    return {
      channelId: this.channelId,
      rev: this.rev,
      now: current ? { ...entry(current.item), state: current.state, position: Math.floor(this.position(current)) } : null,
      queue: this.queue.map((item): TQueueEntry => ({ ...entry(item), state: item.video ? "ready" : "resolving" })),
      locked: this.locked,
      error: this.error,
    };
  }

  // -- inside ---------------------------------------------------------------

  private assertAlive() {
    if (this.destroyed) throw new UserError("This voice channel has closed");
  }

  private requireCurrent(): TCurrent {
    if (!this.current) throw new UserError("Nothing is playing");
    return this.current;
  }

  private changed() {
    this.rev = ++revisions;
    if (!this.destroyed) this.deps.changed(this);
  }

  private setError(error: string | null) {
    clearTimeout(this.errorTimer);
    this.error = error;
    if (error) {
      this.errorTimer = setTimeout(() => {
        this.error = null;
        this.changed();
      }, ERROR_SHOWN_MS);
    }
  }

  private report(error: unknown) {
    if (!(error instanceof UserError)) this.deps.log.error(`[player ${this.channelId}]`, errorText(error));
    if (!this.destroyed) this.setError(userText(error));
  }

  private position(current: TCurrent): number {
    if (current.state !== "playing" || !current.run) return current.base;
    return current.base + current.run.encoder.elapsed();
  }

  /** looks the video up once, and checks it against the length limit */
  private resolve(item: TItem): Promise<TResolved> {
    item.resolving ??= (async () => {
      await this.deps.ready();
      const settings = this.deps.settings();
      const video = await this.deps.youtube.resolve(item.source, settings.quality, item.abort.signal);
      if (!video.live && settings.maxSeconds > 0 && video.duration > settings.maxSeconds) {
        throw new UserError(`Videos can be up to ${minutes(settings.maxSeconds)} minutes long`);
      }
      item.video = video;
      this.changed();
      return video;
    })();
    return item.resolving;
  }

  /** downloads the video once; livestreams are read live instead */
  private fetch(item: TItem): Promise<string | null> {
    item.fetching ??= (async () => {
      const video = await this.resolve(item);
      if (video.live) return null;
      const dir = path.join(this.deps.cacheDir, item.id);
      await mkdir(dir, { recursive: true });
      let lastShown = 0;
      const file = await this.deps.youtube.download(
        video,
        dir,
        (fraction) => {
          item.progress = fraction;
          // a progress bar does not need every percent
          if (fraction - lastShown >= 0.05) {
            lastShown = fraction;
            this.changed();
          }
        },
        item.abort.signal,
      );
      item.file = file;
      item.progress = null;
      this.changed();
      return file;
    })();
    return item.fetching;
  }

  /** the next video downloads while this one plays */
  private prefetch() {
    const next = this.queue[0];
    if (!this.current || !next || next.fetching) return;
    this.fetch(next).catch((error) => this.dropQueued(next, error));
  }

  private dropQueued(item: TItem, error: unknown) {
    const index = this.queue.indexOf(item);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.discard(item);
    this.report(error);
    this.prefetch();
    this.changed();
  }

  /** aborts what the item is doing and deletes its download, once `after` (ffmpeg reading it) is done */
  private discard(item: TItem, after?: Promise<unknown>) {
    item.abort.abort();
    const settled = Promise.allSettled([item.resolving, item.fetching, after]);
    void settled.then(() => rm(path.join(this.deps.cacheDir, item.id), { recursive: true, force: true })).catch(() => {});
  }

  private async advance(): Promise<void> {
    if (this.current || this.destroyed) return;
    const item = this.queue.shift();
    if (!item) {
      this.takeDown();
      this.changed();
      this.deps.slotFreed();
      return;
    }
    if (!this.deps.slotFree()) {
      this.queue.unshift(item);
      this.report(new UserError("Too many videos are playing on this server"));
      this.changed();
      return;
    }
    const current: TCurrent = { item, state: "loading", base: 0, run: null, attempt: 0, restarts: [], retried: false };
    this.current = current;
    this.changed();
    try {
      const video = await this.resolve(item);
      current.base = video.start;
      this.output?.relabel(this.label(video));
      await this.fetch(item);
      if (this.current !== current) return;
      this.prefetch();
      if (current.state === "loading") this.startRun(current, current.base);
    } catch (error) {
      if (this.current === current) this.finish(current, error);
    }
  }

  private label(video: TResolved) {
    return { title: video.title, bannerUrl: this.deps.thumbnail(video.videoId) };
  }

  /** whether what it plays is there: the download, or a livestream's playlist */
  private canStart(current: TCurrent): boolean {
    const video = current.item.video;
    return !!video && (video.live ? !!video.hls : !!current.item.file);
  }

  /** a new ffmpeg with its own transports, from `position` */
  private startRun(current: TCurrent, position: number) {
    const attempt = ++current.attempt;
    current.base = position;
    void (async () => {
      const video = current.item.video!;
      const ffmpeg = this.deps.ffmpeg();
      if (!ffmpeg) throw new UserError("ffmpeg isn't installed yet");
      const quality = this.deps.settings().quality;
      this.output ??= this.deps.createOutput(this.channelId);
      const output = this.output;
      const connection = await output.connect(h264Level(quality).profileLevelId);
      if (this.current !== current || current.attempt !== attempt || current.state !== "loading") {
        connection.close();
        return;
      }
      let encoder: TEncoder;
      try {
        encoder = this.deps.encode(
          {
            ffmpeg,
            input: video.live ? video.hls!.url : current.item.file!,
            live: video.live,
            start: position,
            quality,
            headers: video.hls?.headers,
            video: connection.video,
            audio: connection.audio,
          },
          {
            // ffmpeg reports progress only after this function has returned and `run` is set
            started: () => {
              const run = current.run;
              if (run?.connection !== connection || this.current !== current) return;
              try {
                output.publish(connection, this.label(video));
              } catch (error) {
                this.finish(current, error);
                return;
              }
              run.onAir = true;
              current.state = "playing";
              this.changed();
            },
          },
        );
      } catch (error) {
        // ffmpeg could not even start: the transports were for nothing
        connection.close();
        throw error;
      }
      const run: TRun = { connection, onAir: false, encoder };
      current.run = run;
      void encoder.exited.then((exit) => this.ended(current, run, exit));
    })().catch((error) => {
      if (this.current === current && current.attempt === attempt) this.finish(current, error);
    });
  }

  /** stops the current ffmpeg on purpose, and any start still on its way; the exit is then ignored */
  private stopRun(current: TCurrent): Promise<void> {
    current.attempt++;
    const run = current.run;
    current.run = null;
    return run ? run.encoder.stop() : Promise.resolve();
  }

  /** ffmpeg exited by itself: the end of the video, or something broke */
  private ended(current: TCurrent, run: TRun, exit: TExit) {
    // a run that never went on air leaves its transports behind
    if (!run.onAir) run.connection.close();
    if (current.run !== run || this.current !== current) return;
    current.run = null;
    const video = current.item.video!;
    if (exit.code !== 0) this.deps.log.error(`[ffmpeg ${this.channelId}] exit ${exit.code}: ${exit.error.slice(-300)}`);

    if (video.live) {
      const now = this.deps.now();
      current.restarts = current.restarts.filter((at) => now - at < LIVE_RESTART_WINDOW_MS);
      if (current.restarts.length >= LIVE_RESTARTS) {
        this.finish(current, new UserError("The livestream keeps dropping out"));
        return;
      }
      current.restarts.push(now);
      current.state = "loading";
      this.changed();
      void this.restartLive(current);
      return;
    }

    const position = current.base + run.encoder.elapsed();
    const atEnd = video.duration === 0 || position >= video.duration - 5;
    if (exit.code === 0 || atEnd) {
      this.finish(current, null);
    } else if (!current.retried) {
      current.retried = true;
      current.state = "loading";
      this.changed();
      this.startRun(current, Math.floor(position));
    } else {
      this.finish(current, new UserError("Playback failed"));
    }
  }

  /** livestream playlists expire, so a restart looks the stream up again */
  private async restartLive(current: TCurrent) {
    try {
      const fresh = await this.deps.youtube.resolve(current.item.source, this.deps.settings().quality, current.item.abort.signal);
      if (this.current !== current) return;
      if (!fresh.live) {
        this.finish(current, null);
        return;
      }
      current.item.video = fresh;
      this.startRun(current, 0);
    } catch (error) {
      if (this.current === current) this.finish(current, error);
    }
  }

  /** the current video is done, by its end, a skip, or an error; the next one starts */
  private finish(current: TCurrent, error: unknown) {
    if (this.current !== current) return;
    this.current = null;
    this.discard(current.item, this.stopRun(current));
    if (error) this.report(error);
    void this.advance();
    this.changed();
  }

  private takeDown() {
    const output = this.output;
    this.output = null;
    try {
      output?.remove();
    } catch (error) {
      this.deps.log.error(`[player ${this.channelId}] removing the stream:`, errorText(error));
    }
  }
}
