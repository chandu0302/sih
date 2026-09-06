/**
 * SIH 26171 — coordinate normalization.
 *
 * THE ONE RULE: no module outside this file may convert between coordinate
 * spaces. Every box that reaches the redaction engine passes through here.
 *
 * Three spaces exist in this system:
 *
 *   1. CSS PIXELS (page-relative)
 *      What getBoundingClientRect() returns. Full-page capture (below) never
 *      actually scrolls the page — CDP renders content beyond the viewport
 *      in place — so a rect read at any time during one capture is already
 *      relative to the same fixed (scrollY=0) origin the captured image
 *      uses. No separate "page-relative" transform is needed for that
 *      reason alone; CSS pixels ARE page-relative for the duration of a
 *      capture, by construction.
 *
 *   2. IMAGE PIXELS
 *      The coordinate system of the PNG from CDP's Page.captureScreenshot
 *      (captureBeyondViewport: true) — the ENTIRE scrollable page in one
 *      image, not just the viewport. Larger than CSS pixels on HiDPI
 *      displays. This is the canonical space: redaction, face detection, and
 *      the manifest all live here.
 *
 *   3. DISPLAY PIXELS
 *      The screenshot as rendered in the side panel, usually downscaled to
 *      fit a ~380px column. Only used for drawing overlays.
 *
 * WHY WE DO NOT USE devicePixelRatio TO SCALE
 * The obvious implementation is `imageX = cssX * devicePixelRatio`. It is
 * wrong in practice:
 *   - Browser zoom changes the CSS-to-image ratio without changing DPR in
 *     the way you would expect.
 *   - Fractional DPR (1.25, 1.5 on Windows scaling) accumulates rounding
 *     error across a 1900px viewport — tens of pixels by the right edge.
 *   - Chrome may cap or resize the captured image independently of DPR.
 *
 * Instead we DERIVE the scale empirically from the image that actually came
 * back. The image is ground truth; DPR is a hint we record for diagnostics.
 *
 * WHY THERE IS NO SCROLL TERM
 * getBoundingClientRect() is viewport-relative, and full-page capture never
 * scrolls (see space 1 above) — so viewport-relative and page-relative
 * coincide for the whole capture. Adding a scroll term would be the classic
 * bug this reasoning exists to prevent, not a missing feature.
 */

import type { DomRect2D, ImageBox, DriftReport, ViewportContext } from '../types';

/**
 * The empirically derived relationship between CSS pixels and image pixels
 * for one specific capture. Build it once per capture, pass it everywhere.
 */
export interface CoordinateFrame {
  scaleX: number;
  scaleY: number;
  imageWidth: number;
  imageHeight: number;
  /** Recorded for the metrics panel, never used in arithmetic. */
  reportedDpr: number;
  /**
   * scaleX / scaleY. Should be ~1.0. A meaningful deviation means the
   * capture was resized non-uniformly and boxes will be subtly wrong.
   */
  anisotropy: number;
  /** Diagnostic label for the metrics panel — how this frame's scale was
   *  derived. See createFullPageFrame's doc for what the values mean. */
  basis: string;
}

/**
 * Build the frame for a full-page capture. Unlike the old viewport-only
 * design (which had to guess between two ambiguous viewport-width
 * candidates — see git history — because captureVisibleTab never told you
 * which one it captured), CDP's Page.getLayoutMetrics() gives an
 * unambiguous CSS-pixel page size directly, and the capture was explicitly
 * requested at `clip: {width: pageWidth, height: pageHeight}` — so scale is
 * derived directly per axis, no candidate search needed.
 *
 * Two call shapes, both legitimate:
 *   - IDENTITY (scale exactly 1): pass pageWidth/pageHeight as BOTH the page
 *     size AND the image size (imageWidth===pageWidth). Used before any
 *     screenshot exists yet, purely to place pre-capture DOM masks in the
 *     same page-relative space the eventual image will use.
 *   - REAL: pass the ACTUAL decoded image dimensions (img.naturalWidth /
 *     naturalHeight) once the CDP screenshot has come back.
 *
 * `anisotropy` is still computed and still worth watching in the metrics
 * panel: this file no longer needs it to CHOOSE a candidate, but a
 * meaningful deviation from 1.0 still means something about the capture
 * resized non-uniformly and boxes are suspect.
 */
export function createFullPageFrame(
  pageWidth: number,
  pageHeight: number,
  imageWidth: number,
  imageHeight: number,
  dpr: number,
): CoordinateFrame {
  if (!(pageWidth > 0) || !(pageHeight > 0)) {
    throw new Error('Invalid page dimensions; cannot derive coordinate scale.');
  }
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error('Invalid image dimensions; capture may have failed.');
  }

  const scaleX = imageWidth / pageWidth;
  const scaleY = imageHeight / pageHeight;

  return {
    scaleX,
    scaleY,
    imageWidth,
    imageHeight,
    reportedDpr: dpr,
    anisotropy: scaleX / scaleY,
    basis: imageWidth === pageWidth && imageHeight === pageHeight ? 'identity' : 'page/cdp-image',
  };
}

