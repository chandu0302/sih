/**
 * SIH 26171 — Phase 3a: text redact-before-capture.
 *
 * Applies opaque, position:fixed overlay divs at CSS-pixel rects. No text
 * node or attribute is mutated — masking is a pure visual occlusion, so it
 * is trivially revertible and can never corrupt live page state (form
 * values, event listeners, framework-managed DOM).
 *
 * COORDINATE SPACE: callers pass `DetectedBox[]` computed under the
 * pre-capture IDENTITY frame built in App.tsx (scale 1, imageWidth/Height =
 * the live viewport's own CSS dimensions). Under that frame,
 * `imageBox.{x,y,w,h}` is numerically a viewport-relative CSS-pixel rect,
 * already clamped to the viewport by coords.ts's clampToImage — exactly what
 * `position: fixed` needs. This file does no coordinate math of its own; it
 * trusts coords.ts's output like every other detection track does.
 *
 * ORDERING: applyMasks() must run, then captureVisibleTab() must fire, then
 * removeMasks() must run — in that order, with masking staying on screen for
 * the shortest span that still covers the actual pixel capture. See
 * service-worker.ts's runScreenshot() for where removeMasks() is triggered.
 */
import type { DetectedBox } from '../types';

const MASK_ATTR = 'data-sih-mask';

let activeMasks: HTMLElement[] = [];

/** Creates one overlay div per box and appends it to the page. Returns the
 *  count applied (== boxes.length; returned for symmetry with removeMasks). */
export function applyMasks(boxes: DetectedBox[]): number {
  for (const box of boxes) {
    const el = document.createElement('div');
    el.setAttribute(MASK_ATTR, '1');
    el.style.position = 'fixed';
    el.style.left = `${box.imageBox.x}px`;
    el.style.top = `${box.imageBox.y}px`;
    el.style.width = `${box.imageBox.w}px`;
    el.style.height = `${box.imageBox.h}px`;
    el.style.background = '#000';
    el.style.zIndex = '2147483647';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    activeMasks.push(el);
  }
  return boxes.length;
}

/** Removes every overlay created by applyMasks() since the last call to this
 *  function. Idempotent: calling it with nothing active returns 0. */
export function removeMasks(): number {
  const count = activeMasks.length;
  for (const el of activeMasks) el.remove();
  activeMasks = [];
  return count;
}
