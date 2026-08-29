/**
 * SIH 26171 — build.
 *
 * MV3 needs three outputs with incompatible module formats, which is exactly
 * what a single Vite config cannot express:
 *
 *   sidepanel/       an HTML page  -> ES modules, code splitting fine
 *   background/      service worker -> ES module, single file, no splitting
 *   content/         content script -> IIFE, single file (content scripts
 *                                      cannot be ES modules)
 *
 * The usual answer is @crxjs/vite-plugin. We deliberately do not use it: its
 * MV3 support has been unstable across releases, and a broken build tool the
 * week before a demo is not a risk worth taking for convenience we can
 * replace with 40 lines. Three sequential Vite builds, zero plugins beyond
 * React, fully under our control.
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** Single-file bundle for the worker and content script. */
const singleFile = (entry, outSubdir, fileName, format) => ({
  root,
  configFile: false,
  build: {
    outDir: resolve(outDir, outSubdir),
    emptyOutDir: false,
    // Keep the code readable in DevTools during development. Flip to true
    // for the final demo build if bundle size becomes a talking point.
    minify: false,
    lib: {
      entry: resolve(root, entry),
      formats: [format],
      fileName: () => fileName,
      // Required by Vite whenever the format is iife/umd (the content script).
      // Harmless for the 'es' service-worker build. The content script assigns
      // nothing to this global — it runs for its side effects — but Vite
      // refuses to build an IIFE without a name.
      name: 'SihContentScript',
    },
    rollupOptions: {
      output: {
        // Service workers and content scripts must be exactly one file.
        // Any chunk split here produces an import the browser cannot resolve.
        inlineDynamicImports: true,
      },
    },
  },
});

console.log('[1/3] side panel');
await build({
  root: resolve(root, 'src/sidepanel'),
  configFile: false,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(outDir, 'sidepanel'),
    emptyOutDir: false,
    minify: false,
  },
});

console.log('[2/3] service worker');
await build(singleFile('src/background/service-worker.ts', 'background', 'service-worker.js', 'es'));

console.log('[3/3] content script');
await build(singleFile('src/content/index.ts', 'content', 'index.js', 'iife'));

cpSync(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'));
if (existsSync(resolve(root, 'public'))) {
  cpSync(resolve(root, 'public'), outDir, { recursive: true });
}

console.log('\n✓ dist/ ready — load it as an unpacked extension.');
