/**
 * SIH 26171 — backend probe and fallback policy tests.
 *
 * This file deliberately tests only decision logic. The ONNX runtime itself is
 * not mocked anywhere: a fake InferenceSession would assert that our mock
 * behaves like our mock, which is worse than no test because it reads as
 * coverage. What IS worth pinning is the 2x2 truth table below — the branch
 * that decides which execution provider we end up running on, where a wrong
 * answer means either a hard crash on a driver we could have fallen back from,
 * or silently running everything on WASM at a fraction of the speed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type Backend,
  type GpuNamespace,
  detectBackend,
  resolveBackend,
} from './webgpu';

/** A navigator.gpu stub whose requestAdapter resolves to `adapter`. */
function gpuReturning(adapter: unknown): GpuNamespace {
  return { requestAdapter: () => Promise.resolve(adapter) };
}

describe('detectBackend — capability probe', () => {
  it('reports webgpu when an adapter is actually returned', async () => {
    await expect(detectBackend(gpuReturning({ name: 'fake-adapter' }))).resolves.toBe(
      'webgpu',
    );
  });

  it('reports wasm when navigator.gpu is absent entirely', async () => {
    await expect(detectBackend(undefined)).resolves.toBe('wasm');
  });

  it('reports wasm when gpu exists but yields NO adapter', async () => {
    // The false positive this probe exists for: the API is present, so a
    // naive `if (navigator.gpu)` check passes, but the machine cannot
    // produce a device — blocklisted driver, VM, headless, GPU crash.
    await expect(detectBackend(gpuReturning(null))).resolves.toBe('wasm');
  });

  it('reports wasm when requestAdapter REJECTS', async () => {
    const gpu: GpuNamespace = {
      requestAdapter: () => Promise.reject(new Error('GPU process died')),
    };
    await expect(detectBackend(gpu)).resolves.toBe('wasm');
  });

  it('reports wasm when requestAdapter throws synchronously', async () => {
    const gpu = {
      requestAdapter: () => {
        throw new Error('not a function, actually');
      },
    } as unknown as GpuNamespace;
    await expect(detectBackend(gpu)).resolves.toBe('wasm');
  });

  it('reports wasm when gpu is present but malformed', async () => {
    await expect(detectBackend({} as GpuNamespace)).resolves.toBe('wasm');
  });

  it('never rejects, whatever the platform does', async () => {
    // A capability probe that can itself fail is not a capability probe.
    const hostile = {
      get requestAdapter() {
        throw new Error('exploding getter');
      },
    } as unknown as GpuNamespace;

    await expect(detectBackend(hostile)).resolves.toBe('wasm');
  });

  it('logs the decision so we can see which path a machine took', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await detectBackend(gpuReturning({}));
      await detectBackend(undefined);

      expect(log).toHaveBeenCalledWith('[SIH] backend: webgpu');
      expect(log).toHaveBeenCalledWith('[SIH] backend: wasm');
    } finally {
      log.mockRestore();
    }
  });
});

describe('resolveBackend — the full fallback truth table', () => {
  // Four inputs, four outputs. Enumerated rather than sampled, because this
  // is the whole decision surface.
  const cases: Array<[Backend, 'ok' | 'failed', ReturnType<typeof resolveBackend>]> = [
    ['webgpu', 'ok', { provider: 'webgpu', usedFallback: false, exhausted: false }],
    ['webgpu', 'failed', { provider: 'wasm', usedFallback: true, exhausted: false }],
    ['wasm', 'ok', { provider: 'wasm', usedFallback: false, exhausted: false }],
    ['wasm', 'failed', { provider: 'wasm', usedFallback: false, exhausted: true }],
  ];

  it.each(cases)('probe=%s outcome=%s', (probed, outcome, expected) => {
    expect(resolveBackend(probed, outcome)).toEqual(expected);
  });

  it('falls back to WASM when WebGPU was probed OK but the session still failed', () => {
    // The double-safety case: probe optimistic, driver or model op unsupported.
    const decision = resolveBackend('webgpu', 'failed');

    expect(decision.provider).toBe('wasm');
    expect(decision.usedFallback).toBe(true);
    expect(decision.exhausted).toBe(false);
  });

  it('marks WASM failure as exhausted rather than looping', () => {
    // Nothing below WASM to retry on; the caller must surface the real error.
    expect(resolveBackend('wasm', 'failed').exhausted).toBe(true);
  });

  it('never reports a fallback that lands back on webgpu', () => {
    for (const [probed, outcome] of cases.map(([p, o]) => [p, o] as const)) {
      const decision = resolveBackend(probed, outcome);
      if (decision.usedFallback) expect(decision.provider).toBe('wasm');
    }
  });

  it('is pure — repeated calls agree', () => {
    expect(resolveBackend('webgpu', 'failed')).toEqual(resolveBackend('webgpu', 'failed'));
  });
});
