/* =========================================================================
   TOOL 1 · UPDATE ICON — countdown-overlay generator for Roblox game icons
   Vanilla JS, native canvas. Unlimited uploads · per-icon countdown text ·
   live global style · duplicate/copy/download · export to downloads or a
   chosen folder, as pngs or one .zip (js/umbra-zip.js) · presets ·
   custom overlay · auto 1:1 crop (draggable focus) · send to frontpage ·
   receives icons from crop (Hub inbox).
   Self-contained IIFE. Global listeners guarded by Hub.isActive('update').
   ========================================================================= */
(function () {
  'use strict';

  /* ---------- config ---------- */
  var DEFAULTS = { darkness: 50, hgSize: 100, hgPosY: 0, textSize: 18, textPosY: 12, outline: false, outlineW: 1, overlay: 'hourglass' };
  var VARIANTS = ['24 HOURS', '12 HOURS', '5 HOURS', '3 HOURS', '2 HOURS', '1 HOUR', '45 MINS', '30 MINS', '15 MINS', 'NOW!'];
  var PREVIEW = 340;          // longest preview edge (px)
  var NATIVE_CAP = 4096;      // safety cap on export resolution
  var CROP_TOL = 0.02;        // |aspect - 1| above this → auto square crop
  var LS_STYLE = 'ui.style', LS_PRESETS = 'ui.presets', LS_OVERLAY = 'ui.overlay';
  var LS_SAVETO = 'ui.saveTo', LS_FORMAT = 'ui.saveFormat';   // save prefs: never part of presets / #cfg=
  var IDB_NAME = 'umbra-update-icon', IDB_STORE = 'kv', IDB_DIR_KEY = 'saveDir';

  /* ---------- state ---------- */
  var style = Object.assign({}, DEFAULTS);
  var icons = [];
  var presets = [];
  var idc = 0;
  var newId = function () { return 'ic_' + (++idc); };

  // rovisuals' actual hourglass glyph (embedded as a data URI — file://-safe)
  var hgImg = new Image();
  var hgReady = false;

  // user overlay (png / svg / webp) — replaces the hourglass when style.overlay === 'custom'
  var customImg = null, customUrl = null;

  /* ---------- refs (filled on init) ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var gallery, emptyEl, countEl, dropzone, fileInput, presetRow, savePresetBtn,
      dlAllBtn, clearBtn, outlineToggle, toastEl, prefixEl,
      overlayRow, overlayFile,
      saveToRow, formatRow, folderRow, folderNameEl, folderBtn;

  var SLIDERS = [
    { id: 'ui-darkness', key: 'darkness', fmt: function (v) { return v + '%'; } },
    { id: 'ui-hgsize',   key: 'hgSize',   fmt: function (v) { return v + '%'; } },
    { id: 'ui-hgposy',   key: 'hgPosY',   fmt: signed },
    { id: 'ui-textsize', key: 'textSize', fmt: function (v) { return v + '%'; } },
    { id: 'ui-textposy', key: 'textPosY', fmt: signed },
    { id: 'ui-outlinew', key: 'outlineW', fmt: function (v) { return v + '%'; } }
  ];
  function signed(v) { return (v > 0 ? '+' : '') + v + '%'; }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, 1900);
  }

  /* ---------- drawing ---------- */
  function drawCover(ctx, img, dx, dy, dw, dh) {
    var ir = img.width / img.height, dr = dw / dh, sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else         { sw = img.width;  sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // largest square of the source, centred on the focus point, clamped inside
  function cropRect(icon) {
    var s = Math.min(icon.sw, icon.sh);
    return {
      x: clamp(icon.fx * icon.sw - s / 2, 0, icon.sw - s),
      y: clamp(icon.fy * icon.sh - s / 2, 0, icon.sh - s),
      s: s
    };
  }

  // overlay to draw: custom image (contain-fit) or the rovisuals hourglass (fills e×e)
  function overlaySource() {
    if (style.overlay === 'custom' && customImg) return { img: customImg, contain: true };
    if (hgReady) return { img: hgImg, contain: false };
    return null;
  }

  /* full composite (used at both preview + native resolution).
     Mirrors rovisuals' exact pipeline: draw image → darken → hourglass PNG
     into a square (min(W,H)*size%) centred + H*posY% offset, outline via
     8-way black shadow stamps → bold Arial text at H*(0.75 + posY%),
     black strokeText then white fillText. A custom overlay goes through the
     same square, object-fit contain. Cropped icons draw their square crop. */
  function composite(ctx, icon, W, H) {
    ctx.clearRect(0, 0, W, H);
    if (icon.crop) {
      var r = cropRect(icon);
      ctx.drawImage(icon.img, r.x, r.y, r.s, r.s, 0, 0, W, H);
    } else {
      drawCover(ctx, icon.img, 0, 0, W, H);
    }

    // darkened background
    if (style.darkness > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + (style.darkness / 100) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    var ow = style.outline ? Math.max(1, Math.round(H * (style.outlineW / 100))) : 0;

    // hourglass — real rovisuals glyph, full image into a centred square
    var ov = overlaySource();
    if (ov && style.hgSize > 0) {
      var e = Math.min(W, H) * (style.hgSize / 100);
      var hx = (W - e) / 2;
      var hy = (H - e) / 2 + H * (style.hgPosY / 100);
      var dx = hx, dy = hy, dw = e, dh = e;
      if (ov.contain) {
        var nw = ov.img.naturalWidth || ov.img.width, nh = ov.img.naturalHeight || ov.img.height;
        if (nw > 0 && nh > 0) {
          if (nw >= nh) { dh = e * nh / nw; dy = hy + (e - dh) / 2; }
          else          { dw = e * nw / nh; dx = hx + (e - dw) / 2; }
        }
      }
      try {
        if (ow > 0) {
          var off = [[-ow, 0], [ow, 0], [0, -ow], [0, ow], [-ow, -ow], [ow, -ow], [-ow, ow], [ow, ow]];
          ctx.shadowColor = 'black'; ctx.shadowBlur = 0;
          for (var k = 0; k < off.length; k++) {
            ctx.shadowOffsetX = off[k][0]; ctx.shadowOffsetY = off[k][1];
            ctx.drawImage(ov.img, dx, dy, dw, dh);
          }
          ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        }
        ctx.drawImage(ov.img, dx, dy, dw, dh);
      } catch (err) {
        // e.g. an svg without intrinsic size in some browsers — skip the overlay
        ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
    }

    // countdown text — bold Arial, baseline at H*(0.75 + textPosY%), below the glyph
    var text = (icon.text || '').trim().toUpperCase();
    if (text) {
      var fpx = Math.max(1, Math.round(H * (style.textSize / 100)));
      ctx.font = 'bold ' + fpx + 'px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var ty = H * (0.75 + style.textPosY / 100);
      if (ow > 0) {
        ctx.strokeStyle = 'black'; ctx.lineWidth = ow; ctx.lineJoin = 'round';
        ctx.strokeText(text, W / 2, ty);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(text, W / 2, ty);
    }
  }

  function previewSize(icon) {
    var ar = icon.w / icon.h, W, H;
    if (ar >= 1) { W = PREVIEW; H = Math.round(PREVIEW / ar); }
    else         { H = PREVIEW; W = Math.round(PREVIEW * ar); }
    return { W: Math.max(1, W), H: Math.max(1, H) };
  }

  function renderPreview(icon) {
    var s = previewSize(icon);
    if (icon.canvas.width !== s.W) icon.canvas.width = s.W;
    if (icon.canvas.height !== s.H) icon.canvas.height = s.H;
    var ctx = icon.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    composite(ctx, icon, s.W, s.H);
  }

  var renderRaf = null;
  function renderAll() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(function () {
      renderRaf = null;
      for (var i = 0; i < icons.length; i++) renderPreview(icons[i]);
    });
  }

  function renderNative(icon) {
    var W = icon.w, H = icon.h;
    var mx = Math.max(W, H);
    if (mx > NATIVE_CAP) { var k = NATIVE_CAP / mx; W = Math.round(W * k); H = Math.round(H * k); }
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    composite(ctx, icon, W, H);
    return c;
  }

  /* ---------- icon SVG glyphs ---------- */
  function svg(paths) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
           'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }
  var GLYPH = {
    dup:  svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    copy: svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>'),
    dl:   svg('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>'),
    fp:   svg('<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
    del:  svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>')
  };

  /* ---------- cards ---------- */
  function findIcon(id) {
    for (var i = 0; i < icons.length; i++) if (icons[i].id === id) return icons[i];
    return null;
  }
  function indexOfIcon(id) {
    for (var i = 0; i < icons.length; i++) if (icons[i].id === id) return i;
    return -1;
  }

  function buildCard(icon) {
    if (!icon.canvas) icon.canvas = document.createElement('canvas');

    var card = document.createElement('div');
    card.className = 'icon-card glass glass--track';
    card.dataset.id = icon.id;

    var wrap = document.createElement('div');
    wrap.className = 'icon-canvas-wrap';
    wrap.appendChild(icon.canvas);
    if (icon.crop) {
      // crop-x / crop-y: the crop only pans on one axis. vertical page scroll stays free on touch;
      // tall (crop-y) previews reframe on touch through the badge handle (see cropDown)
      wrap.classList.add('is-crop', icon.sw > icon.sh ? 'crop-x' : 'crop-y');
      wrap.title = 'auto-cropped to 1:1 · drag to reframe · double-click to recenter';
      var badge = document.createElement('span');
      badge.className = 'ui-crop-badge';
      badge.textContent = '1:1 · drag';
      wrap.appendChild(badge);
    }

    var input = document.createElement('input');
    input.className = 'text-input';
    input.type = 'text';
    input.value = icon.text;
    input.placeholder = 'countdown text…';
    input.spellcheck = false;
    input.maxLength = 24;
    icon.input = input;

    var actions = document.createElement('div');
    actions.className = 'icon-actions';
    actions.innerHTML =
      '<button class="ibtn" data-act="dup"  title="duplicate (next variant)">' + GLYPH.dup + '</button>' +
      '<button class="ibtn" data-act="copy" title="copy to clipboard">' + GLYPH.copy + '</button>' +
      '<button class="ibtn" data-act="dl"   title="download png (native res)">' + GLYPH.dl + '</button>' +
      '<button class="ibtn" data-act="fp"   title="→ frontpage (use as game icon)">' + GLYPH.fp + '</button>' +
      '<button class="ibtn danger" data-act="del" title="delete">' + GLYPH.del + '</button>';

    var setBtn = document.createElement('button');
    setBtn.className = 'ibtn-wide';
    setBtn.dataset.act = 'set';
    setBtn.title = 'turn this image into the full countdown set (24h → now)';
    setBtn.textContent = 'generate countdown set';

    card.appendChild(wrap);
    card.appendChild(input);
    card.appendChild(actions);
    card.appendChild(setBtn);
    icon.card = card;
    return card;
  }

  function addIconObject(obj, beforeCard) {
    icons.splice(beforeCard ? indexOfIcon(beforeCard.dataset.id) + 1 : icons.length, 0, obj);
    var card = buildCard(obj);
    if (beforeCard && beforeCard.nextSibling) gallery.insertBefore(card, beforeCard.nextSibling);
    else gallery.appendChild(card);
    renderPreview(obj);
    refreshState();
    return card;
  }

  /* ---------- upload ---------- */
  // sw/sh = source size; w/h = output size (the square side when auto-cropped;
  // renderNative still applies NATIVE_CAP). fx/fy = crop focus, 0..1.
  function makeIcon(img, dataUrl, sw, sh, text, fx, fy) {
    var crop = sw > 0 && sh > 0 && Math.abs(sw / sh - 1) > CROP_TOL;
    var side = Math.min(sw, sh);
    return {
      id: newId(), img: img, dataUrl: dataUrl, sw: sw, sh: sh,
      w: crop ? side : sw, h: crop ? side : sh,
      crop: crop, fx: fx == null ? 0.5 : fx, fy: fy == null ? 0.5 : fy,
      text: text
    };
  }
  function cloneIcon(src, text) { return makeIcon(src.img, src.dataUrl, src.sw, src.sh, text, src.fx, src.fy); }

  // one decode path for dropped / picked / pasted files and images received from other tools:
  // same default text, same auto square-crop rules (makeIcon), same rendering (addIconObject)
  function dataUrlToIcon(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(makeIcon(img, dataUrl, img.naturalWidth || img.width, img.naturalHeight || img.height, 'NOW!'));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function fileToIcon(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        return reject(new Error('not image'));
      }
      var reader = new FileReader();
      reader.onload = function (e) { dataUrlToIcon(e.target.result).then(resolve, reject); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function addFiles(fileList) {
    var arr = Array.prototype.filter.call(fileList || [], function (f) { return f.type && f.type.indexOf('image/') === 0; });
    if (!arr.length) return;
    Promise.all(arr.map(function (f) {
      return fileToIcon(f).catch(function () { return null; });
    })).then(function (items) {
      var added = 0;
      items.forEach(function (it) { if (it) { addIconObject(it); added++; } });
      if (added > 0) toast(added + (added === 1 ? ' icon loaded' : ' icons loaded'));
    });
  }

  /* ---------- receiving from other tools (Hub.send → 'update') ----------
     crop's "→ update icon" sends { kind: 'icon', dataUrl, name, source: 'crop' }. each payload with a
     data:image/ dataUrl becomes a new card through the same path a dropped file takes. `name` is
     ignored: the card text is the countdown overlay, never a file name. queued payloads are added in
     send order, and drains are chained so a later one can't overtake an earlier one still decoding. */
  var recvChain = Promise.resolve();
  function sourceLabel(src) {
    if (src === 'update') return 'update icon';
    return src ? String(src) : 'another tool';
  }
  // Hub.switchTo resets the page to the top; below 860px the gallery sits under every control
  // section, so a received card would land screens below the fold. bring it into view — only
  // for received payloads (dropped files land where the user already is) and only while update
  // icon is the visible tool.
  function revealCard(card) {
    if (!card || !card.isConnected) return;
    var tool = card.closest('.tool');
    if (tool && !tool.classList.contains('is-active')) return;
    var r = card.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top >= 0 && r.bottom <= vh) return;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { card.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' }); }
    catch (e) { card.scrollIntoView(); }
  }
  function drainInbox() {
    if (!gallery || !window.Hub || typeof Hub.takeInbox !== 'function') return;
    var items;
    try { items = Hub.takeInbox('update'); } catch (e) { items = null; }
    if (!Array.isArray(items) || !items.length) return;
    var valid = items.filter(function (p) {
      return p && typeof p.dataUrl === 'string' && p.dataUrl.indexOf('data:image/') === 0;
    });
    if (!valid.length) return;
    recvChain = recvChain.then(function () {
      // decode in parallel, add in order (like addFiles)
      return Promise.all(valid.map(function (p) {
        return dataUrlToIcon(p.dataUrl).catch(function () { return null; });
      })).then(function (made) {
        var added = 0, from = null, firstCard = null;
        made.forEach(function (it, k) {
          if (!it) return;
          var card = addIconObject(it);
          if (!firstCard) firstCard = card;
          added++;
          var f = sourceLabel(valid[k].source);
          from = (from === null || from === f) ? f : 'other tools';
        });
        if (!added) { toast('could not read the received image'); return; }
        toast(added === 1 ? 'icon received from ' + from : added + ' icons received from ' + from);
        revealCard(firstCard);
      });
    }).catch(function () {});
  }

  /* ---------- per-icon ops ---------- */
  function nextVariant(curr) {
    var up = (curr || '').trim().toUpperCase();
    var i = VARIANTS.indexOf(up);
    if (i === -1) return VARIANTS[0];
    return VARIANTS[(i + 1) % VARIANTS.length];
  }
  function duplicateIcon(id) {
    var src = findIcon(id);
    if (!src) return;
    var copy = cloneIcon(src, nextVariant(src.text));
    addIconObject(copy, src.card);
    toast('duplicated → "' + copy.text + '"');
  }
  function generateSet(id) {
    var src = findIcon(id);
    if (!src) return;
    src.text = VARIANTS[0];
    if (src.input) src.input.value = VARIANTS[0];
    renderPreview(src);
    var afterCard = src.card;
    for (var k = 1; k < VARIANTS.length; k++) {
      var copy = cloneIcon(src, VARIANTS[k]);
      addIconObject(copy, afterCard);
      afterCard = copy.card;
    }
    toast('generated ' + VARIANTS.length + '-icon countdown set');
  }
  function deleteIcon(id) {
    var idx = indexOfIcon(id);
    if (idx === -1) return;
    var icon = icons[idx];
    if (icon.card && icon.card.parentNode) icon.card.parentNode.removeChild(icon.card);
    icons.splice(idx, 1);
    refreshState();
  }
  // per-session download-name registry so repeats get _2, _3… and windows never
  // prompts to replace. sessionStorage → resets when the tab closes.
  function uniqueName(base) {
    var key = 'ui.dlnames', map;
    try { map = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch (e) { map = {}; }
    var n = (map[base] || 0) + 1;
    map[base] = n;
    try { sessionStorage.setItem(key, JSON.stringify(map)); } catch (e) {}
    return n === 1 ? base : base + '_' + n;
  }
  function sanitizedPrefix() {
    return prefixEl ? prefixEl.value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') : '';
  }
  // per-icon base name (no extension, no dedup): <prefix>_<CD> · update-icon-<CD> · ICON-n fallback
  function baseName(icon, i) {
    var cd = (icon.text || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('ICON-' + (i + 1));
    var prefix = sanitizedPrefix();
    return prefix ? (prefix + '_' + cd) : ('update-icon-' + cd);
  }
  // downloads mode: predicts the browser's Downloads collisions via the session registry
  function fileName(icon, i) {
    return uniqueName(baseName(icon, i)) + '.png';
  }
  function zipBase() { return sanitizedPrefix() || 'update-icons'; }
  // folder mode only: chromium's file system access api rejects names that downloads
  // silently fix (format chars like ZWJ, other control chars, a leading '~', 8.3-style
  // '~' names, windows device names) with TypeError "Name is not allowed."
  var FORMAT_CHARS = (function () {
    try { return new RegExp('[\\p{Cf}\\p{Cc}\\p{Noncharacter_Code_Point}]', 'gu'); }
    catch (e) { return /[\x00-\x1f\x7f-\x9f­؀-؅؜۝܏࣢᠎​-‏‪-‮⁠-⁤⁦-⁯﷐-﷯﻿￹-￻￾￿]/g; }
  })();
  function folderSafe(base, fallback) {
    var b = String(base).replace(FORMAT_CHARS, '').replace(/^[~_]+/, '');
    if (b.length <= 12) b = b.replace(/~/g, '_');
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9]|clock\$|conin\$|conout\$)(\.|$)/i.test(b)) b = b.replace(/^[^.]*/, '$&_');
    return b || fallback;
  }
  // dedup inside one set of names (zip entries) — case-insensitive like windows
  function uniqueInSet(base, ext, used) {
    var n = 1, name = base + ext;
    while (used[name.toLowerCase()]) { n++; name = base + '_' + n + ext; }
    used[name.toLowerCase()] = true;
    return name;
  }

  /* ---------- save destination: a folder (File System Access API) ---------- */
  var folderSupported = typeof window.showDirectoryPicker === 'function';
  var NO_FOLDER_MSG = 'this browser cannot pick folders — use chrome, edge or opera (brave: turn on brave://flags/#file-system-access-api)';
  var saveTo = 'downloads', saveFormat = 'png';
  var dirHandle = null;                       // FileSystemDirectoryHandle
  var dirReady = Promise.resolve();           // resolves once the stored handle is loaded
  var busy = false;                           // a save is running → ignore more save clicks

  var idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexeddb'));
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb open failed')); };
      req.onblocked = function () { reject(new Error('idb blocked')); };
    });
    idbP.catch(function () { idbP = null; });
    return idbP;
  }
  function kv(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, req;
        try { tx = db.transaction(IDB_STORE, mode); req = fn(tx.objectStore(IDB_STORE)); }
        catch (e) { return reject(e); }
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('idb tx failed')); };
      });
    });
  }
  function kvGet(key) { return kv('readonly', function (s) { return s.get(key); }); }
  function kvSet(key, val) { return kv('readwrite', function (s) { return s.put(val, key); }).catch(function () {}); }
  function kvDel(key) { return kv('readwrite', function (s) { return s.delete(key); }).catch(function () {}); }

  function folderLabel() { return dirHandle ? dirHandle.name : 'folder'; }

  // opens the picker — MUST run inside a click (transient user activation)
  function pickFolder() {
    // `id` makes chromium reopen the last folder picked here; 'downloads' is only the first-time start
    var opts = { id: 'umbra-update-icon', mode: 'readwrite', startIn: dirHandle || 'downloads' };
    var p;
    try { p = window.showDirectoryPicker(opts); } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function (h) {
      dirHandle = h;
      kvSet(IDB_DIR_KEY, h);
      return h;
    }, function (err) {
      if (err && err.name === 'AbortError') toast('no folder chosen');
      else toast('folder picker unavailable here');
      return null;
    });
  }
  function verifyPermission(h) {
    var opts = { mode: 'readwrite' };
    if (typeof h.queryPermission !== 'function') return Promise.resolve(true);
    return Promise.resolve().then(function () { return h.queryPermission(opts); }).then(function (st) {
      if (st === 'granted') return true;
      if (typeof h.requestPermission !== 'function') return false;
      return h.requestPermission(opts).then(function (st2) { return st2 === 'granted'; });
    }).catch(function () { return false; });
  }
  // folder + permission, resolved FIRST in every save click (before any slow work).
  // → handle, or null (cancelled / denied — already toasted).
  function ensureFolder() {
    return dirReady.then(function () {
      if (!dirHandle) {
        return pickFolder().then(function (h) {
          setSaveTo(h ? 'folder' : 'downloads');
          return h;
        });
      }
      return verifyPermission(dirHandle).then(function (ok) {
        if (ok) return dirHandle;
        toast('no permission for ' + dirHandle.name);
        return null;
      });
    });
  }
  function forgetFolder() {
    dirHandle = null;
    kvDel(IDB_DIR_KEY);
    syncSaveUI();
  }
  // the handle is gone / unusable (folder deleted, moved, permission revoked…)
  function isHandleError(err) {
    var n = err && err.name;
    return n === 'NotFoundError' || n === 'InvalidStateError' || n === 'NotAllowedError' ||
           n === 'SecurityError' || n === 'TypeMismatchError' || n === 'NoModificationAllowedError';
  }
  function folderFail(err, saved, total) {
    var tail = total > 1 ? ' · saved ' + saved + '/' + total : '';
    if (isHandleError(err)) {
      var nm = folderLabel();
      forgetFolder();
      toast("can't reach " + nm + ' — choose the folder again' + tail);
    } else if (err && err.code === 'ZIP_LIMIT') {
      toast(err.message);
    } else if (err && err.name === 'TypeError' && /name/i.test(err.message || '')) {
      toast("that file name isn't allowed in folders — change the prefix" + tail);
    } else {
      toast('save failed' + tail);
    }
  }

  // first free name in the folder: base.ext, base_2.ext, … (never overwrites)
  function freeName(dir, base, ext) {
    var n = 1;
    function attempt() {
      var name = n === 1 ? base + ext : base + '_' + n + ext;
      return dir.getFileHandle(name).then(function () {
        n++;
        if (n > 9999) throw new Error('no free file name');
        return attempt();
      }, function (err) {
        if (err && err.name === 'NotFoundError') return name;
        if (err && err.name === 'TypeMismatchError') {   // a sub-folder with that name
          n++;
          if (n > 9999) throw new Error('no free file name');
          return attempt();
        }
        throw err;
      });
    }
    return attempt();
  }
  // `name` comes from freeName (it didn't exist), so on any failure after
  // creation the empty file is ours to remove — no 0-byte exports left behind
  function writeFile(dir, name, blob) {
    var created = false;
    return dir.getFileHandle(name, { create: true }).then(function (fh) {
      created = true;
      return fh.createWritable();
    }).then(function (w) {
      return Promise.resolve(w.write(blob)).then(function () { return w.close(); }, function (err) {
        var a;
        try { a = w.abort && w.abort(); } catch (e) {}
        // wait for the abort so the file's write lock is gone before removeEntry
        return Promise.resolve(a).catch(function () {}).then(function () { throw err; });
      });
    }).catch(function (err) {
      var rm = Promise.resolve();
      if (created && typeof dir.removeEntry === 'function') {
        rm = Promise.resolve().then(function () { return dir.removeEntry(name); }).catch(function () {});
      }
      return rm.then(function () { throw err; });
    });
  }
  // sequential writes. jobs: [{ base, ext, blob: () => Promise<Blob|null> }]
  // → { saved, names, error } — never rejects, so the UI can't get stuck.
  function writeJobs(dir, jobs, onProgress) {
    var saved = 0, names = [], k = 0;
    function next() {
      if (k >= jobs.length) return Promise.resolve({ saved: saved, names: names, error: null });
      var job = jobs[k++];
      if (onProgress) onProgress(k, jobs.length);
      return Promise.resolve().then(job.blob).then(function (blob) {
        if (!blob) return null;
        return freeName(dir, job.base, job.ext).then(function (name) {
          return writeFile(dir, name, blob).then(function () { saved++; names.push(name); });
        });
      }).then(next);
    }
    return next().catch(function (err) { return { saved: saved, names: names, error: err || new Error('write failed') }; });
  }
  function canvasBlob(canvas) {
    return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/png'); });
  }
  function triggerDownload(url, name, revoke) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function blobBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }
  function useFolder() { return folderSupported && saveTo === 'folder'; }

  // per-card download: always a single png; honours "save to"
  function downloadIcon(id) {
    var icon = findIcon(id);
    if (!icon) return;
    if (useFolder()) { saveIconToFolder(icon); return; }
    canvasBlob(renderNative(icon)).then(function (blob) {
      if (!blob) return;
      triggerDownload(URL.createObjectURL(blob), fileName(icon, indexOfIcon(id)), true);
      toast('saved · ' + icon.w + '×' + icon.h);
    });
  }
  function saveIconToFolder(icon) {
    if (busy) return;
    setBusy(true);
    // folder + permission first (needs the click's user activation), then render
    ensureFolder().then(function (dir) {
      if (!dir) return;
      var base = folderSafe(baseName(icon, indexOfIcon(icon.id)), 'update-icon');
      return writeJobs(dir, [{ base: base, ext: '.png', blob: function () { return canvasBlob(renderNative(icon)); } }])
        .then(function (r) {
          if (r.error) folderFail(r.error, r.saved, 1);
          else if (r.saved) toast('saved ' + r.names[0] + ' → ' + dir.name);
          else toast('could not export this icon');
        });
    }).catch(function (err) { folderFail(err, 0, 1); })
      .then(function () { setBusy(false); });
  }
  function copyIcon(id) {
    var icon = findIcon(id);
    if (!icon) return;
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('clipboard image not supported — use download'); return;
    }
    canvasBlob(renderNative(icon)).then(function (blob) {
      if (!blob) return;
      navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
        .then(function () { toast('copied to clipboard'); })
        .catch(function () { toast('copy failed — use download'); });
    });
  }
  // hand the native-res composite to the frontpage mock as the game icon
  function sendToFrontpage(id) {
    var icon = findIcon(id);
    if (!icon) return;
    if (!window.Hub || !Hub.send) { toast('frontpage not available'); return; }
    var dataUrl;
    try { dataUrl = renderNative(icon).toDataURL('image/png'); }
    catch (e) { toast('could not export this icon'); return; }
    // no `name`: icon.text is the countdown overlay ('NOW!', '24 HOURS'…), never a game name
    Hub.send('frontpage', { kind: 'icon', dataUrl: dataUrl, source: 'update' });
  }

  /* ---------- crop focus (drag on a cropped preview) ---------- */
  var drag = null, dragRaf = null;
  function cropDown(e) {
    if (e.button != null && e.button !== 0) return;
    var wrap = e.target.closest('.icon-canvas-wrap'); if (!wrap) return;
    var card = wrap.closest('.icon-card'); if (!card) return;
    var icon = findIcon(card.dataset.id);
    if (!icon || !icon.crop) return;
    // touch on a tall crop: a swipe on the preview scrolls the page (touch-action
    // pan-y), only the badge handle reframes. wide crops drag sideways anywhere.
    if (e.pointerType === 'touch' && icon.sw <= icon.sh && !e.target.closest('.ui-crop-badge')) return;
    e.preventDefault();
    var r = cropRect(icon);
    var shown = icon.canvas.getBoundingClientRect().width || 1;
    drag = {
      icon: icon, wrap: wrap, pid: e.pointerId, x: e.clientX, y: e.clientY,
      cx: r.x + r.s / 2, cy: r.y + r.s / 2,   // current crop centre in source px
      k: r.s / shown                           // source px per screen px
    };
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    wrap.classList.add('is-dragging');
  }
  function cropMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var ic = drag.icon, s = Math.min(ic.sw, ic.sh);
    // content follows the pointer → the crop window moves the other way
    var cx = clamp(drag.cx - (e.clientX - drag.x) * drag.k, s / 2, ic.sw - s / 2);
    var cy = clamp(drag.cy - (e.clientY - drag.y) * drag.k, s / 2, ic.sh - s / 2);
    ic.fx = cx / ic.sw; ic.fy = cy / ic.sh;
    if (!dragRaf) dragRaf = requestAnimationFrame(function () { dragRaf = null; renderPreview(ic); });
  }
  function cropUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    try { drag.wrap.releasePointerCapture(drag.pid); } catch (err) {}
    drag.wrap.classList.remove('is-dragging');
    drag = null;
  }
  function cropReset(e) {
    var wrap = e.target.closest('.icon-canvas-wrap'); if (!wrap) return;
    var card = wrap.closest('.icon-card'); if (!card) return;
    var icon = findIcon(card.dataset.id);
    if (!icon || !icon.crop) return;
    icon.fx = 0.5; icon.fy = 0.5;
    renderPreview(icon);
    toast('crop recentered');
  }

  /* ---------- custom overlay ---------- */
  function isOverlayFile(f) {
    if (!f) return false;
    if (/^image\/(png|webp|svg\+xml)$/.test(f.type || '')) return true;
    return /\.(png|webp|svg)$/i.test(f.name || '');
  }
  // persist=true: freshly uploaded → select it + try to remember it
  function setCustomOverlay(dataUrl, persist) {
    var img = new Image();
    img.onload = function () {
      customImg = img; customUrl = dataUrl;
      if (persist) {
        style.overlay = 'custom';
        saveStyle();
        var kept = true;
        try { localStorage.setItem(LS_OVERLAY, dataUrl); } catch (err) {
          kept = false;
          // a failed write keeps the previous overlay stored; drop it so a reload can't bring it back
          try { localStorage.removeItem(LS_OVERLAY); } catch (e2) {}
        }
        toast(kept ? 'custom overlay set' : 'overlay too big to remember');
      }
      syncOverlay(); renderAll();
    };
    img.onerror = function () { if (persist) toast('could not read that overlay'); };
    img.src = dataUrl;
  }
  function loadOverlayFile(file) {
    if (!isOverlayFile(file)) { toast('overlay must be png, svg or webp'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      var url = String(e.target.result || '');
      // some systems hand svgs over without a mime type
      if (/\.svg$/i.test(file.name || '') && url.indexOf('data:image/svg+xml') !== 0) {
        url = 'data:image/svg+xml;base64,' + url.slice(url.indexOf(',') + 1);
      }
      setCustomOverlay(url, true);
    };
    reader.onerror = function () { toast('could not read that overlay'); };
    reader.readAsDataURL(file);
  }
  function removeCustomOverlay() {
    customImg = null; customUrl = null;
    try { localStorage.removeItem(LS_OVERLAY); } catch (e) {}
    style.overlay = 'hourglass';
    saveStyle(); syncOverlay(); renderAll();
    toast('custom overlay removed');
  }
  function syncOverlay() {
    if (!overlayRow) return;
    var eff = (style.overlay === 'custom' && customImg) ? 'custom' : 'hourglass';
    Array.prototype.forEach.call(overlayRow.querySelectorAll('[data-overlay]'), function (b) {
      b.classList.toggle('active', b.dataset.overlay === eff);
    });
    var chip = overlayRow.querySelector('[data-overlay="custom"]');
    if (!chip) return;
    chip.textContent = '';
    if (customUrl) {
      var th = document.createElement('img');
      th.className = 'ui-ov-thumb'; th.alt = ''; th.src = customUrl;
      chip.appendChild(th);
    }
    chip.appendChild(document.createTextNode('custom'));
    if (customUrl) {
      var del = document.createElement('span');
      del.className = 'chip-delete';
      del.dataset.overlayRemove = '';
      del.textContent = '×';
      del.title = 'remove custom overlay';
      chip.appendChild(del);
    }
    chip.title = customUrl ? 'use your custom overlay' : 'upload a png / svg / webp overlay';
  }

  /* ---------- bulk ---------- */
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // downloads + png: every icon as a separate png. the browser asks once to
  // allow multiple downloads, then it stays silent for the session.
  function downloadAll() {
    if (!icons.length) { toast('no icons loaded'); return; }
    setBusy(true);
    toast('downloading ' + icons.length + ' icons…');
    var chain = Promise.resolve();
    icons.forEach(function (icon, i) {
      chain = chain.then(function () {
        return canvasBlob(renderNative(icon)).then(function (blob) {
          if (blob) triggerDownload(URL.createObjectURL(blob), fileName(icon, i), true);
          return wait(300);
        });
      });
    });
    chain.then(function () { toast(icons.length + ' icons downloaded'); },
               function () { toast('download failed'); })
         .then(function () { setBusy(false); });
  }

  // render every icon → one zip blob (entries deduped inside the zip only)
  function buildZip(list) {
    var used = {}, files = [], chain = Promise.resolve();
    list.forEach(function (it, k) {
      chain = chain.then(function () {
        toast('zipping ' + (k + 1) + '/' + list.length + '…');
        return canvasBlob(renderNative(it.frozen)).then(function (blob) {
          if (!blob) return;
          return blobBytes(blob).then(function (buf) {
            files.push({ name: uniqueInSet(it.base, '.png', used), data: new Uint8Array(buf) });
          });
        });
      });
    });
    return chain.then(function () {
      if (!files.length) throw new Error('nothing rendered');
      return { blob: window.UmbraZip.build(files), count: files.length };
    });
  }
  // names AND text are frozen at click time, so edits made while a save runs
  // can't split a file's name from its pixels (frozen inherits everything else live)
  function snapshot() {
    return icons.map(function (icon, i) {
      var frozen = Object.create(icon);
      frozen.text = icon.text;
      return { icon: icon, frozen: frozen, base: baseName(icon, i) };
    });
  }

  function zipToDownloads() {
    var list = snapshot(), zb = zipBase();
    setBusy(true);
    buildZip(list).then(function (z) {
      var name = uniqueName(zb) + '.zip';
      triggerDownload(URL.createObjectURL(z.blob), name, true);
      toast('downloaded ' + name + ' · ' + z.count + (z.count === 1 ? ' icon' : ' icons'));
    }).catch(function (err) {
      toast(err && err.code === 'ZIP_LIMIT' ? err.message : 'zip failed');
    }).then(function () { setBusy(false); });
  }

  function saveAllToFolder(zip) {
    setBusy(true);
    // folder + permission FIRST (user activation), only then the slow rendering
    ensureFolder().then(function (dir) {
      if (!dir) return;
      var list = snapshot(), zb = folderSafe(zipBase(), 'update-icons');
      if (!list.length) { toast('no icons loaded'); return; }
      if (zip) {
        return buildZip(list).then(function (z) {
          return writeJobs(dir, [{ base: zb, ext: '.zip', blob: function () { return z.blob; } }]).then(function (r) {
            if (r.error) folderFail(r.error, 0, 1);
            else toast('saved ' + r.names[0] + ' → ' + dir.name);
          });
        });
      }
      var jobs = list.map(function (it) {
        return { base: folderSafe(it.base, 'update-icon'), ext: '.png', blob: function () { return canvasBlob(renderNative(it.frozen)); } };
      });
      return writeJobs(dir, jobs, function (k, n) { toast('saving ' + k + '/' + n + '…'); }).then(function (r) {
        if (r.error) folderFail(r.error, r.saved, jobs.length);
        else toast('saved ' + r.saved + (r.saved === 1 ? ' icon' : ' icons') + ' → ' + dir.name);
      });
    }).catch(function (err) { folderFail(err, 0, 1); })
      .then(function () { setBusy(false); });
  }

  // "download all" button: dispatch on save to × format
  function saveAll() {
    if (busy) return;
    if (!icons.length) { toast('no icons loaded'); return; }
    var zip = saveFormat === 'zip';
    if (zip && !window.UmbraZip) { toast('zip unavailable'); return; }
    if (useFolder()) { saveAllToFolder(zip); return; }
    if (zip) { zipToDownloads(); return; }
    downloadAll();
  }

  /* ---------- save options UI ---------- */
  function setBusy(v) {
    busy = !!v;
    if (dlAllBtn) dlAllBtn.disabled = icons.length === 0 || busy;
    if (dlAllBtn) dlAllBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function setSaveTo(v) {
    saveTo = (v === 'folder' && folderSupported) ? 'folder' : 'downloads';
    try { localStorage.setItem(LS_SAVETO, saveTo); } catch (e) {}
    syncSaveUI();
  }
  function setFormat(v) {
    saveFormat = v === 'zip' ? 'zip' : 'png';
    try { localStorage.setItem(LS_FORMAT, saveFormat); } catch (e) {}
    syncSaveUI();
  }
  function loadSavePrefs() {
    var t = null, f = null;
    try { t = localStorage.getItem(LS_SAVETO); f = localStorage.getItem(LS_FORMAT); } catch (e) {}
    saveTo = (t === 'folder' && folderSupported) ? 'folder' : 'downloads';   // unsupported → silent fallback
    saveFormat = f === 'zip' ? 'zip' : 'png';
  }
  function syncRadio(row, attr, val) {
    if (!row) return;
    Array.prototype.forEach.call(row.querySelectorAll('[' + attr + ']'), function (b) {
      var on = b.getAttribute(attr) === val;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function dlAllLabel() {
    var zip = saveFormat === 'zip';
    if (useFolder()) {
      // no folder yet: a short fixed label that fits the 320px sidebar button
      // (ellipsis is only meant for long real folder names)
      if (!dirHandle) return zip ? 'choose folder + zip' : 'choose folder + save';
      return (zip ? 'save .zip → ' : 'save all → ') + dirHandle.name;
    }
    return zip ? 'download .zip' : 'download all';
  }
  function syncSaveUI() {
    syncRadio(saveToRow, 'data-saveto', useFolder() ? 'folder' : 'downloads');
    syncRadio(formatRow, 'data-format', saveFormat);
    if (saveToRow) {
      var fchip = saveToRow.querySelector('[data-saveto="folder"]');
      if (fchip && !folderSupported) { fchip.classList.add('is-unsupported'); fchip.setAttribute('aria-disabled', 'true'); fchip.title = 'your browser cannot pick folders — chrome · edge · opera'; }
    }
    if (folderRow) folderRow.hidden = !useFolder();
    if (folderNameEl) {
      folderNameEl.textContent = dirHandle ? dirHandle.name : 'no folder yet';
      folderNameEl.title = dirHandle ? dirHandle.name : '';
      folderNameEl.classList.toggle('is-empty', !dirHandle);
    }
    if (folderBtn) folderBtn.textContent = dirHandle ? 'change' : 'choose';
    if (dlAllBtn) {
      var label = dlAllLabel();
      dlAllBtn.textContent = label;
      dlAllBtn.title = label;
    }
  }
  function loadFolder() {
    if (!folderSupported) return;
    dirReady = kvGet(IDB_DIR_KEY).then(function (h) {
      if (h && h.kind === 'directory' && typeof h.getFileHandle === 'function') dirHandle = h;
    }).catch(function () {}).then(function () { syncSaveUI(); });
  }
  function chooseFolder() {
    if (busy) return;
    dirReady.then(pickFolder).then(function (h) {
      if (h) { setSaveTo('folder'); toast('saving to ' + h.name); }
      else if (!dirHandle) setSaveTo('downloads');      // cancelled with no folder → downloads
      else { setSaveTo('folder'); toast('saving to ' + dirHandle.name); }   // cancelled → keep the previous folder
    });
  }

  function clearAll() {
    if (!icons.length) return;
    icons.forEach(function (icon) { if (icon.card && icon.card.parentNode) icon.card.parentNode.removeChild(icon.card); });
    icons = [];
    refreshState();
    toast('cleared');
  }

  /* ---------- state / count ---------- */
  function refreshState() {
    if (countEl) countEl.textContent = String(icons.length);
    if (emptyEl) emptyEl.style.display = icons.length ? 'none' : '';
    if (dlAllBtn) dlAllBtn.disabled = icons.length === 0 || busy;
    if (clearBtn) clearBtn.disabled = icons.length === 0;
  }

  /* ---------- style controls ---------- */
  function syncControls() {
    SLIDERS.forEach(function (s) {
      var el = $(s.id), v = $(s.id + '-v');
      if (el) el.value = style[s.key];
      if (v) v.textContent = s.fmt(style[s.key]);
    });
    if (outlineToggle) outlineToggle.checked = style.outline;
    syncOverlay();
  }
  function saveStyle() { try { localStorage.setItem(LS_STYLE, JSON.stringify(style)); } catch (e) {} }
  function loadStyle() {
    try {
      var raw = localStorage.getItem(LS_STYLE);
      if (!raw) return;
      var s = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) { if (s[k] != null) style[k] = s[k]; });
    } catch (e) {}
    if (style.overlay !== 'custom') style.overlay = 'hourglass';
  }
  function loadOverlay() {
    var url = null;
    try { url = localStorage.getItem(LS_OVERLAY); } catch (e) {}
    if (url && url.indexOf('data:image/') === 0) setCustomOverlay(url, false);
  }

  /* ---------- presets ---------- */
  function savePresets() { try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); } catch (e) {} }
  function loadPresets() {
    try { var raw = localStorage.getItem(LS_PRESETS); presets = raw ? JSON.parse(raw) : []; }
    catch (e) { presets = []; }
    if (!Array.isArray(presets)) presets = [];
  }
  function applyStyle(s) {
    Object.keys(DEFAULTS).forEach(function (k) { if (s[k] != null) style[k] = s[k]; });
    if (style.overlay !== 'custom') style.overlay = 'hourglass';
    syncControls(); saveStyle(); renderAll();
  }
  function renderPresetChips() {
    // remove dynamic chips (keep default + save button)
    Array.prototype.slice.call(presetRow.querySelectorAll('[data-user-preset]')).forEach(function (c) { c.remove(); });
    presets.forEach(function (p, i) {
      var chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.userPreset = String(i);
      chip.appendChild(document.createTextNode(p.name));
      var del = document.createElement('span');
      del.className = 'chip-delete';
      del.textContent = '×';
      del.title = 'remove preset';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        presets.splice(i, 1); savePresets(); renderPresetChips();
      });
      chip.appendChild(del);
      presetRow.insertBefore(chip, savePresetBtn);
    });
  }

  /* Inline preset-name entry — replaces window.prompt(), which sandboxed/
     embedded webviews silently block (returns null → save aborts). */
  function beginSavePreset() {
    var existing = presetRow.querySelector('.preset-name-input');
    if (existing) { existing.focus(); return; }
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'text-input preset-name-input';
    inp.placeholder = 'name + enter';
    inp.maxLength = 20;
    inp.spellcheck = false;
    inp.style.width = '130px';
    presetRow.insertBefore(inp, savePresetBtn);
    savePresetBtn.style.display = 'none';
    inp.focus();

    var done = false;
    function finish(commit) {
      if (done) return; done = true;
      var name = (inp.value || '').trim().toLowerCase();
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      savePresetBtn.style.display = '';
      if (commit && name) {
        presets.push({ name: name, style: Object.assign({}, style) });
        savePresets(); renderPresetChips(); toast('preset "' + name + '" saved');
      }
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', function () { finish(true); });
  }

  /* ---------- wiring ---------- */
  function wire() {
    // sliders
    SLIDERS.forEach(function (s) {
      var el = $(s.id), v = $(s.id + '-v');
      if (!el) return;
      el.addEventListener('input', function () {
        style[s.key] = parseInt(el.value, 10);
        if (v) v.textContent = s.fmt(style[s.key]);
        saveStyle(); renderAll();
      });
    });
    // outline
    if (outlineToggle) outlineToggle.addEventListener('change', function () {
      style.outline = outlineToggle.checked; saveStyle(); renderAll();
    });

    // overlay: hourglass | custom (+ upload / remove)
    if (overlayRow) overlayRow.addEventListener('click', function (e) {
      if (e.target.closest('[data-overlay-remove]')) { e.stopPropagation(); removeCustomOverlay(); return; }
      if (e.target.closest('[data-overlay-upload]')) { if (overlayFile) overlayFile.click(); return; }
      var b = e.target.closest('[data-overlay]'); if (!b) return;
      if (b.dataset.overlay === 'custom' && !customImg) { if (overlayFile) overlayFile.click(); return; }
      style.overlay = b.dataset.overlay === 'custom' ? 'custom' : 'hourglass';
      saveStyle(); syncOverlay(); renderAll();
    });
    if (overlayFile) overlayFile.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadOverlayFile(f);
      overlayFile.value = '';
    });

    // dropzone
    dropzone.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (e) { addFiles(e.target.files); fileInput.value = ''; });
    dropzone.addEventListener('dragover', function (e) { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', function (e) { if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('drag-over'); });
    dropzone.addEventListener('drop', function (e) { e.preventDefault(); dropzone.classList.remove('drag-over'); addFiles(e.dataTransfer.files); });

    // gallery delegation: per-icon buttons + text editing
    gallery.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]'); if (!btn) return;
      var card = btn.closest('.icon-card'); if (!card) return;
      var id = card.dataset.id, act = btn.dataset.act;
      if (act === 'dup') duplicateIcon(id);
      else if (act === 'copy') copyIcon(id);
      else if (act === 'dl') downloadIcon(id);
      else if (act === 'fp') sendToFrontpage(id);
      else if (act === 'del') deleteIcon(id);
      else if (act === 'set') generateSet(id);
    });
    gallery.addEventListener('input', function (e) {
      var inp = e.target.closest('.text-input'); if (!inp) return;
      var card = inp.closest('.icon-card'); if (!card) return;
      var icon = findIcon(card.dataset.id);
      if (icon) { icon.text = inp.value; renderPreview(icon); }
    });
    // crop focus: drag a cropped preview to reframe, double-click to recenter
    gallery.addEventListener('pointerdown', cropDown);
    document.addEventListener('pointermove', cropMove);
    document.addEventListener('pointerup', cropUp);
    document.addEventListener('pointercancel', cropUp);
    gallery.addEventListener('dblclick', cropReset);

    // presets
    presetRow.addEventListener('click', function (e) {
      var def = e.target.closest('[data-preset-default]');
      if (def) { applyStyle(DEFAULTS); toast('defaults applied'); return; }
      var up = e.target.closest('[data-user-preset]');
      if (up && !e.target.classList.contains('chip-delete')) {
        var p = presets[parseInt(up.dataset.userPreset, 10)];
        if (p) { applyStyle(p.style); toast('preset "' + p.name + '" applied'); }
      }
    });
    savePresetBtn.addEventListener('click', beginSavePreset);

    // bulk
    dlAllBtn.addEventListener('click', saveAll);
    clearBtn.addEventListener('click', clearAll);

    // save to: downloads | folder (the picker always opens, starting in the last folder)
    if (saveToRow) saveToRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-saveto]'); if (!b || b.disabled) return;
      if (b.dataset.saveto !== 'folder') { setSaveTo('downloads'); return; }
      if (!folderSupported) { toast(NO_FOLDER_MSG); return; }
      chooseFolder();
    });
    if (folderBtn) folderBtn.addEventListener('click', function () { if (folderSupported) chooseFolder(); else toast(NO_FOLDER_MSG); });
    // format: png files | .zip
    if (formatRow) formatRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-format]'); if (!b) return;
      setFormat(b.dataset.format);
    });

    // paste (guarded to this tool)
    document.addEventListener('paste', function (e) {
      if (!window.Hub || !Hub.isActive('update')) return;
      var items = e.clipboardData && e.clipboardData.items; if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) { var f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    // prevent the browser from opening dropped files when update is active
    document.addEventListener('dragover', function (e) { if (window.Hub && Hub.isActive('update')) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (window.Hub && Hub.isActive('update') && !e.target.closest('#ui-dropzone')) e.preventDefault();
    });
  }

  /* ---------- init ---------- */
  function init() {
    gallery       = $('ui-gallery');
    emptyEl       = $('ui-empty');
    countEl       = $('ui-count');
    dropzone      = $('ui-dropzone');
    fileInput     = $('ui-file');
    presetRow     = $('ui-presets');
    savePresetBtn = $('ui-save-preset');
    dlAllBtn      = $('ui-dl-all');
    clearBtn      = $('ui-clear');
    outlineToggle = $('ui-outline');
    toastEl       = $('ui-toast');
    prefixEl      = $('ui-prefix');
    overlayRow    = $('ui-overlay');
    overlayFile   = $('ui-overlay-file');
    saveToRow     = $('ui-saveto');
    formatRow     = $('ui-format');
    folderRow     = $('ui-folder');
    folderNameEl  = $('ui-folder-name');
    folderBtn     = $('ui-folder-change');
    if (!gallery) return;

    hgImg.onload = function () { hgReady = true; renderAll(); };
    if (window.__HOURGLASS_DATAURI) hgImg.src = window.__HOURGLASS_DATAURI;

    loadStyle();
    loadOverlay();
    loadPresets();
    syncControls();
    renderPresetChips();
    loadSavePrefs();
    loadFolder();
    syncSaveUI();
    wire();
    refreshState();

    // hand-offs from other tools: whatever was queued before init, then every later send.
    // hub:show drains too, so anything queued without an event is picked up when update opens.
    drainInbox();
    document.addEventListener('hub:receive', function (e) {
      var d = e && e.detail;
      if (d && d.target === 'update') drainInbox();
    });
    document.addEventListener('hub:show', function (e) {
      var d = e && e.detail;
      if (d && d.tool === 'update') drainInbox();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
