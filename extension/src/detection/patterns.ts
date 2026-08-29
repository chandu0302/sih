/**
 * SIH 26171 — Phase 2 regex pattern registry.
 *
 * Each entry is checked against text nodes by dom-track.ts. A `validate`
 * hook is a second gate AFTER the regex matches: the regex only narrows to
 * the right shape (fast, cheap, high recall), the checksum rejects the
 * shape-alikes that are not actually valid numbers (precision). Patterns
 * without a `validate` hook (phone, email, URL) have no checksum to lean on,
 * so the regex itself carries the precision bar.
 */

import type { PiiType } from '../types';
import { gstinChecksum, verhoeff } from './validators';

export interface PiiPattern {
  type: PiiType;
  subtype: string;
  regex: RegExp;
  /** Rejects false positives that merely match the shape. Receives the raw
   *  matched substring (not the validator's cleaned form). */
  validate?: (match: string) => boolean;
}

export const PII_PATTERNS: PiiPattern[] = [
  {
    type: 'ID_NUMBER',
    subtype: 'aadhaar',
    regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    validate: verhoeff,
  },
  {
    type: 'ID_NUMBER',
    subtype: 'pan',
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  },
  {
    type: 'ID_NUMBER',
    subtype: 'ifsc',
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  },
  {
    type: 'ID_NUMBER',
    subtype: 'gstin',
    regex: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
    validate: gstinChecksum,
  },
  {
    type: 'PHONE',
    subtype: 'phone_in',
    regex: /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/g,
  },
  {
    type: 'EMAIL',
    subtype: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'URL',
    subtype: 'url',
    regex: /\bhttps?:\/\/[^\s<>"']+/g,
  },
];
