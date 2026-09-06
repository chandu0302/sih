/**
 * SIH 26171 — Track 3 4a: MeridianPII NER integration proof (transformers.js).
 *
 * Scope of 4a is narrow on purpose: prove `plingampally/meridianpii-hi-v2`
 * loads and runs IN THE SIDE PANEL, from BUNDLED LOCAL FILES, under the MV3
 * CSP, on WebGPU with a WASM fallback — and returns labeled spans for a
 * hardcoded string. No DOM, no premasking, no coordinate boxing — that is 4b.
 * See runNerSelfTest() at the bottom; Step 8 of the brief is the real gate.
 *
 * WHY A SEPARATE RUNTIME FROM TRACK 2: transformers.js bundles its OWN
 * onnxruntime-web (currently 1.26.0-dev, vs Track 2's pinned 1.29.0 — see
 * build.mjs). It is not the loadOnnxSession/model-registry path; it has its
 * own env config, its own wasm dir (public/ort-tfjs/, not public/ort/), and
 * its own local-model resolution. Mixing the two wasm sets is the kind of
 * wrong that fails silently until the first real inference.
 *
 * MODEL FACTS (from the model card, verified — not re-derived here):
 *   plingampally/meridianpii-hi-v2, CC BY 4.0, base MiniLM (Apache-2.0),
 *   derived from Rampart (CC BY 4.0). dtype 'q8' -> onnx/model_quantized.onnx
 *   (INT8, ~55MB). Confidence floor 0.15, NOT Track 2's 0.4 — INT8
 *   quantization flattens scores, so the same threshold would drop real hits.
 *   17 labels; EMAIL/URL/TAX_ID/ROUTING_NUMBER are premasked upstream by
 *   Track 1 in the real pipeline (4b) — this module still maps them in case
 *   classifyText is ever called on unmasked text (e.g. this self-test).
 */

import { env, pipeline, type TokenClassificationPipeline } from '@huggingface/transformers';
import type { NerSpan, PiiType } from '../types';

/** Below this score, INT8 noise is more likely than a real entity. */
const SCORE_FLOOR = 0.15;

/**
 * chrome.runtime.getURL resolves relative to the extension id, which only
 * exists in a real extension context. Same guard as model-registry.ts's
 * extensionUrl, so this module imports cleanly under plain node/vitest.
 */
function safeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

let envConfigured = false;

/** Idempotent, called once before any pipeline() call. */
function configureTransformersEnv(): void {
  if (envConfigured) return;
  envConfigured = true;

  // Privacy + demo reliability: this must never reach out to HF at runtime.
  // A remote fetch would also just fail under MV3's CSP/host permissions.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = safeUrl('models/');

  // The model files are bundled chrome-extension:// assets, not network
  // fetches — there is nothing for the browser Cache API to usefully cache,
  // and the Cache API's put() rejects the chrome-extension: scheme outright
  // (observed: "Unable to add response to browser cache ... scheme
  // 'chrome-extension' is unsupported"). transformers.js catches that
  // failure internally and continues, but it is a real error every load;
  // disabling it here is honest about what's actually happening rather than
  // suppressing symptom noise.
  env.useBrowserCache = false;

  // env.backends.onnx is typed as Partial<Env>, but wasm is always populated
  // by transformers.js's own env.js at import time; the guard is only to
  // satisfy the optional type, not a real runtime possibility.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    // Track 2's public/ort/ is a DIFFERENT onnxruntime-web version — do not
    // point here at it. See build.mjs's copyTransformersOrtBinaries().
    wasm.wasmPaths = safeUrl('ort-tfjs/');
    // No cross-origin isolation in MV3 extension pages => no
    // SharedArrayBuffer => the threaded build cannot spawn its worker pool
    // above 1 thread.
    wasm.numThreads = 1;
  }
}

const MODEL_ID = 'plingampally/meridianpii-hi-v2';

/**
 * In-flight/completed pipeline load. The PROMISE is cached, not the
 * pipeline, so concurrent callers await the same load instead of each
 * triggering their own ~55MB fetch — same reasoning as onnx-loader.ts's
 * `sessions` map.
 */
let pipelinePromise: Promise<TokenClassificationPipeline> | null = null;

