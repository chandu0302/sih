/**
 * SIH 26171 — model registry.
 *
 * One place that knows what a model IS, so no other module hardcodes a URL,
 * an input tensor name, or a letterbox size. Track 2 (face) and Track 3 (NER)
 * fill their entries in later briefs; the shape is fixed now so those briefs
 * add data, not structure.
 *
 * Field values are deliberately left as stubs rather than guessed. A wrong
 * `inputName` fails at session.run() with an unhelpful message, and a wrong
 * `inputSize` produces boxes that are subtly misaligned rather than absent —
 * the expensive kind of wrong. Both must come from actually inspecting the
 * .onnx file (Netron, or ort's session.inputNames after a successful load).
 */

/** Which runtime consumes this model. See webgpu.ts for why both share a probe. */
export type ModelRuntime = 'onnx' | 'transformers';

export interface ModelSpec {
  /** Logical name, e.g. 'yolo-face'. Also the session-cache key. */
  id: string;
  /**
   * Where to fetch the .onnx from.
   *
   * MV3: this must resolve to a bundled asset, not a CDN — remote code is
   * blocked. Use chrome.runtime.getURL('models/<file>.onnx') at call time
   * rather than baking an absolute chrome-extension:// URL in here, since the
   * extension id differs between unpacked dev loads and a packed build.
   */
  url: string;
  /** ONNX input tensor name, e.g. 'images'. Read it off the model, do not assume. */
  inputName: string;
  /** Square input edge in pixels, e.g. 640 for YOLO. */
  inputSize: number;
  /**
   * Which runtime loads it. onnx-loader.ts handles 'onnx'; transformers.js
   * models are loaded by Track 3's own loader but share the backend probe.
   */
  runtime: ModelRuntime;
}

/**
 * Registered models, keyed by id.
 *
 * Empty until Track 2 and Track 3 land. Typed as Record<string, ModelSpec> per
 * the brief; getModel() below is what callers should use, so an unregistered
 * id fails loudly at the lookup rather than as `undefined.inputName` three
 * frames deeper.
 */
export const MODELS: Record<string, ModelSpec> = {
  // Track 2 fills this in:
  // 'yolo-face': {
  //   id: 'yolo-face',
  //   url: chrome.runtime.getURL('models/yolov8n-face.onnx'),
  //   inputName: 'images',
  //   inputSize: 640,
  //   runtime: 'onnx',
  // },
};

/** Registered model ids. Handy for a warm-up pass or a diagnostics panel. */
export function modelIds(): string[] {
  return Object.keys(MODELS);
}

/**
 * Look up a spec, failing loudly on an unknown id.
 *
 * Throws rather than returning undefined: every caller would immediately have
 * to handle the undefined case, and a typo'd id is a programming error we want
 * surfaced at the call site, not a silent no-detection result that looks like
 * a model that simply found nothing.
 */
export function getModel(id: string): ModelSpec {
  const spec = MODELS[id];
  if (!spec) {
    const known = modelIds().join(', ') || '<registry is empty>';
    throw new Error(`Unknown model id "${id}". Registered: ${known}`);
  }
  return spec;
}
