import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { beginDrag, cancelDrag, endDrag, moveDrag, type DragState } from './splitter-model';

/** S49.1: where a pointer press on the divider is: none, pressed (inside the dead zone) or dragging. */
export type SplitterPhase = 'idle' | 'pressed' | 'dragging';

interface SplitterProps {
  /** Accessible name, e.g. "Resize the files panel". */
  label: string;
  testId: string;
  /** Current value in the splitter's own unit (px or a fraction); clamped by the owner. */
  value: number;
  /** Shown to assistive technology as aria-valuenow/min/max (e.g. px, or percent); `text` is in words. */
  aria: { readonly now: number; readonly min: number; readonly max: number; readonly text: string };
  /** One keyboard step (←/→); Shift multiplies by 4. */
  step: number;
  /** The value after dragging `dx` CSS pixels from `start` (unclamped: the owner decides what it means). */
  dragValue(start: number, dx: number): number;
  /** Keyboard changes, and drags when `onDrag` is absent. */
  onChange(value: number): void;
  /** S49.1: a value from a mouse or pen drag (also the start value again on Escape). */
  onDrag?(value: number, start: number): void;
  /** S49.1: double-click goes back to the default size. */
  onReset?(): void;
  /** S49.1: the press went down, became a drag (past the dead zone), or ended. */
  onPhase?(phase: SplitterPhase): void;
}

/**
 * A vertical splitter between two workbench panels (S13.4 layout sizes): a focusable WAI-ARIA window splitter.
 * Drag with the mouse or pen, or focus it and use ←/→ (Shift for bigger steps); Home/End go to the limits.
 * S49.1: a drag starts after 4 px of movement (a click does nothing), Escape during a drag restores the start value,
 * and a double-click resets the default size (rules in splitter-model.ts).
 */
export function Splitter({
  label,
  testId,
  value,
  aria,
  step,
  dragValue,
  onChange,
  onDrag,
  onReset,
  onPhase,
}: SplitterProps) {
  const drag = useRef<{ state: DragState; pointerId: number; element: HTMLDivElement } | null>(null);
  // The latest callbacks for the window-level Escape listener, which outlives a render.
  const latest = useRef({ onChange, onDrag, onPhase });
  latest.current = { onChange, onDrag, onPhase };
  const applyDrag = (next: number, start: number) => (onDrag ? onDrag(next, start) : onChange(next));

  const stopListening = useRef<(() => void) | null>(null);
  const finish = () => {
    drag.current = null;
    stopListening.current?.();
    stopListening.current = null;
    latest.current.onPhase?.('idle');
  };
  useEffect(
    () => () => {
      // Unmounted mid-press: nothing else will end it.
      if (drag.current) finish();
    },
    [],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = { state: beginDrag(event.clientX, value), pointerId: event.pointerId, element };
    // Escape works wherever the keyboard focus is (the press does not move it); capture phase, before the editor.
    const onKey = (key: globalThis.KeyboardEvent) => {
      const current = drag.current;
      if (key.key !== 'Escape' || !current) return;
      key.preventDefault();
      key.stopPropagation();
      const back = cancelDrag(current.state);
      if (current.element.hasPointerCapture(current.pointerId))
        current.element.releasePointerCapture(current.pointerId);
      if (back !== null) {
        const { onDrag: drop, onChange: change } = latest.current;
        if (drop) drop(back, current.state.startValue);
        else change(back);
      }
      finish();
    };
    window.addEventListener('keydown', onKey, true);
    stopListening.current = () => window.removeEventListener('keydown', onKey, true);
    onPhase?.('pressed');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const moved = moveDrag(current.state, event.clientX, dragValue);
    current.state = moved.state;
    if (moved.started) onPhase?.('dragging');
    if (moved.value !== null) applyDrag(moved.value, current.state.startValue);
  };
  // S15.1: the release position is applied too. Move events can be coalesced or still queued when the button is
  // released, and without this the divider stopped short of where it was let go (the persisted size was then off).
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const released = event.type === 'pointerup' ? endDrag(current.state, event.clientX, dragValue) : null;
    if (released !== null) applyDrag(released, current.state.startValue);
    finish();
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
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
