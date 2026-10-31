/**
 * What the server and the client half agree on: the actions the panel calls,
 * the chat commands, and the state pushed to everyone in a voice channel.
 */
import type { TMessage } from "./i18n";

export type TVideo = {
  /** queue entry id, unique per add */
  id: string;
  title: string;
  /** seconds; 0 for livestreams and while still loading */
  duration: number;
  live: boolean;
};

export type TQueueEntry = TVideo & {
  state: "resolving" | "ready";
  /** download progress 0..1 while prefetching */
  progress: number | null;
  /** a playlist still being looked up; becomes its videos */
  playlist?: true;
};

/** a caption language the video has; `id` is YouTube's language code */
export type TCaptionTrack = { id: string; label: string; auto: boolean };

/** one caption line: from and to (milliseconds into the video), text */
export type TCue = [start: number, end: number, text: string];

export type TCaptions = {
  /** the lines shown between `from` and `until` (seconds), in order */
  cues: TCue[];
  from: number;
  until: number;
};

/** a chapter of the video, from its description: starts `start` seconds in */
export type TChapter = { start: number; title: string };

/**
 * Small frames of the video, for the time bar's preview: sheets of `columns`
 * × `rows` frames of `width` × `height`, a frame every `interval` seconds.
 * `url` has `{n}` for the sheet's number, from 0 to `count` - 1.
 */
export type TStoryboard = { url: string; count: number; width: number; height: number; columns: number; rows: number; interval: number };

export type TNowPlaying = TVideo & {
  /** same-origin path of the cached thumbnail, or "" */
  thumbnail: string;
  captions: TCaptionTrack[];
  chapters: TChapter[];
  storyboard: TStoryboard | null;
  state: "loading" | "playing" | "paused";
  /** seconds into the video when this state was produced */
  position: number;
  /** how much of the video is downloaded, 0..1, while it downloads */
  progress: number | null;
};

export type TPlayer = {
  channelId: number;
  /** grows with every change, so an answer that arrives late cannot undo a newer push */
  rev: number;
  now: TNowPlaying | null;
  queue: TQueueEntry[];
  /** only moderators control playback while locked */
  locked: boolean;
  error: TMessage | null;
};

export type TViewer = {
  player: TPlayer;
  /** may lock the player, and control it while it is locked */
  canModerate: boolean;
};

export type TControl =
  | { op: "pause" | "resume" | "skip" | "stop" | "clear" }
  | { op: "seek"; position: number }
  | { op: "remove"; id: string }
  /** to: the queue index the entry ends up at */
  | { op: "move"; id: string; to: number }
  | { op: "lock"; locked: boolean };

export type TJollyvideo = {
  actions: {
    state: { payload: void; response: TViewer | null };
    add: { payload: { query: string }; response: TViewer };
    control: { payload: TControl; response: TViewer };
    /** the playing video's captions in one language, a window of CAPTION_WINDOW seconds from `from` */
    captions: { payload: { id: string; track: string; from: number }; response: TCaptions };
  };
  commands: {
    watch: { args: { query: string }; response: string };
    "watch-skip": { args: void; response: string };
    "watch-stop": { args: void; response: string };
    "watch-lock": { args: void; response: string };
    "watch-update": { args: void; response: string };
  };
  push: TPlayer;
};

export const PLUGIN_ID = "jollyvideo";
export const MAX_QUERY_LENGTH = 500;
export const MAX_QUEUE = 50;
export const CAPTION_WINDOW = 300;
