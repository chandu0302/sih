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
 * Phase 3c: one redacted region, in the shape ARCHITECTURE.md's Phase 3
 * design settled on — `{type, bbox, selector, confidence}` — minus `text`.
 * This is what Phase 4 will eventually send to the server alongside the
 * sanitized image, so the matched PII text must never appear here (same
 * principle as DetectedBox's attribute hits recording no `text`).
 *
 * `nodeId` stands in for the doc's `selector`: DetectedBox never carried a
 * persistent CSS selector (dom-track.ts's NodeIdSource is scoped to one
 * scan; NER hits are Range-based, not element-based) — building one is
 * out-of-scope P5 convergence work, not an oversight here.
 */
export interface RedactionRegion {
  type: PiiType;
  bbox: ImageBox;
  nodeId?: string;
  confidence: number;
}

/** Phase 3c: the full manifest for one capture. */
export interface RedactionManifest {
  regions: RedactionRegion[];
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

/**
 * Side panel -> service worker.
 *
 * Phase 3a split what was one CAPTURE_REQUEST into two round trips, because
 * text redaction must happen BEFORE the pixels are captured, and computing
 * "what to redact" requires the NER model, which only runs in the panel.
 * The service worker cannot drive that itself, so the panel now owns the
 * sequencing: snapshot -> (panel runs detection + masks the DOM) -> capture.
 * See App.tsx's capture() for the full sequence and mask-overlay.ts for the
 * masking step in between.
 */
export type PanelRequest =
  | { type: 'CAPTURE_SNAPSHOT_REQUEST' }
  | { type: 'CAPTURE_SCREENSHOT_REQUEST'; tabId: number; windowId: number };

/**
 * Service worker -> content script.
 *
 * Track 3, 4c: NER_TEXT_REQUEST/NER_BOX_REQUEST are sent by the PANEL, not
 * the service worker — "ContentRequest" names the recipient, not the
 * sender. The panel has <all_urls> host access, so it can message a tab's
 * content script directly via sendToContent(tabId, ...) without routing
 * through the service worker, keeping the capture sequence untouched.
 *
 * Phase 2 / Brief 5: DOM_PII_REQUEST is the same shape — Track 1
 * (detectDomPii) needs the live DOM, so it runs in the content script too,
 * driven by the panel-built frame just like the NER pair. Kept as its own
 * message pair rather than piggybacked onto NER_TEXT_REQUEST, so the three
 * tracks stay independent: any one of them failing must not block the
 * other two (see App.tsx's detection effect).
 *
 * Phase 3a: APPLY_MASK_REQUEST/REMOVE_MASK_REQUEST are also panel -> content
 * script, sent by the panel after it has merged DOM_PII_REQUEST +
 * NER_BOX_REQUEST results computed under the pre-capture IDENTITY frame
 * (see App.tsx) — those DetectedBox.imageBox values are therefore already
 * viewport CSS-pixel rects, reused as-is, no new coordinate math.
 */
export type ContentRequest =
  | { type: 'SNAPSHOT_REQUEST' }
  | { type: 'VIEWPORT_PROBE' }
  | { type: 'NER_TEXT_REQUEST' }
  | { type: 'NER_BOX_REQUEST'; spans: NerSpan[]; frame: CoordinateFrame }
  | { type: 'DOM_PII_REQUEST'; frame: CoordinateFrame }
  | { type: 'APPLY_MASK_REQUEST'; boxes: DetectedBox[] }
  | { type: 'REMOVE_MASK_REQUEST' }
  | { type: 'EXECUTE_ACTION_REQUEST'; action: ExecutableAction };

/** Content script -> its caller (service worker for the first two, panel for the rest). */
export type ContentResponse =
  | { type: 'SNAPSHOT_RESULT'; snapshot: DomSnapshot }
  | { type: 'VIEWPORT_RESULT'; viewport: ViewportContext }
  /** Already premasked — see ner-track.ts's asymmetry note: this is what
   *  the model reads, NOT what NER_BOX_REQUEST searches against. */
  | { type: 'NER_TEXT_RESULT'; nerText: string }
  | { type: 'NER_BOX_RESULT'; boxes: DetectedBox[] }
  | { type: 'DOM_PII_RESULT'; boxes: DetectedBox[] }
  | { type: 'APPLY_MASK_RESULT'; maskedCount: number }
  | { type: 'REMOVE_MASK_RESULT'; removedCount: number }
  | { type: 'EXECUTE_ACTION_RESULT'; ok: boolean; detail?: string };

/* ------------------------------------------------------------------ */
/* Phase 5: agent server contract (panel <-> Phase 4 FastAPI server)   */
/* ------------------------------------------------------------------ */

/** What the panel sends to the Phase 4 server's POST /plan-action. Mirrors
 *  server/app/schemas.py's PlanActionRequest field-for-field. */
export interface AgentPlanRequest {
  image: string;
  manifest: RedactionManifest;
  task: string;
}

/** Mirrors server/app/schemas.py's ActionCommand field-for-field — `target`
 *  is in IMAGE-pixel space (the space the sanitized screenshot is in), NOT
 *  yet converted to a real page point. See App.tsx's use of
 *  imagePointToCssPoint for that conversion, done before EXECUTE_ACTION_REQUEST
 *  is ever sent. */
export interface AgentActionCommand {
  action: 'click' | 'type' | 'scroll' | 'done';
  target?: { x: number; y: number } | null;
  text?: string | null;
  scroll_direction?: 'up' | 'down' | null;
  reasoning: string;
}

/**
 * One action already resolved to CSS-pixel space — the content script's
 * action-executor.ts never sees image-pixel coordinates or a CoordinateFrame;
 * the panel does that conversion (via coords.ts) before this crosses the
 * message boundary, same division of responsibility as APPLY_MASK_REQUEST's
 * boxes above.
 */
export interface ExecutableAction {
  kind: 'click' | 'type' | 'scroll' | 'done';
  point?: { left: number; top: number };
  text?: string;
  scrollDirection?: 'up' | 'down';
}

/** Service worker -> side panel, phase 1 (DOM read only — no pixels yet). */
export type SnapshotCaptureResponse =
  | { ok: true; tabId: number; windowId: number; snapshot: DomSnapshot; injectMs: number; snapshotMs: number }
  | { ok: false; error: string; hint?: string };

/** Service worker -> side panel, phase 2 (pixels, after the panel has masked
 *  the DOM). Unmasking happens inside this call, immediately after the
 *  pixels are captured — see service-worker.ts's captureScreenshot(). */
export type ScreenshotCaptureResponse =
  | { ok: true; screenshotDataUrl: string; screenshotMs: number }
  | { ok: false; error: string; hint?: string };
