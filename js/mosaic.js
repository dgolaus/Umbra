/* =========================================================================
   TOOL 2 · MOSAIC — Roblox grid generator
   Ported verbatim from dgolaus/Mosaic. The ONLY changes vs upstream:
     · document-level listeners (paste / keydown / dragover / drop) are
       guarded by Hub.isActive('mosaic') so they don't fire from other tools
     · upstream's bundled smooth-scroll IIFE is removed (hub.js provides it)
   All features preserved: formats, ratios, gap, drag/drop/paste, reorder,
   filters, auto-arrange, presets, undo/redo (40), IndexedDB, PNG export.
   ========================================================================= */
(function() {
  'use strict';

  var mosaicActive = function () { return !window.Hub || Hub.isActive('mosaic'); };

  const state = {
    cols: 3, rows: 3,
    ratioW: 16, ratioH: 9,
    gap: 4,
    rounded: false,
    filters: { saturate: false, contrast: false, vignette: false },
    images: [],
    exportRes: 1920
  };

  let imgIdCounter = 0;
  const newId = () => 'img_' + (++imgIdCounter);

  const $ = (id) => document.getElementById(id);
  const formatButtons = $('formatButtons');
  const ratioButtons  = $('ratioButtons');
  const filterButtons = $('filterButtons');
  const presetRow     = $('presetRow');
  const gridPreview   = $('gridPreview');
  const gridSizeHint  = $('gridSizeHint');
  const dropzone      = $('mosaicDropzone');
  const fileInput     = $('mosaicFileInput');
  const gapSlider     = $('gapSlider');
  const gapValue      = $('gapValue');
  const roundedToggle = $('roundedToggle');
  const loadedCount   = $('loadedCount');
  const totalSlots    = $('totalSlots');
  const cacheHint     = $('cacheHint');
  const downloadBtn   = $('downloadBtn');
  const clearBtn      = $('clearBtn');
  const shareBtn      = $('shareBtn');
  const savePresetBtn = $('savePresetBtn');
  const exportResSel  = $('exportRes');
  const autoArrangeBtn= $('autoArrangeBtn');
  const toast         = $('mosaicToast');

  if (!gridPreview) return;

  const totalCells = () => state.cols * state.rows;

  // ====== TOAST ======
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
  }

  // ====== INDEXEDDB ======
  const DB_NAME = 'thumbgrid';
  const STORE   = 'kv';

  function dbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function idbPut(key, val) {
    try {
      const db = await dbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (e) {}
  }
  async function idbGet(key) {
    try {
      const db = await dbOpen();
      const val = await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
      db.close();
      return val;
    } catch (e) { return null; }
  }

  function serializeState() {
    return {
      cols: state.cols, rows: state.rows,
      ratioW: state.ratioW, ratioH: state.ratioH,
      gap: state.gap, rounded: state.rounded,
      filters: { ...state.filters },
      exportRes: state.exportRes,
      images: state.images.map(i => i ? { id: i.id, dataUrl: i.dataUrl } : null)
    };
  }
  async function deserializeAndApply(saved) {
    if (!saved) return;
    state.cols     = saved.cols     ?? 3;
    state.rows     = saved.rows     ?? 3;
    state.ratioW   = saved.ratioW   ?? 16;
    state.ratioH   = saved.ratioH   ?? 9;
    state.gap      = saved.gap      ?? 4;
    state.rounded  = !!saved.rounded;
    state.filters  = Object.assign({ saturate:false, contrast:false, vignette:false }, saved.filters || {});
    state.exportRes = saved.exportRes ?? 1920;
    const items = await Promise.all((saved.images || []).map(s => {
      if (!s) return null;
      return new Promise((res) => {
        const img = new Image();
        img.onload  = () => res({ img, dataUrl: s.dataUrl, id: s.id });
        img.onerror = () => res(null);
        img.src = s.dataUrl;
      });
    }));
    state.images = items;
    state.images.forEach(it => {
      if (!it) return;
      const n = parseInt(String(it.id).replace('img_', ''), 10);
      if (!isNaN(n) && n > imgIdCounter) imgIdCounter = n;
    });
  }
  let saveTimer = null;
  function saveStateDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => idbPut('state', serializeState()), 250);
  }

  // ====== UNDO/REDO ======
  const history = { past: [], future: [], MAX: 40 };
  function snapshot() {
    return {
      cols: state.cols, rows: state.rows,
      ratioW: state.ratioW, ratioH: state.ratioH,
      gap: state.gap, rounded: state.rounded,
      filters: { ...state.filters },
      exportRes: state.exportRes,
      images: state.images.slice()
    };
  }
  function restore(snap) {
    state.cols = snap.cols; state.rows = snap.rows;
    state.ratioW = snap.ratioW; state.ratioH = snap.ratioH;
    state.gap = snap.gap; state.rounded = snap.rounded;
    state.filters = { ...snap.filters };
    state.exportRes = snap.exportRes;
    state.images = snap.images.slice();
    syncUIFromState();
    syncGrid();
    saveStateDebounced();
  }
  function pushHistory() {
    history.past.push(snapshot());
    if (history.past.length > history.MAX) history.past.shift();
    history.future.length = 0;
  }
  function undo() {
    if (history.past.length === 0) return;
    history.future.push(snapshot());
    restore(history.past.pop());
    showToast('undone');
  }
  function redo() {
    if (history.future.length === 0) return;
    history.past.push(snapshot());
    restore(history.future.pop());
    showToast('redone');
  }
  function commit(mutate) {
    pushHistory(); mutate(); syncGrid(); saveStateDebounced();
  }

  // ====== RENDER ======
  function ensureImagesCapacity() {
    const n = totalCells();
    while (state.images.length < n) state.images.push(null);
  }
  function createSlot(index) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.index = String(index);
    return slot;
  }
  function updateSlot(slot, index) {
    const item = state.images[index];
    const currentId = slot.dataset.imageId || '';
    const newIdVal = item ? item.id : '';
    slot.dataset.index = String(index);
    slot.style.borderRadius = state.rounded ? '6px' : '0';
    if (currentId === newIdVal) return;
    slot.dataset.imageId = newIdVal;
    slot.innerHTML = '';
    slot.classList.toggle('has-image', !!item);
    slot.draggable = !!item;
    if (item) {
      const img = document.createElement('img');
      img.src = item.dataUrl; img.alt = '';
      slot.appendChild(img);
      const rm = document.createElement('button');
      rm.className = 'slot-remove';
      rm.textContent = '×';
      rm.title = 'remover esta imagem';
      slot.appendChild(rm);
    } else {
      slot.textContent = String(index + 1).padStart(2, '0');
    }
  }
  function syncGrid() {
    ensureImagesCapacity();
    // grid aspect baseada em cols/rows/ratio — permite que preview-wrap encaixe perfeito
    const aspect = (state.cols * state.ratioW) / (state.rows * state.ratioH);
    gridPreview.style.setProperty('--grid-aspect', aspect);
    gridPreview.style.gridTemplateColumns = `repeat(${state.cols}, 1fr)`;
    gridPreview.style.gridTemplateRows    = `repeat(${state.rows}, 1fr)`;
    gridPreview.style.gap = state.gap + 'px';

    const needed = totalCells();
    while (gridPreview.children.length > needed) gridPreview.removeChild(gridPreview.lastChild);
    while (gridPreview.children.length < needed) gridPreview.appendChild(createSlot(gridPreview.children.length));
    for (let i = 0; i < needed; i++) updateSlot(gridPreview.children[i], i);

    totalSlots.textContent = String(needed);
    gridSizeHint.textContent = `${state.cols}×${state.rows} · ${state.ratioW}:${state.ratioH}`;
    updateCounter();
    updateFiltersClass();
  }
  function updateCounter() {
    const n = totalCells();
    const visible = state.images.slice(0, n).filter(x => x !== null).length;
    const hidden  = state.images.slice(n).filter(x => x !== null).length;
    loadedCount.textContent = String(visible);
    if (hidden > 0) {
      cacheHint.textContent = `+${hidden} em cache`;
      cacheHint.classList.add('visible');
    } else {
      cacheHint.classList.remove('visible');
      cacheHint.textContent = '';
    }
    downloadBtn.disabled = visible === 0;
    autoArrangeBtn.disabled = visible < 2;
  }
  function updateFiltersClass() {
    const f = [];
    if (state.filters.saturate) f.push('saturate(1.35)');
    if (state.filters.contrast) f.push('contrast(1.12)');
    gridPreview.style.setProperty('--img-filter', f.join(' ') || 'none');
    gridPreview.classList.toggle('vignette-on', !!state.filters.vignette);
  }
  function syncUIFromState() {
    document.querySelectorAll('#formatButtons .chip').forEach(b => {
      const active = parseInt(b.dataset.cols,10) === state.cols && parseInt(b.dataset.rows,10) === state.rows;
      b.classList.toggle('active', active);
    });
    document.querySelectorAll('#ratioButtons .chip').forEach(b => {
      const active = parseInt(b.dataset.rw,10) === state.ratioW && parseInt(b.dataset.rh,10) === state.ratioH;
      b.classList.toggle('active', active);
    });
    document.querySelectorAll('#filterButtons .chip').forEach(b => {
      b.classList.toggle('active', !!state.filters[b.dataset.filter]);
    });
    gapSlider.value = String(state.gap);
    gapValue.textContent = state.gap + 'px';
    roundedToggle.checked = state.rounded;
    exportResSel.value = String(state.exportRes);
  }

  // ====== FILE LOADING ======
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) return reject(new Error('not image'));
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload  = () => resolve({ img, dataUrl: e.target.result, id: newId() });
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function loadFileToSlot(file, index) {
    fileToImage(file).then((item) => { commit(() => { state.images[index] = item; }); }).catch(() => {});
  }
  function loadFilesFromIndex(files, startIndex) {
    const arr = Array.from(files).filter(f => f.type && f.type.startsWith('image/'));
    const max = Math.min(arr.length, totalCells() - startIndex);
    if (max <= 0) return;
    Promise.all(arr.slice(0, max).map(fileToImage)).then((items) => {
      commit(() => { items.forEach((item, k) => { state.images[startIndex + k] = item; }); });
      if (items.length > 1) showToast(`${items.length} images added`);
    }).catch(() => {});
  }
  function loadFilesBulk(files) {
    const arr = Array.from(files).filter(f => f.type && f.type.startsWith('image/'));
    if (arr.length === 0) return;
    const emptyIdx = [];
    for (let i = 0; i < totalCells() && emptyIdx.length < arr.length; i++) {
      if (!state.images[i]) emptyIdx.push(i);
    }
    if (emptyIdx.length === 0) { showToast('grid full — increase the format or clear'); return; }
    Promise.all(arr.slice(0, emptyIdx.length).map(fileToImage)).then((items) => {
      commit(() => { items.forEach((item, k) => { state.images[emptyIdx[k]] = item; }); });
      if (items.length > 1) showToast(`${items.length} images added`);
    }).catch(() => {});
  }
  function moveItem(from, to) {
    if (from === to) return;
    const n = totalCells();
    const visible = state.images.slice(0, n);
    const cached  = state.images.slice(n);
    const item = visible[from];
    visible.splice(from, 1);
    visible.splice(to, 0, item);
    state.images = visible.concat(cached);
  }

  // ====== GRID EVENTS ======
  gridPreview.addEventListener('click', (e) => {
    const rm = e.target.closest('.slot-remove');
    if (rm) {
      e.stopPropagation();
      const slot = rm.closest('.slot');
      const idx = parseInt(slot.dataset.index, 10);
      commit(() => { state.images[idx] = null; });
      return;
    }
    const slot = e.target.closest('.slot');
    if (!slot) return;
    const idx = parseInt(slot.dataset.index, 10);
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) loadFileToSlot(f, idx); });
    input.click();
  });
  gridPreview.addEventListener('dragstart', (e) => {
    const slot = e.target.closest('.slot'); if (!slot) return;
    const idx = parseInt(slot.dataset.index, 10);
    if (!state.images[idx]) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', String(idx));
    e.dataTransfer.effectAllowed = 'move';
    slot.classList.add('dragging');
  });
  gridPreview.addEventListener('dragend', (e) => {
    const slot = e.target.closest('.slot'); if (slot) slot.classList.remove('dragging');
  });
  gridPreview.addEventListener('dragover', (e) => {
    const slot = e.target.closest('.slot'); if (!slot) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move'; } catch(_) {}
    slot.classList.add('drag-over');
  });
  gridPreview.addEventListener('dragleave', (e) => {
    const slot = e.target.closest('.slot'); if (!slot) return;
    if (!slot.contains(e.relatedTarget)) slot.classList.remove('drag-over');
  });
  gridPreview.addEventListener('drop', (e) => {
    const slot = e.target.closest('.slot'); if (!slot) return;
    e.preventDefault(); e.stopPropagation();
    slot.classList.remove('drag-over');
    const idx = parseInt(slot.dataset.index, 10);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files).filter(f => f.type && f.type.startsWith('image/'));
      if (files.length === 1)      loadFileToSlot(files[0], idx);
      else if (files.length > 1)   loadFilesFromIndex(files, idx);
      return;
    }
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIdx) && fromIdx !== idx) commit(() => moveItem(fromIdx, idx));
  });

  // ====== CONTROLS ======
  formatButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    commit(() => {
      state.cols = parseInt(btn.dataset.cols, 10);
      state.rows = parseInt(btn.dataset.rows, 10);
    });
    document.querySelectorAll('#formatButtons .chip').forEach(b => b.classList.toggle('active', b === btn));
  });
  ratioButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    commit(() => {
      state.ratioW = parseInt(btn.dataset.rw, 10);
      state.ratioH = parseInt(btn.dataset.rh, 10);
    });
    document.querySelectorAll('#ratioButtons .chip').forEach(b => b.classList.toggle('active', b === btn));
  });
  filterButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    const key = btn.dataset.filter;
    commit(() => { state.filters[key] = !state.filters[key]; });
    btn.classList.toggle('active', state.filters[key]);
  });

  gapSlider.addEventListener('input', (e) => {
    state.gap = parseInt(e.target.value, 10);
    gapValue.textContent = state.gap + 'px';
    gridPreview.style.gap = state.gap + 'px';
  });
  let gapSnapshot = null;
  gapSlider.addEventListener('pointerdown', () => { gapSnapshot = state.gap; });
  gapSlider.addEventListener('pointerup', () => {
    if (gapSnapshot !== null && gapSnapshot !== state.gap) {
      const before = snapshot();
      before.gap = gapSnapshot;
      history.past.push(before);
      if (history.past.length > history.MAX) history.past.shift();
      history.future.length = 0;
      saveStateDebounced();
    }
    gapSnapshot = null;
  });

  roundedToggle.addEventListener('change', (e) => { commit(() => { state.rounded = e.target.checked; }); });
  exportResSel.addEventListener('change', () => { state.exportRes = parseInt(exportResSel.value, 10); saveStateDebounced(); });

  // ====== DROPZONE ======
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { loadFilesBulk(e.target.files); fileInput.value = ''; });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', (e) => { if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('drag-over'); });
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); loadFilesBulk(e.dataTransfer.files); });
  document.addEventListener('dragover', (e) => { if (!mosaicActive()) return; e.preventDefault(); });
  document.addEventListener('drop',     (e) => { if (!mosaicActive()) return; e.preventDefault(); });

  // ====== CLIPBOARD ======
  document.addEventListener('paste', (e) => {
    if (!mosaicActive()) return;
    const items = e.clipboardData && e.clipboardData.items; if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile(); if (f) files.push(f);
      }
    }
    if (files.length > 0) { e.preventDefault(); loadFilesBulk(files); if (files.length === 1) showToast('image pasted'); }
  });

  // ====== KEYBOARD ======
  document.addEventListener('keydown', (e) => {
    if (!mosaicActive()) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
    else if ((meta && e.shiftKey && (e.key === 'Z' || e.key === 'z')) || (meta && (e.key === 'y' || e.key === 'Y'))) { e.preventDefault(); redo(); }
  });

  // ====== CLEAR ======
  clearBtn.addEventListener('click', () => {
    const hadAny = state.images.some(x => x !== null);
    commit(() => { state.images = []; });
    if (hadAny) showToast('grid and cache cleared');
  });

  // ====== PRESETS ======
  const DEFAULT_PRESET = {
    cols: 3, rows: 3, ratioW: 16, ratioH: 9,
    gap: 4, rounded: false,
    filters: { saturate:false, contrast:false, vignette:false },
    exportRes: 1920
  };
  let userPresets = [];

  async function loadPresets() {
    const saved = await idbGet('presets');
    userPresets = Array.isArray(saved) ? saved : [];
    renderPresets();
  }
  async function savePresets() { await idbPut('presets', userPresets); }

  function applyPresetSettings(s) {
    commit(() => {
      state.cols = s.cols; state.rows = s.rows;
      state.ratioW = s.ratioW; state.ratioH = s.ratioH;
      state.gap = s.gap; state.rounded = s.rounded;
      state.filters = { ...s.filters };
      state.exportRes = s.exportRes ?? state.exportRes;
    });
    syncUIFromState();
  }

  function renderPresets() {
    const keep = new Set();
    presetRow.querySelectorAll('.chip').forEach(c => {
      if (c.hasAttribute('data-preset-default') || c.id === 'savePresetBtn') keep.add(c);
    });
    Array.from(presetRow.children).forEach(c => { if (!keep.has(c)) c.remove(); });

    userPresets.forEach((p, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.userPreset = String(i);
      chip.title = `${p.settings.cols}×${p.settings.rows} · ${p.settings.ratioW}:${p.settings.ratioH} · gap ${p.settings.gap}px`;
      chip.appendChild(document.createTextNode(p.name));
      const del = document.createElement('span');
      del.className = 'chip-delete';
      del.textContent = '×';
      del.title = 'remover preset';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        userPresets.splice(i, 1);
        await savePresets();
        renderPresets();
      });
      chip.appendChild(del);
      presetRow.insertBefore(chip, savePresetBtn);
    });
  }

  presetRow.addEventListener('click', (e) => {
    const def = e.target.closest('[data-preset-default]');
    if (def) { applyPresetSettings(DEFAULT_PRESET); showToast('default preset applied'); return; }
    const up = e.target.closest('[data-user-preset]');
    if (up && !e.target.classList.contains('chip-delete')) {
      const i = parseInt(up.dataset.userPreset, 10);
      const p = userPresets[i];
      if (p) { applyPresetSettings(p.settings); showToast(`preset "${p.name}" applied`); }
    }
  });

  savePresetBtn.addEventListener('click', async () => {
    const name = (prompt('preset name:') || '').trim().toLowerCase();
    if (!name) return;
    userPresets.push({
      name,
      settings: {
        cols: state.cols, rows: state.rows,
        ratioW: state.ratioW, ratioH: state.ratioH,
        gap: state.gap, rounded: state.rounded,
        filters: { ...state.filters },
        exportRes: state.exportRes
      }
    });
    await savePresets();
    renderPresets();
    showToast('preset saved');
  });

  // ====== SHARE ======
  function buildShareUrl() {
    const cfg = {
      c: state.cols, r: state.rows,
      rw: state.ratioW, rh: state.ratioH,
      g: state.gap, rd: state.rounded ? 1 : 0,
      f: (state.filters.saturate?1:0) | (state.filters.contrast?2:0) | (state.filters.vignette?4:0),
      e: state.exportRes
    };
    const enc = btoa(JSON.stringify(cfg)).replace(/=+$/, '');
    return `${location.origin}${location.pathname}#cfg=${enc}`;
  }
  function applyShareFromHash() {
    if (!location.hash.startsWith('#cfg=')) return false;
    try {
      const raw = location.hash.slice(5);
      const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
      const cfg = JSON.parse(atob(padded));
      state.cols = cfg.c ?? state.cols; state.rows = cfg.r ?? state.rows;
      state.ratioW = cfg.rw ?? state.ratioW; state.ratioH = cfg.rh ?? state.ratioH;
      state.gap = cfg.g ?? state.gap; state.rounded = !!cfg.rd;
      state.filters.saturate = !!(cfg.f & 1);
      state.filters.contrast = !!(cfg.f & 2);
      state.filters.vignette = !!(cfg.f & 4);
      state.exportRes = cfg.e ?? state.exportRes;
      history.past.length = 0; history.future.length = 0;
      window.history.replaceState(null, '', location.pathname);
      return true;
    } catch (e) { return false; }
  }
  shareBtn.addEventListener('click', async () => {
    const url = buildShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      showToast('link copied — settings only, no images');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showToast('link copied — settings only, no images');
    }
  });

  // ====== AUTO-ORDENAR ======
  const _scoreCanvas = document.createElement('canvas');
  _scoreCanvas.width = 128; _scoreCanvas.height = 128;
  const _scoreCtx = _scoreCanvas.getContext('2d', { willReadFrequently: true });

  function scoreImage(img) {
    const SIZE = 128;
    _scoreCtx.clearRect(0, 0, SIZE, SIZE);
    _scoreCtx.drawImage(img, 0, 0, SIZE, SIZE);
    const data = _scoreCtx.getImageData(0, 0, SIZE, SIZE).data;
    let sumSat = 0, sumBri = 0, sumLum = 0, sumLumSq = 0;
    let centerMass = 0, edgeMass = 0;
    const colors = new Set();
    const halfSize = SIZE / 2;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i+1], b = data[i+2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const bri = (r + g + b) / 3 / 255;
      sumSat += sat; sumBri += bri;
      const lum = 0.299*r + 0.587*g + 0.114*b;
      sumLum += lum; sumLumSq += lum * lum;
      const px = p % SIZE, py = (p / SIZE) | 0;
      const dx = (px - halfSize) / halfSize;
      const dy = (py - halfSize) / halfSize;
      const distSq = dx*dx + dy*dy;
      if (distSq < 0.16) centerMass += sat;
      else if (distSq > 0.49) edgeMass += sat;
      colors.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5));
    }
    const n = SIZE * SIZE;
    const avgSat = sumSat / n;
    const avgBri = sumBri / n;
    const meanLum = sumLum / n;
    const variance = Math.max(0, sumLumSq / n - meanLum * meanLum);
    const stdDev = Math.sqrt(variance);
    const contrast = Math.min(1, stdDev / 80);
    const briBalance = 1 - Math.min(1, Math.abs(avgBri - 0.55) * 2);
    const totalMass = centerMass + edgeMass;
    const centerFocus = totalMass > 0 ? centerMass / totalMass : 0.5;
    const variety = Math.min(1, colors.size / 220);
    return 0.30 * avgSat + 0.25 * contrast + 0.15 * centerFocus + 0.15 * variety + 0.15 * briBalance;
  }

  async function autoArrange() {
    const n = totalCells();
    const visible = state.images.slice(0, n);
    const cached  = state.images.slice(n);
    autoArrangeBtn.disabled = true;
    const originalText = autoArrangeBtn.textContent;
    autoArrangeBtn.textContent = 'analyzing…';
    await new Promise(r => requestAnimationFrame(r));
    const scored = visible.map((item, idx) => ({ item, idx, score: item ? scoreImage(item.img) : -Infinity }));
    scored.sort((a, b) => b.score - a.score);
    const changed = scored.some((s, i) => s.idx !== i);
    autoArrangeBtn.textContent = originalText;
    if (!changed) { updateCounter(); showToast('already in the best order'); return; }
    const sortedVisible = scored.map(s => s.item);
    commit(() => { state.images = sortedVisible.concat(cached); });
    updateCounter();
    const filledCount = scored.filter(s => s.score > -Infinity).length;
    showToast(`${filledCount} thumbs reordered by engagement`);
  }
  autoArrangeBtn.addEventListener('click', autoArrange);

  // ====== EXPORT ======
  downloadBtn.addEventListener('click', exportPng);
  function exportPng() {
    const targetW = state.exportRes;
    const previewSlot = gridPreview.querySelector('.slot');
    const previewW = previewSlot ? previewSlot.getBoundingClientRect().width : 200;
    const denom = state.cols + (state.gap * (state.cols - 1)) / Math.max(previewW, 1);
    const cellW = Math.round(targetW / denom);
    const cellH = Math.round(cellW * state.ratioH / state.ratioW);
    const scale = cellW / Math.max(previewW, 1);
    const gapPx    = Math.round(state.gap * scale);
    const radiusPx = state.rounded ? Math.round(6 * scale) : 0;
    const totalW = cellW * state.cols + gapPx * (state.cols - 1);
    const totalH = cellH * state.rows + gapPx * (state.rows - 1);
    const canvas = document.createElement('canvas');
    canvas.width  = totalW; canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, totalW, totalH);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const f = [];
    if (state.filters.saturate) f.push('saturate(1.35)');
    if (state.filters.contrast) f.push('contrast(1.12)');
    const filterStr = f.join(' ');
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const idx = r * state.cols + c;
        const item = state.images[idx];
        if (!item) continue;
        const x = c * (cellW + gapPx);
        const y = r * (cellH + gapPx);
        ctx.save();
        if (radiusPx > 0) { roundRectPath(ctx, x, y, cellW, cellH, radiusPx); ctx.clip(); }
        else { ctx.beginPath(); ctx.rect(x, y, cellW, cellH); ctx.clip(); }
        if (filterStr) ctx.filter = filterStr;
        drawCover(ctx, item.img, x, y, cellW, cellH);
        ctx.filter = 'none';
        if (state.filters.vignette) {
          const cx = x + cellW/2, cy = y + cellH/2;
          const ri = Math.min(cellW, cellH) * 0.35;
          const ro = Math.max(cellW, cellH) * 0.75;
          const grad = ctx.createRadialGradient(cx, cy, ri, cx, cy, ro);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(0,0,0,0.5)');
          ctx.fillStyle = grad; ctx.fillRect(x, y, cellW, cellH);
        }
        ctx.restore();
      }
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mosaic-${state.cols}x${state.rows}-${state.exportRes}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`png saved · ${totalW}×${totalH}`);
    }, 'image/png');
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function drawCover(ctx, img, dx, dy, dw, dh) {
    const ir = img.width / img.height;
    const dr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else         { sw = img.width;  sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // ====== INIT ======
  (async function init() {
    const sharedApplied = applyShareFromHash();
    const saved = await idbGet('state');
    if (saved && !sharedApplied) { await deserializeAndApply(saved); }
    else if (sharedApplied && saved) { await deserializeAndApply(saved); applyShareFromHash(); }
    await loadPresets();
    syncUIFromState();
    syncGrid();
  })();
})();
