/**
 * SIH 26171 — service worker (capture coordinator).
 *
 * Owns the ORDER of operations, which is the whole correctness story of
 * Phase 1:
 *
 *   1. Inject the content script (idempotent).
 *   2. Read the DOM  -> element rects + viewport context.
 *   3. Capture pixels -> PNG.
 *   4. Probe the viewport again -> did the page move between 2 and 3?
 *
 * Steps 2 and 3 must be adjacent with nothing awaited in between beyond the
 * calls themselves. Any delay lets the page scroll, a lazy image load, or an
 * animation reflow — and then every box we compute describes a page state
 * that the screenshot does not show.
 *
 * MV3 NOTE: this worker is ephemeral (terminated after ~30s idle). That is
 * fine for Phase 1 because each capture is a self-contained request/response
 * with no retained state. Phase 5's persistent WebSocket cannot live here —
 * it needs an offscreen document.
 */

import { MessagingError, NO_RECEIVER, sendToContent } from '../lib/messaging';
import type { ScreenshotCaptureResponse, SnapshotCaptureResponse } from '../types';

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
    runScreenshot(message.tabId, message.windowId)
      .then((result) => sendResponse({ ok: true, ...result } satisfies ScreenshotCaptureResponse))
      .catch((err: unknown) => {
        const { error, hint } = describeError(err);
        console.error('[SIH] screenshot failed', err);
        sendResponse({ ok: false, error, hint } satisfies ScreenshotCaptureResponse);
      });
    return true; // async response
  }

  return false;
});

/**
 * Phase 1 of capture: inject + read the DOM. Nothing about pixels here —
 * Phase 3a's redact-before-capture design means the panel must see this
 * snapshot, run detection, and mask the live DOM BEFORE anything asks for a
 * screenshot. See App.tsx's capture() for the full sequence.
 */
async function runSnapshot(): Promise<Omit<Extract<SnapshotCaptureResponse, { ok: true }>, 'ok'>> {
  const tab = await getActiveTab();
  if (!tab.id) throw new Error('Active tab has no id.');
  assertCapturable(tab.url ?? '');

  const injectStart = performance.now();
  await ensureContentScript(tab.id);
  const injectMs = since(injectStart);

  const snapshotStart = performance.now();
  const snapshotResponse = await sendToContent(tab.id, { type: 'SNAPSHOT_REQUEST' });
  if (snapshotResponse?.type !== 'SNAPSHOT_RESULT') {
    throw new Error('Content script returned an unexpected snapshot response.');
  }
  const snapshotMs = since(snapshotStart);

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    snapshot: snapshotResponse.snapshot,
    injectMs,
    snapshotMs,
  };
}

/**
 * Phase 2 of capture: pixels, then immediately unmask. `tabId`/`windowId`
 * come from the panel's Phase 1 response rather than re-resolving the active
 * tab — the tab we just masked is the one we must capture, regardless of
 * what has focus by the time the panel finishes its detection + masking
 * round trip (which now includes NER inference, on the order of hundreds of
 * ms — long enough that "the active tab" is no longer a safe re-query).
 */
async function runScreenshot(
  tabId: number,
  windowId: number,
): Promise<Omit<Extract<ScreenshotCaptureResponse, { ok: true }>, 'ok'>> {
  const screenshotStart = performance.now();
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const screenshotMs = since(screenshotStart);

  // Unmask immediately — nothing awaited between the capture above and this
  // call except the call itself, mirroring the old snapshot/screenshot
  // adjacency rule. A failed unmask leaves overlays visible on the live page
  // (a UX annoyance, reload fixes it) but is not a capture failure: the
  // pixels we needed are already safely in screenshotDataUrl.
  try {
    await sendToContent(tabId, { type: 'REMOVE_MASK_REQUEST' });
  } catch (err) {
    console.warn('[SIH] unmask failed; overlays may remain visible on the page', err);
  }

  return { screenshotDataUrl, screenshotMs };
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