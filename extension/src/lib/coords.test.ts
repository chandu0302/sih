/**
 * SIH 26171 — coordinate math tests.
 *
 * This is the one module worth testing hard. Every redaction box in Phase 3
 * and every face box in Phase 2 passes through it, and its failure mode is
 * silent: boxes land slightly off, PII stays visible at the edges, and
 * nothing throws. A 20%-weighted criterion fails quietly.
 *
 * Full-page capture (CDP) removed the old scrollbar-candidate ambiguity that
 * createCoordinateFrame used to resolve (captureVisibleTab never told you
 * whether the scrollbar was in the image; CDP's Page.getLayoutMetrics gives
 * an unambiguous CSS page size directly). createFullPageFrame's tests below
 * cover what replaced it: direct per-axis scale from an unambiguous source,
 * still watching anisotropy as a diagnostic even though nothing needs to
 * pick between candidates anymore.
 */

import { describe, expect, it } from 'vitest';
import {
  clampToImage,
  createFullPageFrame,
  detectDrift,
  domRectToImageBox,
  imageBoxToCssBox,
  imagePointToCssPoint,
  iou,
  modelBoxToImageBox,
} from './coords';
import type { ViewportContext } from '../types';

/** For detectDrift's tests only — unrelated to frame-building now. */
function viewport(
  cssWidth: number,
  cssHeight: number,
  opts: { dpr?: number; scrollX?: number; scrollY?: number; url?: string } = {},
): ViewportContext {
  return {
    dpr: opts.dpr ?? 1,
    innerWidth: cssWidth,
    innerHeight: cssHeight,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    scrollX: opts.scrollX ?? 0,
    scrollY: opts.scrollY ?? 0,
    url: opts.url ?? 'https://example.test/page',
  };
}

describe('createFullPageFrame', () => {
  it('derives scale directly from page size vs. image size, no candidate search', () => {
    // 1000x800 CSS page, captured at 2x -> 2000x1600 image.
    const frame = createFullPageFrame(1000, 800, 2000, 1600, 1);
    expect(frame.scaleX).toBeCloseTo(2, 10);
    expect(frame.scaleY).toBeCloseTo(2, 10);
    expect(frame.anisotropy).toBeCloseTo(1, 10);
    expect(frame.basis).toBe('page/cdp-image');
  });

  it('returns an identity frame (scale 1) when image size equals page size', () => {
    const frame = createFullPageFrame(1000, 800, 1000, 800, 1);
    expect(frame.scaleX).toBe(1);
    expect(frame.scaleY).toBe(1);
    expect(frame.basis).toBe('identity');
  });

  it('derives scale from the image even when it disagrees with reported DPR', () => {
    // Browser zoom at 150%: DPR reports 1 but the capture is 1.5x the page.
    const frame = createFullPageFrame(1000, 800, 1500, 1200, 1);
    expect(frame.reportedDpr).toBe(1); // hint only
    expect(frame.scaleX).toBeCloseTo(1.5, 10); // ground truth wins
  });

  it('handles a tall full-page capture (image much taller than wide)', () => {
    // A page 4 viewports tall: 1000x3200 CSS, captured 1x.
    const frame = createFullPageFrame(1000, 3200, 1000, 3200, 1);
    expect(frame.scaleY).toBeCloseTo(1, 10);
    expect(frame.anisotropy).toBeCloseTo(1, 10);
  });

  it('rejects invalid page dimensions', () => {
    expect(() => createFullPageFrame(0, 800, 1000, 800, 1)).toThrow(/Invalid page/);
  });

  it('rejects a failed capture (zero image dimensions) rather than producing silent garbage', () => {
    expect(() => createFullPageFrame(1000, 800, 0, 0, 1)).toThrow(/Invalid image/);
  });
});

describe('domRectToImageBox', () => {
  const frame = createFullPageFrame(1000, 800, 2000, 1600, 1);

  it('scales a rect into image pixels', () => {
    const box = domRectToImageBox({ left: 100, top: 50, width: 200, height: 40 }, frame);
    expect(box).toEqual({ x: 200, y: 100, w: 400, h: 80 });
  });

  it('rounds OUTWARD so a redaction never under-covers its target', () => {
    // Fractional rect: floor the origin, ceil the far edge.
    const box = domRectToImageBox({ left: 10.4, top: 20.6, width: 30.3, height: 15.2 }, frame);

    expect(box.x).toBeLessThanOrEqual(10.4 * frame.scaleX);
    expect(box.y).toBeLessThanOrEqual(20.6 * frame.scaleY);
    expect(box.x + box.w).toBeGreaterThanOrEqual((10.4 + 30.3) * frame.scaleX);
    expect(box.y + box.h).toBeGreaterThanOrEqual((20.6 + 15.2) * frame.scaleY);
  });

  it('does NOT add a scroll offset — full-page capture never scrolls, so rects and the image already share one origin', () => {
    // A box far down a full-page capture (e.g. y=4000) must land exactly
    // where its rect says — no scrollY term to accidentally add.
    const tall = createFullPageFrame(1000, 5000, 1000, 5000, 1);
    const box = domRectToImageBox({ left: 0, top: 4000, width: 50, height: 20 }, tall);
    expect(box.y).toBe(4000);
  });
});

