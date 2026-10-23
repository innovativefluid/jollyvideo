/** The popover: add a video, control the one playing, see what is next. */
import { Lock, LockOpen, LoaderCircle, Pause, Play, Plus, SkipForward, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MAX_QUERY_LENGTH, type TControl, type TNowPlaying, type TQueueEntry } from "../contract";
import { cls } from "./classes";
import { formatTime } from "./format";
import { SeekBar } from "./seek-bar";
import { add, control, getView, positionOf, refresh, subscribe } from "./store";

const WIDTH = 320;
const GAP = 8;

const useView = () => useSyncExternalStore(subscribe, getView);

/** re-renders twice a second while `active`, so the position moves */
const useTicking = (active: boolean) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 500);
    return () => clearInterval(timer);
  }, [active]);
};

type TPlace = { side: "top" | "bottom"; left: number; width: number; top?: number; bottom?: number; maxHeight: number };

/** above the button when there is room, below otherwise; never wider than the window */
const place = (anchor: HTMLElement | null): TPlace => {
  const rect = anchor?.getBoundingClientRect() ?? { left: GAP, top: window.innerHeight - GAP, bottom: window.innerHeight - GAP };
  const width = Math.min(WIDTH, window.innerWidth - 2 * GAP);
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - width - GAP));
  const above = rect.top - 2 * GAP;
  const below = window.innerHeight - rect.bottom - 2 * GAP;
  return above >= 240 || above >= below
    ? { side: "top", left, width, bottom: window.innerHeight - rect.top + GAP, maxHeight: above }
    : { side: "bottom", left, width, top: rect.bottom + GAP, maxHeight: below };
};

const samePlace = (a: TPlace, b: TPlace) => a.side === b.side && a.left === b.left && a.width === b.width && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight;

const send = (op: TControl) => () => void control(op);

const IconButton = (props: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) => (
  <button type="button" className={cls.iconButton} title={props.label} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
    {props.children}
  </button>
);

const AddRow = (props: { canControl: boolean; canModerate: boolean; locked: boolean; busy: boolean }) => {
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (query && (await add(query))) setText("");
  };
  const lockLabel = props.locked ? "Unlock" : "Lock";
  return (
    <form className={cls.row} onSubmit={submit}>
      <input
        className={cls.input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="YouTube link or search"
        aria-label="YouTube link or search"
        maxLength={MAX_QUERY_LENGTH}
        spellCheck={false}
        autoFocus
        disabled={!props.canControl}
      />
      <button type="submit" className={cls.iconButton} title="Add" aria-label="Add" disabled={!props.canControl || props.busy || !text.trim()}>
        <Plus />
      </button>
      {props.canModerate ? (
        <button
          type="button"
          className={props.locked ? cls.iconButtonOn : cls.iconButton}
          title={lockLabel}
          aria-label={lockLabel}
          aria-pressed={props.locked}
          disabled={props.busy}
          onClick={send({ op: "lock", locked: !props.locked })}
        >
          {props.locked ? <Lock /> : <LockOpen />}
        </button>
      ) : props.locked ? (
        <span className={cls.lockedMark} role="img" title="Only moderators can control this right now" aria-label="Locked">
          <Lock className={cls.icon} />
        </span>
      ) : null}
    </form>
  );
};

const Status = ({ now, position }: { now: TNowPlaying; position: number }) => {
  if (now.state === "loading") {
    return (
      <span className={cls.row}>
        {now.progress !== null && <span className={cls.meta}>{Math.round(now.progress * 100)}%</span>}
        <LoaderCircle className={cls.spinner} role="img" aria-label="Loading" />
      </span>
    );
  }
  if (now.live) return <span className={cls.liveBadge}>LIVE</span>;
  return <span className={cls.meta}>{`${formatTime(position)} / ${formatTime(now.duration)}`}</span>;
};

