/** Sharkord's slider, rebuilt without Radix: drag or click to seek, arrow keys step 5 seconds. */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cls } from "./classes";
import { formatTime } from "./format";

type TSeekBarProps = {
  position: number;
  duration: number;
  disabled: boolean;
  onSeek(position: number): void;
};

const THUMB_PX = 16;

export const SeekBar = ({ position, duration, disabled, onSeek }: TSeekBarProps) => {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? position;
  const percent = duration > 0 ? Math.min(100, Math.max(0, (value / duration) * 100)) : 0;

  const at = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return value;
    return (Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(at(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging !== null) setDragging(at(event.clientX));
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

  return (
    <div
      className={cls.slider}
      data-orientation="horizontal"
      data-disabled={disabled ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragging(null)}
    >
      <div ref={track} className={cls.sliderTrack} data-orientation="horizontal">
        <div className={cls.sliderRange} data-orientation="horizontal" style={{ left: 0, width: `${percent}%` }} />
      </div>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Position"
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
    </div>
  );
};
