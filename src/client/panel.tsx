/** The popover: add a video, control the one playing, see what is next. */
import { Captions, Lock, LockOpen, LoaderCircle, Pause, Play, Plus, SkipForward, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MAX_QUERY_LENGTH, type TControl, type TNowPlaying } from "../contract";
import { captionsAt, choose, firstTrack, useCaptionStore, type TCaptionView } from "./captions";
import { cls } from "./classes";
import { formatTime } from "./format";
import { Queue } from "./queue";
import { SeekBar } from "./seek-bar";
import { add, control, getView, positionOf, refresh, subscribe } from "./store";
import { say, t } from "./text";

const WIDTH = 320;
const GAP = 8;

const useView = () => useSyncExternalStore(subscribe, getView);

/** re-renders every `ms` while `active`, so the position moves */
const useTicking = (active: boolean, ms: number) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
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

const send = (op: TControl) => void control(op);

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
  const lockLabel = props.locked ? t("ui.unlock") : t("ui.lock");
  return (
    <form className={cls.row} onSubmit={submit}>
      <input
        className={cls.input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("ui.placeholder")}
        aria-label={t("ui.placeholder")}
        maxLength={MAX_QUERY_LENGTH}
        spellCheck={false}
        autoFocus
        disabled={!props.canControl}
      />
      <button type="submit" className={cls.iconButton} title={t("ui.add")} aria-label={t("ui.add")} disabled={!props.canControl || props.busy || !text.trim()}>
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
          onClick={() => send({ op: "lock", locked: !props.locked })}
        >
          {props.locked ? <Lock /> : <LockOpen />}
        </button>
      ) : props.locked ? (
        <span className={cls.lockedMark} role="img" title={t("error.locked")} aria-label={t("ui.locked")}>
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
        <LoaderCircle className={cls.spinner} role="img" aria-label={t("ui.loading")} />
      </span>
    );
  }
  if (now.live) return <span className={cls.liveBadge}>{t("ui.live")}</span>;
  return <span className={cls.meta}>{`${formatTime(position)} / ${formatTime(now.duration)}`}</span>;
};

/** the video's thumbnail, or an empty frame when there is none or it fails to load */
const Thumbnail = ({ src }: { src: string }) => {
  const [failed, setFailed] = useState<string | null>(null);
  return src && failed !== src ? <img src={src} alt="" className={cls.thumbnail} onError={() => setFailed(src)} /> : <div className={cls.thumbnail} />;
};

/** this viewer's captions on or off */
const CaptionsButton = ({ captions }: { captions: TCaptionView }) => {
  if (!captions.tracks.length) return null;
  const on = captions.track !== null;
  const toggle = () => choose(on ? null : (firstTrack(captions.tracks, navigator.languages ?? [navigator.language])?.id ?? null));
  return (
    <button type="button" className={on ? cls.iconButtonOn : cls.iconButton} title={t("ui.captions")} aria-label={t("ui.captions")} aria-pressed={on} onClick={toggle}>
      <Captions />
    </button>
  );
};

/** the current lines, and the language when there are several */
const CaptionLines = ({ captions }: { captions: TCaptionView }) => {
  if (!captions.track) return null;
  return (
    <>
      <p className={captions.failed ? cls.captionsFailed : cls.captions} aria-live="polite">
        {captions.failed
          ? t("error.captions")
          : (captions.lines.length ? captions.lines : ["\u00a0"]).map((line, index) => (
              <span key={index} className={cls.captionLine}>
                {line}
              </span>
            ))}
      </p>
      {captions.tracks.length > 1 && (
        <div className={cls.queueFooter}>
          <select className={cls.select} aria-label={t("ui.captionsLanguage")} value={captions.track.id} onChange={(event) => choose(event.target.value)}>
            {captions.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
};

const NowPlaying = ({ now, position, canControl, captions }: { now: TNowPlaying; position: number; canControl: boolean; captions: TCaptionView }) => (
  <>
    <div className={cls.nowPlaying}>
      <Thumbnail src={now.thumbnail} />
      <div className={cls.nowText}>
        <p className={cls.title} title={now.title}>
          {now.title}
        </p>
      </div>
    </div>
    {!now.live && now.duration > 0 && (
      <SeekBar
        position={position}
        duration={now.duration}
        buffered={now.progress}
        disabled={!canControl}
        onSeek={(at) => send({ op: "seek", position: Math.floor(at) })}
      />
    )}
    <div className={cls.controls}>
      {!now.live &&
        (now.state === "paused" ? (
          <IconButton label={t("ui.play")} disabled={!canControl} onClick={() => send({ op: "resume" })}>
            <Play />
          </IconButton>
        ) : (
          <IconButton label={t("ui.pause")} disabled={!canControl || now.state !== "playing"} onClick={() => send({ op: "pause" })}>
            <Pause />
          </IconButton>
        ))}
      <IconButton label={t("ui.skip")} disabled={!canControl} onClick={() => send({ op: "skip" })}>
        <SkipForward />
      </IconButton>
      <IconButton label={t("ui.stop")} disabled={!canControl} onClick={() => send({ op: "stop" })}>
        <Square />
      </IconButton>
      <CaptionsButton captions={captions} />
      <span className={cls.grow} />
      <Status now={now} position={position} />
    </div>
    <CaptionLines captions={captions} />
  </>
);

export const Panel = ({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose(): void }) => {
  const view = useView();
  const panel = useRef<HTMLDivElement>(null);
  const [where, setWhere] = useState<TPlace>(() => place(anchor.current));

  // follows the button when the window or the layout around it changes, at most once a frame
  useLayoutEffect(() => {
    const update = () =>
      setWhere((old) => {
        const next = place(anchor.current);
        return samePlace(old, next) ? old : next;
      });
    let frame = 0;
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(document.body);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
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
  useCaptionStore();
  const position = positionOf(view);
  const captions = captionsAt(now, position);
  // captions change more often than the clock
  useTicking(now?.state === "playing", captions.track ? 250 : 1000);
  const error = view.failure ?? player?.error ?? null;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={t("ui.watch")}
      data-state="open"
      data-side={where.side}
      className={cls.panel}
      style={{ left: where.left, width: where.width, top: where.top, bottom: where.bottom, maxHeight: where.maxHeight }}
    >
      <AddRow canControl={canControl} canModerate={view.canModerate} locked={locked} busy={view.busy} />
      {now && <NowPlaying now={now} position={position} canControl={canControl} captions={captions} />}
      {player && player.queue.length > 0 && <Queue queue={player.queue} canControl={canControl} send={send} />}
      {error && (
        <p className={cls.error} role="alert">
          {say(error)}
        </p>
      )}
    </div>,
    document.body,
  );
};
