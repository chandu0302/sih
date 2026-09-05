# SIH 26171 — On-device Visual Perception for Light-weight Browser Agents

Phase 1: capture and coordinate alignment.

## What Phase 1 does

Click the extension icon → a side panel opens → **Capture** takes, at the same
instant:

1. a **screenshot** of the visible tab (PNG), and
2. a **structured list of salient page elements**, each with a bounding rect,

then draws every element's box back onto the screenshot. If the boxes sit
exactly on their elements, the coordinate contract is correct and Phases 2–5
can be built on it.

There is no ML, no server, and no redaction yet. Phase 1 exists to make the
coordinate spine trustworthy, because every later stage inherits it.

## Setup

```bash
cd extension
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `extension/dist`
4. Open any normal **http/https** website tab, click the extension icon, press **Capture**

Capture currently works on `http://` and `https://` pages only — see
**Known gaps** below for why `file://` (including the bundled test page) needs
an extra step, and **Troubleshooting** if Capture reports an access error.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Build `dist/` (side panel, service worker, content script) |
| `npm test` | Run the coordinate math test suite |
| `npm run typecheck` | TypeScript, no emit |

## Verifying the coordinate contract

The acceptance test for Phase 1 is visual and must hold in all of these:

- **DPR 1** — a standard display
- **DPR 2** — a Retina display, or DevTools device emulation
- **Browser zoom** at 80% / 125% / 150%
- **A scrolled page** — boxes must not drift downward
- **A page with a horizontal scrollbar**

Watch the **Scale basis** and **Derived scale** readouts in the panel. If the
derived scale disagrees with the reported DPR, that is expected — it is the
whole reason we derive scale from the returned image rather than trusting
`devicePixelRatio`.

## Architecture notes worth knowing

**Permissions ended up broader than the original activeTab-only plan, and
here's the honest reason why.** The manifest declares:

```json
"permissions": ["activeTab", "scripting", "sidePanel"],
"host_permissions": ["http://*/*", "https://*/*"]
```

> Note: your local manifest may instead have `"host_permissions": ["<all_urls>"]`
> — that's fine too, it's the broader superset and works the same way. Either
> form fixes the same underlying issue described below.

The original design used `activeTab` alone — granted on the toolbar-icon
click, nothing at install, the tightest possible footprint. In practice this
failed specifically **because of the side panel**: opening a side panel
consumes the icon click, so `activeTab`'s grant doesn't reliably reach the tab
by the time Capture runs. This is a known, reported Chromium behavior
(`activeTab` behaves differently in a side panel than in a popup — see
[chromium issue 40916430](https://issues.chromium.org/issues/40916430)), not
something specific to this codebase. The documented workaround is a standing
host permission, which is what's declared above.

Net effect: install-time permissions are still minimal (no `tabs`, so no
"read your browsing history" warning), but the extension does ask for
http/https access up front rather than purely on-demand. Revisit this in
Phase 6 — Chrome's per-site access controls (user can scope it to specific
sites post-install) partially recover the tighter story even with this
manifest.

*Consequence to plan for:* Phase 5's agent loop navigates across pages; the
current host_permissions already cover that, so no further change needed
there.

**Capture order is the correctness story.** Read the DOM, capture pixels, then
re-probe the viewport to detect whether the page moved in between. A drift
warning is surfaced in the panel rather than silently producing boxes that
describe a page state the screenshot never showed.

**Scale is derived, not assumed.** `createCoordinateFrame()` tries both
candidate viewport denominators (with and without the scrollbar) and keeps the
one that yields an isotropic frame. Whether `captureVisibleTab` includes the
scrollbar varies with overlay-scrollbar settings and Chrome version; guessing
wrong is a silent ~15px horizontal error. See `src/lib/coords.ts`.

**Active-tab resolution ignores DevTools/panel focus.** `getActiveTab()` in
the service worker does *not* use `chrome.tabs.query({active, currentWindow})`
— when the service-worker DevTools or the side panel itself has focus,
`currentWindow` can resolve to *that* window instead of your browser tab,
which silently captures the wrong thing (or a `chrome://` page). It resolves
the last-focused **normal** browser window instead, with a fallback scan.
See `src/background/service-worker.ts`.

**The build is hand-rolled on purpose.** MV3 needs three outputs with
incompatible module formats (ES-module page, ES-module worker, IIFE content
script). `build.mjs` runs three sequential Vite builds — about 40 lines, fully
under our control, no plugin to break the week before the demo.

## Troubleshooting

**"No access to this tab yet"** — you clicked Capture while a `chrome://`
page, the extensions page, or DevTools had focus. Switch to a normal http/https
tab, make sure no DevTools window is focused, and capture again.

**"This is a browser page and cannot be captured"** — same cause, cleaner
message. Capture only works on real websites.

**Capture fails only on the local test page** — expected. `file://` pages
aren't covered by the `http://*/*` / `https://*/*` host permissions, so
`test-page/index.html` won't load via `Capture` as-is. Two ways around it,
neither requires broadening permissions:
- Serve it instead of opening it: `npx serve test-page` and capture the
  `http://localhost:...` URL it gives you.
- Or just verify coordinate alignment on any real site (Wikipedia works well)
  — the test page's real purpose is Phase 2's PII-precision fixture, not this
  check.

**Raw error text, if the friendly message isn't enough** — open the extension
card at `chrome://extensions` → **"service worker"** under Inspect views →
Console tab → Capture. The `[SIH] capture failed …` line there is the actual
Chrome API error.

## Known gaps (deliberate, revisited later)

- **Occlusion is not modelled.** An element visually behind another is still
  reported as visible. Matters for redaction in Phase 3.
- **Selectors are best-effort.** Hardened in Phase 5, when actions depend on them.
- **`file://` capture isn't wired up.** See Troubleshooting above — serve the
  test page over http instead, or add `file:///*` host permission + file
  access if you specifically need it later.
- **Cross-origin iframes are not traversed.** Their contents are invisible to
  the DOM track; the Phase 2 vision tracks are what will cover them.
- **Chrome only.** Firefox's MV3 differs (no `chrome.sidePanel`, event pages
  rather than true service workers). Ported in Phase 6.

