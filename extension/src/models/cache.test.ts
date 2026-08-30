/**
 * SIH 26171 — model cache degradation tests.
 *
 * SCOPE, DELIBERATELY NARROW: this file tests ONLY the contract that a cache
 * failure degrades instead of throwing. Real store-and-retrieve behaviour is
 * on the manual-verification list in onnx-loader.ts (item 3), because
 * verifying it here would mean either mocking IndexedDB — asserting our mock
 * behaves like our mock — or pulling in a fake-indexeddb dependency to test
 * infrastructure the browser is going to provide anyway.
 *
 * What IS worth testing without a browser is the path that runs when
 * IndexedDB is missing entirely, since that is a documented requirement of
 * the brief and the one branch that must never throw. These tests run in the
 * `node` project, where `indexedDB` genuinely does not exist — so the
 * condition is real rather than simulated.
 */

import { describe, expect, it } from 'vitest';
import { cacheModel, clearModelCache, getCachedModel } from './cache';

const URL_A = 'chrome-extension://abc/models/face.onnx';

describe('cache — when IndexedDB is unavailable', () => {
  it('confirms the precondition: no indexedDB in this environment', () => {
    // Guards every assertion below. If a future environment change provided
    // IndexedDB here, these tests would silently start exercising a different
    // path and this one would fail first, saying so.
    expect(typeof indexedDB).toBe('undefined');
  });

  it('getCachedModel resolves to null instead of throwing', async () => {
    await expect(getCachedModel(URL_A)).resolves.toBeNull();
  });

  it('cacheModel resolves quietly instead of throwing', async () => {
    const buf = new ArrayBuffer(8);
    await expect(cacheModel(URL_A, buf)).resolves.toBeUndefined();
  });

  it('clearModelCache resolves quietly instead of throwing', async () => {
    await expect(clearModelCache()).resolves.toBeUndefined();
  });

  it('a write followed by a read still reports a miss, not a crash', async () => {
    // The degraded steady state the loader must tolerate: every load is a
    // cache miss, so every load re-downloads, and nothing breaks.
    await cacheModel(URL_A, new ArrayBuffer(16));
    await expect(getCachedModel(URL_A)).resolves.toBeNull();
  });

  it('settles promptly rather than hanging on the open timeout', async () => {
    // openDb() bounds a blocked IndexedDB open at 3s. When the factory is
    // absent we must short-circuit well before that — a hung await here would
    // freeze the panel with no error, which is the worst failure shape.
    const started = Date.now();
    await getCachedModel(URL_A);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
