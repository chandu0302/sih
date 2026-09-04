/**
 * SIH 26171 — Track 2 face detection (YOLOv11n-face via ONNX Runtime Web).
 *
 * Proves the ONNX loader stack end-to-end: WASM under the MV3 CSP, the
 * WebGPU/JSEP path, and the IndexedDB weight cache, by landing one real face
 * box on a real screenshot. See the acceptance steps in the brief for the
 * two-machine browser verification — that, not this file, is the real gate.
 *
 * MODEL, CONFIRMED BY INSPECTION (not assumed — see model-registry.ts):
 *   input  'images'   float32 [1, 3, 640, 640], NCHW RGB, /255 normalized.
 *   output 'output0'  float32 [1, 5, 8400] — [cx, cy, w, h, faceScore] per
 *     anchor, coords in 640-space, score already sigmoid'd (checked: max
 *     score on an all-grey 640x640 input was ~5e-5, not a large logit). No
 *     baked-in NMS node — done here in TS.
 *
 * PIPELINE: letterbox -> tensor -> session.run -> decode -> NMS ->
 * modelBoxToImageBox -> clampToImage. The letterbox `{ scale, padX, padY }`
 * computed in step 1 is threaded verbatim into modelBoxToImageBox in the last
 * step — recomputing it independently is the classic way to introduce a
 * padding sign bug that silently misaligns every box.
 */

import * as ort from 'onnxruntime-web';
import { clampToImage, iou, modelBoxToImageBox, type CoordinateFrame } from '../lib/coords';
import { getModel } from '../models/model-registry';
import { loadOnnxSession } from '../models/onnx-loader';
import type { DetectedBox, ImageBox } from '../types';

const MODEL_ID = 'yolov11n-face';

/** Score threshold below which an anchor is discarded. Tunable. */
const CONF = 0.4;

/** IoU threshold above which two overlapping boxes are treated as duplicates. */
const NMS_IOU = 0.45;

/** Letterbox grey padding value, matching Ultralytics' own preprocessing. */
const PAD_VALUE = 114;

/** The three numbers modelBoxToImageBox needs to invert the letterbox. */
export interface LetterboxParams {
  /** image-pixels -> model-pixels scale factor. */
  scale: number;
  /** Grey padding added on each axis, in model pixels. */
  padX: number;
  padY: number;
}

export interface LetterboxResult extends LetterboxParams {
  /** RGB, NCHW, /255-normalized, shape [1, 3, size, size]. */
  data: Float32Array;
}

/**
 * Pure geometry: how a `srcW x srcH` image maps into a `size x size`
 * letterboxed square. Split out from letterbox() so it can be unit-tested
 * without a real canvas/ImageBitmap.
 */
export function computeLetterboxParams(
  srcW: number,
  srcH: number,
  size: number,
): LetterboxParams {
  const scale = Math.min(size / srcW, size / srcH);
  const resizedW = Math.round(srcW * scale);
  const resizedH = Math.round(srcH * scale);
  const padX = (size - resizedW) / 2;
  const padY = (size - resizedH) / 2;

  return { scale, padX, padY };
}

/**
 * Scale `image` to fit `size x size` preserving aspect ratio, grey-pad the
 * remainder, and return both the NCHW tensor data and the exact params used
 * — the same object modelBoxToImageBox must invert with, never recomputed.
 */
