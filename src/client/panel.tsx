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

type TPlace = { left: number; bottom: number; maxHeight: number };

/** above the button, inside the window */
const placeAbove = (anchor: HTMLElement | null): TPlace => {
  const rect = anchor?.getBoundingClientRect();
  const left = rect?.left ?? GAP;
  const top = rect?.top ?? window.innerHeight - GAP;
  return {
    left: Math.max(GAP, Math.min(left, window.innerWidth - WIDTH - GAP)),
    bottom: window.innerHeight - top + GAP,
    maxHeight: Math.max(160, top - 2 * GAP),
  };
};

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
        <span className={cls.lockedMark} title="Only moderators can control this right now" aria-label="Locked">
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
        <LoaderCircle className={cls.spinner} aria-label="Loading" />
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
  if (entry.state === "resolving") return <LoaderCircle className={cls.spinner} aria-label="Loading" />;
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
          <button type="button" className={cls.smallIconButton} title="Remove" aria-label="Remove" onClick={send({ op: "remove", id: entry.id })}>
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
  const [place, setPlace] = useState<TPlace>(() => placeAbove(anchor.current));

  useLayoutEffect(() => {
    const update = () => setPlace(placeAbove(anchor.current));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor]);

  useEffect(() => {
    void refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
      data-side="top"
      className={cls.panel}
      style={{ left: place.left, bottom: place.bottom, maxHeight: place.maxHeight }}
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
