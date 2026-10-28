/**
 * Captions, for this viewer only: whether they are on and in which language
 * (remembered in the browser), and the lines, fetched from the server a
 * window of CAPTION_WINDOW seconds at a time as the video plays.
 */
import { useSyncExternalStore } from "react";
import { CAPTION_WINDOW, PLUGIN_ID, type TCaptions, type TCaptionTrack, type TJollyvideo, type TNowPlaying } from "../contract";

const STORAGE_KEY = "jollyvideo:captions";
/** the next window is fetched this long before it is needed */
const AHEAD_SECONDS = 30;
/** lines shown at once, newest last: YouTube's automatic captions roll two lines */
const SHOWN_LINES = 2;
/** windows kept; older ones are fetched again if someone seeks back */
const KEPT_WINDOWS = 12;

type TWindow = TCaptions | "loading" | "failed";

const remembered = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** the language picked, or null while captions are off */
let chosen: string | null = remembered();
const windows = new Map<string, TWindow>();
const listeners = new Set<() => void>();
/** bumped by every change, so React sees one */
let version = 0;

const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const choose = (trackId: string | null): void => {
  chosen = trackId;
  try {
    if (trackId) localStorage.setItem(STORAGE_KEY, trackId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // remembered for this page only
  }
  changed();
};

const base = (id: string) => id.split("-")[0]!.toLowerCase();

/** the track for the language picked: the same one, else the same language, else the first */
export const trackFor = (tracks: TCaptionTrack[], wanted: string | null): TCaptionTrack | null => {
  if (!wanted || !tracks.length) return null;
  return tracks.find((track) => track.id === wanted) ?? tracks.find((track) => base(track.id) === base(wanted)) ?? tracks[0]!;
};

/** the track to start with: the browser's language if the video has it, the uploader's over YouTube's own */
export const firstTrack = (tracks: TCaptionTrack[], languages: readonly string[]): TCaptionTrack | null => {
  for (const language of languages) {
    const match = tracks.find((track) => base(track.id) === base(language));
    if (match) return match;
  }
  return tracks.find((track) => !track.auto) ?? tracks[0] ?? null;
};

const call = (payload: TJollyvideo["actions"]["captions"]["payload"]) =>
  window.__SHARKORD_STORE__.actions.executePluginAction<TCaptions>(PLUGIN_ID, "captions", payload);

const load = (entryId: string, trackId: string, index: number) => {
  const key = `${entryId}/${trackId}/${index}`;
  if (windows.has(key)) return;
  windows.set(key, "loading");
  while (windows.size > KEPT_WINDOWS) windows.delete(windows.keys().next().value as string);
  call({ id: entryId, track: trackId, from: index * CAPTION_WINDOW }).then(
    (captions) => {
      if (windows.get(key) !== "loading") return;
      windows.set(key, captions);
      changed();
    },
    () => {
      if (windows.get(key) !== "loading") return;
      windows.set(key, "failed");
      changed();
    },
  );
};

export type TCaptionView = {
  tracks: TCaptionTrack[];
  /** null while captions are off, or the video has none */
  track: TCaptionTrack | null;
  lines: string[];
  failed: boolean;
};

/** what to show for `now` at `position` seconds, fetching what is missing */
export const captionsAt = (now: TNowPlaying | null, position: number): TCaptionView => {
  const tracks = now?.captions ?? [];
  const track = now ? trackFor(tracks, chosen) : null;
  if (!now || !track) return { tracks, track: null, lines: [], failed: false };
  const index = Math.floor(position / CAPTION_WINDOW);
  load(now.id, track.id, index);
  if (now.duration === 0 || (index + 1) * CAPTION_WINDOW < now.duration) {
    if (position + AHEAD_SECONDS >= (index + 1) * CAPTION_WINDOW) load(now.id, track.id, index + 1);
  }
  const window = windows.get(`${now.id}/${track.id}/${index}`);
  if (window === "failed") return { tracks, track, lines: [], failed: true };
  if (!window || window === "loading") return { tracks, track, lines: [], failed: false };
  const at = position * 1000;
  const lines = window.cues.filter(([start, end]) => start <= at && at < end).map((cue) => cue[2]);
  return { tracks, track, lines: lines.slice(-SHOWN_LINES), failed: false };
};

/** re-renders when the language changes or a window arrives */
export const useCaptionStore = (): number => useSyncExternalStore(subscribe, () => version);

/** for tests */
export const resetCaptions = (): void => {
  chosen = remembered();
  windows.clear();
  listeners.clear();
};
