import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface SplitterProps {
  /** Accessible name, e.g. "Resize the files panel". */
  label: string;
  testId: string;
  /** Current value in the splitter's own unit (px or a fraction); clamped by the owner. */
  value: number;
  /** Shown to assistive technology as aria-valuenow/min/max (e.g. px, or percent). */
  aria: { readonly now: number; readonly min: number; readonly max: number; readonly text: string };
  /** One keyboard step (←/→); Shift multiplies by 4. */
  step: number;
  /** The value after dragging `dx` CSS pixels from `start`. */
  dragValue(start: number, dx: number): number;
  onChange(value: number): void;
}

/**
 * A vertical splitter between two workbench panels (S13.4 layout sizes): a focusable WAI-ARIA window splitter.
 * Drag with the mouse or pen, or focus it and use ←/→ (Shift for bigger steps); Home/End go to the limits.
 */
export function Splitter({ label, testId, value, aria, step, dragValue, onChange }: SplitterProps) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startValue: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current) onChange(dragValue(current.startValue, event.clientX - current.startX));
  };
  // S15.1: the release position is applied too. Move events can be coalesced or still queued when the button is
  // released, and without this the divider stopped short of where it was let go (the persisted size was then off).
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (current && event.type === 'pointerup') onChange(dragValue(current.startValue, event.clientX - current.startX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const big = event.shiftKey ? 4 : 1;
    const next = {
      ArrowLeft: value - step * big,
      ArrowRight: value + step * big,
      Home: -Infinity,
      End: Infinity,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={aria.now}
      aria-valuemin={aria.min}
      aria-valuemax={aria.max}
      aria-valuetext={aria.text}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
