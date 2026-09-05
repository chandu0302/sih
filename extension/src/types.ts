/**
 * SIH 26171 — shared type contract.
 *
 * These types are the interface between the three extension contexts
 * (content script, service worker, side panel). Every later phase adds
 * fields here rather than inventing parallel shapes, so keep this file
 * as the single source of truth.
 *
 * NOTE (Track 3, 4c): CoordinateFrame below is imported type-only from
 * lib/coords, which itself imports types from here type-only. That is a
 * cycle, but an `import type` one — TypeScript erases both sides at compile
 * time, so nothing circular exists in the emitted JS. Flagged since it looks
 * alarming on a dependency graph; it is not a runtime problem.
 */
import type { CoordinateFrame } from './lib/coords';

/** Semantic classes of PII. Unused in Phase 1; fixed now so Phase 2/3 agree. */
export type PiiType =
  | 'FACE'
  | 'PASSWORD'
  | 'CARD'
  | 'ID_NUMBER'
  | 'NAME'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'URL'
  | 'DATE'
  | 'SECRET'
  | 'OTHER';

/** Which detector produced a box. Phase 2. */
export type DetectionSource = 'DOM' | 'FACE_MODEL' | 'NER_MODEL';

/**
 * One NER hit (NOT boxed here — ner-track.ts's spansToBoxes does that).
 *
 * NO CHAR OFFSETS ARE AVAILABLE. transformers.js's TokenClassificationPipeline
 * carries a literal `// TODO: Add support for start and end` where it builds
 * each token, and its groupEntities() returns only `{ entity_group, score,
 * word }`. The `start?`/`end?` in its own .d.ts are aspirational — verified
 * empirically in Node against the real weights (Track 3, 4a). The
 * Rust-backed tokenizer exposes no offset mapping either.
 *
 * `word` is therefore the only anchor ner-track.ts has to work from. Offsets
 * stay on the shape, always null for now, in case a future transformers.js
 * version adds real ones — so a fix would fill them in rather than churn
 * every consumer's type.
 *
 * MOVED HERE IN 4c (was ner-detector.ts): now a cross-boundary DTO — it
 * crosses the panel -> content script message channel in NER_BOX_REQUEST, so
 * it belongs in the shared contract, not a model-only module. Re-exported
 * from ner-detector.ts for existing importers.
 */
export interface NerSpan {
  piiType: PiiType;
  /** The decoded entity text, e.g. 'प्रिया'. Today's only anchor. */
  word: string;
  /** Char offsets into the NFC-normalized input. null until a real one exists. */
  start: number | null;
  end: number | null;
  score: number;
  label: string;
}

/**
 * A rectangle in viewport-relative CSS pixels, exactly as returned by
 * getBoundingClientRect(). NOT image pixels — pass through coords.ts first.
 */