/**
 * Load (or return the in-flight load of) the NER pipeline. Tries WebGPU
 * first; on ANY failure, logs and retries on WASM. WebGPU support for this
 * BERT/token-classification architecture in transformers.js is unconfirmed
 * going into this brief — that is exactly what Step 8 exists to determine.
 */
function loadNerPipeline(): Promise<TokenClassificationPipeline> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = createPipeline().catch((err) => {
    // Do not poison the cache: a transient failure should not permanently
    // fail every later call for the life of the panel.
    pipelinePromise = null;
    throw err;
  });

  return pipelinePromise;
}

async function createPipeline(): Promise<TokenClassificationPipeline> {
  configureTransformersEnv();

  try {
    const pipe = await pipeline('token-classification', MODEL_ID, {
      dtype: 'q8',
      device: 'webgpu',
    });
    console.log('[SIH] NER backend: webgpu');
    fixTokenizerMaxLength(pipe);
    return pipe as unknown as TokenClassificationPipeline;
  } catch (err) {
    console.warn('[SIH] NER webgpu pipeline failed; retrying on wasm', err);
    const pipe = await pipeline('token-classification', MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
    });
    console.log('[SIH] NER backend: wasm');
    fixTokenizerMaxLength(pipe);
    return pipe as unknown as TokenClassificationPipeline;
  }
}

/** The tokenizer's own getter reads this if the config didn't ship one. */
const FALLBACK_MAX_LENGTH = 512;

/**
 * VERIFIED BUG in the bundled model assets: tokenizer_config.json ships
 * `model_max_length: 1e30` (the HF-default "unbounded" sentinel — an
 * artifact of the model conversion, not a code bug), while config.json's
 * `max_position_embeddings` is the model's real limit (512, for this MiniLM
 * base). `tokenizer.model_max_length` is a GETTER with no public setter
 * (see transformers.js's tokenization_utils.js) that reads straight from
 * that broken config value.
 *
 * Why this matters: TokenClassificationPipeline._call() always tokenizes
 * with `{ padding: true, truncation: true }` and no explicit `max_length`,
 * so `truncation: true` silently does nothing — the pipeline call has no
 * way to override it. A page whose assembled visible text exceeds 512 real
 * tokens (easily reached by a form with a dozen-plus fields) is NOT
 * truncated; it crashes the whole NER track with an ONNX Runtime broadcast
 * error on the position-embedding Add node, taking down Track 3 entirely
 * instead of degrading to "processed the first 512 tokens."
 *
 * Model assets are gitignored + staged (see ARCHITECTURE.md) — editing the
 * JSON file on disk would not survive a re-stage, so the fix lives here
 * instead, applied once per pipeline load, reading the model's own
 * max_position_embeddings so it self-corrects if the model is ever swapped.
 */
export function fixTokenizerMaxLength(pipe: unknown): void {
  const p = pipe as {
    tokenizer?: { _tokenizerConfig?: Record<string, unknown> };
    model?: { config?: { max_position_embeddings?: number } };
  };

  const tokenizerConfig = p.tokenizer?._tokenizerConfig;
  if (!tokenizerConfig) {
    console.warn('[SIH] Could not access tokenizer config to cap model_max_length.');
    return;
  }

  const maxPositions = p.model?.config?.max_position_embeddings ?? FALLBACK_MAX_LENGTH;
  tokenizerConfig.model_max_length = maxPositions;
}

/**
 * Moved to types.ts in 4c: NerSpan crosses the panel -> content script
 * message boundary (NER_BOX_REQUEST) as of this brief, which makes it a
 * shared-contract DTO rather than a model-only shape. Re-exported here so
 * existing importers (ner-track.ts, this file's own test) don't need to
 * change their import path. See types.ts for the full doc comment —
 * including why char offsets are always null.
 */
export type { NerSpan };

/**
 * Model entity_group -> our PiiType, or null to DROP.
 *
 * Pure: no model, no I/O. Two reasons a label maps to null, both
 * deliberate, not omissions:
 *   - CITY/STATE/ZIP_CODE are a KEEP-set — the model found them, but they are
 *     not redacted (an address's city is usually not sensitive on its own).
 *   - An unrecognized label means the model or its config drifted from what
 *     this file expects; guessing a PiiType for it would silently misclassify
 *     rather than surface the drift.
 */
