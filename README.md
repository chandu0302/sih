# PrivacyLens — SIH 26171

**"On-device Visual Perception for Light-weight Browser Agents"** (ISRO/Dept.
of Space, PS 26171). A Chrome extension that captures a page, redacts PII
**on-device** before anything leaves the browser, then lets a vision-language
model answer questions about the sanitized page or execute one action on it.

**The thesis:** the VLM reasons over sanitized state; the client executes in
real state. A detection miss cannot leak data that was never transmitted,
because redaction happens *before* the image is ever sent anywhere.

## What it does

Open the side panel — it looks like a chat. Pick a mode from the dropdown at
the bottom (defaults to **Capture**):

- **Capture** — takes the *entire scrollable page* (not just the viewport) as
  one sanitized screenshot: text-shaped PII is masked on the live DOM
  *before* the pixels are ever captured, and any detected face is blurred on
  the captured bitmap afterward. The result is pinned above the chat.
- **Ask** — a free-text question about the current capture ("What kind of
  form is this?"), answered by a VLM that sees only the sanitized image plus
  a manifest of what was redacted (type/location/confidence, never the
  actual matched text).
- **Agent** — a one-step task ("Click the Submit button"). The VLM plans one
  action (click/type/scroll/done) against the sanitized image; the extension
  converts its answer back to a real page coordinate and executes it.

**Capture is optional, not a precondition** — switching to Ask or Agent and
hitting Send with nothing captured yet auto-captures the page first, then
proceeds. Manual Capture stays available whenever you want fresher context
(e.g. after an Agent action changes the page).

## Setup

### Extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `extension/dist`
4. Open any normal **http/https** website tab, click the extension icon to
   open the side panel

### Server (Ask / Agent modes)

Ask and Agent both call a small FastAPI server that talks to a VLM. See
[`server/README.md`](server/README.md) for full setup — short version:

```bash
cd server
pip install -r requirements.txt
cp .env.example .env   # paste a free key from openrouter.ai/keys
uvicorn app.main:app --reload
```

Capture mode alone (no server needed) still fully demonstrates the on-device
redaction pipeline.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Build `dist/` (side panel, service worker, content script) |
| `npm test` | Run the extension test suite (Vitest) |
| `npm run typecheck` | TypeScript, no emit |
| `pytest` (in `server/`) | Run the server test suite |

## Architecture notes worth knowing

**Full-page capture uses the Chrome DevTools Protocol, not
`captureVisibleTab`.** `chrome.tabs.captureVisibleTab()` can only ever return
the current viewport — a hard platform limit. The entire scrollable page, in
one shot, uses the same mechanism DevTools' own "Capture full size
screenshot" command does: `chrome.debugger.attach` →
`Page.getLayoutMetrics` (the page's real CSS size — the sole source of truth
for coordinate math downstream) → `Page.captureScreenshot` with
`captureBeyondViewport: true` → `chrome.debugger.detach`. Because this never
actually scrolls the page, `getBoundingClientRect()` stays valid as both
viewport- and page-relative for the whole capture — no scroll-offset math
was needed anywhere. See `src/background/service-worker.ts` and
`src/lib/coords.ts`'s `createFullPageFrame`.

This is why the manifest declares the `"debugger"` permission — it shows a
"this extension is debugging your browser" banner while attached (briefly,
per capture) and fails if real DevTools is already attached to the same tab
(only one debugger client allowed at a time — close DevTools and retry).

**Redaction is two different mechanisms for two different reasons.** Text
is masked *before* capture: three concurrent, independently fault-tolerant
detection tracks (DOM/regex, on-device face model, on-device NER) find PII
on the live page, then opaque `position: absolute` overlay divs cover it
*before* the CDP screenshot fires — the pixels never contain the text.
Faces can only be located in pixels, so they're blurred *after* capture,
directly on the captured bitmap. See `src/redaction/mask-overlay.ts` and
`src/redaction/face-blur.ts`.

**Attribute-based fields are masked whether empty or filled.** A password
field, a name field (`id`/`placeholder`/`autocomplete` hinting at a name), or
an address field (state/city/pincode, including `<select>` dropdowns whose
closed options aren't laid out on the page at all and so can never be boxed
via text detection) are classified and masked by their *markup*, not their
*content* — the only way to catch a field before or regardless of what gets
typed into it. See `src/detection/dom-track.ts`'s `classifyElement`.

**Scale is derived, not assumed.** `createFullPageFrame()` computes scale
directly from CDP's reported page size vs. the actual captured image
dimensions — no guessing between viewport-width candidates the way a
`captureVisibleTab`-based design would need to. See `src/lib/coords.ts`'s
module doc for the full reasoning (including why there's still no scroll
term).

**Active-tab resolution ignores DevTools/panel focus.** `getActiveTab()` in
the service worker does *not* use `chrome.tabs.query({active, currentWindow})`
— when the service-worker DevTools or the side panel itself has focus,
`currentWindow` can resolve to *that* window instead of your browser tab.
It resolves the last-focused **normal** browser window instead, with a
fallback scan. See `src/background/service-worker.ts`.

**The build is hand-rolled on purpose.** MV3 needs three outputs with
incompatible module formats (ES-module page, ES-module worker, IIFE content
script). `build.mjs` runs three sequential Vite builds — fully under our
control, no plugin to break the week before the demo.

**Constrained decoding on the server is prompt + validation, not grammar
decoding.** OpenRouter proxies many providers whose support for
`json_schema` mode is inconsistent; `/plan-action` uses
`response_format: json_object` plus a strict system prompt plus post-hoc
Pydantic validation instead. `/ask` uses no `response_format` at all — it's
a free-text answer, not a structured action.

## Troubleshooting

**"No access to this tab yet" / "This is a browser page and cannot be
captured"** — Capture was triggered while a `chrome://` page, the extensions
page, or DevTools had focus. Switch to a normal http/https tab and retry.

**"Another debugger (often Chrome DevTools) is already attached to this
tab"** — real DevTools is open on the same tab. Close it and capture again;
Chrome only allows one debugger client per tab.

**A capture bubble never appears / the debugging banner seems stuck** — an
unexpected mid-capture failure attempts a best-effort detach automatically
(`CAPTURE_ABORT_REQUEST`); if it's still stuck, reload the extension from
`chrome://extensions`.

**Ask/Agent returns an error mentioning "OPENROUTER_API_KEY"** — the server
has no key configured; see `server/README.md`.

**Ask/Agent returns a rate-limit or capacity error from the model
provider** — expected free-tier behavior, not a bug (free models rate-limit
hard under load). Wait and retry, or set `VLM_MODEL` in `server/.env` to a
different model.

**Raw error text, if the friendly message isn't enough** — open the
extension card at `chrome://extensions` → **"service worker"** under Inspect
views → Console tab.

## Known gaps (deliberate, not oversights)

- **Arbitrary text typed into a field with no name/ID-hinting attribute**
  (e.g. a generic "Notes" textarea) is not detected by any track — the
  attribute-based fix only covers fields markup already hints are sensitive.
  A deeper fix (scanning live input/textarea values through the NER model,
  boxing the whole element) is a known, larger, deferred change.
- **The Agent/Ask task/question text itself is sent to the cloud VLM
  unfiltered** — if you type real PII directly into the prompt (not the
  page), it bypasses the on-device redaction pipeline entirely. Worth a
  separate decision if this becomes a real concern.
- **One action per Agent turn, not a loop.** No automatic multi-step
  execution (scroll-then-click-then-verify) — each Send plans and executes
  exactly one step.
- **A very tall full-page capture may be downscaled by the VLM's own vision
  encoder**, hurting grounding accuracy on long pages — not something this
  project's client-side code controls.
- **Occlusion is not modelled** in the salient-element list (an element
  behind a modal is still reported as visible).
- **Cross-origin iframes are not traversed** — invisible to all three
  detection tracks.
- **Chrome only.** Firefox's MV3 differs (no `chrome.sidePanel`, no
  `chrome.debugger` equivalent, event pages rather than true service
  workers) — not ported.
