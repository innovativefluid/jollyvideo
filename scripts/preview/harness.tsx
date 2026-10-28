/**
 * The preview page: Sharkord's React globals and a pretend store around the
 * built client, inside a copy of Sharkord's voice controls.
 * `?scenario=playing|live|loading|locked|moderator|empty&theme=light&open=0`
 */
import { Monitor, PhoneOff, Video } from "lucide-react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JSX from "react/jsx-runtime";
import type { TControl, TNowPlaying, TPlayer, TQueueEntry, TViewer } from "../../src/contract";

const globals = window as unknown as Record<string, unknown>;
globals.__SHARKORD_REACT__ = React;
globals.__SHARKORD_REACT_JSX__ = JSX;
globals.__SHARKORD_REACT_DOM__ = ReactDOM;
globals.__SHARKORD_REACT_DOM_CLIENT__ = ReactDOMClient;

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "playing";
if (params.get("theme") !== "light") document.documentElement.classList.add("dark");

const thumbnail = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${hue + 60} 70% 30%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>`,
  )}`;

const now = (extra: Partial<TNowPlaying> = {}): TNowPlaying => ({
  id: "now",
  title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
  duration: 634,
  live: false,
  thumbnail: thumbnail(200),
  captions: [
    { id: "en", label: "English", auto: false },
    { id: "de", label: "German", auto: false },
  ],
  state: "playing",
  position: 127,
  progress: null,
  ...extra,
});
const queue: TQueueEntry[] = [
  { id: "q1", title: "Sintel - Open Movie by Blender Foundation", duration: 888, live: false, state: "ready", progress: 0.35 },
  { id: "q2", title: "lofi hip hop radio - beats to relax/study to", duration: 0, live: true, state: "ready", progress: null },
  { id: "q3", title: "tears of steel", duration: 0, live: false, state: "resolving", progress: null },
];

const scenarios: Record<string, TViewer> = {
  empty: { player: { channelId: 1, rev: 1, now: null, queue: [], locked: false, error: null }, canModerate: false },
  playing: { player: { channelId: 1, rev: 1, now: now({ progress: 0.62 }), queue, locked: false, error: null }, canModerate: false },
  live: { player: { channelId: 1, rev: 1, now: now({ title: "lofi hip hop radio 📚 - beats to relax/study to", live: true, duration: 0, thumbnail: thumbnail(280) }), queue: [], locked: false, error: null }, canModerate: false },
  loading: { player: { channelId: 1, rev: 1, now: now({ state: "loading", progress: 0.42, position: 0 }), queue: [], locked: false, error: null }, canModerate: false },
  locked: { player: { channelId: 1, rev: 1, now: now({ state: "paused" }), queue: queue.slice(0, 2), locked: true, error: null }, canModerate: false },
  moderator: { player: { channelId: 1, rev: 1, now: now(), queue: queue.slice(0, 1), locked: true, error: { key: "yt.private" } }, canModerate: true },
};

let viewer: TViewer = structuredClone(scenarios[scenario] ?? scenarios.playing!);
let push: ((data: unknown) => void) | undefined;
const update = (player: TPlayer) => {
  viewer = { ...viewer, player: { ...player, rev: player.rev + 1 } };
  player = viewer.player;
  setTimeout(() => push?.(player), 0);
};

const control = (op: TControl) => {
  const player = structuredClone(viewer.player);
  if (op.op === "pause" && player.now) player.now.state = "paused";
  if (op.op === "resume" && player.now) player.now.state = "playing";
  if (op.op === "seek" && player.now) player.now.position = op.position;
  if (op.op === "lock") player.locked = op.locked;
  if (op.op === "remove") player.queue = player.queue.filter((entry) => entry.id !== op.id);
  if (op.op === "move") {
    const from = player.queue.findIndex((entry) => entry.id === op.id);
    const [entry] = player.queue.splice(from, 1);
    player.queue.splice(op.to, 0, entry!);
  }
  if (op.op === "clear") player.queue = [];
  if (op.op === "stop") Object.assign(player, { now: null, queue: [] });
  if (op.op === "skip") {
    const [next, ...rest] = player.queue;
    player.now = next ? { ...next, thumbnail: "", captions: [], state: "playing", position: 0 } : null;
    player.queue = rest;
  }
  update(player);
};

globals.__SHARKORD_STORE__ = {
  getState: () => ({ currentVoiceChannelId: 1 }),
  subscribe: () => () => {},
  actions: {
    async executePluginAction(_plugin: string, name: string, payload: unknown) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (name === "captions") {
        // a line every four seconds, the way an uploader's captions come
        const { track, from } = payload as { track: string; from: number };
        const words = track === "de" ? "Die Geschichte eines großen Hasen" : "The story of a big bunny and three bullies";
        const cues = Array.from({ length: 75 }, (_, i) => [(from + i * 4) * 1000, (from + i * 4 + 3.5) * 1000, `${words} (${from + i * 4} s)`]);
        return { cues, from, until: from + 300 };
      }
      if (name === "add") {
        const query = (payload as { query: string }).query;
        const entry: TQueueEntry = { id: crypto.randomUUID(), title: query, duration: 0, live: false, state: "resolving", progress: null };
        update({ ...viewer.player, queue: [...viewer.player.queue, entry] });
      }
      if (name === "control") control(payload as TControl);
      return viewer;
    },
    onPush(_plugin: string, handler: (data: unknown) => void) {
      push = handler;
      return () => {};
    },
  },
};

const { components } = (await import("/client.js" as string)) as { components: { voice_controls: React.ComponentType<{ channelId: number }>[] } };
const Button = components.voice_controls[0]!;

// Sharkord's voice controls, at the bottom of its left sidebar (voice-control.tsx)
const Sidebar = () => (
  <div className="flex h-full">
    <div className="flex w-72 flex-col border-r border-border bg-card">
      <div className="flex-1" />
      <div className="bg-secondary/30 border-t border-border">
        <div className="flex items-center px-2 py-1.5 gap-2 bg-secondary/50">
          <span className="text-xs font-medium text-green-600">Voice connected</span>
        </div>
        <div className="flex items-center justify-between px-2 py-2">
          <button className="inline-flex items-center justify-center whitespace-nowrap text-sm font-medium border bg-background shadow-xs hover:bg-accent dark:bg-input/30 dark:border-input h-8 rounded-md gap-1.5 px-3">
            <PhoneOff className="h-3.5 w-3.5 mr-1.5" />
            Disconnect
          </button>
          <div className="flex gap-1">
            <Button channelId={1} />
            {[Video, Monitor].map((Icon, index) => (
              <button key={index} className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground">
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
    <div className="flex-1 bg-background" />
  </div>
);

ReactDOMClient.createRoot(document.getElementById("root")!).render(<Sidebar />);
if (params.get("open") !== "0") {
  setTimeout(() => document.querySelector<HTMLButtonElement>("button[aria-label='Watch together']")?.click(), 100);
}