export function letterbox(image: ImageBitmap, size: number): LetterboxResult {
  const params = computeLetterboxParams(image.width, image.height, size);
  const resizedW = Math.round(image.width * params.scale);
  const resizedH = Math.round(image.height * params.scale);

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2d context for letterbox canvas.');

  ctx.fillStyle = `rgb(${PAD_VALUE}, ${PAD_VALUE}, ${PAD_VALUE})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, image.width, image.height, params.padX, params.padY, resizedW, resizedH);

  const { data: rgba } = ctx.getImageData(0, 0, size, size);
  const data = new Float32Array(3 * size * size);
  const plane = size * size;

  for (let i = 0; i < plane; i++) {
    const o = i * 4;
    data[i] = rgba[o] / 255; // R
    data[plane + i] = rgba[o + 1] / 255; // G
    data[2 * plane + i] = rgba[o + 2] / 255; // B
  }

  return { data, ...params };
}

/**
 * One decoded, unfiltered detection in model-pixel (640) space, cxcywh
 * already converted to xywh.
 */
interface RawDetection {
  box: ImageBox;
  score: number;
}

/**
 * Decode raw model output into score-filtered, xywh detections in
 * model-pixel space. Handles both [1, 5, K] and [1, K, 5] layouts — the axis
 * of length 5 (cx, cy, w, h, score) is detected rather than assumed.
 */
export function decodeOutput(
  output: Float32Array,
  dims: readonly number[],
  conf: number = CONF,
): RawDetection[] {
  const [d0, d1] = dims.length === 3 ? [dims[1], dims[2]] : [dims[0], dims[1]];
  const rowMajor = d0 === 5; // [5, K]: anchor stride 1, channel stride K
  const numAnchors = rowMajor ? d1 : d0;

  const detections: RawDetection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    const at = (channel: number): number =>
      rowMajor ? output[channel * numAnchors + a] : output[a * 5 + channel];

    const score = at(4);
    if (score < conf) continue;

    const cx = at(0);
    const cy = at(1);
    const w = at(2);
    const h = at(3);

    detections.push({
      box: { x: cx - w / 2, y: cy - h / 2, w, h },
      score,
    });
  }

  return detections;
}

/** Greedy NMS, highest score first, using coords.ts's iou(). */
export function nms(detections: RawDetection[], iouThreshold: number = NMS_IOU): RawDetection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: RawDetection[] = [];

  for (const candidate of sorted) {
    const overlapsKept = kept.some((k) => iou(k.box, candidate.box) > iouThreshold);
    if (!overlapsKept) kept.push(candidate);
  }

  return kept;
}

/** Extract output0's data + dims from a session.run() result, runtime-agnostic. */
function readOutput(outputs: ort.InferenceSession.OnnxValueMapType): {
  data: Float32Array;
  dims: readonly number[];
} {
  const tensor = outputs.output0;
  if (!tensor || !(tensor.data instanceof Float32Array)) {
    throw new Error('Unexpected face model output: missing or non-float32 "output0".');
  }
  return { data: tensor.data, dims: tensor.dims };
}

/**
 * Run YOLOv11n-face on `image` and return image-pixel-space FACE detections.
 *
 * `frame` must describe THIS image — its dimensions are only used to clamp
 * boxes to the image bounds via coords.ts's clampToImage.
 */
export async function detectFaces(
  image: ImageBitmap,
  frame: CoordinateFrame,
): Promise<DetectedBox[]> {
  const spec = getModel(MODEL_ID);
  const session = await loadOnnxSession(spec);

  const lb = letterbox(image, spec.inputSize);
  const tensor = new ort.Tensor('float32', lb.data, [1, 3, spec.inputSize, spec.inputSize]);
  const outputs = await session.run({ [spec.inputName]: tensor });

  const { data, dims } = readOutput(outputs);
  const survivors = nms(decodeOutput(data, dims));

  const boxes: DetectedBox[] = [];
  for (const { box, score } of survivors) {
    const imageBox = clampToImage(modelBoxToImageBox(box, lb), frame);
    if (!imageBox) continue;

    boxes.push({
      imageBox,
      piiType: 'FACE',
      confidence: score,
      source: 'FACE_MODEL',
    });
  }

  return boxes;
}

/**
 * Fire-and-forget warm-up: triggers the (potentially multi-second) JSEP/WASM
 * session instantiation when the panel opens, so it doesn't land on the
 * first real capture. Call site is a later brief.
 */
export function warmFaceModel(): Promise<void> {
  return loadOnnxSession(getModel(MODEL_ID)).then(() => undefined);
}
