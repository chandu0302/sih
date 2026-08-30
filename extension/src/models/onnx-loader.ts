/**
 * SIH 26171 — ONNX InferenceSession loader (Track 2's raw-ONNX path).
 *
 * Flow: IndexedDB cache -> fetch on miss -> probe backend -> create session on
 * WebGPU -> on ANY session-creation failure, retry on WASM.
 *
 * ============================================================================
 * MANUAL BROWSER VERIFICATION REQUIRED
 * ============================================================================
 * The unit tests here cover the fallback DECISION (webgpu.test.ts) and nothing
 * else. Mocking InferenceSession would only assert that a mock behaves like a
 * mock. The following must be checked by hand in a real Chrome, with the
 * extension loaded unpacked and DevTools open ON THE SIDE PANEL (right-click
 * the panel -> Inspect; the service worker console will NOT show these logs):
 *
 *   1. WEBGPU PATH LOADS
 *      On a WebGPU-capable machine, expect `[SIH] backend: webgpu` followed by
 *      `[SIH] model <id> ready on webgpu`. Confirm in chrome://gpu that WebGPU
 *      is actually hardware-backed and not falling back to SwiftShader, which
 *      reports as usable but is slower than WASM.
 *
 *   2. WASM FALLBACK TRIGGERS
 *      Launch Chrome with --disable-features=WebGPU (or flip
 *      chrome://flags#enable-unsafe-webgpu off) and reload. Expect
 *      `[SIH] backend: wasm` and a session that still loads.
 *      Then test the OTHER fallback path, which is the one the probe cannot
 *      predict: force session creation to fail on WebGPU while the probe still
 *      says webgpu (easiest with a model using an op the JSEP backend does not
 *      implement). Expect `[SIH] webgpu session failed; retrying on wasm`.
 *      These two are genuinely different code paths — verify both.
 *
 *   3. INDEXEDDB CACHE HIT ON SECOND LOAD
 *      First open: Network tab shows the .onnx fetch, console shows
 *      `[SIH] model <id> downloaded (N bytes)`. Close and reopen the panel:
 *      NO network request for the .onnx, and `[SIH] model <id> cache hit`.
 *      Inspect Application -> IndexedDB -> sih-models -> weights to confirm.
 *      Also verify the quota path: fill the origin quota and confirm the model
 *      still loads (re-downloading) rather than erroring.
 *
 *   4. CONCURRENT COLD START
 *      Call loadOnnxSession twice in the same tick on a cold cache. Exactly one
 *      network request should appear — the promise cache must dedupe them.
 *
 * ============================================================================
 * MV3 GOTCHAS — READ BEFORE THE FIRST BROWSER RUN
 * ============================================================================
 * These are outside this brief's file scope (src/models/ only) and are NOT
 * done. Nothing below will work in a real extension until they are:
 *
 *   A. manifest.json NEEDS 'wasm-unsafe-eval'.
 *      MV3's default extension-page CSP is `script-src 'self'; object-src
 *      'self'`, which blocks WebAssembly compilation outright. ORT's WASM
 *      backend — and the JSEP/WebGPU build, which is also WASM underneath —
 *      will fail with a CSP error. Add:
 *        "content_security_policy": {
 *          "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
 *        }
 *      This affects BOTH backends, so it is not optional even on a WebGPU box.
 *
 *   B. THE .wasm/.mjs BINARIES MUST BE BUNDLED, NOT FETCHED FROM A CDN.
 *      ORT defaults wasmPaths to a jsDelivr URL. MV3 blocks remote code, so
 *      that 404s-by-policy. Copy from node_modules/onnxruntime-web/dist/ into
 *      extension/public/ort/ (build.mjs already copies public/ to dist/ root):
 *        ort-wasm-simd-threaded.wasm       + .mjs   (WASM backend)
 *        ort-wasm-simd-threaded.jsep.wasm  + .mjs   (WebGPU/JSEP backend)
 *      Both pairs are needed — the fallback path is useless if only the JSEP
 *      build ships. configureOrtEnv() below points wasmPaths at them.
 *
 *   C. numThreads MUST BE 1.
 *      ORT 1.29 ships only the "-threaded" binaries, but the threading is
 *      opt-in at runtime: with numThreads > 1 it needs SharedArrayBuffer,
 *      which requires cross-origin isolation (COOP/COEP). Extension pages are
 *      not cross-origin isolated, so anything above 1 fails to spawn its
 *      worker pool. Pinned to 1 below; the binary itself is fine.
 *
 *   D. THIS MUST RUN IN THE SIDE PANEL, NOT THE SERVICE WORKER.
 *      WebGPU needs a document context; a worker has no navigator.gpu, so
 *      detectBackend() there silently returns 'wasm' — correct-looking and
 *      wrong. MV3 workers are also killed after ~30s idle, which would evict
 *      a multi-MB session mid-use.
 *
 *   E. web_accessible_resources is NOT needed for these assets.
 *      The side panel is an extension page loading same-origin
 *      chrome-extension:// URLs. WAR is only required for assets a content
 *      script pulls into a page context.
 */

