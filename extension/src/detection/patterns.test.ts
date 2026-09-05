/**
 * SIH 26171 — PII_PATTERNS regex tests.
 *
 * Currently covers the phone_in pattern's +91 prefix fix: a leading \b
 * cannot anchor before '+' (both sides are non-word characters), so the
 * original /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/g only ever matched the bare 10
 * digits and silently dropped the +91 prefix from both premask and the
 * redaction box. Digit-based lookaround ((?<!\d) / (?!\d)) fixes this while
 * still rejecting a match embedded in a longer digit run.
 */

import { describe, expect, it } from 'vitest';
import { PII_PATTERNS } from './patterns';

function firstMatch(text: string): string | null {
  const pattern = PII_PATTERNS.find((p) => p.subtype === 'phone_in')!;
  pattern.regex.lastIndex = 0;
  return pattern.regex.exec(text)?.[0] ?? null;
}

describe('phone_in pattern', () => {
  it('captures the full +91 prefix with a space separator', () => {
    expect(firstMatch('call +91 9876543210 now')).toBe('+91 9876543210');
  });

  it('captures the full +91 prefix with no separator', () => {
    expect(firstMatch('call +919876543210 now')).toBe('+919876543210');
  });

  it('captures the full +91 prefix with a dash separator', () => {
    expect(firstMatch('call +91-9876543210 now')).toBe('+91-9876543210');
  });

  it('still matches a bare 10-digit number with no country code', () => {
    expect(firstMatch('call 9876543210 now')).toBe('9876543210');
  });

  it('does not match a phone-shaped run embedded in a longer digit sequence', () => {
    // "129876543210" — a 12-digit run; the 10-digit phone shape starting at
    // the 3rd digit must NOT match, because it isn't bounded by a non-digit.
    expect(firstMatch('order 129876543210 confirmed')).toBeNull();
  });
});
