import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TControl, TNowPlaying, TPlayer, TQueueEntry, TViewer } from "../../src/contract";
import { cls } from "../../src/client/classes";
import { resetCaptions } from "../../src/client/captions";
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
  captions: [],
  chapters: [],
  storyboard: null,
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
/** the server's captions: a line every 10 seconds naming its language and time; "xx" fails */
const captionsAnswer = async ({ track, from }: { track: string; from: number }) => {
  if (track === "xx") throw new Error('jv:{"key":"error.captions"}');
  const cues = Array.from({ length: 30 }, (_, i) => [(from + i * 10) * 1000, (from + i * 10 + 8) * 1000, `${track} at ${from + i * 10}`]);
  return { cues, from, until: from + 300 };
};

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
        if (name === "captions") return captionsAnswer(payload as { track: string; from: number });
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

const open = async (name = "Watch together") => {
  render(<VoiceButton />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
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
  localStorage.clear();
  resetCaptions();
  installHost();
});
afterEach(() => cleanup());

describe("captions", () => {
  const tracks = [
    { id: "en", label: "English", auto: false },
    { id: "de", label: "Deutsch", auto: false },
    { id: "xx", label: "Broken", auto: false },
  ];
  const captionCalls = () => calls.filter((call) => call.name === "captions").map((call) => call.payload);

  it("are off until this viewer turns them on, then follow the video", async () => {
    await open();
    await show({ player: player({ now: now({ captions: tracks, position: 312, duration: 900 }) }), canModerate: false });
    const button = screen.getByRole("button", { name: "Captions" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(captionCalls()).toEqual([]);
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("button", { name: "Captions" }).getAttribute("aria-pressed")).toBe("true");
    // the browser speaks English: the English track, the window the position is in
    expect(captionCalls()).toEqual([{ id: "n1", track: "en", from: 300 }]);
    expect(await screen.findByText("en at 310")).toBeTruthy();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Caption language" }), { target: { value: "de" } }));
    expect(await screen.findByText("de at 310")).toBeTruthy();
    expect(localStorage.getItem("jollyvideo:captions")).toBe("de");
  });

  it("fetch the next window shortly before it is needed", async () => {
    localStorage.setItem("jollyvideo:captions", "en");
    resetCaptions();
    await open();
    await show({ player: player({ now: now({ captions: tracks, position: 285, duration: 900 }) }), canModerate: false });
    expect(captionCalls()).toEqual([
      { id: "n1", track: "en", from: 0 },
      { id: "n1", track: "en", from: 300 },
    ]);
  });

  it("say so when they cannot be loaded, and stay off for videos without any", async () => {
    localStorage.setItem("jollyvideo:captions", "xx");
    resetCaptions();
    await open();
    await show({ player: player({ now: now({ captions: tracks, position: 5 }) }), canModerate: false });
    expect(await screen.findByText("The captions could not be loaded")).toBeTruthy();
    await show({ player: player({ now: now({ id: "n2", captions: [], position: 5 }) }), canModerate: false });
    expect(screen.queryByRole("button", { name: "Captions" })).toBeNull();
  });
});

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

  it("shows an empty frame when the thumbnail does not load", async () => {
    await open();
    await show({ player: player({ now: now() }), canModerate: false });
    const image = document.querySelector("[role=dialog] img")!;
    await act(async () => fireEvent.error(image));
    expect(document.querySelector("[role=dialog] img")).toBeNull();
  });

  it("seeks with the keyboard", async () => {
    await open();
    await show({ player: player({ now: now({ state: "paused", position: 30 }) }), canModerate: false });
    await act(async () => fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" }));
    expect(controls()).toEqual([{ op: "seek", position: 35 }]);
    expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
  });

  /** the seek bar's track: 200 px wide from x = 100 */
  const layOutTrack = () => {
    const track = document.querySelector<HTMLElement>(`[role=dialog] [data-orientation=horizontal].${cls.sliderTrack.split(" ")[0]}`)!;
    track.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 6, right: 300, bottom: 6, x: 100, y: 0, toJSON() {} }) as DOMRect;
    return track.parentElement!;
  };
  const chapters = [
    { start: 0, title: "Intro" },
    { start: 60, title: "The middle" },
    { start: 100, title: "" },
  ];

  it("shows the time and chapter under the mouse, and seeks to it on a click", async () => {
    await open();
    await show({ player: player({ now: now({ chapters }) }), canModerate: false });
    const bar = layOutTrack();
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(async () => fireEvent.pointerMove(bar, { pointerType: "mouse", clientX: 220 }));
    expect(screen.getByRole("tooltip").textContent).toBe("1:12The middle");
    await act(async () => fireEvent.pointerMove(bar, { pointerType: "mouse", clientX: 290 }));
    // a chapter without a title shows just the time
    expect(screen.getByRole("tooltip").textContent).toBe("1:54");
    await act(async () => fireEvent.pointerLeave(bar));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // gaps where the second and third chapters start
    expect(document.querySelectorAll(`[role=dialog] .${cls.chapterGap.split(" ")[0]}`)).toHaveLength(2);
    // the chapter playing (10 s in) under the title
    expect(screen.getByText("Intro")).toBeDefined();
    expect(controls()).toEqual([]);
  });

  it("shows the storyboard frame of the time under the mouse", async () => {
    const storyboard = { url: "/thumb/k/v/sb{n}.jpg", count: 2, width: 80, height: 45, columns: 5, rows: 5, interval: 2 };
    await open();
    await show({ player: player({ now: now({ storyboard }) }), canModerate: false });
    const bar = layOutTrack();
    // 0.6 × 120 s = 72 s: frame 36, the 12th of the second sheet, row 2, column 1
    await act(async () => fireEvent.pointerMove(bar, { pointerType: "mouse", clientX: 220 }));
    const image = screen.getByRole("tooltip").querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/thumb/k/v/sb1.jpg");
    expect([image.style.width, image.style.left, image.style.top]).toEqual(["800px", "-160px", "-180px"]);
    // a sheet that does not load leaves just the time
    await act(async () => fireEvent.error(image));
    expect(screen.getByRole("tooltip").querySelector("img")).toBeNull();
    expect(screen.getByRole("tooltip").textContent).toBe("1:12");
  });

  it("shows where a drag goes, and seeks only when let go", async () => {
    await open();
    await show({ player: player({ now: now({ chapters }) }), canModerate: false });
    const bar = layOutTrack();
    await act(async () => fireEvent.pointerDown(bar, { button: 0, pointerId: 1, pointerType: "touch", clientX: 110 }));
    await act(async () => fireEvent.pointerMove(bar, { pointerId: 1, pointerType: "touch", clientX: 250 }));
    expect(screen.getByRole("tooltip").textContent).toBe("1:30The middle");
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("90");
    expect(controls()).toEqual([]);
    await act(async () => fireEvent.pointerUp(bar, { pointerId: 1, pointerType: "touch", clientX: 250 }));
    expect(controls()).toEqual([{ op: "seek", position: 90 }]);
    expect(screen.queryByRole("tooltip")).toBeNull();
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
    failNext = 'TRPCClientError: jv:{"key":"error.locked"}';
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Only moderators can control this right now");
  });

  it("shows the server's errors", async () => {
    await open();
    await show({ player: player({ error: { key: "yt.private" } }), canModerate: false });
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

  const layOut = () =>
    screen.getAllByRole("listitem").forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 30, height: 30, bottom: index * 30 + 30, left: 0, right: 300, width: 300, x: 0, y: index * 30, toJSON() {} }) as DOMRect;
    });
  const rowTexts = () => screen.getAllByRole("listitem").map((row) => row.textContent);

  it("reorders the queue by dragging an entry by its handle", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b"), entry("c")] }), canModerate: false });
    layOut();
    const grip = screen.getByRole("button", { name: "Move Next a" });
    await act(async () => fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 }));
    await act(async () => fireEvent.pointerMove(grip, { pointerId: 1, clientY: 80 }));
    // while dragging, rows only shift on screen
    const rows = screen.getAllByRole("listitem");
    expect(rowTexts()).toEqual(["1:15Next a", "1:15Next b", "1:15Next c"]);
    expect(rows.map((row) => row.style.transform)).toEqual(["translateY(70px)", "translateY(-30px)", "translateY(-30px)"]);
    await act(async () => fireEvent.pointerUp(grip, { pointerId: 1, clientY: 80 }));
    expect(controls()).toEqual([{ op: "move", id: "a", to: 2 }]);
    // shown at its new place until the server answers, also through other updates
    expect(rowTexts()).toEqual(["1:15Next b", "1:15Next c", "1:15Next a"]);
    await show({ player: player({ now: now({ position: 20 }), queue: [entry("a"), entry("b"), entry("c")] }), canModerate: false });
    expect(rowTexts()).toEqual(["1:15Next b", "1:15Next c", "1:15Next a"]);
    await show({ player: player({ now: now(), queue: [entry("b"), entry("c"), entry("a")] }), canModerate: false });
    expect(rowTexts()).toEqual(["1:15Next b", "1:15Next c", "1:15Next a"]);
    expect(screen.getAllByRole("listitem").every((row) => !row.style.transform)).toBe(true);
  });

  it("gives up a drag when the queue changes under it", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b"), entry("c")] }), canModerate: false });
    layOut();
    const grip = screen.getByRole("button", { name: "Move Next c" });
    await act(async () => fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 70 }));
    await act(async () => fireEvent.pointerMove(grip, { pointerId: 1, clientY: 5 }));
    // the first video started playing
    await show({ player: player({ now: now(), queue: [entry("b"), entry("c")] }), canModerate: false });
    expect(screen.getAllByRole("listitem").every((row) => !row.style.transform)).toBe(true);
    await act(async () => fireEvent.pointerUp(grip, { pointerId: 1, clientY: 5 }));
    expect(controls()).toEqual([]);
    expect(rowTexts()).toEqual(["1:15Next b", "1:15Next c"]);
  });

  it("moves an entry one step with the arrow keys, keeping the focus on it", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b"), entry("c")] }), canModerate: false });
    await act(async () => fireEvent.keyDown(screen.getByRole("button", { name: "Move Next a" }), { key: "ArrowUp" }));
    expect(controls()).toEqual([]);
    const grip = screen.getByRole("button", { name: "Move Next a" });
    grip.focus();
    await act(async () => fireEvent.keyDown(grip, { key: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }));
    expect(controls()).toEqual([
      { op: "move", id: "a", to: 1 },
      { op: "move", id: "a", to: 2 },
    ]);
    expect(rowTexts()).toEqual(["1:15Next b", "1:15Next c", "1:15Next a"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Next a" }));
  });

  it("clears the queue", async () => {
    await open();
    await show({ player: player({ now: now(), queue: [entry("a"), entry("b")] }), canModerate: false });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear the queue" })));
    expect(controls()).toEqual([{ op: "clear" }]);
  });

  it("shows a playlist being looked up, and what is downloaded", async () => {
    await open();
    await show({ player: player({ now: now({ progress: 0.4 }), queue: [entry("p", { playlist: true, state: "resolving" })] }), canModerate: false });
    expect(screen.getAllByRole("listitem")[0]!.textContent).toBe("Playlist");
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
    const buffered = [...document.querySelectorAll<HTMLElement>("[role=dialog] div")].find((element) => element.className === cls.sliderBuffered);
    expect(buffered?.style.width).toBe("40%");
  });

  it("speaks German or Polish when the browser does", async () => {
    const languages = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "languages");
    Object.defineProperty(navigator, "languages", { value: ["de-AT", "en"], configurable: true });
    try {
      await open("Zusammen schauen");
      expect(screen.getByRole("textbox", { name: "YouTube-Link oder Suche" })).toBeDefined();
      await show({ player: player({ error: { key: "error.tooLong", params: { minutes: 90 } } }), canModerate: false });
      expect(screen.getByRole("alert").textContent).toBe("Videos dürfen höchstens 90 Minuten lang sein");
      Object.defineProperty(navigator, "languages", { value: ["pl"], configurable: true });
      await show({ player: player({ error: { key: "yt.private" } }), canModerate: false });
      expect(screen.getByRole("alert").textContent).toBe("Ten film jest prywatny");
    } finally {
      delete (navigator as unknown as Record<string, unknown>).languages;
      if (languages && !("languages" in navigator)) Object.defineProperty(navigator, "languages", languages);
    }
  });

  it("keeps an unexpected error vague", async () => {
    await open();
    failNext = "socket hang up";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong");
  });

  it("ignores pushes for other channels", async () => {
    await open();
    await act(async () => push(player({ channelId: 99, now: now() })));
    expect(screen.queryByText("Big Buck Bunny")).toBeNull();
  });

  it("uses only Sharkord's classes", async () => {
    await open();
    await show({ player: player({ now: now({ progress: 0.5 }), queue: [entry("a"), entry("b", { state: "resolving" }), entry("p", { playlist: true, state: "resolving" })], locked: true, error: { key: "yt.private" } }), canModerate: true });
    const known = new Set(Object.values(cls).flatMap((value) => value.split(" ")));
    const used = new Set<string>();
    for (const element of [screen.getByRole("button", { name: "Watch together" }), ...document.querySelectorAll("[role=dialog] *, [role=dialog]")]) {
      for (const name of element.getAttribute("class")?.split(/\s+/) ?? []) if (name && !name.startsWith("lucide")) used.add(name);
    }
    expect([...used].filter((name) => !known.has(name))).toEqual([]);
  });
});
