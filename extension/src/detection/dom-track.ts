/**
 * SIH 26171 — Phase 2 DOM/regex detection track.
 *
 * The highest-precision of the three tracks: it reads the live DOM rather
 * than pixels, so it knows an <input type="password"> is a password without
 * inferring anything. Runs in the content script, at snapshot time, against
 * the same viewport the screenshot captured.
 *
 * TWO PASSES, IN PRECISION ORDER:
 *   1. ATTRIBUTES — semantic markup (input types, autocomplete tokens, ARIA
 *      names). Near-certain, and it catches fields that are EMPTY or masked,
 *      which no text scan can see.
 *   2. TEXT REGEX — the patterns.ts registry over visible text nodes. The box
 *      comes from a Range over the exact matched substring, not the element:
 *      redacting a whole <p> because it contains one email destroys the page
 *      and tanks the utility score.
 *
 * Every rect leaves here via coords.ts. No coordinate math lives in this file.
 */

import { clampToImage, domRectToImageBox, type CoordinateFrame } from '../lib/coords';
import type { DetectedBox, DomRect2D, PiiType } from '../types';
import { PII_PATTERNS } from './patterns';

/** Rects thinner than this are collapsed inline boxes, not readable text. */
const MIN_DIMENSION = 2;

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
]);

/**
 * Word-boundary matched, NOT substring matched. A naive `includes('pan')`
 * flags every "panel", "company", "expand" and "Spanish" on the page — the
 * single largest false-positive source in this track.
 */
const ID_HINT = /\b(aadhaar|aadhar|uidai|pan|ssn)\b/i;

/**
 * BUG FIX (found via live one-step-agent testing): a plain
 * `<input id="full-name" placeholder="Enter your name">` matched neither
 * ID_HINT nor any other rule, so it was never classified — and its typed
 * VALUE is invisible to collectTextMatches/NER too (an input's live value
 * is form-control internal state, never a DOM text node the tree walkers
 * below can see). Net effect: a name typed into such a field was not
 * redacted by ANY track. This regex, applied the same way ID_HINT already
 * is, closes that specific gap by classifying the FIELD itself (so it's
 * masked whether empty or filled, same as password fields).
 *
 * Narrow on purpose: matches "full-name", "Enter your name", "surname", but
 * NOT "username"/"companyName"/"brandname" — same word-boundary reasoning
 * ID_HINT already relies on (no boundary between concatenated words with no
 * separator). A field with no name/ID-hinting attribute at all (e.g. a
 * generic "Notes" textarea) remains a known, separate, undetected gap —
 * documented, not silently left implicit.
 */
const NAME_HINT = /\b(name|surname)\b/i;

/** HTML autocomplete tokens the spec defines for a person's name — checked
 *  before HINT_ATTRS below since this is a near-certain semantic signal,
 *  same precedence as the existing autocomplete="cc-*" check for CARD. */
const NAME_AUTOCOMPLETE = /(^|\s)(name|given-name|family-name|additional-name|honorific-prefix)(\s|$)/i;

/**
 * BUG FIX #2 (found via live testing, right after the NAME fix above): a
 * `<select id="state">` classifies correctly once this rule exists, but
 * unlike a plain text input, its VALUE was never going to be catchable any
 * other way — a closed <select>'s <option> elements are not laid out on the
 * page at all (no box for Range.getClientRects() to return), so even
 * fixing Track 3's CITY/STATE/ZIP_CODE keep-set (ner-detector.ts) could
 * never have redacted this: NER might classify the text, but boxing it via
 * a DOM Range structurally cannot work for an unlaid-out option. Attribute
 * classification of the whole <select> element — same mechanism as
 * password/name fields, boxing the visible closed-dropdown control itself
 * — is the only mechanism that can actually work here.
 */
const ADDRESS_HINT = /\b(state|city|address|pincode|postal[\s-]?code|zip[\s-]?code)\b/i;

/** HTML autocomplete tokens the spec defines for address components. */
const ADDRESS_AUTOCOMPLETE =
  /(^|\s)(address-line[123]|address-level[1234]|postal-code|country)(\s|$)/i;

/** Attributes that carry a human-meaningful label for a field. */
const HINT_ATTRS = ['aria-label', 'name', 'id', 'placeholder'] as const;

const CONFIDENCE = {
  /** Semantic markup: the browser itself tells us what this field is. */
  attribute: 0.98,
  /** Regex shape confirmed by a checksum. */
  validated: 0.95,
  /** Regex shape only — structurally distinctive but unverifiable. */
  shape: 0.8,
} as const;

/**
 * Scan the live DOM for PII and return boxes in image-pixel space.
 *
 * `frame` must be the frame built from THIS capture — boxes are only
 * meaningful against the screenshot whose dimensions produced it.
 */
export function detectDomPii(frame: CoordinateFrame): DetectedBox[] {
  const boxes: DetectedBox[] = [];
  const ids = new NodeIdSource();

  collectAttributeMatches(frame, ids, boxes);
  collectTextMatches(frame, ids, boxes);

  return boxes;
}

/* ------------------------------------------------------------------ */
/* Pass 1 — attribute matching                                         */
/* ------------------------------------------------------------------ */

