/**
 * SIH 26171 — Phase 3c: redaction manifest.
 *
 * Pure mapping from the merged detections already computed for the overlay
 * (App.tsx's `detections` state) into the manifest shape Phase 4 will
 * eventually consume. No new detection pass — the boxes already exist.
 *
 * Deliberately drops DetectedBox.text: the manifest is what leaves the
 * client, and the matched PII text must never travel with it (mirrors
 * dom-track.ts's own rule for attribute hits — "record WHERE it is, never
 * WHAT it is").
 */
import type { DetectedBox, RedactionManifest } from '../types';

export function buildRedactionManifest(boxes: DetectedBox[]): RedactionManifest {
  return {
    regions: boxes.map((box) => ({
      type: box.piiType,
      bbox: box.imageBox,
      nodeId: box.nodeId,
      confidence: box.confidence,
    })),
  };
}
