import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TControl, TNowPlaying, TPlayer, TQueueEntry, TViewer } from "../../src/contract";
import { cls } from "../../src/client/classes";
import { reset } from "../../src/client/store";
import { VoiceButton } from "../../src/client/voice-button";

const CHANNEL = 5;

type TCall = { name: string; payload: unknown };

const now = (extra: Partial<TNowPlaying> = {}): TNowPlaying => ({
  id: "n1",
  title: "Big Buck Bunny",
  duration: 120,
  live: false,
  thumbnail: "/plugins/jollyvideo/thumb/aqz-KE-bpKQ.jpg",
  addedBy: 1,
  state: "playing",
  position: 10,
  progress: null,
  ...extra,
});
const entry = (id: string, extra: Partial<TQueueEntry> = {}): TQueueEntry => ({
  id,
  title: `Next ${id}`,
  duration: 75,
  live: false,
  thumbnail: "",
  addedBy: 1,
  state: "ready",
  progress: null,
  ...extra,
});
let revs = 0;
const player = (extra: Partial<TPlayer> = {}): TPlayer => ({ channelId: CHANNEL, rev: ++revs, now: null, queue: [], locked: false, error: null, ...extra });

let calls: TCall[];
let state: TViewer;
let failNext: string | null;
let push: (data: unknown) => void;

const installHost = () => {
  calls = [];
  failNext = null;
  state = { player: player(), canModerate: false };
  window.__SHARKORD_STORE__ = {
    getState: () => ({ currentVoiceChannelId: CHANNEL }),
    subscribe: () => () => {},
    actions: {
      executePluginAction: async (pluginId: string, name: string, payload?: unknown) => {
        expect(pluginId).toBe("jollyvideo");
        calls.push({ name, payload });
        if (failNext) {
          const message = failNext;
          failNext = null;
          throw new Error(message);
        }
        return state;
      },
      onPush: (_pluginId: string, handler: (data: unknown) => void) => {
        push = handler;
        return () => {};
      },
    },
  } as never;
};

const open = async () => {
  render(<VoiceButton />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Watch together" }));
  });
  return screen.getByRole("dialog");
};

const show = async (next: TViewer) => {
  state = next;
  await act(async () => push(next.player));
};

const controls = () => calls.filter((call) => call.name === "control").map((call) => call.payload as TControl);

beforeEach(() => {
  reset();
  installHost();
});
afterEach(() => cleanup());

