/**
 * SIH 26171 — face detector tests.
 *
 * Pure logic only, mirroring the loader's testing philosophy (see
 * onnx-loader.ts's header): mocking InferenceSession would only assert a
 * mock behaves like a mock. What's worth pinning here is the math that would
 * actually hide a bug — letterbox geometry, the padX/padY round-trip through
 * modelBoxToImageBox, and the anchor decoder/NMS on a hand-built tensor. No
 * browser, no real weights.
 */

import { describe, expect, it } from 'vitest';
import { clampToImage, createFullPageFrame, modelBoxToImageBox } from '../lib/coords';
import type { ImageBox, ViewportContext } from '../types';
import { computeLetterboxParams, decodeOutput, nms } from './face-detector';

const SIZE = 640;

/* ------------------------------------------------------------------ */
/* letterbox geometry                                                  */
/* ------------------------------------------------------------------ */

describe('computeLetterboxParams', () => {
  it('pads top/bottom for a landscape image (wide source, square target)', () => {
    const params = computeLetterboxParams(1280, 720, SIZE);

    expect(params.scale).toBeCloseTo(SIZE / 1280, 6);
    // Width fills exactly; height is scaled and the leftover is split evenly.
    expect(params.padX).toBeCloseTo(0, 6);
    expect(params.padY).toBeGreaterThan(0);

    const resizedH = Math.round(720 * params.scale);
    expect(params.padY).toBeCloseTo((SIZE - resizedH) / 2, 6);
  });

  it('pads left/right for a portrait image', () => {
    const params = computeLetterboxParams(720, 1280, SIZE);

    expect(params.scale).toBeCloseTo(SIZE / 1280, 6);
    expect(params.padY).toBeCloseTo(0, 6);
    expect(params.padX).toBeGreaterThan(0);

    const resizedW = Math.round(720 * params.scale);
    expect(params.padX).toBeCloseTo((SIZE - resizedW) / 2, 6);
  });

  it('adds no padding for a square image already at the target size', () => {
    const params = computeLetterboxParams(SIZE, SIZE, SIZE);

    expect(params.scale).toBeCloseTo(1, 6);
    expect(params.padX).toBeCloseTo(0, 6);
    expect(params.padY).toBeCloseTo(0, 6);
  });

  it('scales a smaller square image up, still with no padding', () => {
    const params = computeLetterboxParams(320, 320, SIZE);

    expect(params.scale).toBeCloseTo(2, 6);
    expect(params.padX).toBeCloseTo(0, 6);
    expect(params.padY).toBeCloseTo(0, 6);
  });
});

/* ------------------------------------------------------------------ */
/* round-trip invariant — the important one                            */
/* ------------------------------------------------------------------ */

