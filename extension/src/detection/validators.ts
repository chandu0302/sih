/**
 * SIH 26171 — Phase 2 checksum validators.
 *
 * Pure functions, no DOM. Each regex match in patterns.ts that carries a
 * `validate` hook is confirmed here before it is trusted as PII — a bare
 * digit-shape match on its own has a high false-positive rate (any 12-digit
 * run of digits looks like an Aadhaar number).
 */

/** Verhoeff multiplication table. */
const D_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Verhoeff permutation table. */
const P_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Verhoeff checksum, used by Aadhaar. Strips spaces first; the input must
 * reduce to exactly 12 digits or this returns false without computing
 * anything (a wrong-length string is not a valid Aadhaar, checksum or not).
 */
export function verhoeff(digits: string): boolean {
  const cleaned = digits.replace(/\s/g, '');
  if (!/^\d{12}$/.test(cleaned)) return false;

  let c = 0;
  const reversed = cleaned.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D_TABLE[c][P_TABLE[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/**
 * Luhn checksum, used by card numbers (and IMEI). Strips spaces/dashes
 * first. Accepts 8–19 digits, the range that covers every issued card
 * network without also accepting arbitrary long digit runs.
 */
export function luhn(digits: string): boolean {
  const cleaned = digits.replace(/[\s-]/g, '');
  if (!/^\d{8,19}$/.test(cleaned)) return false;

  let sum = 0;
  let double = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let n = Number(cleaned[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CODE_POINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_MOD = 36;

/**
 * GSTIN mod-36 checksum: the final of the 15 characters is a check character
 * computed over the preceding 14 with an alternating 1/2 weighting, folded
 * back into base 36 the same way ISBN/ISO 7064 mod-N-radix checks do.
 */
export function gstinChecksum(gstin: string): boolean {
  const cleaned = gstin.trim().toUpperCase();
  if (!GSTIN_SHAPE.test(cleaned)) return false;

  let factor = 2;
  let sum = 0;
  for (let i = cleaned.length - 2; i >= 0; i--) {
    const codePoint = GSTIN_CODE_POINTS.indexOf(cleaned[i]);
    const product = factor * codePoint;
    sum += Math.floor(product / GSTIN_MOD) + (product % GSTIN_MOD);
    factor = factor === 2 ? 1 : 2;
  }

  const checkCodePoint = (GSTIN_MOD - (sum % GSTIN_MOD)) % GSTIN_MOD;
  return GSTIN_CODE_POINTS[checkCodePoint] === cleaned[cleaned.length - 1];
}
