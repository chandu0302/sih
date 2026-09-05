/**
 * SIH 26171 — Phase 2 box merger.
 *
 * Combines the three tracks' DetectedBox[] (DOM/regex, face model, NER
 * model) into one list for the unified overlay. The only real question is
 * what counts as a duplicate.
 *
 * IOU-ONLY DEDUPE, REGARDLESS OF PiiType — the deliberate choice here.
 * Two tracks can box the SAME PII (Track 1's phone regex and Track 3's NER
 * pass both firing on a number premask missed), and those must collapse to
 * one box. But a FACE box and a NAME box can also coincidentally overlap
 * (a name printed under a photo) without being the same detection at all.
 * A type-aware rule would get the second case right and the first case
 * wrong just as often — the two cases are geometrically indistinguishable
 * without deeper reasoning this merger doesn't have.
 *
 * The rule that stays correct in the case that actually matters: this
 * merger feeds REDACTION, not classification. Redaction only cares whether
 * a region of pixels is already going to be covered — a covered pixel is
 * covered, regardless of which track's idea of "why" wins. So: dedupe on
 * IoU alone. The kept box's piiType/source are whichever survives (highest
 * confidence), which is also the most defensible LABEL to show, even though
 * it may erase a second, differently-typed reason the same pixels are
 * sensitive. Accepted trade-off, not an oversight.
 */

import { iou } from '../lib/coords';
import type { DetectedBox } from '../types';

/** Two boxes overlapping above this are the same redaction target. */
const IOU_THRESHOLD = 0.5;

/**
 * Greedy IoU dedupe, highest confidence first (same algorithm shape as
 * face-detector.ts's nms(), one level up: across tracks instead of across
 * one model's anchors).
 *
 * A box is kept only if its IoU with EVERY already-kept box is at or below
 * the threshold — checked against the kept set as it grows, not against the
 * full input in one pass. That is what makes this greedy rather than a
 * single clustering pass: two boxes that both narrowly miss a strong
 * overlap with the top box, but that ARE strong overlaps with EACH OTHER,
 * still correctly collapse to one, because the second one entering the
 * kept set blocks the third.
 */
export function mergeDetections(
  boxes: DetectedBox[],
  iouThreshold: number = IOU_THRESHOLD,
): DetectedBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedBox[] = [];

  for (const candidate of sorted) {
    const overlapsKept = kept.some(
      (k) => iou(k.imageBox, candidate.imageBox) > iouThreshold,
    );
    if (!overlapsKept) kept.push(candidate);
  }

  return kept;
}