export function mapNerLabel(entityGroup: string): PiiType | null {
  switch (entityGroup) {
    case 'GIVEN_NAME':
    case 'SURNAME':
      return 'NAME';
    case 'PHONE':
      return 'PHONE';
    case 'EMAIL':
      return 'EMAIL';
    case 'URL':
      return 'URL';
    case 'TAX_ID':
    case 'BANK_ACCOUNT':
    case 'ROUTING_NUMBER':
    case 'GOVERNMENT_ID':
    case 'PASSPORT':
    case 'DRIVERS_LICENSE':
      return 'ID_NUMBER';
    case 'BUILDING_NUMBER':
    case 'STREET_NAME':
    case 'SECONDARY_ADDRESS':
      return 'ADDRESS';
    case 'CITY':
    case 'STATE':
    case 'ZIP_CODE':
      return null; // keep-set: detected, NOT redacted
    default:
      return null; // unknown label -> drop, don't guess
  }
}

/**
 * One raw pipeline result, grouped (aggregation_strategy: 'simple').
 * These three fields are exactly what groupEntities() emits — no more.
 */
interface RawEntity {
  entity_group: string;
  score: number;
  word: string;
}

/**
 * Score-floor + label-map + null-drop, factored out of classifyText so it
 * can be unit-tested against a hand-built array without calling the model.
 */
export function filterEntities(entities: RawEntity[], scoreFloor: number = SCORE_FLOOR): NerSpan[] {
  const spans: NerSpan[] = [];

  for (const e of entities) {
    if (e.score < scoreFloor) continue;

    const piiType = mapNerLabel(e.entity_group);
    if (!piiType) continue;

    spans.push({
      piiType,
      word: e.word,
      start: null,
      end: null,
      score: e.score,
      label: e.entity_group,
    });
  }

  return spans;
}

/**
 * Run the NER pipeline on `text` and return score-filtered, mapped spans in
 * char-offset space. NFC-normalized first — NFKD strips Devanagari matras
 * and would corrupt Hindi text, so NFC is the only normalization ever
 * applied here.
 */
export async function classifyText(text: string): Promise<NerSpan[]> {
  const pipe = await loadNerPipeline();
  const normalized = text.normalize('NFC');

  const raw = (await pipe(normalized, {
    aggregation_strategy: 'simple',
  })) as unknown as RawEntity[];

  return filterEntities(raw);
}

/**
 * Fire-and-forget warm-up: triggers the pipeline load when the panel opens,
 * so the ~55MB model + WebGPU/WASM session instantiation doesn't land on
 * the first real capture. Mirrors face-detector.ts's warmFaceModel.
 */
export function warmNerModel(): Promise<void> {
  return loadNerPipeline().then(() => undefined);
}

/**
 * Hardcoded cross-script fixture: a Devanagari name + phone, AND a
 * Latin-script Indian name + email in the same string, so opening the panel
 * visibly proves BOTH scripts are covered, not just Devanagari. Verified
 * against the real weights in Node (see the 4a-fix coverage report) —
 * expect GIVEN_NAME/SURNAME on "प्रिया"/"शर्मा" AND on "Rahul"/"Verma",
 * PHONE on the number. The email's local part ("rahul") typically also
 * surfaces as a spurious GIVEN_NAME fragment — expected, not a bug: this
 * model never tags EMAIL itself (that's Track 1's regex job upstream).
 */
const SELF_TEST_TEXT =
  'प्रिया शर्मा, फ़ोन 9876543210 — my name is Rahul Verma, email rahul@example.com';

/**
 * Runs classifyText on a hardcoded string and logs spans + backend +
 * latency. This IS the acceptance instrument for 4a (Step 8) — wired into
 * the panel's mount effect rather than deferred, per Brief 3's lesson that a
 * proof left unwired doesn't get proven.
 */
export async function runNerSelfTest(): Promise<void> {
  const started = performance.now();
  const spans = await classifyText(SELF_TEST_TEXT);
  const ms = Math.round(performance.now() - started);

  console.log(`[SIH] NER self-test: ${spans.length} span(s) in ${ms}ms`);
  for (const span of spans) {
    console.log(
      `[SIH]   ${span.label} -> ${span.piiType} "${span.word}" (${span.score.toFixed(3)})`,
    );
  }
}
