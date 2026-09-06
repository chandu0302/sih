/**
 * SIH 26171 — Phase 3a mask-overlay tests.
 *
 * No layout dependency (jsdom's missing layout engine, which dom-track.test.ts
 * works around with a fake layout, does not matter here): applyMasks() only
 * writes the CSS its caller hands it, never measures the DOM itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectedBox } from '../types';
import { applyMasks, removeMasks } from './mask-overlay';

function box(x: number, y: number, w: number, h: number): DetectedBox {
  return {
    imageBox: { x, y, w, h },
    piiType: 'NAME',
    confidence: 0.9,
    source: 'DOM',
  };
}

describe('applyMasks / removeMasks', () => {
  afterEach(() => {
    removeMasks();
  });

  it('appends one overlay element per box, positioned and sized to match', () => {
    const count = applyMasks([box(10, 20, 100, 40), box(200, 5, 30, 30)]);

    expect(count).toBe(2);
    const overlays = document.querySelectorAll('[data-sih-mask]');
    expect(overlays.length).toBe(2);

    const first = overlays[0] as HTMLElement;
    expect(first.style.position).toBe('fixed');
    expect(first.style.left).toBe('10px');
    expect(first.style.top).toBe('20px');
    expect(first.style.width).toBe('100px');
    expect(first.style.height).toBe('40px');
  });

  it('overlays do not intercept pointer events on the underlying page', () => {
    applyMasks([box(0, 0, 10, 10)]);
    const overlay = document.querySelector('[data-sih-mask]') as HTMLElement;
    expect(overlay.style.pointerEvents).toBe('none');
  });

  it('removeMasks removes every applied overlay and returns the count removed', () => {
    applyMasks([box(0, 0, 10, 10), box(20, 20, 10, 10), box(40, 40, 10, 10)]);
    expect(document.querySelectorAll('[data-sih-mask]').length).toBe(3);

    const removed = removeMasks();

    expect(removed).toBe(3);
    expect(document.querySelectorAll('[data-sih-mask]').length).toBe(0);
  });

  it('is idempotent when called with nothing active', () => {
    expect(removeMasks()).toBe(0);
  });

  it('does not accumulate overlays across repeated apply/remove cycles', () => {
    applyMasks([box(0, 0, 10, 10)]);
    removeMasks();
    applyMasks([box(0, 0, 10, 10), box(10, 10, 10, 10)]);

    expect(document.querySelectorAll('[data-sih-mask]').length).toBe(2);
  });
});
