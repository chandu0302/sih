/**
 * SIH 26171 — Track 3 4b: DOM text pipeline for the NER model.
 *
 * The content-script half of Track 3. The model itself runs in the panel
 * (ner-detector.ts, Track 3 4a); this file assembles the page's visible
 * text for the model to read, premasks the structured IDs Track 1's regex
 * already owns, and turns each NER-detected `word` back into pixel boxes.
 * No model, no messaging — those are 4c.
 *
 * THE HARD PART: offset recovery. transformers.js returns
 * `{ entity_group, score, word }` with NO character offsets (confirmed in
 * 4a — see ner-detector.ts's NerSpan doc comment). So spansToBoxes()
 * re-locates each `word` in the assembled text via a monotonic cursor
 * search, then converts the recovered [start, end) into a DOM Range and
 * from there into image-pixel boxes via coords.ts, exactly like
 * dom-track.ts's boxFor.
 *
 * THE ASYMMETRY TO KEEP STRAIGHT: assembleVisibleText() produces ONE
 * assembled `text`, but it is used two different ways:
 *   - premask(text) is what the model actually reads (4c sends this).
 *   - spansToBoxes searches the ORIGINAL, un-premasked `text` — because the
 *     model's returned `word` is the real entity text, and premask tokens
 *     like "[PHONE]" would never match it. Same assembled text, two
 *     independent derivations from it. Do not premask before boxing.
 */

import { clampToImage, domRectToImageBox, type CoordinateFrame } from '../lib/coords';
import type { DetectedBox, DomRect2D, ImageBox } from '../types';
import type { NerSpan } from './ner-detector';
import { PII_PATTERNS } from './patterns';

/* ------------------------------------------------------------------ */
/* Shared DOM-walk filter — duplicated from dom-track.ts               */
/* ------------------------------------------------------------------ */

/**
 * KNOWN GAP, same shape as dom-track.ts's NodeIdSource note: this SKIP_TAGS
 * set and isRendered() are copy-pasted from dom-track.ts rather than
 * shared. Converging the two walkers into one shared traversal is P5 work
 * (it touches dom-track.ts, which is out of scope here) — for now, two
 * detectors independently deciding "is this text visible" is acceptable
 * duplication, not drift, as long as both copies stay this small.
 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
]);

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

/* ------------------------------------------------------------------ */
/* 1. assembleVisibleText                                              */
/* ------------------------------------------------------------------ */

/** One text node's span in the assembled string. [start, end), separator excluded. */
export interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * Walk visible text nodes (same filter as dom-track.ts's collectTextMatches
 * walker) and concatenate them into one string, joined by `\n`.
 *
 * The separator matters: without it, "John" in one element followed
 * immediately by "Smith" in a sibling element would read as "JohnSmith" to
 * the model — a fused, fictitious word the page never actually shows
 * adjacent. `\n` gives the model (and premask's regexes) a real boundary.
 */
export function assembleVisibleText(): { text: string; segments: TextSegment[] } {
  const segments: TextSegment[] = [];
  const parts: string[] = [];
  let cursor = 0;

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
    const text = node as Text;
    const value = text.nodeValue ?? '';

    if (parts.length > 0) {
      parts.push('\n');
      cursor += 1;
    }

    const start = cursor;
    parts.push(value);
    cursor += value.length;
    segments.push({ node: text, start, end: cursor });
  }

  return { text: parts.join(''), segments };
}

/* ------------------------------------------------------------------ */
/* 2. premask                                                          */
/* ------------------------------------------------------------------ */

/**
 * The reference impl (github.com/plingampally/meridianpii) that would have
 * confirmed the exact training-time premask token is NOT PUBLIC (404 as of
 * 4c). So the `[SUBTYPE]` sentinel below stays a reasonable, unverified
 * default rather than a confirmed match — this is a Phase-6 recall-tuning
 * knob (does the model do better or worse with a different placeholder
 * shape?), not an unknown blocking integration. The premasking is
 * structurally correct and tested regardless of the token's exact text.
 */
function premaskToken(subtype: string): string {
  return `[${subtype.toUpperCase()}]`;
}

/**
 * Replace every PII_PATTERNS match (Track 1's structured-ID regexes, same
 * registry dom-track.ts uses) with a category sentinel, so the NER model
 * spends its capacity on names/addresses rather than IDs Track 1 already
 * owns — and doesn't emit the email-local-part name noise 4a observed on
 * unmasked text.
 *
 * Length-independence is the key simplification: the returned string is
 * used ONLY as model input (see the module doc's asymmetry note) — offset
 * recovery in spansToBoxes runs against the ORIGINAL text, never this one.
 * So the mask can be any length; nothing downstream needs premask(text) to
 * stay character-aligned with text.
 */
export function premask(text: string): string {
  const matches: Array<{ start: number; end: number; token: string }> = [];

  for (const pattern of PII_PATTERNS) {
    // /g regexes are stateful; always reset before a fresh scan of the whole
    // string (mirrors dom-track.ts's collectTextMatches, same reasoning).
    pattern.regex.lastIndex = 0;

    for (let m = pattern.regex.exec(text); m; m = pattern.regex.exec(text)) {
      if (m[0].length === 0) {
        pattern.regex.lastIndex++;
        continue;
      }
      if (pattern.validate && !pattern.validate(m[0])) continue;

      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        token: premaskToken(pattern.subtype),
      });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlaps an already-applied match; skip
    result += text.slice(cursor, m.start) + m.token;
    cursor = m.end;
  }
  result += text.slice(cursor);

  return result;
}

