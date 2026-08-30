/**
 * SIH 26171 — backend capability probe and fallback policy.
 *
 * Shared by BOTH model runtimes: Track 2's raw onnxruntime-web sessions and
 * Track 3's transformers.js pipelines. transformers.js takes a `device`
 * string rather than an executionProviders array, but the *decision* — is
 * WebGPU actually usable here, and what do we do when it is not — is the
 * same question, so it is answered once, here.
 *
 * WHY PROBING navigator.gpu IS NOT ENOUGH
 * `navigator.gpu` is a namespace object; its presence says the browser has
 * the WebGPU API compiled in, not that this machine can produce a device.
 * requestAdapter() returns null on blocklisted drivers, in headless/VM
 * environments, on Linux where WebGPU is still behind a flag, and when the
 * GPU process has crashed. Treating presence as capability is the classic
 * WebGPU false positive: everything typechecks, the probe says yes, and
 * session creation then fails on the user's actual machine.
 *
 * This module NEVER throws. A capability probe that can itself fail is not a
 * capability probe. Every failure path resolves to 'wasm', which works
 * everywhere.
 */

/** Execution backend. Ordered by preference, not by capability. */
export type Backend = 'webgpu' | 'wasm';

/** Whether a session-creation attempt succeeded. */
export type SessionOutcome = 'ok' | 'failed';

/**
 * The minimal shape of `navigator.gpu` that we depend on.
 *
 * Declared structurally rather than pulling in @webgpu/types: we call exactly
 * one method, and onnxruntime-web's own .d.ts already references the real GPU
 * types (absorbed by tsconfig's skipLibCheck). Adding the package would mean
 * editing tsconfig's `types` array, which is outside this brief's scope.
 */
export interface GpuNamespace {
  requestAdapter(): Promise<unknown | null>;
}

function navigatorGpu(): GpuNamespace | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { gpu?: GpuNamespace }).gpu;
}

/**
 * Probe whether WebGPU is genuinely usable in this context.
 *
 * `gpu` is injectable ONLY so the decision logic can be unit-tested without a
 * browser; production callers use the no-argument form the brief specifies.
 *
 * MV3 NOTE: this must run in a document context — the side panel. A service
 * worker has no `navigator.gpu`, so calling this there always yields 'wasm',
 * silently and wrongly. See onnx-loader.ts.
 */
export async function detectBackend(
  gpu: GpuNamespace | undefined = navigatorGpu(),
): Promise<Backend> {
  const backend = await probe(gpu);
  console.log(`[SIH] backend: ${backend}`);
  return backend;
}

async function probe(gpu: GpuNamespace | undefined): Promise<Backend> {
  // EVERYTHING goes inside the try, including the shape guard. Reading
  // `gpu.requestAdapter` is itself a property access that can throw — on a
  // Proxy-based navigator, or a polyfill with a throwing getter. An earlier
  // version guarded outside the try and rejected on exactly that input; the
  // "never rejects" test in webgpu.test.ts caught it.
  try {
    if (!gpu || typeof gpu.requestAdapter !== 'function') return 'wasm';

    // requestAdapter() can reject outright, and can also resolve to null,
    // which is the far more common "API present, hardware unavailable" case.
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/**
 * The fallback policy, as a pure function of (probe result, attempt outcome).
 *
 * Extracted from the loader precisely because it IS testable: the surrounding
 * I/O — fetching weights, building an ONNX session — is not worth simulating,
 * but the branching that decides which provider we end up on is where a bug
 * would actually hide. The full truth table is pinned in webgpu.test.ts.
 *
 * The `exhausted` case matters: when the probe already said 'wasm' and WASM
 * itself fails to build a session, there is nothing left to fall back to and
 * the caller must surface the real error rather than retrying forever.
 */
export interface BackendDecision {
  /** The execution provider to use next, or the one that succeeded. */
  provider: Backend;
  /** True when a WebGPU session-creation failure forced us down to WASM. */
  usedFallback: boolean;
  /** True when no further attempt is possible; the caller must throw. */
  exhausted: boolean;
}

export function resolveBackend(probed: Backend, outcome: SessionOutcome): BackendDecision {
  if (probed === 'webgpu') {
    return outcome === 'ok'
      ? { provider: 'webgpu', usedFallback: false, exhausted: false }
      // The double-safety the brief calls for: the probe can be optimistic
      // and session creation still fail on a specific driver or model op.
      : { provider: 'wasm', usedFallback: true, exhausted: false };
  }

  return {
    provider: 'wasm',
    usedFallback: false,
    exhausted: outcome === 'failed',
  };
}
