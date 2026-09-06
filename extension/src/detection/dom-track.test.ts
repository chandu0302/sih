/**
 * SIH 26171 — DOM detection track tests.
 *
 * jsdom has no layout engine: every getBoundingClientRect() returns zeros and
 * Range.prototype.getBoundingClientRect does not exist AT ALL. Both matter —
 * a zero-area rect is filtered out by the track, and the missing Range method
 * throws a TypeError that rectForSubstring's catch would swallow, yielding
 * silently zero text detections.
 *
 * So we install a deterministic fake layout below. It is a monospace model:
 * every character is CHAR_W wide, every line LINE_H tall. The important
 * property is that a Range's rect DEPENDS ON ITS OFFSETS — otherwise the
 * "boxes the matched substring, not the whole element" assertion would pass
 * even if the code boxed the entire paragraph, which is the exact bug the
 * Range path exists to prevent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFullPageFrame } from '../lib/coords';
import type { DetectedBox, ViewportContext } from '../types';
import { detectDomPii } from './dom-track';

/* ------------------------------------------------------------------ */
/* Fake layout                                                         */
/* ------------------------------------------------------------------ */

const CHAR_W = 8;
const LINE_H = 20;
const ORIGIN_X = 10;
const FIRST_Y = 40;
/** Width used for elements that render a control rather than text. */
const FIELD_W = 200;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

/**
 * An element's box. `data-rect="left,top,width,height"` overrides the layout
 * for cases that need a specific geometry (off-screen, zero-area).
 */
function elementRect(el: Element): DOMRect {
  const override = el.getAttribute('data-rect');
  if (override) {
    const [left, top, width, height] = override.split(',').map(Number);
    return rect(left, top, width, height);
  }

  const index = Array.from(document.querySelectorAll('*')).indexOf(el);
  const isField = el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA';
  const width = isField ? FIELD_W : (el.textContent?.length ?? 0) * CHAR_W;

  return rect(ORIGIN_X, FIRST_Y + index * LINE_H, width, LINE_H);
}

const originalElementRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return elementRect(this);
  };

  // Not an override — jsdom does not define this at all.
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const parent = this.startContainer.parentElement;
    if (!parent) return rect(0, 0, 0, 0);

    const base = elementRect(parent);
    // The whole point: horizontal position and width follow the offsets, so
    // a range over 14 characters is 14 characters wide and starts where the
    // match starts — not where the element starts.
    return rect(
      base.left + this.startOffset * CHAR_W,
      base.top,
      (this.endOffset - this.startOffset) * CHAR_W,
      LINE_H,
    );
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalElementRect;
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
/* Frame — 1:1 scale so image pixels equal CSS pixels in assertions.   */
/* ------------------------------------------------------------------ */

const VIEWPORT: ViewportContext = {
  dpr: 1,
  innerWidth: 1000,
  innerHeight: 800,
  clientWidth: 1000,
  clientHeight: 800,
  scrollX: 0,
  scrollY: 0,
  url: 'https://example.test/form',
};

const FRAME = createFullPageFrame(VIEWPORT.clientWidth, VIEWPORT.clientHeight, 1000, 800, VIEWPORT.dpr);

function detect(html: string): DetectedBox[] {
  document.body.innerHTML = html;
  return detectDomPii(FRAME);
}

function ofType(boxes: DetectedBox[], type: DetectedBox['piiType']): DetectedBox[] {
  return boxes.filter((b) => b.piiType === type);
}

/* ------------------------------------------------------------------ */

describe('the fake layout itself', () => {
  // If these break, every assertion below becomes meaningless.
  it('gives elements a non-zero rect and ranges an offset-dependent one', () => {
    document.body.innerHTML = '<p>0123456789</p>';
    const p = document.querySelector('p')!;
    expect(p.getBoundingClientRect().width).toBe(80);

    const range = document.createRange();
    range.setStart(p.firstChild!, 2);
    range.setEnd(p.firstChild!, 5);
    const r = range.getBoundingClientRect();

    expect(r.left).toBe(ORIGIN_X + 2 * CHAR_W);
    expect(r.width).toBe(3 * CHAR_W);
  });
});

describe('attribute matching — password fields', () => {
  it('detects input[type=password] as PASSWORD', () => {
    const boxes = detect('<input type="password" value="hunter2">');
    const hits = ofType(boxes, 'PASSWORD');

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('DOM');
    expect(hits[0].subtype).toBe('password_field');
    expect(hits[0].confidence).toBeGreaterThan(0.9);
    expect(hits[0].nodeId).toBeDefined();
  });

  it('records NO text for a password — the value is the secret itself', () => {
    const boxes = detect('<input type="password" value="hunter2">');

    expect(ofType(boxes, 'PASSWORD')[0].text).toBeUndefined();
    // The manifest is written out and rendered in the panel. The secret must
    // not appear anywhere in the payload, under any field.
    expect(JSON.stringify(boxes)).not.toContain('hunter2');
  });

  it('still detects an empty password field, which no text scan could see', () => {
    const boxes = detect('<input type="password">');
    expect(ofType(boxes, 'PASSWORD')).toHaveLength(1);
  });

  it('does not flag an ordinary text input', () => {
    const boxes = detect('<input type="text" value="hello">');
    expect(boxes).toHaveLength(0);
  });
});

