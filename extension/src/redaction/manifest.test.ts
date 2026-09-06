/**
 * SIH 26171 — Phase 3c manifest tests.
 */
import { describe, expect, it } from 'vitest';
import type { DetectedBox } from '../types';
import { buildRedactionManifest } from './manifest';

function box(overrides: Partial<DetectedBox> = {}): DetectedBox {
  return {
    imageBox: { x: 1, y: 2, w: 3, h: 4 },
    piiType: 'PHONE',
    confidence: 0.8,
    source: 'DOM',
    ...overrides,
  };
}

describe('buildRedactionManifest', () => {
  it('maps type, bbox, and confidence straight through', () => {
    const manifest = buildRedactionManifest([box()]);

    expect(manifest.regions).toEqual([
      { type: 'PHONE', bbox: { x: 1, y: 2, w: 3, h: 4 }, nodeId: undefined, confidence: 0.8 },
    ]);
  });

  it('carries nodeId through when present', () => {
    const manifest = buildRedactionManifest([box({ nodeId: 'd3' })]);
    expect(manifest.regions[0].nodeId).toBe('d3');
  });

  it('never includes the matched PII text, even when the input box carries it', () => {
    const manifest = buildRedactionManifest([box({ text: '9876543210' })]);

    expect(manifest.regions[0]).not.toHaveProperty('text');
    expect(JSON.stringify(manifest)).not.toContain('9876543210');
  });

  it('produces an empty manifest for no detections', () => {
    expect(buildRedactionManifest([])).toEqual({ regions: [] });
  });

  it('preserves one region per input box, in order', () => {
    const boxes = [box({ piiType: 'NAME' }), box({ piiType: 'EMAIL' }), box({ piiType: 'FACE' })];
    const manifest = buildRedactionManifest(boxes);

    expect(manifest.regions.map((r) => r.type)).toEqual(['NAME', 'EMAIL', 'FACE']);
  });
});
