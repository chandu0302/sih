/**
 * SIH 26171 — algebraic verification of the Verhoeff tables.
 *
 * WHY THIS EXISTS, GIVEN validators.test.ts ALREADY TESTS verhoeff()
 *
 * Behavioural tests feed in numbers and check the boolean. That catches a
 * table that is *broken*, but not one that is *wrong-but-self-consistent*:
 * a subtly different permutation table applied identically when generating
 * a check digit and when verifying it will happily agree with itself. Our
 * original Aadhaar vector was produced by brute-forcing the check digit with
 * our own verhoeff(), so it could never have caught that class of bug.
 *
 * The reference vectors in validators.test.ts are one answer (an outside
 * oracle). This file is the other: it checks the tables against the algebra
 * Verhoeff's scheme REQUIRES, independent of any vector.
 *
 * The scheme is built on the dihedral group D5. Its error-detecting power
 * comes from D5 being NON-ABELIAN — that is precisely why it catches adjacent
 * transpositions, which Luhn misses. Swap in a table over the cyclic group
 * Z10 and every check digit still validates consistently while transposition
 * detection silently disappears. Aadhaar chose Verhoeff over Luhn for exactly
 * that property, so it is worth pinning down rather than assuming.
 *
 * NOTE ON WHAT THIS DOES AND DOES NOT PIN DOWN:
 * These properties identify the group up to isomorphism, not up to labelling —
 * a consistently relabelled D5 table would satisfy every assertion here while
 * computing different (internally valid) check digits. That is fine, because
 * the two files cover different halves: the reference vectors pin the
 * labelling, and this file pins the structure. Neither alone is sufficient.
 *
 * We read the SHIPPED SOURCE rather than importing the tables, because they
 * are module-private and validators.ts should not widen its public API just
 * to be tested.
 */

import { describe, expect, it } from 'vitest';
// Vite's ?raw import: the file's text, not its exports. Declared by vite/client.
import validatorsSource from './validators.ts?raw';

/* ------------------------------------------------------------------ */
/* Parsing the shipped tables                                          */
/* ------------------------------------------------------------------ */

/**
 * Pull a `const NAME = [[...],[...]]` literal out of the source.
 *
 * Bracket-matched rather than line-based, so reformatting the file (prettier
 * collapsing rows, say) does not silently change what gets parsed. A parse
 * that goes wrong must fail loudly — see the shape assertions below, which
 * exist so a mis-parse can never leave the real assertions vacuously passing
 * over an empty array.
 */
function parseTable(source: string, name: string): number[][] {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`${name} not found in validators.ts`);

  const open = source.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${name} literal is not bracket-balanced`);

  const rows = source.slice(open + 1, end).match(/\[[^\]]*\]/g) ?? [];
  return rows.map((row) => (row.match(/\d+/g) ?? []).map(Number));
}

const d = parseTable(validatorsSource, 'D_TABLE');
const p = parseTable(validatorsSource, 'P_TABLE');

/** Identity element of the group, and the value a valid checksum ends on. */
const IDENTITY = 0;

/**
 * Multiplicative order of x: the smallest n >= 1 with x^n = identity.
 * Capped, because a malformed table would otherwise hang the whole suite
 * instead of failing it.
 */
function order(x: number): number {
  let n = 1;
  let y = x;
  while (y !== IDENTITY) {
    y = d[y][x];
    n++;
    if (n > 20) throw new Error(`element ${x} has no finite order — table is malformed`);
  }
  return n;
}

/* ------------------------------------------------------------------ */

describe('Verhoeff tables — parse sanity', () => {
  // Guards every assertion below: an empty or truncated parse would make the
  // structural tests pass over nothing at all.
  it('extracts a 10x10 multiplication table', () => {
    expect(d).toHaveLength(10);
    for (const row of d) {
      expect(row).toHaveLength(10);
      expect(row.every((v) => Number.isInteger(v) && v >= 0 && v <= 9)).toBe(true);
    }
  });

  it('extracts an 8x10 permutation table', () => {
    expect(p).toHaveLength(8);
    for (const row of p) {
      expect(row).toHaveLength(10);
      expect(row.every((v) => Number.isInteger(v) && v >= 0 && v <= 9)).toBe(true);
    }
  });
});

describe('D_TABLE is the Cayley table of the dihedral group D5', () => {
  it('is a Latin square — every row and column a permutation of 0..9', () => {
    for (let i = 0; i < 10; i++) {
      expect(new Set(d[i]).size, `row ${i} repeats a value`).toBe(10);
      expect(new Set(d.map((row) => row[i])).size, `column ${i} repeats a value`).toBe(10);
    }
  });

  it('has 0 as its identity element', () => {
    for (let i = 0; i < 10; i++) {
      expect(d[IDENTITY][i]).toBe(i);
      expect(d[i][IDENTITY]).toBe(i);
    }
  });

  it('is associative, so it is genuinely a group of order 10', () => {
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        for (let c = 0; c < 10; c++) {
          expect(d[d[a][b]][c], `associativity fails at (${a},${b},${c})`).toBe(
            d[a][d[b][c]],
          );
        }
      }
    }
  });

  it('gives every element an inverse', () => {
    for (let a = 0; a < 10; a++) {
      expect(d[a].indexOf(IDENTITY), `element ${a} has no inverse`).toBeGreaterThanOrEqual(0);
    }
  });

  it('is NON-ABELIAN — the property that catches transpositions', () => {
    // If this ever passes as commutative, the table has been swapped for one
    // over Z10: check digits still validate, transposition detection is gone,
    // and no behavioural test would notice.
    const commutes = d.every((row, a) => row.every((_, b) => d[a][b] === d[b][a]));
    expect(commutes, 'table is commutative — this is Z10, not D5').toBe(false);
  });

  it('has D5’s element-order profile: 1 identity, 5 reflections, 4 rotations', () => {
    const profile: Record<number, number> = {};
    for (let i = 0; i < 10; i++) {
      const o = order(i);
      profile[o] = (profile[o] ?? 0) + 1;
    }
    // D5: identity (order 1), five reflections (order 2), four rotations (order 5).
    // Z10 would instead give {1:1, 2:1, 5:4, 10:4}.
    expect(profile).toEqual({ 1: 1, 2: 5, 5: 4 });
  });
});

describe('P_TABLE is the required order-8 permutation sequence', () => {
  it('starts with the identity permutation', () => {
    expect(p[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('has every row a permutation of 0..9', () => {
    for (let i = 0; i < 8; i++) {
      expect(new Set(p[i]).size, `p[${i}] is not a permutation`).toBe(10);
    }
  });

  it('builds each row by composing the base permutation: p[i] = p[1]^i', () => {
    for (let i = 1; i < 8; i++) {
      for (let x = 0; x < 10; x++) {
        expect(p[i][x], `p[${i}][${x}] is not p[1] applied to p[${i - 1}][${x}]`).toBe(
          p[1][p[i - 1][x]],
        );
      }
    }
  });

  it('has period exactly 8, which is why the algorithm indexes with i % 8', () => {
    // Applying the base permutation once more to p[7] must return the identity.
    const p8 = Array.from({ length: 10 }, (_, x) => p[1][p[7][x]]);
    expect(p8).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // And no earlier row may already be the identity, or the period is shorter
    // than 8 and positional weighting collapses.
    for (let i = 1; i < 8; i++) {
      expect(p[i], `p[${i}] is the identity — period is shorter than 8`).not.toEqual(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
    }
  });
});
