/**
 * SIH 26171 — shared type contract.
 *
 * These types are the interface between the three extension contexts
 * (content script, service worker, side panel). Every later phase adds
 * fields here rather than inventing parallel shapes, so keep this file
 * as the single source of truth.
 */

/** Semantic classes of PII. Unused in Phase 1; fixed now so Phase 2/3 agree. */
export type PiiType =
  | 'FACE'
  | 'PASSWORD'
  | 'ID_NUMBER'
  | 'NAME'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS';

/** Which detector produced a box. Phase 2. */
export type DetectionSource = 'DOM' | 'FACE_MODEL' | 'NER_MODEL';

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

/** Service worker -> content script. */
export type ContentRequest =
  | { type: 'SNAPSHOT_REQUEST' }
  | { type: 'VIEWPORT_PROBE' };

/** Content script -> service worker. */
export type ContentResponse =
  | { type: 'SNAPSHOT_RESULT'; snapshot: DomSnapshot }
  | { type: 'VIEWPORT_RESULT'; viewport: ViewportContext };

/** Service worker -> side panel. Errors are values, not exceptions, because
 *  they cross a message boundary that does not preserve stack traces. */
export type CaptureResponse =
  | { ok: true; payload: CapturePayload }
  | { ok: false; error: string; hint?: string };