/* ------------------------------------------------------------------ */
/* Monotonic cursor search                                             */
/* ------------------------------------------------------------------ */

/**
 * Find `word` in `text` at or after `cursor`. Pure.
 *
 * MONOTONIC ON PURPOSE: NER spans arrive in document order, so searching
 * from `cursor` — not 0 — prevents re-finding an earlier occurrence of a
 * repeated word ("Kumar" mentioned twice must resolve to two distinct
 * positions, in order, not the first one twice).
 *
 * Returns null (never throws) when `word` cannot be found from `cursor`
 * onward — this happens in practice (SentencePiece decode vs. source
 * mismatch, Unicode normalization differences), and the caller's job is to
 * skip that span, not guess a position.
 */
export function findNextOccurrence(text: string, word: string, cursor: number): number | null {
  if (word.length === 0) return null;
  const idx = text.indexOf(word, cursor);
  return idx === -1 ? null : idx;
}

/* ------------------------------------------------------------------ */
/* 3. spansToBoxes                                                     */
/* ------------------------------------------------------------------ */

/** Rects thinner than this are collapsed inline boxes, not readable text. */
const MIN_DIMENSION = 2;

/** CSS rect -> clamped image box, or null. Same path as dom-track.ts's boxFor. */
function boxFor(rect: DOMRect, frame: CoordinateFrame): ImageBox | null {
  if (rect.width < MIN_DIMENSION || rect.height < MIN_DIMENSION) return null;

  const plain: DomRect2D = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  return clampToImage(domRectToImageBox(plain, frame), frame);
}

/**
 * Turn NER spans into image-pixel boxes.
 *
 * For each span, in order: locate `word` in `text` via the monotonic cursor
 * (skip + warn on not-found, never throw), find the text segment(s) the
 * recovered [start, end) falls in, build a Range across them (a Range CAN
 * cross nodes — a name split by inline markup like `<b>`), and read
 * `range.getClientRects()` rather than the union `getBoundingClientRect()`:
 * one box PER VISUAL LINE. dom-track.ts deliberately over-covers with the
 * union rect; here, per-line rects are tighter, which helps redaction
 * precision (20% of the rubric) at the cost of possibly multiple boxes per
 * entity — that trade is correct for a model-scored span, wrong for the
 * DOM track's semantic-attribute boxes, which is why the two tracks differ.
 */
export function spansToBoxes(
  spans: NerSpan[],
  text: string,
  segments: TextSegment[],
  frame: CoordinateFrame,
): DetectedBox[] {
  const boxes: DetectedBox[] = [];
  let cursor = 0;

  for (const span of spans) {
    const idx = findNextOccurrence(text, span.word, cursor);
    if (idx === null) {
      console.warn(`[SIH] NER span "${span.word}" not found in assembled text; skipping.`);
      continue;
    }

    const globalStart = idx;
    const globalEnd = idx + span.word.length;
    cursor = globalEnd; // monotonic: never search behind this again

    const startSeg = segments.find((s) => s.start <= globalStart && globalStart < s.end);
    const endSeg = segments.find((s) => s.start < globalEnd && globalEnd <= s.end);
    if (!startSeg || !endSeg) {
      console.warn(`[SIH] NER span "${span.word}" offsets fall outside any text node; skipping.`);
      continue;
    }

    let range: Range;
    try {
      range = document.createRange();
      range.setStart(startSeg.node, globalStart - startSeg.start);
      range.setEnd(endSeg.node, globalEnd - endSeg.start);
    } catch {
      // Offsets can fall outside a node if the DOM mutated after assembly.
      console.warn(`[SIH] NER span "${span.word}" produced an invalid Range; skipping.`);
      continue;
    }

    for (const rect of Array.from(range.getClientRects())) {
      const imageBox = boxFor(rect, frame);
      if (!imageBox) continue;

      boxes.push({
        imageBox,
        piiType: span.piiType,
        subtype: `ner_${span.label.toLowerCase()}`,
        confidence: span.score,
        source: 'NER_MODEL',
        text: span.word,
      });
    }

    range.detach();
  }

  return boxes;
}

/* ------------------------------------------------------------------ */
/* Orchestrator — the content script's call site, wired in 4c          */
/* ------------------------------------------------------------------ */

/**
 * Assemble the page's visible text and box the given (already-classified)
 * NER spans against it. `premask` is exported separately: 4c sends
 * `premask(assembleVisibleText().text)` to the model, then passes the
 * model's spans back through THIS function — reusing the same assembled
 * text for boxing, per the module doc's asymmetry note.
 */
export function detectNerBoxes(spans: NerSpan[], frame: CoordinateFrame): DetectedBox[] {
  const { text, segments } = assembleVisibleText();
  return spansToBoxes(spans, text, segments, frame);
}
