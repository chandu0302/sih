/**
 * SIH 26171 — DOM snapshot.
 *
 * Produces a FLAT list of salient elements, not a nested tree of the whole
 * document. Three reasons:
 *   1. Phase 4's VLM needs targetable elements with names and boxes; it has
 *      no use for <div> nesting depth.
 *   2. A full tree on a real page is hundreds of KB. We ship this over the
 *      network every agent step — size is latency (15% of the score) and
 *      client work (20%).
 *   3. Flat lists are trivially filterable by the Phase 2 PII tracks.
 *
 * The model is the accessibility tree: what can a user perceive and act on?
 */

import type {
  DomRect2D,
  DomSnapshot,
  SnapshotElement,
  ViewportContext,
} from '../types';

/** Hard ceiling. Dense pages (search results, dashboards) can hold thousands
 *  of nodes; beyond a few hundred the VLM cannot use them anyway. */
const MAX_ELEMENTS = 300;

/** Boxes smaller than this in CSS px are tracking pixels, spacers, or
 *  decorative slivers. */
const MIN_DIMENSION = 4;

const TEXT_TRUNCATE = 160;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Block-level text containers worth reporting. Deliberately excludes bare
 *  <div>/<span> — they are usually layout wrappers, and their text is already
 *  covered by the specific tags below. */
const TEXT_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,label,legend,caption,figcaption,blockquote';

/** Never traverse into these. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

/* ------------------------------------------------------------------ */

export function captureViewportContext(): ViewportContext {
  return {
    dpr: window.devicePixelRatio,
    // Report BOTH candidate denominators and let createCoordinateFrame decide.
    // innerWidth includes the classic scrollbar, clientWidth excludes it; the
    // difference is ~15px and which one matches the captured PNG is not
    // reliably knowable in advance. See ViewportContext in types.ts.
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth || window.innerWidth,
    clientHeight: document.documentElement.clientHeight || window.innerHeight,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    url: location.href,
  };
}

export function takeSnapshot(): DomSnapshot {
  const started = performance.now();

  const viewport = captureViewportContext();
  const seen = new Set<Element>();
  const elements: SnapshotElement[] = [];
  let counter = 0;
  let truncated = false;

  const consider = (el: Element, interactive: boolean): boolean => {
    if (seen.has(el)) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (!isVisibleInViewport(el, rect, viewport)) return true;

    if (elements.length >= MAX_ELEMENTS) {
      truncated = true;
      return false;
    }

    elements.push(
      buildElement(el, rect, interactive, `n${counter++}`),
    );
    return true;
  };

  // Interactive first: if we hit the cap, actionable elements are the ones
  // worth keeping. The agent can click a button; it cannot click a paragraph.
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (!consider(el, true)) break;
  }
  for (const el of Array.from(document.querySelectorAll(TEXT_SELECTOR))) {
    if (!consider(el, false)) break;
  }

  return {
    elements,
    viewport,
    traversalMs: Math.round((performance.now() - started) * 100) / 100,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

/**
 * KNOWN GAP (Phase 1): this does not handle occlusion. An element behind a
 * modal, a cookie banner, or a sticky header passes as visible because it has
 * a non-zero rect and visible styles. Phase 2 can add elementFromPoint
 * hit-testing if PII false-positives on hidden layers become a problem.
 */
function isVisibleInViewport(
  el: Element,
  rect: DOMRect,
  viewport: ViewportContext,
): boolean {
  if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return false;

  // Fully outside the captured viewport => not in the screenshot at all.
  if (rect.bottom <= 0 || rect.right <= 0) return false;
  if (rect.top >= viewport.clientHeight || rect.left >= viewport.clientWidth) return false;

  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) < 0.05) return false;

  return true;
}

/* ------------------------------------------------------------------ */
/* Element construction                                                */
/* ------------------------------------------------------------------ */

function buildElement(
  el: Element,
  rect: DOMRect,
  isInteractive: boolean,
  nodeId: string,
): SnapshotElement {
  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? el.type : undefined;
  const text = visibleText(el);

  return {
    nodeId,
    tag,
    type,
    role: resolveRole(el, tag, type),
    name: accessibleName(el, text),
    text: text || undefined,
    rect: toPlainRect(rect),
    selector: cssPath(el),
    isInteractive,
  };
}

/** DOMRect is not structured-cloneable across the message boundary in all
 *  browsers, and we only want four of its properties. */
function toPlainRect(rect: DOMRect): DomRect2D {
  return {
    left: Math.round(rect.left * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  };
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  li: 'listitem',
  td: 'cell',
  th: 'columnheader',
  p: 'paragraph',
  label: 'label',
  img: 'img',
  summary: 'button',
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  submit: 'button',
  button: 'button',
  reset: 'button',
  range: 'slider',
  search: 'searchbox',
};

function resolveRole(el: Element, tag: string, type?: string): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (tag === 'input') return INPUT_ROLES[type ?? ''] ?? 'textbox';
  return IMPLICIT_ROLES[tag] ?? 'generic';
}

/**
 * Accessible-name resolution, simplified from the ARIA spec. Order matters:
 * an explicit aria-label always beats inferred text.
 *
 * This is the field the VLM will use to target elements in Phase 4, so it is
 * worth more than the raw tag name.
 */
function accessibleName(el: Element, text: string): string {
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return truncate(ariaLabel);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const names = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (names.length) return truncate(names.join(' '));
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const labelText = Array.from(labels)
        .map((l) => l.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (labelText) return truncate(labelText);
    }
    const placeholder = el.getAttribute('placeholder')?.trim();
    if (placeholder) return truncate(placeholder);
  }

  const alt = el.getAttribute('alt')?.trim();
  if (alt) return truncate(alt);

  const title = el.getAttribute('title')?.trim();
  if (title) return truncate(title);

  if (text) return truncate(text);

  const value = el.getAttribute('value')?.trim();
  if (value) return truncate(value);

  return '';
}

/** Text belonging to this element, not its descendants' whole subtree. */
function visibleText(el: Element): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, TEXT_TRUNCATE);
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_TRUNCATE ? `${flat.slice(0, TEXT_TRUNCATE)}…` : flat;
}

/**
 * Best-effort CSS path.
 *
 * PHASE 5 WARNING: this is adequate for identifying elements in a snapshot,
 * but it is NOT a robust action selector. Framework-generated class names
 * (styled-components, Tailwind JIT, CSS modules) change between builds, and
 * nth-of-type breaks when a list reorders. Phase 5 should either resolve
 * actions by nodeId against a retained WeakMap, or add a stability score.
 */
function cssPath(el: Element): string {
  const id = el.getAttribute('id');
  if (id && isStableId(id) && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
    return `#${CSS.escape(id)}`;
  }

  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;

  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 6) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break;

    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === node!.tagName,
    );
    parts.unshift(
      siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
    );

    node = parent;
    depth++;
  }

  return parts.join(' > ');
}

/** Reject auto-generated ids (React, Emotion, Angular) that change per render. */
function isStableId(id: string): boolean {
  if (/^[0-9]/.test(id)) return false;
  if (/^(radix|mui|headlessui|:r|__)/i.test(id)) return false;
  if (/^[a-f0-9]{8,}$/i.test(id)) return false;
  return true;
}
