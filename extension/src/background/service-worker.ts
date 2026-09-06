/**
 * SIH 26171 — service worker (capture coordinator).
 *
 * FULL-PAGE CAPTURE (CDP): captureVisibleTab only ever returned the current
 * viewport. The entire scrollable page, in one shot, requires the Chrome
 * DevTools Protocol — the same mechanism DevTools' own "Capture full size
 * screenshot" command uses — driven here via chrome.debugger:
 *
 *   1. Inject the content script (idempotent).
 *   2. Read the DOM -> element rects + viewport context (unchanged).
 *   2b. Attach a debugger session to the tab, Page.enable, then
 *       Page.getLayoutMetrics() for the full page's CSS size — the sole
 *       source of truth for "how big is this page," used both to build the
 *       pre-capture identity frame (for masking) and, re-queried, the real
 *       post-capture frame.
 *   3. Page.captureScreenshot({captureBeyondViewport:true, clip:<page size>})
 *      -> one PNG covering the whole page. The debugger detaches immediately
 *      after, in runScreenshot's finally block, whether capture succeeded or
 *      not — an attached-but-forgotten session leaves Chrome's "this
 *      extension is debugging this browser" banner up indefinitely.
 *   4. Probe the viewport again -> did the page move between 2 and 3?
 *
 * Because full-page capture never scrolls (see coords.ts's module doc),
 * getBoundingClientRect() stays viewport-relative AND page-relative for the
 * whole capture — no scroll-offset math was added anywhere for this.
 *
 * MV3 NOTE: this worker is ephemeral (terminated after ~30s idle). That is
 * fine here because each capture is a self-contained request/response with
 * no retained state across calls — the debugger session lives on the TAB via
 * chrome.debugger, not in this worker's memory, so it survives the worker
 * itself being recycled between the snapshot and screenshot round trips.
 * Phase 5's one-shot HTTP call to the Phase 4 server has the same property
 * for the same reason (see agent/server-client.ts's doc comment).
 */

import { MessagingError, NO_RECEIVER, sendToContent } from '../lib/messaging';
import type {
  CaptureAbortResponse,
  ScreenshotCaptureResponse,
  SnapshotCaptureResponse,
} from '../types';

/** CDP protocol version chrome.debugger negotiates against — a broadly
 *  compatible marker string, not a Chrome build number. */
const CDP_VERSION = '1.3';

/** Clicking the toolbar icon opens the side panel. Page access is granted
 *  separately, by the Capture button requesting the optional host permission
 *  (see sidepanel/App.tsx) — opening the panel alone does not grant it. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[SIH] setPanelBehavior failed', err));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only handle panel requests here; content-script replies are routed by
  // their own sendResponse channel and must not be intercepted.
  if (message?.type === 'CAPTURE_SNAPSHOT_REQUEST') {
    runSnapshot()
      .then((result) => sendResponse({ ok: true, ...result } satisfies SnapshotCaptureResponse))
      .catch((err: unknown) => {
        const { error, hint } = describeError(err);
        console.error('[SIH] snapshot failed', err);
        sendResponse({ ok: false, error, hint } satisfies SnapshotCaptureResponse);
      });
    return true; // async response
  }

  if (message?.type === 'CAPTURE_SCREENSHOT_REQUEST') {
    runScreenshot(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result } satisfies ScreenshotCaptureResponse))
      .catch((err: unknown) => {
        const { error, hint } = describeError(err);
        console.error('[SIH] screenshot failed', err);
        sendResponse({ ok: false, error, hint } satisfies ScreenshotCaptureResponse);
      });
    return true; // async response
  }

  if (message?.type === 'CAPTURE_ABORT_REQUEST') {
    chrome.debugger
      .detach({ tabId: message.tabId })
      .catch(() => undefined) // already detached, or never attached — fine
      .finally(() => sendResponse({ ok: true } satisfies CaptureAbortResponse));
    return true; // async response
  }

  return false;
});

/**
 * Phase 1 of capture: inject + read the DOM, then attach CDP and learn the
 * full page's CSS size. Nothing about pixels here — Phase 3a's
 * redact-before-capture design means the panel must see this snapshot, run
 * detection, and mask the live DOM BEFORE anything asks for a screenshot.
 * See App.tsx's capture() for the full sequence.
 *
 * The debugger is attached here and stays attached until runScreenshot's
 * finally block detaches it (or CAPTURE_ABORT_REQUEST does, if the panel's
 * flow throws before reaching that point) — one session for the whole
 * capture cycle, not one per CDP call.
 */
