/**
 * SIH 26171 — side panel.
 *
 * Phase 1's job was to prove the coordinate contract: do boxes computed by
 * coords.ts land exactly on their elements. Phase 2 (this file, as of
 * Brief 5) builds on that proof to run all three PII detection tracks and
 * show one unified, deduped overlay — the thing a judge actually sees.
 *
 *   Track 1 (detectDomPii)  — content script, live DOM.
 *   Track 2 (detectFaces)   — panel, screenshot pixels + WebGPU.
 *   Track 3 (NER round trip)— content assembles/boxes, panel runs the model.
 *
 * Each track runs independently and is individually fault-tolerant: one
 * failing (a WebGPU load error, a content-script timeout) degrades to
 * whatever the other two found, never a blank overlay. See the detection
 * effect below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampToImage,
  createCoordinateFrame,
  domRectToImageBox,
  imageBoxToCssBox,
  type CoordinateFrame,
} from '../lib/coords';
import { classifyText, warmNerModel } from '../detection/ner-detector';
import { detectFaces, warmFaceModel } from '../detection/face-detector';
import { mergeDetections } from '../detection/box-merger';
import { sendToContent } from '../lib/messaging';
import type {
  CapturePayload,
  CaptureResponse,
  DetectedBox,
  PiiType,
  SnapshotElement,
} from '../types';

interface DrawnBox {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isInteractive: boolean;
}

/**
 * One color per PiiType, grouped by sensitivity family rather than given 12
 * arbitrary hues: PASSWORD/SECRET share the "critical" red used elsewhere
 * for errors; FACE gets its own hue since it's a visual rather than
 * text-based detection; the rest of the text-derived types each get a
 * distinct, legible-on-dark hue. Consumed by both the overlay boxes and the
 * legend below.
 */
const PII_COLORS: Record<PiiType, string> = {
  FACE: '#6366f1',
  PASSWORD: '#f2603c',
  SECRET: '#f2603c',
  CARD: '#e9a73c',
  ID_NUMBER: '#f472b6',
  NAME: '#a78bfa',
  EMAIL: '#22d3ee',
  PHONE: '#34d399',
  ADDRESS: '#facc15',
  URL: '#38bdf8',
  DATE: '#94a3b8',
  OTHER: '#7b8fa1',
};

/** Per-capture Step 5 metrics: what judges score under efficiency/latency. */
interface DetectionMetrics {
  faceMs: number;
  domMs: number;
  nerMs: number;
  totalMs: number;
  faceCount: number;
  domCount: number;
  nerCount: number;
  mergedCount: number;
  dupesCollapsed: number;
}

