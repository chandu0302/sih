/**
 * SIH 26171 — coordinate math tests.
 *
 * This is the one module worth testing hard in Phase 1. Every redaction box in
 * Phase 3 and every face box in Phase 2 passes through it, and its failure mode
 * is silent: boxes land slightly off, PII stays visible at the edges, and
 * nothing throws. A 20%-weighted criterion fails quietly.
 *
 * The scenarios below are the real display configurations we must survive:
 * standard 1x, Retina 2x, Windows fractional scaling at 1.25/1.5, and browser
 * zoom — plus scrollbar ambiguity, which is what the basis selection solves.
 */

import { describe, expect, it } from 'vitest';
import {
  clampToImage,
  createCoordinateFrame,
  detectDrift,
  domRectToImageBox,
  imageBoxToCssBox,
  iou,
  modelBoxToImageBox,
} from './coords';
import type { ViewportContext } from '../types';

/**
 * Build a viewport as the browser would report it.
 * `scrollbar` is the width the classic scrollbar steals from clientWidth;
 * pass 0 to simulate overlay scrollbars (macOS / Chrome overlay mode).
 */
function viewport(
  cssWidth: number,
  cssHeight: number,
  opts: { dpr?: number; scrollbar?: number; scrollX?: number; scrollY?: number; url?: string } = {},
): ViewportContext {
  const scrollbar = opts.scrollbar ?? 15;
  return {
    dpr: opts.dpr ?? 1,
    innerWidth: cssWidth,
    innerHeight: cssHeight,
    clientWidth: cssWidth - scrollbar,
    clientHeight: cssHeight,
    scrollX: opts.scrollX ?? 0,
    scrollY: opts.scrollY ?? 0,
    url: opts.url ?? 'https://example.test/page',
  };
}

describe('createCoordinateFrame — basis selection', () => {
  it('picks the scrollbar-excluding basis when the capture excludes the scrollbar', () => {
    // Viewport 1500 CSS wide, 15px scrollbar => content area 1485.
    // Capture is 1485 physical px: the PNG did NOT include the scrollbar.
    const frame = createCoordinateFrame(viewport(1500, 800), 1485, 800);

    expect(frame.basis).toBe('client/client');
    expect(frame.scaleX).toBeCloseTo(1, 10);
    expect(frame.anisotropy).toBeCloseTo(1, 10);
  });

  it('picks the scrollbar-including basis when the capture includes the scrollbar', () => {
    // Same page, but the PNG came back 1500 wide: the scrollbar IS in the image.
    const frame = createCoordinateFrame(viewport(1500, 800), 1500, 800);

    expect(frame.basis).toBe('inner/client');
    expect(frame.scaleX).toBeCloseTo(1, 10);
    expect(frame.anisotropy).toBeCloseTo(1, 10);
  });

  it('resolves the ambiguity correctly at 2x DPR, where the error would double', () => {
    // Retina: content area 1485 CSS -> 2970 image px.
    const frame = createCoordinateFrame(viewport(1500, 800, { dpr: 2 }), 2970, 1600);

    expect(frame.basis).toBe('client/client');
    expect(frame.scaleX).toBeCloseTo(2, 10);
    expect(frame.scaleY).toBeCloseTo(2, 10);
  });

  it('is unambiguous with overlay scrollbars, where both bases agree', () => {
    const frame = createCoordinateFrame(viewport(1500, 800, { scrollbar: 0 }), 1500, 800);
    expect(frame.anisotropy).toBeCloseTo(1, 10);
    expect(frame.scaleX).toBeCloseTo(1, 10);
  });

  it('would have produced a ~1% scale error if the wrong basis were chosen', () => {
    // Documents WHY basis selection exists: this is the bug it prevents.
    const vp = viewport(1500, 800);
    const naiveScaleX = 1485 / vp.innerWidth; // wrong denominator
    const correctScaleX = 1485 / vp.clientWidth;

    // At x=1400 CSS the naive transform misplaces the box by >13px.
    const drift = Math.abs(1400 * correctScaleX - 1400 * naiveScaleX);
    expect(drift).toBeGreaterThan(13);
  });
});

describe('createCoordinateFrame — fractional and zoomed scales', () => {
  it('handles Windows 1.25x scaling', () => {
    const frame = createCoordinateFrame(viewport(1536, 864, { dpr: 1.25 }), 1901, 1080);
    expect(frame.scaleY).toBeCloseTo(1.25, 6);
    expect(frame.anisotropy).toBeCloseTo(1, 2);
  });

  it('derives scale from the image even when it disagrees with reported DPR', () => {
    // Browser zoom at 150%: DPR reports 1 but the capture is 1.5x the viewport.
    const frame = createCoordinateFrame(viewport(1000, 800, { dpr: 1, scrollbar: 0 }), 1500, 1200);

    expect(frame.reportedDpr).toBe(1); // hint only
    expect(frame.scaleX).toBeCloseTo(1.5, 10); // ground truth wins
  });

  it('rejects a failed capture rather than producing silent garbage', () => {
    expect(() => createCoordinateFrame(viewport(1000, 800), 0, 0)).toThrow(/Invalid image/);
  });
});

describe('domRectToImageBox', () => {
  const frame = createCoordinateFrame(viewport(1000, 800, { scrollbar: 0 }), 2000, 1600);

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

  it('does NOT add scroll offset — rects and captures share the viewport origin', () => {
    const scrolled = createCoordinateFrame(
      viewport(1000, 800, { scrollbar: 0, scrollY: 4000 }),
      1000,
      800,
    );
    const box = domRectToImageBox({ left: 0, top: 10, width: 50, height: 20 }, scrolled);

    // If scrollY leaked into the transform, y would be ~4010 and off-image.
    expect(box.y).toBe(10);
  });
});

describe('clampToImage', () => {
  const frame = createCoordinateFrame(viewport(1000, 800, { scrollbar: 0 }), 1000, 800);

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
    const frame = createCoordinateFrame(viewport(1000, 800, { scrollbar: 0 }), 2000, 1600);
    const rect = { left: 120, top: 80, width: 200, height: 40 };

    const displayScale = 400 / frame.imageWidth; // rendered at 400px wide
    const css = imageBoxToCssBox(domRectToImageBox(rect, frame), displayScale);

    // CSS px -> image px -> display px == CSS px * (display / viewport)
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
