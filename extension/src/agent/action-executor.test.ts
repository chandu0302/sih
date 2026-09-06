/**
 * SIH 26171 — Phase 5 action-executor tests.
 *
 * jsdom has no layout engine, so document.elementFromPoint always returns
 * null by default (same class of gap dom-track.test.ts works around for
 * getBoundingClientRect) — stubbed directly here instead of building a fake
 * layout, since elementFromPoint's return value is all this module actually
 * consumes, not real coordinate geometry (that already happened in
 * coords.ts before this module ever sees a point).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction } from './action-executor';

describe('executeAction — click', () => {
  // jsdom does not implement elementFromPoint at all (no layout engine to
  // compute it from) — vi.spyOn requires an existing property descriptor to
  // wrap, which jsdom's document doesn't have here, so it must be assigned
  // directly rather than spied on.
  beforeEach(() => {
    document.elementFromPoint = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks the element at the given point and reports success', () => {
    const button = document.createElement('button');
    button.id = 'submit-btn';
    document.body.appendChild(button);
    const clickSpy = vi.spyOn(button, 'click');
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(button);

    const result = executeAction({ kind: 'click', point: { left: 10, top: 20 } });

    expect(result.ok).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(result.detail).toContain('submit-btn');
    button.remove();
  });

  it('reports failure when no element is at the point', () => {
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = executeAction({ kind: 'click', point: { left: 999, top: 999 } });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no element found/i);
  });

  it('reports failure when the action carries no point', () => {
    const result = executeAction({ kind: 'click' });
    expect(result.ok).toBe(false);
  });
});

describe('executeAction — type', () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
  });

  afterEach(() => {
    input.remove();
  });

  it('sets the value on the focused input and fires input/change', () => {
    const inputHandler = vi.fn();
    const changeHandler = vi.fn();
    input.addEventListener('input', inputHandler);
    input.addEventListener('change', changeHandler);

    const result = executeAction({ kind: 'type', text: 'Test User' });

    expect(result.ok).toBe(true);
    expect(input.value).toBe('Test User');
    expect(inputHandler).toHaveBeenCalledOnce();
    expect(changeHandler).toHaveBeenCalledOnce();
  });

  it('fails when nothing is focused', () => {
    input.blur();
    (document.activeElement as HTMLElement | null)?.blur();
    // jsdom's default activeElement when nothing is focused is <body>.
    const result = executeAction({ kind: 'type', text: 'x' });
    expect(result.ok).toBe(false);
  });

  it('fails when the action carries no text', () => {
    const result = executeAction({ kind: 'type' });
    expect(result.ok).toBe(false);
  });
});

describe('executeAction — scroll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls down by a positive amount', () => {
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    executeAction({ kind: 'scroll', scrollDirection: 'down' });

    expect(scrollBySpy).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }));
    const arg = scrollBySpy.mock.calls[0][0] as unknown as { top: number };
    expect(arg.top).toBeGreaterThan(0);
  });

  it('scrolls up by a negative amount', () => {
    const scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    executeAction({ kind: 'scroll', scrollDirection: 'up' });

    const arg = scrollBySpy.mock.calls[0][0] as unknown as { top: number };
    expect(arg.top).toBeLessThan(0);
  });

  it('fails when the action carries no direction', () => {
    const result = executeAction({ kind: 'scroll' });
    expect(result.ok).toBe(false);
  });
});

describe('executeAction — done', () => {
  it('always succeeds and executes nothing', () => {
    const result = executeAction({ kind: 'done' });
    expect(result.ok).toBe(true);
  });
});