describe('letterbox <-> modelBoxToImageBox round trip', () => {
  const VIEWPORT: ViewportContext = {
    dpr: 1,
    innerWidth: 1280,
    innerHeight: 720,
    clientWidth: 1280,
    clientHeight: 720,
    scrollX: 0,
    scrollY: 0,
    url: 'https://example.test/',
  };

  function roundTrip(
    imgW: number,
    imgH: number,
    box: ImageBox,
  ): { original: ImageBox; recovered: ImageBox | null } {
    const params = computeLetterboxParams(imgW, imgH, SIZE);

    // Project the known image-space box into model (640) space exactly the
    // way a real detection would arrive: scale then offset by the pad.
    const modelBox: ImageBox = {
      x: box.x * params.scale + params.padX,
      y: box.y * params.scale + params.padY,
      w: box.w * params.scale,
      h: box.h * params.scale,
    };

    const frame = createFullPageFrame(VIEWPORT.clientWidth, VIEWPORT.clientHeight, imgW, imgH, VIEWPORT.dpr);
    const recovered = clampToImage(modelBoxToImageBox(modelBox, params), frame);

    return { original: box, recovered };
  }

  it('recovers a box within 1px for a landscape image', () => {
    const { original, recovered } = roundTrip(1280, 720, { x: 100, y: 50, w: 200, h: 150 });

    expect(recovered).not.toBeNull();
    expect(Math.abs(recovered!.x - original.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.y - original.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.w - original.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.h - original.h)).toBeLessThanOrEqual(1);
  });

  it('recovers a box within 1px for a portrait image (exercises padX)', () => {
    const { original, recovered } = roundTrip(720, 1280, { x: 50, y: 300, w: 100, h: 120 });

    expect(recovered).not.toBeNull();
    expect(Math.abs(recovered!.x - original.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.y - original.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.w - original.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(recovered!.h - original.h)).toBeLessThanOrEqual(1);
  });

  it('recovers a box near the image edge (exercises the padding sign)', () => {
    // If padX/padY were subtracted with the wrong sign, a box near the
    // origin would come back far from zero instead of near it.
    const { recovered } = roundTrip(1280, 720, { x: 0, y: 0, w: 40, h: 40 });

    expect(recovered).not.toBeNull();
    expect(recovered!.x).toBeLessThanOrEqual(1);
    expect(recovered!.y).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* decoder — hand-built tensor                                         */
/* ------------------------------------------------------------------ */

/** Build a [1, 5, K] tensor from a list of [cx, cy, w, h, score] anchors. */
function buildPlanar(anchors: number[][]): Float32Array {
  const k = anchors.length;
  const out = new Float32Array(5 * k);
  for (let ch = 0; ch < 5; ch++) {
    for (let a = 0; a < k; a++) {
      out[ch * k + a] = anchors[a][ch];
    }
  }
  return out;
}

/** Build a [1, K, 5] tensor from the same anchor list. */
function buildInterleaved(anchors: number[][]): Float32Array {
  const k = anchors.length;
  const out = new Float32Array(k * 5);
  for (let a = 0; a < k; a++) {
    for (let ch = 0; ch < 5; ch++) {
      out[a * 5 + ch] = anchors[a][ch];
    }
  }
  return out;
}

describe('decodeOutput', () => {
  // [cx, cy, w, h, score]
  const ANCHORS = [
    [100, 100, 40, 40, 0.9], // kept — high score
    [102, 101, 40, 40, 0.8], // kept-by-score, but overlaps anchor 0 heavily
    [500, 500, 30, 30, 0.6], // kept — far away, distinct face
    [300, 300, 20, 20, 0.1], // dropped — below CONF
  ];

  it('filters by score and converts cxcywh -> xywh', () => {
    const data = buildPlanar(ANCHORS);
    const decoded = decodeOutput(data, [1, 5, ANCHORS.length], 0.4);

    // The 0.1-score anchor is gone; the other three survive decoding
    // (NMS happens separately).
    expect(decoded).toHaveLength(3);

    // Float32Array rounds 0.9 to the nearest representable float32, so
    // compare with a tolerance rather than strict equality.
    const first = decoded.find((d) => Math.abs(d.score - 0.9) < 1e-5)!;
    expect(first.box).toEqual({ x: 100 - 20, y: 100 - 20, w: 40, h: 40 });
  });

  it('is axis-agnostic: [1,5,K] and [1,K,5] decode identically', () => {
    const planar = decodeOutput(buildPlanar(ANCHORS), [1, 5, ANCHORS.length], 0.4);
    const interleaved = decodeOutput(buildInterleaved(ANCHORS), [1, ANCHORS.length, 5], 0.4);

    expect(interleaved).toEqual(planar);
  });

  it('also accepts un-batched dims ([5,K] / [K,5])', () => {
    const planar = decodeOutput(buildPlanar(ANCHORS), [5, ANCHORS.length], 0.4);
    expect(planar).toHaveLength(3);
  });
});

describe('nms', () => {
  it('dedupes two heavily overlapping boxes, keeping the higher score', () => {
    const data = buildPlanar(ANCHORS_FOR_NMS);
    const decoded = decodeOutput(data, [1, 5, ANCHORS_FOR_NMS.length], 0.4);
    const survivors = nms(decoded, 0.45);

    // Anchor 0 and 1 overlap heavily (IoU well above 0.45); anchor 2 is a
    // separate face far away and must survive independently.
    const has = (score: number) => survivors.some((s) => Math.abs(s.score - score) < 1e-5);

    expect(survivors).toHaveLength(2);
    expect(has(0.9)).toBe(true);
    expect(has(0.8)).toBe(false);
    expect(has(0.6)).toBe(true);
  });

  it('keeps two boxes that do not overlap', () => {
    const decoded = [
      { box: { x: 0, y: 0, w: 10, h: 10 }, score: 0.9 },
      { box: { x: 500, y: 500, w: 10, h: 10 }, score: 0.5 },
    ];
    expect(nms(decoded, 0.45)).toHaveLength(2);
  });
});

const ANCHORS_FOR_NMS = [
  [100, 100, 40, 40, 0.9],
  [102, 101, 40, 40, 0.8],
  [500, 500, 30, 30, 0.6],
];
