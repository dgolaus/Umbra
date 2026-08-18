<div align="center">

![umbra](assets/og.png)

# umbra

**a roblox gfx utility hub — by [@gfxs0da](https://x.com/gfxs0da)**

three client-side tools for roblox icon & thumbnail work, under one roof.
no backend · no build step · no tracking — everything runs in your browser.

[**→ open umbra**](https://dgolaus.github.io/Umbra/)

</div>

---

## the tools

### ⧗ update icon
countdown-overlay generator for roblox game icons — the white hourglass + bold countdown text over a darkened background.

- **unlimited** uploads — drag, paste (`ctrl+v`) or click
- live global style: bg darkness, hourglass size/position, text size/position, black outline + width
- per-icon editable countdown text
- one-click **generate countdown set** — turns one image into the whole sequence (`24 hours → 12 → … → now!`)
- per-icon duplicate · copy to clipboard · download png at native resolution
- **download all** as a zip
- saveable style presets · processed locally for privacy

### ▦ mosaic
roblox-style thumbnail grid generator.

- 5 formats (`2×2 … 4×3`), 3 ratios (`16:9 / 1:1 / 4:5`), gap + rounded corners
- drag / drop / paste, drag-to-reorder, per-slot upload
- filters (saturation · contrast · vignette) — applied in preview **and** export
- auto-arrange by engagement, presets, undo/redo (40 steps)
- **boards** — save a whole finished mosaic (grid, settings **and** images) and reload it later to keep editing
- png export at 1080p / 2k / 4k · remembers your work (indexeddb)

### ∑ rocalc
robux calculator suite.

- **tax** (30%, bi-directional) · **gamepass** reverse pricing
- **devex** (robux ↔ usd ↔ brl, precision mode)
- **black market** — parallel-market comparison vs the official devex rate
- live usd→brl rate with fallback + manual override

---

## design
dark, near-black, monochrome. [jetbrains mono](https://www.jetbrains.com/lp/mono/) throughout, lowercase-leaning ui, glassmorphism panels, a subtle film-grain + ambient particles. respects `prefers-reduced-motion`.

## shortcuts
`1` `2` `3` switch tools · `ctrl+v` paste images · `ctrl+z` / `ctrl+shift+z` undo / redo (mosaic)

## tech
vanilla **html / css / js**. zero build, zero dependencies (jszip is pulled from a cdn only when you export a zip). all image work is native `<canvas>`. runs straight from `file://` or any static host.

```
index.html        # the whole app shell + the three tool panels
css/              # core design system + one file per tool
js/               # hub controller + one module per tool
assets/           # logo, favicon, og card, hourglass glyph
```

## run locally
just open `index.html`, or serve the folder:

```sh
npx serve        # or:  python -m http.server
```

## credits
built by [@gfxs0da](https://x.com/gfxs0da) · [github @dgolaus](https://github.com/dgolaus)

not affiliated with roblox corporation. robux, devex and related marks belong to roblox.
