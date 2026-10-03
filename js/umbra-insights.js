/* =========================================================================
   UMBRA INSIGHTS — small image helpers shared by the frontpage tool
   stats() · compare() · squareCrop() · placeholder(). Native canvas only,
   no deps. Nothing here throws: unreadable pixels give null, a missing DOM
   gives null / ''. Exposes window.UmbraInsights.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---------- config ---------- */
  var SAMPLE = 128;              // longest edge sampled by stats()
  var MAX_SIDE = 4096;           // safety cap for generated canvases
  var DARK_FLOOR = 12;           // below this max channel, hue is noise → saturation 0
  var COLORFUL_NORM = 200;       // Hasler–Süsstrunk M at which colorfulness reads 1 (roblox thumbs run hot)
  var DETAIL_NORM = 0.25;        // mean luminance gradient at which detail reads 1
  var FONT = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  var KEYS = ['saturation', 'contrast', 'brightness', 'colorfulness', 'detail'];
  var LABELS = {
    saturation: 'saturation', contrast: 'contrast', brightness: 'brightness',
    colorfulness: 'colorfulness', detail: 'detail'
  };
  // how much each metric counts towards "stands out" (sums to 1)
  var WEIGHTS = { colorfulness: 0.26, contrast: 0.24, saturation: 0.18, brightness: 0.18, detail: 0.14 };
  var TIPS = {
    colorfulness: 'try bolder colors', contrast: 'try more contrast', saturation: 'try more saturation',
    brightness: 'try brightening it', detail: 'try sharper details'
  };

  var hasDom = function () { return typeof document !== 'undefined' && !!document.createElement; };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var round = function (v, d) { var k = Math.pow(10, d); return Math.round(v * k) / k + 0; };   // + 0 drops -0
  var finite = function (v) { return typeof v === 'number' && isFinite(v); };

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // intrinsic size of an <img>, <canvas>, <video> or ImageBitmap (0 when not ready)
  function srcSize(src) {
    if (!src) return { w: 0, h: 0 };
    if (typeof src.naturalWidth === 'number') return { w: src.naturalWidth || 0, h: src.naturalHeight || 0 };
    if (typeof src.videoWidth === 'number') return { w: src.videoWidth || 0, h: src.videoHeight || 0 };
    return { w: +src.width || 0, h: +src.height || 0 };
  }

  /* draw a source region into ctx, halving in steps first so big downscales stay
     smooth in browsers that ignore imageSmoothingQuality */
  function drawScaled(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    var cur = src, cw = sw, ch = sh, cx = sx, cy = sy, flip = 0, tmp = [null, null];
    while (cw > dw * 2 && ch > dh * 2) {
      var nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2);
      var t = tmp[flip];
      if (!t) t = tmp[flip] = makeCanvas(nw, nh);
      else { t.width = nw; t.height = nh; }
      var tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
      cur = t; cx = 0; cy = 0; cw = nw; ch = nh; flip = 1 - flip;
    }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  }

  /* ---------- metrics (pure) ---------- */
  // rgba: Uint8ClampedArray-like (alpha ignored; stats() flattens onto black first)
  function measure(rgba, w, h) {
    w = w | 0; h = h | 0;
    var n = w * h;
    if (!n || !rgba || rgba.length < n * 4) return null;

    var lum = new Float32Array(n);
    var satSum = 0, lSum = 0, lSq = 0, rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx > DARK_FLOOR) satSum += (mx - mn) / mx;
      var l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lum[i] = l; lSum += l; lSq += l * l;
      var rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
    }

    var mean = lSum / n;
    var sd = Math.sqrt(Math.max(0, lSq / n - mean * mean));
    // Hasler & Süsstrunk (2003): σ_rgyb + 0.3·μ_rgyb on the opponent channels
    var mrg = rgSum / n, myb = ybSum / n;
    var vrg = Math.max(0, rgSq / n - mrg * mrg), vyb = Math.max(0, ybSq / n - myb * myb);
    var M = Math.sqrt(vrg + vyb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);

    // detail: mean gradient magnitude (forward differences on luminance)
    var gSum = 0, gN = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x;
        var hasX = x + 1 < w, hasY = y + 1 < h;
        if (!hasX && !hasY) continue;
        var gx = hasX ? lum[k + 1] - lum[k] : 0;
        var gy = hasY ? lum[k + w] - lum[k] : 0;
        gSum += Math.sqrt(gx * gx + gy * gy); gN++;
      }
    }

    return {
      saturation:   round(clamp(satSum / n, 0, 1), 4),
      contrast:     round(clamp(sd / 0.5, 0, 1), 4),      // 0.5 = the largest possible σ
      brightness:   round(clamp(mean, 0, 1), 4),
      colorfulness: round(clamp(M / COLORFUL_NORM, 0, 1), 4),
      detail:       round(clamp(gN ? gSum / gN / DETAIL_NORM : 0, 0, 1), 4)
    };
  }

  /* ---------- stats ---------- */
  var work = null, workCtx = null;     // reused sampler; dropped once tainted
  var statCache = new Map();           // remote url → stats (neighbors repeat a lot)

  function stats(src) {
    try {
      if (!hasDom()) return null;
      var s = srcSize(src);
      if (!s.w || !s.h) return null;

      var key = null;
      if (src.tagName === 'IMG') {
        key = src.currentSrc || src.src || '';
        if (key.length > 2048) key = null;   // skip data urls — don't pin big strings
        else if (key && statCache.has(key)) return Object.assign({}, statCache.get(key));
      }

      var k = Math.min(1, SAMPLE / Math.max(s.w, s.h));
      var w = Math.max(1, Math.round(s.w * k)), h = Math.max(1, Math.round(s.h * k));
      if (!work) {
        work = makeCanvas(w, h);
        workCtx = work.getContext('2d', { willReadFrequently: true });
      } else { work.width = w; work.height = h; }
      if (!workCtx) return null;

      workCtx.fillStyle = '#000';
      workCtx.fillRect(0, 0, w, h);
      var data;
      try {
        drawScaled(workCtx, src, 0, 0, s.w, s.h, 0, 0, w, h);
        data = workCtx.getImageData(0, 0, w, h).data;
      } catch (err) {
        // tainted (no CORS) or broken image — a tainted canvas never recovers
        work = null; workCtx = null;
        return null;
      }

      var out = measure(data, w, h);
      if (key && out) {
        if (statCache.size > 400) statCache.delete(statCache.keys().next().value);
        statCache.set(key, Object.assign({}, out));
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  /* ---------- compare (pure) ---------- */
  function usable(st) {
    if (!st || typeof st !== 'object') return false;
    for (var i = 0; i < KEYS.length; i++) if (!finite(st[KEYS[i]])) return false;
    return true;
  }

  // relative gap, stabilised for tiny averages
  function rel(mine, avg) { return (mine - avg) / Math.max(avg, 0.05); }

  /* signed pull of one metric in -1..1. Brightness is not a "more is better"
     metric: near-or-above the neighbors is fine (small bonus), darker is penalised. */
  function pull(key, r) {
    if (key === 'brightness') {
      if (r >= -0.1) return 0.25 * Math.tanh(Math.max(0, r) / 0.5);
      return -Math.tanh(-(r + 0.1) / 0.25);
    }
    return Math.tanh(r / 0.4);
  }

  function scoreOf(st, avg) {
    var sum = 0;
    for (var i = 0; i < KEYS.length; i++) {
      var key = KEYS[i];
      sum += WEIGHTS[key] * pull(key, rel(st[key], avg[key]));
    }
    return clamp(Math.round(50 + 50 * sum), 0, 100);
  }

  function compare(mine, others) {
    var list = [];
    if (others && typeof others.length === 'number') {
      for (var i = 0; i < others.length; i++) if (usable(others[i])) list.push(others[i]);
    }
    if (!list.length) return { metrics: [], score: null, verdict: 'no neighbor data', count: 0 };
    if (!usable(mine)) return { metrics: [], score: null, verdict: 'cannot read your image', count: list.length };

    var avg = {}, metrics = [], worst = null, worstV = Infinity;
    KEYS.forEach(function (key) {
      var s = 0;
      for (var j = 0; j < list.length; j++) s += list[j][key];
      avg[key] = s / list.length;
      var d = (mine[key] - avg[key]) / Math.max(avg[key], 1e-6) * 100;
      metrics.push({
        key: key,
        label: LABELS[key],
        mine: round(mine[key], 4),
        avg: round(avg[key], 4),
        deltaPct: round(clamp(d, -999, 999), 1)    // clamped so near-zero averages can't explode the ui
      });
      var c = WEIGHTS[key] * pull(key, rel(mine[key], avg[key]));
      if (c < worstV) { worstV = c; worst = key; }
    });

    var score = scoreOf(mine, avg);
    // share of neighbors that score below you against the same average
    var beaten = 0;
    for (var n = 0; n < list.length; n++) if (scoreOf(list[n], avg) < score) beaten++;
    var share = beaten / list.length;
    var tip = worstV < -0.02 ? TIPS[worst] : '';

    var verdict;
    if (score >= 70 && share >= 0.7) verdict = share === 1 && list.length > 2 ? 'pops more than every neighbor' : 'pops more than most neighbors';
    else if (score >= 70) verdict = 'stands out, but a few neighbors pop harder';
    else if (score >= 60) verdict = tip ? 'stands out a bit — ' + tip : 'stands out a bit';
    else if (score >= 42) verdict = tip ? 'on par with neighbors — ' + tip : 'on par with neighbors';
    else verdict = 'blends in — ' + (tip || 'try more contrast');

    return { metrics: metrics, score: score, verdict: verdict, count: list.length };
  }

  /* ---------- square crop ---------- */
  // largest square centred on the focus (fx, fy in 0..1), clamped inside w × h
  function cropRect(w, h, fx, fy) {
    w = Math.max(0, +w || 0); h = Math.max(0, +h || 0);
    fx = finite(fx) ? clamp(fx, 0, 1) : 0.5;
    fy = finite(fy) ? clamp(fy, 0, 1) : 0.5;
    var s = Math.min(w, h);
    return {
      x: clamp(fx * w - s / 2, 0, w - s),
      y: clamp(fy * h - s / 2, 0, h - s),
      s: s
    };
  }

  function squareCrop(source, fx, fy, size) {
    try {
      if (!hasDom()) return null;
      var d = srcSize(source);
      var side = Math.min(d.w, d.h);
      size = Math.round(+size || 0);
      if (size <= 0) size = Math.round(side) || 1;
      size = clamp(size, 1, MAX_SIDE);
      var c = makeCanvas(size, size);
      if (!side) return c;
      var r = cropRect(d.w, d.h, fx, fy);
      var ctx = c.getContext('2d');
      try { drawScaled(ctx, source, r.x, r.y, r.s, r.s, 0, 0, size, size); } catch (err) { /* broken source → blank */ }
      return c;
    } catch (e) {
      return null;
    }
  }

  /* ---------- placeholder art ---------- */
  var phCache = new Map();

  function fontsReady() {
    try { return !document.fonts || document.fonts.check('12px "JetBrains Mono"'); } catch (e) { return true; }
  }

  function fitLabel(ctx, text, maxW, fs, minFs) {
    ctx.font = '500 ' + fs + 'px ' + FONT;
    while (fs > minFs && ctx.measureText(text).width > maxW) {
      fs--; ctx.font = '500 ' + fs + 'px ' + FONT;
    }
    if (ctx.measureText(text).width > maxW) {
      while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
      text = text.replace(/\s+$/, '') + '…';
    }
    return { text: text, fs: fs };
  }

  // an eclipse: light disc with an offset shadow disc cut out, faint corona ring
  function eclipse(ctx, cx, cy, r, W, H) {
    var glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 3.2);
    glow.addColorStop(0, 'rgba(255,255,255,0.07)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - r * 3.2, cy - r * 3.2, r * 6.4, r * 6.4);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx + r * 0.42, cy - r * 0.3, r * 0.92, 0, Math.PI * 2, true);
    ctx.clip('evenodd');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(229,229,229,0.88)';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.stroke();
  }

  function placeholder(w, h, label) {
    w = clamp(Math.round(+w || 768), 1, MAX_SIDE);
    h = clamp(Math.round(+h || 432), 1, MAX_SIDE);
    label = label == null ? '' : String(label).trim();
    var key = w + 'x' + h + '|' + label;
    if (phCache.has(key)) return phCache.get(key);
    if (!hasDom()) return '';

    try {
      var c = makeCanvas(w, h), ctx = c.getContext('2d');
      var m = Math.min(w, h), L = Math.max(w, h);

      // near-black diagonal base + a soft top-left light
      var base = ctx.createLinearGradient(0, 0, w, h);
      base.addColorStop(0, '#171717');
      base.addColorStop(0.55, '#0a0a0a');
      base.addColorStop(1, '#030303');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      var lite = ctx.createRadialGradient(w * 0.28, h * 0.2, 0, w * 0.28, h * 0.2, L * 0.75);
      lite.addColorStop(0, 'rgba(255,255,255,0.055)');
      lite.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lite;
      ctx.fillRect(0, 0, w, h);

      // faint grid, centred so it stays symmetric at any size
      var step = Math.max(8, Math.round(m / 7));
      var x, y;
      ctx.beginPath();
      for (x = (w / 2) % step; x <= w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
      for (y = (h / 2) % step; y <= h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.stroke();

      // vignette
      var vig = ctx.createRadialGradient(w / 2, h / 2, m * 0.25, w / 2, h / 2, L * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);

      // crop marks
      var pad = Math.max(3, Math.round(m * 0.07)), arm = Math.max(3, Math.round(m * 0.06));
      ctx.lineWidth = Math.max(1, Math.round(m / 220));
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.beginPath();
      [[pad, pad, 1, 1], [w - pad, pad, -1, 1], [pad, h - pad, 1, -1], [w - pad, h - pad, -1, -1]].forEach(function (q) {
        ctx.moveTo(q[0] + arm * q[2], q[1]); ctx.lineTo(q[0], q[1]); ctx.lineTo(q[0], q[1] + arm * q[3]);
      });
      ctx.stroke();

      // glyph + label
      var showLabel = label && m >= 24;
      var r = m * (showLabel ? 0.11 : 0.15);
      var fs = clamp(Math.round(m * 0.075), 8, 40);
      var cy = showLabel ? h / 2 - fs * 0.75 : h / 2;
      eclipse(ctx, w / 2, cy, r, w, h);

      if (showLabel) {
        var fit = fitLabel(ctx, label, w * 0.84, fs, 8);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0.04em';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(230,230,230,0.8)';
        ctx.fillText(fit.text, w / 2, cy + r + fit.fs * 1.15);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      }

      // tiny maker's mark
      if (m >= 140) {
        var ms = clamp(Math.round(m * 0.04), 8, 14);
        ctx.font = '400 ' + ms + 'px ' + FONT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillText('umbra', w - pad - arm * 0.5, h - pad - arm * 0.5);
      }

      var url = c.toDataURL('image/png');
      if (!label || fontsReady()) {
        if (phCache.size > 48) phCache.delete(phCache.keys().next().value);
        phCache.set(key, url);
      }
      return url;
    } catch (e) {
      return '';
    }
  }

  root.UmbraInsights = {
    stats: stats,
    compare: compare,
    squareCrop: squareCrop,
    placeholder: placeholder,
    cropRect: cropRect,      // pure helpers, handy for focus overlays + tests
    measure: measure
  };
})(typeof window !== 'undefined' ? window : this);
