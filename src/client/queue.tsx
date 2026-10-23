/**
 * What plays next. Entries are dragged by their handle to a new place, or moved
 * one step with the arrow keys while the handle has focus.
 *
 * While dragging, the rows only shift on screen and stay where they are in the
 * page: a row moved in the page would lose the pointer, and keyboard focus.
 */
import { GripVertical, ListX, LoaderCircle, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { TControl, TQueueEntry } from "../contract";
import { cls } from "./classes";
import { formatTime } from "./format";
import { t } from "./text";

type TDrag = {
  id: string;
  /** the order shown when the drag began; any change to it ends the drag */
  order: string;
  from: number;
  to: number;
  startY: number;
  y: number;
  /** from one row to the next */
  step: number;
  /** middles of the other rows; where the pointer is among them gives `to` */
  middles: number[];
};

/** gives up waiting for the server to show a move after this long */
const SETTLE_MS = 3_000;

const moved = <T,>(items: T[], from: number, to: number): T[] => {
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item!);
  return result;
};

const idsOf = (entries: TQueueEntry[]) => entries.map((entry) => entry.id);
const videosOf = (entries: TQueueEntry[]) => entries.filter((entry) => !entry.playlist);

/** the queue in `order` (video ids), while the server has not caught up with a move */
const ordered = (queue: TQueueEntry[], order: string[] | null): TQueueEntry[] => {
  if (!order) return queue;
  const byId = new Map(queue.map((entry) => [entry.id, entry]));
  return [...order.flatMap((id) => byId.get(id) ?? []), ...queue.filter((entry) => entry.playlist)];
};

const titleOf = (entry: TQueueEntry) => (entry.playlist ? t("ui.playlist") : entry.title);

const meta = (entry: TQueueEntry): ReactNode => {
  if (entry.state === "resolving") return <LoaderCircle className={cls.spinner} role="img" aria-label={t("ui.loading")} />;
  if (entry.progress !== null) return `${Math.round(entry.progress * 100)}%`;
  return entry.live ? t("ui.live") : formatTime(entry.duration);
};

export const Queue = (props: { queue: TQueueEntry[]; canControl: boolean; send(op: TControl): void }) => {
  const { queue, canControl, send } = props;
  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<TDrag | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const focusAfter = useRef<string | null>(null);

  // the server's order replaces ours once it matches, or once other videos come or go
  const serverOrder = idsOf(videosOf(queue)).join(" ");
  useEffect(() => {
    setOrder((current) => {
      if (!current) return current;
      const ids = serverOrder ? serverOrder.split(" ") : [];
      const sameVideos = ids.length === current.length && ids.every((id) => current.includes(id));
      return sameVideos && ids.join(" ") !== current.join(" ") ? current : null;
    });
  }, [serverOrder]);
  useEffect(() => {
    if (!order) return;
    const timer = setTimeout(() => setOrder(null), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [order]);

  // a moved row keeps the keyboard focus
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    [...(list.current?.querySelectorAll<HTMLElement>("[data-grip]") ?? [])].find((grip) => grip.dataset.grip === id)?.focus();
  });

  const shown = ordered(queue, order);
  // only real videos move; playlists still being looked up stay at the end
  const movable = videosOf(shown).length;
  const shownOrder = idsOf(shown).join(" ");
  const active = drag && canControl && drag.order === shownOrder ? drag : null;

  const reorder = (id: string, from: number, to: number) => {
    setOrder(moved(idsOf(videosOf(shown)), from, to));
    send({ op: "move", id, to });
  };

  const begin = (event: PointerEvent<HTMLButtonElement>, entry: TQueueEntry, from: number) => {
    if (event.button !== 0 || !list.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rects = [...list.current.querySelectorAll<HTMLElement>("[data-row]")].map((row) => row.getBoundingClientRect());
    const middles = rects
      .slice(0, movable)
      .filter((_, index) => index !== from)
      .map((rect) => rect.top + rect.height / 2);
    const step = rects.length > 1 ? rects[1]!.top - rects[0]!.top : (rects[from]?.height ?? 0);
    setDrag({ id: entry.id, order: shownOrder, from, to: from, startY: event.clientY, y: event.clientY, step, middles });
  };

  const follow = (event: PointerEvent<HTMLButtonElement>) => {
    if (!active) return;
    setDrag({ ...active, y: event.clientY, to: active.middles.filter((middle) => middle < event.clientY).length });
  };

  const drop = () => {
    setDrag(null);
    if (active && active.to !== active.from) reorder(active.id, active.from, active.to);
  };

  const step = (event: KeyboardEvent<HTMLButtonElement>, entry: TQueueEntry, index: number) => {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (active || to < 0 || to >= movable) return;
    focusAfter.current = entry.id;
    reorder(entry.id, index, to);
  };

  /** where a row is drawn while dragging: the dragged one under the pointer, the ones it passed one row over */
  const shift = (index: number): CSSProperties | undefined => {
    if (!active) return undefined;
    if (index === active.from) return { transform: `translateY(${active.y - active.startY}px)`, position: "relative", zIndex: 1 };
    const by = active.from < index && index <= active.to ? -active.step : active.to <= index && index < active.from ? active.step : 0;
    return by ? { transform: `translateY(${by}px)` } : undefined;
  };

  return (
    <>
      <ul ref={list} className={cls.queue}>
        {shown.map((entry, index) => (
          <li key={entry.id} data-row className={active?.id === entry.id ? cls.queueRowDragging : cls.queueRow} style={shift(index)}>
            {canControl && !entry.playlist && (
              <button
                type="button"
                data-grip={entry.id}
                className={cls.grip}
                title={t("ui.move", { title: titleOf(entry) })}
                aria-label={t("ui.move", { title: titleOf(entry) })}
                onPointerDown={(event) => begin(event, entry, index)}
                onPointerMove={follow}
                onPointerUp={drop}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(event) => step(event, entry, index)}
              >
                <GripVertical />
              </button>
            )}
            <span className={cls.queueMeta}>{meta(entry)}</span>
            <span className={cls.queueTitle} title={titleOf(entry)}>
              {titleOf(entry)}
            </span>
            {canControl && (
              <button
                type="button"
                className={cls.smallIconButton}
                title={t("ui.remove", { title: titleOf(entry) })}
                aria-label={t("ui.remove", { title: titleOf(entry) })}
                onClick={() => send({ op: "remove", id: entry.id })}
              >
                <X />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canControl && queue.length > 1 && (
        <div className={cls.queueFooter}>
          <button type="button" className={cls.smallIconButton} title={t("ui.clear")} aria-label={t("ui.clear")} onClick={() => send({ op: "clear" })}>
            <ListX />
          </button>
        </div>
      )}
    </>
  );
};