async function runSnapshot(): Promise<Omit<Extract<SnapshotCaptureResponse, { ok: true }>, 'ok'>> {
  const tab = await getActiveTab();
  if (!tab.id) throw new Error('Active tab has no id.');
  const tabId = tab.id;
  assertCapturable(tab.url ?? '');

  const injectStart = performance.now();
  await ensureContentScript(tabId);
  const injectMs = since(injectStart);

  const snapshotStart = performance.now();
  const snapshotResponse = await sendToContent(tabId, { type: 'SNAPSHOT_REQUEST' });
  if (snapshotResponse?.type !== 'SNAPSHOT_RESULT') {
    throw new Error('Content script returned an unexpected snapshot response.');
  }
  const snapshotMs = since(snapshotStart);

  let pageWidth: number;
  let pageHeight: number;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    ({ width: pageWidth, height: pageHeight } = await getFullPageSize(tabId));
  } catch (err) {
    // Attach may have partially succeeded (e.g. enable/getLayoutMetrics
    // failed after a real attach) — detach defensively so a failure here
    // never leaves the debugging banner up with nothing to show for it.
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw describeCdpError(err);
  }

  return {
    tabId,
    snapshot: snapshotResponse.snapshot,
    pageWidth,
    pageHeight,
    injectMs,
    snapshotMs,
  };
}

/**
 * Phase 2 of capture: the full-page screenshot via CDP, then immediately
 * unmask, then always detach — in that order, mirroring the old
 * snapshot/screenshot adjacency rule (nothing unnecessary awaited between
 * the pixels landing and the unmask call). `tabId` comes from the panel's
 * Phase 1 response, not a re-resolved active tab — the tab we just masked is
 * the one we must capture, regardless of what has focus by the time the
 * panel finishes its detection + masking round trip.
 */
async function runScreenshot(
  tabId: number,
): Promise<Omit<Extract<ScreenshotCaptureResponse, { ok: true }>, 'ok'>> {
  try {
    const screenshotStart = performance.now();
    const { width, height } = await getFullPageSize(tabId);
    const { data } = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })) as { data: string };
    const screenshotDataUrl = `data:image/png;base64,${data}`;
    const screenshotMs = since(screenshotStart);

    // Unmask immediately — a failed unmask leaves overlays visible on the
    // live page (a UX annoyance, reload fixes it) but is not a capture
    // failure: the pixels we needed are already safely in screenshotDataUrl.
    try {
      await sendToContent(tabId, { type: 'REMOVE_MASK_REQUEST' });
    } catch (err) {
      console.warn('[SIH] unmask failed; overlays may remain visible on the page', err);
    }

    return { screenshotDataUrl, screenshotMs };
  } catch (err) {
    throw describeCdpError(err);
  } finally {
    // Always — success or failure — so the "debugging this browser" banner
    // never outlives one capture cycle.
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
}

/** Page.getLayoutMetrics()'s cssContentSize — the full scrollable page, CSS
 *  px. The sole source of truth for "how big is this page," queried fresh
 *  here rather than threaded through messages, so a layout change between
 *  the snapshot and screenshot steps (rare, but possible) doesn't leave the
 *  two calls disagreeing about page size. */