describe("the panel", () => {
  it("opens from the voice controls with just a search field", async () => {
    const dialog = await open();
    expect(screen.getByRole("textbox", { name: "YouTube link or search" })).toBe(document.activeElement as HTMLInputElement);
    expect(dialog.querySelectorAll("button")).toHaveLength(1);
    expect(calls.map((call) => call.name)).toContain("state");
  });

  it("adds what was typed, and clears the field", async () => {
    await open();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  big buck bunny " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(calls.at(-1)).toEqual({ name: "add", payload: { query: "big buck bunny" } });
    expect(input.value).toBe("");
  });

  it("shows the video playing, counts up, and controls it", async () => {
    await open();
    await show({ player: player({ now: now() }), canModerate: false });
    expect(screen.getByText("Big Buck Bunny")).toBeDefined();
    expect(screen.getByText(/^0:1\d \/ 2:00$/)).toBeDefined();
    expect(screen.getByRole("slider", { name: "Position" }).getAttribute("aria-valuemax")).toBe("120");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    expect(controls()).toEqual([{ op: "pause" }, { op: "skip" }, { op: "stop" }]);
  });

  it("seeks with the keyboard", async () => {
    await open();
    await show({ player: player({ now: now({ state: "paused", position: 30 }) }), canModerate: false });
    await act(async () => fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" }));
    expect(controls()).toEqual([{ op: "seek", position: 35 }]);
    expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
  });

  it("marks livestreams and leaves out what they cannot do", async () => {
    await open();
    await show({ player: player({ now: now({ live: true, duration: 0 }) }), canModerate: false });
    expect(screen.getByText("LIVE")).toBeDefined();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows loading with the download's progress", async () => {
    await open();
    await show({ player: player({ now: now({ state: "loading", progress: 0.42 }) }), canModerate: false });
    expect(screen.getByText("42%")).toBeDefined();
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
  });

  it("lists the queue and removes from it", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b", { state: "resolving", title: "lofi" }), entry("c", { live: true })] }), canModerate: false });
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["1:15Next a", "lofi", "LIVENext c"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Next a" })));
    expect(controls()).toEqual([{ op: "remove", id: "a" }]);
  });

  it("locks everything but watching for non-moderators", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a")], locked: true }), canModerate: false });
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText("Locked").getAttribute("title")).toBe("Only moderators can control this right now");
    for (const name of ["Pause", "Skip", "Stop"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBe("true");
  });

  it("gives moderators the lock", async () => {
    // the moderator flag comes with action answers, not with pushes
    state = { player: player({ now: now() }), canModerate: true };
    await open();
    const lock = screen.getByRole("button", { name: "Lock" });
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(lock));
    expect(controls().at(-1)).toEqual({ op: "lock", locked: true });
    await show({ player: player({ now: now(), locked: true }), canModerate: true });
    expect(screen.getByRole("button", { name: "Unlock" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
  });

  it("says why an action failed", async () => {
    await open();
    failNext = "Only moderators can control this right now";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Only moderators can control this right now");
  });

  it("shows the server's errors", async () => {
    await open();
    await show({ player: player({ error: "This video is private" }), canModerate: false });
    expect(screen.getByRole("alert").textContent).toBe("This video is private");
  });

  it("closes with Escape and with a click elsewhere", async () => {
    await open();
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Watch together" })));
    expect(screen.getByRole("dialog")).toBeDefined();
    await act(async () => fireEvent.pointerDown(document.body));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves Escape to the chat box when focus is outside", async () => {
    const chat = document.createElement("input");
    document.body.append(chat);
    await open();
    chat.focus();
    await act(async () => fireEvent.keyDown(chat, { key: "Escape" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    screen.getByRole("textbox", { name: "YouTube link or search" }).focus();
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Watch together" }));
    chat.remove();
  });

  it("keeps a newer push over an older answer", async () => {
    await open();
    const stale = player({ now: now({ title: "Old" }) });
    await act(async () => push(player({ now: now({ title: "New" }) })));
    state = { player: stale, canModerate: true };
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip" })));
    expect(screen.getByText("New")).toBeDefined();
    // the answer still says what the user may do
    expect(screen.getByRole("button", { name: "Lock" })).toBeDefined();
  });

  it("opens downwards when the button is near the top", async () => {
    render(<VoiceButton />);
    const button = screen.getByRole("button", { name: "Watch together" });
    button.getBoundingClientRect = () => ({ left: 10, top: 20, bottom: 52, right: 42, width: 32, height: 32, x: 10, y: 20, toJSON() {} }) as DOMRect;
    await act(async () => fireEvent.click(button));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-side")).toBe("bottom");
    expect(dialog.style.top).toBe("60px");
  });

  it("ignores pushes for other channels", async () => {
    await open();
    await act(async () => push(player({ channelId: 99, now: now() })));
    expect(screen.queryByText("Big Buck Bunny")).toBeNull();
  });

  it("uses only Sharkord's classes", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b", { state: "resolving" })], locked: true, error: "x" }), canModerate: true });
    const known = new Set(Object.values(cls).flatMap((value) => value.split(" ")));
    const used = new Set<string>();
    for (const element of [screen.getByRole("button", { name: "Watch together" }), ...document.querySelectorAll("[role=dialog] *, [role=dialog]")]) {
      for (const name of element.getAttribute("class")?.split(/\s+/) ?? []) if (name && !name.startsWith("lucide")) used.add(name);
    }
    expect([...used].filter((name) => !known.has(name))).toEqual([]);
  });
});
