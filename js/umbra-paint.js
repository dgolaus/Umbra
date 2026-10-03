/* =========================================================================
   UMBRA PAINT — rasterize the visible client area of a live DOM subtree
   onto a native <canvas>. No html2canvas, no foreignObject: it walks the
   DOM and redraws a supported subset with the 2d context.

   API  UmbraPaint.paint(rootEl, { scale = 2, background = null,
                                   skipSelector = '[data-paint="skip"]' })
        → Promise<HTMLCanvasElement>

   Supported
   - background-color (alpha), linear-gradient() and url() background layers
     (drawn once, no repeat), background-clip border/padding/content/text
   - per-corner (elliptical) border-radius, solid borders (any widths;
     differing side colours become mitred strips), dashed/dotted when uniform
   - opacity multiplied through ancestors (no true group compositing)
   - overflow hidden/auto/scroll/clip + contain:paint clipping, honouring
     inner scroll positions; only what is visible is painted
   - <img> (object-fit fill/cover/contain/none/scale-down, object-position,
     radius clip, awaits decode), <canvas>, <video>, inline <svg> (computed
     styles inlined, serialized to a data-URL image)
   - text: per-word Range rects grouped into lines, computed font / colour /
     letter-spacing / text-transform / text-decoration (own parent only),
     white-space:nowrap, approximate "…"
     for text-overflow:ellipsis and -webkit-line-clamp
   - input / textarea / select values (or placeholders)
   - a uniform scale transform on an ancestor of the root (layout size wins)

   Not supported (by design): z-index and stacking contexts — paint order is
   DOM order, with the one CSS rule that positioned children paint after
   their in-flow siblings (z<0 first, z>0 last, per parent only);
   transforms inside the root, CSS filters, box-shadow, text-shadow,
   outlines, ::before/::after content, shadow DOM, radial/conic gradients,
   background-repeat, iframes. display:none, visibility:hidden, opacity 0
   and skipSelector subtrees are skipped. Pixels that would taint the canvas
   (cross-origin images without CORS, local files on file://) are skipped.
   One bad node never throws the whole paint.
   ========================================================================= */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var LOAD_TIMEOUT = 4000;    // per image / svg load
  var DECODE_WAIT = 300;      // extra grace for img.decode() once loaded
  var FONT_TIMEOUT = 3000;
  var MAX_SIDE = 16384, MAX_AREA = 1.2e8;
  var K_EASE = 0.5522847498;  // bezier constant for quarter ellipses

  var SKIP_TAGS = { script: 1, style: 1, template: 1, noscript: 1, link: 1, meta: 1, head: 1, title: 1, base: 1,
                    iframe: 1, object: 1, embed: 1, audio: 1, map: 1, area: 1, datalist: 1, br: 1, wbr: 1 };
  var REPLACED = { img: 1, canvas: 1, video: 1 };
  var CONTROLS = { input: 1, textarea: 1, select: 1 };
  var SVG_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
                   'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'visibility',
                   'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
                   'dominant-baseline', 'letter-spacing', 'clip-rule', 'clip-path', 'mask', 'marker-start', 'marker-mid',
                   'marker-end', 'paint-order', 'vector-effect', 'color'];
  var SVG_ROOT_SKIP = { opacity: 1, visibility: 1 };

  var bgCache = {};    // url → Promise<HTMLImageElement|null> (failures are evicted)
  var svgCache = {};   // serialized markup → Promise<HTMLImageElement|null>

  /* ---------- small helpers ---------- */
  function px(v, k) { var n = parseFloat(v); return isNaN(n) ? 0 : n * k; }
  function max0(v) { return v > 0 ? v : 0; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function ratio(a, b) { return b > 0 ? a / b : 1; }

  function lenOf(v, ref, k) {   // "12px" | "50%" → viewport units
    if (!v) return 0;
    var n = parseFloat(v);
    if (isNaN(n)) return 0;
    return /%\s*$/.test(v) ? ref * n / 100 : n * k;
  }

  function posLen(v, free, k) { // one object-/background-position component
    v = String(v || '50%').trim();
    if (v === 'left' || v === 'top') return 0;
    if (v === 'center') return free / 2;
    if (v === 'right' || v === 'bottom') return free;
    if (/%$/.test(v)) return free * parseFloat(v) / 100;
    var n = parseFloat(v);
    return isNaN(n) ? free / 2 : n * k;
  }

  function colorAlpha(c) {
    if (!c || c === 'transparent') return 0;
    var i = c.indexOf('/');
    if (i >= 0) return parseAlpha(c.slice(i + 1));
    var m = c.match(/^(rgba?|hsla?)\(([^)]*)\)/i);
    if (m) {
      var p = m[2].split(',');
      if (p.length === 4) return parseAlpha(p[3]);
    }
    return 1;
  }
  function parseAlpha(s) {
    s = s.replace(')', '').trim();
    var v = parseFloat(s);
    if (isNaN(v)) return 1;
    return s.indexOf('%') >= 0 ? v / 100 : v;
  }

  function hit(b, c) { return b.x < c.r && b.x + b.w > c.l && b.y < c.b && b.y + b.h > c.t; }

  function inset(b, t, r, bo, l) {
    return { x: b.x + l, y: b.y + t, w: max0(b.w - l - r), h: max0(b.h - t - bo) };
  }

  function bordersOf(cs, k) {
    return { t: px(cs.borderTopWidth, k), r: px(cs.borderRightWidth, k),
             b: px(cs.borderBottomWidth, k), l: px(cs.borderLeftWidth, k) };
  }
  function paddingOf(cs, k) {
    return { t: px(cs.paddingTop, k), r: px(cs.paddingRight, k),
             b: px(cs.paddingBottom, k), l: px(cs.paddingLeft, k) };
  }

  function splitTop(s) {        // split on commas at paren depth 0
    var out = [], depth = 0, cur = '';
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function within(p, ms) {      // resolves true/false, never rejects, never hangs
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(false); } }, ms);
      Promise.resolve(p).then(
        function () { if (!done) { done = true; clearTimeout(t); res(true); } },
        function () { if (!done) { done = true; clearTimeout(t); res(false); } });
    });
  }

  function safeMatches(el, sel) {
    try { return !!(el.matches && el.matches(sel)); } catch (e) { return false; }
  }

  // a fresh 1×1 probe per check: once a canvas is tainted it stays tainted
  function isClean(src) {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      var x = c.getContext('2d');
      x.drawImage(src, 0, 0, 1, 1);
      x.getImageData(0, 0, 1, 1);
      return true;
    } catch (e) { return false; }
  }

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }

  /* ---------- border radius + paths ---------- */
  function radii(cs, b, k) {
    function corner(v) {
      var p = String(v || '0').trim().split(/\s+/);
      return [max0(lenOf(p[0], b.w, k)), max0(lenOf(p[1] || p[0], b.h, k))];
    }
    return fitRadii({
      tl: corner(cs.borderTopLeftRadius), tr: corner(cs.borderTopRightRadius),
      br: corner(cs.borderBottomRightRadius), bl: corner(cs.borderBottomLeftRadius)
    }, b.w, b.h);
  }

  // CSS overlap rule: scale every radius down by the worst side
  function fitRadii(R, w, h) {
    var f = Math.min(1, ratio(w, R.tl[0] + R.tr[0]), ratio(w, R.bl[0] + R.br[0]),
                        ratio(h, R.tl[1] + R.bl[1]), ratio(h, R.tr[1] + R.br[1]));
    if (f >= 1) return R;
    return { tl: [R.tl[0] * f, R.tl[1] * f], tr: [R.tr[0] * f, R.tr[1] * f],
             br: [R.br[0] * f, R.br[1] * f], bl: [R.bl[0] * f, R.bl[1] * f] };
  }

  function insetRadii(R, t, r, b, l) {
    return { tl: [max0(R.tl[0] - l), max0(R.tl[1] - t)], tr: [max0(R.tr[0] - r), max0(R.tr[1] - t)],
             br: [max0(R.br[0] - r), max0(R.br[1] - b)], bl: [max0(R.bl[0] - l), max0(R.bl[1] - b)] };
  }

  function hasRadius(R) {
    return !!R && (R.tl[0] > 0 || R.tr[0] > 0 || R.br[0] > 0 || R.bl[0] > 0);
  }

  function pathTo(ctx, b, R) {  // adds a sub-path (no beginPath)
    var x = b.x, y = b.y, w = b.w, h = b.h;
    if (!hasRadius(R)) { ctx.rect(x, y, w, h); return; }
    R = fitRadii(R, w, h);
    var tl = R.tl, tr = R.tr, br = R.br, bl = R.bl, K = K_EASE;
    ctx.moveTo(x + tl[0], y);
    ctx.lineTo(x + w - tr[0], y);
    ctx.bezierCurveTo(x + w - tr[0] + tr[0] * K, y, x + w, y + tr[1] - tr[1] * K, x + w, y + tr[1]);
    ctx.lineTo(x + w, y + h - br[1]);
    ctx.bezierCurveTo(x + w, y + h - br[1] + br[1] * K, x + w - br[0] + br[0] * K, y + h, x + w - br[0], y + h);
    ctx.lineTo(x + bl[0], y + h);
    ctx.bezierCurveTo(x + bl[0] - bl[0] * K, y + h, x, y + h - bl[1] + bl[1] * K, x, y + h - bl[1]);
    ctx.lineTo(x, y + tl[1]);
    ctx.bezierCurveTo(x, y + tl[1] - tl[1] * K, x + tl[0] - tl[0] * K, y, x + tl[0], y);
    ctx.closePath();
  }

  function boxPath(ctx, b, R) { ctx.beginPath(); pathTo(ctx, b, R); }

  /* ---------- backgrounds ---------- */
  function linearGradient(ctx, src, b, k) {
    var open = src.indexOf('('), close = src.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    var args = splitTop(src.slice(open + 1, close));
    if (!args.length) return null;
    var dx = 0, dy = 1, first = args[0], m;
    if (/^to\s/.test(first)) {
      var sx = /right/.test(first) ? 1 : (/left/.test(first) ? -1 : 0);
      var sy = /bottom/.test(first) ? 1 : (/top/.test(first) ? -1 : 0);
      if (sx && sy) { dx = sx * b.h; dy = sy * b.w; } else { dx = sx; dy = sy; }
      args.shift();
    } else if ((m = first.match(/^(-?[\d.]+)(deg|rad|turn|grad)$/))) {
      var a = parseFloat(m[1]);
      a = m[2] === 'rad' ? a : m[2] === 'turn' ? a * 2 * Math.PI : m[2] === 'grad' ? a * Math.PI / 200 : a * Math.PI / 180;
      dx = Math.sin(a); dy = -Math.cos(a);
      args.shift();
    }
    var n = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= n; dy /= n;
    var L = Math.abs(b.w * dx) + Math.abs(b.h * dy);
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var g = ctx.createLinearGradient(cx - dx * L / 2, cy - dy * L / 2, cx + dx * L / 2, cy + dy * L / 2);

    var stops = [];
    args.forEach(function (s) {
      var col, rest, fm = s.match(/^([a-z-]+\([^)]*\))\s*(.*)$/i);
      if (fm) { col = fm[1]; rest = fm[2]; }
      else { var parts = s.split(/\s+/); col = parts[0]; rest = parts.slice(1).join(' '); }
      if (/^-?[\d.]+(px|%)?$/.test(col)) return;      // colour hint: ignored
      var ps = rest ? rest.split(/\s+/) : [];
      if (!ps.length) stops.push({ c: col, p: null });
      ps.forEach(function (p) {
        stops.push({ c: col, p: /%$/.test(p) ? parseFloat(p) / 100 : (L > 0 ? px(p, k) / L : 0) });
      });
    });
    if (!stops.length) return null;
    if (stops[0].p == null) stops[0].p = 0;
    if (stops[stops.length - 1].p == null) stops[stops.length - 1].p = 1;
    for (var i = 1; i < stops.length; i++) {
      if (stops[i].p != null) continue;
      var j = i;
      while (stops[j].p == null) j++;
      var p0 = stops[i - 1].p, step = (stops[j].p - p0) / (j - i + 1);
      for (var q = i; q < j; q++) stops[q].p = p0 + step * (q - i + 1);
    }
    var last = 0;
    stops.forEach(function (s) {
      last = Math.max(last, s.p);
      try { g.addColorStop(clamp01(last), s.c); } catch (e) { /* unparseable colour */ }
    });
    return g;
  }

  function areaFor(which, b, bw, pad) {
    if (which === 'padding-box') return inset(b, bw.t, bw.r, bw.b, bw.l);
    if (which === 'content-box') return inset(inset(b, bw.t, bw.r, bw.b, bw.l), pad.t, pad.r, pad.b, pad.l);
    return b;
  }

  function drawBgImage(ctx, img, area, size, posX, posY, k) {
    var nw = img.naturalWidth * k, nh = img.naturalHeight * k, dw, dh;
    if (!(nw > 0 && nh > 0)) return;
    size = String(size || 'auto').trim();
    if (size === 'cover' || size === 'contain') {
      var s = (size === 'cover' ? Math.max : Math.min)(area.w / nw, area.h / nh);
      dw = nw * s; dh = nh * s;
    } else {
      var p = size.split(/\s+/), a = p[0], c = p[1] || 'auto';
      dw = a === 'auto' ? null : lenOf(a, area.w, k);
      dh = c === 'auto' ? null : lenOf(c, area.h, k);
      if (dw == null && dh == null) { dw = nw; dh = nh; }
      else if (dw == null) dw = dh * nw / nh;
      else if (dh == null) dh = dw * nh / nw;
    }
    ctx.drawImage(img, area.x + posLen(posX, area.w - dw, k), area.y + posLen(posY, area.h - dh, k), dw, dh);
  }

  function urlOf(layer) {
    var m = layer.match(/^url\(\s*(["']?)(.*?)\1\s*\)$/);
    return m ? m[2] : null;
  }

  function paintBackground(P, cs, b, bw, R) {
    var ctx = P.ctx, k = P.k, pad = paddingOf(cs, k);
    var clip = cs.backgroundClip || cs.webkitBackgroundClip || 'border-box';
    if (clip === 'text') return;                     // handled as a text fill
    var cb = areaFor(clip, b, bw, pad);
    var cR = clip === 'border-box' ? R : insetRadii(R, bw.t, bw.r, bw.b, bw.l);
    if (clip === 'content-box') cR = insetRadii(cR, pad.t, pad.r, pad.b, pad.l);

    var bg = cs.backgroundColor;
    if (colorAlpha(bg) > 0) { boxPath(ctx, cb, cR); ctx.fillStyle = bg; ctx.fill(); }

    var bi = cs.backgroundImage;
    if (!bi || bi === 'none') return;
    var layers = splitTop(bi), sizes = splitTop(cs.backgroundSize),
        xs = splitTop(cs.backgroundPositionX), ys = splitTop(cs.backgroundPositionY),
        origins = splitTop(cs.backgroundOrigin);
    ctx.save();
    boxPath(ctx, cb, cR);
    ctx.clip();
    for (var i = layers.length - 1; i >= 0; i--) {   // first layer is on top
      try {
        var L = layers[i], area = areaFor(origins[i] || origins[0] || 'padding-box', b, bw, pad);
        if (/^(repeating-)?linear-gradient\(/.test(L)) {
          var g = linearGradient(ctx, L, area, k);
          if (g) { ctx.fillStyle = g; ctx.fillRect(cb.x, cb.y, cb.w, cb.h); }
        } else {
          var url = urlOf(L), img = url && P.bg[url];
          if (img) drawBgImage(ctx, img, area, sizes[i] || sizes[0], xs[i] || xs[0], ys[i] || ys[0], k);
        }
      } catch (e) { /* skip this layer */ }
    }
    ctx.restore();
  }

  // background-clip:text → the text itself gets the gradient (or colour)
  function textFillFor(P, cs, b) {
    var layers = splitTop(cs.backgroundImage);
    for (var i = 0; i < layers.length; i++) {
      if (/^(repeating-)?linear-gradient\(/.test(layers[i])) {
        var g = linearGradient(P.ctx, layers[i], b, P.k);
        if (g) return g;
      }
    }
    return colorAlpha(cs.backgroundColor) > 0 ? cs.backgroundColor : null;
  }

  /* ---------- borders ---------- */
  function paintBorders(ctx, cs, b, bw, R) {
    if (!(bw.t || bw.r || bw.b || bw.l)) return;
    var sides = [
      { w: bw.t, s: cs.borderTopStyle, c: cs.borderTopColor },
      { w: bw.r, s: cs.borderRightStyle, c: cs.borderRightColor },
      { w: bw.b, s: cs.borderBottomStyle, c: cs.borderBottomColor },
      { w: bw.l, s: cs.borderLeftStyle, c: cs.borderLeftColor }
    ];
    var live = sides.filter(function (s) { return s.w > 0 && s.s !== 'none' && s.s !== 'hidden' && colorAlpha(s.c) > 0; });
    if (!live.length) return;
    var inner = inset(b, bw.t, bw.r, bw.b, bw.l), iR = insetRadii(R, bw.t, bw.r, bw.b, bw.l);
    var uniform = live.length === 4 && sides.every(function (s) { return s.w === sides[0].w && s.s === sides[0].s && s.c === sides[0].c; });

    ctx.save();
    if (uniform && (sides[0].s === 'dashed' || sides[0].s === 'dotted')) {
      var w = sides[0].w;
      boxPath(ctx, inset(b, w / 2, w / 2, w / 2, w / 2), insetRadii(R, w / 2, w / 2, w / 2, w / 2));
      ctx.lineWidth = w;
      ctx.strokeStyle = sides[0].c;
      if (ctx.setLineDash) ctx.setLineDash(sides[0].s === 'dotted' ? [w, w] : [w * 3, w * 2]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    // ring = outer path minus inner path (exact for any radii and widths)
    ctx.beginPath();
    pathTo(ctx, b, R);
    pathTo(ctx, inner, iR);
    // the ring covers every side with width, so the single-fill fast path is only
    // safe when none of those sides was dropped (e.g. a transparent side)
    var wide = sides.filter(function (s) { return s.w > 0; }).length;
    var oneColor = live.length === wide && live.every(function (s) { return s.c === live[0].c; });
    if (oneColor) {
      ctx.fillStyle = live[0].c;
      ctx.fill('evenodd');
    } else {
      ctx.clip('evenodd');
      var x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h, ix0 = inner.x, iy0 = inner.y, ix1 = inner.x + inner.w, iy1 = inner.y + inner.h;
      var quads = [
        [x0, y0, x1, y0, ix1, iy0, ix0, iy0],
        [x1, y0, x1, y1, ix1, iy1, ix1, iy0],
        [x1, y1, x0, y1, ix0, iy1, ix1, iy1],
        [x0, y1, x0, y0, ix0, iy0, ix0, iy1]
      ];
      sides.forEach(function (s, i) {
        if (live.indexOf(s) < 0) return;
        var q = quads[i];
        ctx.beginPath();
        ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); ctx.lineTo(q[4], q[5]); ctx.lineTo(q[6], q[7]);
        ctx.closePath();
        ctx.fillStyle = s.c;
        ctx.fill();
      });
    }
    ctx.restore();
  }

  function paintBox(P, cs, b, flat) {
    var bw = bordersOf(cs, P.k), R = flat ? null : radii(cs, b, P.k);
    if (!R) R = { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] };
    paintBackground(P, cs, b, bw, R);
    paintBorders(P.ctx, cs, b, bw, R);
  }

  /* ---------- replaced content ---------- */
  function fitRect(cs, cb, nw, nh, k) {
    var fit = cs.objectFit || 'fill', s;
    if (!(nw > 0 && nh > 0) || fit === 'fill') return cb;
    if (fit === 'contain') s = Math.min(cb.w / nw, cb.h / nh);
    else if (fit === 'cover') s = Math.max(cb.w / nw, cb.h / nh);
    else if (fit === 'none') s = k;
    else if (fit === 'scale-down') s = Math.min(k, cb.w / nw, cb.h / nh);
    else return cb;
    var dw = nw * s, dh = nh * s, pos = String(cs.objectPosition || '50% 50%').trim().split(/\s+/);
    return { x: cb.x + posLen(pos[0], cb.w - dw, k), y: cb.y + posLen(pos[1] || '50%', cb.h - dh, k), w: dw, h: dh };
  }

  function drawReplaced(P, el, cs, b) {
    var ctx = P.ctx, k = P.k, ln = el.localName, src, nw = 0, nh = 0;
    if (ln === 'canvas') {
      if (!el.width || !el.height || !isClean(el)) return;
      src = el; nw = el.width; nh = el.height;
    } else if (ln === 'video') {
      if (el.readyState < 2 || !el.videoWidth || !isClean(el)) return;
      src = el; nw = el.videoWidth; nh = el.videoHeight;
    } else {
      src = P.res.get(el);
      if (!src) return;
      if (ln === 'img') { nw = src.naturalWidth; nh = src.naturalHeight; }
    }
    var bw = bordersOf(cs, k), pad = paddingOf(cs, k);
    var cb = inset(inset(b, bw.t, bw.r, bw.b, bw.l), pad.t, pad.r, pad.b, pad.l);
    if (cb.w <= 0 || cb.h <= 0) return;
    var R = insetRadii(insetRadii(radii(cs, b, k), bw.t, bw.r, bw.b, bw.l), pad.t, pad.r, pad.b, pad.l);
    var d = ln === 'svg' ? cb : fitRect(cs, cb, nw, nh, k);
    ctx.save();
    boxPath(ctx, cb, R);
    ctx.clip();
    ctx.drawImage(src, d.x, d.y, d.w, d.h);
    ctx.restore();
  }

  /* ---------- text ---------- */
  function fontOf(cs, k) {
    var size = px(cs.fontSize, k) || 16 * k;
    var fs = cs.fontStyle || 'normal';
    var style = fs === 'normal' ? '' : (fs.indexOf('oblique') === 0 ? 'oblique ' : fs + ' ');
    var caps = cs.fontVariantCaps === 'small-caps' ? 'small-caps ' : '';
    return style + caps + (cs.fontWeight || '400') + ' ' + size + 'px ' + (cs.fontFamily || 'sans-serif');
  }

  function setupFont(ctx, cs, k) {
    // vertical metrics come back integer-rounded at the requested size, so measure them at
    // layout size and scale — the baseline then matches the DOM whatever the ancestor scale
    ctx.font = fontOf(cs, 1);
    var m = ctx.measureText('Hg'), asc = m.fontBoundingBoxAscent * k, desc = m.fontBoundingBoxDescent * k;
    ctx.font = fontOf(cs, k);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if ('letterSpacing' in ctx) {
      var ls = cs.letterSpacing;
      ctx.letterSpacing = ls && ls !== 'normal' ? (px(ls, k) + 'px') : '0px';
    }
    if (!(asc > 0)) { var size = px(cs.fontSize, k) || 16 * k; asc = size * 0.8; desc = size * 0.2; }
    return { asc: asc, desc: desc || 0 };
  }

  function transformText(s, tt, wordStart) {
    if (tt === 'uppercase') return s.toUpperCase();
    if (tt === 'lowercase') return s.toLowerCase();
    if (tt === 'capitalize' && wordStart) return s.charAt(0).toUpperCase() + s.slice(1);
    return s;
  }

  function liveRects(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].width > 0 && list[i].height > 0) out.push(list[i]);
    return out;
  }

  // collapse rects on the same line that overlap or touch (chrome reports a word in an
  // ellipsized line twice — full + visible fragment — and font-fallback runs as pieces)
  function mergeLineRects(rs) {
    if (rs.length < 2) return rs;
    var out = [];
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i], hit = null;
      for (var j = 0; j < out.length; j++) {
        var o = out[j];
        if (Math.abs(o.top - r.top) < 1 && r.left <= o.left + o.width + 0.5 && o.left <= r.left + r.width + 0.5) { hit = o; break; }
      }
      if (hit) {
        var l = Math.min(hit.left, r.left), rt = Math.max(hit.left + hit.width, r.left + r.width);
        hit.left = l; hit.width = rt - l;
        hit.height = Math.max(hit.height, r.height);
      } else out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    return out;
  }

  // length (utf-16 units) of the grapheme cluster starting at i: keeps VS16 / ZWJ /
  // skin-tone / combining-mark sequences together so emoji keep their presentation
  var segmenter = null;
  try { if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch (e) { segmenter = null; }
  function cpLen(text, i) { return text.codePointAt(i) > 0xffff ? 2 : 1; }
  function isExtender(cp) {
    return cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d || cp === 0x20e3 ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xe0020 && cp <= 0xe007f);
  }
  function clusterLen(text, i) {
    var n = cpLen(text, i);
    while (i + n < text.length) {
      var cp = text.codePointAt(i + n);
      if (cp === 0x200d) {
        n += 1;
        if (i + n < text.length) n += cpLen(text, i + n);
      } else if (isExtender(cp)) n += cpLen(text, i + n);
      else break;
    }
    return n;
  }
  function graphemes(s) {
    if (segmenter) {
      try { return Array.from(segmenter.segment(s), function (g) { return g.segment; }); } catch (e) {}
    }
    var out = [];
    for (var i = 0; i < s.length;) { var n = clusterLen(s, i); out.push(s.substr(i, n)); i += n; }
    return out;
  }

  function wordRects(P, node, text, tt) {
    var out = [], re = /\S+/g, range = P.range, m;
    while ((m = re.exec(text))) {
      var s = m.index, e = s + m[0].length;
      range.setStart(node, s);
      range.setEnd(node, e);
      var rs = mergeLineRects(liveRects(range.getClientRects()));
      if (rs.length === 1) {
        out.push({ x: rs[0].left, y: rs[0].top, w: rs[0].width, h: rs[0].height, str: transformText(m[0], tt, true) });
      } else if (rs.length > 1) {
        // word broken across lines: fall back to per-grapheme rects
        var parts = graphemes(m[0]);
        for (var p = 0, i = s; p < parts.length; p++) {
          var n = parts[p].length;
          range.setStart(node, i);
          range.setEnd(node, i + n);
          var cr = liveRects(range.getClientRects());
          if (cr.length) out.push({ x: cr[0].left, y: cr[0].top, w: cr[0].width, h: cr[0].height,
                                    str: transformText(text.substr(i, n), tt, i === s) });
          i += n;
        }
      }
    }
    return out;
  }

  function groupLines(words, nowrap) {
    var lines = [], cur = null;
    words.forEach(function (w) {
      if (!cur || (!nowrap && (Math.abs(w.y - cur.t) > cur.h * 0.5 || w.x < cur.right - 1))) {
        cur = { t: w.y, h: w.h, b: w.y + w.h, right: w.x + w.w, words: [] };
        lines.push(cur);
      }
      cur.words.push(w);
      cur.right = w.x + w.w;
      cur.b = Math.max(cur.b, w.y + w.h);
    });
    return lines;
  }

  function paintText(P, node, cs, st) {
    var text = node.nodeValue;
    if (!text || !/\S/.test(text)) return;
    var ctx = P.ctx, k = P.k, cl = st.clip;

    // whole node off-screen (scrolled away / clipped) → skip cheaply
    P.range.selectNodeContents(node);
    var nb = P.range.getBoundingClientRect();
    if (!hit({ x: nb.left, y: nb.top, w: Math.max(nb.width, 1), h: Math.max(nb.height, 1) }, cl)) return;

    var fill = cs.webkitTextFillColor || cs.color;
    var fillStyle = fill;
    if (colorAlpha(fill) <= 0) { if (st.textFill) fillStyle = st.textFill; else return; }

    var words = wordRects(P, node, text, cs.textTransform);
    if (!words.length) return;
    ctx.globalAlpha = st.alpha;
    var fm = setupFont(ctx, cs, k);
    ctx.fillStyle = fillStyle;

    function base(w) { return w.y + (w.h - (fm.asc + fm.desc)) / 2 + fm.asc; }
    function draw(w) {
      if (w.x > cl.r || w.x + w.w < cl.l || w.y > cl.b || w.y + w.h < cl.t) return;
      ctx.fillText(w.str, w.x, base(w), w.w * 1.04 + 1);
    }

    var nowrap = cs.whiteSpace === 'nowrap' || cs.textWrapMode === 'nowrap';
    // half a LAYOUT px of ellipsis slack (rects are on-screen px, 1 layout px = k)
    var lines = groupLines(words, nowrap), ell = st.ell, tol = 0.5 * k;
    var deco = cs.textDecorationLine || '';
    if (!/underline|line-through|overline/.test(deco)) deco = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.b < cl.t || line.t > cl.b) continue;
      var lastW = line.words[line.words.length - 1];
      // when Chrome itself overflows the box, sub-pixel spill still cuts (no slack)
      var cut = ell && (lastW.x + lastW.w > ell.right + (ell.over ? 0 : tol) ||
                        (ell.clamp && lines[i + 1] && lines[i + 1].t >= ell.bottom - tol && line.b <= ell.bottom + tol));
      if (!cut) line.words.forEach(draw);
      else drawEllipsized(ctx, line.words, ell.right, base, draw, tol);
      if (deco) decorate(line, cut ? ell.right : Infinity);
    }

    // text-decoration on the text's own parent (not propagated from further up)
    function decorate(line, maxX) {
      var f = line.words[0], l = line.words[line.words.length - 1];
      var x1 = Math.min(l.x + l.w, maxX), th = Math.max(k, (px(cs.fontSize, k) || 16 * k) / 14), y0 = base(f);
      var dc = cs.textDecorationColor;
      ctx.fillStyle = dc && colorAlpha(dc) > 0 ? dc : fillStyle;
      if (/underline/.test(deco)) ctx.fillRect(f.x, y0 + th * 1.5, x1 - f.x, th);
      if (/line-through/.test(deco)) ctx.fillRect(f.x, y0 - fm.asc * 0.3 - th / 2, x1 - f.x, th);
      if (/overline/.test(deco)) ctx.fillRect(f.x, y0 - fm.asc, x1 - f.x, th);
      ctx.fillStyle = fillStyle;
    }
  }

  // approximate text-overflow: ellipsis — keep what fits with room for "…"
  function drawEllipsized(ctx, words, R, base, draw, tol) {
    if (!(tol >= 0)) tol = 0.5;
    var ew = ctx.measureText('…').width, prevEnd = -Infinity;
    for (var j = 0; j < words.length; j++) {
      var w = words[j];
      if (w.x + w.w <= R - ew + tol) { draw(w); prevEnd = w.x + w.w; continue; }
      var chars = graphemes(w.str), n = chars.length, pre = '';
      while (n > 0) {
        pre = chars.slice(0, n).join('');
        if (w.x + ctx.measureText(pre).width + ew <= R + tol) break;
        n--;
      }
      if (n === 0) pre = '';
      var ex = pre ? w.x + ctx.measureText(pre).width : Math.max(prevEnd, Math.min(w.x, R - ew));
      if (pre) ctx.fillText(pre, w.x, base(w));
      ctx.fillText('…', ex, base(w));
      return;
    }
    var lw = words[words.length - 1];     // line-clamp: everything fit, "…" trails
    ctx.fillText('…', lw.x + lw.w, base(lw));
  }

  /* ---------- form controls ---------- */
  function paintControl(P, el, cs, b, st) {
    var ctx = P.ctx, k = P.k, ln = el.localName, text = '', ph = false;
    if (ln === 'input') {
      var t = String(el.type || 'text').toLowerCase();
      if (/^(checkbox|radio|range|color|file|hidden|image)$/.test(t)) return;
      text = String(el.value || '');
      if (t === 'password') text = text.replace(/./g, '•');
      if (!text && el.placeholder) { text = el.placeholder; ph = true; }
    } else if (ln === 'textarea') {
      text = String(el.value || '');
      if (!text && el.placeholder) { text = el.placeholder; ph = true; }
    } else if (ln === 'select') {
      var o = el.options && el.options[el.selectedIndex];
      text = o ? o.text : '';
    }
    if (!text) return;
    text = transformText(text, cs.textTransform, true);

    var bw = bordersOf(cs, k), pad = paddingOf(cs, k);
    var pb = inset(b, bw.t, bw.r, bw.b, bw.l), cb = inset(pb, pad.t, pad.r, pad.b, pad.l);
    if (cb.w <= 0 || cb.h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pb.x, pb.y, pb.w, pb.h);
    ctx.clip();
    var fm = setupFont(ctx, cs, k), color = cs.webkitTextFillColor || cs.color;
    ctx.globalAlpha = st.alpha;
    if (ph) {
      var pc = null;
      try { pc = getComputedStyle(el, '::placeholder').color; } catch (e) { pc = null; }
      if (pc && pc !== color) color = pc; else ctx.globalAlpha = st.alpha * 0.5;
    }
    ctx.fillStyle = color;

    if (ln === 'textarea') {
      var size = px(cs.fontSize, k) || 16 * k;
      var lh = cs.lineHeight === 'normal' ? size * 1.2 : px(cs.lineHeight, k);
      var y = cb.y - el.scrollTop * k;
      text.split('\n').forEach(function (para) {
        var line = '';
        para.split(/(\s+)/).forEach(function (tok) {
          if (line && ctx.measureText(line + tok).width > cb.w && /\S/.test(tok)) {
            ctx.fillText(line, cb.x, y + (lh - (fm.asc + fm.desc)) / 2 + fm.asc);
            y += lh; line = tok;
          } else line += tok;
        });
        ctx.fillText(line, cb.x, y + (lh - (fm.asc + fm.desc)) / 2 + fm.asc);
        y += lh;
      });
    } else {
      var tw = ctx.measureText(text).width, al = cs.textAlign, x;
      if (al === 'center' || al === '-webkit-center') x = cb.x + (cb.w - tw) / 2;
      else if (al === 'right' || al === 'end' || al === '-webkit-right') x = cb.x + cb.w - tw;
      else x = cb.x - (el.scrollLeft || 0) * k;
      ctx.fillText(text, x, cb.y + (cb.h - (fm.asc + fm.desc)) / 2 + fm.asc);
    }
    ctx.restore();
  }

  /* ---------- tree walk ---------- */
  function isPositioned(cs) { return cs.position && cs.position !== 'static'; }
  function zOf(cs) { var z = parseInt(cs.zIndex, 10); return isNaN(z) ? 0 : z; }

  // CSS painting phases, per parent only: z<0 positioned, in-flow (DOM
  // order, text included), positioned z auto/0, z>0 positioned
  function walkChildren(P, el, cs, st, visibleText) {
    var neg = [], flow = [], pos = [], top = [];
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (visibleText) flow.push({ n: c }); continue; }
      if (c.nodeType !== 1) continue;
      var ccs = null;
      try { ccs = getComputedStyle(c); } catch (e) { continue; }
      var item = { n: c, cs: ccs };
      if (ccs && isPositioned(ccs)) {
        var z = zOf(ccs);
        item.z = z;
        if (z < 0) neg.push(item); else if (z > 0) top.push(item); else pos.push(item);
      } else flow.push(item);
    }
    var byZ = function (a, b) { return a.z - b.z; };
    stableSort(neg, byZ);
    stableSort(top, byZ);
    neg.concat(flow, pos, top).forEach(function (it) {
      if (it.n.nodeType === 3) {
        P.ctx.save();
        try { paintText(P, it.n, cs, st); } catch (e) { /* skip this text */ }
        finally { P.ctx.restore(); }
      } else paintEl(P, it.n, st, it.cs);
    });
  }

  function stableSort(arr, cmp) {
    arr.forEach(function (it, i) { it._i = i; });
    arr.sort(function (a, b) { return cmp(a, b) || a._i - b._i; });
  }

  function paintEl(P, el, st, cs) {
    var ctx = P.ctx, saved = false;
    try {
      if (!cs) cs = getComputedStyle(el);
      if (!cs || cs.display === 'none') return;
      var ln = el.localName;
      if (SKIP_TAGS[ln]) return;
      if (P.skip && safeMatches(el, P.skip)) return;
      var isSvg = el.namespaceURI === SVG_NS;
      if (isSvg && ln !== 'svg') return;
      if (cs.display === 'contents') { walkChildren(P, el, cs, st, cs.visibility === 'visible'); return; }

      var op = parseFloat(cs.opacity), alpha = st.alpha * (isNaN(op) ? 1 : op);
      if (!(alpha > 0.002)) return;

      ctx.save();
      saved = true;
      ctx.globalAlpha = alpha;

      var visible = cs.visibility === 'visible';
      var r = el.getBoundingClientRect(), b = { x: r.left, y: r.top, w: r.width, h: r.height };
      var inline = cs.display === 'inline';
      var onScreen = b.w > 0 && b.h > 0 && hit(b, st.clip);
      var textClip = (cs.backgroundClip || cs.webkitBackgroundClip) === 'text';

      if (visible && onScreen && !isSvg) {
        if (inline) {
          var frags = liveRects(el.getClientRects());
          if (frags.length > 1) {
            frags.forEach(function (f) { paintBox(P, cs, { x: f.left, y: f.top, w: f.width, h: f.height }, true); });
          } else paintBox(P, cs, b, false);
        } else paintBox(P, cs, b, false);
      }

      var nst = { alpha: alpha, clip: st.clip, ell: inline ? st.ell : null, textFill: st.textFill };
      if (textClip) nst.textFill = textFillFor(P, cs, b);

      if (isSvg || REPLACED[ln]) { if (visible && onScreen) drawReplaced(P, el, cs, b); return; }
      if (CONTROLS[ln]) { if (visible && onScreen) paintControl(P, el, cs, b, nst); return; }

      if (!inline) {
        var contain = /paint|strict|content/.test(cs.contain || '');
        var ox = cs.overflowX !== 'visible' || contain, oy = cs.overflowY !== 'visible' || contain;
        if (ox || oy) {
          var bw = bordersOf(cs, P.k), pb = inset(b, bw.t, bw.r, bw.b, bw.l), c0 = st.clip;
          var c = { l: ox ? Math.max(c0.l, pb.x) : c0.l, r: ox ? Math.min(c0.r, pb.x + pb.w) : c0.r,
                    t: oy ? Math.max(c0.t, pb.y) : c0.t, b: oy ? Math.min(c0.b, pb.y + pb.h) : c0.b };
          if (c.l >= c.r || c.t >= c.b) return;
          ctx.beginPath();
          var R = radii(cs, b, P.k);
          if (ox && oy && hasRadius(R)) pathTo(ctx, pb, insetRadii(R, bw.t, bw.r, bw.b, bw.l));
          else ctx.rect(c.l, c.t, c.r - c.l, c.b - c.t);
          ctx.clip();
          nst.clip = c;
          var clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
          if (cs.textOverflow === 'ellipsis' || clamp) {
            var pad = paddingOf(cs, P.k), cb = inset(pb, pad.t, pad.r, pad.b, pad.l);
            // over: Chrome's own overflow verdict (layout px, transform-proof) for single-line ellipsis
            nst.ell = { right: cb.x + cb.w, bottom: cb.y + cb.h, clamp: !!clamp,
                        over: !clamp && el.scrollWidth > el.clientWidth };
          }
        }
      }
      if (cs.contentVisibility === 'hidden') return;
      walkChildren(P, el, cs, nst, visible);
    } catch (e) {
      /* one bad node never sinks the paint */
    } finally {
      if (saved) ctx.restore();
    }
  }

  /* ---------- resource preparation (async, before the sync walk) ---------- */
  // wait for the load, then give decode() a short window. decode() alone can
  // stall in a hidden/background tab; drawImage decodes synchronously anyway.
  function readyImage(img) {
    var loaded = img.complete ? Promise.resolve() : new Promise(function (res, rej) {
      img.addEventListener('load', res);
      img.addEventListener('error', rej);
    });
    return within(loaded, LOAD_TIMEOUT).then(function () {
      if (!(img.complete && img.naturalWidth > 0)) return false;
      return img.decode ? within(img.decode(), DECODE_WAIT) : true;
    }).then(function () {
      return img.complete && img.naturalWidth > 0 && isClean(img) ? img : null;
    });
  }

  function loadUrl(url) {
    if (bgCache[url]) return bgCache[url];
    var img = new Image();
    if (/^https?:/i.test(url) && !sameOrigin(url)) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = url;
    var p = bgCache[url] = readyImage(img).then(function (ok) {
      if (!ok) delete bgCache[url];
      return ok;
    });
    return p;
  }

  function refUrl(v) { return String(v).replace(/url\(\s*["']?[^"')]*#([^"')]+)["']?\s*\)/g, 'url(#$1)'); }

  function inlineSvgStyles(orig, clone) {
    var os = [orig].concat(Array.prototype.slice.call(orig.querySelectorAll('*')));
    var cs = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    for (var i = 0; i < os.length && i < cs.length; i++) {
      var o = os[i], c = cs[i];
      if (!c.style || (o !== orig && o.closest && o.closest('symbol'))) continue;   // symbols inherit from their <use>
      var s;
      try { s = getComputedStyle(o); } catch (e) { continue; }
      for (var j = 0; j < SVG_PROPS.length; j++) {
        var p = SVG_PROPS[j];
        if (o === orig && SVG_ROOT_SKIP[p]) continue;
        var v = s.getPropertyValue(p);
        if (v) c.style.setProperty(p, refUrl(v));
      }
      if (o !== orig) {
        if (s.display === 'none') c.style.setProperty('display', 'none');
        // CSS-driven transforms only (attribute transforms already serialize)
        if (s.transform && s.transform !== 'none' && !o.hasAttribute('transform')) {
          c.style.setProperty('transform', s.transform);
          c.style.setProperty('transform-origin', s.transformOrigin);
          c.style.setProperty('transform-box', s.transformBox || 'view-box');
        }
      }
    }
  }

  // <use href="#x"> / url(#x) pointing outside this svg → copy the target in
  function pullRefs(clone) {
    var defs = null, seen = {}, rounds = 0, added = true;
    function collect(ids, v) {
      String(v || '').replace(/url\(\s*["']?#([^"')]+)["']?\s*\)/g, function (_, id) { ids.push(id); return _; });
    }
    while (added && rounds++ < 6) {
      added = false;
      var ids = [];
      Array.prototype.forEach.call(clone.querySelectorAll('*'), function (n) {
        var h = n.getAttribute('href') || n.getAttributeNS(XLINK_NS, 'href');
        if (h && h.charAt(0) === '#') ids.push(h.slice(1));
        collect(ids, n.getAttribute('style'));
        ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end'].forEach(function (a) {
          collect(ids, n.getAttribute(a));
        });
      });
      ids.forEach(function (id) {
        if (seen[id]) return;
        seen[id] = 1;
        var local = null;
        try { local = clone.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id)); } catch (e) { local = null; }
        if (local) return;
        var src = document.getElementById(id);
        if (!src || src.namespaceURI !== SVG_NS) return;
        if (!defs) { defs = document.createElementNS(SVG_NS, 'defs'); clone.insertBefore(defs, clone.firstChild); }
        defs.appendChild(src.cloneNode(true));
        added = true;
      });
    }
  }

  function prepSvg(svg, k, scale) {
    var r = svg.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return Promise.resolve(null);
    var lw = r.width / k, lh = r.height / k;
    var W = Math.max(1, Math.round(lw * scale)), H = Math.max(1, Math.round(lh * scale));
    var clone = svg.cloneNode(true);
    inlineSvgStyles(svg, clone);
    pullRefs(clone);
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 ' + lw + ' ' + lh);
    clone.setAttribute('width', W);
    clone.setAttribute('height', H);
    clone.style.width = W + 'px';
    clone.style.height = H + 'px';
    ['transform', 'opacity', 'visibility', 'filter', 'margin', 'position', 'left', 'top', 'right', 'bottom'].forEach(function (p) {
      clone.style.removeProperty(p);
    });
    var str = new XMLSerializer().serializeToString(clone);
    if (!/^<svg[^>]*\sxmlns=/.test(str)) str = str.replace(/^<svg/, '<svg xmlns="' + SVG_NS + '"');
    if (str.indexOf('xlink:') >= 0 && !/^<svg[^>]*\sxmlns:xlink=/.test(str)) {
      str = str.replace(/^<svg/, '<svg xmlns:xlink="' + XLINK_NS + '"');
    }
    if (svgCache[str]) return svgCache[str];
    var img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    var p = svgCache[str] = readyImage(img).then(function (ok) {
      if (!ok) delete svgCache[str];
      return ok;
    });
    return p;
  }

  function prepare(P, root) {
    var jobs = [], rr = P.rootRect, view = { l: rr.left, t: rr.top, r: rr.right, b: rr.bottom };
    var els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    els.forEach(function (el) {
      try {
        if (el.namespaceURI === SVG_NS && el.ownerSVGElement) return;     // inside an svg we serialize whole
        if (P.skip) {
          var s = el.closest && el.closest(P.skip);
          if (s && (s === root || root.contains(s))) return;
        }
        var ln = el.localName;
        if (ln === 'svg' || ln === 'img') {
          var r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0) || !hit({ x: r.left, y: r.top, w: r.width, h: r.height }, view)) return;
          if (ln === 'img' && !(el.currentSrc || el.getAttribute('src'))) return;
          var job = ln === 'svg' ? prepSvg(el, P.k, P.scale) : readyImage(el);
          jobs.push(job.then(function (src) { if (src) P.res.set(el, src); }, function () {}));
          return;
        }
        var bi = getComputedStyle(el).backgroundImage;
        if (bi && bi !== 'none' && bi.indexOf('url(') >= 0) {
          splitTop(bi).forEach(function (layer) {
            var url = urlOf(layer);
            if (url) jobs.push(loadUrl(url).then(function (img) { if (img) P.bg[url] = img; }, function () {}));
          });
        }
      } catch (e) { /* skip */ }
    });
    return Promise.all(jobs);
  }

  function fontsReady() {
    try {
      if (document.fonts && document.fonts.ready) return within(document.fonts.ready, FONT_TIMEOUT);
    } catch (e) { /* no FontFaceSet */ }
    return Promise.resolve(true);
  }

  /* ---------- entry ---------- */
  function measure(root, scale) {
    var rr = root.getBoundingClientRect();
    var lw = root.offsetWidth || rr.width, lh = root.offsetHeight || rr.height;
    var k = lw > 0 && rr.width > 0 ? rr.width / lw : 1;   // uniform ancestor scale (e.g. a css zoom-out)
    var s = Math.min(scale, MAX_SIDE / Math.max(lw, 1), MAX_SIDE / Math.max(lh, 1), Math.sqrt(MAX_AREA / Math.max(lw * lh, 1)));
    return { rr: rr, lw: lw, lh: lh, k: k, scale: s };
  }

  function paint(rootEl, opts) {
    opts = opts || {};
    if (!rootEl || !rootEl.getBoundingClientRect) return Promise.reject(new Error('umbra-paint: no root element'));
    var scale = +opts.scale > 0 ? +opts.scale : 2;
    var skip = opts.skipSelector === undefined ? '[data-paint="skip"]' : opts.skipSelector;
    if (skip) { try { document.createDocumentFragment().querySelector(skip); } catch (e) { skip = null; } }

    return fontsReady().then(function () {
      var m0 = measure(rootEl, scale);
      var P = { ctx: null, k: m0.k, scale: m0.scale, skip: skip, rootRect: m0.rr,
                res: new Map(), bg: {}, range: document.createRange() };
      return prepare(P, rootEl).then(function () {
        var m = measure(rootEl, scale);     // images may have shifted layout while decoding
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(m.lw * m.scale));
        canvas.height = Math.max(1, Math.round(m.lh * m.scale));
        var ctx = canvas.getContext('2d');
        if (opts.background) {
          ctx.fillStyle = opts.background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        // work in viewport coordinates; f maps them to output pixels
        var f = canvas.width / Math.max(m.rr.width, 1e-6);
        ctx.setTransform(f, 0, 0, f, -m.rr.left * f, -m.rr.top * f);
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        P.ctx = ctx;
        P.k = m.k;
        P.rootRect = m.rr;
        var st = { alpha: 1, clip: { l: m.rr.left, t: m.rr.top, r: m.rr.right, b: m.rr.bottom }, ell: null, textFill: null };
        paintEl(P, rootEl, st);
        if (P.range.detach) P.range.detach();
        return canvas;
      });
    });
  }

  window.UmbraPaint = { paint: paint };
})();
