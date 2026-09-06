/**
 * SIH 26171 — test configuration.
 *
 * Two projects rather than one global environment. The DOM track needs a
 * document; coords.ts and validators.ts are pure math and pure string work,
 * and running them under jsdom would only add startup cost and hide an
 * accidental DOM dependency behind a global that happens to exist.
 *
 * Vitest 4 removed `environmentMatchGlobs`, so per-file environments are
 * expressed as projects.
 */

import { defineConfig } from 'vitest/config';

const DOM_TESTS = [
  'src/detection/dom-track.test.ts',
  'src/detection/ner-track.test.ts',
  'src/redaction/mask-overlay.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: DOM_TESTS,
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: DOM_TESTS,
        },
      },
    ],
  },
});