- **`nodeId` convergence** (`dom-track.ts` uses `d…` counters, the DOM
  snapshot uses `n…`) and the duplicated DOM-walk filter between
  `dom-track.ts`/`ner-track.ts` are known, deliberate, low-priority
  consolidation items.

## Models

- **`extension/public/models/yolov11n-face.onnx`** — face detection.
  - Source: https://huggingface.co/AdamCodd/YOLOv11n-face-detection (`model.onnx`, fp32 — not `model_fp16.onnx`; the WASM fallback path needs fp32)
  - sha256: `2dfe14171f5b76a05f9bcf0dac7f94b7bff4416b1f29eff7c9ef5830f51c5719`
  - License: apache-2.0
  - Base model: Ultralytics/YOLO11 (YOLOv11n)
  - Dataset: WIDERFACE
  - Confirmed by inspection (session.inputNames/outputNames/dims), not assumed: input `images` float32 `[1,3,640,640]` NCHW RGB; output `output0` float32 `[1,5,8400]` (`cx,cy,w,h,score` per anchor, score already sigmoid'd, no baked-in NMS).

- **`extension/public/models/plingampally/meridianpii-hi-v2/`** — Hindi/English NER for PII. Gitignored (~55MB, over GitHub's 50MB warning) — staged manually for now; download from the source below.
  - Source: https://huggingface.co/plingampally/meridianpii-hi-v2 (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `onnx/model_quantized.onnx` — INT8, dtype `q8`; skip `.safetensors`/full-precision `model.onnx`/any PyTorch `.bin`)
  - sha256 (`onnx/model_quantized.onnx`): `0a60415537461aed8e7380da01d051f23e962a1c540129a94ba4f3925e26be56`
  - License: **CC BY 4.0** — attribution required on redistribution.
  - Base model: MiniLM (Apache-2.0). Derived from Rampart (CC BY 4.0).
  - 17-label BIO token-classification (`BertForTokenClassification`): `GIVEN_NAME, SURNAME, EMAIL, PHONE, URL, TAX_ID, BANK_ACCOUNT, ROUTING_NUMBER, GOVERNMENT_ID, PASSPORT, DRIVERS_LICENSE, BUILDING_NUMBER, STREET_NAME, SECONDARY_ADDRESS, CITY, STATE, ZIP_CODE` — all 17 map to a redacted PiiType (no keep-set). Loaded via `@huggingface/transformers`' `pipeline('token-classification', ..., { dtype: 'q8' })`, confidence floor `0.15` (INT8 flattens scores — a 0.4 floor would drop real hits), text NFC-normalized only (NFKD strips Devanagari matras).
  - **Fixed bug, worth knowing if you re-stage this model:** the bundled `tokenizer_config.json` ships `model_max_length` as the HF-default "unbounded" sentinel instead of this model's real 512-token limit, silently defeating `transformers.js`'s own truncation and crashing on any page whose assembled text exceeds 512 tokens. Patched at pipeline-load time in `ner-detector.ts` (`fixTokenizerMaxLength`), not in the model asset itself, so it survives re-staging.

- **VLM (Ask/Agent modes)** — server-side, configurable, not bundled with the extension. See `server/README.md` for current default/setup.

## Layout

```
sih/
├── extension/
│   ├── build.mjs, manifest.json, vitest.config.ts
│   ├── public/ (models/, ort/, ort-tfjs/ — gitignored except the committed face model)
│   └── src/
│       ├── types.ts               ← shared contract across all contexts
│       ├── lib/ (coords.ts, messaging.ts)
│       ├── background/service-worker.ts   ← capture coordinator, CDP
│       ├── content/ (index.ts, snapshot.ts)
│       ├── sidepanel/ (App.tsx — chat UI, styles.css)
│       ├── detection/  (Track 1 DOM/regex, Track 2 face, Track 3 NER, box-merger)
│       ├── redaction/  (mask-overlay.ts, face-blur.ts, manifest.ts)
│       ├── agent/      (server-client.ts, action-executor.ts — Phase 5)
│       └── models/     (onnx-loader, webgpu, cache, model-registry)
├── server/  (FastAPI action-planner/Q&A — see server/README.md)
└── test-page/index.html   (coordinate + PII-precision fixture)
```
