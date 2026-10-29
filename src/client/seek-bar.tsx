/**
 * Sharkord's slider, rebuilt without Radix: drag or click to seek, arrow keys
 * step 5 seconds. Pointing at it shows the time (and chapter) a click goes
 * to; dragging shows where the video will go, and seeks only when let go.
 * Chapters are gaps in the track, as on YouTube.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TChapter } from "../contract";
import { cls } from "./classes";
import { formatTime } from "./format";
import { t } from "./text";

type TSeekBarProps = {
  position: number;
  duration: number;
  /** how much is downloaded, 0..1, while it downloads */
  buffered: number | null;
  chapters: TChapter[];
  disabled: boolean;
  onSeek(position: number): void;
};

const THUMB_PX = 16;

/** the chapter `time` is in */
export const chapterAt = (chapters: TChapter[], time: number): TChapter | null => {
  let found: TChapter | null = null;
  for (const chapter of chapters) {
    if (chapter.start > time) break;
    found = chapter;
  }
  return found;
};

const percentOf = (time: number, duration: number) => (duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0);

export const SeekBar = ({ position, duration, buffered, chapters, disabled, onSeek }: TSeekBarProps) => {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** the time under the mouse, while it is over the bar */
  const [hover, setHover] = useState<number | null>(null);
  const value = dragging ?? position;
  const percent = percentOf(value, duration);

  const at = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return value;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(at(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging !== null) setDragging(at(event.clientX));
    else if (event.pointerType === "mouse") setHover(at(event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    setDragging(null);
    onSeek(at(event.clientX));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[event.key];
    const target = event.key === "Home" ? 0 : event.key === "End" ? duration - 1 : step === undefined ? null : value + step;
    if (target === null) return;
    event.preventDefault();
    onSeek(Math.min(Math.max(0, target), Math.max(0, duration - 1)));
  };

  const preview = dragging ?? hover;
  const previewChapter = preview === null ? null : chapterAt(chapters, preview);
  const previewPercent = preview === null ? 0 : percentOf(preview, duration);

  return (
    <div
      className={disabled ? cls.slider : cls.sliderEnabled}
      data-orientation="horizontal"
      data-disabled={disabled ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragging(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div ref={track} className={cls.sliderTrack} data-orientation="horizontal">
        {buffered !== null && <div className={cls.sliderBuffered} style={{ left: 0, width: `${Math.min(100, buffered * 100)}%` }} />}
        <div className={cls.sliderRange} data-orientation="horizontal" style={{ left: 0, width: `${percent}%` }} />
        {chapters.slice(1).map((chapter) => (
          <div key={chapter.start} className={cls.chapterGap} style={{ left: `${percentOf(chapter.start, duration)}%`, width: 2, transform: "translateX(-1px)" }} />
        ))}
      </div>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("ui.position")}
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(value)}
        aria-valuetext={formatTime(value)}
        aria-disabled={disabled || undefined}
        className={cls.sliderThumb}
        // kept inside the track at both ends, as Radix does
        style={{ left: `calc(${percent}% - ${(percent / 100) * THUMB_PX}px)` }}
        onKeyDown={onKeyDown}
      />
      {preview !== null && (
        <div
          role="tooltip"
          className={cls.seekPreview}
          // over the pointer, and shifted along so it never leaves the bar at either end
          style={{ left: `${previewPercent}%`, bottom: "calc(100% + 2px)", transform: `translateX(-${previewPercent}%)` }}
        >
          <span className={cls.seekPreviewTime}>{formatTime(preview)}</span>
          {previewChapter?.title && <span className={cls.seekPreviewChapter}>{previewChapter.title}</span>}
        </div>
      )}
    </div>
  );
};
