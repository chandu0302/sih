/**
 * SIH 26171 — typed message passing.
 *
 * Chrome's messaging APIs are untyped and fail silently in ways that are
 * miserable to debug (a rejected promise in a service worker often just
 * disappears). These wrappers give us types at the boundary and turn the
 * common failure modes into readable errors.
 */

import type { ContentRequest, ContentResponse } from '../types';

/** Content scripts are injected on demand, so "no receiver" is expected and
 *  recoverable (we inject, then retry) rather than a real failure. */
export const NO_RECEIVER = 'NO_RECEIVER';

export class MessagingError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'MessagingError';
  }
}

/**
 * Send a typed message to a tab's content script.
 *
 * `chrome.tabs.sendMessage` rejects with "Could not establish connection"
 * when nothing is listening — which happens whenever the content script has
 * not been injected yet, or the page navigated. We normalize that to
 * NO_RECEIVER so callers can inject and retry.
 */
export async function sendToContent(
  tabId: number,
  message: ContentRequest,
  timeoutMs = 5000,
): Promise<ContentResponse> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new MessagingError(
            `Content script did not respond within ${timeoutMs}ms.`,
            'TIMEOUT',
          ),
        ),
      timeoutMs,
    ),
  );

  const send = chrome.tabs.sendMessage(tabId, message).catch((err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    if (text.includes('Could not establish connection') || text.includes('Receiving end')) {
      throw new MessagingError(text, NO_RECEIVER);
    }
    throw new MessagingError(text);
  });

  return (await Promise.race([send, timeout])) as ContentResponse;
}

/**
 * Register a content-script listener.
 *
 * The `return true` is load-bearing: it tells Chrome the response will arrive
 * asynchronously and keeps the message channel open. Without it the sender's
 * promise resolves as undefined and the bug looks like a data problem.
 */
export function onContentMessage(
  handler: (message: ContentRequest) => Promise<ContentResponse>,
): void {
  chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
    handler(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        console.error('[SIH] content handler failed', err);
        sendResponse(undefined as never);
      });
    return true;
  });
}