function collectAttributeMatches(
  frame: CoordinateFrame,
  ids: NodeIdSource,
  out: DetectedBox[],
): void {
  const fields = document.querySelectorAll<HTMLElement>(
    'input, textarea, select, [autocomplete], [aria-label], [placeholder]',
  );

  for (const el of Array.from(fields)) {
    const hit = classifyElement(el);
    if (!hit) continue;

    const box = boxFor(el.getBoundingClientRect(), frame);
    if (!box) continue;

    out.push({
      imageBox: box,
      piiType: hit,
      subtype: subtypeForAttributeHit(el, hit),
      confidence: CONFIDENCE.attribute,
      source: 'DOM',
      nodeId: ids.for(el),
      // Deliberately no `text`: the value of a password or card field is the
      // secret itself, and the manifest is written to disk and shown in the
      // panel. We record WHERE it is, never WHAT it is.
    });
  }
}

function classifyElement(el: HTMLElement): PiiType | null {
  if (el instanceof HTMLInputElement && el.type === 'password') return 'PASSWORD';

  const autocomplete = el.getAttribute('autocomplete');
  if (autocomplete && /(^|\s)cc-/i.test(autocomplete)) return 'CARD';
  if (autocomplete && NAME_AUTOCOMPLETE.test(autocomplete)) return 'NAME';
  if (autocomplete && ADDRESS_AUTOCOMPLETE.test(autocomplete)) return 'ADDRESS';

  for (const attr of HINT_ATTRS) {
    const value = el.getAttribute(attr);
    if (value && ID_HINT.test(value)) return 'ID_NUMBER';
    if (value && NAME_HINT.test(value)) return 'NAME';
    if (value && ADDRESS_HINT.test(value)) return 'ADDRESS';
  }

  return null;
}

function subtypeForAttributeHit(el: HTMLElement, type: PiiType): string {
  if (type === 'PASSWORD') return 'password_field';
  if (type === 'CARD') return 'cc_number_field';
  if (type === 'NAME') return 'name_field';
  if (type === 'ADDRESS') return 'address_field';

  for (const attr of HINT_ATTRS) {
    const match = el.getAttribute(attr)?.match(ID_HINT);
    if (match) return `${match[1].toLowerCase()}_field`;
  }
  return 'id_field';
}

/* ------------------------------------------------------------------ */
/* Pass 2 — text regex matching                                        */
/* ------------------------------------------------------------------ */

function collectTextMatches(
  frame: CoordinateFrame,
  ids: NodeIdSource,
  out: DetectedBox[],
): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isRendered(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;

    for (const pattern of PII_PATTERNS) {
      // The registry's regexes are /g and therefore stateful. Today the loop
      // below always runs to exhaustion, and a failed exec() resets lastIndex
      // on its own — so this is belt-and-braces. It stops being redundant the
      // moment anyone adds an early `break` (a per-node match cap, say), at
      // which point the stale index silently skips matches in the NEXT node.
      pattern.regex.lastIndex = 0;

      for (
        let match = pattern.regex.exec(text);
        match;
        match = pattern.regex.exec(text)
      ) {
        if (match[0].length === 0) {
          pattern.regex.lastIndex++;
          continue;
        }
        if (pattern.validate && !pattern.validate(match[0])) continue;

        const rect = rectForSubstring(node, match.index, match[0].length);
        if (!rect) continue;

        const box = boxFor(rect, frame);
        if (!box) continue;

        out.push({
          imageBox: box,
          piiType: pattern.type,
          subtype: pattern.subtype,
          confidence: pattern.validate ? CONFIDENCE.validated : CONFIDENCE.shape,
          source: 'DOM',
          nodeId: node.parentElement ? ids.for(node.parentElement) : undefined,
          text: match[0],
        });
      }
    }
  }
}

/**
 * Box the matched substring itself, via a Range. Wrapped matches yield the
 * union of their line fragments — wider than strictly necessary, but
 * coords.ts's rule applies: over-covering is free, under-covering leaks.
 */
function rectForSubstring(node: Node, start: number, length: number): DOMRect | null {
  try {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + length);
    const rect = range.getBoundingClientRect();
    range.detach();
    return rect;
  } catch {
    // Offsets can fall outside the node if it mutated mid-walk.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * CSS rect -> clamped image box, or null if it contributes no pixels to the
 * screenshot. Rejects zero-area rects and anything scrolled out of the
 * viewport: those elements are not in the captured image at all.
 */
function boxFor(rect: DOMRect, frame: CoordinateFrame): DetectedBox['imageBox'] | null {
  if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return null;

  const plain: DomRect2D = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  // clampToImage rejects fully off-screen boxes and trims straddling ones,
  // so there is no separate viewport bounds check to keep in sync here.
  return clampToImage(domRectToImageBox(plain, frame), frame);
}

const HIDDEN_STYLE_CACHE = new WeakMap<Element, boolean>();

function isRendered(el: Element): boolean {
  const cached = HIDDEN_STYLE_CACHE.get(el);
  if (cached !== undefined) return cached;

  const style = getComputedStyle(el);
  const rendered =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    parseFloat(style.opacity) >= 0.05;

  HIDDEN_STYLE_CACHE.set(el, rendered);
  return rendered;
}

/**
 * Stable ids for the duration of ONE scan.
 *
 * KNOWN GAP: these do NOT join with SnapshotElement.nodeId — snapshot.ts
 * numbers its own traversal independently. Phase 3 needs one shared identity
 * space if the manifest is going to reference snapshot elements; the clean
 * fix is a single id source both passes consult, which touches snapshot.ts
 * and so is out of scope here.
 */
class NodeIdSource {
  private readonly assigned = new WeakMap<Element, string>();
  private counter = 0;

  for(el: Element): string {
    const existing = this.assigned.get(el);
    if (existing) return existing;

    const id = `d${this.counter++}`;
    this.assigned.set(el, id);
    return id;
  }
}
