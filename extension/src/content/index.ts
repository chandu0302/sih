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
 *
 * TRACK 3 (4c): the NER model runs in the panel (WebGPU/CSP need a document
 * context), but the DOM text + boxing must run here, where the DOM is. The
 * panel messages this script directly (sendToContent(tabId, ...)) rather
 * than routing through the service worker — see types.ts's ContentRequest
 * doc comment.
 */

import { onContentMessage } from '../lib/messaging';
import { captureViewportContext, takeSnapshot } from './snapshot';
import type { ContentRequest, ContentResponse } from '../types';
import { assembleVisibleText, premask, spansToBoxes, type TextSegment } from '../detection/ner-track';
import { detectDomPii } from '../detection/dom-track';

declare global {
  interface Window {
    __sihContentInstalled?: boolean;
  }
}

if (!window.__sihContentInstalled) {
  window.__sihContentInstalled = true;

  /**
   * NER_TEXT_REQUEST assembles + caches this; NER_BOX_REQUEST searches it.
   * Lives in this module's closure so the cached `Text` node references
   * (segments) never have to cross a message boundary — only the resulting
   * `text` string, spans, frame, and boxes do, all structured-clone-safe.
   *
   * A stale cache (DOM mutated between the two requests) is not specially
   * guarded here: spansToBoxes already skips-and-warns on an offset that no
   * longer lands in a valid node rather than throwing, which is the correct
   * behavior for this case too.
   */
  let lastAssembly: { text: string; segments: TextSegment[] } | null = null;

  onContentMessage(async (message: ContentRequest): Promise<ContentResponse> => {
    switch (message.type) {
      case 'SNAPSHOT_REQUEST':
        return { type: 'SNAPSHOT_RESULT', snapshot: takeSnapshot() };

      // Cheap second read taken AFTER the screenshot, so the service worker
      // can tell whether the page moved between the DOM read and the pixels.
      case 'VIEWPORT_PROBE':
        return { type: 'VIEWPORT_RESULT', viewport: captureViewportContext() };

      case 'NER_TEXT_REQUEST': {
        const { text, segments } = assembleVisibleText();
        lastAssembly = { text, segments };
        // premask(text) is what the model reads. spansToBoxes below searches
        // the ORIGINAL text, cached above — same assembled text, two
        // independent derivations. See ner-track.ts's module doc.
        return { type: 'NER_TEXT_RESULT', nerText: premask(text) };
      }

      case 'NER_BOX_REQUEST': {
        if (!lastAssembly) {
          // NER_TEXT_REQUEST was never sent first (or the script was
          // reinjected in between, resetting this closure) — nothing to
          // search against. Empty, not an error: the panel already has a
          // usable capture without Track 3 boxes.
          return { type: 'NER_BOX_RESULT', boxes: [] };
        }
        const boxes = spansToBoxes(
          message.spans,
          lastAssembly.text,
          lastAssembly.segments,
          message.frame,
        );
        return { type: 'NER_BOX_RESULT', boxes };
      }

      case 'DOM_PII_REQUEST':
        return { type: 'DOM_PII_RESULT', boxes: detectDomPii(message.frame) };
    }
  });

  console.debug('[SIH 26171] content script ready');
}
