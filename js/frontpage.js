/* =========================================================================
   TOOL 4 · FRONTPAGE — see your thumbnail on a roblox-style front page
   Vanilla JS. Your game (name · rating · players · thumb · icon) is
   dropped among real neighbors from js/feed.js on an ORIGINAL roblox-like
   mock (home · search · charts · desktop / mobile · dark / light · en / pt-br).
   A/B variants · readability tests · png export.
   Self-contained IIFE. Global listeners guarded by Hub.isActive('frontpage').
   Optional deps (all guarded): window.__UMBRA_FEED, UmbraInsights, UmbraPaint,
   Hub.send / Hub.takeInbox / 'hub:receive'. The icon is a center crop of the
   thumbnail until you upload one or frame one in the crop tool (tool 5).
   ========================================================================= */
(function () {
  'use strict';

  /* ---------- connections row manifest ----------
     drop square headshots into assets/frontpage/avatars/ and list them here
     (see the frontpage notes). src: null → generated placeholder; a file that
     fails to load also falls back to the placeholder. */
  var FP_CONNECTIONS = [
    { name: 'pixelnova',  src: null },
    { name: 'kairo_dev',  src: null },
    { name: 'mintleaf',   src: null },
    { name: 'echoblox',   src: null },
    { name: 'lumaa',      src: null },
    { name: 'orbitz',     src: null },
    { name: 'zephyr',     src: null },
    { name: 'cobaltfox',  src: null },
    { name: 'vexed_r',    src: null }
  ];
  var PROFILE = { name: 'S0DA', src: 'assets/frontpage/s0da.png' };

  /* ---------- config ---------- */
  var TOOL = 'frontpage';
  var DB_NAME = 'umbra-frontpage', DB_STORE = 'kv', DB_KEY = 'state';
  var MAX_VARIANTS = 4, LETTERS = ['A', 'B', 'C', 'D'];
  var DEFAULT_NAME = 'Your Game';
  var THUMB_MAX = 1920;     // longest stored edge for thumbnails
  var ICON_MAX = 768;       // longest stored edge for uploaded icons
  var TIGHT_W = 640;        // desktop mock narrower than this drops the sidebar (phone-width stage)
  var POOL_MIN = 40;        // a genre pool smaller than this is topped up from the rest of the feed
  var ICON_PX = 384;        // center-crop icon size
  var DEFAULTS = {
    name: '', creator: 'you', rating: 97, players: '1.2K',
    active: 0, varMode: 'flip',
    // 'auto' = center square crop of each variant's thumbnail · 'upload' = your icon (uploaded or from crop)
    iconMode: 'auto',
    page: 'home', device: 'desktop', theme: 'dark', lang: 'en', sidebar: true, density: 'cozy',
    genre: 'all', seed: 7, slot: 1, chartRow: 0,
    distance: 0, squint: 0, gray: false,
    highlight: true, scale: 2, zoom: '100', zoomV: 2
  };
  var ENUMS = {
    varMode: ['flip', 'spread'], iconMode: ['auto', 'upload'],
    page: ['home', 'search', 'charts'], device: ['desktop', 'mobile'],
    theme: ['dark', 'light'], lang: ['en', 'pt'], density: ['cozy', 'compact'], scale: [1, 2],
    zoom: ['fit', '100']
  };
  /* fit view ("whole screen"): the mock is laid out on a fixed virtual screen and the
     whole thing is scaled to fit the stage. phone = a real 390×844 viewport inside the
     frame chrome (12px padding + 1px border per side, see .fp-device.is-phone) */
  var FIT = { screenW: 1920, screenH: 1080, phoneW: 390, phoneH: 844, phoneChrome: 13, pad: 14, padPhone: 18 };

  /* ---------- mock strings ---------- */
  var STR = {
    en: {
      home: 'Home', charts: 'Charts', market: 'Marketplace', create: 'Create', robux: 'Robux',
      search: 'Search', profile: 'Profile', messages: 'Messages', connections: 'Connections',
      avatar: 'Avatar', inventory: 'Inventory', trade: 'Trade', communities: 'Communities',
      blog: 'Blog', store: 'Official Store', gift: 'Gift Cards', premium: 'Get Premium',
      viewProfile: 'View Profile', connect: 'Connect', seeAll: 'See All',
      rec: 'Recommended For You', cont: 'Continue', results: 'Results for',
      experiences: 'Experiences', people: 'People', device: 'Device', computer: 'Computer', phone: 'Phone',
      country: 'Country', allLoc: 'All Locations', genre: 'Genre', by: 'By',
      chat: 'Chat', more: 'More', trending: 'Top Trending', balance: '1,337'
    },
    pt: {
      home: 'Início', charts: 'Destaques', market: 'Mercado', create: 'Criar', robux: 'Robux',
      search: 'Buscar', profile: 'Perfil', messages: 'Mensagens', connections: 'Conexões',
      avatar: 'Avatar', inventory: 'Inventário', trade: 'Trocas', communities: 'Comunidades',
      blog: 'Blog', store: 'Loja oficial', gift: 'Cartões-presente', premium: 'Obter Premium',
      viewProfile: 'Ver perfil', connect: 'Conectar', seeAll: 'Ver tudo',
      rec: 'Recomendados para você', cont: 'Continuar', results: 'Resultados para',
      experiences: 'Experiências', people: 'Pessoas', device: 'Dispositivo', computer: 'Computador', phone: 'Celular',
      country: 'País', allLoc: 'Todos os locais', genre: 'Gênero', by: 'Por',
      chat: 'Chat', more: 'Mais', trending: 'Em alta', balance: '1.337'
    }
  };

  /* mock palettes — svg glyphs bake these colors in so the export matches the screen
     (keep in sync with the --r-* tokens in css/frontpage.css) */
  var PAL = {
    dark:  { bg: '#111216', top: '#111216', fg: '#f7f7f8', fg2: '#b8bac1', fg3: '#85878f', onPill: '#111216' },
    light: { bg: '#f7f7f8', top: '#ffffff', fg: '#1b1c20', fg2: '#55575e', fg3: '#7c7e85', onPill: '#ffffff' }
  };
  var BLUE = '#3b6cff', RED = '#e0262b';
  var AV_TONES = ['#6b7280', '#7b8494', '#5f6b7a', '#8a8f99', '#707a8a', '#7d7f87', '#666d78'];

  /* ---------- state ---------- */
  var S = clone(DEFAULTS);
  var variants = [];        // { id, dataUrl, url, img, w, h, icon, iconCanvas, name }
  var upIcon = null;        // { dataUrl, img }
  var feed = { games: [], byId: {}, sorts: [], genres: [], generatedAt: null, source: '' };
  var vid = 0;
  var restored = false, activated = false, exporting = false;
  var recvQueue = [];
  var poolCache = null, poolKey = '';
  var statsCache = {};
  var scrollKey = '', lastSig = '', tightNow = false;
  var fitK = null;          // current fit scale (null until the stage has been measured)
  var reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  /* ---------- refs ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var root, stage, stageBody, lens, device, viewport, emptyEl, toastEl, stageLabel, stageVar,
      nameIn, creatorIn, ratingIn, playersIn, dropzone, fileInput,
      iconDrop, iconFile, iconPrev, iconSrc, iconMine, iconRemove, iconCropBtn,
      varRow, varAdd, varFile, varPrev, varNext, varLabel,
      sidebarT, genreSel, shuffleBtn, slotVal, slotReset,
      distIn, distVal, squintIn, squintVal, grayT,
      hlT, exportBtn, copyBtn, fnameEl, feedInfo;

  /* ---------- small helpers ---------- */
  function clone(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function noop() {}
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function isActive() { return !!(window.Hub && typeof Hub.isActive === 'function' && Hub.isActive(TOOL)); }
  function typingIn(t) {
    var tag = t && t.tagName;
    // a focused checkbox / button input never uses ← →, so it must not swallow variant flipping
    if (tag === 'INPUT') return !/^(checkbox|button|submit|reset|file|color|image)$/i.test(t.type || '');
    return tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
  }
  function yourName() { return (S.name || '').trim() || DEFAULT_NAME; }
  function yourCreator() { return (S.creator || '').trim() || 'you'; }

  // mulberry32 — deterministic neighbor order per seed
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, seed) {
    var a = arr.slice(), r = rng(seed);
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // roblox-style abbreviation, truncated (12,37K → 12.3K · pt: 12,3 mil)
  function fmtCount(n) {
    n = Number(n) || 0;
    var pt = S.lang === 'pt';
    var units = pt ? [[1e9, ' bi'], [1e6, ' mi'], [1e3, ' mil']] : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < units.length; i++) {
      if (n >= units[i][0]) {
        var v = n / units[i][0];
        var s = v < 100 ? (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.floor(v));
        if (pt) s = s.replace('.', ',');
        return s + units[i][1];
      }
    }
    return String(Math.round(n));
  }
  // your players text is shown as typed — except in the pt-br mock, where a plain count or an
  // english abbreviation ('1.2K', '40K', '1.5M') follows the neighbours' format ('1,2 mil')
  function yourPlayers() {
    var s = (S.players || '').trim();
    if (!s) return '0';
    if (S.lang !== 'pt') return s;
    var m = /^(\d+(?:\.\d+)?)\s*([kmb])$/i.exec(s) || /^(\d+)()$/.exec(s);
    if (!m) return s;
    return fmtCount(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1));
  }
  function fmtRating(r) { return (r == null || isNaN(r)) ? '--' : Math.round(r) + '%'; }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, 2100);
  }

  /* ---------- indexeddb ---------- */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexeddb'));
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var r = tx.objectStore(DB_STORE).get(key);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      }).then(function (v) { db.close(); return v; }, function (e) { db.close(); throw e; });
    }).catch(function () { return null; });
  }
  function idbPut(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      }).then(function (v) { db.close(); return v; }, function (e) { db.close(); throw e; });
    }).catch(function () { return false; });
  }

  var saveTimer = null, saveWarned = false;
  function save() {
    if (!restored) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      idbPut(DB_KEY, serialize()).then(function (ok) {
        if (!ok && !saveWarned) { saveWarned = true; toast('could not save — storage unavailable'); }
      });
    }, 300);
  }
  function serialize() {
    var o = clone(S);
    o.v = 1;
    o.variants = variants.map(function (v) { return { id: v.id, dataUrl: v.dataUrl, name: v.name || '' }; });
    o.icon = upIcon ? upIcon.dataUrl : null;
    return o;
  }

  /* ---------- feed ---------- */
  function readFeed() {
    var out = { games: [], byId: {}, sorts: [], genres: [], generatedAt: null, source: '' };
    var f = window.__UMBRA_FEED;
    if (!f || typeof f !== 'object' || !f.games || typeof f.games !== 'object') return out;
    try {
      Object.keys(f.games).forEach(function (k) {
        var g = f.games[k];
        if (!g || typeof g !== 'object' || !g.thumb || !g.icon || !g.name) return;
        var id = String(g.id != null ? g.id : k);
        if (out.byId[id]) return;
        out.byId[id] = g;
        out.games.push(g);
      });
      (Array.isArray(f.sorts) ? f.sorts : []).forEach(function (s) {
        if (!s || !Array.isArray(s.gameIds)) return;
        var seen = {}, ids = [];
        s.gameIds.forEach(function (id) {
          var key = String(id);
          if (out.byId[key] && !seen[key]) { seen[key] = 1; ids.push(key); }
        });
        if (ids.length) out.sorts.push({ id: String(s.id || ''), name: String(s.name || s.id || ''), namePt: String(s.namePt || s.name || ''), ids: ids });
      });
      var present = {};
      out.games.forEach(function (g) { if (g.genre) present[g.genre] = 1; });
      (Array.isArray(f.genres) ? f.genres : []).forEach(function (g) {
        if (g && g.id && present[g.id]) out.genres.push({ id: String(g.id), name: String(g.name || g.id), namePt: String(g.namePt || g.name || g.id) });
      });
      out.generatedAt = f.generatedAt || null;
      out.source = f.source || '';
    } catch (e) {
      return { games: [], byId: {}, sorts: [], genres: [], generatedAt: null, source: '' };
    }
    return out;
  }
  function inGenre(g) { return S.genre === 'all' || g.genre === S.genre; }
  function pool() {
    var key = S.seed + '|' + S.genre;
    if (poolCache && poolKey === key) return poolCache;
    var list = feed.games.filter(inGenre);
    if (!list.length) list = feed.games.slice();
    poolCache = shuffled(list, S.seed);
    // small genre (e.g. 1-2 games): genre matches stay first, then the rest of the feed
    // tops the pool up so the grids aren't near-empty or repeating the same game
    if (poolCache.length < POOL_MIN && list.length < feed.games.length) {
      var rest = feed.games.filter(function (g) { return !inGenre(g); });
      poolCache = poolCache.concat(shuffled(rest, (S.seed ^ 0x9e3779b9) >>> 0).slice(0, POOL_MIN - poolCache.length));
    }
    poolKey = key;
    return poolCache;
  }
  function take(list, start, n) {
    var out = [], len = list.length;
    n = Math.min(Math.max(0, n), len);
    for (var i = 0; i < n; i++) out.push(list[(start + i) % len]);
    return out;
  }
  function sortGames(s) {
    var out = [];
    s.ids.forEach(function (id) { var g = feed.byId[id]; if (g && inGenre(g)) out.push(g); });
    return out;
  }
  function sortName(s) { return S.lang === 'pt' ? (s.namePt || s.name) : s.name; }
  function genreName(id) {
    for (var i = 0; i < feed.genres.length; i++) if (feed.genres[i].id === id) return S.lang === 'pt' ? feed.genres[i].namePt : feed.genres[i].name;
    return id;
  }

  /* ---------- images ---------- */
  function loadImg(src) {
    return new Promise(function (res, rej) {
      var i = new Image();
      i.onload = function () { res(i); };
      i.onerror = function () { rej(new Error('decode')); };
      i.src = src;
    });
  }
  function readFile(file) {
    return new Promise(function (res, rej) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return rej(new Error('not image'));
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(file);
    });
  }
  function imageFiles(list) {
    return Array.prototype.filter.call(list || [], function (f) { return f && f.type && f.type.indexOf('image/') === 0; });
  }
  // downscale anything bigger than `max` so stored state stays light
  function normalize(dataUrl, max) {
    return loadImg(dataUrl).then(function (img) {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('empty image');
      var k = Math.min(1, max / Math.max(w, h));
      if (k === 1 && /^data:image\/(png|jpe?g|webp|gif)/i.test(dataUrl)) return { dataUrl: dataUrl, img: img, w: w, h: h };
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      var type = /^data:image\/jpe?g/i.test(dataUrl) ? 'image/jpeg' : 'image/png';
      var out = c.toDataURL(type, 0.92);
      return loadImg(out).then(function (img2) { return { dataUrl: out, img: img2, w: c.width, h: c.height }; });
    });
  }
  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(',');
    var head = dataUrl.slice(5, comma), body = dataUrl.slice(comma + 1);
    var mime = head.split(';')[0] || 'application/octet-stream';
    if (/;base64/i.test(head)) {
      var bin = atob(body), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  function displayUrl(dataUrl) {
    try { return URL.createObjectURL(dataUrlToBlob(dataUrl)); } catch (e) { return dataUrl; }
  }
  function disposeVariant(v) {
    if (v && v.url && v.url.indexOf('blob:') === 0) { try { URL.revokeObjectURL(v.url); } catch (e) {} }
  }

  // plain center square crop (framing it by hand is the crop tool's job)
  function centerCrop(src, w, h, size) {
    var I = window.UmbraInsights;
    if (I && typeof I.squareCrop === 'function') {
      try { var c0 = I.squareCrop(src, 0.5, 0.5, size); if (c0 && c0.width) return c0; } catch (e) {}
    }
    var s = Math.min(w, h);
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    return c;
  }
  // every variant carries its own center-crop icon: the square tiles' silent fallback
  function makeIcon(v) {
    if (!v) return;
    var c = centerCrop(v.img, v.w, v.h, ICON_PX);
    v.iconCanvas = c;
    try { v.icon = c.toDataURL('image/png'); } catch (e) { v.icon = ''; }
  }
  // file name without its image extension ('my thumb.png' → 'my thumb')
  function fileBase(name) {
    return String(name || '').trim().replace(/\.(png|jpe?g|webp|gif|bmp|avif)$/i, '').slice(0, 80);
  }
  function makeVariant(dataUrl, doNormalize, name) {
    var p = doNormalize ? normalize(dataUrl, THUMB_MAX)
      : loadImg(dataUrl).then(function (img) { return { dataUrl: dataUrl, img: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }; });
    return p.then(function (r) {
      if (!r.w || !r.h) throw new Error('empty image');
      var v = { id: 'v' + (++vid), dataUrl: r.dataUrl, url: displayUrl(r.dataUrl), img: r.img, w: r.w, h: r.h, icon: '', iconCanvas: null, name: fileBase(name) };
      makeIcon(v);
      return v;
    });
  }
  function makeIcon2(dataUrl, doNormalize) {
    var p = doNormalize ? normalize(dataUrl, ICON_MAX)
      : loadImg(dataUrl).then(function (img) { return { dataUrl: dataUrl, img: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }; });
    return p.then(function (r) {
      if (!r.w || !r.h) throw new Error('empty image');
      if (Math.abs(r.w / r.h - 1) <= 0.02) return { dataUrl: r.dataUrl, img: r.img };
      var size = Math.min(r.w, r.h, ICON_MAX);
      var c = centerCrop(r.img, r.w, r.h, size);
      var out = c.toDataURL('image/png');
      return loadImg(out).then(function (img2) { return { dataUrl: out, img: img2 }; });
    });
  }

  /* placeholders — UmbraInsights.placeholder when available, local fallback otherwise */
  var phCache = {}, phLocal = {}, phSettled = false;
  // labelled placeholders drawn before JetBrains Mono lands use the fallback font:
  // don't pin those (UmbraInsights skips its own cache for the same reason)
  function phCacheable(label) {
    if (!label || phSettled) return true;
    try { return !document.fonts || document.fonts.check('12px "JetBrains Mono"'); } catch (e) { return true; }
  }
  function ph(w, h, label) {
    var k = w + 'x' + h + ':' + label;
    if (phCache[k]) return phCache[k];
    var I = window.UmbraInsights, url = null;
    if (I && typeof I.placeholder === 'function') { try { url = I.placeholder(w, h, label); } catch (e) { url = null; } }
    if (typeof url === 'string' && url.indexOf('data:') === 0) { if (phCacheable(label)) phCache[k] = url; return url; }
    if (phLocal[k]) return phLocal[k];
    var u = localPh(w, h, label);
    if (phCacheable(label)) phLocal[k] = u;
    return u;
  }
  function refreshPh() { phCache = {}; phLocal = {}; fillMine(); }
  function localPh(w, h, label) {
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var x = c.getContext('2d');
      x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, w, h);
      var g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 1;
      var step = Math.max(12, Math.round(Math.min(w, h) / 8));
      for (var gx = step; gx < w; gx += step) { x.beginPath(); x.moveTo(gx + 0.5, 0); x.lineTo(gx + 0.5, h); x.stroke(); }
      for (var gy = step; gy < h; gy += step) { x.beginPath(); x.moveTo(0, gy + 0.5); x.lineTo(w, gy + 0.5); x.stroke(); }
      if (label) {
        x.fillStyle = '#8a8a8a';
        x.font = '600 ' + Math.round(Math.min(w, h) * 0.075) + "px 'JetBrains Mono', ui-monospace, monospace";
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(label, w / 2, h / 2);
      }
      return c.toDataURL('image/png');
    } catch (e) { return ''; }
  }
  function avatarPh(name) {
    var t = AV_TONES[hash(String(name)) % AV_TONES.length];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect x="34" y="17" width="32" height="30" rx="7" fill="' + t + '"/>' +
      '<path d="M22 100V72a14 14 0 0 1 14-14h28a14 14 0 0 1 14 14v28z" fill="' + t + '"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // your icon (upload / crop) wins over the center crop
  function hasIcon() { return S.iconMode === 'upload' && !!upIcon; }
  function thumbUrl(vi) { var v = variants[vi]; return v ? v.url : ph(768, 432, 'drop your thumbnail'); }
  function iconUrl(vi) {
    if (hasIcon()) return upIcon.dataUrl;
    var v = variants[vi];
    return v && v.icon ? v.icon : ph(256, 256, 'icon');
  }

  /* ---------- glyphs (original inline svg) ---------- */
  var GLY = {
    thumb:   { fill: 1, d: '<path d="M2 10.6A1.6 1.6 0 0 1 3.6 9H6v12H3.6A1.6 1.6 0 0 1 2 19.4z"/><path d="M8 21V9.4l4.2-6.6a1.7 1.7 0 0 1 3.1 1.2L14.7 8H20a2 2 0 0 1 2 2.3l-1.4 8.5A2.6 2.6 0 0 1 18 21z"/>' },
    person:  { fill: 1, d: '<circle cx="12" cy="7.5" r="4.6"/><path d="M3 21.6c0-4.7 4-7.9 9-7.9s9 3.2 9 7.9z"/>' },
    search:  { d: '<circle cx="11" cy="11" r="6.6"/><path d="M16 16l4.6 4.6"/>' },
    bell:    { d: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>' },
    gear:    { d: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M5.5 18.5l1.9-1.9M16.6 7.4l1.9-1.9"/><circle cx="12" cy="12" r="6.6"/>' },
    burger:  { d: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>' },
    robux:   { d: '<path d="M12 2.9l7.9 4.55v9.1L12 21.1l-7.9-4.55v-9.1z"/><rect x="9.1" y="9.1" width="5.8" height="5.8" rx="1"/>' },
    home:    { d: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.6v-6H9.6v6H5a1 1 0 0 1-1-1z"/>' },
    profile: { d: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5"/>' },
    msg:     { d: '<path d="M4 5h16v11H9.5L4 20z"/>' },
    conn:    { d: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.9-3.3 3.3-5 6.5-5s5.6 1.7 6.5 5"/><circle cx="17" cy="9.5" r="2.8"/><path d="M17.5 14.6c2.2.3 3.6 1.9 4.1 4.4"/>' },
    figure:  { d: '<rect x="8.5" y="3" width="7" height="6" rx="1.5"/><path d="M6 21v-8.5A2.5 2.5 0 0 1 8.5 10h7a2.5 2.5 0 0 1 2.5 2.5V21"/><path d="M10 21v-5h4v5"/>' },
    bag:     { d: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M4 12h16"/>' },
    trade:   { d: '<path d="M5 8h13l-3.5-3.5"/><path d="M19 16H6l3.5 3.5"/>' },
    group:   { d: '<circle cx="12" cy="8" r="3"/><circle cx="5.5" cy="10" r="2.3"/><circle cx="18.5" cy="10" r="2.3"/><path d="M7 19.5c.6-3 2.5-4.6 5-4.6s4.4 1.6 5 4.6"/><path d="M2 18.5c.4-2 1.6-3.2 3.4-3.4M22 18.5c-.4-2-1.6-3.2-3.4-3.4"/>' },
    doc:     { d: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>' },
    store:   { d: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>' },
    gift:    { d: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11"/><path d="M12 9c-1.5-3-5-3.5-5-1.2C7 9 9.5 9 12 9zM12 9c1.5-3 5-3.5 5-1.2C17 9 14.5 9 12 9z"/>' },
    chevR:   { d: '<path d="M9.5 6l6 6-6 6"/>' },
    chevL:   { d: '<path d="M14.5 6l-6 6 6 6"/>' },
    arrowR:  { d: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
    plus:    { d: '<path d="M12 5v14M5 12h14"/>' },
    caret:   { fill: 1, d: '<path d="M7 10l5 5 5-5z"/>' },
    bars:    { d: '<path d="M5 20v-8M12 20V5M19 20v-9"/>' },
    dots:    { fill: 1, d: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' },
    signal:  { fill: 1, d: '<rect x="2" y="15" width="3.6" height="6" rx="1"/><rect x="7.2" y="11.5" width="3.6" height="9.5" rx="1"/><rect x="12.4" y="8" width="3.6" height="13" rx="1"/><rect x="17.6" y="4" width="3.6" height="17" rx="1"/>' },
    wifi:    { d: '<path d="M2.5 9.5a14 14 0 0 1 19 0"/><path d="M6 13a9 9 0 0 1 12 0"/><path d="M9.5 16.5a4 4 0 0 1 5 0"/>' }
  };
  function glyph(name, size, color, sw) {
    var g = GLY[name];
    if (!g) return '';
    var paint = g.fill ? 'fill="' + color + '" stroke="none"'
      : 'fill="none" stroke="' + color + '" stroke-width="' + (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round"';
    return '<svg class="rbx-ic" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" ' + paint + ' aria-hidden="true">' + g.d + '</svg>';
  }
  // scalloped rosette + white check (original drawing)
  function badge(size, color) {
    var c = '<circle cx="12" cy="12" r="8"/>';
    for (var i = 0; i < 10; i++) {
      var a = i * Math.PI / 5;
      c += '<circle cx="' + (12 + 7.4 * Math.cos(a)).toFixed(2) + '" cy="' + (12 + 7.4 * Math.sin(a)).toFixed(2) + '" r="3.4"/>';
    }
    return '<svg class="rbx-badge" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<g fill="' + color + '">' + c + '</g>' +
      '<path d="M8.3 12.4l2.5 2.5 5-5.4" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // neutral tilted-square glyph (no wordmark)
  function logo(size, P) {
    return '<svg class="rbx-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<g transform="rotate(-15 12 12)"><rect x="3.5" y="3.5" width="17" height="17" rx="2.6" fill="' + P.fg + '"/>' +
      '<rect x="9.7" y="9.7" width="4.6" height="4.6" rx="0.6" fill="' + P.top + '"/></g></svg>';
  }
  function battery(P) {
    return '<svg class="rbx-ic" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 14" width="27" height="13" aria-hidden="true">' +
      '<rect x="0.75" y="0.75" width="23" height="12.5" rx="3.5" fill="none" stroke="' + P.fg + '" stroke-opacity="0.45" stroke-width="1.5"/>' +
      '<rect x="2.6" y="2.6" width="17" height="8.8" rx="2" fill="' + P.fg + '"/>' +
      '<rect x="25" y="4.5" width="2" height="5" rx="1" fill="' + P.fg + '" fill-opacity="0.45"/></svg>';
  }

  /* ---------- fit view ---------- */
  // pure: stage size + virtual screen size + per-side margin → uniform "contain" scale,
  // capped at 1 (never upscaled) and floored at 0.02; null when the stage can't be
  // measured (content-visibility hidden → 0×0) so the caller keeps its last scale
  function fitScale(aw, ah, vw, vh, pad) {
    aw = +aw; ah = +ah; vw = +vw; vh = +vh; pad = Math.max(0, +pad || 0);
    if (!(aw > 0 && ah > 0 && vw > 0 && vh > 0) || !isFinite(aw) || !isFinite(ah) || !isFinite(vw) || !isFinite(vh)) return null;
    if (aw - 2 * pad < 1 || ah - 2 * pad < 1) pad = 0;   // tiny stage: drop the letterbox margin first
    var k = Math.min((aw - 2 * pad) / vw, (ah - 2 * pad) / vh, 1);
    k = Math.floor(k * 10000) / 10000;
    return k > 0.02 ? k : 0.02;
  }
  // the virtual box the fit view scales: the 1920×1080 screen, or the whole phone (frame included)
  function fitVirtual(mobile) {
    return mobile ? { w: FIT.phoneW + FIT.phoneChrome * 2, h: FIT.phoneH + FIT.phoneChrome * 2, pad: FIT.padPhone }
      : { w: FIT.screenW, h: FIT.screenH, pad: FIT.pad };
  }
  var fsOn = false;   // stage in browser fullscreen → always the whole-screen view
  function wantFit() { return S.zoom === 'fit' || fsOn; }
  function fitOn() { return wantFit() && feed.games.length > 0; }
  function clearFit() {
    if (!device) return;
    ['width', 'height', 'margin-left', 'margin-top', 'transform', '--fp-inv'].forEach(function (p) { device.style.removeProperty(p); });
  }
  // the transform lives on fp-device (an ancestor of the painted viewport, inside the lens):
  // the distance test composes with it; while exporting, .fp-exporting (frontpage.css) drops it
  // to scale(1) so the png is painted at true layout size, independent of the window
  function applyFit() {
    if (!device || !stage) return;
    var on = fitOn();
    stage.classList.toggle('fp-fit', on);
    // stacked layout (frontpage.css, <860px): a fit desktop screen sizes the stage to 16:9
    stage.classList.toggle('fp-fit-desk', on && S.device !== 'mobile');
    if (!on) { stage.classList.remove('fp-fit-small', 'fp-fit-tiny'); clearFit(); updateStageLabel(); return; }
    var v = fitVirtual(S.device === 'mobile');
    var k = fitScale(stageBody ? stageBody.clientWidth : 0, stageBody ? stageBody.clientHeight : 0, v.w, v.h, v.pad);
    if (k == null) k = fitK;
    device.style.width = v.w + 'px';
    device.style.height = v.h + 'px';
    device.style.marginLeft = (-v.w / 2) + 'px';
    device.style.marginTop = (-v.h / 2) + 'px';
    if (k) {
      fitK = k;
      device.style.transform = 'scale(' + k + ')';
      device.style.setProperty('--fp-inv', (1 / k).toFixed(3));
      // too small for a readable 'your game' chip: drop it (square tiles first), the
      // dashed outline still marks your tiles
      stage.classList.toggle('fp-fit-small', k < 0.45);
      stage.classList.toggle('fp-fit-tiny', k < 0.3);
    }
    updateStageLabel();
  }
  var fitRaf = null;
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(function () { fitRaf = null; if (wantFit()) applyFit(); });
  }
  // effective on-screen scale of an element (fit × distance lens); 1 when unmeasurable
  function scaleOf(el) {
    var w = el && el.offsetWidth, r = w ? el.getBoundingClientRect().width / w : 1;
    return r > 0 && isFinite(r) ? r : 1;
  }
  // wheel over the letterbox / top bar / sidebar scrolls the virtual screen, like a real
  // monitor; at either end it falls through so the page itself still scrolls
  function onStageWheel(e) {
    if (!fitOn() || e.ctrlKey || !viewport) return;
    var main = viewport.querySelector('.rbx-main');
    if (!main || (e.target && e.target.closest && e.target.closest('.rbx-main'))) return;
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? main.clientHeight : 1);
    if (!dy) return;
    var max = main.scrollHeight - main.clientHeight;
    if ((dy < 0 && main.scrollTop <= 0) || (dy > 0 && main.scrollTop >= max - 1)) return;
    e.preventDefault();
    e.stopPropagation();
    main.scrollTop += dy;
  }
  function buildZoomToggle() {
    var bar = stageLabel && stageLabel.parentNode;
    if (!bar || $('fp-zoom')) return;
    var seg = document.createElement('span');
    seg.className = 'fp-seg fp-zoom';
    seg.id = 'fp-zoom';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'preview size');
    [['100', '100%', 'actual size, scroll inside the preview'],
     ['fit', 'fit', 'the whole ' + FIT.screenW + '×' + FIT.screenH + ' screen (or the whole phone) scaled to fit']].forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('data-set', 'zoom');
      b.setAttribute('data-val', o[0]);
      b.title = o[2];
      b.textContent = o[1];
      seg.appendChild(b);
    });
    bar.insertBefore(seg, stageLabel.nextSibling);
    // fullscreen: the stage takes the whole monitor and shows the whole screen, so on a
    // 1080p monitor the mock is at its real 1:1 size. esc (or the button) leaves it.
    if (stage && stage.requestFullscreen) {
      var fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'chip fp-fs';
      fsBtn.id = 'fp-fs';
      fsBtn.title = 'fullscreen: the whole page at real size (esc to leave)';
      fsBtn.setAttribute('aria-label', 'fullscreen preview');
      fsBtn.textContent = '⛶';
      // real browser fullscreen when allowed; otherwise (embedded views, blocked) the stage
      // still covers the whole window ("pseudo" mode) and esc leaves it
      var pseudo = false;
      var setFs = function (on) {
        if (fsOn === on) return;
        fsOn = on;
        stage.classList.toggle('is-fs', on);
        document.documentElement.classList.toggle('fp-fs-lock', on && pseudo);
        fsBtn.textContent = on ? '✕' : '⛶';
        fsBtn.title = on ? 'exit fullscreen (esc)' : 'fullscreen: the whole page at real size (esc to leave)';
        fsBtn.setAttribute('aria-label', on ? 'exit fullscreen' : 'fullscreen preview');
        render();
      };
      fsBtn.addEventListener('click', function () {
        if (fsOn) {
          if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
          else { pseudo = false; setFs(false); }
          return;
        }
        var p = null;
        try { p = stage.requestFullscreen(); } catch (err) { p = Promise.reject(err); }
        var settled = false;
        var fallback = function () { if (settled) return; settled = true; if (!document.fullscreenElement) { pseudo = true; setFs(true); } };
        Promise.resolve(p).then(function () { settled = true; }, fallback);
        // some embedded browsers leave the request hanging: don't make the user wait
        setTimeout(fallback, 900);
      });
      bar.appendChild(fsBtn);
      document.addEventListener('fullscreenchange', function () { pseudo = false; setFs(document.fullscreenElement === stage); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pseudo && fsOn) { pseudo = false; setFs(false); } });
      document.addEventListener('hub:show', function (e) { if (fsOn && pseudo && e.detail && e.detail.tool !== 'frontpage') { pseudo = false; setFs(false); } });
    }
  }

  /* ---------- layout ---------- */
  var SQ_STATS_W = 104;
  function layout() {
    var mobile = S.device === 'mobile', compact = S.density === 'compact';
    // fit view: always the real 1920 desktop (or the 390 phone), never the stage width
    var vw = wantFit() ? (mobile ? FIT.phoneW : FIT.screenW) : ((viewport && viewport.clientWidth) || (mobile ? 390 : 980));
    // tight: desktop mock squeezed to phone width — drop the sidebar + top-bar extras
    // (S.sidebar itself is left alone so a wider stage restores it)
    var tight = !mobile && vw < TIGHT_W;
    var pad = mobile || tight ? 16 : (compact ? 20 : 24);
    var side = (!mobile && !tight && S.sidebar) ? (compact ? 184 : 204) : 0;
    var avail = vw - side - pad * 2 - 10;
    var gap = mobile ? 10 : (compact ? 12 : 16);
    var wideMin = compact ? 176 : 216, sqMin = compact ? 118 : 148;
    return {
      mobile: mobile, compact: compact, narrow: !mobile && vw < 860, tight: tight,
      // phone frame squeezed under 360 (100% mode on a phone): the 'Home' title, then the
      // robux number, give way so the signed-in viewer chip is never clipped off the top bar
      xs: mobile && vw < 360, xxs: mobile && vw < 280,
      wide: clamp(Math.floor((avail + gap) / (wideMin + gap)), 2, 6),
      // square grids: the stats row ("97% 40.3K") needs ~104px, so a squeezed mock (tight
      // desktop / phone frame under 390) drops to 2 columns instead of clipping the numbers
      sq: mobile ? ((vw - 32 - 2 * gap) / 3 >= SQ_STATS_W ? 3 : 2)
        : clamp(Math.floor((avail + gap) / (sqMin + gap)), tight ? 2 : 3, 10),
      rows: 3,
      chartW: mobile ? 108 : (compact ? 124 : 150),
      recW: compact ? 220 : 252,
      rowSqW: compact ? 96 : 108
    };
  }
  function sig(L) { return [L.mobile, L.compact, L.narrow, L.tight, L.xs, L.xxs, L.wide, L.sq].join('|'); }

  /* how many of your tiles a section shows: one (flip) or one per variant (spread) */
  function mineCount(kind) {
    if (S.varMode === 'flip' || variants.length <= 1) return 1;
    if (kind === 'sq' && hasIcon()) return 1;
    return variants.length;
  }
  function withMine(games, k) {
    var out = games.map(function (g) { return { game: g }; });
    var at = clamp(S.slot, 0, out.length);
    var mine = [];
    if (k === 1) mine.push({ mine: true, vi: variants.length ? clamp(S.active, 0, variants.length - 1) : 0 });
    else for (var i = 0; i < k; i++) mine.push({ mine: true, vi: i });
    out.splice.apply(out, [at, 0].concat(mine));
    return out;
  }
  // an icon tile showing the uploaded icon belongs to no variant — no letter (it would go stale in spread)
  function sharedIcon(kind) { return kind === 'sq' && hasIcon(); }
  // letter first: if a narrow tile ellipsizes the chip, the variant letter still shows
  function hlText(vi, kind) { return (variants.length > 1 && !sharedIcon(kind) ? LETTERS[vi] + ' · ' : '') + 'your game'; }

  /* ---------- mock markup ---------- */
  function tile(it, kind, C, attrs, opt) {
    opt = opt || {};
    var P = C.P, isz = C.L.mobile ? 12 : (C.L.compact ? 12 : 13);
    var name, rating, players, img, creator = '', verified = false;
    if (it.mine) {
      name = yourName(); rating = fmtRating(S.rating); players = yourPlayers();
      creator = yourCreator();
      img = '<img class="rbx-img" data-mine="' + (kind === 'wide' ? 'thumb' : 'icon') + '" data-vi="' + it.vi + '" alt="">';
    } else {
      var g = it.game;
      name = g.name; rating = fmtRating(g.rating); players = fmtCount(g.playing);
      creator = g.creator || ''; verified = !!g.creatorVerified;
      img = '<img class="rbx-img" crossorigin="anonymous" data-src="' + esc(kind === 'wide' ? g.thumb : g.icon) + '"' +
        (opt.lazy ? ' loading="lazy"' : '') + ' alt="">';
    }
    var h = '<div class="rbx-tile rbx-tile--' + kind + (it.mine ? ' is-mine' : '') + '"' + (attrs || '') + '>' +
      '<div class="rbx-thumb">' + img + '</div>' +
      '<div class="rbx-name">' + esc(name) + '</div>';
    if (opt.creator && creator) {
      h += '<div class="rbx-by"><span class="rbx-by-t">' + esc(C.t.by + ' ' + creator) + '</span>' + (verified ? badge(13, BLUE) : '') + '</div>';
    }
    h += '<div class="rbx-meta">' +
      '<span class="rbx-stat">' + glyph('thumb', isz, P.fg2) + '<span>' + esc(rating) + '</span></span>' +
      '<span class="rbx-stat">' + glyph('person', isz, P.fg2) + '<span>' + esc(players) + '</span></span>' +
      '</div>';
    if (it.mine) h += '<div class="fp-hl" data-paint="skip"><span class="fp-hl-chip">' + esc(hlText(it.vi, kind)) + '</span></div>';
    return h + '</div>';
  }
  function tiles(list, kind, C, sec, row, opt) {
    var h = '';
    list.forEach(function (it, i) {
      var attrs = '';
      if (sec) attrs = ' data-sec="' + sec + '" data-pos="' + i + '"' + (row != null ? ' data-row="' + row + '"' : '');
      var o = opt || {};
      if (o.lazyFrom != null) o = { creator: o.creator, lazy: i >= o.lazyFrom };
      h += tile(it, kind, C, attrs, o);
    });
    return h;
  }
  function head(title, C, opt) {
    opt = opt || {};
    return '<div class="rbx-sec-head"><div class="rbx-h2"><span class="rbx-h2-t">' + esc(title) + '</span>' + (opt.chev ? glyph('chevR', C.L.mobile ? 18 : 20, C.P.fg, 2.4) : '') + '</div>' +
      (opt.seeAll ? '<div class="rbx-see">' + esc(C.t.seeAll) + glyph('arrowR', 15, C.P.fg2, 2.2) + '</div>' : '') + '</div>';
  }
  function grid(cols, inner, kind) {
    return '<div class="rbx-grid rbx-grid--' + kind + '" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + inner + '</div>';
  }
  // row arrows are hover-only preview chrome (opacity 0 otherwise) — kept out of the tab order
  function row(inner, tw, C, arrows) {
    var h = '<div class="rbx-rowwrap" style="--tw:' + tw + 'px">';
    if (arrows) h += '<button type="button" class="rbx-arrow rbx-arrow--l" data-dir="-1" data-paint="skip" tabindex="-1" aria-label="scroll left">' + glyph('chevL', 18, C.P.fg, 2.4) + '</button>';
    h += '<div class="rbx-row" data-native-scroll>' + inner + '</div>';
    if (arrows) h += '<button type="button" class="rbx-arrow rbx-arrow--r" data-dir="1" data-paint="skip" tabindex="-1" aria-label="scroll right">' + glyph('chevR', 18, C.P.fg, 2.4) + '</button>';
    return h + '</div>';
  }
  function avatarImg(c) {
    if (c.src) return '<img class="rbx-avimg" data-src="' + esc(c.src) + '" data-av="' + esc(c.name) + '" alt="">';
    return '<img class="rbx-avimg" src="' + avatarPh(c.name) + '" alt="">';
  }

  /* connections: js/connections.js (window.__UMBRA_CONNECTIONS, generated by
     scripts/fetch-avatars.js) shuffled once per page load so everyone shows up over
     time — or the placeholder manifest above. S0DA is the viewer (top bar + sidebar
     profile), never one of his own connections, so he is filtered out here. */
  var connList = null;
  function isViewer(c) {
    var me = PROFILE.name.toLowerCase();
    return [c.username, c.name].some(function (n) { return n && String(n).toLowerCase() === me; });
  }
  function connections() {
    if (connList) return connList;
    var gen = window.__UMBRA_CONNECTIONS;
    var list = [];
    if (Array.isArray(gen) && gen.length) {
      gen.forEach(function (c) {
        if (!c || typeof c !== 'object' || isViewer(c)) return;
        var name = String(c.name || c.username || '').trim();
        if (!name) return;
        list.push({ name: name, src: typeof c.src === 'string' && c.src ? c.src : null, verified: !!c.verified });
      });
      list = shuffled(list, (Math.random() * 4294967295) >>> 0);
    }
    connList = list.length ? list : FP_CONNECTIONS.filter(function (c) { return !isViewer(c); });
    return connList;
  }

  function friends(C) {
    var L = C.L, t = C.t, list = connections();
    var h = '<div class="rbx-friend"><div class="rbx-av rbx-av--add">' + glyph('plus', L.mobile ? 24 : 30, C.P.fg, 2.2) +
      '<span class="rbx-count">3</span></div><div class="rbx-fname">' + esc(t.connect) + '</div></div>';
    list.slice(0, 16).forEach(function (c, i) {
      var mark = c.verified ? badge(13, BLUE) : '';
      h += '<div class="rbx-friend"><div class="rbx-av">' + avatarImg(c) + (i % 3 !== 2 ? '<span class="rbx-dot"></span>' : '') +
        '</div><div class="rbx-fname"><span>' + esc(c.name) + '</span>' + mark + '</div></div>';
    });
    return '<div class="rbx-sec rbx-sec--friends">' + head(t.connections + ' (' + list.length + ')', C, { seeAll: true }) +
      '<div class="rbx-friends">' + h + '</div></div>';
  }

  function homePage(C) {
    var L = C.L, t = C.t, pl = pool();
    var kW = mineCount('wide'), kS = mineCount('sq');
    var recN = L.mobile ? 8 : L.wide * L.rows;
    var recBase = take(pl, 0, recN - kW);
    shownSlot = { page: 'home', slot: clamp(S.slot, 0, recBase.length) };
    var rec = withMine(recBase, kW);
    var contN = L.mobile ? 8 : L.sq;
    var cont = withMine(take(pl, recN - kW, contN - kS), kS);
    var s0 = feed.sorts[0];
    var sortList = s0 ? sortGames(s0) : [];
    if (!sortList.length) sortList = take(pl, recN + contN, 12);
    var sortN = L.mobile ? 10 : L.sq;
    if (sortList.length < sortN) {
      sortList = sortList.concat(pl.filter(function (g) { return sortList.indexOf(g) === -1; }).slice(0, sortN - sortList.length));
    }
    var sortItems = sortList.slice(0, sortN).map(function (g) { return { game: g }; });

    var h = L.mobile ? '' : '<div class="rbx-h1">' + esc(t.home) + '</div>';
    h += friends(C);
    h += '<div class="rbx-sec" data-sec="rec">' + head(t.rec, C, { chev: true }) +
      (L.mobile ? row(tiles(rec, 'wide', C, 'rec'), L.recW, C, false) : grid(L.wide, tiles(rec, 'wide', C, 'rec'), 'wide')) + '</div>';
    h += '<div class="rbx-sec" data-sec="cont">' + head(t.cont, C, { chev: true }) +
      (L.mobile ? row(tiles(cont, 'sq', C, 'cont'), L.rowSqW, C, false) : grid(L.sq, tiles(cont, 'sq', C, 'cont'), 'sq')) + '</div>';
    h += '<div class="rbx-sec">' + head(s0 ? sortName(s0) : t.trending, C, { chev: true }) +
      (L.mobile ? row(tiles(sortItems, 'sq', C, null), L.rowSqW, C, false) : grid(L.sq, tiles(sortItems, 'sq', C, null), 'sq')) + '</div>';
    return h;
  }

  var STOP = { the: 1, and: 1, for: 1, with: 1, you: 1 };
  function words(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter(function (w) { return w.length >= 3 && !STOP[w]; });
  }
  function searchPage(C) {
    var L = C.L, t = C.t, pl = pool();
    var q = words(yourName()), hit = [], rest = [];
    pl.forEach(function (g) {
      var gw = words(g.name), m = false;
      for (var i = 0; i < q.length && !m; i++) if (gw.indexOf(q[i]) !== -1) m = true;
      (m ? hit : rest).push(g);
    });
    var k = mineCount('sq');
    var cols = L.sq;
    var n = cols * (L.mobile ? 6 : 4);
    var base = hit.concat(rest).slice(0, Math.max(0, n - k));
    shownSlot = { page: 'search', slot: clamp(S.slot, 0, base.length) };
    var list = withMine(base, k);
    var pills = [t.experiences, t.market, t.people, t.communities].map(function (p, i) {
      return '<span class="rbx-pill' + (i === 0 ? ' is-on' : '') + '">' + esc(p) + '</span>';
    }).join('');
    return '<div class="rbx-h1 rbx-h1--search">' + esc(t.results + ' "' + yourName() + '"') + '</div>' +
      '<div class="rbx-pills">' + pills + '</div>' +
      '<div class="rbx-sec rbx-sec--flat" data-sec="search">' + grid(cols, tiles(list, 'sq', C, 'search', null, { creator: true }), 'sq') + '</div>';
  }

  function chartsPage(C) {
    var L = C.L, t = C.t, P = C.P;
    var rows = [];
    feed.sorts.forEach(function (s) {
      var g = sortGames(s).slice(0, 24);
      if (g.length) rows.push({ name: sortName(s), games: g });
    });
    if (!rows.length) rows.push({ name: t.trending, games: take(pool(), 0, 24) });
    var cr = clamp(S.chartRow, 0, rows.length - 1);
    shownChart = { row: cr, slot: clamp(S.slot, 0, rows[cr].games.length) };
    var k = mineCount('sq');
    var pills = '<span class="rbx-pill">' + esc(t.device + ': ' + (L.mobile ? t.phone : t.computer)) + glyph('caret', 18, P.fg) + '</span>' +
      '<span class="rbx-pill">' + esc(t.country + ': ' + t.allLoc) + glyph('caret', 18, P.fg) + '</span>' +
      (S.genre !== 'all' ? '<span class="rbx-pill is-on">' + esc(t.genre + ': ' + genreName(S.genre)) + '</span>' : '');
    var h = '<div class="rbx-h1">' + esc(t.charts) + '</div><div class="rbx-pills">' + pills + '</div>';
    rows.forEach(function (r, ri) {
      var items = ri === cr ? withMine(r.games, k) : r.games.map(function (g) { return { game: g }; });
      h += '<div class="rbx-sec" data-sec="chart' + ri + '">' + head(r.name, C, { seeAll: true }) +
        row(tiles(items, 'sq', C, 'chart', ri, { lazyFrom: L.mobile ? 5 : 10 }), L.chartW, C, !L.mobile) + '</div>';
    });
    return h;
  }

  function pageHtml(C) {
    if (S.page === 'search') return searchPage(C);
    if (S.page === 'charts') return chartsPage(C);
    return homePage(C);
  }

  function sideNav(C) {
    var t = C.t, P = C.P, isz = C.L.compact ? 20 : 22;
    var onHome = S.page !== 'charts';
    var items = [['home', t.home, onHome], ['profile', t.profile], ['msg', t.messages], ['conn', t.connections],
      ['figure', t.avatar], ['bag', t.inventory], ['trade', t.trade], ['group', t.communities]];
    var h = '<div class="rbx-side">' +
      '<div class="rbx-me"><div class="rbx-me-av">' + avatarImg(PROFILE) + '</div><div class="rbx-me-txt">' +
      '<div class="rbx-me-name"><span>' + esc(PROFILE.name) + '</span>' + badge(16, RED) + '</div>' +
      '<div class="rbx-me-sub">' + esc(t.viewProfile) + '</div></div></div><div class="rbx-nav">';
    items.forEach(function (it) {
      h += '<div class="rbx-nav-i' + (it[2] ? ' is-on' : '') + '">' + glyph(it[0], isz, P.fg, 1.9) + '<span>' + esc(it[1]) + '</span></div>';
    });
    h += '</div><div class="rbx-side-sep"></div><div class="rbx-nav">';
    [['doc', t.blog], ['store', t.store], ['gift', t.gift]].forEach(function (it) {
      h += '<div class="rbx-nav-i">' + glyph(it[0], isz, P.fg, 1.9) + '<span>' + esc(it[1]) + '</span></div>';
    });
    return h + '</div><div class="rbx-premium">' + esc(t.premium) + '</div></div>';
  }

  // the signed-in viewer (S0DA + red badge) in the top bar — headshot + name on desktop, headshot on the phone
  function viewerChip(withName) {
    return '<span class="rbx-viewer"><span class="rbx-viewer-av">' + avatarImg(PROFILE) + '</span>' +
      (withName ? '<span class="rbx-viewer-n">' + esc(PROFILE.name) + '</span>' : '') + badge(withName ? 15 : 14, RED) + '</span>';
  }

  function desktopFrame(C) {
    var t = C.t, P = C.P;
    var q = S.page === 'search';
    var links = [t.charts, t.market, t.create, t.robux].map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('');
    var top = '<div class="rbx-top">' +
      '<span class="rbx-top-ic">' + glyph('burger', 24, P.fg, 2) + '</span>' + logo(30, P) +
      '<div class="rbx-links">' + links + '</div>' +
      '<div class="rbx-search' + (q ? ' has-q' : '') + '">' + glyph('search', 18, q ? P.fg : P.fg3, 2.2) +
      '<span class="rbx-search-t">' + esc(q ? yourName() : t.search) + '</span></div>' +
      '<div class="rbx-right">' + viewerChip(true) +
      '<span class="rbx-robux">' + glyph('robux', 22, P.fg, 2) + '<span>' + esc(t.balance) + '</span></span>' +
      '<span class="rbx-top-ic">' + glyph('bell', 23, P.fg, 2) + '</span>' +
      '<span class="rbx-top-ic">' + glyph('gear', 23, P.fg, 2) + '</span></div></div>';
    return top + '<div class="rbx-divider"></div><div class="rbx-body">' + (S.sidebar && !C.L.tight ? sideNav(C) : '') +
      '<div class="rbx-main" data-native-scroll><div class="rbx-content">' + pageHtml(C) + '</div></div></div>';
  }

  function mobileFrame(C) {
    var t = C.t, P = C.P, q = S.page === 'search';
    var status = '<div class="rbx-status"><span>9:41</span><span class="rbx-status-r">' +
      glyph('signal', 17, P.fg) + glyph('wifi', 17, P.fg, 2.2) + battery(P) + '</span></div>';
    var top;
    if (q) {
      top = '<div class="rbx-top rbx-top--m">' + glyph('chevL', 24, P.fg, 2.4) +
        '<div class="rbx-search has-q">' + glyph('search', 17, P.fg, 2.2) + '<span class="rbx-search-t">' + esc(yourName()) + '</span></div></div>';
    } else {
      top = '<div class="rbx-top rbx-top--m">' + logo(28, P) +
        (S.page === 'home' ? '<span class="rbx-m-title">' + esc(t.home) + '</span>' : '') +
        '<div class="rbx-right"><span class="rbx-top-ic">' + glyph('search', 22, P.fg, 2.2) + '</span>' +
        '<span class="rbx-robux">' + glyph('robux', 20, P.fg, 2) + '<span>' + esc(t.balance) + '</span></span>' +
        '<span class="rbx-top-ic">' + glyph('bell', 22, P.fg, 2) + '</span>' + viewerChip(false) + '</div></div>';
    }
    var on = S.page === 'charts' ? 1 : 0;
    var tabs = [['home', t.home], ['bars', t.charts], ['figure', t.avatar], ['msg', t.chat], ['dots', t.more]].map(function (it, i) {
      var c = i === on ? P.fg : P.fg3;
      return '<div class="rbx-tab' + (i === on ? ' is-on' : '') + '">' + glyph(it[0], 23, c, 2) + '<span>' + esc(it[1]) + '</span></div>';
    }).join('');
    return status + top + '<div class="rbx-divider"></div>' +
      '<div class="rbx-main" data-native-scroll><div class="rbx-content">' + pageHtml(C) + '</div></div>' +
      '<div class="rbx-divider"></div><div class="rbx-tabbar">' + tabs + '</div>';
  }

  /* ---------- render ---------- */
  var renderRaf = null;
  // the charts row / slot your game was actually drawn in (chartsPage clamps them)
  var shownChart = null;
  // likewise the slot home (Recommended) / search drew your game at — withMine clamps it
  // when the row is shorter (phone, narrow 100% stage); S.slot itself is kept
  var shownSlot = null;
  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(function () { renderRaf = null; render(); });
  }
  function pageKey() { return S.page + '|' + S.device; }
  function captureScroll() {
    var main = viewport.querySelector('.rbx-main');
    if (!main) return null;
    var rows = Array.prototype.map.call(viewport.querySelectorAll('.rbx-row'), function (r) { return r.scrollLeft; });
    return { top: main.scrollTop, rows: rows };
  }
  function restoreScroll(k) {
    var main = viewport.querySelector('.rbx-main');
    if (main) main.scrollTop = k.top;
    Array.prototype.forEach.call(viewport.querySelectorAll('.rbx-row'), function (r, i) { if (k.rows[i]) r.scrollLeft = k.rows[i]; });
  }
  // scroll your first tile into view (its row horizontally, the page vertically)
  function revealMine() {
    var t = viewport && viewport.querySelector('.rbx-tile.is-mine');
    if (!t) return;
    var r = t.closest('.rbx-row');
    // rects are on-screen px (fit / distance scaled), scroll offsets are layout px
    if (r) {
      var tr = t.getBoundingClientRect(), rr = r.getBoundingClientRect(), kr = scaleOf(r);
      if (tr.left < rr.left + 8 * kr || tr.right > rr.right - 8 * kr) {
        r.scrollLeft += (tr.left - rr.left) / kr - 8 - Math.max(0, (rr.width - tr.width) / kr / 2 - 40);
      }
    }
    var main = viewport.querySelector('.rbx-main');
    if (main) {
      var a = t.getBoundingClientRect(), m = main.getBoundingClientRect();
      if (a.top < m.top || a.bottom > m.bottom) main.scrollTop += (a.top - m.top) / scaleOf(main) - 48;
    }
  }
  function render(reveal) {
    if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = null; }
    if (!viewport) return;
    var hasFeed = feed.games.length > 0;
    if (emptyEl) emptyEl.hidden = hasFeed;
    if (lens) lens.hidden = !hasFeed;
    updateStageBar();
    updateExportButtons();
    if (!hasFeed) { applyFit(); return; }

    var keep = scrollKey === pageKey() ? captureScroll() : null;
    var mobile = S.device === 'mobile';
    device.className = 'fp-device' + (mobile ? ' is-phone' : '');
    applyFit();     // before layout(): in 100% mode it reads the freed stage width
    var L = layout();
    lastSig = sig(L);
    var C = { L: L, P: PAL[S.theme] || PAL.dark, t: STR[S.lang] || STR.en };
    viewport.className = 'fp-viewport rbx rbx--' + (mobile ? 'mobile' : 'desktop') +
      (L.compact ? ' rbx--compact' : '') + (L.narrow ? ' rbx--narrow' : '') + (L.tight ? ' rbx--tight' : '') +
      (L.xs ? ' rbx--xs' : '') + (L.xxs ? ' rbx--xxs' : '') +
      (S.highlight ? ' fp-hl-on' : '');
    tightNow = L.tight;
    syncSideRow();
    viewport.setAttribute('data-theme', S.theme);
    viewport.setAttribute('lang', S.lang === 'pt' ? 'pt-BR' : 'en');
    shownChart = null;
    shownSlot = null;
    viewport.innerHTML = mobile ? mobileFrame(C) : desktopFrame(C);
    scrollKey = pageKey();
    if (keep) restoreScroll(keep);
    if (reveal === true || !keep) revealMine();
    fillMine();
    hydrate();
    syncSlot();
  }
  // cheap path: name / creator / rating / players only change your own tiles' text,
  // except on search (results heading, top-bar query and hits depend on the name)
  var textTimer = null;
  function textChanged() {
    if (!viewport) return;
    if (S.page === 'search') {
      clearTimeout(textTimer);
      textTimer = setTimeout(function () { textTimer = null; render(); }, 150);
      return;
    }
    var t = STR[S.lang] || STR.en;
    Array.prototype.forEach.call(viewport.querySelectorAll('.rbx-tile.is-mine'), function (el) {
      var n = el.querySelector('.rbx-name');
      if (n) n.textContent = yourName();
      var by = el.querySelector('.rbx-by-t');
      if (by) by.textContent = t.by + ' ' + yourCreator();
      var st = el.querySelectorAll('.rbx-stat > span');
      if (st[0]) st[0].textContent = fmtRating(S.rating);
      if (st[1]) st[1].textContent = yourPlayers();
    });
  }
  // cheap path: only your-game images (variant flip, icon change)
  function fillMine() {
    if (!viewport) return;
    Array.prototype.forEach.call(viewport.querySelectorAll('img[data-mine]'), function (img) {
      var vi = parseInt(img.getAttribute('data-vi'), 10) || 0;
      var url = img.getAttribute('data-mine') === 'thumb' ? thumbUrl(vi) : iconUrl(vi);
      if (img.getAttribute('src') !== url) img.src = url;
    });
  }
  function refreshMine() {
    if (!viewport) return;
    if (S.varMode === 'flip' || variants.length <= 1) {
      var vi = variants.length ? clamp(S.active, 0, variants.length - 1) : 0;
      Array.prototype.forEach.call(viewport.querySelectorAll('.rbx-tile.is-mine'), function (t) {
        var img = t.querySelector('img[data-mine]');
        if (img) img.setAttribute('data-vi', String(vi));
        var chip = t.querySelector('.fp-hl-chip');
        if (chip) chip.textContent = hlText(vi, img && img.getAttribute('data-mine') === 'icon' ? 'sq' : 'wide');
      });
    }
    fillMine();
  }
  // network images start loading only once the tool has been shown
  function hydrate() {
    if (!activated || !viewport) return;
    Array.prototype.forEach.call(viewport.querySelectorAll('img[data-src]'), function (img) {
      var src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
      img.src = src;
    });
  }
  function activate() {
    if (activated) return;
    activated = true;
    hydrate();
  }

  function onImgError(e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || img.getAttribute('data-fb')) return;
    img.setAttribute('data-fb', '1');
    if (img.hasAttribute('data-av')) { img.src = avatarPh(img.getAttribute('data-av')); return; }
    if (img.hasAttribute('data-mine')) return;
    img.src = img.closest('.rbx-tile--sq') ? ph(256, 256, '') : ph(480, 270, '');
  }

  function onMockClick(e) {
    var arrow = e.target.closest('.rbx-arrow');
    if (arrow) {
      var r = arrow.parentNode.querySelector('.rbx-row');
      if (r) r.scrollBy({ left: r.clientWidth * 0.8 * (parseInt(arrow.getAttribute('data-dir'), 10) || 1), behavior: reduceMotion ? 'auto' : 'smooth' });
      return;
    }
    var t = e.target.closest('.rbx-tile');
    if (!t || !viewport.contains(t)) return;
    if (t.classList.contains('is-mine')) {
      if (variants.length < 2) return;
      if (S.varMode === 'flip') cycle(1);
      else {
        var img = t.querySelector('img[data-mine]');
        selectVariant(parseInt(img && img.getAttribute('data-vi'), 10) || 0);
      }
      return;
    }
    if (!t.hasAttribute('data-pos')) return;
    S.slot = parseInt(t.getAttribute('data-pos'), 10) || 0;
    if (t.hasAttribute('data-row')) S.chartRow = parseInt(t.getAttribute('data-row'), 10) || 0;
    render();
    syncSlot();
    save();
  }

  /* ---------- stage bar / export buttons ---------- */
  function updateStageLabel() {
    if (!stageLabel) return;
    var parts = [S.page, S.device, S.theme, S.lang === 'pt' ? 'pt-br' : 'en'];
    if (fitOn() && fitK) parts.push(Math.round(fitK * 100) + '%');
    stageLabel.textContent = parts.join(' · ');
  }
  function updateStageBar() {
    updateStageLabel();
    if (stageVar) {
      stageVar.textContent = variants.length > 1 ? ('variant ' + LETTERS[S.active] + ' / ' + variants.length + (S.varMode === 'spread' ? ' · spread' : '')) : '';
    }
    if (fnameEl) fnameEl.textContent = fileName();
  }
  function updateExportButtons() {
    var off = !feed.games.length || exporting;
    if (exportBtn) exportBtn.disabled = off;
    if (copyBtn) copyBtn.disabled = off;
  }
  function fileName() { return 'frontpage-' + S.page + '-' + S.device + '.png'; }

  /* ---------- variants ---------- */
  function renderVariantChips() {
    if (!varRow) return;
    Array.prototype.forEach.call(varRow.querySelectorAll('.fp-var-chip'), function (c) { c.remove(); });
    variants.forEach(function (v, i) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip fp-var-chip' + (i === S.active ? ' active' : '');
      chip.setAttribute('data-vi', String(i));
      chip.title = 'variant ' + LETTERS[i] + ' · ' + v.w + '×' + v.h;
      var im = document.createElement('img');
      im.src = v.url; im.alt = '';
      chip.appendChild(im);
      chip.appendChild(document.createTextNode(LETTERS[i]));
      var del = document.createElement('span');
      del.className = 'chip-delete';
      del.setAttribute('data-del', String(i));
      del.title = 'remove variant ' + LETTERS[i];
      del.textContent = '×';
      chip.appendChild(del);
      varRow.insertBefore(chip, varAdd);
    });
    if (varAdd) varAdd.disabled = variants.length >= MAX_VARIANTS;
    var many = variants.length > 1;
    if (varPrev) varPrev.disabled = !many;
    if (varNext) varNext.disabled = !many;
    if (varLabel) varLabel.textContent = variants.length ? (LETTERS[S.active] + ' / ' + variants.length) : 'no variants';
  }
  function afterActiveChange() {
    renderVariantChips();
    renderIcon();
    refreshMine();
    updateStageBar();
    save();
  }
  function afterVariantsChange() {
    S.active = variants.length ? clamp(S.active, 0, variants.length - 1) : 0;
    renderVariantChips();
    renderIcon();
    render(true);
    save();
  }
  function selectVariant(i) {
    if (i < 0 || i >= variants.length || i === S.active) return;
    S.active = i;
    afterActiveChange();
  }
  function cycle(dir) {
    var n = variants.length;
    if (n < 2) return;
    S.active = (S.active + dir + n) % n;
    afterActiveChange();
  }
  function removeVariant(i) {
    var v = variants[i];
    if (!v) return;
    disposeVariant(v);
    variants.splice(i, 1);
    if (S.active > i || S.active >= variants.length) S.active = Math.max(0, S.active - 1);
    afterVariantsChange();
    toast(variants.length ? 'variant removed' : 'thumbnail removed');
  }

  // mode 'replace': first file replaces the active variant (or adds one); the rest are added
  // mode 'add': every file becomes a new variant
  function importThumbs(fileList, mode) {
    var list = imageFiles(fileList);
    if (!list.length) return;
    Promise.all(list.map(function (f) {
      return readFile(f).then(function (d) { return makeVariant(d, true, f.name); }).catch(function () { return null; });
    })).then(function (vs) {
      vs = vs.filter(Boolean);
      if (!vs.length) { toast('could not read that image'); return; }
      var added = 0, replaced = false, dropped = 0, firstNew = -1;
      vs.forEach(function (v, i) {
        if (mode === 'replace' && i === 0 && variants.length) {
          disposeVariant(variants[S.active]);
          variants[S.active] = v;
          replaced = true;
        } else if (variants.length < MAX_VARIANTS) {
          variants.push(v);
          if (firstNew === -1) firstNew = variants.length - 1;
          added++;
        } else { disposeVariant(v); dropped++; }
      });
      if (!replaced && firstNew !== -1) S.active = firstNew;
      afterVariantsChange();
      var msg = replaced ? ('variant ' + LETTERS[S.active] + ' updated') : '';
      if (added) msg = (msg ? msg + ' · ' : '') + (added === 1 ? 'variant ' + LETTERS[firstNew] + ' added' : added + ' variants added');
      if (dropped) msg = (msg ? msg + ' · ' : '') + 'max ' + MAX_VARIANTS + ' variants';
      toast(msg || 'max ' + MAX_VARIANTS + ' variants');
    });
  }
  // your icon (uploaded or sent back from crop) replaces the center crop on every square tile
  function useIcon(r) {
    upIcon = r;
    S.iconMode = 'upload';
    renderIcon(); render(); save();
  }
  function importIcon(file) {
    readFile(file).then(function (d) { return makeIcon2(d, true); }).then(function (r) {
      useIcon(r);
      toast('icon uploaded');
    }).catch(function () { toast('could not read that image'); });
  }

  /* ---------- receiving from other tools (Hub.send) ---------- */
  function onReceive(e) {
    var d = e && e.detail;
    if (!d || d.target !== TOOL) return;
    if (!(window.Hub && typeof Hub.takeInbox === 'function') && d.payload) recvQueue.push(d.payload);
    if (restored) drainInbox();
  }
  var recvChain = Promise.resolve();
  function drainInbox() {
    var items = recvQueue.splice(0);
    if (window.Hub && typeof Hub.takeInbox === 'function') {
      try { var inbox = Hub.takeInbox(TOOL); if (Array.isArray(inbox)) items = items.concat(inbox); } catch (err) {}
    }
    items.forEach(function (p) { recvChain = recvChain.then(function () { return receive(p); }).catch(noop); });
  }
  function receive(p) {
    if (!p || typeof p.dataUrl !== 'string' || p.dataUrl.indexOf('data:image/') !== 0) return Promise.resolve();
    var fromCrop = p.source === 'crop';
    var from = p.source === 'update' ? 'update icon' : (p.source || 'another tool');
    // crop's name is its output file name ('game_thumb_icon'), never a game name
    var name = fromCrop ? '' : String(p.name || '').trim();
    var setName = function () {
      if (name && !(S.name || '').trim()) {
        S.name = name.slice(0, 60);
        if (nameIn) nameIn.value = S.name;
      }
    };
    if (p.kind === 'icon') {
      return makeIcon2(p.dataUrl, true).then(function (r) {
        setName();
        useIcon(r);
        toast('icon received from ' + from);
      }).catch(function () { toast('could not read the received icon'); });
    }
    return makeVariant(p.dataUrl, true, name).then(function (v) {
      var msg;
      if (fromCrop && variants.length) {
        // a 16:9 crop of the active variant comes back in its place (keeping its file name)
        var old = variants[S.active];
        v.name = old.name;
        disposeVariant(old);
        variants[S.active] = v;
        msg = 'thumbnail received from crop → variant ' + LETTERS[S.active] + ' updated';
      } else if (variants.length < MAX_VARIANTS) {
        variants.push(v);
        S.active = variants.length - 1;
        msg = 'thumbnail received from ' + from + ' → variant ' + LETTERS[S.active];
      } else {
        disposeVariant(variants[S.active]);
        variants[S.active] = v;
        msg = 'variants full — replaced ' + LETTERS[S.active];
      }
      setName();
      afterVariantsChange();
      toast(msg);
    }).catch(function () { toast('could not read the received thumbnail'); });
  }

  /* ---------- icon: center crop (auto) · your icon (upload / crop) ---------- */
  function renderIcon() {
    if (!iconPrev) return;
    var v = variants[S.active], mine = hasIcon();
    var url = mine ? upIcon.dataUrl : (v && v.icon) || '';
    iconPrev.parentNode.classList.toggle('is-empty', !url);
    if (!url) iconPrev.removeAttribute('src');
    else if (iconPrev.getAttribute('src') !== url) iconPrev.src = url;
    iconSrc.textContent = mine ? 'your icon' : (v ? 'center crop (auto)' : 'none yet · add a thumbnail or upload one');
    iconMine.hidden = !mine;
    iconCropBtn.disabled = !v;
    iconCropBtn.title = v ? 'frame the icon from variant ' + LETTERS[S.active] + ' in the crop tool, then send it back with → frontpage'
      : 'add a thumbnail first';
  }
  function removeIcon() {
    if (!upIcon && S.iconMode === 'auto') return;
    upIcon = null; S.iconMode = 'auto';
    renderIcon(); render(); save();
    toast('back to the center crop');
  }
  // the active variant's stored thumbnail goes to the crop tool as a 1:1 (icon) crop
  function cropFromThumb() {
    var v = variants[S.active];
    if (!v) { toast('add a thumbnail first'); return; }
    if (!window.Hub || typeof Hub.send !== 'function') { toast('crop tool not available'); return; }
    var p = { kind: 'thumb', dataUrl: v.dataUrl, ratio: '1:1', source: 'frontpage' };
    var name = (S.name || '').trim() || v.name;
    if (name) p.name = name;
    Hub.send('crop', p);
    if (typeof Hub.show === 'function') Hub.show('crop');
  }

  /* ---------- tests (css on the lens — never exported) ---------- */
  function distScale() { return 1 - S.distance * 0.0075; }   // 0 → 1×, 100 → 0.25×
  function applyTests() {
    if (!lens) return;
    lens.style.transform = S.distance ? 'scale(' + distScale().toFixed(3) + ')' : '';
    var f = [];
    if (S.squint) f.push('blur(' + S.squint + 'px)');
    if (S.gray) f.push('grayscale(1)');
    lens.style.filter = f.join(' ');
    if (distVal) distVal.textContent = distScale().toFixed(2) + '×';
    if (squintVal) squintVal.textContent = S.squint + 'px';
  }

  /* ---------- export ---------- */
  function canvasBlob(canvas) {
    return new Promise(function (res, rej) {
      try { canvas.toBlob(function (b) { if (b) res(b); else rej(new Error('empty')); }, 'image/png'); }
      catch (e) { rej(e); }
    });
  }
  function nextFrame() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  function waitImages(timeout) {
    var vr = viewport.getBoundingClientRect();
    var imgs = Array.prototype.filter.call(viewport.querySelectorAll('img'), function (img) {
      if (img.loading === 'lazy') img.loading = 'eager';
      return overlaps(img.getBoundingClientRect(), vr);
    });
    return Promise.race([
      Promise.all(imgs.map(function (img) {
        if (img.complete && (img.naturalWidth || img.getAttribute('data-fb'))) return null;
        return new Promise(function (r) {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', function () { setTimeout(r, 60); }, { once: true });
        });
      })),
      new Promise(function (r) { setTimeout(r, timeout); })
    ]);
  }
  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function exportBlob() {
    activate();
    stage.classList.add('fp-exporting');
    return waitImages(5000).then(nextFrame).then(function () {
      return window.UmbraPaint.paint(viewport, { scale: S.scale });
    }).then(function (canvas) {
      if (!canvas || !canvas.width) throw new Error('empty');
      return canvasBlob(canvas);
    }).then(function (blob) {
      stage.classList.remove('fp-exporting');
      return blob;
    }, function (err) {
      stage.classList.remove('fp-exporting');
      throw err;
    });
  }
  // on file:// local avatar pngs would taint the canvas, so the painter skips them silently
  function fileAvatarNote() {
    if (location.protocol !== 'file:' || !viewport) return '';
    var imgs = viewport.querySelectorAll('img.rbx-avimg');
    for (var i = 0; i < imgs.length; i++) {
      var s = imgs[i].getAttribute('src') || '';
      if (s && s.indexOf('data:') !== 0) return ' · avatars skipped on file:// — open umbra over http';
    }
    return '';
  }
  function exportFail(err) {
    var sec = err && (err.name === 'SecurityError' || /taint|insecure|security/i.test(String(err.message || '')));
    toast(sec ? (location.protocol === 'file:' ? 'export blocked on file:// — open umbra over http' : 'export blocked — an image is not cors-clean')
      : 'export failed — try again');
  }
  function setBusy(on, which) {
    exporting = on;
    updateExportButtons();
    if (which === 'png' && exportBtn) exportBtn.textContent = on ? 'exporting…' : 'export png';
    if (which === 'copy' && copyBtn) copyBtn.textContent = on ? 'copying…' : 'copy';
  }
  function canExport() {
    if (exporting || !feed.games.length) return false;
    if (!window.UmbraPaint || typeof UmbraPaint.paint !== 'function') { toast('export engine not loaded'); return false; }
    return true;
  }
  function exportPng() {
    if (!canExport()) return;
    setBusy(true, 'png');
    exportBlob().then(function (blob) {
      triggerDownload(URL.createObjectURL(blob), fileName());
      toast('saved · ' + fileName() + fileAvatarNote());
    }).catch(exportFail).then(function () { setBusy(false, 'png'); });
  }
  function copyPng() {
    if (!canExport()) return;
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('clipboard image not supported — use export png'); return;
    }
    setBusy(true, 'copy');
    var job = exportBlob();
    var item;
    // a promise-valued ClipboardItem keeps the user activation (safari) while we paint
    try { item = new window.ClipboardItem({ 'image/png': job }); } catch (e) { item = null; }
    var write = item ? navigator.clipboard.write([item])
      : job.then(function (b) { return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': b })]); });
    write.then(function () { toast('copied to clipboard' + fileAvatarNote()); })
      .catch(function (err) {
        job.then(function () { toast('copy failed — use export png'); }, exportFail);
      })
      .then(function () { setBusy(false, 'copy'); });
  }

  /* ---------- controls sync ---------- */
  function syncSegs() {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-set]'), function (b) {
      var on = String(S[b.getAttribute('data-set')]) === b.getAttribute('data-val');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncSideRow();
  }
  // sidebar toggle is moot on the phone frame and on a tight (phone-width) desktop mock
  function syncSideRow() {
    var sideRow = sidebarT && sidebarT.closest('.row');
    if (sideRow) sideRow.classList.toggle('is-off', S.device === 'mobile' || tightNow);
  }
  function syncSlot() {
    if (!slotVal) return;
    // on charts, name the row / slot the mock actually shows (a genre can drop rows)
    var sc = S.page === 'charts' ? shownChart : null;
    var where = S.page === 'charts' ? ('row ' + ((sc ? sc.row : S.chartRow) + 1) + ' · ') : '';
    var ss = shownSlot && shownSlot.page === S.page ? shownSlot.slot : null;
    slotVal.textContent = where + 'slot ' + ((sc ? sc.slot : (ss != null ? ss : S.slot)) + 1);
  }
  function syncControls() {
    if (nameIn) nameIn.value = S.name;
    if (creatorIn) creatorIn.value = S.creator;
    if (ratingIn) ratingIn.value = S.rating;
    if (playersIn) playersIn.value = S.players;
    if (sidebarT) sidebarT.checked = S.sidebar;
    if (grayT) grayT.checked = S.gray;
    if (hlT) hlT.checked = S.highlight;
    if (distIn) distIn.value = S.distance;
    if (squintIn) squintIn.value = S.squint;
    if (genreSel) genreSel.value = S.genre;
    syncSegs();
    syncSlot();
    applyTests();
  }
  function buildGenres() {
    if (!genreSel) return;
    genreSel.innerHTML = '<option value="all">all genres</option>' + feed.genres.map(function (g) {
      return '<option value="' + esc(g.id) + '">' + esc(String(g.name).toLowerCase()) + '</option>';
    }).join('');
    genreSel.disabled = !feed.genres.length;
  }
  function feedLine() {
    if (!feedInfo) return;
    if (!feed.games.length) { feedInfo.textContent = 'neighbor feed unavailable'; return; }
    var age = '';
    var t = feed.generatedAt ? Date.parse(feed.generatedAt) : NaN;
    if (!isNaN(t)) {
      var d = Math.floor((Date.now() - t) / 86400000);
      age = ' · updated ' + (d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago');
    }
    feedInfo.textContent = feed.games.length + ' live neighbors' + age;
  }

  /* ---------- wiring ---------- */
  function wire() {
    // 01 your game
    nameIn.addEventListener('input', function () { S.name = nameIn.value; textChanged(); save(); });
    creatorIn.addEventListener('input', function () { S.creator = creatorIn.value; textChanged(); save(); });
    creatorIn.addEventListener('blur', function () { if (!creatorIn.value.trim()) { S.creator = 'you'; creatorIn.value = 'you'; textChanged(); save(); } });
    ratingIn.addEventListener('input', function () {
      var n = parseInt(ratingIn.value, 10);
      if (isNaN(n)) return;
      S.rating = clamp(n, 0, 100); textChanged(); save();
    });
    ratingIn.addEventListener('change', function () { ratingIn.value = S.rating; });
    playersIn.addEventListener('input', function () { S.players = playersIn.value; textChanged(); save(); });

    dropzone.addEventListener('click', function () { fileInput.click(); });
    dropzone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    fileInput.addEventListener('change', function () { importThumbs(fileInput.files, 'replace'); fileInput.value = ''; });
    // [zone, element that lights up] · the whole icon block (preview, crop button, status) is an icon target
    [[dropzone, dropzone], [$('fp-icon') || iconDrop, iconDrop], [varRow, varRow]].forEach(function (p) {
      var z = p[0], hl = p[1];
      z.addEventListener('dragover', function (e) { e.preventDefault(); hl.classList.add('drag-over'); });
      z.addEventListener('dragleave', function (e) { if (!z.contains(e.relatedTarget)) hl.classList.remove('drag-over'); });
    });

    // icon: upload · crop from thumbnail → · remove
    iconDrop.addEventListener('click', function () { iconFile.click(); });
    iconDrop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); iconFile.click(); } });
    iconFile.addEventListener('change', function () { var f = imageFiles(iconFile.files)[0]; if (f) importIcon(f); iconFile.value = ''; });
    iconCropBtn.addEventListener('click', cropFromThumb);
    iconRemove.addEventListener('click', removeIcon);

    // 02 variants
    varRow.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); removeVariant(parseInt(del.getAttribute('data-del'), 10)); return; }
      var chip = e.target.closest('.fp-var-chip');
      if (chip) { selectVariant(parseInt(chip.getAttribute('data-vi'), 10)); return; }
      if (e.target.closest('#fp-var-add')) varFile.click();
    });
    varFile.addEventListener('change', function () { importThumbs(varFile.files, 'add'); varFile.value = ''; });
    varPrev.addEventListener('click', function () { cycle(-1); });
    varNext.addEventListener('click', function () { cycle(1); });

    // segmented controls: [data-set][data-val]
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-set]');
      if (!b || !root.contains(b)) return;
      var key = b.getAttribute('data-set'), raw = b.getAttribute('data-val');
      var val = typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
      if (S[key] === val) return;
      S[key] = val;
      syncSegs();
      if (key === 'page' || key === 'device') syncSlot();
      if (key !== 'scale') render(key === 'varMode'); else updateStageBar();
      save();
    });

    // 03 view
    sidebarT.addEventListener('change', function () { S.sidebar = sidebarT.checked; render(); save(); });

    // 04 neighbors
    genreSel.addEventListener('change', function () { S.genre = genreSel.value || 'all'; render(true); save(); });
    shuffleBtn.addEventListener('click', function () {
      var s;
      do { s = (Math.random() * 4294967295) >>> 0; } while (!s || s === S.seed);
      S.seed = s;
      render(); save();
      toast('neighbors reshuffled');
    });
    slotReset.addEventListener('click', function () { S.slot = DEFAULTS.slot; S.chartRow = 0; render(true); syncSlot(); save(); });

    // 05 tests
    distIn.addEventListener('input', function () { S.distance = parseInt(distIn.value, 10) || 0; applyTests(); save(); });
    squintIn.addEventListener('input', function () { S.squint = parseInt(squintIn.value, 10) || 0; applyTests(); save(); });
    grayT.addEventListener('change', function () { S.gray = grayT.checked; applyTests(); save(); });

    // 06 export
    hlT.addEventListener('change', function () {
      S.highlight = hlT.checked;
      if (viewport) viewport.classList.toggle('fp-hl-on', S.highlight);
      save();
    });
    exportBtn.addEventListener('click', exportPng);
    copyBtn.addEventListener('click', copyPng);

    // mock
    viewport.addEventListener('click', onMockClick);
    viewport.addEventListener('error', onImgError, true);

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!feed.games.length) return;
        if (sig(layout()) !== lastSig) scheduleRender();
      }).observe(viewport);
      if (stageBody) new ResizeObserver(scheduleFit).observe(stageBody);
    } else {
      window.addEventListener('resize', function () {
        scheduleFit();
        if (feed.games.length && sig(layout()) !== lastSig) scheduleRender();
      });
    }
    if (stageBody) stageBody.addEventListener('wheel', onStageWheel, { passive: false });

    // global: keys · paste · drop (guarded to this tool)
    document.addEventListener('keydown', function (e) {
      if (!isActive() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingIn(e.target)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (variants.length < 2) return;
        e.preventDefault();
        cycle(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    document.addEventListener('paste', function (e) {
      if (!isActive()) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) { var f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); importThumbs(files, 'replace'); }
    });
    document.addEventListener('dragover', function (e) { if (isActive()) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!isActive()) return;
      e.preventDefault();
      [dropzone, iconDrop, varRow].forEach(function (z) { z.classList.remove('drag-over'); });
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !imageFiles(files).length) return;
      var t = e.target && e.target.closest ? e.target : document.body;
      if (t.closest('#fp-icon, #fp-icon-drop')) importIcon(imageFiles(files)[0]);
      else if (t.closest('#fp-var-sec')) importThumbs(files, 'add');
      else if (t.closest('#tool-frontpage')) importThumbs(files, 'replace');
    });

    document.addEventListener('hub:show', function (e) {
      if (e && e.detail && e.detail.tool === TOOL) {
        activate();
        applyFit();     // sizes were 0×0 while the tool was hidden
        if (feed.games.length && sig(layout()) !== lastSig) render();
        scheduleFit();
      }
    });
    document.addEventListener('hub:receive', onReceive);
  }

  /* ---------- restore ---------- */
  function restoreState() {
    return idbGet(DB_KEY).then(function (d) {
      if (!d || typeof d !== 'object') return;
      Object.keys(DEFAULTS).forEach(function (k) {
        if (d[k] != null && typeof d[k] === typeof DEFAULTS[k]) S[k] = d[k];
      });
      Object.keys(ENUMS).forEach(function (k) { if (ENUMS[k].indexOf(S[k]) === -1) S[k] = DEFAULTS[k]; });
      // saves from before 100% became the default open at 100% once
      if (d.zoomV !== 2) { S.zoom = '100'; S.zoomV = 2; }
      S.rating = clamp(Math.round(S.rating) || 0, 0, 100);
      S.slot = Math.max(0, Math.floor(S.slot) || 0);
      S.chartRow = Math.max(0, Math.floor(S.chartRow) || 0);
      S.distance = clamp(Math.round(S.distance) || 0, 0, 100);
      S.squint = clamp(Math.round(S.squint) || 0, 0, 12);
      S.seed = (S.seed >>> 0) || DEFAULTS.seed;
      var saved = Array.isArray(d.variants) ? d.variants.slice(0, MAX_VARIANTS) : [];
      return Promise.all(saved.map(function (s) {
        return s && typeof s.dataUrl === 'string' ? makeVariant(s.dataUrl, false, typeof s.name === 'string' ? s.name : '').catch(function () { return null; }) : null;
      })).then(function (list) {
        variants = list.filter(Boolean);
        S.active = variants.length ? clamp(S.active, 0, variants.length - 1) : 0;
        // older saves: the focus editor's fx / fy are ignored (the auto icon is always the center
        // crop now), and an icon kept behind the old "auto" chip is dropped: you saw the auto icon
        if (S.iconMode === 'upload' && typeof d.icon === 'string' && d.icon.indexOf('data:image/') === 0) {
          return makeIcon2(d.icon, false).then(function (r) { upIcon = r; }).catch(noop);
        }
      }).then(function () { if (!upIcon) S.iconMode = 'auto'; });
    }).catch(noop);
  }

  /* ---------- init ---------- */
  function init() {
    root = $('tool-frontpage');
    if (!root) return;
    stage = $('fp-stage'); stageBody = $('fp-stage-body'); lens = $('fp-lens'); device = $('fp-device');
    viewport = $('fp-viewport'); emptyEl = $('fp-empty'); toastEl = $('fp-toast');
    stageLabel = $('fp-stage-label'); stageVar = $('fp-stage-var');
    nameIn = $('fp-name'); creatorIn = $('fp-creator'); ratingIn = $('fp-rating'); playersIn = $('fp-players');
    dropzone = $('fp-dropzone'); fileInput = $('fp-file');
    iconDrop = $('fp-icon-drop'); iconFile = $('fp-icon-file'); iconPrev = $('fp-icon-prev');
    iconSrc = $('fp-icon-src'); iconMine = $('fp-icon-mine'); iconRemove = $('fp-icon-remove'); iconCropBtn = $('fp-icon-crop');
    varRow = $('fp-variants'); varAdd = $('fp-var-add'); varFile = $('fp-var-file');
    varPrev = $('fp-var-prev'); varNext = $('fp-var-next'); varLabel = $('fp-var-label');
    sidebarT = $('fp-sidebar'); genreSel = $('fp-genre'); shuffleBtn = $('fp-shuffle');
    slotVal = $('fp-slot-v'); slotReset = $('fp-slot-reset');
    distIn = $('fp-distance'); distVal = $('fp-distance-v'); squintIn = $('fp-squint'); squintVal = $('fp-squint-v');
    grayT = $('fp-gray');
    hlT = $('fp-highlight'); exportBtn = $('fp-export'); copyBtn = $('fp-copy'); fnameEl = $('fp-fname');
    feedInfo = $('fp-feed-info');

    var required = [stage, lens, device, viewport, nameIn, creatorIn, ratingIn, playersIn, dropzone, fileInput,
      iconDrop, iconFile, iconPrev, iconSrc, iconMine, iconRemove, iconCropBtn, varRow, varAdd, varFile, varPrev, varNext, sidebarT, genreSel, shuffleBtn,
      slotReset, distIn, squintIn, grayT, hlT, exportBtn, copyBtn];
    for (var i = 0; i < required.length; i++) if (!required[i]) return;

    feed = readFeed();
    buildGenres();
    feedLine();
    buildZoomToggle();
    wire();
    syncControls();
    renderVariantChips();
    renderIcon();
    render();
    if (!window.Hub || isActive()) activate();

    // placeholders drawn before the label font loaded: redraw once it lands
    var fs = document.fonts;
    if (fs) {
      if (fs.addEventListener) fs.addEventListener('loadingdone', refreshPh);
      if (fs.ready && fs.ready.then) fs.ready.then(refreshPh, noop);
    }
    // font never arriving (offline / blocked): stop redrawing placeholders on every render
    setTimeout(function () { phSettled = true; }, 8000);

    restoreState().then(function () {
      restored = true;
      if (S.genre !== 'all' && !feed.genres.some(function (g) { return g.id === S.genre; })) S.genre = 'all';
      poolCache = null;
      syncControls();
      renderVariantChips();
      renderIcon();
      render();
      drainInbox();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
