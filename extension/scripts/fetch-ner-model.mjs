#!/usr/bin/env node
/**
 * SIH 26171 — fetches the MeridianPII NER model (Track 3) into
 * public/models/plingampally/meridianpii-hi-v2/, the exact path
 * ner-detector.ts's MODEL_ID + env.localModelPath already expect.
 *
 * Gitignored (~55MB, over GitHub's 50MB warning — see .gitignore), unlike
 * the small YOLO face model, which is committed directly. Verified working
 * during the clean-clone reproducibility audit this script closes the gap
 * on: `npm run build` succeeds without this model present (Track 1/2 still
 * work; Track 3 silently fails at runtime with no build-time warning) — see
 * build.mjs's own check, which now warns if this hasn't been run.
 *
 * Re-run safely: skips any file that already exists (pass --force to
 * re-download everything, e.g. after a model update).
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'plingampally/meridianpii-hi-v2';
const BASE_URL = `https://huggingface.co/${REPO}/resolve/main`;
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = resolve(__dirname, '..', 'public', 'models', REPO);
const force = process.argv.includes('--force');

async function downloadFile(relPath) {
  const dest = resolve(TARGET_DIR, relPath);
  if (existsSync(dest) && !force) {
    console.log(`[skip]     ${relPath} (already present — pass --force to re-download)`);
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  const url = `${BASE_URL}/${relPath}`;

  console.log(`[download] ${relPath}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await streamPipeline(response.body, createWriteStream(dest));
}

async function main() {
  console.log(`Fetching ${REPO} -> ${TARGET_DIR}\n`);

  for (const file of FILES) {
    await downloadFile(file);
  }

  console.log('\nDone. Verify with: npm run build (Track 3 NER should load without warnings).');
}

main().catch((err) => {
  console.error('\n[SIH] NER model fetch failed:', err.message);
  console.error(
    'Manual fallback: download the 5 files listed in README.md\'s "Models" section from',
    `https://huggingface.co/${REPO} and place them under ${TARGET_DIR}`,
  );
  process.exitCode = 1;
});