describe('attribute matching — card fields', () => {
  it('detects autocomplete="cc-number" as CARD', () => {
    const boxes = detect('<input autocomplete="cc-number">');
    const hits = ofType(boxes, 'CARD');

    expect(hits).toHaveLength(1);
    expect(hits[0].subtype).toBe('cc_number_field');
    expect(hits[0].text).toBeUndefined();
  });

  it('detects other cc- autocomplete tokens', () => {
    expect(ofType(detect('<input autocomplete="cc-csc">'), 'CARD')).toHaveLength(1);
    expect(ofType(detect('<input autocomplete="cc-exp">'), 'CARD')).toHaveLength(1);
  });

  it('does not flag unrelated autocomplete tokens', () => {
    expect(detect('<input autocomplete="street-address">')).toHaveLength(0);
  });
});

describe('attribute matching — name fields (bug fix: typed names were not redacted)', () => {
  it('detects a plain name field via id + placeholder, empty or filled', () => {
    const empty = ofType(detect('<input id="full-name" placeholder="Enter your name">'), 'NAME');
    expect(empty).toHaveLength(1);
    expect(empty[0].subtype).toBe('name_field');
    expect(empty[0].confidence).toBeGreaterThan(0.9);

    const filled = ofType(
      detect('<input id="full-name" placeholder="Enter your name" value="Priya Sharma">'),
      'NAME',
    );
    expect(filled).toHaveLength(1);
  });

  it('records NO text for a name field — same rule as password fields', () => {
    const boxes = detect('<input id="full-name" value="Priya Sharma">');
    expect(ofType(boxes, 'NAME')[0].text).toBeUndefined();
    expect(JSON.stringify(boxes)).not.toContain('Priya Sharma');
  });

  it('detects autocomplete="name"/"given-name"/"family-name"', () => {
    expect(ofType(detect('<input autocomplete="name">'), 'NAME')).toHaveLength(1);
    expect(ofType(detect('<input autocomplete="given-name">'), 'NAME')).toHaveLength(1);
    expect(ofType(detect('<input autocomplete="family-name">'), 'NAME')).toHaveLength(1);
  });

  it('detects "surname"', () => {
    expect(ofType(detect('<input aria-label="Surname">'), 'NAME')).toHaveLength(1);
  });

  it('does NOT flag "username" — a login handle is not this category', () => {
    expect(detect('<input id="username" placeholder="Username">')).toHaveLength(0);
  });

  it('does NOT flag unrelated fields containing "name" with no word boundary', () => {
    expect(detect('<input id="companyName">')).toHaveLength(0);
    expect(detect('<input id="brandname">')).toHaveLength(0);
  });
});

describe('attribute matching — address fields, incl. <select> (bug fix #2)', () => {
  it('classifies a <select id="state"> as ADDRESS — the whole closed dropdown, not its options', () => {
    // The real repro: a closed <select>'s <option>s are not laid out on the
    // page at all, so NER-then-Range-boxing structurally cannot mask this —
    // only attribute classification of the whole element can.
    const boxes = detect(`
      <select id="state">
        <option>Andhra Pradesh</option>
        <option>Karnataka</option>
      </select>
    `);
    const hits = ofType(boxes, 'ADDRESS');

    expect(hits).toHaveLength(1);
    expect(hits[0].subtype).toBe('address_field');
    expect(hits[0].text).toBeUndefined();
  });

  it('detects "city", "address", "pincode", "postal code", "zip code" hints', () => {
    expect(ofType(detect('<input id="city">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<input aria-label="Address">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<input placeholder="Enter pincode">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<input placeholder="Postal code">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<input placeholder="Zip code">'), 'ADDRESS')).toHaveLength(1);
  });

  it('detects autocomplete address-line/address-level/postal-code tokens', () => {
    expect(ofType(detect('<input autocomplete="address-line1">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<select autocomplete="address-level1">'), 'ADDRESS')).toHaveLength(1);
    expect(ofType(detect('<input autocomplete="postal-code">'), 'ADDRESS')).toHaveLength(1);
  });

  it('does NOT flag "estate" — no word boundary before "state"', () => {
    expect(detect('<input id="estate-agent-notes">')).toHaveLength(0);
  });
});

