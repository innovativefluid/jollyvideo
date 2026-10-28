/**
 * The player of one voice channel: a queue, the video playing, and the lock.
 *
 * Everything outside (yt-dlp, ffmpeg, mediasoup, the disk, the clock) comes in
 * through `TPlayerDeps`, so the state machine can be tested on its own.
 */
import { mkdir, rm } from "fs/promises";
import path from "path";
import { CAPTION_WINDOW, MAX_QUEUE, type TCaptions, type TCue, type TPlayer, type TQueueEntry } from "../contract";
import type { TMessage } from "../i18n";
import type { TEncodeOptions, TEncoder, TEncoderEvents, TExit } from "./encoder";
import { h264Level } from "./encoder";
import { errorText, UserError, userMessage } from "./errors";
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
  /** the disk downloads go to, shared by every player */
  disk: TDisk;
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
  /** how long a video has to be next before it downloads ahead; PREFETCH_DELAY_MS by default */
  prefetchDelayMs?: number;
};

/** one file being downloaded */
type TDownload = { file: string | null; bytes: number; total: number | null; done: boolean };

type TItem = {
  id: string;
  source: TSource;
  addedBy: number;
  /** what a playlist said about the video, until it is looked up */
  hint: { title: string; duration: number } | null;
  video: TResolved | null;
  /** when `video` was looked up: its download links expire */
  lookedUpAt: number;
  /** its lookup is wanted now, so it goes ahead of other lookups even if it was asked for earlier */
  urgent: boolean;
  /** caption tracks read so far, by track id */
  captions: Map<string, Promise<TCue[]>>;
  resolving: Promise<TResolved> | null;
  fetching: TFetch | null;
  /** separate video and audio, readable while they grow; or one merged file, readable when done */
  downloads: { separate: boolean; files: TDownload[] } | null;
  abort: AbortController;
};

export type TDisk = {
  /** free bytes on the disk holding `dir`, or null when it cannot be told */
  free(dir: string): Promise<number | null>;
  /** bytes promised to downloads still running */
  reserved: number;
};

/** a download on its way: stopped on its own when its video is no longer next in line */
type TFetch = { abort: AbortController; dir: string; done: Promise<void> };

/** a playlist still being looked up, shown at the end of the queue */
type TPending = { id: string; addedBy: number; abort: AbortController };

type TRun = { encoder: TEncoder; connection: TConnection; onAir: boolean };

type TCurrent = {
  item: TItem;
  state: "loading" | "playing" | "paused";
  /** seconds into the video where the current run started, or where it is paused */
  base: number;
  run: TRun | null;
  /** bumped by every start and stop, so a start that finishes late knows it is stale */
  attempt: number;
  /** the attempt of a start still on its way */
  starting: number | null;
  /** when livestream restarts happened, for the restart limit */
  restarts: number[];
  retried: boolean;
};

const LIVE_RESTARTS = 3;
const LIVE_RESTART_WINDOW_MS = 10 * 60_000;
const ERROR_SHOWN_MS = 15_000;
const RETRY_AFTER_SECONDS = 60;
/** playback starts once this much past the position is downloaded */
const BUFFER_SECONDS = 20;
/** room left on the disk after a download */
const DISK_RESERVE = 512 * 1024 * 1024;
/** this many videos at the front of the queue are looked up ahead; the rest when they come up */
const LOOK_AHEAD = 3;
/** a video downloads ahead once it has been next this long, so reordering does not start and stop downloads */
const PREFETCH_DELAY_MS = 5_000;
/** a download ahead keeps going while its video is one of the next this many */
const KEEP_AHEAD = 2;
/** older lookups are made again before downloading: YouTube's links expire after some hours */
const LOOKUP_MAX_AGE_MS = 60 * 60_000;
/** what a queued search shows of what was typed */
const SHOWN_QUERY = 100;
/** playlists being read at once per channel; each is a lookup */
const PENDING_PLAYLISTS = 2;

