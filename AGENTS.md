# umbra: project context

This file is for anyone (person or AI agent) who needs to pick up work on umbra quickly. It describes what
the site is, how it is built, and the rules the owner cares about.

## What it is

**umbra** is a free web toolkit for Roblox GFX artists, made by **@gfxs0da** (x.com/gfxs0da), a Roblox GFX
artist. Tagline: *"just use umbra, bro."* Bio: *"the boring parts of roblox gfx work, done in a few clicks.
six free tools, one tab."*

- Live site: **https://useumbra.cc/** (custom domain on GitHub Pages; `dgolaus.github.io/Umbra` redirects to it).
- Repo: **github.com/dgolaus/Umbra**, served from the `main` branch root. A push to `main` is a deploy.
- DNS is on Cloudflare (A/AAAA records for GitHub Pages, `www` CNAME, all "DNS only"). `useumbra.cc` and
  `gfxs0da.com` are both verified domains on the GitHub account.

Everything runs in the visitor's browser. There is no backend, no account and no upload. The only outside
data is a daily Roblox snapshot that a GitHub Action bakes into the repo (see "Daily feed").

## The six tools (plus the landing page)

The site is a single page (`index.html`). Each tool is a `<section class="tool" id="tool-NAME">`, and
`js/hub.js` shows one at a time. Clean URLs map to tools: `/update`, `/mosaic`, `/rocalc`, `/frontpage`,
`/crop`, `/gltf`. The site root `/` is the landing page (`home`). Keys `1` to `6` switch tools.

