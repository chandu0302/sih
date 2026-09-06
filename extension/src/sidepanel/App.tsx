/**
 * SIH 26171 — side panel.
 *
 * Chat-style redesign: the panel is a message thread (Capture / user /
 * assistant bubbles) with a composer at the bottom, not the earlier flat
 * form-and-status-paragraph layout. The underlying pipelines are UNCHANGED —
 * capture()'s CDP sequence and the three-track detection effect are the same
 * logic as before, just pushing their settled result onto a `messages` array
 * instead of setting flat top-level state.
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
  createFullPageFrame,
  detectDrift,
  domRectToImageBox,
  imageBoxToCssBox,
  imagePointToCssPoint,
  type CoordinateFrame,
} from '../lib/coords';
import { classifyText, warmNerModel } from '../detection/ner-detector';
import { detectFaces, warmFaceModel } from '../detection/face-detector';
import { mergeDetections } from '../detection/box-merger';
import { blurFaces } from '../redaction/face-blur';
import { buildRedactionManifest } from '../redaction/manifest';
import { askQuestion, planAction } from '../agent/server-client';
import { sendToContent } from '../lib/messaging';
import type {
  CapturePayload,
  DetectedBox,
  ExecutableAction,
  PiiType,
  RedactionManifest,
  ScreenshotCaptureResponse,
  SnapshotCaptureResponse,
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

/* ------------------------------------------------------------------ */
/* Chat message model                                                  */
/* ------------------------------------------------------------------ */

interface CaptureMessage {
  id: string;
  role: 'capture';
  ts: number;
  payload: CapturePayload;
  sanitizedScreenshotDataUrl: string | null;
  detections: DetectedBox[];
  manifest: RedactionManifest;
  frame: CoordinateFrame;
  metrics: DetectionMetrics | null;
  detectWarning: string | null;
}

interface UserMessage {
  id: string;
  role: 'user';
  ts: number;
  mode: 'ask' | 'agent';
  text: string;
}

interface AssistantAskMessage {
  id: string;
  role: 'assistant-ask';
  ts: number;
  answer: string;
}

interface AssistantAgentMessage {
  id: string;
  role: 'assistant-agent';
  ts: number;
  reasoning: string;
  ok: boolean;
  detail?: string;
}

interface ErrorChatMessage {
  id: string;
  role: 'error';
  ts: number;
  message: string;
  hint?: string;
}

type ChatMessage =
  | CaptureMessage
  | UserMessage
  | AssistantAskMessage
  | AssistantAgentMessage
  | ErrorChatMessage;

