/**
 * What the server and the client half agree on: the actions the panel calls,
 * the chat commands, and the state pushed to everyone in a voice channel.
 */

export type TVideo = {
  /** queue entry id, unique per add */
  id: string;
  title: string;
  /** seconds; 0 for livestreams and while still loading */
  duration: number;
  live: boolean;
  /** same-origin path of the cached thumbnail, or "" */
  thumbnail: string;
  addedBy: number;
};

export type TQueueEntry = TVideo & {
  state: "resolving" | "ready";
  /** download progress 0..1 while prefetching */
  progress: number | null;
};

export type TNowPlaying = TVideo & {
  state: "loading" | "playing" | "paused";
  /** seconds into the video when this state was produced */
  position: number;
  /** download progress 0..1 while loading */
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
  error: string | null;
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
  | { op: "lock"; locked: boolean };

export type TJollyvideo = {
  actions: {
    state: { payload: void; response: TViewer | null };
    add: { payload: { query: string }; response: TViewer };
    control: { payload: TControl; response: TViewer };
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
