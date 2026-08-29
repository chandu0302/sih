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
4. Open any normal website tab, click the extension icon, press **Capture**

To verify alignment precisely, open `test-page/index.html` in a tab — it places
elements at known pixel offsets so misalignment is obvious rather than a
judgement call.

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

**Permissions are deliberately minimal.** The extension declares no content
script and holds no host permissions. It uses `activeTab` plus on-demand
injection via `chrome.scripting.executeScript`, so it can only read a page at
the moment you invoke it. For a privacy project, asking for permanent access to
every site at install time is the wrong first impression.

*Consequence to plan for:* `activeTab` is revoked on navigation. Phase 5's agent
loop navigates, so it will need `optional_host_permissions` requested at
runtime — keeping the install-time permission list clean.

**Capture order is the correctness story.** Read the DOM, capture pixels, then
re-probe the viewport to detect whether the page moved in between. A drift
warning is surfaced in the panel rather than silently producing boxes that
describe a page state the screenshot never showed.

**Scale is derived, not assumed.** `createCoordinateFrame()` tries both
candidate viewport denominators (with and without the scrollbar) and keeps the
one that yields an isotropic frame. Whether `captureVisibleTab` includes the
scrollbar varies with overlay-scrollbar settings and Chrome version; guessing
wrong is a silent ~15px horizontal error. See `src/lib/coords.ts`.

**The build is hand-rolled on purpose.** MV3 needs three outputs with
incompatible module formats (ES-module page, ES-module worker, IIFE content
script). `build.mjs` runs three sequential Vite builds — about 40 lines, fully
under our control, no plugin to break the week before the demo.

## Known gaps (deliberate, revisited later)

- **Occlusion is not modelled.** An element visually behind another is still
  reported as visible. Matters for redaction in Phase 3.
- **Selectors are best-effort.** Hardened in Phase 5, when actions depend on them.
- **Cross-origin iframes are not traversed.** Their contents are invisible to
  the DOM track; the Phase 2 vision tracks are what will cover them.
- **Chrome only.** Firefox's MV3 differs (no `chrome.sidePanel`, event pages
  rather than true service workers). Ported in Phase 6.

## Layout

```
extension/
├── build.mjs              three-target MV3 build
├── manifest.json
└── src/
    ├── types.ts           shared data contract
    ├── lib/coords.ts      ← the coordinate contract; nothing else converts spaces
    ├── lib/coords.test.ts
    ├── lib/messaging.ts   typed cross-context protocol
    ├── background/        capture coordinator (owns operation order)
    ├── content/           injected snapshot (DOM traversal)
    └── sidepanel/         React verification panel
test-page/
└── index.html             elements at known offsets
```