/**
 * CSS pixels -> image pixels. The transform used by the DOM detection track.
 *
 * Coordinates are rounded outward (floor the origin, ceil the far edge) so a
 * redaction box never lands a fraction of a pixel INSIDE the text it is meant
 * to cover. Under-covering leaks PII; over-covering by one pixel costs
 * nothing. Redaction precision is 20% of the score — bias toward coverage.
 */
export function domRectToImageBox(rect: DomRect2D, frame: CoordinateFrame): ImageBox {
  const x0 = Math.floor(rect.left * frame.scaleX);
  const y0 = Math.floor(rect.top * frame.scaleY);
  const x1 = Math.ceil((rect.left + rect.width) * frame.scaleX);
  const y1 = Math.ceil((rect.top + rect.height) * frame.scaleY);

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Image pixels -> CSS pixels, for ONE point — the inverse of
 * domRectToImageBox, needed by Phase 5's action executor to turn a VLM's
 * click target (image-pixel space, from the sanitized screenshot) back into
 * a real point on the live page.
 *
 * No outward-rounding bias here: that bias exists in domRectToImageBox to
 * over-cover for redaction (under-covering leaks PII), which does not apply
 * to picking a single click point — a plain round is the honest center.
 */
export function imagePointToCssPoint(
  point: { x: number; y: number },
  frame: CoordinateFrame,
): { left: number; top: number } {
  return {
    left: Math.round(point.x / frame.scaleX),
    top: Math.round(point.y / frame.scaleY),
  };
}

/**
 * PHASE 2 STUB — model output -> image pixels.
 *
 * YOLO-family detectors take a square letterboxed input (e.g. 640x640): the
 * image is scaled to fit and padded with grey bars. Boxes come back in that
 * padded space, so we must subtract the padding before undoing the scale.
 * Forgetting the padding offset is the single most common face-detection
 * alignment bug.
 *
 * Signature is fixed now so Phase 2 slots in without touching callers.
 */
export function modelBoxToImageBox(
  box: ImageBox,
  letterbox: { padX: number; padY: number; scale: number },
): ImageBox {
  const x = (box.x - letterbox.padX) / letterbox.scale;
  const y = (box.y - letterbox.padY) / letterbox.scale;
  const w = box.w / letterbox.scale;
  const h = box.h / letterbox.scale;

  return {
    x: Math.floor(x),
    y: Math.floor(y),
    w: Math.ceil(w),
    h: Math.ceil(h),
  };
}

/**
 * Image pixels -> display pixels, for drawing overlays on the downscaled
 * screenshot in the side panel. `displayScale` is
 * img.clientWidth / img.naturalWidth.
 */
export function imageBoxToCssBox(
  box: ImageBox,
  displayScale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: box.x * displayScale,
    top: box.y * displayScale,
    width: box.w * displayScale,
    height: box.h * displayScale,
  };
}

/**
 * Clip a box to the image bounds. Elements straddling the viewport edge
 * produce boxes with negative origins or edges past the image; feeding those
 * to canvas operations silently does nothing on some browsers.
 *
 * Returns null if the box lies entirely outside the image.
 */
export function clampToImage(box: ImageBox, frame: CoordinateFrame): ImageBox | null {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(frame.imageWidth, box.x + box.w);
  const y1 = Math.min(frame.imageHeight, box.y + box.h);

  if (x1 <= x0 || y1 <= y0) return null;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Intersection over Union. Phase 2's box merger dedupes across the three
 * detection tracks with this. Defined here because it operates on ImageBox
 * and belongs with the geometry.
 */
export function iou(a: ImageBox, b: ImageBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);

  if (x1 <= x0 || y1 <= y0) return 0;

  const intersection = (x1 - x0) * (y1 - y0);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Compare the viewport state read at snapshot time with a probe taken after
 * the screenshot. Any difference means the DOM boxes and the pixels describe
 * different page states.
 *
 * Returns null when the capture is clean.
 */
export function detectDrift(
  atSnapshot: ViewportContext,
  afterCapture: ViewportContext,
): DriftReport | null {
  const scrollXDelta = afterCapture.scrollX - atSnapshot.scrollX;
  const scrollYDelta = afterCapture.scrollY - atSnapshot.scrollY;
  const urlChanged = afterCapture.url !== atSnapshot.url;

  if (scrollXDelta === 0 && scrollYDelta === 0 && !urlChanged) return null;

  return { scrollXDelta, scrollYDelta, urlChanged };
}