describe('attribute matching — id-number hints vs. false positives', () => {
  it('does NOT treat "expand", "company" or "panel" as a PAN reference', () => {
    // A substring test for "pan" flags all three. This fixture carries a real
    // Aadhaar field as a control, so the test cannot pass by the detector
    // simply doing nothing.
    const boxes = detect(`
      <button aria-label="Expand company panel">Expand</button>
      <span id="panel-header">Company panel</span>
      <input aria-label="Aadhaar Number">
    `);

    const hits = ofType(boxes, 'ID_NUMBER');
    expect(hits).toHaveLength(1);
    expect(hits[0].subtype).toBe('aadhaar_field');
  });

  it('detects aadhaar/pan/ssn hints across the label-bearing attributes', () => {
    expect(ofType(detect('<input aria-label="Aadhaar Number">'), 'ID_NUMBER'))
      .toHaveLength(1);
    expect(ofType(detect('<input name="pan">'), 'ID_NUMBER')).toHaveLength(1);
    expect(ofType(detect('<input placeholder="Enter SSN">'), 'ID_NUMBER'))
      .toHaveLength(1);
  });
});

describe('text regex matching — Aadhaar via Range', () => {
  const VALID = '2341 2341 2346';

  it('detects a checksum-valid Aadhaar in a paragraph', () => {
    const boxes = detect(`<p>ID ${VALID} end</p>`);
    const hits = ofType(boxes, 'ID_NUMBER');

    expect(hits).toHaveLength(1);
    expect(hits[0].subtype).toBe('aadhaar');
    expect(hits[0].source).toBe('DOM');
    expect(hits[0].text).toBe(VALID);
  });

  it('boxes the matched substring, NOT the whole paragraph', () => {
    // "ID " is 3 chars, so the match starts at offset 3 and runs 14 chars.
    const boxes = detect(`<p>ID ${VALID} end</p>`);
    const box = ofType(boxes, 'ID_NUMBER')[0].imageBox;

    expect(box.x).toBe(ORIGIN_X + 3 * CHAR_W);
    expect(box.w).toBe(VALID.length * CHAR_W);

    // And it is strictly inside the paragraph that contains it.
    const paragraph = document.querySelector('p')!.getBoundingClientRect();
    expect(box.x).toBeGreaterThan(paragraph.left);
    expect(box.x + box.w).toBeLessThan(paragraph.right);
  });

  it('does NOT detect an Aadhaar-shaped number with a bad checksum', () => {
    // Same digits, last one changed: correct shape, wrong Verhoeff digit.
    const boxes = detect('<p>ID 2341 2341 2340 end</p>');
    expect(boxes).toHaveLength(0);
  });

  it('detects the unspaced form too', () => {
    const hits = ofType(detect('<p>234123412346</p>'), 'ID_NUMBER');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('234123412346');
  });
});

describe('text regex matching — other patterns', () => {
  it('detects email and URL with their matched text', () => {
    const boxes = detect('<p>Mail a@b.com or visit https://x.test/p now</p>');

    expect(ofType(boxes, 'EMAIL')[0].text).toBe('a@b.com');
    expect(ofType(boxes, 'URL')[0].text).toBe('https://x.test/p');
  });

  it('detects an Indian mobile number', () => {
    expect(ofType(detect('<p>call 9876543210</p>'), 'PHONE')[0].text)
      .toBe('9876543210');
  });

  it('finds matches in EVERY text node, not just the first', () => {
    // NOTE: this does NOT prove the lastIndex reset in dom-track works —
    // removing that line keeps this test green, because an exhausted exec()
    // loop resets lastIndex by itself. Verified by mutation. What this does
    // cover is that the walker visits every node and reports each match.
    const boxes = detect('<p>a@b.com</p><p>c@d.com</p><p>e@f.com</p>');
    const emails = ofType(boxes, 'EMAIL').map((b) => b.text);

    expect(emails).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
  });

  it('finds repeated matches within a single text node', () => {
    const boxes = detect('<p>a@b.com and c@d.com</p>');
    expect(ofType(boxes, 'EMAIL')).toHaveLength(2);
  });
});

describe('skipping content that is not in the captured image', () => {
  it('skips zero-area elements', () => {
    expect(detect('<input type="password" data-rect="10,10,0,0">')).toHaveLength(0);
  });

  it('skips elements scrolled below the viewport', () => {
    // Viewport is 800 tall; this sits at y=900.
    expect(detect('<input type="password" data-rect="10,900,200,20">')).toHaveLength(0);
  });

  it('skips display:none and visibility:hidden text', () => {
    expect(detect('<p style="display:none">a@b.com</p>')).toHaveLength(0);
    expect(detect('<p style="visibility:hidden">a@b.com</p>')).toHaveLength(0);
  });

  it('skips script and style contents', () => {
    expect(detect('<script>var e = "a@b.com";</script>')).toHaveLength(0);
    expect(detect('<style>/* a@b.com */</style>')).toHaveLength(0);
  });

  it('clips a box that straddles the viewport edge rather than dropping it', () => {
    const boxes = detect('<input type="password" data-rect="950,10,200,20">');
    expect(boxes).toHaveLength(1);
    expect(boxes[0].imageBox.x).toBe(950);
    expect(boxes[0].imageBox.w).toBe(50); // clipped at the 1000px image edge
  });
});