## Models

- **`extension/public/models/yolov11n-face.onnx`** — face detection (Track 2).
  - Source: https://huggingface.co/AdamCodd/YOLOv11n-face-detection (`model.onnx`, fp32 — not `model_fp16.onnx`; the WASM fallback path needs fp32)
  - sha256: `2dfe14171f5b76a05f9bcf0dac7f94b7bff4416b1f29eff7c9ef5830f51c5719`
  - License: apache-2.0
  - Base model: Ultralytics/YOLO11 (YOLOv11n)
  - Dataset: WIDERFACE
  - Confirmed by inspection (session.inputNames/outputNames/dims), not assumed: input `images` float32 `[1,3,640,640]` NCHW RGB; output `output0` float32 `[1,5,8400]` (`cx,cy,w,h,score` per anchor, score already sigmoid'd, no baked-in NMS).

- **`extension/public/models/plingampally/meridianpii-hi-v2/`** — Hindi/English NER for PII (Track 3, 4a). Gitignored (~55MB, over GitHub's 50MB warning) — staged manually for now; download from the source below.
  - Source: https://huggingface.co/plingampally/meridianpii-hi-v2 (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `onnx/model_quantized.onnx` — INT8, dtype `q8`; skip `.safetensors`/full-precision `model.onnx`/any PyTorch `.bin`)
  - sha256 (`onnx/model_quantized.onnx`): `0a60415537461aed8e7380da01d051f23e962a1c540129a94ba4f3925e26be56`
  - License: **CC BY 4.0** — attribution required on redistribution.
  - Base model: MiniLM (Apache-2.0). Derived from Rampart (CC BY 4.0).
  - 17-label BIO token-classification (`BertForTokenClassification`): `GIVEN_NAME, SURNAME, EMAIL, PHONE, URL, TAX_ID, BANK_ACCOUNT, ROUTING_NUMBER, GOVERNMENT_ID, PASSPORT, DRIVERS_LICENSE, BUILDING_NUMBER, STREET_NAME, SECONDARY_ADDRESS, CITY, STATE, ZIP_CODE`. Loaded via `@huggingface/transformers`' `pipeline('token-classification', ..., { dtype: 'q8' })`, confidence floor `0.15` (INT8 flattens scores — Track 2's 0.4 would drop real hits), text NFC-normalized only (NFKD strips Devanagari matras).

## Layout