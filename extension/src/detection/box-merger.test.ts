/**
 * SIH 26171 — box-merger tests.
 *
 * Pure logic, no DOM, no model. What's worth pinning: no-overlap keeps
 * everything, identical/overlapping boxes collapse to the higher-confidence
 * one REGARDLESS of piiType (the deliberate cross-source rule — see
 * box-merger.ts's doc comment), and the greedy "kept set" semantics (not a
 * single all-pairs pass) on a three-box chain.
 */

import { describe, expect, it } from 'vitest';
import { mergeDetections } from './box-merger';
import type { DetectedBox } from '../types';

function box(overrides: Partial<DetectedBox> & { x: number; y: number; w: number; h: number }): DetectedBox {
  const { x, y, w, h, ...rest } = overrides;
  return {
    imageBox: { x, y, w, h },
    piiType: 'OTHER',
    confidence: 0.9,
    source: 'DOM',
    ...rest,
  };
}

describe('mergeDetections', () => {
  it('keeps all boxes when none overlap', () => {
    const boxes = [
      box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9 }),
      box({ x: 100, y: 100, w: 10, h: 10, confidence: 0.5 }),
      box({ x: 200, y: 200, w: 10, h: 10, confidence: 0.1 }),
    ];
    expect(mergeDetections(boxes)).toHaveLength(3);
  });

  it('collapses identical boxes to the single higher-confidence one', () => {
    const low = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.4, source: 'DOM' });
    const high = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9, source: 'NER_MODEL' });

    const merged = mergeDetections([low, high]);

    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(0.9);
    expect(merged[0].source).toBe('NER_MODEL');
  });

  it('is order-independent: the higher-confidence box wins regardless of input order', () => {
    const low = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.4 });
    const high = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9 });

    expect(mergeDetections([high, low])[0].confidence).toBe(0.9);
    expect(mergeDetections([low, high])[0].confidence).toBe(0.9);
  });

  it('dedupes across DIFFERENT piiTypes when IoU is high — deliberate, not a bug', () => {
    // A face box and a name box overlapping heavily. IoU-only dedupe means
    // these collapse to one, per box-merger.ts's documented reasoning: the
    // merger feeds redaction (a covered pixel is covered), not
    // classification.
    const face = box({ x: 0, y: 0, w: 20, h: 20, piiType: 'FACE', source: 'FACE_MODEL', confidence: 0.95 });
    const name = box({ x: 1, y: 1, w: 20, h: 20, piiType: 'NAME', source: 'NER_MODEL', confidence: 0.6 });

    const merged = mergeDetections([face, name]);

    expect(merged).toHaveLength(1);
    expect(merged[0].piiType).toBe('FACE'); // higher-confidence box's label wins
  });

  it('keeps two DIFFERENT-type boxes that merely sit near each other without real overlap', () => {
    const face = box({ x: 0, y: 0, w: 20, h: 20, piiType: 'FACE', confidence: 0.95 });
    const name = box({ x: 100, y: 100, w: 20, h: 20, piiType: 'NAME', confidence: 0.6 });

    expect(mergeDetections([face, name])).toHaveLength(2);
  });

  it('respects a custom IoU threshold', () => {
    // Two 10x10 boxes offset by 5px on one axis: intersection 5x10=50,
    // union 100+100-50=150, IoU = 1/3.
    const a = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9 });
    const b = box({ x: 5, y: 0, w: 10, h: 10, confidence: 0.8 });

    expect(mergeDetections([a, b], 0.5)).toHaveLength(2); // below 0.5, both kept
    expect(mergeDetections([a, b], 0.3)).toHaveLength(1); // above 0.3, collapsed
  });

  it('greedy kept-set semantics: a losing box does not block a later box it never overlapped', () => {
    // A (conf 0.9) and C (conf 0.7) do NOT overlap each other.
    // B (conf 0.8) overlaps BOTH A and C heavily.
    // Sorted by confidence: A, B, C.
    //   A: kept (nothing kept yet).
    //   B: overlaps A above threshold -> dropped. B is NEVER added to kept.
    //   C: checked against kept = [A] only (not the dropped B) -> no
    //      overlap with A -> C is kept too.
    // Net: A and C survive, B does not. This only holds if the algorithm
    // checks candidates against the KEPT set as it grows, not the full
    // original list or B specifically.
    const a = box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9 });
    const b = box({ x: 5, y: 0, w: 10, h: 10, confidence: 0.8 }); // overlaps a and c
    const c = box({ x: 10, y: 0, w: 10, h: 10, confidence: 0.7 }); // does not overlap a

    const merged = mergeDetections([a, b, c], 0.2);

    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.confidence).sort((x, y) => y - x)).toEqual([0.9, 0.7]);
  });

  it('returns an empty array for empty input', () => {
    expect(mergeDetections([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const boxes = [
      box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.4 }),
      box({ x: 0, y: 0, w: 10, h: 10, confidence: 0.9 }),
    ];
    const original = [...boxes];
    mergeDetections(boxes);
    expect(boxes).toEqual(original);
  });
});
