/* =========================================================================
   TOOL 1 · UPDATE ICON — countdown-overlay generator for Roblox game icons
   Vanilla JS, native canvas. Unlimited uploads · per-icon countdown text ·
   live global style · duplicate/copy/download · ZIP export · presets.
   Self-contained IIFE. Global listeners guarded by Hub.isActive('update').
   ========================================================================= */
(function () {
  'use strict';

  /* ---------- config ---------- */
  var DEFAULTS = { darkness: 50, hgSize: 100, hgPosY: 0, textSize: 18, textPosY: 12, outline: false, outlineW: 1 };
  var VARIANTS = ['24 HOURS', '12 HOURS', '5 HOURS', '3 HOURS', '2 HOURS', '1 HOUR', '45 MINS', '30 MINS', '15 MINS', 'NOW!'];
  var PREVIEW = 340;          // longest preview edge (px)
  var NATIVE_CAP = 4096;      // safety cap on export resolution
  var LS_STYLE = 'ui.style', LS_PRESETS = 'ui.presets';

  /* ---------- state ---------- */
  var style = Object.assign({}, DEFAULTS);
  var icons = [];
  var presets = [];
  var idc = 0;
  var newId = function () { return 'ic_' + (++idc); };

  // rovisuals' actual hourglass glyph (embedded as a data URI — file://-safe)
  var hgImg = new Image();
  var hgReady = false;

  /* ---------- refs (filled on init) ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var gallery, emptyEl, countEl, dropzone, fileInput, presetRow, savePresetBtn,
      dlAllBtn, clearBtn, outlineToggle, toastEl, prefixEl;

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

  /* full composite (used at both preview + native resolution).
     Mirrors rovisuals' exact pipeline: draw image → darken → hourglass PNG
     into a square (min(W,H)*size%) centred + H*posY% offset, outline via
     8-way black shadow stamps → bold Arial text at H*(0.75 + posY%),
     black strokeText then white fillText. */
  function composite(ctx, icon, W, H) {
    ctx.clearRect(0, 0, W, H);
    drawCover(ctx, icon.img, 0, 0, W, H);

    // darkened background
    if (style.darkness > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + (style.darkness / 100) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    var ow = style.outline ? Math.max(1, Math.round(H * (style.outlineW / 100))) : 0;

    // hourglass — real rovisuals glyph, full image into a centred square
    if (hgReady && style.hgSize > 0) {
      var e = Math.min(W, H) * (style.hgSize / 100);
      var hx = (W - e) / 2;
      var hy = (H - e) / 2 + H * (style.hgPosY / 100);
      if (ow > 0) {
        var off = [[-ow, 0], [ow, 0], [0, -ow], [0, ow], [-ow, -ow], [ow, -ow], [-ow, ow], [ow, ow]];
        ctx.shadowColor = 'black'; ctx.shadowBlur = 0;
        for (var k = 0; k < off.length; k++) {
          ctx.shadowOffsetX = off[k][0]; ctx.shadowOffsetY = off[k][1];
          ctx.drawImage(hgImg, hx, hy, e, e);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
      ctx.drawImage(hgImg, hx, hy, e, e);
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
  }

  /* ---------- upload ---------- */
  function fileToIcon(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        return reject(new Error('not image'));
      }
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          resolve({ id: newId(), img: img, dataUrl: e.target.result, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, text: 'NOW!' });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
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
    var copy = { id: newId(), img: src.img, dataUrl: src.dataUrl, w: src.w, h: src.h, text: nextVariant(src.text) };
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
      var copy = { id: newId(), img: src.img, dataUrl: src.dataUrl, w: src.w, h: src.h, text: VARIANTS[k] };
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
  function fileName(icon, i) {
    var cd = (icon.text || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('ICON-' + (i + 1));
    var prefix = prefixEl ? prefixEl.value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') : '';
    var base = prefix ? (prefix + '_' + cd) : ('update-icon-' + cd);
    return uniqueName(base) + '.png';
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
  function downloadIcon(id) {
    var icon = findIcon(id);
    if (!icon) return;
    canvasBlob(renderNative(icon)).then(function (blob) {
      if (!blob) return;
      triggerDownload(URL.createObjectURL(blob), fileName(icon, indexOfIcon(id)), true);
      toast('saved · ' + icon.w + '×' + icon.h);
    });
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

  /* ---------- bulk ---------- */
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // download every icon as a separate png (no zip). the browser asks once to
  // allow multiple downloads, then it stays silent for the session.
  function downloadAll() {
    if (!icons.length) { toast('no icons loaded'); return; }
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
    chain.then(function () { toast(icons.length + ' icons downloaded'); });
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
    if (dlAllBtn) dlAllBtn.disabled = icons.length === 0;
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
  }
  function saveStyle() { try { localStorage.setItem(LS_STYLE, JSON.stringify(style)); } catch (e) {} }
  function loadStyle() {
    try {
      var raw = localStorage.getItem(LS_STYLE);
      if (!raw) return;
      var s = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) { if (s[k] != null) style[k] = s[k]; });
    } catch (e) {}
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
      else if (act === 'del') deleteIcon(id);
      else if (act === 'set') generateSet(id);
    });
    gallery.addEventListener('input', function (e) {
      var inp = e.target.closest('.text-input'); if (!inp) return;
      var card = inp.closest('.icon-card'); if (!card) return;
      var icon = findIcon(card.dataset.id);
      if (icon) { icon.text = inp.value; renderPreview(icon); }
    });

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
    dlAllBtn.addEventListener('click', downloadAll);
    clearBtn.addEventListener('click', clearAll);

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
    if (!gallery) return;

    hgImg.onload = function () { hgReady = true; renderAll(); };
    if (window.__HOURGLASS_DATAURI) hgImg.src = window.__HOURGLASS_DATAURI;

    loadStyle();
    loadPresets();
    syncControls();
    renderPresetChips();
    wire();
    refreshState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