const NowPlaying = ({ now, position, canControl }: { now: TNowPlaying; position: number; canControl: boolean }) => (
  <>
    <div className={cls.nowPlaying}>
      {now.thumbnail ? <img src={now.thumbnail} alt="" className={cls.thumbnail} /> : <div className={cls.thumbnail} />}
      <div className={cls.nowText}>
        <p className={cls.title} title={now.title}>
          {now.title}
        </p>
      </div>
    </div>
    {!now.live && now.duration > 0 && (
      <SeekBar position={position} duration={now.duration} disabled={!canControl} onSeek={(at) => void control({ op: "seek", position: Math.floor(at) })} />
    )}
    <div className={cls.controls}>
      {!now.live &&
        (now.state === "paused" ? (
          <IconButton label="Play" disabled={!canControl} onClick={send({ op: "resume" })}>
            <Play />
          </IconButton>
        ) : (
          <IconButton label="Pause" disabled={!canControl || now.state !== "playing"} onClick={send({ op: "pause" })}>
            <Pause />
          </IconButton>
        ))}
      <IconButton label="Skip" disabled={!canControl} onClick={send({ op: "skip" })}>
        <SkipForward />
      </IconButton>
      <IconButton label="Stop" disabled={!canControl} onClick={send({ op: "stop" })}>
        <Square />
      </IconButton>
      <span className={cls.grow} />
      <Status now={now} position={position} />
    </div>
  </>
);

const queueMeta = (entry: TQueueEntry): ReactNode => {
  if (entry.state === "resolving") return <LoaderCircle className={cls.spinner} role="img" aria-label="Loading" />;
  if (entry.progress !== null) return `${Math.round(entry.progress * 100)}%`;
  return entry.live ? "LIVE" : formatTime(entry.duration);
};

const Queue = ({ queue, canControl }: { queue: TQueueEntry[]; canControl: boolean }) => (
  <ul className={cls.queue}>
    {queue.map((entry) => (
      <li key={entry.id} className={cls.queueRow}>
        <span className={cls.queueMeta}>{queueMeta(entry)}</span>
        <span className={cls.queueTitle} title={entry.title}>
          {entry.title}
        </span>
        {canControl && (
          <button type="button" className={cls.smallIconButton} title="Remove" aria-label={`Remove ${entry.title}`} onClick={send({ op: "remove", id: entry.id })}>
            <X />
          </button>
        )}
      </li>
    ))}
  </ul>
);

export const Panel = ({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose(): void }) => {
  const view = useView();
  const panel = useRef<HTMLDivElement>(null);
  const [where, setWhere] = useState<TPlace>(() => place(anchor.current));

  // follows the button when the window or the layout around it changes
  useLayoutEffect(() => {
    const update = () => setWhere((old) => {
      const next = place(anchor.current);
      return samePlace(old, next) ? old : next;
    });
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(document.body);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  useEffect(() => {
    void refresh();
    // Escape belongs to the panel only while focus is in it, not to the chat box
    const onKey = (event: KeyboardEvent) => {
      const focus = document.activeElement;
      if (event.key !== "Escape" || !(panel.current?.contains(focus) || anchor.current === focus)) return;
      onClose();
      anchor.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  const player = view.player;
  const locked = player?.locked ?? false;
  const canControl = !locked || view.canModerate;
  const now = player?.now ?? null;
  useTicking(now?.state === "playing");
  const error = view.failure ?? player?.error ?? null;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Watch together"
      data-state="open"
      data-side={where.side}
      className={cls.panel}
      style={{ left: where.left, width: where.width, top: where.top, bottom: where.bottom, maxHeight: where.maxHeight }}
    >
      <AddRow canControl={canControl} canModerate={view.canModerate} locked={locked} busy={view.busy} />
      {now && <NowPlaying now={now} position={positionOf(view)} canControl={canControl} />}
      {player && player.queue.length > 0 && <Queue queue={player.queue} canControl={canControl} />}
      {error && (
        <p className={cls.error} role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
};
