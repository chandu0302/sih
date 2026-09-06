/**
 * SIH 26171 — Phase 3a: text redact-before-capture.
 *
 * Applies opaque, position:absolute overlay divs at CSS-pixel rects. No text
 * node or attribute is mutated — masking is a pure visual occlusion, so it
 * is trivially revertible and can never corrupt live page state (form
 * values, event listeners, framework-managed DOM).
 *
 * position:absolute, NOT position:fixed (bug fix — full-page capture):
 * fixed elements are pinned to the VIEWPORT and, under CDP's
 * captureBeyondViewport rendering, only ever appear once near the top of a
 * tall composite instead of following their target down the page — a mask
 * meant for something 3000px down would silently cover nothing. Absolute
 * positioning is relative to the document's initial containing block, which
 * is exactly what a beyond-viewport capture actually composites. Since
 * full-page capture never scrolls (see coords.ts's module doc), viewport-
 * relative and page-relative coordinates coincide throughout one capture —
 * so the same rect values that worked for `fixed` also work for `absolute`,
 * unchanged.
 *
 * COORDINATE SPACE: callers pass `DetectedBox[]` computed under the
 * pre-capture IDENTITY frame built in App.tsx (scale 1, imageWidth/Height =
 * the full page's own CSS dimensions, from coords.ts's createFullPageFrame).
 * Under that frame, `imageBox.{x,y,w,h}` is numerically a page-relative
 * CSS-pixel rect, already clamped by coords.ts's clampToImage. This file
 * does no coordinate math of its own; it trusts coords.ts's output like
 * every other detection track does.
 *
 * ORDERING: applyMasks() must run, then the CDP screenshot must fire, then
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
    el.style.position = 'absolute';
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