export default function App() {
  const [payload, setPayload] = useState<CapturePayload | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  /** img.clientWidth / img.naturalWidth — set once the bitmap decodes. */
  const [displayScale, setDisplayScale] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  // Phase 2 unified detections (all three tracks, merged) + Step 5 metrics.
  const [detections, setDetections] = useState<DetectedBox[]>([]);
  const [detectWarning, setDetectWarning] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DetectionMetrics | null>(null);
  /** Which payload the detection pass has already run for — a ref, not
   *  state, because it must not itself trigger a re-run when it changes. */
  const detectRanFor = useRef<CapturePayload | null>(null);

  useEffect(() => {
    warmFaceModel().catch((err) => console.error('[SIH] Face warm-up failed', err));
    warmNerModel().catch((err) => console.error('[SIH] NER warm-up failed', err));
  }, []);

      const capture = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSelected(null);
    setDisplayScale(0);
    setDetections([]);
    setDetectWarning(null);
    setMetrics(null);
    detectRanFor.current = null;

    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'CAPTURE_REQUEST',
      })) as CaptureResponse;

      if (!res) throw new Error('No response from the extension worker.');
      if (!res.ok) {
        setError({ message: res.error, hint: res.hint });
        setPayload(null);
        return;
      }
      setPayload(res.payload);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        hint: 'Reload the extension from chrome://extensions and try again.',
      });
      setPayload(null);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * The moment the coordinate contract is exercised. We read naturalWidth /
   * naturalHeight — the true bitmap size — NOT clientWidth, which is the
   * downscaled size the panel renders at.
   */
  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    setDisplayScale(img.clientWidth / img.naturalWidth);
  }, []);

  const frame: CoordinateFrame | null = useMemo(() => {
    const img = imgRef.current;
    if (!payload || !img || !img.naturalWidth || displayScale === 0) return null;
    try {
      return createCoordinateFrame(
        payload.snapshot.viewport,
        img.naturalWidth,
        img.naturalHeight,
      );
    } catch {
      return null;
    }
  }, [payload, displayScale]);

  const boxes: DrawnBox[] = useMemo(() => {
    if (!payload || !frame || displayScale === 0) return [];

    return payload.snapshot.elements.flatMap((el) => {
      // CSS px -> image px -> clip -> display px. Every conversion via coords.ts.
      const imageBox = clampToImage(domRectToImageBox(el.rect, frame), frame);
      if (!imageBox) return [];
      const css = imageBoxToCssBox(imageBox, displayScale);
      return [{ nodeId: el.nodeId, ...css, isInteractive: el.isInteractive }];
    });
  }, [payload, frame, displayScale]);

  /**
   * The Phase-2 detection pass: all three tracks, run concurrently, each
   * independently fault-tolerant, merged, timed.
   *
   * Keyed on [payload, frame] like the DOM `boxes` memo above — same frame,
   * so every track's boxes land in the same space. Guarded by detectRanFor
   * so a `frame` recompute for the SAME payload does not re-issue the pass.
   *
   * DEVIATION FROM THE BRIEF'S LITERAL PSEUDOCODE, worth flagging: the brief
   * sketches `Promise.all([detectFaces, DOM_PII_REQUEST, NER_TEXT_REQUEST])`
   * and only THEN sequentially runs classifyText + NER_BOX_REQUEST — which
   * would block Track 3's model call until Track 2's (typically slower)
   * face inference finishes, even though the two have no dependency on each
   * other. Here each track is its own fully independent async pipeline,
   * racing from the start; Track 3 internally sequences its own two-step
   * text -> classify -> box chain. Lower total latency, same merged result,
   * same fault isolation — this is a latency optimization, not a
   * behavioral change from what the brief specifies.
   */
  useEffect(() => {
    if (!payload || !frame) return;
    if (detectRanFor.current === payload) return;
    detectRanFor.current = payload;

    let cancelled = false;

    (async () => {
      const totalStart = performance.now();
      let faceBoxes: DetectedBox[] = [];
      let domBoxes: DetectedBox[] = [];
      let nerBoxes: DetectedBox[] = [];
      let faceMs = 0;
      let domMs = 0;
      let nerMs = 0;
      const warnings: string[] = [];

      const faceTrack = (async () => {
        const start = performance.now();
        try {
          const blob = await (await fetch(payload.screenshotDataUrl)).blob();
          const image = await createImageBitmap(blob);
          faceBoxes = await detectFaces(image, frame);
        } catch (err) {
          console.error('[SIH] Face detection failed', err);
          warnings.push(`face: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          faceMs = performance.now() - start;
        }
      })();

      const domTrack = (async () => {
        const start = performance.now();
        try {
          const res = await sendToContent(payload.tabId, { type: 'DOM_PII_REQUEST', frame });
          if (res?.type !== 'DOM_PII_RESULT') {
            throw new Error('Content script returned an unexpected DOM PII response.');
          }
          domBoxes = res.boxes;
        } catch (err) {
          console.error('[SIH] DOM PII detection failed', err);
          warnings.push(`dom: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          domMs = performance.now() - start;
        }
      })();

      const nerTrack = (async () => {
        const start = performance.now();
        try {
          const textRes = await sendToContent(payload.tabId, { type: 'NER_TEXT_REQUEST' });
          if (textRes?.type !== 'NER_TEXT_RESULT') {
            throw new Error('Content script returned an unexpected NER text response.');
          }
          const spans = await classifyText(textRes.nerText);
          const boxRes = await sendToContent(payload.tabId, {
            type: 'NER_BOX_REQUEST',
            spans,
            frame,
          });
          if (boxRes?.type !== 'NER_BOX_RESULT') {
            throw new Error('Content script returned an unexpected NER box response.');
          }
          nerBoxes = boxRes.boxes;
        } catch (err) {
          console.error('[SIH] NER detection failed', err);
          warnings.push(`ner: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          nerMs = performance.now() - start;
        }
      })();

      await Promise.all([faceTrack, domTrack, nerTrack]);
      if (cancelled) return;

      const raw = [...faceBoxes, ...domBoxes, ...nerBoxes];
      const merged = mergeDetections(raw);

      setDetections(merged);
      setDetectWarning(warnings.length > 0 ? warnings.join('; ') : null);
      setMetrics({
        faceMs: Math.round(faceMs),
        domMs: Math.round(domMs),
        nerMs: Math.round(nerMs),
        totalMs: Math.round(performance.now() - totalStart),
        faceCount: faceBoxes.length,
        domCount: domBoxes.length,
        nerCount: nerBoxes.length,
        mergedCount: merged.length,
        dupesCollapsed: raw.length - merged.length,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [payload, frame]);

  const detectedDrawnBoxes = useMemo(() => {
    if (displayScale === 0) return [];
    return detections.map((box) => ({
      ...imageBoxToCssBox(box.imageBox, displayScale),
      piiType: box.piiType,
      subtype: box.subtype,
      source: box.source,
      confidence: box.confidence,
    }));
  }, [detections, displayScale]);

  /** Only the types actually present this capture — an always-full 12-chip
   *  legend would be noise on a page with two PII types on it. */
  const presentTypes = useMemo(() => {
    const seen = new Set<PiiType>();
    for (const box of detections) seen.add(box.piiType);
    return Array.from(seen);
  }, [detections]);

  return (
    <div className="app">
      <header className="header">
        <p className="eyebrow">SIH 26171 · Phase 2</p>
        <h1 className="title">Screen capture &amp; PII detection</h1>
        <button className="capture-btn" onClick={capture} disabled={busy}>
          {busy ? 'Capturing…' : 'Capture this page'}
        </button>
      </header>

      {payload && frame && <Readout frame={frame} payload={payload} />}

      <div className="scroll">
        {payload?.drift && <DriftNotice payload={payload} />}
        {error && <ErrorNotice message={error.message} hint={error.hint} />}

        {!payload && !error && (
          <p className="empty">
            Open any website, then choose <code>Capture this page</code>.
            <br />
            Boxes should sit exactly on their elements.
          </p>
        )}

        {payload && (
          <>
            <div className="stage">
              <img
                ref={imgRef}
                src={payload.screenshotDataUrl}
                onLoad={onImageLoad}
                alt="Captured page"
              />
              <div className="overlay">
                {boxes.map((box) => (
                  <div
                    key={box.nodeId}
                    className={[
                      'box',
                      box.isInteractive ? '' : 'static',
                      selected === box.nodeId ? 'selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      left: `${box.left}px`,
                      top: `${box.top}px`,
                      width: `${box.width}px`,
                      height: `${box.height}px`,
                    }}
                  >
                    <span className="tick tl" />
                    <span className="tick tr" />
                    <span className="tick bl" />
                    <span className="tick br" />
                  </div>
                ))}

                {detectedDrawnBoxes.map((box, i) => {
                  const color = PII_COLORS[box.piiType];
                  return (
                    <div
                      key={`det-${i}`}
                      className="box detected"
                      title={`${box.piiType}${box.subtype ? ` · ${box.subtype}` : ''} · ${box.source} · ${Math.round(box.confidence * 100)}%`}
                      style={{
                        left: `${box.left}px`,
                        top: `${box.top}px`,
                        width: `${box.width}px`,
                        height: `${box.height}px`,
                        borderColor: color,
                        background: `${color}29`,
                        color,
                      }}
                    >
                      <span className="tick tl" />
                      <span className="tick tr" />
                      <span className="tick bl" />
                      <span className="tick br" />
                    </div>
                  );
                })}
              </div>
            </div>

            {presentTypes.length > 0 && (
              <ul className="legend">
                {presentTypes.map((type) => (
                  <li key={type} className="legend-chip">
                    <span
                      className="legend-dot"
                      style={{ background: PII_COLORS[type] }}
                    />
                    {type}
                  </li>
                ))}
              </ul>
            )}

            {metrics && (
              <p className="metrics">
                {metrics.mergedCount} box{metrics.mergedCount === 1 ? '' : 'es'}
                {' '}({metrics.faceCount} face · {metrics.domCount} dom · {metrics.nerCount} ner)
                {' · '}face {metrics.faceMs}ms · dom {metrics.domMs}ms · ner {metrics.nerMs}ms
                {' · '}{metrics.dupesCollapsed} deduped · {metrics.totalMs}ms total
                {detectWarning ? ` — ${detectWarning}` : ''}
              </p>
            )}

            <ElementList
              elements={payload.snapshot.elements}
              selected={selected}
              onSelect={setSelected}
              truncated={payload.snapshot.truncated}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The derived scale is the single most diagnostic number in Phase 1. If it
 * disagrees with the reported DPR, that is not a bug — it is exactly why we
 * derive the scale empirically instead of trusting devicePixelRatio.
 */
function Readout({ frame, payload }: { frame: CoordinateFrame; payload: CapturePayload }) {
  const skewed = Math.abs(frame.anisotropy - 1) > 0.01;

  return (
    <div className="readout">
      <div className="readout-cell">
        <span className="readout-label">Derived scale</span>
        <span className={`readout-value${skewed ? ' warn' : ''}`}>
          {frame.scaleX.toFixed(3)}×
        </span>
      </div>
      <div className="readout-cell">
        <span className="readout-label">Reported DPR</span>
        <span className="readout-value">{frame.reportedDpr.toFixed(2)}×</span>
      </div>
      <div className="readout-cell">
        <span className="readout-label">Scale basis</span>
        <span className="readout-value">{frame.basis}</span>
      </div>
      <div className="readout-cell">
        <span className="readout-label">Pipeline</span>
        <span className="readout-value">{Math.round(payload.timings.totalMs)}ms</span>
      </div>
    </div>
  );
}

function DriftNotice({ payload }: { payload: CapturePayload }) {
  const d = payload.drift!;
  return (
    <div className="notice">
      <h3>Page moved during capture</h3>
      <p>
        {d.urlChanged
          ? 'The page navigated between reading the DOM and capturing pixels.'
          : `The page scrolled ${Math.abs(d.scrollYDelta)}px vertically, ${Math.abs(
              d.scrollXDelta,
            )}px horizontally. Boxes below are offset by that amount.`}{' '}
        Hold the page still and capture again.
      </p>
    </div>
  );
}

function ErrorNotice({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="notice">
      <h3>{message}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

function ElementList({
  elements,
  selected,
  onSelect,
  truncated,
}: {
  elements: SnapshotElement[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  truncated: boolean;
}) {
  const interactive = elements.filter((e) => e.isInteractive).length;

  return (
    <>
      <div className="section-head">
        <h2>Elements</h2>
        <span className="count">
          {interactive} interactive · {elements.length - interactive} static
          {truncated ? ' · capped' : ''}
        </span>
      </div>
      <ul className="list">
        {elements.map((el) => (
          <li key={el.nodeId}>
            <button
              className={`row${selected === el.nodeId ? ' selected' : ''}`}
              onClick={() => onSelect(selected === el.nodeId ? null : el.nodeId)}
            >
              <span className={`dot${el.isInteractive ? '' : ' static'}`} />
              <span className="row-name">
                {el.name || <span className="unnamed">unnamed</span>}
              </span>
              <span className="row-meta">
                {el.tag}
                {el.type ? `:${el.type}` : ''} · {Math.round(el.rect.width)}×
                {Math.round(el.rect.height)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