const minutes = (seconds: number) => Math.round(seconds / 60);

let fetches = 0;

/** one count across every player, so a new player never goes back in time */
let revisions = 0;
export const currentRevision = (): number => revisions;

/** the bytes a download takes; without sizes from YouTube, a generous 8 Mbit/s, and 2 GB without a length either */
const sizeOf = (video: TResolved) => {
  const sizes = video.parts ? [video.parts.video.size, video.parts.audio.size] : [null];
  if (sizes.every((size) => size !== null)) return sizes.reduce<number>((sum, size) => sum + size!, 0);
  return video.duration > 0 ? video.duration * 1_000_000 : 2 * 1024 ** 3;
};

const fraction = (download: TDownload) => (download.done ? 1 : download.total ? Math.min(1, download.bytes / download.total) : 0);

export class ChannelPlayer {
  private queue: TItem[] = [];
  private pending: TPending[] = [];
  private current: TCurrent | null = null;
  private output: TOutput | null = null;
  private locked = false;
  private error: TMessage | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private rev = ++revisions;
  /** the video waiting out PREFETCH_DELAY_MS before it downloads ahead */
  private prefetchFor: TItem | null = null;
  private prefetchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly channelId: number,
    private readonly deps: TPlayerDeps,
  ) {}

  get isLocked(): boolean {
    return this.locked;
  }

  /** a video is on air, so clients count its position up */
  get playing(): boolean {
    return this.current?.state === "playing";
  }

  /** a video is playing, paused or loading, which takes one of the server's slots */
  get busy(): boolean {
    return this.current !== null;
  }

  // -- what people can do --------------------------------------------------

  add(query: string, userId: number): void {
    this.assertAlive();
    const source = parseQuery(query);
    if (this.queue.length + this.pending.length >= MAX_QUEUE) throw new UserError("error.queueFull");
    if (source.kind === "playlist" && this.pending.length >= PENDING_PLAYLISTS) throw new UserError("error.playlistsLoading");
    if (!this.current && !this.deps.slotFree()) throw new UserError("error.slots");
    this.setError(null);
    if (source.kind === "playlist") {
      this.addPlaylist(source.listId, userId);
    } else {
      this.queue.push(this.item(source, userId, null));
      this.next();
      this.lookAhead();
    }
    this.changed();
  }

  pause(): void {
    const current = this.requireCurrent();
    if (current.item.video?.live) throw new UserError("error.livePause");
    if (current.state === "paused") return;
    if (current.state !== "playing") throw new UserError("error.stillLoading");
    current.base = this.position(current);
    current.state = "paused";
    this.background(this.stopRun(current));
    this.changed();
  }

  resume(): void {
    const current = this.requireCurrent();
    if (current.state !== "paused") return;
    current.state = "loading";
    this.changed();
    this.maybeStart(current);
  }

  seek(position: number): void {
    const current = this.requireCurrent();
    const video = current.item.video;
    if (!video) throw new UserError("error.stillLoading");
    if (video.live) throw new UserError("error.liveSeek");
    const end = video.duration > 0 ? video.duration - 1 : Number.MAX_SAFE_INTEGER;
    current.base = Math.max(0, Math.min(end, Math.floor(position)));
    // paused: it starts there when resumed
    if (current.state !== "paused") {
      current.state = "loading";
      this.background(this.stopRun(current));
      this.maybeStart(current);
    }
    this.changed();
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
    for (const pending of this.pending.splice(0)) pending.abort.abort();
    this.changed();
  }

  remove(id: string): void {
    const pending = this.pending.find((entry) => entry.id === id);
    if (pending) {
      pending.abort.abort();
      this.pending.splice(this.pending.indexOf(pending), 1);
    }
    const index = this.queue.findIndex((item) => item.id === id);
    if (index !== -1) {
      const [item] = this.queue.splice(index, 1);
      this.discard(item!);
      this.lookAhead();
      this.prefetch();
    }
    if (pending || index !== -1) this.changed();
  }

  /** moves a queued video so it ends up at index `to` */
  move(id: string, to: number): void {
    const from = this.queue.findIndex((item) => item.id === id);
    if (from === -1) return;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(Math.max(0, Math.min(this.queue.length, Math.floor(to))), 0, item!);
    this.lookAhead();
    this.prefetch();
    this.changed();
  }

  /**
   * The playing video's captions in one language, the lines between `from`
   * and CAPTION_WINDOW seconds later. Each track is downloaded once per video.
   */
  async captions(entryId: string, trackId: string, from: number): Promise<TCaptions> {
    const item = this.current?.item;
    if (!item || item.id !== entryId) throw new UserError("error.nothingPlaying");
    const track = item.video?.captions.find((candidate) => candidate.id === trackId);
    if (!track) throw new UserError("error.captions");
    let cues = item.captions.get(track.id);
    if (!cues) {
      const video = item.video!;
      cues = (async () => {
        const dir = path.join(this.deps.cacheDir, item.id, "captions");
        await mkdir(dir, { recursive: true });
        return this.deps.youtube.captions(video, track, dir, item.abort.signal);
      })();
      item.captions.set(track.id, cues);
      // a failure is not tried again for this video, but is logged once
      cues.catch((error) => {
        if (!(error instanceof UserError) && !item.abort.signal.aborted) this.deps.log.error(`[captions ${this.channelId}]`, errorText(error));
      });
    }
    let all: TCue[];
    try {
      all = await cues;
    } catch (error) {
      throw error instanceof UserError ? error : new UserError("error.captions");
    }
    const start = Math.max(0, Math.floor(from));
    const until = start + CAPTION_WINDOW;
    return { cues: all.filter(([begin, end]) => end > start * 1000 && begin < until * 1000), from: start, until };
  }

  /** starts the queue again after it waited for a free slot */
  retry(): void {
    if (!this.current && this.queue.length && !this.destroyed) this.background(this.advance());
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.changed();
  }

  /** stops everything and takes the stream down; the player is unusable afterwards. Resolves once ffmpeg is gone. */
  destroy(): Promise<void> {
    this.destroyed = true;
    for (const item of this.queue.splice(0)) this.discard(item);
    for (const pending of this.pending.splice(0)) pending.abort.abort();
    const current = this.current;
    this.current = null;
    const stopped = current ? this.stopRun(current) : Promise.resolve();
    if (current) this.discard(current.item, stopped);
    this.takeDown();
    clearTimeout(this.errorTimer);
    clearTimeout(this.prefetchTimer);
    return stopped;
  }

  snapshot(): TPlayer {
    const current = this.current;
    const entry = (item: TItem) => ({
      id: item.id,
      title: item.video?.title ?? item.hint?.title ?? (item.source.kind === "search" ? item.source.text.slice(0, SHOWN_QUERY) : "YouTube video"),
      duration: item.video?.duration ?? item.hint?.duration ?? 0,
      live: item.video?.live ?? false,
      progress: this.progress(item),
    });
    const pending = this.pending.map((entry): TQueueEntry => ({ id: entry.id, title: "", duration: 0, live: false, progress: null, state: "resolving", playlist: true }));
    // only the one playing shows its thumbnail
    const now = current && {
      ...entry(current.item),
      thumbnail: current.item.video ? this.deps.thumbnail(current.item.video.videoId) : "",
      captions: current.item.video?.captions ?? [],
      state: current.state,
      position: Math.floor(this.position(current)),
    };
    return {
      channelId: this.channelId,
      rev: this.rev,
      now,
      queue: [
        ...this.queue.map((item): TQueueEntry => ({ ...entry(item), state: item.resolving && !item.video && !item.hint ? "resolving" : "ready" })),
        ...pending,
      ],
      locked: this.locked,
      error: this.error,
    };
  }

  // -- inside ---------------------------------------------------------------

  private item(source: TSource, addedBy: number, hint: TItem["hint"]): TItem {
    return { id: crypto.randomUUID(), source, addedBy, hint, video: null, lookedUpAt: 0, urgent: false, captions: new Map(), resolving: null, fetching: null, downloads: null, abort: new AbortController() };
  }

  private assertAlive() {
    if (this.destroyed) throw new UserError("error.closed");
  }

  private requireCurrent(): TCurrent {
    if (!this.current) throw new UserError("error.nothingPlaying");
    return this.current;
  }

  private changed() {
    this.rev = ++revisions;
    if (!this.destroyed) this.deps.changed(this);
  }

  private setError(error: TMessage | null) {
    clearTimeout(this.errorTimer);
    this.error = error;
    if (error) {
      this.errorTimer = setTimeout(() => {
        this.error = null;
        this.changed();
      }, ERROR_SHOWN_MS);
    }
  }

  /** Bun ends the whole server on a rejection nobody handles, so work left running logs its failures */
  private background(task: Promise<unknown>) {
    task.catch((error) => this.deps.log.error(`[player ${this.channelId}]`, errorText(error)));
  }

  private report(error: unknown) {
    if (!(error instanceof UserError)) this.deps.log.error(`[player ${this.channelId}]`, errorText(error));
    if (!this.destroyed) this.setError(userMessage(error));
  }

  private position(current: TCurrent): number {
    if (current.state !== "playing" || !current.run) return current.base;
    return current.base + current.run.encoder.elapsed();
  }

  /** how much is downloaded, while it downloads */
  private progress(item: TItem): number | null {
    const files = item.downloads?.files;
    if (!files || files.every((file) => file.done)) return null;
    const totals = files.map((file) => (file.done ? file.bytes : file.total));
    if (totals.some((total) => total === null)) return fraction(files[0]!);
    // yt-dlp's totals can be estimates below what arrives
    return Math.min(1, files.reduce((sum, file) => sum + file.bytes, 0) / totals.reduce<number>((sum, total) => sum + total!, 0));
  }

  /** the next thing to do: start the queue, or download what comes next */
  private next() {
    if (!this.current) this.background(this.advance());
    else this.prefetch();
  }

  private addPlaylist(listId: string, userId: number) {
    const pending: TPending = { id: crypto.randomUUID(), addedBy: userId, abort: new AbortController() };
    this.pending.push(pending);
    this.background((async () => {
      try {
        await this.deps.ready();
        const entries = await this.deps.youtube.playlist(listId, pending.abort.signal);
        if (!this.pending.includes(pending)) return;
        this.pending.splice(this.pending.indexOf(pending), 1);
        const limit = this.deps.settings().maxSeconds;
        const fitting = entries.filter((entry) => !limit || entry.duration <= limit);
        const added = fitting.slice(0, Math.max(0, MAX_QUEUE - this.queue.length - this.pending.length));
        for (const entry of added) {
          this.queue.push(this.item({ kind: "video", videoId: entry.videoId, start: 0 }, userId, { title: entry.title, duration: entry.duration }));
        }
        if (added.length < fitting.length) this.report(new UserError("error.queueFullSome", { count: added.length, total: fitting.length }));
        else if (fitting.length < entries.length) this.report(new UserError("error.someTooLong", { minutes: minutes(limit) }));
        else if (!fitting.length) this.report(new UserError("yt.playlistEmpty"));
        this.next();
        this.lookAhead();
        this.changed();
      } catch (error) {
        if (!this.pending.includes(pending)) return;
        this.pending.splice(this.pending.indexOf(pending), 1);
        this.report(error);
        this.changed();
      }
    })());
  }

  /**
   * Looks the video up once, and checks it against the length limit. The
   * lookup's info is kept on disk for the downloads. `urgent`: wanted now, so
   * it goes ahead of other lookups.
   */
  private resolve(item: TItem, urgent = false): Promise<TResolved> {
    if (urgent) item.urgent = true;
    item.resolving ??= (async () => {
      await this.deps.ready();
      const settings = this.deps.settings();
      const dir = path.join(this.deps.cacheDir, item.id);
      await mkdir(dir, { recursive: true });
      const video = await this.deps.youtube.resolve(item.source, settings.quality, item.abort.signal, { urgent: () => item.urgent, saveTo: path.join(dir, "info.json") });
      if (!video.live && settings.maxSeconds > 0) {
        // without a length, nothing says how long or how large it is
        if (video.duration <= 0) throw new UserError("error.unknownLength");
        if (video.duration > settings.maxSeconds) throw new UserError("error.tooLong", { minutes: minutes(settings.maxSeconds) });
      }
      item.video = video;
      item.lookedUpAt = this.deps.now();
      this.changed();
      return video;
    })();
    return item.resolving;
  }

  /** the lookup, made again when its download links may have expired */
  private async freshVideo(item: TItem): Promise<TResolved> {
    const video = await this.resolve(item, true);
    if (video.live || this.deps.now() - item.lookedUpAt < LOOKUP_MAX_AGE_MS) return video;
    item.resolving = null;
    return this.resolve(item, true);
  }

  /** the first few queued videos are looked up ahead, so their titles show and a bad link says so early */
  private lookAhead() {
    for (const item of this.queue.slice(0, LOOK_AHEAD)) {
      if (!item.resolving) this.resolve(item).catch((error) => this.dropQueued(item, error));
    }
  }

  /**
   * Downloads the video once: video and audio side by side into files that
   * ffmpeg reads while they grow, or, without separate formats, one merged
   * file. Livestreams are read live instead. Its failure ends the video, or
   * drops it from the queue; `stopFetch` ends it quietly.
   */
  private fetch(item: TItem): void {
    if (item.fetching) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([item.abort.signal, abort.signal]);
    const fetching: TFetch = { abort, dir: path.join(this.deps.cacheDir, item.id, String(++fetches)), done: Promise.resolve() };
    item.fetching = fetching;
    fetching.done = (async () => {
      const video = await this.freshVideo(item);
      if (video.live) return;
      await mkdir(fetching.dir, { recursive: true });
      const free = await this.deps.disk.free(fetching.dir);
      signal.throwIfAborted();
      // checked and claimed in one step, so downloads starting together do not count the same space
      const needed = sizeOf(video);
      if (free !== null && free - this.deps.disk.reserved < needed + DISK_RESERVE) throw new UserError("error.disk");
      this.deps.disk.reserved += needed;
      try {
        await this.download(item, fetching, video, signal);
      } finally {
        this.deps.disk.reserved -= needed;
      }
    })();
    fetching.done.then(
      () => {
        // the one playing is in: the next may download now
        if (this.current?.item === item) this.prefetch();
      },
      (error) => {
        // stopped because it is no longer next
        if (item.fetching !== fetching) return;
        const current = this.current;
        if (current?.item === item) this.finish(current, error);
        else this.dropQueued(item, error);
      },
    );
  }

  private async download(item: TItem, fetching: TFetch, video: TResolved, signal: AbortSignal) {
    const dir = fetching.dir;
    let lastShown = 0;
    const tick = () => {
      if (item.fetching !== fetching) return;
      const progress = this.progress(item) ?? 1;
      // a progress bar does not need every percent
      if (progress - lastShown >= 0.02 || progress === 1) {
        lastShown = progress;
        this.changed();
      }
      if (this.current?.item === item) this.maybeStart(this.current);
    };
    if (video.parts) {
      const { video: videoPart, audio: audioPart } = video.parts;
      const files = [videoPart, audioPart].map((part, index): TDownload => ({
        file: path.join(dir, `${index ? "audio" : "video"}.${part.ext}`),
        bytes: 0,
        total: part.size,
        done: false,
      }));
      item.downloads = { separate: true, files };
      await Promise.all(
        [videoPart, audioPart].map((part, index) => {
          const download = files[index]!;
          return this.deps.youtube
            .downloadPart(video, part, download.file!, (bytes, total) => {
              download.bytes = bytes;
              download.total = total ?? download.total;
              tick();
            }, signal)
            .then(() => {
              download.done = true;
              tick();
            });
        }),
      );
    } else {
      const download: TDownload = { file: null, bytes: 0, total: null, done: false };
      item.downloads = { separate: false, files: [download] };
      download.file = await this.deps.youtube.downloadMerged(video, dir, (bytes, total) => {
        download.bytes = bytes;
        download.total = total;
        tick();
      }, signal);
      download.done = true;
      tick();
    }
  }

  /**
   * The next video downloads ahead once the one playing is downloaded, and
   * once it has been next for PREFETCH_DELAY_MS. A download ahead that is
   * running keeps going while its video is one of the next KEEP_AHEAD.
   */
  private prefetch() {
    this.queue.forEach((item, index) => {
      if (index >= KEEP_AHEAD && item.fetching) this.stopFetch(item);
    });
    const next = this.queue[0];
    if (!next || next.fetching || !this.currentDownloaded()) {
      clearTimeout(this.prefetchTimer);
      this.prefetchFor = null;
      return;
    }
    if (this.prefetchFor === next) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchFor = next;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchFor = null;
      if (!this.destroyed && this.queue[0] === next && this.currentDownloaded()) this.fetch(next);
    }, this.deps.prefetchDelayMs ?? PREFETCH_DELAY_MS);
  }

  /** the video playing needs no more downloading */
  private currentDownloaded(): boolean {
    const item = this.current?.item;
    if (!item?.video) return false;
    return item.video.live || (!!item.downloads && item.downloads.files.every((file) => file.done));
  }

  private stopFetch(item: TItem) {
    const fetching = item.fetching!;
    item.fetching = null;
    item.downloads = null;
    fetching.abort.abort();
    void fetching.done
      .catch(() => {})
      .then(() => rm(fetching.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
      .catch(() => {});
    this.changed();
  }

  private dropQueued(item: TItem, error: unknown) {
    const index = this.queue.indexOf(item);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.discard(item);
    this.report(error);
    this.lookAhead();
    this.prefetch();
    this.changed();
  }

  /** aborts what the item is doing and deletes its download, once `after` (ffmpeg reading it) is done */
  private discard(item: TItem, after?: Promise<unknown>) {
    item.abort.abort();
    const settled = Promise.allSettled([item.resolving, item.fetching?.done, after]);
    // on Windows, a killed download can hold its file a moment longer
    void settled.then(() => rm(path.join(this.deps.cacheDir, item.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })).catch(() => {});
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
      this.report(new UserError("error.slots"));
      this.changed();
      return;
    }
    const current: TCurrent = { item, state: "loading", base: 0, run: null, attempt: 0, starting: null, restarts: [], retried: false };
    this.current = current;
    this.lookAhead();
    this.changed();
    try {
      const video = await this.resolve(item, true);
      if (this.current !== current) return;
      current.base = video.start;
      this.output?.relabel(this.label(video));
      this.fetch(item);
      this.prefetch();
      this.maybeStart(current);
    } catch (error) {
      if (this.current === current) this.finish(current, error);
    }
  }

  private label(video: TResolved) {
    return { title: video.title, bannerUrl: this.deps.thumbnail(video.videoId) };
  }

  /** whether there is enough to play from `position`: the playlist of a livestream, or the download */
  private canStart(item: TItem, position: number): boolean {
    const video = item.video;
    if (!video) return false;
    if (video.live) return !!video.hls;
    const downloads = item.downloads;
    if (!downloads) return false;
    if (downloads.files.every((file) => file.done)) return true;
    if (!downloads.separate || video.duration <= 0) return false;
    const needed = Math.min(1, (position + BUFFER_SECONDS) / video.duration);
    return downloads.files.every((file) => file.bytes > 0 && fraction(file) >= needed);
  }

  /** starts playing when the current video is waiting for nothing but itself */
  private maybeStart(current: TCurrent) {
    if (this.current !== current || current.state !== "loading" || current.run || current.starting !== null) return;
    if (this.canStart(current.item, current.base)) this.startRun(current, current.base);
  }

  /** a new ffmpeg with its own transports, from `position` */
  private startRun(current: TCurrent, position: number) {
    const attempt = ++current.attempt;
    current.starting = attempt;
    current.base = position;
    void (async () => {
      const video = current.item.video!;
      const ffmpeg = this.deps.ffmpeg();
      if (!ffmpeg) throw new UserError("error.ffmpeg");
      const quality = this.deps.settings().quality;
      this.output ??= this.deps.createOutput(this.channelId);
      const output = this.output;
      const connection = await output.connect(h264Level(quality).profileLevelId);
      if (this.current !== current || current.attempt !== attempt || current.state !== "loading") {
        connection.close();
        return;
      }
      const downloads = current.item.downloads;
      const [first, second] = downloads?.files ?? [];
      const input = video.live ? video.hls!.url : downloads!.separate ? { video: first!.file!, audio: second!.file! } : first!.file!;
      const follow = !video.live && !!downloads?.files.some((file) => !file.done);
      let encoder: TEncoder;
      try {
        encoder = this.deps.encode(
          {
            ffmpeg,
            input,
            live: video.live,
            follow,
            copyAudio: !!downloads?.separate && !!video.parts?.audio.copy,
            start: position,
            // a little past the end: durations are rounded, and ffmpeg stops at the real one
            length: !video.live && video.duration > 0 ? video.duration - position + 1 : undefined,
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
            growing: follow ? () => downloads!.files.some((file) => !file.done) : undefined,
          },
        );
      } catch (error) {
        // ffmpeg could not even start: the transports were for nothing
        connection.close();
        throw error;
      }
      const run: TRun = { connection, onAir: false, encoder };
      current.run = run;
      this.background(encoder.exited.then((exit) => this.ended(current, run, exit)));
    })()
      .catch((error) => {
        if (this.current === current && current.attempt === attempt) this.finish(current, error);
      })
      .finally(() => {
        if (current.starting === attempt) current.starting = null;
      })
      .catch((error) => this.deps.log.error(`[player ${this.channelId}]`, errorText(error)));
  }

  /** stops the current ffmpeg on purpose, and any start still on its way; the exit is then ignored */
  private stopRun(current: TCurrent): Promise<void> {
    current.attempt++;
    current.starting = null;
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
    const position = current.base + run.encoder.elapsed();
    const atEnd = !video.live && (video.duration === 0 || position >= video.duration - 5);
    if (exit.code !== 0 && !atEnd) this.deps.log.error(`[ffmpeg ${this.channelId}] exit ${exit.code}: ${exit.error.slice(-300)}`);

    if (video.live) {
      const now = this.deps.now();
      current.restarts = current.restarts.filter((at) => now - at < LIVE_RESTART_WINDOW_MS);
      if (current.restarts.length >= LIVE_RESTARTS) {
        this.finish(current, new UserError("error.liveDropping"));
        return;
      }
      current.restarts.push(now);
      current.state = "loading";
      this.changed();
      this.background(this.restartLive(current));
      return;
    }

    // a run that played a while earns its retry back
    if (run.encoder.elapsed() >= RETRY_AFTER_SECONDS) current.retried = false;
    if (exit.code === 0 || atEnd) {
      this.finish(current, null);
    } else if (!current.retried) {
      current.retried = true;
      current.state = "loading";
      current.base = Math.floor(position);
      this.changed();
      this.maybeStart(current);
    } else {
      this.finish(current, new UserError("error.playback"));
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
      current.base = 0;
      this.maybeStart(current);
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
    this.background(this.advance());
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