let msgCounter = 0;
function newId(): string {
  return `m${Date.now()}-${msgCounter++}`;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const pushMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const [payload, setPayload] = useState<CapturePayload | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which payload the detection pass has already run for — a ref, not
   *  state, because it must not itself trigger a re-run when it changes. */
  const detectRanFor = useRef<CapturePayload | null>(null);
  /** Set by capture() right before the screenshot step, read once by the
   *  detection effect so a pre-mask warning (computed before `payload` even
   *  exists) still reaches the eventual capture message. */
  const preMaskWarningRef = useRef<string | null>(null);

  /** 'capture' is the default — matches the reference interaction pattern
   *  (a single mode dropdown covering all three actions, not a separate
   *  always-visible Capture button). */
  const [mode, setMode] = useState<'agent' | 'ask' | 'capture'>('capture');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [modeMenuOpen]);

  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    warmFaceModel().catch((err) => console.error('[SIH] Face warm-up failed', err));
    warmNerModel().catch((err) => console.error('[SIH] NER warm-up failed', err));
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  /**
   * Phase 3a's redact-before-capture design forces this into two
   * service-worker round trips with a masking phase in between:
   *
   *   1. CAPTURE_SNAPSHOT_REQUEST — DOM read, no pixels yet, but the
   *      service worker also attaches CDP here and learns the full page's
   *      CSS size (pageWidth/pageHeight) — the sole source of truth for
   *      "how big is this page," used for the identity frame below AND
   *      later for the real post-capture frame.
   *   2. Detect text PII under a throwaway IDENTITY frame (scale 1, built
   *      from the FULL PAGE size, not just the current viewport — a mask
   *      1 or 4 viewports down the page must land at its real page-relative
   *      position, not get clamped away as "off-screen") and mask it on the
   *      live page via APPLY_MASK_REQUEST.
   *   3. CAPTURE_SCREENSHOT_REQUEST — the ENTIRE scrollable page in one CDP
   *      screenshot, now that text PII is masked. The service worker
   *      unmasks and detaches the debugger immediately after, inside that
   *      call.
   *
   * A pre-mask detection failure does not abort the capture — it degrades to
   * "nothing masked" (see the per-step try/catch below). That degraded
   * state is surfaced via the eventual capture message's detectWarning, not
   * swallowed: an unmasked capture is the one failure mode this project
   * cannot be silent about.
   *
   * If anything throws AFTER phase 1 succeeds (debugger now attached) but
   * BEFORE phase 3 completes (which normally detaches it), the outer catch
   * below fires a best-effort CAPTURE_ABORT_REQUEST so the debugger session
   * — and the "this extension is debugging this browser" banner — never
   * outlives one capture cycle on an unexpected failure.
   *
   * Failures push an `error`-role chat message rather than a separate
   * top-level error banner — one message-driven UI, not two.
   */
  const capture = useCallback(async () => {
    setBusy(true);
    const totalStart = performance.now();
    let attachedTabId: number | null = null;

    try {
      // --- Phase 1: DOM snapshot + full page size ---------------------
      const snapRes = (await chrome.runtime.sendMessage({
        type: 'CAPTURE_SNAPSHOT_REQUEST',
      })) as SnapshotCaptureResponse;

      if (!snapRes) throw new Error('No response from the extension worker.');
      if (!snapRes.ok) {
        pushMessage({ id: newId(), role: 'error', ts: Date.now(), message: snapRes.error, hint: snapRes.hint });
        return;
      }
      const { tabId, snapshot, pageWidth, pageHeight, injectMs, snapshotMs } = snapRes;
      attachedTabId = tabId; // debugger is attached from this point on

      // --- Phase 2: detect text PII (identity frame) and mask it ------
      const identityFrame = createFullPageFrame(pageWidth, pageHeight, pageWidth, pageHeight, snapshot.viewport.dpr);

      const preMaskWarnings: string[] = [];
      let domMaskBoxes: DetectedBox[] = [];
      let nerMaskBoxes: DetectedBox[] = [];

      try {
        const res = await sendToContent(tabId, { type: 'DOM_PII_REQUEST', frame: identityFrame });
        if (res?.type === 'DOM_PII_RESULT') domMaskBoxes = res.boxes;
      } catch (err) {
        console.error('[SIH] Pre-capture DOM PII detection failed', err);
        preMaskWarnings.push(`pre-mask dom: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const textRes = await sendToContent(tabId, { type: 'NER_TEXT_REQUEST' });
        if (textRes?.type === 'NER_TEXT_RESULT') {
          const spans = await classifyText(textRes.nerText);
          const boxRes = await sendToContent(tabId, {
            type: 'NER_BOX_REQUEST',
            spans,
            frame: identityFrame,
          });
          if (boxRes?.type === 'NER_BOX_RESULT') nerMaskBoxes = boxRes.boxes;
        }
      } catch (err) {
        console.error('[SIH] Pre-capture NER detection failed', err);
        preMaskWarnings.push(`pre-mask ner: ${err instanceof Error ? err.message : String(err)}`);
      }

      const maskBoxes = mergeDetections([...domMaskBoxes, ...nerMaskBoxes]);

      try {
        await sendToContent(tabId, { type: 'APPLY_MASK_REQUEST', boxes: maskBoxes });
      } catch (err) {
        console.error('[SIH] Applying text mask failed', err);
        preMaskWarnings.push(`mask-apply: ${err instanceof Error ? err.message : String(err)}`);
      }

      preMaskWarningRef.current = preMaskWarnings.length > 0 ? preMaskWarnings.join('; ') : null;

      // --- Phase 3: pixels, now that text PII is masked ---------------
      const shotRes = (await chrome.runtime.sendMessage({
        type: 'CAPTURE_SCREENSHOT_REQUEST',
        tabId,
      })) as ScreenshotCaptureResponse;
      attachedTabId = null; // service worker detaches inside this call regardless of ok/error

      if (!shotRes) throw new Error('No response from the extension worker.');
      if (!shotRes.ok) {
        pushMessage({ id: newId(), role: 'error', ts: Date.now(), message: shotRes.error, hint: shotRes.hint });
        return;
      }

      // --- Phase 4: drift check, computed here instead of the service
      // worker now that the panel owns the sequencing. --------------
      let drift = null;
      try {
        const probe = await sendToContent(tabId, { type: 'VIEWPORT_PROBE' });
        if (probe?.type === 'VIEWPORT_RESULT') {
          drift = detectDrift(snapshot.viewport, probe.viewport);
        }
      } catch {
        console.warn('[SIH] viewport probe failed; drift unknown');
      }

      setPayload({
        screenshotDataUrl: shotRes.screenshotDataUrl,
        snapshot,
        pageWidth,
        pageHeight,
        drift,
        tabId,
        timings: {
          injectMs,
          snapshotMs,
          screenshotMs: shotRes.screenshotMs,
          totalMs: performance.now() - totalStart,
        },
      });
    } catch (err) {
      pushMessage({
        id: newId(),
        role: 'error',
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
        hint: 'Reload the extension from chrome://extensions and try again.',
      });

      // The debugger session was attached (phase 1 succeeded) but this
      // capture never reached the point that normally detaches it — clean
      // up so the debugging banner doesn't outlive this failed attempt.
      if (attachedTabId !== null) {
        chrome.runtime
          .sendMessage({ type: 'CAPTURE_ABORT_REQUEST', tabId: attachedTabId })
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }, [pushMessage]);

  /**
   * The Phase-2 detection pass: all three tracks, run concurrently, each
   * independently fault-tolerant, merged, timed. Decodes the captured image
   * ONCE, upfront (needed for both the coordinate frame and face detection —
   * previously each was derived separately, from a DOM <img> load event and
   * from the face track's own fetch respectively; decoding once here removes
   * that duplication and the render-timing dependency it carried).
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
    if (!payload) return;
    if (detectRanFor.current === payload) return;
    detectRanFor.current = payload;

    let cancelled = false;

    (async () => {
      const totalStart = performance.now();

      let image: ImageBitmap;
      try {
        const blob = await (await fetch(payload.screenshotDataUrl)).blob();
        image = await createImageBitmap(blob);
      } catch (err) {
        if (!cancelled) {
          pushMessage({
            id: newId(),
            role: 'error',
            ts: Date.now(),
            message: 'Failed to decode the captured image.',
            hint: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      let frame: CoordinateFrame;
      try {
        frame = createFullPageFrame(
          payload.pageWidth,
          payload.pageHeight,
          image.width,
          image.height,
          payload.snapshot.viewport.dpr,
        );
      } catch (err) {
        if (!cancelled) {
          pushMessage({
            id: newId(),
            role: 'error',
            ts: Date.now(),
            message: 'Failed to compute the coordinate frame for this capture.',
            hint: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      let faceBoxes: DetectedBox[] = [];
      let domBoxes: DetectedBox[] = [];
      let nerBoxes: DetectedBox[] = [];
      let faceMs = 0;
      let domMs = 0;
      let nerMs = 0;
      /** Phase 3b: set only if faces were found and blurring succeeded. */
      let blurredDataUrl: string | null = null;
      const warnings: string[] = [];

      const faceTrack = (async () => {
        const start = performance.now();
        try {
          faceBoxes = await detectFaces(image, frame);

          if (faceBoxes.length > 0) {
            try {
              blurredDataUrl = await blurFaces(image, faceBoxes);
            } catch (blurErr) {
              console.error('[SIH] Face blur failed', blurErr);
              warnings.push(
                `face-blur: ${blurErr instanceof Error ? blurErr.message : String(blurErr)}`,
              );
            }
          }
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
      const manifest = buildRedactionManifest(merged);

      // Pre-mask warnings from capture() are not dropped when this
      // post-capture pass finds nothing wrong of its own — an unmasked-text
      // warning matters even if faces/dom/ner all succeed.
      const ownWarning = warnings.length > 0 ? warnings.join('; ') : null;
      const preWarning = preMaskWarningRef.current;
      const detectWarning =
        preWarning && ownWarning ? `${preWarning}; ${ownWarning}` : (preWarning ?? ownWarning);

      pushMessage({
        id: newId(),
        role: 'capture',
        ts: Date.now(),
        payload,
        sanitizedScreenshotDataUrl: blurredDataUrl,
        detections: merged,
        manifest,
        frame,
        metrics: {
          faceMs: Math.round(faceMs),
          domMs: Math.round(domMs),
          nerMs: Math.round(nerMs),
          totalMs: Math.round(performance.now() - totalStart),
          faceCount: faceBoxes.length,
          domCount: domBoxes.length,
          nerCount: nerBoxes.length,
          mergedCount: merged.length,
          dupesCollapsed: raw.length - merged.length,
        },
        detectWarning,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [payload, pushMessage]);

  /** The most recent capture message — Ask/Agent messages operate against
   *  its image+manifest+frame. Re-capturing appends a new one, becoming the
   *  new context for subsequent messages. */
  const lastCapture = useMemo<CaptureMessage | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'capture') return msg;
    }
    return null;
  }, [messages]);

  /**
   * One chat turn: append the user's message, then dispatch to Ask
   * (free-text Q&A via the Phase 4 server's /ask) or Agent (the existing
   * Phase 5 one-scripted-action flow — plan, convert coordinates, execute).
   *
   * ONE action per Agent turn, not a loop: this does not re-capture and does
   * not chain further steps on `done`/`click`/etc.
   */
  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (mode === 'capture' || !text || !lastCapture || sending) return;

    setInputText('');
    setSending(true);
    pushMessage({ id: newId(), role: 'user', ts: Date.now(), mode, text });

    const image = lastCapture.sanitizedScreenshotDataUrl ?? lastCapture.payload.screenshotDataUrl;

    try {
      if (mode === 'ask') {
        const result = await askQuestion({ image, manifest: lastCapture.manifest, question: text });
        if (!result.ok) {
          pushMessage({ id: newId(), role: 'error', ts: Date.now(), message: result.error });
        } else {
          pushMessage({ id: newId(), role: 'assistant-ask', ts: Date.now(), answer: result.answer });
        }
        return;
      }

      const planned = await planAction({ image, manifest: lastCapture.manifest, task: text });
      if (!planned.ok) {
        pushMessage({ id: newId(), role: 'error', ts: Date.now(), message: planned.error });
        return;
      }

      const cmd = planned.action;
      let toExecute: ExecutableAction;

      if (cmd.action === 'click') {
        if (!cmd.target) {
          pushMessage({
            id: newId(),
            role: 'error',
            ts: Date.now(),
            message: "Server returned 'click' with no target.",
          });
          return;
        }
        toExecute = { kind: 'click', point: imagePointToCssPoint(cmd.target, lastCapture.frame) };
      } else if (cmd.action === 'type') {
        toExecute = { kind: 'type', text: cmd.text ?? '' };
      } else if (cmd.action === 'scroll') {
        toExecute = { kind: 'scroll', scrollDirection: cmd.scroll_direction ?? 'down' };
      } else {
        pushMessage({
          id: newId(),
          role: 'assistant-agent',
          ts: Date.now(),
          reasoning: cmd.reasoning,
          ok: true,
          detail: 'Task marked complete.',
        });
        return;
      }

      const execRes = await sendToContent(lastCapture.payload.tabId, {
        type: 'EXECUTE_ACTION_REQUEST',
        action: toExecute,
      });
      if (execRes?.type !== 'EXECUTE_ACTION_RESULT') {
        pushMessage({
          id: newId(),
          role: 'error',
          ts: Date.now(),
          message: 'Content script returned an unexpected execute-action response.',
        });
        return;
      }

      pushMessage({
        id: newId(),
        role: 'assistant-agent',
        ts: Date.now(),
        reasoning: cmd.reasoning,
        ok: execRes.ok,
        detail: execRes.detail,
      });
    } catch (err) {
      pushMessage({
        id: newId(),
        role: 'error',
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
    }
  }, [inputText, mode, lastCapture, sending, pushMessage]);

  /** The composer has one primary button, not two — what it does depends on
   *  the selected mode (Capture takes no text; Ask/Agent send the typed
   *  message), mirroring the reference interaction pattern. */
  const handlePrimaryAction = useCallback(() => {
    if (mode === 'capture') {
      capture();
    } else {
      sendMessage();
    }
  }, [mode, capture, sendMessage]);

  const MODE_LABELS = { agent: 'Agent', ask: 'Ask', capture: 'Capture' } as const;

  return (
    <div className="app">
      <header className="header">
        <p className="eyebrow">SIH 26171</p>
        <h1 className="title">PrivacyLens</h1>
      </header>

      <div className="chat-thread">
        {messages.length === 0 && (
          <p className="empty">
            Click <code>Capture</code> below to sanitize the current page, then Ask a question
            or give the Agent a task.
          </p>
        )}

        {messages.map((msg) => {
          switch (msg.role) {
            case 'capture':
              return <CaptureBubble key={msg.id} message={msg} />;
            case 'user':
              return (
                <div key={msg.id} className="msg msg-user">
                  <span className="msg-mode-badge">{msg.mode === 'agent' ? 'Agent' : 'Ask'}</span>
                  <p>{msg.text}</p>
                </div>
              );
            case 'assistant-ask':
              return (
                <div key={msg.id} className="msg msg-assistant">
                  <p>{msg.answer}</p>
                </div>
              );
            case 'assistant-agent':
              return (
                <div key={msg.id} className={`msg msg-assistant${msg.ok ? '' : ' msg-assistant-error'}`}>
                  <p>{msg.reasoning}</p>
                  {msg.detail && <p className="msg-detail">{msg.detail}</p>}
                </div>
              );
            case 'error':
              return (
                <div key={msg.id} className="msg msg-error">
                  <p>{msg.message}</p>
                  {msg.hint && <p className="msg-hint">{msg.hint}</p>}
                </div>
              );
            default:
              return null;
          }
        })}

        <div ref={threadEndRef} />
      </div>

      <div className="composer">
        <div className="composer-row">
          <div className="mode-select" ref={modeMenuRef}>
            <button
              type="button"
              className="mode-select-trigger"
              aria-haspopup="listbox"
              aria-expanded={modeMenuOpen}
              onClick={() => setModeMenuOpen((v) => !v)}
            >
              {MODE_LABELS[mode]}
              <span className="mode-select-caret">▾</span>
            </button>
            {modeMenuOpen && (
              <ul className="mode-menu" role="listbox" aria-label="Message mode">
                {(['agent', 'ask', 'capture'] as const).map((m) => (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={mode === m}
                      className={mode === m ? 'active' : ''}
                      onClick={() => {
                        setMode(m);
                        setModeMenuOpen(false);
                      }}
                    >
                      {MODE_LABELS[m]}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="composer-row">
          <textarea
            className="composer-input"
            rows={2}
            disabled={mode === 'capture'}
            placeholder={
              mode === 'agent'
                ? 'e.g. Click the Submit button'
                : mode === 'ask'
                  ? 'e.g. What kind of form is this?'
                  : 'Capture takes the current page as-is — no prompt needed'
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handlePrimaryAction();
              }
            }}
          />
          <button
            type="button"
            className="send-btn"
            onClick={handlePrimaryAction}
            disabled={
              mode === 'capture' ? busy || sending : sending || !inputText.trim() || !lastCapture
            }
          >
            {mode === 'capture' ? (busy ? 'Capturing…' : 'Capture') : sending ? '…' : 'Send'}
          </button>
        </div>

        {mode !== 'capture' && !lastCapture && (
          <p className="composer-hint">Capture the page first to ask a question or run a task.</p>
        )}
      </div>
    </div>
  );
}

/**
 * One capture's full render: the sanitized image (click to zoom to full
 * size in a new tab), the per-message redacted-regions toggle (Phase 3c —
 * scoped to THIS capture, not global), and a collapsible Details section
 * holding everything that used to be permanently visible (coordinate-scale
 * readout, per-track timing metrics, manifest summary, element list).
 *
 * Owns its own displayScale/showOverlay/selected state — each capture bubble
 * measures and toggles independently, since the chat can hold more than one.
 */
function CaptureBubble({ message }: { message: CaptureMessage }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [displayScale, setDisplayScale] = useState(0);
  const [showOverlay, setShowOverlay] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  /** The moment the coordinate contract is exercised. We read naturalWidth /
   *  naturalHeight — the true bitmap size — NOT clientWidth, which is the
   *  downscaled size the panel renders at. */
  const onImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    setDisplayScale(img.clientWidth / img.naturalWidth);
  }, []);

  /**
   * Full-page captures render very small in the panel's narrow column (a
   * tall page can be thousands of pixels tall, downscaled to fit ~380px
   * wide) — opens the actual captured bitmap at full resolution in a new
   * tab so it's inspectable. A Blob URL, not the data: URL directly:
   * Chrome blocks top-level navigation to data: URLs as an anti-phishing
   * measure; object URLs are not subject to that restriction.
   */
  const openFullSize = useCallback(async () => {
    const dataUrl = message.sanitizedScreenshotDataUrl ?? message.payload.screenshotDataUrl;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      console.error('[SIH] Failed to open full-size image', err);
    }
  }, [message]);

  const boxes: DrawnBox[] = useMemo(() => {
    if (displayScale === 0) return [];
    return message.payload.snapshot.elements.flatMap((el) => {
      // CSS px -> image px -> clip -> display px. Every conversion via coords.ts.
      const imageBox = clampToImage(domRectToImageBox(el.rect, message.frame), message.frame);
      if (!imageBox) return [];
      const css = imageBoxToCssBox(imageBox, displayScale);
      return [{ nodeId: el.nodeId, ...css, isInteractive: el.isInteractive }];
    });
  }, [message, displayScale]);

  const detectedDrawnBoxes = useMemo(() => {
    if (displayScale === 0) return [];
    return message.detections.map((box) => ({
      ...imageBoxToCssBox(box.imageBox, displayScale),
      piiType: box.piiType,
      subtype: box.subtype,
      source: box.source,
      confidence: box.confidence,
    }));
  }, [message.detections, displayScale]);

  /** Only the types actually present this capture — an always-full 12-chip
   *  legend would be noise on a page with two PII types on it. */
  const presentTypes = useMemo(() => {
    const seen = new Set<PiiType>();
    for (const box of message.detections) seen.add(box.piiType);
    return Array.from(seen);
  }, [message.detections]);

  return (
    <div className="msg msg-capture">
      {message.payload.drift && <DriftNotice payload={message.payload} />}

      <div className="stage">
        <img
          ref={imgRef}
          src={message.sanitizedScreenshotDataUrl ?? message.payload.screenshotDataUrl}
          onLoad={onImageLoad}
          onClick={openFullSize}
          className="zoomable"
          title="Click to open full-size in a new tab"
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

          {showOverlay &&
            detectedDrawnBoxes.map((box, i) => {
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

      {message.detections.length > 0 && (
        <button
          type="button"
          className="overlay-toggle"
          onClick={() => setShowOverlay((v) => !v)}
        >
          {showOverlay ? 'Hide redacted regions' : 'Show redacted regions'}
        </button>
      )}

      {presentTypes.length > 0 && showOverlay && (
        <ul className="legend">
          {presentTypes.map((type) => (
            <li key={type} className="legend-chip">
              <span className="legend-dot" style={{ background: PII_COLORS[type] }} />
              {type}
            </li>
          ))}
        </ul>
      )}

      {message.manifest.regions.length > 0 && (
        <p className="manifest-summary">
          Manifest: {message.manifest.regions.length} region
          {message.manifest.regions.length === 1 ? '' : 's'} (
          {Object.entries(
            message.manifest.regions.reduce<Record<string, number>>((counts, r) => {
              counts[r.type] = (counts[r.type] ?? 0) + 1;
              return counts;
            }, {}),
          )
            .map(([type, count]) => `${count} ${type}`)
            .join(' · ')}
          ) — no matched text
        </p>
      )}

      <details className="details">
        <summary>Details</summary>
        <Readout frame={message.frame} payload={message.payload} />
        {message.metrics && (
          <p className="metrics">
            {message.metrics.mergedCount} box{message.metrics.mergedCount === 1 ? '' : 'es'}
            {' '}({message.metrics.faceCount} face · {message.metrics.domCount} dom · {message.metrics.nerCount} ner)
            {' · '}face {message.metrics.faceMs}ms · dom {message.metrics.domMs}ms · ner {message.metrics.nerMs}ms
            {' · '}{message.metrics.dupesCollapsed} deduped · {message.metrics.totalMs}ms total
            {message.detectWarning ? ` — ${message.detectWarning}` : ''}
          </p>
        )}
        <ElementList
          elements={message.payload.snapshot.elements}
          selected={selected}
          onSelect={setSelected}
          truncated={message.payload.snapshot.truncated}
        />
      </details>
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