import * as ort from 'onnxruntime-web';
import { cacheModel, getCachedModel } from './cache';
import type { ModelSpec } from './model-registry';
import { detectBackend, resolveBackend } from './webgpu';

/**
 * Directory inside the built extension holding ORT's .wasm/.mjs files.
 * Mirrors extension/public/ort/ -> dist/ort/. See gotcha (B).
 */
const ORT_ASSET_DIR = 'ort/';

let envConfigured = false;

/**
 * Point ORT at the bundled WASM assets and pin the settings MV3 requires.
 *
 * Idempotent: ort.env is global, and re-assigning it after a session exists
 * has no effect on that session, so first-call-wins is the honest behaviour.
 *
 * Exported because Track 3's transformers.js loader must apply the SAME
 * settings — transformers.js drives onnxruntime-web underneath and reads the
 * same global env. If it configures a different wasmPaths, whichever runs
 * second silently wins. Call this from both.
 */
export function configureOrtEnv(): void {
  if (envConfigured) return;
  envConfigured = true;

  // chrome.runtime.getURL resolves to chrome-extension://<id>/ort/, which
  // differs between an unpacked dev load and a packed build — so it must be
  // computed at runtime, never hardcoded. Guarded so this module can be
  // imported in a test/node context without a chrome global.
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL(ORT_ASSET_DIR);
  }

  // Gotcha (C): no cross-origin isolation in extension pages => no
  // SharedArrayBuffer => the threaded build cannot instantiate.
  ort.env.wasm.numThreads = 1;

  // Proxying to a worker would need a separate bundled worker file and buys
  // nothing here: the side panel does not paint while inference runs anyway.
  ort.env.wasm.proxy = false;
}

/**
 * In-flight and completed loads, keyed by spec.id.
 *
 * The PROMISE is cached, not the resolved session. Caching the session would
 * still let two concurrent cold-start callers both miss the cache and both
 * download several MB. Storing the promise means the second caller awaits the
 * first one's work.
 */
const sessions = new Map<string, Promise<ort.InferenceSession>>();

/** Load (or return the in-flight load of) a model's inference session. */
export function loadOnnxSession(spec: ModelSpec): Promise<ort.InferenceSession> {
  const existing = sessions.get(spec.id);
  if (existing) return existing;

  const pending = createSession(spec).catch((err) => {
    // A failed load must not poison the cache — otherwise every later attempt
    // returns the same rejected promise and a transient network blip becomes
    // permanent for the life of the panel.
    sessions.delete(spec.id);
    throw err;
  });

  sessions.set(spec.id, pending);
  return pending;
}

async function createSession(spec: ModelSpec): Promise<ort.InferenceSession> {
  configureOrtEnv();

  const weights = await fetchWeights(spec);
  const probed = await detectBackend();

  try {
    const session = await ort.InferenceSession.create(weights, {
      executionProviders: [probed],
      graphOptimizationLevel: 'all',
    });
    console.log(`[SIH] model ${spec.id} ready on ${probed}`);
    return session;
  } catch (err) {
    const decision = resolveBackend(probed, 'failed');

    // Gotcha: the probe said WebGPU was available and session creation still
    // failed — an unsupported op, a driver bug, an OOM on a small GPU. This is
    // exactly why the probe alone is insufficient.
    if (decision.exhausted) {
      console.error(`[SIH] model ${spec.id} failed on wasm; no fallback left`, err);
      throw err;
    }

    console.warn(`[SIH] webgpu session failed; retrying on ${decision.provider}`, err);
    const session = await ort.InferenceSession.create(weights, {
      executionProviders: [decision.provider],
      graphOptimizationLevel: 'all',
    });
    console.log(`[SIH] model ${spec.id} ready on ${decision.provider} (fallback)`);
    return session;
  }
}

/** Cache-first weight retrieval. A cache failure costs a download, nothing more. */
async function fetchWeights(spec: ModelSpec): Promise<ArrayBuffer> {
  const cached = await getCachedModel(spec.url);
  if (cached) {
    console.log(`[SIH] model ${spec.id} cache hit (${cached.byteLength} bytes)`);
    return cached;
  }

  const response = await fetch(spec.url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch model ${spec.id} from ${spec.url}: ${response.status} ${response.statusText}`,
    );
  }

  const buf = await response.arrayBuffer();
  console.log(`[SIH] model ${spec.id} downloaded (${buf.byteLength} bytes)`);

  // Awaited on purpose. It costs cold-start latency on a multi-MB write, but
  // the side panel can be closed at any moment, and an un-awaited write would
  // be abandoned mid-transaction — leaving the cache permanently cold and
  // re-downloading on every open, which is the cost this cache exists to
  // avoid. Safe to await because cacheModel never rejects: a failed write
  // resolves, and we return the buffer we already have either way.
  await cacheModel(spec.url, buf);

  return buf;
}

/** Drop cached sessions. For a diagnostics button, or after clearModelCache(). */
export function resetSessions(): void {
  sessions.clear();
}