| # | tool | files | what it does |
|---|------|-------|--------------|
| 1 | **update icon** | `js/update-icon.js`, `css/update-icon.css`, `js/hourglass-asset.js`, `js/umbra-zip.js` | Countdown overlays for Roblox game icons, in the style of rovisuals: the real rovisuals hourglass glyph (embedded as a data URI), bold Arial countdown text, darkness/size/position sliders, outline, presets, custom overlay upload, auto square crop with draggable focus, "generate countdown set" (24 HOURS → NOW!). Saves as separate PNGs or one .zip, to the browser's downloads or to a folder the user picks (File System Access API, remembered in IndexedDB). Filename prefix, `_2/_3` dedup, never overwrites. Receives icons from crop and gltf. |
| 2 | **mosaic** | `js/mosaic.js`, `css/mosaic.css` | Grid mosaics from thumbnails (port of the owner's own Mosaic project). Boards save a whole mosaic (grid, settings, images) in IndexedDB (`thumbgrid`). Share links use `#cfg=…`. Slots can be sent to frontpage. |
| 3 | **rocalc** | `js/rocalc.js`, `css/rocalc.css` | Robux calculator (port of the owner's RoCalc): marketplace tax (Roblox keeps 30%), gamepass pricing, DevEx, black-market rates with a currency dropdown. |
| 4 | **frontpage** | `js/frontpage.js`, `css/frontpage.css`, `js/feed.js`, `js/connections.js`, `js/umbra-insights.js`, `js/umbra-paint.js` | Inspired by qptr.io: drops the user's thumbnail and icon into an original Roblox-style mock (home / search / charts, desktop / mobile, dark / light, EN / PT-BR) next to real games from the daily feed. A/B variants, readability tests (distance, squint, grayscale), stand-out meter, click a tile to place your game, PNG export (custom DOM-to-canvas painter, no html2canvas). Opens at 100% (real size); "fit" scales the whole 1920×1080 screen into the box; the ⛶ icon shows it fullscreen at real size (falls back to covering the window when fullscreen is blocked). The signed-in viewer is **S0DA** (the owner's avatar, red verified badge, top bar and sidebar only, never in the connections row). The connections row shows the owner's real Roblox friends, shuffled on every load. |
| 5 | **crop** | `js/crop.js`, `css/crop.css` | Photoshop-style crop: dimmed outside, white L-corner handles, thirds grid while dragging, ratios 1:1 / 16:9 / 4:3 / free / original, output sizes (512 icon, 1920×1080 thumb, etc.). Sends results to update icon or frontpage. |
| 6 | **gltf → png** (badge: "active testing") | `js/gltf.js`, `css/gltf.css` | For EgoMoose's Photobooth Studio plugin: captures are exported from Studio as `.gltf`/`.glb`; this extracts the embedded images as PNGs (bit-exact when no option is on). Gallery with previews, capture-time sort (mesh names are UTC timestamps), duplicate detection, rename, "remove empty space" (trim transparency), background, size, name style, save to downloads/folder as PNGs or .zip, send to crop / update icon / frontpage. Real exports are 3840×2160 RGBA PNGs. |
| – | **landing** (`home`) | `js/home.js`, `css/home.css`, `js/specular.js`, `assets/home/` | Typewriter hero ("stop redoing countdown icons." / "stop googling robux to usd." / "stop guessing how your thumbnail looks." → "just use umbra, bro." with neon on "umbra"), nav hidden while it types, SpecularButton CTA (vanilla WebGL port of React Bits' component), "some of what's inside" bento with a small looping demo per tool using the owner's own thumbnail mockups, "from studio to front page" flow, numbers, "why did i make this?" story, FAQ, closing CTA. |

## Architecture

- **Static, zero-build, vanilla HTML/CSS/JS.** No framework, no bundler, no npm packages, no CDN scripts
  (Google Fonts is the only external request). Every JS file is a classic `<script defer>` IIFE. No ES
  modules, so the site also works when `index.html` is opened from disk (`file://`).
- **`js/hub.js`** is the controller: tool switching, clean URLs (`history.replaceState`), the nav, keys 1–6,
  the boot splash, a shared smooth scroll, and the cross-tool bus:
  - `Hub.show(name)`, `Hub.isActive(name)`, `Hub.activeTool`, `Hub.lastTool()`
  - `Hub.send(target, payload)` queues a payload and opens the target; receivers drain it with
    `Hub.takeInbox(target)` on init and on the `hub:receive` event. Payload shape:
    `{ kind: 'icon' | 'thumb', dataUrl, name?, source }`. Frontpage ignores `name` when it comes from crop or gltf.
  - `hub:show` (detail `{ tool }`) fires on every switch.
- **Clean URLs on GitHub Pages:** `/crop` is not a real file, so Pages serves `404.html`, which redirects to
  `/?go=crop` (keeping `#cfg=` hashes); `hub.js` reads `?go=` and rewrites the URL. Old `#tool` links still work.
- **Tool panels** use `content-visibility` so hidden tools cost nothing; `body.warming` lays them all out
  once behind the boot splash. Panels that measure themselves must re-measure on `hub:show`.
- **Shared modules:** `umbra-zip.js` (store-only zip writer, `window.UmbraZip.build`), `umbra-paint.js`
  (`UmbraPaint.paint`, DOM → canvas for frontpage export), `umbra-insights.js` (image stats for the
  stand-out meter), `specular.js` (`UmbraSpecular.enhance(el, opts)`).
- **Storage:** localStorage keys are prefixed per tool (`ui.*` update icon, `crop.*`, `gltf.*`,
  `hub.lastTool`); sessionStorage holds download-name counters and `home.typed`; IndexedDB databases are
  `umbra-update-icon`, `umbra-gltf` (remembered folder handles), `umbra-frontpage` (state + thumbnails) and
  `thumbgrid` (mosaic boards).

## Daily feed and avatars

Roblox's JSON APIs have no CORS, so the browser cannot call them. `.github/workflows/update-feed.yml` runs
every day (cron `23 6 * * *`, also manual) and:

- `scripts/fetch-feed.js` writes `js/feed.js` (`window.__UMBRA_FEED`: sorts, games, genres, thumbnail and
  icon URLs). The images themselves are hotlinked from `tr.rbxcdn.com`, which sends CORS `*`, so the
  frontpage export can still draw them.
- `scripts/fetch-avatars.js` refreshes `js/connections.js` and `assets/frontpage/avatars/` (headshot URLs
  expire, so the PNGs live in the repo). The username list is at the top of the script. Watch for
  look-alike names (capital `I` vs lowercase `l`, e.g. `Ieafarr`, `4Iudee`). A partial run keeps the old list.
- It commits only when something changed and asks Pages to rebuild.

## Design rules

- Monochrome: black and grays, light-gray accent `#e5e5e5`, JetBrains Mono, all lowercase UI copy, glass
  panels, subtle grid background. **No red in the site chrome.** The only exceptions: S0DA's red verified
  badge inside the frontpage mock, the yellow "active testing" badge on gltf, and the owner's own artwork
  (thumbnail mockups) keeping its colors.
- Every tool works down to 320px wide with no horizontal scroll; the six-tab nav has stepped breakpoints in
  `css/core.css` (re-measure if a tab is added or renamed).
- Respect `prefers-reduced-motion`. Never use `alert()`, `prompt()` or `confirm()`; use the in-tool toasts.
- Copy should read like a person wrote it: no em dashes, no triads of fragments, no invented facts.

## Working on it

- **Local preview:** `node _serve.js` serves the repo on http://localhost:4173 with no caching and
  `404.html` fallback, like Pages. `_serve.js`, `_src/` (harnesses, samples, the embed banner source
  `_src/og/og.html`) and `.claude/` are gitignored and never deployed.
- **Embed banner:** `assets/og.png` (1200×630) is rendered from `_src/og/og.html` with headless Chrome.
  Bump the `?v=` in the `og:image` / `twitter:image` meta tags when it changes so Discord refetches it.
- **Deploying:** only when the owner says so ("deploy"). Commit with the noreply git identity configured in
  the repo, push to `main`, wait for the Pages build. The daily Action also pushes to `main`, so pull with
  rebase before pushing.
- The owner talks in Brazilian Portuguese and prefers short status updates with honest time estimates.
