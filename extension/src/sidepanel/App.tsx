/**
 * SIH 26171 — side panel.
 *
 * This is the verification instrument for Phase 1. Its purpose is not to look
 * like an AI assistant; it is to answer one question definitively:
 *
 *   Do the boxes computed by coords.ts land exactly on their elements?
 *
 * If they do, the coordinate contract holds and Phase 2 can stack face
 * detection and NER on top of it. If they do not, nothing downstream can
 * possibly be correct, and we would rather find that out here than after
 * building a redaction engine on a broken transform.
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
import { sendToContent } from '../lib/messaging';
import type { CapturePayload, CaptureResponse, DetectedBox, SnapshotElement } from '../types';

interface DrawnBox {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isInteractive: boolean;
}

export default function App() {
  const [payload, setPayload] = useState<CapturePayload | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  /** img.clientWidth / img.naturalWidth — set once the bitmap decodes. */
  const [displayScale, setDisplayScale] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  // Track 3 (NER) state. A NER failure must never break the capture view —
  // see the round-trip effect below, which only ever sets nerError, never
  // rethrows.
  const [nerBoxes, setNerBoxes] = useState<DetectedBox[]>([]);
  const [nerError, setNerError] = useState<string | null>(null);
  /** Which payload the NER round trip has already run for — a ref, not
   *  state, because it must not itself trigger a re-run when it changes. */
  const nerRanFor = useRef<CapturePayload | null>(null);

  useEffect(() => {
    warmNerModel().catch((err) => console.error('[SIH] NER warm-up failed', err));
  }, []);

      const capture = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSelected(null);
    setDisplayScale(0);   
    setNerBoxes([]);
    setNerError(null);
    nerRanFor.current = null;

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
   * Track 3 round trip: model runs here (panel), text assembly + boxing run
   * in the content script. Keyed on [payload, frame] like the DOM `boxes`
   * memo above — same frame, so NER boxes land in the same space. Guarded
   * by nerRanFor so a `frame` recompute for the SAME payload (e.g. a
   * re-render after displayScale settles) does not re-issue the round trip.
   */
  useEffect(() => {
    if (!payload || !frame) return;
    if (nerRanFor.current === payload) return;
    nerRanFor.current = payload;

    let cancelled = false;

    (async () => {
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

        if (!cancelled) setNerBoxes(boxRes.boxes);
      } catch (err) {
        // Track 3 is additive. A capture the user can still see and use
        // matters more than a failed NER pass — never surface this as the
        // main error state.
        if (!cancelled) {
          setNerError(err instanceof Error ? err.message : String(err));
        }
        console.error('[SIH] NER round trip failed', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [payload, frame]);

  const nerDrawnBoxes = useMemo(() => {
    if (displayScale === 0) return [];
    return nerBoxes.map((box) => ({
      ...imageBoxToCssBox(box.imageBox, displayScale),
      piiType: box.piiType,
      subtype: box.subtype,
      confidence: box.confidence,
      text: box.text,
    }));
  }, [nerBoxes, displayScale]);

  return (
    <div className="app">
      <header className="header">
        <p className="eyebrow">SIH 26171 · Phase 1</p>
        <h1 className="title">Screen capture &amp; alignment</h1>
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

                {nerDrawnBoxes.map((box, i) => (
                  <div
                    key={`ner-${i}`}
                    className="box ner"
                    title={`${box.piiType}${box.subtype ? ` · ${box.subtype}` : ''} — ${Math.round(box.confidence * 100)}%`}
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
              </div>
            </div>

            <p className="ner-status">
              Track 3: {nerBoxes.length} box{nerBoxes.length === 1 ? '' : 'es'}
              {nerError ? ` — NER failed: ${nerError}` : ''}
            </p>

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
