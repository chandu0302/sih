/**
 * SIH 26171 — Phase 3b face-blur tests.
 *
 * Pure geometry only, same philosophy as face-detector.test.ts: blurFaces()
 * itself needs OffscreenCanvas/ImageBitmap, neither of which exist in Node,
 * so browser verification (MVP blocker #4) is what actually proves the blur
 * occludes identity. What's worth pinning here is the padding/clamping math
 * that would silently under- or over-cover a face if it drifted.
 */
import { describe, expect, it } from 'vitest';
import type { ImageBox } from '../types';
import { computeBlurRect } from './face-blur';

const IMAGE_W = 1000;
const IMAGE_H = 800;

describe('computeBlurRect', () => {
  it('pads a box by the given fraction on every side', () => {
    const box: ImageBox = { x: 100, y: 100, w: 100, h: 100 };
    const rect = computeBlurRect(box, IMAGE_W, IMAGE_H, 0.25);

    expect(rect).not.toBeNull();
    // 25% of 100 = 25px padding each side.
    expect(rect!.x).toBe(75);
    expect(rect!.y).toBe(75);
    expect(rect!.w).toBe(150);
    expect(rect!.h).toBe(150);
  });

  it('clamps padding at the left/top image edge instead of going negative', () => {
    const box: ImageBox = { x: 5, y: 5, w: 40, h: 40 };
    const rect = computeBlurRect(box, IMAGE_W, IMAGE_H, 0.5);

    expect(rect).not.toBeNull();
    expect(rect!.x).toBe(0);
    expect(rect!.y).toBe(0);
  });

  it('clamps padding at the right/bottom image edge instead of overflowing', () => {
    const box: ImageBox = { x: IMAGE_W - 40, y: IMAGE_H - 40, w: 40, h: 40 };
    const rect = computeBlurRect(box, IMAGE_W, IMAGE_H, 0.5);

    expect(rect).not.toBeNull();
    expect(rect!.x + rect!.w).toBe(IMAGE_W);
    expect(rect!.y + rect!.h).toBe(IMAGE_H);
  });

  it('defaults to the module padding fraction when none is given', () => {
    const box: ImageBox = { x: 200, y: 200, w: 100, h: 100 };
    const rect = computeBlurRect(box, IMAGE_W, IMAGE_H);

    expect(rect).not.toBeNull();
    // Default is 0.25 — same expansion as the explicit-fraction test above.
    expect(rect!.w).toBe(150);
    expect(rect!.h).toBe(150);
  });

  it('returns a box no smaller than the input when padding is zero', () => {
    const box: ImageBox = { x: 50, y: 50, w: 20, h: 30 };
    const rect = computeBlurRect(box, IMAGE_W, IMAGE_H, 0);

    expect(rect).toEqual(box);
  });
});