async function getFullPageSize(tabId: number): Promise<{ width: number; height: number }> {
  const metrics = (await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics')) as {
    cssContentSize: { width: number; height: number };
  };
  return metrics.cssContentSize;
}

/** chrome.debugger's most common real failure — another debugger client
 *  (frequently actual DevTools) already attached — surfaces as a plain
 *  Error with a distinctive message. Give it a hint instead of a raw
 *  protocol string; every other failure passes through unchanged. */
function describeCdpError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/already attached/i.test(message)) {
    return new MessagingError(
      'Another debugger (often Chrome DevTools) is already attached to this tab.',
      'DEBUGGER_BUSY',
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/* ------------------------------------------------------------------ */

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  // NOT {active, currentWindow}: when DevTools or the side panel is focused,
  // "currentWindow" can resolve to that window and return the wrong tab (or a
  // chrome:// one), which is why capture failed while DevTools was open.
  //
  // tab.url is populated here because our host_permissions match http/https
  // URLs (Chrome fills url/title when host permissions cover the tab, even
  // without the "tabs" permission).
  const win = await chrome.windows.getLastFocused({ populate: true });
  const active = win.tabs?.find((t) => t.active);
  if (active && /^https?:/.test(active.url ?? '')) return active;

  // Fallback: search all normal windows for an active web tab. Handles the
  // case where the last-focused window is DevTools or our own panel.
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  for (const w of wins) {
    const t = w.tabs?.find((t) => t.active && /^https?:/.test(t.url ?? ''));
    if (t) return t;
  }

  throw new MessagingError(
    'No normal web page tab is active.',
    'RESTRICTED_PAGE',
  );
}

/** Chrome refuses to inject into its own pages, the Web Store, and other
 *  extensions. Failing here with a clear message beats an opaque API error. */
function assertCapturable(url: string): void {
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://'];
  if (blocked.some((p) => url.startsWith(p)) || url.includes('chromewebstore.google.com')) {
    throw new MessagingError(
      'This page is protected by the browser and cannot be captured.',
      'RESTRICTED_PAGE',
    );
  }
}

/**
 * Inject if absent. We attempt a cheap probe first: if the script is already
 * there, injection is skipped entirely, saving ~20-40ms per capture.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToContent(tabId, { type: 'VIEWPORT_PROBE' }, 500);
    return; // already installed
  } catch (err) {
    if (!(err instanceof MessagingError) || err.code === 'TIMEOUT') {
      // Timeout means something IS listening but is wedged; re-injecting
      // will not help, so surface it.
      if (err instanceof MessagingError && err.code === 'TIMEOUT') throw err;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/index.js'],
  });
}

function since(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function describeError(err: unknown): { error: string; hint?: string } {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof MessagingError && err.code === 'DEBUGGER_BUSY') {
    return {
      error: message,
      hint: 'Close DevTools on this tab (it holds the same debugger slot Chrome only allows one client on), then capture again.',
    };
  }

  if (err instanceof MessagingError && err.code === 'RESTRICTED_PAGE') {
    return {
      error: message,
      hint: 'Open a normal website tab and capture again.',
    };
  }

  if (
    message.includes('chrome://') ||
    message.includes('Cannot access a chrome') ||
    err instanceof MessagingError && err.code === 'RESTRICTED_PAGE'
  ) {
    return {
      error: 'This is a browser page and cannot be captured.',
      hint: 'Switch to a normal website tab (e.g. wikipedia.org), click the icon there, then capture.',
    };
  }

  if (message.includes('activeTab') || message.includes('Cannot access contents')) {
    return {
      error: 'No access to this tab yet.',
      hint: 'Click the extension icon on this page to grant access, then capture again.',
    };
  }

  if (err instanceof MessagingError && err.code === NO_RECEIVER) {
    return {
      error: 'The page script is not responding.',
      hint: 'Reload the page and capture again.',
    };
  }

  return { error: message };
}