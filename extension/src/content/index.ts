/**
 * SIH 26171 — content script entry.
 *
 * Injected on demand by the service worker via chrome.scripting.executeScript,
 * NOT declared in the manifest. That choice is deliberate:
 *   - A declarative content script with "matches": ["<all_urls>"] requests
 *     broad host access at install time. For a privacy project, asking for
 *     permanent access to every site is the wrong first impression.
 *   - On-demand injection runs our code only on the tab the user explicitly
 *     invoked the extension on, which is also less client-side work.
 *
 * Because injection can happen repeatedly on the same page, this script must
 * be idempotent — otherwise each capture stacks another onMessage listener
 * and the same snapshot gets computed N times.
 */

import { onContentMessage } from '../lib/messaging';
import { captureViewportContext, takeSnapshot } from './snapshot';
import type { ContentRequest, ContentResponse } from '../types';

declare global {
  interface Window {
    __sihContentInstalled?: boolean;
  }
}

if (!window.__sihContentInstalled) {
  window.__sihContentInstalled = true;

  onContentMessage(async (message: ContentRequest): Promise<ContentResponse> => {
    switch (message.type) {
      case 'SNAPSHOT_REQUEST':
        return { type: 'SNAPSHOT_RESULT', snapshot: takeSnapshot() };

      // Cheap second read taken AFTER the screenshot, so the service worker
      // can tell whether the page moved between the DOM read and the pixels.
      case 'VIEWPORT_PROBE':
        return { type: 'VIEWPORT_RESULT', viewport: captureViewportContext() };
    }
  });

  console.debug('[SIH 26171] content script ready');
}
