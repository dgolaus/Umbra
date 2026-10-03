/* =========================================================================
   TOOL 5 · CROP — photoshop-style crop for thumbnails & icons
   Upload a thumbnail → a highlighted crop area (1:1 by default) → drag /
   resize it like photoshop (white L corners + edge bars, dimmed outside,
   rule-of-thirds grid while dragging, alt = from centre, shift = keep ratio
   in free) → export a png (150 / 512 / 1024 icon, 720p / 1080p thumb,
   native…) or hand it to update icon / frontpage through Hub.send.
   The crop rect lives in IMAGE pixels (floats) and is rounded only at export.
   Self-contained IIFE. Global listeners guarded by Hub.isActive('crop').
   ========================================================================= */
(function () {
  'use strict';

  /* ---------- config ---------- */
  var TOOL = 'crop';
  var MIN_CROP = 16;          // shortest crop side, in image px
  var MAX_ZOOM = 4;           // on-screen upscale cap for tiny images
  var PROXY_MAX = 1600;       // long edge of the preview proxy (big images stay smooth)
  var NATIVE_CAP = 8192;      // safety cap on a 'native' export's long edge
  var SAFE_AREA = 16777216;   // largest canvas every browser allocates (iOS safari: 4096²)
  var PREV_H = 220;           // preview box height (css px)
  var LS_RATIO = 'crop.ratio', LS_OUTPUT = 'crop.output', SS_NAMES = 'crop.dlnames';

  /* =======================================================================
     pure geometry — no DOM. exposed as window.UmbraCrop.geo (node-testable)
     boxes are { x, y, w, h } in image px; W × H is the image size.
     ======================================================================= */
  var Geo = (function () {
    var RATIOS = { '1:1': [1, 1], '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '3:4': [3, 4], 'free': null, 'original': null };
    var KEYS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'free', 'original'];
    var FLIP = { '16:9': '9:16', '9:16': '16:9', '4:3': '3:4', '3:4': '4:3' };
    var BASE = { '9:16': '16:9', '3:4': '4:3' };
    var NATIVE = { id: 'native', w: 0, h: 0 };
    // output presets per landscape ratio — portrait mirrors them
    var PRESETS = {
      '1:1':  { def: '512',       list: [{ id: '150', w: 150, h: 150 }, { id: '512', w: 512, h: 512 }, { id: '1024', w: 1024, h: 1024 }] },
      '16:9': { def: '1920x1080', list: [{ id: '1280x720', w: 1280, h: 720 }, { id: '1920x1080', w: 1920, h: 1080 }] },
      '4:3':  { def: '1024x768',  list: [{ id: '1024x768', w: 1024, h: 768 }] }
    };

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function isKey(k) { return KEYS.indexOf(k) !== -1; }
    function baseKey(k) { return BASE[k] || k; }
    function flipKey(k) { return FLIP[k] || k; }
    function isPortrait(k) { return k === '9:16' || k === '3:4'; }
    function canFlip(k) { return !!FLIP[k]; }
    // width / height of the ratio, or null (free)
    function aspect(k, W, H) {
      if (k === 'original') return W > 0 && H > 0 ? W / H : null;
      var r = RATIOS[k];
      return r ? r[0] / r[1] : null;
    }
    function minSide(W, H) { return Math.min(MIN_CROP, W, H); }

    // the LARGEST box of ratio r that fits the image, centred (photoshop's default)
    function fitBox(W, H, r) {
      if (!r) return { x: 0, y: 0, w: W, h: H };
      var w = W, h = W / r;
      if (h > H) { h = H; w = H * r; }
      return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
    }
    // a w × h box centred on (cx, cy), shifted back inside the image
    function place(cx, cy, w, h, W, H) {
      w = Math.min(w, W); h = Math.min(h, H);
      return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w: w, h: h };
    }
    function clampBox(b, W, H) {
      var m = minSide(W, H);
      var w = clamp(b.w, m, W), h = clamp(b.h, m, H);
      return { x: clamp(b.x, 0, W - w), y: clamp(b.y, 0, H - h), w: w, h: h };
    }
    // ratio change: the smallest box of the new ratio that still covers the old one,
    // capped to the largest that fits, centred on the old centre (shifted in when needed)
    function refit(b, W, H, r) {
      if (!r) return clampBox(b, W, H);
      var w = Math.max(b.w, b.h * r), h = w / r;
      var max = fitBox(W, H, r);
      if (w > max.w) { w = max.w; h = max.h; }
      var m = minSide(W, H);
      if (Math.min(w, h) < m) {
        if (w < h) { w = m; h = m / r; } else { h = m; w = m * r; }
        if (w > max.w) { w = max.w; h = max.h; }
      }
      return place(b.x + b.w / 2, b.y + b.h / 2, w, h, W, H);
    }
    // orientation swap (photoshop's ⇄): width and height trade places around the same centre,
    // scaled down only when the swapped box would not fit. r = the NEW ratio (kept exact).
    function swap(b, W, H, r) {
      var w = b.h, h = r ? w / r : b.w;
      var max = fitBox(W, H, r || w / h);
      if (w > max.w + 1e-9 || h > max.h + 1e-9) { var k = Math.min(max.w / w, max.h / h); w *= k; h *= k; }
      var m = minSide(W, H);
      if (Math.min(w, h) < m) {
        if (w < h) { w = m; h = r ? m / r : h; } else { h = m; w = r ? m * r : w; }
        if (w > max.w) { w = max.w; h = max.h; }
      }
      return place(b.x + b.w / 2, b.y + b.h / 2, w, h, W, H);
    }
    function move(b, dx, dy, W, H) {
      return { x: clamp(b.x + dx, 0, W - b.w), y: clamp(b.y + dy, 0, H - b.h), w: b.w, h: b.h };
    }
    /* resize from a handle. s = the box when the drag started, (dx, dy) = pointer travel
       in image px since then. o = { W, H, r (locked ratio or null), center (alt), keep (shift) }.
       - corner + ratio: anchored at the opposite corner, slides along the box diagonal
       - edge + ratio:   anchored at the opposite edge's centre (cross axis slides in at a bound)
       - center:         symmetric around the start centre
       - keep (free only): locks the start box's own ratio
       a locked-ratio resize that would leave the image stops at the bound (never distorts). */
    function resize(s, handle, dx, dy, o) {
      var W = o.W, H = o.H;
      var r = o.r || (o.keep ? s.w / s.h : null);
      var c = !!o.center;
      var m = minSide(W, H);
      var hx = handle.indexOf('e') !== -1 ? 1 : (handle.indexOf('w') !== -1 ? -1 : 0);
      var hy = handle.indexOf('s') !== -1 ? 1 : (handle.indexOf('n') !== -1 ? -1 : 0);
      var x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      var cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      var k = c ? 2 : 1;
      // room available from the anchor in the growth direction. an edge drag's cross axis
      // (ratio-locked) stays centred on the old centre when it can and slides inside the image
      // when it can't — so a box touching the top still grows from its side bars.
      var roomX = c ? 2 * Math.min(cx, W - cx) : (hx > 0 ? W - x0 : (hx < 0 ? x1 : W));
      var roomY = c ? 2 * Math.min(cy, H - cy) : (hy > 0 ? H - y0 : (hy < 0 ? y1 : H));
      var w = s.w + hx * dx * k, h = s.h + hy * dy * k;

      if (!r) {
        w = hx ? clamp(w, Math.min(m, roomX), roomX) : s.w;
        h = hy ? clamp(h, Math.min(m, roomY), roomY) : s.h;
      } else {
        // corner: the pointer travel projected onto the box diagonal from the anchor (least squares)
        // — continuous, so the corner slides smoothly along the diagonal and never jumps (photoshop)
        if (hx && hy) w = s.w + k * (hx * dx * r * r + hy * dy * r) / (r * r + 1);
        else if (hy) w = h * r;                 // n / s edge drives the height
        var maxW = Math.min(roomX, roomY * r);
        var minW = r >= 1 ? m * r : m;          // shortest side ≥ m
        w = clamp(w, Math.min(minW, maxW), maxW);
        h = w / r;
      }

      var x, y;
      if (c || (hx === 0 && r)) x = cx - w / 2;
      else if (hx > 0) x = x0;
      else if (hx < 0) x = x1 - w;
      else x = x0;
      if (c || (hy === 0 && r)) y = cy - h / 2;
      else if (hy > 0) y = y0;
      else if (hy < 0) y = y1 - h;
      else y = y0;
      // shifts an edge drag's cross axis back inside; otherwise float dust only
      x = clamp(x, 0, Math.max(0, W - w));
      y = clamp(y, 0, Math.max(0, H - h));
      return { x: x, y: y, w: w, h: h };
    }

    // exact integer source rect for export (keeps a locked ratio as close as integers allow)
    function intRect(b, W, H, r) {
      var w = clamp(Math.round(b.w), 1, W), h = clamp(Math.round(b.h), 1, H);
      if (r) {
        var h2 = Math.round(w / r);
        if (h2 >= 1 && h2 <= H) h = h2;
        else w = clamp(Math.round(h * r), 1, W);
      }
      var x = clamp(Math.round(b.x + (b.w - w) / 2), 0, W - w);
      var y = clamp(Math.round(b.y + (b.h - h) / 2), 0, H - h);
      return { x: x, y: y, w: w, h: h };
    }

    // output presets for a ratio key (portrait keys mirror their landscape presets)
    function presets(k) {
      var p = PRESETS[baseKey(k)], port = isPortrait(k);
      var list = (p ? p.list : []).map(function (q) {
        var w = port ? q.h : q.w, h = port ? q.w : q.h;
        return { id: q.id, w: w, h: h, label: w === h ? String(w) : (w + '×' + h) };
      });
      list.push({ id: 'native', w: 0, h: 0, label: 'native' });
      return list;
    }
    function defaultPreset(k) { var p = PRESETS[baseKey(k)]; return p ? p.def : 'native'; }
    function validPreset(k, id) {
      return presets(k).some(function (q) { return q.id === id; }) ? id : defaultPreset(k);
    }
    // final integer output size for (ratio key, preset id, integer crop rect)
    function outputSize(k, id, rect, cap) {
      var list = presets(k), p = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) p = list[i];
      if (!p || p.id === 'native') {
        var lim = cap || Infinity, s = Math.min(1, lim / Math.max(rect.w, rect.h));
        return { w: Math.max(1, Math.round(rect.w * s)), h: Math.max(1, Math.round(rect.h * s)), native: true, capped: s < 1 };
      }
      return { w: p.w, h: p.h, native: false, capped: false };
    }

    return {
      MIN_CROP: MIN_CROP, KEYS: KEYS,
      clamp: clamp, isKey: isKey, baseKey: baseKey, flipKey: flipKey, isPortrait: isPortrait, canFlip: canFlip,
      aspect: aspect, minSide: minSide, fitBox: fitBox, place: place, clampBox: clampBox, refit: refit, swap: swap,
      move: move, resize: resize, intRect: intRect,
      presets: presets, defaultPreset: defaultPreset, validPreset: validPreset, outputSize: outputSize
    };
  })();

  if (typeof window !== 'undefined') window.UmbraCrop = { geo: Geo };
  if (typeof document === 'undefined') return;     // node / vm test: geometry only

  /* ---------- state ---------- */
  var src = null;             // { img, url (object url | null), W, H, base, proxy, pk }
  var box = null;             // crop rect, image px (floats)
  var userBox = null;         // the last box the user set directly — ratio changes refit from it (no ratchet)
  var hitPx = 28;             // current --cr-hit (css px), re-read on layout
  var ratioByPointer = false; // the ratio <select> was opened with a pointer (→ give focus back to the box)
  var ratioKey = '1:1';
  var savedRatio = '1:1';     // the user's own last pick — the only ratio ever persisted (sender hints are not)
  var outPref = {};          // base ratio key → preset id
  var nameDirty = false;
  var disp = { sx: 0, sy: 0, w: 0, h: 0 };
  var drag = null;
  var raf = 0, needLayout = false, needBox = false, needPrev = false;
  var loadSeq = 0, busy = false, badgeTimer = null;
  var noop = function () {};

  /* ---------- refs ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var root, stage, view, drop, frame, imgEl, shade, ui, boxEl, badge, bar, ratioSel, swapBtn, resetBtn, newBtn,
      fileInput, infoEl, prevWrap, prevCanvas, prevEmpty, outSizeEl, upEl, sizesRow, nameIn,
      dlBtn, copyBtn, toUpdateBtn, toFpBtn, toastEl;

  function isActive() { return !!(window.Hub && typeof Hub.isActive === 'function' && Hub.isActive(TOOL)); }
  function typingIn(t) {
    var tag = t && t.tagName;
    if (tag === 'INPUT') return !/^(checkbox|radio|button|submit|reset|file|color|image|range)$/i.test(t.type || '');
    return tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
  }
  // somewhere text can actually be pasted (a focused <select> is not one)
  function isTextField(t) { return typingIn(t) && !(t && t.tagName === 'SELECT'); }
  // give the keyboard to the crop box (photoshop: the crop keys work as soon as the crop is on screen)
  function focusBox() {
    if (!src || !boxEl || !isActive() || isTextField(document.activeElement)) return;
    try { boxEl.focus({ preventScroll: true }); } catch (e) {}
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, type) {
    if (!toastEl) return;
    // when the floating toolbar reaches the bottom of the viewport, the toast moves to the top of the
    // stage, centred on it (not over the bottom handles / toolbar); else core's bottom-centre spot
    var b = 30, left = '', top = '';
    if (bar && !bar.hidden && view) {
      var r = bar.getBoundingClientRect(), vh = window.innerHeight || 0;
      if (r.height && r.top < vh && r.bottom > vh - 90) {
        var v = view.getBoundingClientRect();
        var cs = getComputedStyle(document.documentElement);
        var navB = (parseFloat(cs.getPropertyValue('--nav-top')) || 12) + (parseFloat(cs.getPropertyValue('--nav-h')) || 52);
        var tt = Math.round(Math.max(v.top + 10, navB + 8));
        left = Math.round(v.left + v.width / 2) + 'px';
        if (tt + 60 < r.top) top = tt + 'px';
        else b = Math.max(30, Math.round(vh - r.top + 12));
      }
    }
    toastEl.style.left = left;
    toastEl.style.top = top;
    toastEl.style.bottom = top ? 'auto' : b + 'px';
    toastEl.textContent = msg;
    if (type) toastEl.dataset.type = type; else delete toastEl.dataset.type;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, 1900);
  }

  /* ---------- storage ---------- */
  function loadPrefs() {
    try {
      var k = localStorage.getItem(LS_RATIO);
      if (Geo.isKey(k)) ratioKey = savedRatio = k;
    } catch (e) {}
    try {
      var o = JSON.parse(localStorage.getItem(LS_OUTPUT) || '{}');
      if (o && typeof o === 'object') Object.keys(o).forEach(function (b) { if (typeof o[b] === 'string') outPref[b] = o[b]; });
    } catch (e) {}
  }
  function saveRatio() { try { localStorage.setItem(LS_RATIO, savedRatio); } catch (e) {} }
  function saveOutput() { try { localStorage.setItem(LS_OUTPUT, JSON.stringify(outPref)); } catch (e) {} }
  // per-session download-name registry so repeats get _2, _3… (same idea as update icon)
  function uniqueName(base) {
    var map;
    try { map = JSON.parse(sessionStorage.getItem(SS_NAMES) || '{}'); } catch (e) { map = {}; }
    if (!map || typeof map !== 'object') map = {};
    var n = (map[base] || 0) + 1;
    map[base] = n;
    try { sessionStorage.setItem(SS_NAMES, JSON.stringify(map)); } catch (e) {}
    return n === 1 ? base : base + '_' + n;
  }

  /* ---------- names ---------- */
  function sanitize(s) {
    return String(s || '').trim()
      .replace(/\.png$/i, '')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 80);
  }
  // strips only a real image extension: a received game name like 'Adopt.Me' or 'Pet Sim 2.5' stays whole
  function baseFromName(n) {
    return sanitize(String(n || '').replace(/\.(png|jpe?g|jfif|pjpeg|webp|gif|bmp|avif|heic|heif|tiff?|svg|ico)$/i, ''));
  }
  // the base is cut to 75 so base + '_icon' / '_crop' still fits sanitize()'s 80 (field = saved name)
  function defaultBase() {
    var b = (src ? src.base : 'thumbnail').slice(0, 75).replace(/[_.]+$/, '') || 'thumbnail';
    return b + (Geo.baseKey(ratioKey) === '1:1' ? '_icon' : '_crop');
  }
  function outBase() { return sanitize(nameIn.value) || sanitize(defaultBase()) || 'crop'; }
  function syncName() { if (!nameDirty) nameIn.value = defaultBase(); }

  /* ---------- canvas helpers ---------- */
  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    if (!ctx || c.width !== w || c.height !== h) throw new Error('canvas ' + w + '×' + h + ' unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return c;
  }
  // free a scratch canvas's backing store now (iOS caps total canvas memory and frees it lazily)
  function release(c) { if (c && c.getContext) { c.width = 0; c.height = 0; } }
  // sub-rect → ow × oh with stepwise halving for big downscales (no aliasing on 1080 → 150)
  function stepped(source, sx, sy, sw, sh, ow, oh) {
    var cur = source, cx = sx, cy = sy, cw = sw, ch = sh;
    try {
      while (cw > ow * 2 || ch > oh * 2) {
        var nw = cw > ow * 2 ? Math.ceil(cw / 2) : cw;
        var nh = ch > oh * 2 ? Math.ceil(ch / 2) : ch;
        var t = canvasOf(nw, nh);
        t.getContext('2d').drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
        if (cur !== source) release(cur);
        cur = t; cx = 0; cy = 0; cw = nw; ch = nh;
      }
      var out = canvasOf(ow, oh);
      out.getContext('2d').drawImage(cur, cx, cy, cw, ch, 0, 0, ow, oh);
      return out;
    } finally {
      if (cur !== source) release(cur);
    }
  }
  // png blob of an output canvas, which is released once encoded
  function canvasBlob(canvas) {
    return new Promise(function (res) { canvas.toBlob(function (b) { release(canvas); res(b); }, 'image/png'); });
  }
  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- derived ---------- */
  function ratio() { return src ? Geo.aspect(ratioKey, src.W, src.H) : Geo.aspect(ratioKey, 1, 1); }
  function presetId() { return Geo.validPreset(ratioKey, outPref[Geo.baseKey(ratioKey)]); }
  function cropInt() { return Geo.intRect(box, src.W, src.H, ratio()); }
  function outSize(r) { return Geo.outputSize(ratioKey, presetId(), r, NATIVE_CAP); }

  /* ---------- loading ---------- */
  function loadFile(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { toast('that is not an image', 'warn'); return; }
    var url = URL.createObjectURL(file);
    loadFrom(url, true, baseFromName(file.name) || 'thumbnail', null);
  }
  // hint = optional ratio key from a sender, applied (not persisted) only once the image has decoded
  function loadFrom(url, revocable, base, msg, hint) {
    var seq = ++loadSeq;
    var im = new Image();
    im.decoding = 'async';
    // onload only — img.decode() never settles while the page is hidden (background tab)
    new Promise(function (res, rej) { im.onload = res; im.onerror = rej; im.src = url; })
      .then(function () {
        if (seq !== loadSeq) { if (revocable) URL.revokeObjectURL(url); return; }
        // naturalWidth/Height are post-EXIF (image-orientation: from-image) — same space drawImage uses
        var W = im.naturalWidth, H = im.naturalHeight;
        if (!W || !H) throw new Error('empty image');
        endDrag();                                  // a drag on the old image must not carry over
        var old = src;
        src = { img: im, url: revocable ? url : null, W: W, H: H, base: base || 'thumbnail', proxy: im, pk: 1 };
        makeProxy();
        imgEl.src = url;
        if (old && old.url) URL.revokeObjectURL(old.url);
        if (hint && hint !== ratioKey) setRatio(hint, true);
        box = userBox = Geo.fitBox(W, H, ratio());
        nameDirty = false;
        showStage(true);
        syncName();
        infoEl.textContent = src.base + ' · ' + W + ' × ' + H;
        needLayout = needBox = needPrev = true; flush();   // no-op while hidden — hub:show redoes it
        focusBox();
        toast(msg || ('loaded · ' + W + '×' + H));
      })
      .catch(function () {
        if (revocable) URL.revokeObjectURL(url);
        if (seq === loadSeq) toast('could not read that image', 'warn');
      });
  }
  // small downscaled copy for the live preview so an 8000px source never repaints per move
  function makeProxy() {
    var W = src.W, H = src.H, L = Math.max(W, H);
    if (L <= PROXY_MAX) return;
    var k = PROXY_MAX / L;
    try {
      src.proxy = stepped(src.img, 0, 0, W, H, Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
      src.pk = src.proxy.width / W;
    } catch (e) { src.proxy = src.img; src.pk = 1; }
  }
  function showStage(on) {
    drop.hidden = on;
    frame.hidden = !on;
    ui.hidden = !on;
    bar.hidden = !on;
    stage.classList.toggle('has-image', on);
    [dlBtn, copyBtn, toUpdateBtn, toFpBtn, nameIn].forEach(function (b) { b.disabled = !on; });
  }

  /* ---------- receiving (Hub.send → 'crop') ---------- */
  function drainInbox() {
    if (!window.Hub || typeof Hub.takeInbox !== 'function') return;
    var items;
    try { items = Hub.takeInbox(TOOL); } catch (e) { items = null; }
    if (!Array.isArray(items)) return;
    var last = null;
    items.forEach(function (p) {
      if (p && typeof p.dataUrl === 'string' && p.dataUrl.indexOf('data:image/') === 0) last = p;
    });
    if (!last) return;
    // optional ratio hint from the sender. frontpage's "crop icon from thumbnail →" is an icon crop, so
    // it opens at 1:1 even when the hint is missing (otherwise a remembered 16:9 would send it back as a
    // 'thumb'). loadFrom applies it after decoding; never persisted — the user's own pick stays remembered.
    var hint = Geo.isKey(last.ratio) ? last.ratio : (last.source === 'frontpage' ? '1:1' : null);
    var from = last.source === 'frontpage' ? 'frontpage' : (last.source === 'update' ? 'update icon' : (last.source ? String(last.source) : 'another tool'));
    loadFrom(last.dataUrl, false, baseFromName(last.name) || 'thumbnail', 'thumbnail received from ' + from, hint);
  }

  /* ---------- layout / paint ---------- */
  function schedule() { if (!raf) raf = requestAnimationFrame(tick); }
  // discrete actions (ratio, size, reset, nudge, load) paint right away; only drags wait for a frame
  function flush() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    tick();
  }
  function tick() {
    raf = 0;
    if (needLayout) layout();
    if (needBox) paintBox();
    if (needPrev) { renderPreview(); syncOutput(); }
  }
  // fit-contain the image in the view (never upscaled past MAX_ZOOM), leaving room for the toolbar
  function isNarrow() { return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches); }
  function layout() {
    needLayout = false;
    if (!src) { stage.style.height = ''; return; }
    var vw = view.clientWidth;
    if (!vw || !view.clientHeight) return;        // hidden (content-visibility) → wait for hub:show
    var hv = parseFloat(getComputedStyle(root).getPropertyValue('--cr-hit'));
    if (hv > 0) hitPx = hv;
    var pad = vw < 520 ? 16 : 26;
    var barH = bar.hidden ? 0 : bar.offsetHeight;
    // bar's bottom offset + the outward half of the s / se / sw hit areas + a gap: a touch just under the
    // bottom handles lands on the handle, not on the toolbar
    var padB = barH ? barH + (vw < 520 ? 10 : 14) + Math.ceil(hitPx / 2) + 4 : pad;
    // phones / narrow: the stage hugs the fitted image (capped at 70% of the viewport) so the toolbar
    // sits right under it instead of below the fold. the view's width doesn't depend on its height → no RO loop.
    if (isNarrow()) {
      var cs = getComputedStyle(stage);
      var sp = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var fw = (vw - pad * 2) / src.W, sw = fw < 1 ? fw : Math.min(fw, MAX_ZOOM);
      var want = src.H * sw + pad + padB + sp;
      var cap = Math.max(260, Math.round((window.innerHeight || 700) * 0.7));
      var hpx = Math.round(Math.max(260, Math.min(want, cap))) + 'px';
      if (stage.style.height !== hpx) stage.style.height = hpx;
    } else if (stage.style.height) stage.style.height = '';
    var vh = view.clientHeight;
    if (!vh) return;
    var aw = vw - pad * 2, ah = vh - pad - padB;
    if (aw < 24 || ah < 24) return;
    var fit = Math.min(aw / src.W, ah / src.H);
    var s = fit < 1 ? fit : Math.min(fit, MAX_ZOOM);
    // one exact scale for both axes (no rounding skew between box and frame); only the origin snaps
    var dw = src.W * s, dh = src.H * s;
    var l = Math.round(pad + (aw - dw) / 2), t = Math.round(pad + (ah - dh) / 2);
    [frame, ui].forEach(function (el) {
      el.style.left = l + 'px'; el.style.top = t + 'px';
      el.style.width = px(dw); el.style.height = px(dh);
    });
    frame.classList.toggle('is-pixel', s >= 3);
    disp = { sx: s, sy: s, w: dw, h: dh };
    paintBox();
    renderPreview(); syncOutput();
  }
  function px(v) { return (Math.round(v * 100) / 100) + 'px'; }
  function paintBox() {
    needBox = false;
    if (!src || !box) return;
    if (!drag) syncLabel();                         // every non-drag change (nudge, reset, ratio, load, drop)
    if (!disp.sx) return;
    var l = box.x * disp.sx, t = box.y * disp.sy, w = box.w * disp.sx, h = box.h * disp.sy;
    var st = shade.style, sb = boxEl.style;
    st.left = sb.left = px(l); st.top = sb.top = px(t);
    st.width = sb.width = px(w); st.height = sb.height = px(h);
    boxEl.classList.toggle('is-small', w < 64 || h < 64);
    // how far the handle hit areas reach INSIDE the box: half the hit size normally, at most a quarter
    // of the short side on small boxes so the middle always moves the box (photoshop); the rest of
    // each hit area moves outward, so resizing a tiny box stays easy.
    boxEl.style.setProperty('--cr-in', px(Math.min(hitPx / 2, Math.min(w, h) / 4)));
    // readout badge: above the box, inside it when there is no room
    var r = cropInt();
    badge.textContent = r.w + ' × ' + r.h + ' px';
    var bt = t >= 34 ? t - 30 : t + 8;
    var bl = Math.max(46, Math.min(disp.w - 46, l + w / 2));
    badge.style.left = px(bl); badge.style.top = px(bt);
  }
  // the box's accessible name carries the current crop (the badge is aria-hidden)
  function syncLabel() {
    var r = cropInt();
    var t = 'crop area ' + r.w + ' × ' + r.h + ' px at ' + r.x + ', ' + r.y + ' — drag to move, handles to resize, arrow keys to nudge';
    if (boxEl.getAttribute('aria-label') !== t) boxEl.setAttribute('aria-label', t);
  }
  function flashBadge() {
    badge.classList.add('is-on');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { badge.classList.remove('is-on'); }, 900);
  }
  function setBox(b, sync) {
    box = b;
    needBox = needPrev = true;
    if (sync) flush(); else schedule();
  }

  /* ---------- preview + output ---------- */
  function renderPreview() {
    needPrev = false;
    if (!src || !box) return;
    var maxW = prevWrap.clientWidth - 16, maxH = PREV_H - 16;
    if (maxW <= 0) return;
    var r = cropInt(), o = outSize(r);
    var k = Math.min(maxW / o.w, maxH / o.h);
    var cw = Math.max(1, Math.round(o.w * k)), ch = Math.max(1, Math.round(o.h * k));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr));
    if (prevCanvas.width !== pw) prevCanvas.width = pw;
    if (prevCanvas.height !== ph) prevCanvas.height = ph;
    prevCanvas.style.width = cw + 'px'; prevCanvas.style.height = ch + 'px';
    var ctx = prevCanvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, pw, ph);
    var p = src.pk;
    ctx.drawImage(src.proxy, r.x * p, r.y * p, r.w * p, r.h * p, 0, 0, pw, ph);
    prevCanvas.hidden = false;
    prevEmpty.hidden = true;
  }
  function syncOutput() {
    if (!src || !box) {
      outSizeEl.textContent = '—';
      upEl.textContent = '';
      upEl.hidden = false;
      upEl.style.visibility = 'hidden';
      prevCanvas.hidden = true; prevEmpty.hidden = false;
      return;
    }
    var r = cropInt(), o = outSize(r);
    outSizeEl.textContent = o.w + ' × ' + o.h + ' px';
    var note = '';
    if (o.capped) note = 'capped from ' + r.w + ' × ' + r.h;
    else if (!o.native && (r.w < o.w || r.h < o.h)) note = 'upscaled from ' + (r.w === r.h ? r.w + ' px' : r.w + ' × ' + r.h + ' px');
    upEl.textContent = note;
    // the note keeps its own reserved line: toggling visibility (not display) so the panel never jumps mid-drag
    upEl.hidden = false;
    upEl.style.visibility = note ? '' : 'hidden';
  }
  function buildChips() {
    var cur = presetId();
    sizesRow.textContent = '';
    Geo.presets(ratioKey).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (p.id === cur ? ' active' : '');
      b.dataset.out = p.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', p.id === cur ? 'true' : 'false');
      b.textContent = p.label;
      b.title = p.id === 'native' ? 'the crop’s own pixel size' : (p.w + ' × ' + p.h + ' px');
      sizesRow.appendChild(b);
    });
  }

  /* ---------- ratio ---------- */
  var RATIO_TEXT = { '1:1': '1:1 square', '16:9': '16:9 thumbnail', '9:16': '9:16 vertical', '4:3': '4:3', '3:4': '3:4', 'free': 'free', 'original': 'original' };
  // next (optional) = the box to use instead of a refit (the ⇄ swap passes its own)
  function setRatio(k, quiet, next) {
    if (!Geo.isKey(k)) k = '1:1';
    ratioKey = k;
    var b = Geo.baseKey(k);
    if (ratioSel.value !== b) ratioSel.value = b;
    // every flippable option shows the current orientation (in 9:16 the menu reads '9:16 vertical' and
    // '3:4'), so a pick applies exactly what its label says; ⇄ switches orientation
    var port = Geo.isPortrait(k);
    Array.prototype.forEach.call(ratioSel.options, function (opt) {
      var v = (port && Geo.canFlip(opt.value)) ? Geo.flipKey(opt.value) : opt.value;
      opt.textContent = RATIO_TEXT[v] || opt.value;
    });
    swapBtn.disabled = !Geo.canFlip(k);
    swapBtn.setAttribute('aria-label', Geo.canFlip(k) ? 'swap to ' + Geo.flipKey(k) : 'swap orientation (n/a)');
    swapBtn.title = Geo.canFlip(k) ? 'swap orientation → ' + Geo.flipKey(k) : 'only for 16:9 and 4:3';
    // refit from the user's own box, not the previous refit: 1:1 → 16:9 → 1:1 returns the same square.
    // free has nothing to fit to → the box on screen stays exactly where it is (photoshop)
    if (src && box) {
      var nr = ratio();
      if (next) box = userBox = next;
      else if (!nr) box = userBox = Geo.clampBox(box, src.W, src.H);
      else box = Geo.refit(userBox || box, src.W, src.H, nr);
    }
    if (!quiet) { savedRatio = k; saveRatio(); }
    buildChips();
    syncName();
    syncSendTitles();
    needBox = needPrev = true; flush();
  }
  // picking 16:9 / 4:3 from the dropdown keeps the current orientation
  function onRatioPick() {
    var b = ratioSel.value;
    var k = (Geo.isPortrait(ratioKey) && Geo.canFlip(b)) ? Geo.flipKey(b) : b;
    setRatio(k);
  }
  // ⇄ — photoshop's swap: w and h trade places around the centre (two presses = the original box)
  function swapOrientation() {
    if (!Geo.canFlip(ratioKey)) return;
    var nk = Geo.flipKey(ratioKey);
    setRatio(nk, false, (src && box) ? Geo.swap(box, src.W, src.H, Geo.aspect(nk, src.W, src.H)) : null);
    if (src) flashBadge();
  }
  function resetBox() {
    if (!src) return;
    setBox(userBox = Geo.fitBox(src.W, src.H, ratio()), true);
    flashBadge();
  }

  /* ---------- pointer: move / resize ---------- */
  function onDown(e) {
    if (!src || drag) return;
    if (e.button != null && e.button !== 0) return;
    var h = e.target.closest && e.target.closest('.cr-h');
    var inBox = e.target.closest && e.target.closest('.cr-box');
    if (!h && !inBox) return;
    e.preventDefault();
    var el = h || boxEl;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    drag = {
      el: el, pid: e.pointerId,
      mode: h ? 'resize' : 'move', handle: h ? h.dataset.h : null,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      alt: e.altKey, shift: e.shiftKey,
      start: { x: box.x, y: box.y, w: box.w, h: box.h }
    };
    ui.classList.add('is-dragging');
    ui.dataset.mode = drag.mode;
    boxEl.classList.remove('is-kbd');              // pointer use: no keyboard focus ring (photoshop shows none)
    try { boxEl.focus({ preventScroll: true }); } catch (err) {}
    needBox = true; schedule();
  }
  function applyDrag() {
    if (!drag || !disp.sx) return;
    var dx = (drag.x - drag.x0) / disp.sx, dy = (drag.y - drag.y0) / disp.sy;
    if (drag.mode === 'move') setBox(Geo.move(drag.start, dx, dy, src.W, src.H));
    else setBox(Geo.resize(drag.start, drag.handle, dx, dy, {
      W: src.W, H: src.H, r: ratio(), center: drag.alt, keep: drag.shift && ratioKey === 'free'
    }));
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.alt = e.altKey; drag.shift = e.shiftKey;
    applyDrag();
  }
  // drop an active drag without applying anything more (also used when a new image lands mid-drag)
  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;                                  // first: releasePointerCapture fires lostpointercapture → onUp
    try { if (d.el.hasPointerCapture && d.el.hasPointerCapture(d.pid)) d.el.releasePointerCapture(d.pid); } catch (err) {}
    ui.classList.remove('is-dragging');
    delete ui.dataset.mode;
  }
  function onUp(e) {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.pid)) return;
    var st = drag.start;
    endDrag();
    // only a drag that changed the box becomes the user's box (a plain click must not commit a refit)
    if (st.x !== box.x || st.y !== box.y || st.w !== box.w || st.h !== box.h) userBox = box;
    needBox = needPrev = true; flush();             // paintBox syncs the aria-label
  }
  // alt / shift pressed or released mid-drag re-apply live (photoshop does)
  function onModKey(e) {
    if (!drag) return;
    if (e.key !== 'Alt' && e.key !== 'Shift') return;
    if (e.key === 'Alt') e.preventDefault();      // windows: don't focus the browser menu
    drag.alt = e.altKey; drag.shift = e.shiftKey;
    applyDrag();
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (!isActive() || !src || drag) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (typingIn(t)) return;                      // text fields + the ratio <select> keep their keys
    var onBox = t === boxEl;
    if (onBox) boxEl.classList.add('is-kbd');      // keyboard use on the box → show its focus ring
    var free =onBox || !t || t === document.body || t === document.documentElement;
    // arrows / esc also work with focus on a plain button (nav tab, toolbar, panel) — like photoshop.
    // enter stays box / body only so a focused button still clicks natively. the size chips own their arrows.
    var nonText = free || !(t.closest && t.closest('#cr-sizes, [role="radiogroup"]'));
    var step = e.shiftKey ? 10 : 1, dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else if (e.key === 'Enter') { if (!free) return; e.preventDefault(); if (!e.repeat) download(); return; }
    else if (e.key === 'Escape') { if (!nonText) return; e.preventDefault(); resetBox(); return; }
    else return;
    if (!nonText) return;
    e.preventDefault();
    setBox(userBox = Geo.move(box, dx, dy, src.W, src.H), true);
    flashBadge();
  }

  /* ---------- export ---------- */
  // integer source rect r → ow × oh canvas
  function renderRect(r, ow, oh) {
    // copy the integer rect 1:1 first (no filtering → nothing from outside the crop can bleed in),
    // then scale from that copy, which clamps at its own edges — no 1px fringe on the png.
    // only while the copy fits every browser's canvas limit (iOS safari: 16.7 MP) — above it, sample
    // the source directly: the first halving reads the rect itself, any edge bleed is sub-pixel.
    var base = null;
    if (r.w * r.h <= SAFE_AREA) {
      try {
        base = canvasOf(r.w, r.h);
        base.getContext('2d').drawImage(src.img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      } catch (e) { release(base); base = null; }
    }
    if (base && r.w === ow && r.h === oh) return base;
    try {
      return base ? stepped(base, 0, 0, r.w, r.h, ow, oh) : stepped(src.img, r.x, r.y, r.w, r.h, ow, oh);
    } finally { release(base); }
  }
  function renderOutput() {
    if (!src || !box) return null;
    var r = cropInt(), o = outSize(r);
    try { return renderRect(r, o.w, o.h); }
    catch (e) {
      // a huge 'native' png on a canvas-limited browser: retry scaled down to the safe area
      if (o.native && o.w * o.h > SAFE_AREA) {
        var k = Math.sqrt(SAFE_AREA / (o.w * o.h));
        try { return renderRect(r, Math.max(1, Math.floor(o.w * k)), Math.max(1, Math.floor(o.h * k))); } catch (e2) {}
      }
      toast(o.native ? 'could not render — try a smaller output size' : 'could not render this crop', 'warn');
      return null;
    }
  }
  function download() {
    if (!src || busy) return;
    var c = renderOutput();
    if (!c) return;
    busy = true;
    var name = uniqueName(outBase()) + '.png', size = c.width + '×' + c.height;
    canvasBlob(c).then(function (blob) {
      if (!blob) { toast('could not export this crop', 'warn'); return; }
      triggerDownload(URL.createObjectURL(blob), name);
      toast('saved ' + name + ' · ' + size);
    }).catch(function () { toast('could not export this crop', 'warn'); })
      .then(function () { busy = false; });
  }
  function copyOut() {
    if (!src) return;
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('clipboard image not supported — use download', 'warn'); return;
    }
    var c = renderOutput();
    if (!c) return;
    var size = c.width + '×' + c.height;
    // hand ClipboardItem the promise (keeps the click's user activation in safari)
    var blobP = canvasBlob(c).then(function (b) { if (!b) throw new Error('no blob'); return b; });
    blobP.catch(noop);
    var write;
    try { write = navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobP })]); }
    catch (e) {
      write = blobP.then(function (b) { return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': b })]); });
    }
    Promise.resolve(write)
      .then(function () { toast('copied · ' + size); })
      .catch(function () { toast('copy failed — use download', 'warn'); });
  }
  // icons are square: say so on the send buttons when the crop isn't, since the receivers centre-crop it
  function syncSendTitles() {
    var sq = Geo.baseKey(ratioKey) === '1:1';
    toUpdateBtn.title = sq ? 'use it as an icon in update icon'
      : 'icons are square — update icon centre-crops this to 1:1 (pick 1:1 to frame it yourself)';
    toFpBtn.title = ratioKey === '16:9' ? 'goes in as the frontpage thumbnail'
      : (sq ? 'goes in as the frontpage icon' : 'goes in as the icon — icons are square, so frontpage centre-crops this to 1:1');
  }
  function sendTo(target) {
    if (!src) return;
    var label = target === 'update' ? 'update icon' : 'frontpage';
    if (!window.Hub || typeof Hub.send !== 'function') { toast(label + ' not available', 'warn'); return; }
    var c = renderOutput();
    if (!c) return;
    var dataUrl;
    try { dataUrl = c.toDataURL('image/png'); }
    catch (e) { toast('could not export this crop', 'warn'); return; }
    finally { release(c); }
    var kind = (target === 'frontpage' && ratioKey === '16:9') ? 'thumb' : 'icon';
    Hub.send(target, { kind: kind, dataUrl: dataUrl, name: outBase(), source: 'crop' });
    if (typeof Hub.show === 'function') Hub.show(target);
  }

  /* ---------- wiring ---------- */
  function pickFile() { fileInput.click(); }
  function firstImage(list) {
    for (var i = 0; list && i < list.length; i++) {
      if (list[i] && list[i].type && list[i].type.indexOf('image/') === 0) return list[i];
    }
    return null;
  }
  function wire() {
    drop.addEventListener('click', pickFile);
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
    });
    newBtn.addEventListener('click', pickFile);
    fileInput.addEventListener('change', function () {
      var f = firstImage(fileInput.files);
      if (f) loadFile(f);
      else if (fileInput.files && fileInput.files.length) toast('that is not an image', 'warn');
      fileInput.value = '';
    });

    // a pointer-made ratio pick hands the keyboard back to the box (arrows nudge, not re-pick);
    // keyboard navigation of the closed <select> keeps working as usual
    ratioSel.addEventListener('pointerdown', function () { ratioByPointer = true; });
    ratioSel.addEventListener('keydown', function () { ratioByPointer = false; });
    ratioSel.addEventListener('change', function () {
      onRatioPick();
      if (ratioByPointer) { ratioByPointer = false; focusBox(); }
    });
    swapBtn.addEventListener('click', function (e) { swapOrientation(); if (e.detail) focusBox(); });
    resetBtn.addEventListener('click', function (e) { resetBox(); if (e.detail) focusBox(); });

    sizesRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-out]');
      if (!b) return;
      outPref[Geo.baseKey(ratioKey)] = b.dataset.out;
      saveOutput();                                 // output only — never persists a sender's ratio hint
      var had = sizesRow.contains(document.activeElement);
      buildChips();
      // the rebuild removed the focused chip: keep focus on the picked one (not <body>, where enter downloads)
      if (had) { var again = sizesRow.querySelector('[data-out="' + b.dataset.out + '"]'); if (again) again.focus(); }
      needPrev = true; flush();
    });
    // arrow keys inside the size radiogroup
    sizesRow.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var chips = Array.prototype.slice.call(sizesRow.querySelectorAll('[data-out]'));
      var i = chips.indexOf(document.activeElement);
      if (i === -1) return;
      e.preventDefault();
      var n = chips[(i + (e.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length];
      n.click();
      var again = sizesRow.querySelector('[data-out="' + n.dataset.out + '"]');
      if (again) again.focus();
    });

    nameIn.addEventListener('input', function () { nameDirty = !!nameIn.value.trim(); });
    nameIn.addEventListener('blur', function () { if (!nameIn.value.trim()) { nameDirty = false; syncName(); } });
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) download(); } });

    dlBtn.addEventListener('click', download);
    copyBtn.addEventListener('click', copyOut);
    toUpdateBtn.addEventListener('click', function () { sendTo('update'); });
    toFpBtn.addEventListener('click', function () { sendTo('frontpage'); });

    // crop interaction (pointer events: mouse, touch, pen)
    ui.addEventListener('pointerdown', onDown);
    ui.addEventListener('pointermove', onMove);
    ui.addEventListener('pointerup', onUp);
    ui.addEventListener('pointercancel', onUp);
    ui.addEventListener('lostpointercapture', onUp);
    boxEl.addEventListener('dblclick', function (e) {
      if (e.target.closest('.cr-h')) return;
      e.preventDefault();
      resetBox();
    });
    boxEl.addEventListener('dragstart', function (e) { e.preventDefault(); });
    // the focus ring is for keyboard users only: on when tabbed to (Tab's keyup lands on the box), off on blur
    boxEl.addEventListener('keyup', function (e) { if (e.key === 'Tab') boxEl.classList.add('is-kbd'); });
    boxEl.addEventListener('blur', function () { boxEl.classList.remove('is-kbd'); });
    document.addEventListener('keydown', onModKey);
    document.addEventListener('keyup', onModKey);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', function () { if (drag) onUp(); });

    // relayout: stage resize (rAF-throttled) and tool show (sizes were 0 while hidden)
    if (window.ResizeObserver) {
      new ResizeObserver(function () { needLayout = true; schedule(); }).observe(view);
    } else {
      window.addEventListener('resize', function () { needLayout = true; schedule(); });
    }
    document.addEventListener('hub:show', function (e) {
      if (e && e.detail && e.detail.tool === TOOL) { needLayout = needPrev = true; flush(); }
      else if (toastEl) { clearTimeout(toastTimer); toastEl.classList.remove('visible'); }   // toast lives on <body> → hide it when leaving crop
    });
    document.addEventListener('hub:receive', function (e) {
      var d = e && e.detail;
      if (d && d.target === TOOL) drainInbox();
    });

    // paste / drop — only while crop is the active tool, never while typing
    document.addEventListener('paste', function (e) {
      if (!isActive() || isTextField(e.target)) return;    // a focused ratio <select> still takes a paste
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          var f = it.getAsFile();
          if (f) { e.preventDefault(); loadFile(f); return; }
        }
      }
    });
    var dragDepth = 0;
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
    }
    document.addEventListener('dragover', function (e) { if (isActive() && hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!isActive()) return;
      e.preventDefault();
      dragDepth = 0; stage.classList.remove('drag-over');
      var f = firstImage(e.dataTransfer && e.dataTransfer.files);
      if (f && e.target && e.target.closest && e.target.closest('#tool-crop')) loadFile(f);
      else if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && !f) toast('that is not an image', 'warn');
    });
    stage.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; dragDepth++; stage.classList.add('drag-over'); });
    stage.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) stage.classList.remove('drag-over'); });
  }

  /* ---------- init ---------- */
  function init() {
    root = $('tool-crop');
    if (!root) return;
    stage = $('cr-stage'); view = $('cr-view'); drop = $('cr-drop');
    frame = $('cr-frame'); imgEl = $('cr-img'); shade = $('cr-shade');
    ui = $('cr-ui'); boxEl = $('cr-box'); badge = $('cr-badge');
    bar = $('cr-bar'); ratioSel = $('cr-ratio'); swapBtn = $('cr-swap'); resetBtn = $('cr-reset'); newBtn = $('cr-new');
    fileInput = $('cr-file'); infoEl = $('cr-info');
    prevWrap = $('cr-preview'); prevCanvas = $('cr-prev-canvas'); prevEmpty = $('cr-prev-empty');
    outSizeEl = $('cr-out-size'); upEl = $('cr-up'); sizesRow = $('cr-sizes'); nameIn = $('cr-name');
    dlBtn = $('cr-download'); copyBtn = $('cr-copy'); toUpdateBtn = $('cr-to-update'); toFpBtn = $('cr-to-frontpage');
    toastEl = $('cr-toast');
    // position:fixed inside the section is pinned to the section, not the viewport (the .tool
    // animation's `both` fill keeps a transform on it) → hand the toast to <body>
    if (toastEl && toastEl.parentNode !== document.body) document.body.appendChild(toastEl);
    var required = [stage, view, drop, frame, imgEl, shade, ui, boxEl, badge, bar, ratioSel, swapBtn, resetBtn, newBtn,
      fileInput, infoEl, prevWrap, prevCanvas, prevEmpty, outSizeEl, upEl, sizesRow, nameIn, dlBtn, copyBtn,
      toUpdateBtn, toFpBtn];
    for (var i = 0; i < required.length; i++) if (!required[i]) return;

    loadPrefs();
    showStage(false);
    setRatio(ratioKey, true);
    syncOutput();
    wire();
    drainInbox();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
