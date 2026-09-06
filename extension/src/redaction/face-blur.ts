/**
 * SIH 26171 — Phase 3b: face redact-after-capture.
 *
 * Faces can only be located in pixels, so — unlike Phase 3a's text masking —
 * this runs AFTER captureVisibleTab, blurring the already text-masked
 * screenshot bitmap in place. `faceBoxes` arrive in image-pixel space
 * (coords.ts's canonical space, from face-detector.ts's detectFaces()) —
 * the same space the bitmap itself is in, so no conversion is needed here.
 *
 * computeBlurRect is split out as pure geometry (mirrors face-detector.ts's
 * own split of computeLetterboxParams from letterbox()) so the padding /
 * clamping math is unit-testable without an OffscreenCanvas or ImageBitmap,
 * neither of which exist in the Node test environment. blurFaces() itself is
 * verified in-browser (MVP blocker #4), same as letterbox().
 */
import type { DetectedBox, ImageBox } from '../types';

/** Extra coverage beyond the tight model box — ears/hairline/jaw sit just
 *  outside YOLO's tight face box, and redaction is scored on whether
 *  identity is actually obscured, not on box tightness. */
const PAD_FRACTION = 0.25;

/** Gaussian blur radius, in image pixels. */
const BLUR_PX = 18;

/**
 * Pad `box` by `padFraction` of its own width/height, then clamp to the
 * image bounds. Returns null if the padded box has no area left inside the
 * image (should not happen for a box that already survived coords.ts's
 * clampToImage, but this file does not assume its caller did that).
 */
export function computeBlurRect(
  box: ImageBox,
  imageWidth: number,
  imageHeight: number,
  padFraction: number = PAD_FRACTION,
): ImageBox | null {
  const padX = box.w * padFraction;
  const padY = box.h * padFraction;

  const x0 = Math.max(0, Math.floor(box.x - padX));
  const y0 = Math.max(0, Math.floor(box.y - padY));
  const x1 = Math.min(imageWidth, Math.ceil(box.x + box.w + padX));
  const y1 = Math.min(imageHeight, Math.ceil(box.y + box.h + padY));

  if (x1 <= x0 || y1 <= y0) return null;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Blur every face region on `image` and return the result as a data URL.
 * `image` itself is untouched — a fresh canvas is drawn and returned.
 */
export async function blurFaces(image: ImageBitmap, faceBoxes: DetectedBox[]): Promise<string> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2d context for face-blur canvas.');

  ctx.drawImage(image, 0, 0);

  for (const box of faceBoxes) {
    const rect = computeBlurRect(box.imageBox, image.width, image.height);
    if (!rect) continue;

    // Draw the region over itself with a blur filter applied. Canvas buffers
    // the source before writing, so this in-place redraw is safe (the
    // standard technique for a localized canvas blur — see MDN's
    // CanvasRenderingContext2D.filter examples).
    ctx.save();
    ctx.filter = `blur(${BLUR_PX}px)`;
    ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error as DOMException);
    reader.readAsDataURL(blob);
  });
}