export interface DomRect2D {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A rectangle in captured-image pixel space (the coordinate system of the
 * PNG returned by captureVisibleTab). This is the canonical space that
 * redaction operates in.
 */
export interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One PII detection, already in canonical image-pixel space. Emitted by each
 * detection track (DOM/regex, face model, NER) and merged before redaction.
 */
export interface DetectedBox {
  imageBox: ImageBox;
  piiType: PiiType;
  /** e.g. 'aadhaar', 'pan', 'gstin' — set by the regex track. */
  subtype?: string;
  /** 0–1. */
  confidence: number;
  source: DetectionSource;
  /** Set when found via a DOM element; ties back to SnapshotElement.nodeId. */
  nodeId?: string;
  /** The matched/covered text, for the redaction manifest. */
  text?: string;
}

/**
 * Everything needed to relate CSS pixels to image pixels. Captured in the
 * content script at snapshot time, because the service worker has no
 * `window` and the side panel's `window` is the panel's, not the page's.
 */
export interface ViewportContext {
  /** window.devicePixelRatio — recorded for diagnostics, NOT used to scale. */
  dpr: number;
  /**
   * window.innerWidth/Height — CSS px, INCLUDING classic scrollbars.
   * One of two candidate denominators for the scale calculation.
   */
  innerWidth: number;
  innerHeight: number;
  /**
   * documentElement.clientWidth/Height — CSS px, EXCLUDING classic scrollbars.
   * The other candidate.
   *
   * We record both because whether captureVisibleTab's PNG includes the
   * scrollbar is not something we should assume: it differs with overlay
   * scrollbars (macOS, and Chrome's overlay setting) and has changed across
   * Chrome versions. Picking wrong is a silent ~15px horizontal scale error —
   * exactly the kind of drift that costs redaction-precision marks.
   * createCoordinateFrame() picks between them empirically instead.
   */
  clientWidth: number;
  clientHeight: number;
  scrollX: number;
  scrollY: number;
  /** Page URL at snapshot time — used to detect navigation mid-capture. */
  url: string;
}

/** One salient element from the page. */
export interface SnapshotElement {
  /** Stable within a single snapshot. Redaction manifests and Phase 5
   *  actions reference this instead of re-querying the live DOM. */
  nodeId: string;
  tag: string;
  /** input[type], when present. */
  type?: string;
  /** Explicit or implicit ARIA role. */
  role: string;
  /** Accessible name: aria-label > aria-labelledby > <label> > placeholder > alt > title > text. */
  name: string;
  /** Visible text, truncated. */
  text?: string;
  /** Viewport-relative CSS pixels. */
  rect: DomRect2D;
  /** Best-effort CSS path. Hardened in Phase 5 when we actually click things. */
  selector: string;
  isInteractive: boolean;
}

/** Result of one content-script traversal. */
export interface DomSnapshot {
  elements: SnapshotElement[];
  viewport: ViewportContext;
  /** Wall-clock ms spent traversing. Feeds the client-efficiency metric. */
  traversalMs: number;
  /** True if we hit the element cap and stopped early. */
  truncated: boolean;
}

/**
 * The full Phase 1 payload handed to the side panel.
 * Phase 2 adds `detections`; Phase 3 adds `redactionManifest`.
 */
export interface CapturePayload {
  /** data:image/png;base64,... as returned by captureVisibleTab. */
  screenshotDataUrl: string;
  snapshot: DomSnapshot;
  timings: CaptureTimings;
  /** Set when the page moved between snapshot and capture. See coords.ts. */
  drift: DriftReport | null;
  /**
   * The captured tab's id. Track 3, 4c: the panel talks to the content
   * script directly for NER (sendToContent(tabId, ...)) rather than routing
   * every message through the service worker — this is what makes that
   * possible without adding a NER step to the drift-critical capture
   * sequence in service-worker.ts.
   */
  tabId: number;
}

export interface CaptureTimings {
  injectMs: number;
  snapshotMs: number;
  screenshotMs: number;
  totalMs: number;
}

/**
 * Scroll or navigation between the DOM read and the pixel capture means the
 * two describe different page states, and every downstream box is wrong.
 * We surface it loudly rather than silently emitting misaligned overlays.
 */
export interface DriftReport {
  scrollXDelta: number;
  scrollYDelta: number;
  urlChanged: boolean;
}

/* ------------------------------------------------------------------ */
/* Message protocol                                                    */
/* ------------------------------------------------------------------ */

/** Side panel -> service worker. */
export type PanelRequest = { type: 'CAPTURE_REQUEST' };

/**
 * Service worker -> content script.
 *
 * Track 3, 4c: NER_TEXT_REQUEST/NER_BOX_REQUEST are sent by the PANEL, not
 * the service worker — "ContentRequest" names the recipient, not the
 * sender. The panel has <all_urls> host access, so it can message a tab's
 * content script directly via sendToContent(tabId, ...) without routing
 * through the service worker, keeping the capture sequence untouched.
 */
export type ContentRequest =
  | { type: 'SNAPSHOT_REQUEST' }
  | { type: 'VIEWPORT_PROBE' }
  | { type: 'NER_TEXT_REQUEST' }
  | { type: 'NER_BOX_REQUEST'; spans: NerSpan[]; frame: CoordinateFrame };

/** Content script -> its caller (service worker for the first two, panel for the NER pair). */
export type ContentResponse =
  | { type: 'SNAPSHOT_RESULT'; snapshot: DomSnapshot }
  | { type: 'VIEWPORT_RESULT'; viewport: ViewportContext }
  /** Already premasked — see ner-track.ts's asymmetry note: this is what
   *  the model reads, NOT what NER_BOX_REQUEST searches against. */
  | { type: 'NER_TEXT_RESULT'; nerText: string }
  | { type: 'NER_BOX_RESULT'; boxes: DetectedBox[] };

/** Service worker -> side panel. Errors are values, not exceptions, because
 *  they cross a message boundary that does not preserve stack traces. */
export type CaptureResponse =
  | { ok: true; payload: CapturePayload }
  | { ok: false; error: string; hint?: string };