describe('imagePointToCssPoint — the inverse of domRectToImageBox', () => {
  const frame = createFullPageFrame(1000, 800, 2000, 1600, 1);

  it('scales an image point back down to CSS pixels', () => {
    const point = imagePointToCssPoint({ x: 400, y: 200 }, frame);
    expect(point).toEqual({ left: 200, top: 100 });
  });

  it('round-trips a domRectToImageBox origin back to (approximately) the original CSS point', () => {
    const cssRect = { left: 123, top: 45, width: 10, height: 10 };
    const imageBox = domRectToImageBox(cssRect, frame);
    const back = imagePointToCssPoint({ x: imageBox.x, y: imageBox.y }, frame);

    // domRectToImageBox floors the origin outward; the round trip should
    // land within one CSS pixel of the original, not drift arbitrarily.
    expect(Math.abs(back.left - cssRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.top - cssRect.top)).toBeLessThanOrEqual(1);
  });

  it('has no scroll term, same as domRectToImageBox', () => {
    const tall = createFullPageFrame(1000, 5000, 1000, 5000, 1);
    const point = imagePointToCssPoint({ x: 10, y: 4020 }, tall);
    expect(point).toEqual({ left: 10, top: 4020 });
  });
});

describe('clampToImage', () => {
  const frame = createFullPageFrame(1000, 800, 1000, 800, 1);

  it('clips a box straddling the top-left edge', () => {
    const clipped = clampToImage({ x: -20, y: -10, w: 100, h: 50 }, frame);
    expect(clipped).toEqual({ x: 0, y: 0, w: 80, h: 40 });
  });

  it('clips a box overflowing the bottom-right edge', () => {
    const clipped = clampToImage({ x: 950, y: 780, w: 100, h: 50 }, frame);
    expect(clipped).toEqual({ x: 950, y: 780, w: 50, h: 20 });
  });

  it('returns null for a box entirely outside the image', () => {
    expect(clampToImage({ x: 2000, y: 50, w: 100, h: 50 }, frame)).toBeNull();
  });

  it('retains a box far down a tall full-page frame instead of dropping it as off-viewport', () => {
    // This is the whole point of full-page capture: a box at y=4500 on a
    // 5000-tall page must survive clamping, not get treated as "outside the
    // viewport" the way it would have against the old viewport-only frame.
    const tall = createFullPageFrame(1000, 5000, 1000, 5000, 1);
    const box = clampToImage({ x: 100, y: 4500, w: 50, h: 30 }, tall);
    expect(box).toEqual({ x: 100, y: 4500, w: 50, h: 30 });
  });
});

describe('modelBoxToImageBox — letterbox inversion', () => {
  it('undoes YOLO letterbox padding and scaling', () => {
    // 1000x500 image -> 640x640 input: scale 0.64, padY = (640 - 320)/2 = 160.
    const letterbox = { padX: 0, padY: 160, scale: 0.64 };
    const box = modelBoxToImageBox({ x: 64, y: 224, w: 128, h: 64 }, letterbox);

    expect(box.x).toBe(100);
    expect(box.y).toBe(100);
    expect(box.w).toBe(200);
    expect(box.h).toBe(100);
  });

  it('forgetting padding would misplace the box — the bug this prevents', () => {
    const letterbox = { padX: 0, padY: 160, scale: 0.64 };
    const withPad = modelBoxToImageBox({ x: 64, y: 224, w: 128, h: 64 }, letterbox);
    const withoutPad = modelBoxToImageBox({ x: 64, y: 224, w: 128, h: 64 }, {
      ...letterbox,
      padY: 0,
    });

    expect(Math.abs(withPad.y - withoutPad.y)).toBe(250);
  });
});

describe('imageBoxToCssBox', () => {
  it('scales a box down to the rendered screenshot size', () => {
    // 2000px-wide image displayed in a 400px column => displayScale 0.2
    const css = imageBoxToCssBox({ x: 500, y: 250, w: 100, h: 40 }, 0.2);
    expect(css).toEqual({ left: 100, top: 50, width: 20, height: 8 });
  });

  it('round-trips with domRectToImageBox back to the original CSS rect', () => {
    // The overlay must land on the element it describes; this is the
    // end-to-end property the side panel verifies visually.
    const frame = createFullPageFrame(1000, 800, 2000, 1600, 1);
    const rect = { left: 120, top: 80, width: 200, height: 40 };

    const displayScale = 400 / frame.imageWidth; // rendered at 400px wide
    const css = imageBoxToCssBox(domRectToImageBox(rect, frame), displayScale);

    // CSS px -> image px -> display px == CSS px * (display / page width)
    const expected = 400 / 1000;
    expect(css.left).toBeCloseTo(rect.left * expected, 6);
    expect(css.width).toBeCloseTo(rect.width * expected, 6);
  });
});

describe('iou', () => {
  it('returns 1 for identical boxes', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
  });

  it('returns 0 for disjoint boxes', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(0);
  });

  it('returns 0 for boxes that merely touch at an edge', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(0);
  });

  it('computes partial overlap', () => {
    // 50% overlap in x, full in y => intersection 50, union 150.
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3, 10);
  });

  it('crosses the 0.5 dedupe threshold as expected', () => {
    // Phase 2's merger dedupes above 0.5; pin the behaviour it depends on.
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(iou(a, { x: 10, y: 10, w: 100, h: 100 })).toBeGreaterThan(0.5);
    expect(iou(a, { x: 60, y: 0, w: 100, h: 100 })).toBeLessThan(0.5);
  });
});

describe('detectDrift', () => {
  it('returns null for a clean capture', () => {
    expect(detectDrift(viewport(1000, 800), viewport(1000, 800))).toBeNull();
  });

  it('flags a page that scrolled between the DOM read and the screenshot', () => {
    const drift = detectDrift(viewport(1000, 800), viewport(1000, 800, { scrollY: 120 }));
    expect(drift).not.toBeNull();
    expect(drift!.scrollYDelta).toBe(120);
  });

  it('flags navigation mid-capture', () => {
    const drift = detectDrift(
      viewport(1000, 800, { url: 'https://a.test/' }),
      viewport(1000, 800, { url: 'https://b.test/' }),
    );
    expect(drift!.urlChanged).toBe(true);
  });
});
