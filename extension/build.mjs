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
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * ONNX Runtime Web's WebAssembly binaries — ~40MB, and a BUILD INPUT rather
 * than source. They are byte-for-byte reproducible from the onnxruntime-web
 * version pinned in package-lock.json, so they are gitignored and staged here
 * instead of being committed. Git stores large binaries badly: no delta
 * compression, and every runtime bump would add another full copy to history
 * that only a rewrite could remove.
 *
 * BOTH pairs are required. The .jsep build backs the WebGPU execution
 * provider; the plain build backs the WASM fallback. Shipping only one makes
 * the fallback in src/models/onnx-loader.ts useless on exactly the machines
 * that need it — which would show up as a demo-day failure, not a build error.
 *
 * These are staged into public/ so the existing public/ -> dist/ copy below
 * carries them to dist/ort/, which is where chrome.runtime.getURL('ort/') in
 * configureOrtEnv() resolves. Those two paths must change together.
 */
const ORT_DIST = 'node_modules/onnxruntime-web/dist';
const ORT_BINARIES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

function copyOrtBinaries() {
  const from = resolve(root, ORT_DIST);
  const to = resolve(root, 'public/ort');

  // Fail loudly. A missing binary silently yields a dist that loads fine and
  // then dies at the first inference with a CDN fetch blocked by MV3's CSP —
  // a confusing runtime error, far from its cause.
  const missing = ORT_BINARIES.filter((file) => !existsSync(resolve(from, file)));
  if (missing.length > 0) {
    throw new Error(
      `ORT wasm binaries not found in ${ORT_DIST}:\n` +
        missing.map((file) => `  - ${file}`).join('\n') +
        `\n\nRun \`npm install\` first. If they are installed but renamed, the ` +
        `dist layout has changed from the pinned onnxruntime-web@1.29.0 — ` +
        `update ORT_BINARIES here AND check wasmPaths in ` +
        `src/models/onnx-loader.ts before shipping.`,
    );
  }

  mkdirSync(to, { recursive: true });
  for (const file of ORT_BINARIES) {
    copyFileSync(resolve(from, file), resolve(to, file));
  }
  console.log(`[ort] staged ${ORT_BINARIES.length} wasm binaries -> public/ort/`);
}

/**
 * transformers.js (Track 3 / NER) bundles its OWN onnxruntime-web, at a
 * different pinned version from the plain onnxruntime-web dependency Track 2
 * uses (1.26.0-dev vs 1.29.0 as of writing — verify with `npm ls` if this
 * throws). Mixing the two wasm sets is the silent-breakage kind of wrong, so
 * this stages into its own public/ort-tfjs/ dir rather than reusing
 * public/ort/. ner-detector.ts points env.backends.onnx.wasm.wasmPaths here.
 *
 * WHICH PAIR BACKS WEBGPU DIFFERS FROM TRACK 2. Track 2's 1.29.0 uses the
 * `.jsep` build for its WebGPU/JSEP execution provider. This nested
 * 1.26.0-dev build instead resolves WebGPU through the `.asyncify` build —
 * confirmed empirically: the bundled sidepanel JS's dynamic import of
 * `ort-wasm-simd-threaded.asyncify.mjs` 404's if only `.jsep` is staged
 * (verified in the browser: "no available backend found... Failed to fetch
 * dynamically imported module ... asyncify.mjs"). Do not assume `.jsep` is
 * the WebGPU pair for every onnxruntime-web version — grep the built bundle
 * (`grep -o 'ort-wasm-simd-threaded\.[a-z.]*mjs' dist/sidepanel/assets/*.js`)
 * if this version bumps and breaks again.
 *
 * SHARED FILE — build.mjs is Track 2's file too. Flagged in the team channel
 * per the brief; this only adds a second, independent staging step.
 */
const ORT_TFJS_DIST = 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist';
const ORT_TFJS_BINARIES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
];

function copyTransformersOrtBinaries() {
  const from = resolve(root, ORT_TFJS_DIST);
  const to = resolve(root, 'public/ort-tfjs');

  const missing = ORT_TFJS_BINARIES.filter((file) => !existsSync(resolve(from, file)));
  if (missing.length > 0) {
    throw new Error(
      `transformers.js's onnxruntime-web wasm binaries not found in ${ORT_TFJS_DIST}:\n` +
        missing.map((file) => `  - ${file}`).join('\n') +
        `\n\nRun \`npm install\` first. If they are installed but renamed, ` +
        `@huggingface/transformers bumped its nested onnxruntime-web — update ` +
        `ORT_TFJS_BINARIES here AND check wasmPaths in ` +
        `src/detection/ner-detector.ts before shipping.`,
    );
  }

  mkdirSync(to, { recursive: true });
  for (const file of ORT_TFJS_BINARIES) {
    copyFileSync(resolve(from, file), resolve(to, file));
  }
  console.log(`[ort-tfjs] staged ${ORT_TFJS_BINARIES.length} wasm binaries -> public/ort-tfjs/`);
}

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

copyOrtBinaries();
copyTransformersOrtBinaries();

cpSync(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'));
if (existsSync(resolve(root, 'public'))) {
  cpSync(resolve(root, 'public'), outDir, { recursive: true });
}

console.log('\n✓ dist/ ready — load it as an unpacked extension.');
