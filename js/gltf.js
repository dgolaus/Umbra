/* =========================================================================
   TOOL 6 · GLTF → PNG — photobooth captures exported from roblox studio
   (.gltf / .glb) → pngs. Many files at once · proper glTF 2.0 mapping
   (mesh → material → baseColorTexture → texture.source → image) · data uris,
   glb bufferViews, external uris · duplicate detection · capture-time sort ·
   trim / background / scale · save to downloads or a folder, as pngs or one
   .zip (js/umbra-zip.js) · hand-off to crop, update icon and frontpage.

   Two layers in one classic IIFE:
     1. the pure core (no DOM) → window.UmbraGltf, unit-tested in node
     2. the tool UI, which only boots when there is a document
   Global listeners are guarded by Hub.isActive('gltf').
   ========================================================================= */
(function (root) {
  'use strict';

  /* =====================================================================
     1 · CORE (pure)
     ===================================================================== */

  var CAP = 8192;                      // longest output edge (canvas memory safety)
  var MAX_PAD = 64;

  function gltfError(msg, code) {
    var e = new Error(msg);
    e.code = code || 'GLTF';
    e.gltf = true;
    return e;
  }

  // the reference site's sanitizer, verbatim (name parity with photobooth-plugin-site)
  function refSanitize(s) {
    var t = String(s).replace(/[\/?%*:|"<>\x00-\x1F]/g, '_');
    t = t.replace(/\s/g, '-');
    t = t.replace(/^[.-]+|[.-]+$/g, '');
    t = t.replace(/[_]{2,}/g, '_');
    t = t.replace(/[-]{2,}/g, '-');
    return t;
  }
  // reference sanitizer + what it lets through that a file system refuses (backslash, DEL), capped
  function safeBase(s) {
    var t = refSanitize(String(s == null ? '' : s).replace(/[\\\x7f]/g, '_'));
    t = t.replace(/[_]{2,}/g, '_');
    if (t.length > 120) t = t.slice(0, 120).replace(/[.-]+$/g, '');
    return t;
  }
  // update icon's prefix rule (dropped chars, spaces → _)
  function cleanPrefix(s) {
    return String(s || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
  }
  function stripExt(name) { return String(name || '').replace(/\.[a-z0-9]{1,6}$/i, ''); }
  // last path segment of a relative uri, percent-decoded, query/hash dropped
  function baseOf(p) {
    var s = String(p || '').split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch (e) {}
    return s.split(/[\\/]/).pop() || '';
  }

  /* ---- capture time (photobooth names meshes "2026-10-02T17:24:32Z_1") ---- */
  var CAP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:_](\d{2})[:_](\d{2})Z(?:_(\d+))?$/;
  function captureTime(raw) {
    var m = CAP_RE.exec(String(raw || '').trim());
    if (!m) return null;
    var mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
    var ms = Date.UTC(+m[1], mo - 1, d, h, mi, s);
    return isNaN(ms) ? null : { ms: ms, idx: m[7] ? +m[7] : 0 };
  }
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // local time: "02 oct · 14:24:32" (the year only when it is not this year)
  function fmtCapture(ms, nowMs) {
    var d = new Date(ms), now = new Date(nowMs == null ? Date.now() : nowMs);
    var s = pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) s += ' ' + d.getFullYear();
    return s + ' · ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* ---- bytes ---- */
  function b64ToBytes(s) {
    if (/[^A-Za-z0-9+/=]/.test(s)) s = s.replace(/[^A-Za-z0-9+/=]/g, '');   // whitespace / newlines
    var out = new Uint8Array(Math.floor(s.length * 3 / 4) + 3), o = 0;
    var CH = 1 << 18;                                   // multiple of 4 → chunks decode independently
    for (var i = 0; i < s.length; i += CH) {
      var bin = root.atob(s.slice(i, i + CH));
      for (var k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
    }
    return out.subarray(0, o);
  }
  function pctToBytes(s) {
    var out = [], enc = typeof root.TextEncoder === 'function' ? new root.TextEncoder() : null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 37 && /^[0-9a-f]{2}$/i.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else if (c < 128 || !enc) out.push(c & 255);
      else { var b = enc.encode(s.charAt(i)); for (var k = 0; k < b.length; k++) out.push(b[k]); }
    }
    return new Uint8Array(out);
  }
  function parseDataUri(uri) {
    var s = String(uri || '');
    var comma = s.indexOf(',');
    if (!/^data:/i.test(s) || comma < 0) return null;
    var head = s.slice(5, comma);
    return { mime: (head.split(';')[0] || '').trim().toLowerCase(), base64: /;base64\s*$/i.test(head), start: comma + 1 };
  }
  function dataUriToBytes(uri) {
    var d = parseDataUri(uri);
    if (!d) throw gltfError('not a data uri', 'BAD_URI');
    var body = String(uri).slice(d.start);
    return { mime: d.mime, bytes: d.base64 ? b64ToBytes(body) : pctToBytes(body) };
  }

  // format + pixel size straight from the header bytes (no decode)
  function imageInfo(u8) {
    if (!u8 || u8.length < 12) return null;
    var be32 = function (o) { return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; };
    var le16 = function (o) { return u8[o] | (u8[o + 1] << 8); };
    var le24 = function (o) { return u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); };
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47 && u8[4] === 0x0D && u8[5] === 0x0A && u8[6] === 0x1A && u8[7] === 0x0A) {
      if (u8.length < 24 || String.fromCharCode(u8[12], u8[13], u8[14], u8[15]) !== 'IHDR') return { mime: 'image/png', w: 0, h: 0 };
      return { mime: 'image/png', w: be32(16), h: be32(20) };
    }
    if (u8[0] === 0xFF && u8[1] === 0xD8) {
      var o = 2;
      while (o + 9 < u8.length) {
        if (u8[o] !== 0xFF) { o++; continue; }
        var mk = u8[o + 1];
        if (mk === 0xFF) { o++; continue; }
        if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { o += 2; continue; }
        var len = (u8[o + 2] << 8) | u8[o + 3];
        if ((mk >= 0xC0 && mk <= 0xCF) && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
          return { mime: 'image/jpeg', w: (u8[o + 7] << 8) | u8[o + 8], h: (u8[o + 5] << 8) | u8[o + 6] };
        }
        o += 2 + len;
      }
      return { mime: 'image/jpeg', w: 0, h: 0 };
    }
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return { mime: 'image/gif', w: le16(6), h: le16(8) };
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'RIFF' && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'WEBP' && u8.length >= 30) {
      var fmt = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
      if (fmt === 'VP8 ') return { mime: 'image/webp', w: le16(26) & 0x3FFF, h: le16(28) & 0x3FFF };
      if (fmt === 'VP8L') {
        var b0 = u8[21], b1 = u8[22], b2 = u8[23], b3 = u8[24];
        return { mime: 'image/webp', w: 1 + (b0 | ((b1 & 0x3F) << 8)), h: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10)) };
      }
      if (fmt === 'VP8X') return { mime: 'image/webp', w: 1 + le24(24), h: 1 + le24(27) };
      return { mime: 'image/webp', w: 0, h: 0 };
    }
    if (u8[0] === 0x42 && u8[1] === 0x4D && u8.length >= 26) {
      var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      return { mime: 'image/bmp', w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
    }
    return null;
  }

  // content hash for duplicate detection: length + two independent 32-bit fnv-style lanes
  function hashBytes(u8) {
    var h1 = 0x811c9dc5, h2 = 0x9747b28c, n = u8.length;
    for (var i = 0; i < n; i++) {
      var b = u8[i];
      h1 = Math.imul(h1 ^ b, 16777619);
      h2 = Math.imul(h2 ^ b, 0x5bd1e995);
      h2 ^= h2 >>> 15;
    }
    return n.toString(36) + '-' + (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16);
  }
  // → for each entry, the index of the first earlier entry with the same hash, or -1
  function markDuplicates(hashes) {
    var first = {}, out = [];
    for (var i = 0; i < hashes.length; i++) {
      var h = hashes[i];
      if (h == null) { out.push(-1); continue; }
      if (Object.prototype.hasOwnProperty.call(first, h)) out.push(first[h]);
      else { first[h] = i; out.push(-1); }
    }
    return out;
  }

  /* ---- containers ---- */
  var GLB_MAGIC = 0x46546C67, CHUNK_JSON = 0x4E4F534A, CHUNK_BIN = 0x004E4942;
  function isGlb(u8) { return !!u8 && u8.length >= 4 && u8[0] === 0x67 && u8[1] === 0x6C && u8[2] === 0x54 && u8[3] === 0x46; }
  function decodeUtf8(u8) {
    if (typeof root.TextDecoder === 'function') return new root.TextDecoder('utf-8').decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  // binary glTF 2.0: 12-byte header, then chunks (JSON first, optional BIN), little-endian
  function parseGlb(u8) {
    if (!u8 || u8.length < 12) throw gltfError('not a glb file — too short', 'BAD_GLB');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== GLB_MAGIC) throw gltfError('not a glb file — bad magic', 'BAD_GLB');
    var version = dv.getUint32(4, true);
    if (version !== 2) throw gltfError('glb version ' + version + ' is not supported (needs 2)', 'BAD_GLB');
    var length = dv.getUint32(8, true);
    if (length > u8.length) throw gltfError('glb file is truncated', 'BAD_GLB');
    var off = 12, json = null, bin = null;
    while (off + 8 <= length) {
      var clen = dv.getUint32(off, true), ctype = dv.getUint32(off + 4, true);
      off += 8;
      if (off + clen > length) throw gltfError('glb file is truncated', 'BAD_GLB');
      if (ctype === CHUNK_JSON && !json) json = u8.subarray(off, off + clen);
      else if (ctype === CHUNK_BIN && !bin) bin = u8.subarray(off, off + clen);
      off += clen;
    }
    if (!json) throw gltfError('glb has no json chunk', 'BAD_GLB');
    return { text: decodeUtf8(json), bin: bin };
  }

  function arr(v) { return Array.isArray(v) ? v : []; }
  function isIndex(v, len) { return typeof v === 'number' && v >= 0 && v % 1 === 0 && v < len; }

  /* glTF json → the images to extract, named, in reference order (meshes first, then the rest).
     opts.bin: the glb BIN chunk · opts.has(name): is a file with that base name available */
  function extract(json, opts) {
    opts = opts || {};
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw gltfError('not a gltf file — the json is not an object', 'NOT_GLTF');
    if (!json.asset || typeof json.asset !== 'object') throw gltfError('missing "asset" — not a gltf file', 'NO_ASSET');
    if (json.asset.version == null || json.asset.version === '') throw gltfError('missing asset.version — not a gltf file', 'NO_ASSET');
    var images = arr(json.images);
    if (!images.length) throw gltfError('no images in this file', 'NO_IMAGES');
    var generator = typeof json.asset.generator === 'string' ? json.asset.generator : '';

    var meshes = arr(json.meshes), materials = arr(json.materials), nodes = arr(json.nodes);
    var textures = Array.isArray(json.textures) ? json.textures : null;
    var bufferViews = arr(json.bufferViews), buffers = arr(json.buffers);

    var nodeName = {};
    nodes.forEach(function (n) {
      if (n && typeof n.mesh === 'number' && nodeName[n.mesh] == null && typeof n.name === 'string' && n.name.trim()) nodeName[n.mesh] = n.name;
    });
    // texture index → image index. no textures array, or a texture without a source → the
    // index is an image index (what the reference site does for every texture)
    function texImage(t) {
      if (!isIndex(t, Infinity)) return -1;
      var tx = textures ? textures[t] : null, src = t;
      if (tx && typeof tx === 'object') {
        if (typeof tx.source === 'number') src = tx.source;
        else if (tx.extensions && typeof tx.extensions === 'object') {
          for (var k in tx.extensions) {
            var ex = tx.extensions[k];
            if (ex && typeof ex.source === 'number') { src = ex.source; break; }
          }
        }
      }
      return isIndex(src, images.length) ? src : -1;
    }

    var owner = [], order = [];
    meshes.forEach(function (mesh, p) {
      if (!mesh || typeof mesh !== 'object') return;
      var raw = typeof mesh.name === 'string' && mesh.name.trim() ? mesh.name : (nodeName[p] || '');
      var base = safeBase(raw);
      if (!base) return;                               // unnamed → its images count as unreferenced
      var seen = [];
      arr(mesh.primitives).forEach(function (prim) {
        var m = prim && prim.material;
        var mat = isIndex(m, materials.length) ? materials[m] : null;
        var pbr = mat && mat.pbrMetallicRoughness;
        var t = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
        var im = texImage(t);
        if (im >= 0 && seen.indexOf(im) === -1) seen.push(im);
      });
      seen.forEach(function (im, k) {
        if (owner[im]) return;                         // an earlier mesh already named it
        owner[im] = { raw: raw, base: k ? base + '_' + (k + 1) : base, mesh: p };
        order.push(im);
      });
    });
    var n = 0;
    for (var i = 0; i < images.length; i++) {
      if (owner[i]) continue;
      owner[i] = { raw: '', base: 'image_' + (++n), mesh: -1 };
      order.push(i);
    }

    var bufCache = {};
    function bufferBytes(bi) {
      if (Object.prototype.hasOwnProperty.call(bufCache, bi)) return bufCache[bi];
      var b = buffers[bi], r;
      if (!b || typeof b !== 'object') r = { err: 'buffer ' + bi + ' not found' };
      else if (b.uri == null) r = opts.bin ? { bytes: opts.bin } : { err: 'no binary chunk for buffer ' + bi };
      else if (/^data:/i.test(b.uri)) {
        try { r = { bytes: dataUriToBytes(b.uri).bytes }; } catch (e) { r = { err: 'buffer ' + bi + ' has a bad data uri' }; }
      } else r = { file: baseOf(b.uri) };
      bufCache[bi] = r;
      return r;
    }
    function source(img, idx) {
      if (!img || typeof img !== 'object') return { type: 'broken', why: 'image ' + idx + ' is empty' };
      var mime = typeof img.mimeType === 'string' ? img.mimeType.toLowerCase() : '';
      if (typeof img.uri === 'string' && img.uri) {
        if (/^data:/i.test(img.uri)) return { type: 'data', uri: img.uri, mime: mime || (parseDataUri(img.uri) || {}).mime || '' };
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(img.uri)) return { type: 'broken', why: 'remote url — not downloaded', name: baseOf(img.uri) };
        var name = baseOf(img.uri);
        if (!name) return { type: 'broken', why: 'image ' + idx + ' has an empty uri' };
        return opts.has && opts.has(name) ? { type: 'file', name: name, mime: mime } : { type: 'missing', name: name };
      }
      if (typeof img.bufferView === 'number') {
        var bv = bufferViews[img.bufferView];
        if (!bv || typeof bv !== 'object') return { type: 'broken', why: 'bufferView ' + img.bufferView + ' not found' };
        var off = bv.byteOffset || 0, len = bv.byteLength;
        if (!isIndex(off, Infinity) || !isIndex(len, Infinity)) return { type: 'broken', why: 'bufferView ' + img.bufferView + ' is malformed' };
        var b = bufferBytes(bv.buffer);
        if (b.err) return { type: 'broken', why: b.err };
        if (b.file) {
          return opts.has && opts.has(b.file)
            ? { type: 'binfile', name: b.file, offset: off, length: len, mime: mime }
            : { type: 'missing', name: b.file, offset: off, length: len };
        }
        if (off + len > b.bytes.length) return { type: 'broken', why: 'bufferView ' + img.bufferView + ' is out of range' };
        return { type: 'bytes', bytes: b.bytes.subarray(off, off + len), mime: mime };
      }
      return { type: 'broken', why: 'image ' + idx + ' has no uri or bufferView' };
    }

    return {
      generator: generator,
      roblox: generator === 'Roblox Export',
      images: order.map(function (idx) {
        var o = owner[idx];
        return { index: idx, raw: o.raw, base: o.base, mesh: o.mesh, time: captureTime(o.raw), src: source(images[idx], idx) };
      })
    };
  }

  // a dropped / pasted file → extract(). data: Uint8Array | string | an already-parsed object
  // realm-independent (node buffers, arrays from another frame)
  function isBytes(x) { return !!x && typeof x === 'object' && typeof x.byteLength === 'number' && typeof x.subarray === 'function'; }
  function isArrayBuffer(x) { return Object.prototype.toString.call(x) === '[object ArrayBuffer]'; }
  function parseFile(name, data, opts) {
    opts = opts || {};
    var bin = null, text = null, json = null, kind = 'gltf';
    if (data && typeof data === 'object' && !isBytes(data) && !isArrayBuffer(data)) json = data;
    else {
      var u8 = isArrayBuffer(data) ? new Uint8Array(data) : data;
      if (isBytes(u8) && (isGlb(u8) || /\.glb$/i.test(name || ''))) {
        var g = parseGlb(u8);
        text = g.text; bin = g.bin; kind = 'glb';
      } else {
        text = isBytes(u8) ? decodeUtf8(u8) : String(data == null ? '' : data);
      }
      text = text.replace(/^﻿/, '');
      if (!text.trim()) throw gltfError('the file is empty', 'BAD_JSON');
      try { json = JSON.parse(text); }
      catch (e) { throw gltfError('invalid json — ' + String(e && e.message || 'parse error').replace(/^JSON\.parse:\s*/i, '').slice(0, 90), 'BAD_JSON'); }
    }
    var r = extract(json, { bin: bin, has: opts.has });
    r.kind = kind;
    return r;
  }

  // case-insensitive registry: name, name_2, name_3 …
  function dedupeName(base, used) {
    var n = 1, name = base;
    while (used[name.toLowerCase()]) { n++; name = base + '_' + n; }
    used[name.toLowerCase()] = true;
    return name;
  }
  function numberedName(prefix, k, total) {
    var w = Math.max(2, String(total).length), s = String(k);
    while (s.length < w) s = '0' + s;
    return (prefix || 'capture') + '_' + s;
  }
  function zipBaseFor(prefix, fileNames) {
    if (prefix) return prefix;
    var uniq = [];
    (fileNames || []).forEach(function (f) { if (uniq.indexOf(f) === -1) uniq.push(f); });
    if (uniq.length === 1) return safeBase(stripExt(uniq[0])) || 'gltf_images';
    return 'gltf_images';
  }

  /* ---- trim / output geometry ---- */
  // bounding box of pixels with alpha > 0 in an rgba buffer → { x, y, w, h } or null (fully transparent)
  function trimBounds(px, w, h) {
    var x, y, row, top = -1, bottom = -1, left = w, right = -1;
    for (y = 0; y < h && top < 0; y++) {
      row = y * w * 4;
      for (x = 0; x < w; x++) if (px[row + x * 4 + 3] !== 0) { top = y; break; }
    }
    if (top < 0) return null;
    for (y = h - 1; y >= top && bottom < 0; y--) {
      row = y * w * 4;
      for (x = 0; x < w; x++) if (px[row + x * 4 + 3] !== 0) { bottom = y; break; }
    }
    for (y = top; y <= bottom; y++) {
      row = y * w * 4;
      for (x = 0; x < left; x++) if (px[row + x * 4 + 3] !== 0) { left = x; break; }
      for (x = w - 1; x > right; x--) if (px[row + x * 4 + 3] !== 0) { right = x; break; }
    }
    return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  }
  // '1' · '0.5' · '2' · 'fit1024' · 'fit512' (longest edge = N) — capped at CAP
  function scaleSize(w, h, scale, cap) {
    cap = cap || CAP;
    var k = 1, m = /^fit(\d+)$/.exec(String(scale || '1'));
    if (m) k = (+m[1]) / Math.max(w, h, 1);
    else if (scale === '0.5' || scale === 0.5) k = 0.5;
    else if (scale === '2' || scale === 2) k = 2;
    var ow = Math.max(1, Math.round(w * k)), oh = Math.max(1, Math.round(h * k)), capped = false;
    var L = Math.max(ow, oh);
    if (L > cap) {
      var c = cap / L;
      ow = Math.max(1, Math.round(ow * c)); oh = Math.max(1, Math.round(oh * c)); capped = true;
    }
    return { w: ow, h: oh, capped: capped };
  }
  function clampPad(v) { v = Math.round(+v || 0); return v < 0 ? 0 : (v > MAX_PAD ? MAX_PAD : v); }
  /* the export recipe for a w×h source. tb = trim bounds (null → fully transparent, kept as 1×1).
     crop to the box → pad evenly (trim only) → scale the padded result. */
  function plan(w, h, o, tb) {
    o = o || {};
    var box = { x: 0, y: 0, w: w, h: h }, pad = 0, empty = false;
    if (o.trim) {
      if (tb) box = { x: tb.x, y: tb.y, w: tb.w, h: tb.h };
      else { box = { x: 0, y: 0, w: 1, h: 1 }; empty = true; }
      pad = clampPad(o.padding);
    }
    var cw = box.w + 2 * pad, ch = box.h + 2 * pad;
    var s = scaleSize(cw, ch, o.scale);
    return { box: box, pad: pad, cw: cw, ch: ch, ow: s.w, oh: s.h, capped: s.capped, empty: empty };
  }
  function isPassthrough(o) {
    o = o || {};
    return !o.trim && (o.bg || 'transparent') === 'transparent' && String(o.scale || '1') === '1';
  }

  function kindOf(name, type) {
    var n = String(name || '').toLowerCase(), t = String(type || '').toLowerCase();
    if (/\.glb$/.test(n) || t === 'model/gltf-binary') return 'glb';
    if (/\.gltf$/.test(n) || t === 'model/gltf+json') return 'gltf';
    if (/\.bin$/.test(n)) return 'bin';
    if (t.indexOf('image/') === 0 || /\.(png|jpe?g|webp|gif|bmp)$/.test(n)) return 'image';
    return null;
  }

  var Core = {
    CAP: CAP, MAX_PAD: MAX_PAD,
    refSanitize: refSanitize, safeBase: safeBase, cleanPrefix: cleanPrefix, stripExt: stripExt, baseOf: baseOf,
    captureTime: captureTime, fmtCapture: fmtCapture,
    parseDataUri: parseDataUri, dataUriToBytes: dataUriToBytes, imageInfo: imageInfo,
    hashBytes: hashBytes, markDuplicates: markDuplicates,
    isGlb: isGlb, parseGlb: parseGlb, extract: extract, parseFile: parseFile,
    dedupeName: dedupeName, numberedName: numberedName, zipBaseFor: zipBaseFor,
    trimBounds: trimBounds, scaleSize: scaleSize, plan: plan, isPassthrough: isPassthrough, kindOf: kindOf
  };
  root.UmbraGltf = Core;

  if (typeof document === 'undefined') return;          // node: the core is all there is

  /* =====================================================================
     2 · TOOL UI
     ===================================================================== */

  var TOOL = 'gltf';
  var LS_SAVETO = 'gltf.saveTo', LS_FORMAT = 'gltf.saveFormat', LS_OPTS = 'gltf.opts', SS_NAMES = 'gltf.dlnames';
  var IDB_NAME = 'umbra-gltf', IDB_STORE = 'kv', IDB_DIR_KEY = 'saveDir';
  var PREVIEW = 560;                                   // longest preview edge (px)
  var OPT_DEFAULTS = { trim: false, padding: 0, bg: 'transparent', scale: '1', prefix: '', previewBg: 'checker', nameStyle: 'original', sort: 'auto' };
  var BGS = ['transparent', 'black', 'white'], SCALES = ['1', '0.5', '2', 'fit1024', 'fit512'];
  var PBGS = ['checker', 'black', 'white'], SORTS = ['auto', 'time-desc', 'time-asc', 'file'];

  var opts = Object.assign({}, OPT_DEFAULTS);
  var groups = [], items = [], byId = {}, used = {}, pool = {};
  var gid = 0, iid = 0;
  var filter = '';

  /* ---------- refs ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var rootEl, infoEl, drop, fileInput, pasteToggle, pasteBox, jsonIn, extractBtn,
      trimIn, padRow, padIn, padVal, bgRow, scaleRow, optNote, styleRow, prefixIn,
      saveToRow, folderRow, folderNameEl, folderBtn, formatRow, saveBtn,
      toolbar, selAllBtn, selNoneBtn, selCount, searchIn, sortSel, pbgRow, clearBtn,
      groupsEl, emptyEl, toastEl;

  function isActive() { return !!(window.Hub && typeof Hub.isActive === 'function' && Hub.isActive(TOOL)); }
  function typingIn(t) {
    var tag = t && t.tagName;
    if (tag === 'INPUT') return !/^(checkbox|radio|button|submit|reset|file|color|image|range)$/i.test(t.type || '');
    return tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, type, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    if (type) toastEl.dataset.type = type; else delete toastEl.dataset.type;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, ms || 2200);
  }

  /* ---------- small helpers ---------- */
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var nextFrame = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  function readBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function canvasOf(w, h, read) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
    if (!ctx || c.width !== w || c.height !== h) throw new Error('canvas ' + w + '×' + h + ' unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return c;
  }
  // free a scratch canvas's backing store now (big exports, one at a time)
  function release(c) { if (c && c.getContext) { c.width = 0; c.height = 0; } }
  function canvasBlob(c) {
    return new Promise(function (res) {
      c.toBlob(function (b) { release(c); res(b); }, 'image/png');
    });
  }

  /* ---------- decoding ---------- */
  function loadImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), im = new Image();
      im.decoding = 'async';
      im.onload = function () { res({ src: im, w: im.naturalWidth, h: im.naturalHeight, close: function () { URL.revokeObjectURL(url); } }); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode failed')); };
      im.src = url;
    });
  }
  function fromBitmap(bm) { return { src: bm, w: bm.width, h: bm.height, close: function () { try { bm.close(); } catch (e) {} } }; }
  // full-resolution decode (export / trim analysis) — the caller closes it
  function decodeFull(blob) {
    if (typeof window.createImageBitmap === 'function') {
      return createImageBitmap(blob).then(fromBitmap, function () { return loadImg(blob); });
    }
    return loadImg(blob);
  }
  // downscaled decode for previews
  function decodeSmall(blob, w, h) {
    if (typeof window.createImageBitmap === 'function') {
      return createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
        .then(fromBitmap, function () { return loadImg(blob); });
    }
    return loadImg(blob);
  }
  // big downscales halve step by step (no aliasing on 3840 → 512)
  function stepped(source, sw, sh, ow, oh) {
    var cur = source, cw = sw, ch = sh;
    try {
      while (cw > ow * 2 || ch > oh * 2) {
        var nw = cw > ow * 2 ? Math.ceil(cw / 2) : cw;
        var nh = ch > oh * 2 ? Math.ceil(ch / 2) : ch;
        var t = canvasOf(nw, nh);
        t.getContext('2d').drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
        if (cur !== source) release(cur);
        cur = t; cw = nw; ch = nh;
      }
      var out = canvasOf(ow, oh);
      out.getContext('2d').drawImage(cur, 0, 0, cw, ch, 0, 0, ow, oh);
      return out;
    } finally {
      if (cur !== source) release(cur);
    }
  }
  function trimOf(d) {
    var c = canvasOf(d.w, d.h, true);
    try {
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(d.src, 0, 0);
      return trimBounds(ctx.getImageData(0, 0, d.w, d.h).data, d.w, d.h);
    } finally { release(c); }
  }
  var BG_FILL = { black: '#000000', white: '#ffffff' };
  function compose(d, p, bg) {
    var c = canvasOf(p.cw, p.ch), ctx = c.getContext('2d');
    if (BG_FILL[bg]) { ctx.fillStyle = BG_FILL[bg]; ctx.fillRect(0, 0, p.cw, p.ch); }
    ctx.drawImage(d.src, p.box.x, p.box.y, p.box.w, p.box.h, p.pad, p.pad, p.box.w, p.box.h);
    if (p.ow === p.cw && p.oh === p.ch) return c;
    var out;
    try {
      if (p.ow < p.cw || p.oh < p.ch) out = stepped(c, p.cw, p.ch, p.ow, p.oh);
      else {
        out = canvasOf(p.ow, p.oh);
        out.getContext('2d').drawImage(c, 0, 0, p.cw, p.ch, 0, 0, p.ow, p.oh);
      }
    } finally { release(c); }
    return out;
  }
  /* the exported png for one image with options o. no option on + a png source → the original
     bytes from the gltf (bit-exact). anything else is re-rendered through a canvas. */
  function renderOut(it, o) {
    if (isPassthrough(o) && it.mime === 'image/png') {
      return Promise.resolve({ blob: it.blob, w: it.w, h: it.h, original: true, empty: false, capped: false });
    }
    return decodeFull(it.blob).then(function (d) {
      try {
        if (!d.w || !d.h) throw new Error('empty image');
        var tb;
        if (o.trim) {
          if (it.trim === undefined || it.trimFor !== d.w + 'x' + d.h) { it.trim = trimOf(d); it.trimFor = d.w + 'x' + d.h; }
          tb = it.trim;
        }
        var p = plan(d.w, d.h, o, tb);
        var c = compose(d, p, o.bg);
      } finally { d.close(); }
      return canvasBlob(c).then(function (b) {
        if (!b) throw new Error('encode failed');
        return { blob: b, w: p.ow, h: p.oh, original: false, empty: p.empty, capped: p.capped };
      });
    });
  }

  /* ---------- names ---------- */
  function okItems() { return displayOrder().filter(function (it) { return it.status === 'ok'; }); }
  function selectedItems() { return okItems().filter(function (it) { return it.selected; }); }
  // the base name an image is exported under right now (before the per-batch dedupe)
  function computeNames() {
    var map = {}, prefix = cleanPrefix(opts.prefix);
    var list = displayOrder();
    // numbered: the selected images without a rename, counted in the gallery order
    var total = list.filter(function (it) { return it.status === 'ok' && it.selected && !safeBase(it.override); }).length;
    var k = 0;
    list.forEach(function (it) {
      var ov = safeBase(it.override);
      if (ov) { map[it.id] = ov; return; }
      if (opts.nameStyle === 'numbered') {
        map[it.id] = it.status === 'ok' && it.selected ? numberedName(prefix, ++k, total) : it.name;
        return;
      }
      map[it.id] = prefix ? prefix + '_' + it.name : it.name;
    });
    return map;
  }
  function syncNames() {
    var map = computeNames();
    items.forEach(function (it) {
      if (!it.els || !it.els.name) return;
      var ph = map[it.id] || it.name;
      if (it.els.name.placeholder !== ph) it.els.name.placeholder = ph;
    });
    return map;
  }

  /* ---------- order / sort ---------- */
  function hasTimes() {
    var ok = items.filter(function (it) { return it.status === 'ok' || it.status === 'loading'; });
    return ok.length > 0 && ok.every(function (it) { return !!it.time; });
  }
  function anyTimes() { return items.some(function (it) { return !!it.time; }); }
  function effSort() {
    if (opts.sort === 'auto') return hasTimes() ? 'time-desc' : 'file';
    if (opts.sort !== 'file' && !anyTimes()) return 'file';
    return opts.sort;
  }
  function cmpItems(mode) {
    return function (a, b) {
      if (mode !== 'file') {
        var ta = a.time, tb = b.time;
        if (ta && tb) {
          var d = (ta.ms - tb.ms) || (ta.idx - tb.idx);
          if (d) return mode === 'time-desc' ? -d : d;
        } else if (ta || tb) return ta ? -1 : 1;     // timed first
      }
      return a.ord - b.ord;
    };
  }
  function groupKey(g, mode) {
    var t = g.items.map(function (id) { return byId[id]; }).filter(function (it) { return it && it.time; });
    if (!t.length || mode === 'file') return null;
    var ms = t.map(function (it) { return it.time.ms; });
    return mode === 'time-desc' ? Math.max.apply(null, ms) : Math.min.apply(null, ms);
  }
  function sortedGroups() {
    var mode = effSort();
    return groups.slice().sort(function (a, b) {
      var ka = groupKey(a, mode), kb = groupKey(b, mode);
      if (ka != null && kb != null && ka !== kb) return mode === 'time-desc' ? kb - ka : ka - kb;
      if ((ka == null) !== (kb == null)) return ka == null ? 1 : -1;
      return a.ord - b.ord;
    });
  }
  function groupItems(g) {
    return g.items.map(function (id) { return byId[id]; }).filter(Boolean).sort(cmpItems(effSort()));
  }
  function displayOrder() {
    var out = [];
    sortedGroups().forEach(function (g) { out = out.concat(groupItems(g)); });
    return out;
  }
  // moves existing nodes into the current order (never rebuilds cards)
  function applyOrder() {
    sortedGroups().forEach(function (g) {
      groupsEl.appendChild(g.el);
      groupItems(g).forEach(function (it) { if (it.els) g.grid.appendChild(it.els.card); });
    });
  }

  /* ---------- svg glyphs ---------- */
  function svg(paths) {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
           'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var GLYPH = {
    dl:     svg('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>'),
    copy:   svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>'),
    crop:   svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
    update: svg('<path d="M6 3h12M6 21h12"/><path d="M8 3v2.5a4 4 0 0 0 1.6 3.2L12 10.5l2.4-1.8A4 4 0 0 0 16 5.5V3"/><path d="M8 21v-2.5a4 4 0 0 1 1.6-3.2L12 13.5l2.4 1.8a4 4 0 0 1 1.6 3.2V21"/>'),
    fp:     svg('<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>')
  };

  /* ---------- groups + cards ---------- */
  function newGroup(file, size) {
    var g = { id: 'g' + (++gid), ord: gid, file: file, size: size || 0, kind: '', status: 'loading', error: '', generator: '', roblox: true, items: [], collapsed: false };
    var el = document.createElement('div');
    el.className = 'gl-group';
    el.dataset.gid = g.id;
    el.innerHTML =
      '<div class="gl-ghead">' +
        '<button type="button" class="gl-gtoggle" aria-expanded="true"><svg class="gl-caret" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg><span class="gl-gname"></span></button>' +
        '<span class="gl-gmeta"></span>' +
        '<span class="gl-gnote" hidden></span>' +
        '<span class="gl-gspace"></span>' +
        '<label class="gl-gsel" hidden><input type="checkbox" aria-label="select every image of this file"><span>all</span></label>' +
        '<button type="button" class="gl-gdel" title="remove this file" aria-label="remove this file">×</button>' +
      '</div>' +
      '<div class="gl-gerr" hidden></div>' +
      '<div class="gl-grid"></div>';
    g.el = el;
    g.grid = el.querySelector('.gl-grid');
    g.toggle = el.querySelector('.gl-gtoggle');
    g.metaEl = el.querySelector('.gl-gmeta');
    g.noteEl = el.querySelector('.gl-gnote');
    g.errEl = el.querySelector('.gl-gerr');
    g.selLabel = el.querySelector('.gl-gsel');
    g.selIn = g.selLabel.querySelector('input');
    el.querySelector('.gl-gname').textContent = file;
    el.querySelector('.gl-gname').title = file;
    groups.push(g);
    groupsEl.appendChild(el);
    renderGroupHead(g);
    refreshState();
    return g;
  }
  function renderGroupHead(g) {
    var its = g.items.map(function (id) { return byId[id]; }).filter(Boolean);
    var meta;
    if (g.status === 'loading' && !its.length) meta = 'reading…';
    else if (g.status === 'error') meta = 'not extracted';
    else {
      meta = plural(its.length, 'image');
      var loading = its.filter(function (it) { return it.status === 'loading'; }).length;
      if (loading) meta += ' · reading ' + (its.length - loading + 1) + '/' + its.length + '…';
      var dups = its.filter(function (it) { return it.dupOf; }).length;
      if (dups && !loading) meta += ' · ' + plural(dups, 'duplicate');
      if (filter) {
        var shown = its.filter(matchesFilter).length;
        if (shown !== its.length) meta += ' · ' + shown + ' shown';
      }
    }
    if (g.size) meta += ' · ' + fmtBytes(g.size);
    if (g.kind === 'glb') meta += ' · glb';
    g.metaEl.textContent = meta;
    var note = g.status === 'ok' && !g.roblox ? 'not exported by roblox studio — extracting anyway' : '';
    g.noteEl.hidden = !note;
    g.noteEl.textContent = note;
    if (note && g.generator) g.noteEl.title = 'generator: ' + g.generator;
    g.errEl.hidden = g.status !== 'error';
    g.errEl.textContent = g.error;
    g.el.classList.toggle('is-error', g.status === 'error');
    var ok = its.filter(function (it) { return it.status === 'ok'; });
    g.selLabel.hidden = ok.length < 2;
    var on = ok.filter(function (it) { return it.selected; }).length;
    g.selIn.checked = ok.length > 0 && on === ok.length;
    g.selIn.indeterminate = on > 0 && on < ok.length;
  }

  function newItem(g, im, k) {
    var it = {
      id: 'i' + (++iid), gid: g.id, ord: iid, index: im.index, raw: im.raw,
      name: dedupeName(im.base, used), override: '', time: im.time,
      status: 'loading', why: '', missing: '', src: im.src,
      blob: null, mime: '', bytes: 0, w: 0, h: 0, hash: null, dupOf: null, selected: false,
      trim: undefined, trimFor: '', prevUrl: null, prevState: 0, removed: false
    };
    byId[it.id] = it;
    items.push(it);
    g.items.push(it.id);
    buildCard(it, g);
    return it;
  }
  function buildCard(it, g) {
    var card = document.createElement('div');
    card.className = 'gl-card is-loading';
    card.dataset.id = it.id;
    card.innerHTML =
      '<div class="gl-prev">' +
        '<img alt="" draggable="false" hidden>' +
        '<span class="gl-prev-msg">reading…</span>' +
        '<label class="gl-cb" title="include in the export"><input type="checkbox" aria-label="select"><span aria-hidden="true"></span></label>' +
        '<span class="gl-badge" hidden></span>' +
      '</div>' +
      '<label class="gl-name"><input type="text" class="text-input" spellcheck="false" autocomplete="off" maxlength="120" aria-label="file name"><span class="gl-ext" aria-hidden="true">.png</span></label>' +
      '<div class="gl-meta"><span class="gl-dim"></span><span class="gl-time" hidden></span><span class="gl-out" hidden></span></div>' +
      '<div class="gl-acts">' +
        '<button type="button" class="ibtn" data-act="dl" title="save this png">' + GLYPH.dl + '</button>' +
        '<button type="button" class="ibtn" data-act="copy" title="copy to clipboard">' + GLYPH.copy + '</button>' +
        '<button type="button" class="ibtn" data-act="crop" title="→ crop">' + GLYPH.crop + '</button>' +
        '<button type="button" class="ibtn" data-act="update" title="→ update icon">' + GLYPH.update + '</button>' +
        '<button type="button" class="ibtn" data-act="fp" title="→ frontpage">' + GLYPH.fp + '</button>' +
      '</div>';
    it.els = {
      card: card, img: card.querySelector('img'), msg: card.querySelector('.gl-prev-msg'),
      cb: card.querySelector('.gl-cb input'), cbLabel: card.querySelector('.gl-cb'), badge: card.querySelector('.gl-badge'),
      name: card.querySelector('.gl-name input'), dim: card.querySelector('.gl-dim'),
      timeEl: card.querySelector('.gl-time'), out: card.querySelector('.gl-out'),
      acts: Array.prototype.slice.call(card.querySelectorAll('.gl-acts .ibtn'))
    };
    it.els.name.placeholder = it.name;
    if (it.time) {
      it.els.timeEl.hidden = false;
      it.els.timeEl.textContent = fmtCapture(it.time.ms);
      it.els.timeEl.title = 'captured ' + new Date(it.time.ms).toString();
    }
    g.grid.appendChild(card);
    renderCard(it);
  }
  function renderCard(it) {
    var e = it.els;
    if (!e) return;
    var ok = it.status === 'ok';
    e.card.classList.toggle('is-loading', it.status === 'loading');
    e.card.classList.toggle('is-missing', it.status === 'missing' || it.status === 'broken');
    e.card.classList.toggle('is-selected', ok && it.selected);
    e.card.classList.toggle('is-dup', !!it.dupOf);
    e.cbLabel.hidden = !ok;
    e.cb.checked = ok && it.selected;
    e.acts.forEach(function (b) { b.disabled = !ok; });
    e.name.disabled = it.status === 'loading';
    if (it.status === 'missing') {
      e.msg.innerHTML = '<b>missing file</b><span>' + esc(it.missing) + '</span><i>drop ' + esc(it.missing) + ' here too</i>';
    } else if (it.status === 'broken') {
      e.msg.innerHTML = '<b>can\'t read this image</b><span>' + esc(it.why) + '</span>';
    } else if (it.status === 'loading') {
      e.msg.textContent = 'reading…';
    } else {
      e.msg.textContent = it.prevState === -1 ? 'no preview' : '';
    }
    e.msg.hidden = ok && it.prevState === 2;
    e.dim.textContent = ok ? (it.w + ' × ' + it.h + ' · ' + fmtBytes(it.bytes)) : (it.status === 'loading' ? '' : '—');
    var badge = '';
    if (it.dupOf && byId[it.dupOf]) badge = 'duplicate of ' + displayName(byId[it.dupOf]);
    else if (ok && opts.trim && it.trim === null) badge = 'fully transparent · 1×1';
    e.badge.hidden = !badge;
    e.badge.textContent = badge;
    e.badge.title = badge;
    renderOutHint(it);
  }
  function displayName(it) { return safeBase(it.override) || it.name; }
  // "→ 1920 × 1080" on each card while an option changes the output
  function renderOutHint(it) {
    var e = it.els;
    if (!e) return;
    var txt = '';
    if (it.status === 'ok' && !isPassthrough(opts)) {
      if (opts.trim && it.trim === undefined) txt = '→ trimming…';
      else {
        var p = plan(it.w, it.h, opts, opts.trim ? it.trim : undefined);
        txt = '→ ' + p.ow + ' × ' + p.oh + (p.capped ? ' (capped)' : '');
      }
    }
    e.out.hidden = !txt;
    e.out.textContent = txt;
  }

  /* ---------- previews (lazy, one at a time, small object urls) ---------- */
  var io = typeof window.IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var it = byId[en.target.dataset.id];
          io.unobserve(en.target);
          if (it) queuePreview(it);
        });
      }, { rootMargin: '600px 0px' })
    : null;
  var pq = [], pBusy = false;
  function observe(it) { if (io) io.observe(it.els.card); else queuePreview(it); }
  function queuePreview(it) {
    if (it.prevState || it.status !== 'ok') return;
    it.prevState = 1;
    pq.push(it);
    pump();
  }
  function pump() {
    if (pBusy) return;
    var it = pq.shift();
    if (!it) return;
    pBusy = true;
    makePreview(it).catch(function () { it.prevState = -1; renderCard(it); })
      .then(function () { pBusy = false; setTimeout(pump, 0); });
  }
  function makePreview(it) {
    if (it.removed || !it.blob) return Promise.resolve();
    var k = Math.min(1, PREVIEW / Math.max(it.w || 1, it.h || 1));
    var pw = Math.max(1, Math.round((it.w || PREVIEW) * k)), ph = Math.max(1, Math.round((it.h || PREVIEW) * k));
    return decodeSmall(it.blob, pw, ph).then(function (d) {
      var c;
      try {
        c = canvasOf(pw, ph);
        c.getContext('2d').drawImage(d.src, 0, 0, d.w, d.h, 0, 0, pw, ph);
      } finally { d.close(); }
      return canvasBlob(c);
    }).then(function (b) {
      if (!b) throw new Error('preview encode failed');
      if (it.removed) return;
      it.prevUrl = URL.createObjectURL(b);
      it.els.img.src = it.prevUrl;
      it.els.img.hidden = false;
      it.prevState = 2;
      renderCard(it);
    });
  }

  /* ---------- trim analysis in the background (only while trim is on) ---------- */
  var tq = [], tBusy = false;
  function queueTrims() {
    if (!opts.trim) { tq = []; return; }
    tq = okItems().filter(function (it) { return it.trim === undefined; });
    pumpTrim();
  }
  function pumpTrim() {
    if (tBusy || !opts.trim) return;
    var it = tq.shift();
    if (!it) return;
    if (it.removed || it.trim !== undefined || !it.blob) { pumpTrim(); return; }
    tBusy = true;
    decodeFull(it.blob).then(function (d) {
      try { if (d.w && d.h) { it.trim = trimOf(d); it.trimFor = d.w + 'x' + d.h; } }
      finally { d.close(); }
    }).catch(function () {}).then(function () {
      tBusy = false;
      if (!it.removed) renderCard(it);
      setTimeout(pumpTrim, 16);
    });
  }

  /* ---------- loading ---------- */
  var loadChain = Promise.resolve();
  function bytesFor(src) {
    if (src.type === 'bytes') return Promise.resolve(src.bytes);
    if (src.type === 'data') {
      var uri = src.uri;
      var viaCore = function () { return dataUriToBytes(uri).bytes; };
      if (typeof window.fetch !== 'function') return Promise.resolve().then(viaCore);
      return fetch(uri).then(function (r) { return r.arrayBuffer(); })
        .then(function (b) { return new Uint8Array(b); }, viaCore);
    }
    if (src.type === 'file' || src.type === 'binfile') {
      var f = pool[src.name.toLowerCase()];
      if (!f) return Promise.reject(new Error('missing'));
      return readBytes(f).then(function (u8) {
        if (src.type === 'file') return u8;
        if (src.offset + src.length > u8.length) throw new Error(src.name + ' is shorter than the bufferView');
        return u8.subarray(src.offset, src.offset + src.length);
      });
    }
    return Promise.reject(new Error(src.why || 'unreadable'));
  }
  function resolveItem(it) {
    var src = it.src;
    if (src.type === 'missing') { it.status = 'missing'; it.missing = src.name; finishItem(it); return Promise.resolve(); }
    if (src.type === 'broken') { it.status = 'broken'; it.why = src.why; finishItem(it); return Promise.resolve(); }
    it.status = 'loading';
    renderCard(it);
    return bytesFor(src).then(function (u8) {
      if (it.removed) return;
      var info = imageInfo(u8);
      if (!info) { it.status = 'broken'; it.why = 'not an image (unknown format)'; return; }
      it.mime = info.mime;
      it.w = info.w; it.h = info.h;
      it.bytes = u8.length;
      it.hash = hashBytes(u8);
      it.blob = new Blob([u8], { type: info.mime });
      it.src = null;                                   // drop the (possibly huge) data uri string
      if (!it.w || !it.h) {
        return decodeFull(it.blob).then(function (d) { it.w = d.w; it.h = d.h; d.close(); markOk(it); },
          function () { it.status = 'broken'; it.why = 'the image data is damaged'; });
      }
      markOk(it);
    }, function (err) {
      if ((src.type === 'file' || src.type === 'binfile') && !pool[src.name.toLowerCase()]) { it.status = 'missing'; it.missing = src.name; }
      else { it.status = 'broken'; it.why = (err && err.message) || 'unreadable'; }
    }).then(function () { finishItem(it); });
  }
  function markOk(it) {
    var dup = null;
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      if (o === it) break;
      if (o.status === 'ok' && o.hash === it.hash && !o.dupOf) { dup = o; break; }
    }
    it.status = 'ok';
    it.dupOf = dup ? dup.id : null;
    it.selected = !dup;
  }
  function finishItem(it) {
    if (it.removed) return;
    renderCard(it);
    if (it.status === 'ok') { observe(it); if (opts.trim) { tq.push(it); pumpTrim(); } }
    var g = groupOf(it);
    if (g) renderGroupHead(g);
    refreshState();
  }
  function groupOf(it) { for (var i = 0; i < groups.length; i++) if (groups[i].id === it.gid) return groups[i]; return null; }

  // one container: read → parse → cards → resolve images one by one (the tab stays responsive)
  function loadContainer(file, name, size, preJson, stats) {
    var g = newGroup(name, size);
    var read = preJson ? Promise.resolve(preJson) : (typeof file === 'string' ? Promise.resolve(file) : readBytes(file));
    return read.then(function (data) {
      if (g.removed) return;
      var r = parseFile(name, data, { has: function (n) { return !!pool[String(n).toLowerCase()]; } });
      data = null;
      g.kind = r.kind;
      g.generator = r.generator;
      g.roblox = r.roblox;
      g.status = 'ok';
      var made = r.images.map(function (im, k) { return newItem(g, im, k); });
      r = null;
      applyOrder();
      renderGroupHead(g);
      refreshState();
      var chain = Promise.resolve();
      made.forEach(function (it) {
        chain = chain.then(function () { if (!it.removed) return resolveItem(it).then(nextFrame); });
      });
      return chain.then(function () {
        if (g.removed) return;
        stats.images += made.filter(function (it) { return it.status === 'ok'; }).length;
        stats.dups += made.filter(function (it) { return it.dupOf; }).length;
        stats.missing += made.filter(function (it) { return it.status === 'missing'; }).length;
        stats.broken += made.filter(function (it) { return it.status === 'broken'; }).length;
        if (!g.roblox) stats.foreign++;
        applyOrder();
        renderGroupHead(g);
        syncNames();
        refreshState();
      });
    }).catch(function (err) {
      if (g.removed) return;
      g.status = 'error';
      g.error = err && err.gltf ? err.message : 'could not read this file';
      stats.errors++;
      renderGroupHead(g);
      refreshState();
    });
  }
  function summary(stats) {
    var parts = [];
    if (stats.images) parts.push(plural(stats.images, 'image') + ' extracted');
    if (stats.dups) parts.push(plural(stats.dups, 'duplicate') + ' unselected');
    if (stats.missing) parts.push(plural(stats.missing, 'missing file'));
    if (stats.broken) parts.push(stats.broken + ' unreadable');
    if (stats.errors) parts.push(plural(stats.errors, 'file') + ' failed');
    if (!parts.length) parts.push('nothing extracted');
    toast(parts.join(' · '), stats.errors || stats.missing || stats.broken ? 'warn' : '', 3200);
  }
  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var containers = [], loose = [], skipped = 0;
    files.forEach(function (f) {
      var k = kindOf(f.name, f.type);
      if (k === 'gltf' || k === 'glb') containers.push(f);
      else if (k === 'image' || k === 'bin') loose.push(f);
      else skipped++;
    });
    loose.forEach(function (f) { pool[baseOf(f.name).toLowerCase()] = f; });
    if (!containers.length) {
      var fixed = resolveLater(loose);
      if (fixed) toast(plural(fixed, 'missing image') + ' found');
      else if (loose.length) toast('kept ' + plural(loose.length, 'file') + ' for a .gltf that points to ' + (loose.length === 1 ? 'it' : 'them') + ' — drop the .gltf too', 'warn', 3600);
      else if (skipped) toast('only .gltf / .glb (and the pngs they use)', 'warn');
      return;
    }
    var stats = { images: 0, dups: 0, missing: 0, broken: 0, errors: 0, foreign: 0 };
    var batch = loadChain.then(function () {
      var c = Promise.resolve();
      containers.forEach(function (f) { c = c.then(function () { return loadContainer(f, f.name, f.size, null, stats); }); });
      return c;
    });
    loadChain = batch.then(function () {
      resolveLater(loose);
      summary(stats);
    }).catch(function () {});
    if (skipped) toast('skipped ' + plural(skipped, 'unsupported file'), 'warn');
  }
  // a loose png dropped after its .gltf completes the "missing file" cards
  function resolveLater(loose) {
    var names = {};
    loose.forEach(function (f) { names[baseOf(f.name).toLowerCase()] = true; });
    var fixed = 0;
    items.forEach(function (it) {
      if (it.status === 'missing' && names[String(it.missing).toLowerCase()] && it.src) {
        var s = it.src;
        if (s.type === 'missing') {
          // the source only knew the name; re-derive what kind of file it was from the original src
          it.src = s.offset != null ? { type: 'binfile', name: s.name, offset: s.offset, length: s.length } : { type: 'file', name: s.name };
        }
        fixed++;
        loadChain = loadChain.then(function () { return resolveItem(it); }).then(function () { syncNames(); refreshState(); });
      }
    });
    return fixed;
  }
  function loadJsonText(text, label) {
    var stats = { images: 0, dups: 0, missing: 0, broken: 0, errors: 0, foreign: 0 };
    var name = label || nextPasteName();
    loadChain = loadChain.then(function () { return loadContainer(text, name, text.length, null, stats); })
      .then(function () { summary(stats); }).catch(function () {});
  }
  var pasteN = 0;
  function nextPasteName() { pasteN++; return pasteN === 1 ? 'pasted.gltf' : 'pasted-' + pasteN + '.gltf'; }

  /* ---------- removing ---------- */
  function disposeItem(it) {
    it.removed = true;
    if (it.prevUrl) { URL.revokeObjectURL(it.prevUrl); it.prevUrl = null; }
    if (io && it.els) io.unobserve(it.els.card);
    delete used[String(it.name).toLowerCase()];
    delete byId[it.id];
    it.blob = null; it.src = null;
  }
  function recheckDups() {
    var hashes = items.map(function (it) { return it.status === 'ok' ? it.hash : null; });
    var dups = markDuplicates(hashes);
    items.forEach(function (it, i) {
      var was = it.dupOf;
      it.dupOf = dups[i] >= 0 ? items[dups[i]].id : null;
      if (was !== it.dupOf) renderCard(it);
    });
  }
  function removeGroup(g) {
    g.removed = true;
    g.items.forEach(function (id) { var it = byId[id]; if (it) disposeItem(it); });
    items = items.filter(function (it) { return !it.removed; });
    groups = groups.filter(function (x) { return x !== g; });
    if (g.el.parentNode) g.el.parentNode.removeChild(g.el);
    recheckDups();
    groups.forEach(renderGroupHead);
    syncNames();
    refreshState();
    toast('removed ' + g.file);
  }
  function clearAll() {
    if (!groups.length) return;
    groups.slice().forEach(function (g) {
      g.removed = true;
      g.items.forEach(function (id) { var it = byId[id]; if (it) disposeItem(it); });
      if (g.el.parentNode) g.el.parentNode.removeChild(g.el);
    });
    groups = []; items = []; byId = {}; used = {}; pool = {}; pq = []; tq = [];
    if (searchIn) searchIn.value = '';
    filter = '';
    refreshState();
    toast('cleared');
  }

  /* ---------- selection / filter / state ---------- */
  function matchesFilter(it) {
    if (!filter) return true;
    var f = filter.toLowerCase();
    return displayName(it).toLowerCase().indexOf(f) !== -1 || String(it.raw).toLowerCase().indexOf(f) !== -1;
  }
  function applyFilter() {
    items.forEach(function (it) { if (it.els) it.els.card.hidden = !matchesFilter(it); });
    groups.forEach(renderGroupHead);
  }
  function setSelected(list, on) {
    list.forEach(function (it) { if (it.status === 'ok') { it.selected = on; renderCard(it); } });
    groups.forEach(renderGroupHead);
    syncNames();
    refreshState();
  }
  function refreshState() {
    var ok = items.filter(function (it) { return it.status === 'ok'; });
    var sel = ok.filter(function (it) { return it.selected; }).length;
    var has = groups.length > 0;
    if (emptyEl) emptyEl.hidden = has;
    if (toolbar) toolbar.hidden = !has;
    if (selCount) selCount.textContent = sel + ' of ' + ok.length + ' selected';
    if (infoEl) {
      infoEl.textContent = has ? plural(groups.length, 'file') + ' · ' + plural(ok.length, 'image') : 'no files yet';
    }
    if (sortSel) {
      sortSel.value = effSort();
      sortSel.disabled = !anyTimes();
      sortSel.title = anyTimes() ? '' : 'these images carry no capture time';
    }
    syncSaveUI();
  }

  /* ---------- options ---------- */
  function saveOpts() { try { localStorage.setItem(LS_OPTS, JSON.stringify(opts)); } catch (e) {} }
  function loadOpts() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(LS_OPTS) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') return;
    if (typeof s.trim === 'boolean') opts.trim = s.trim;
    if (s.padding != null) opts.padding = clampPad(s.padding);
    if (BGS.indexOf(s.bg) !== -1) opts.bg = s.bg;
    if (SCALES.indexOf(String(s.scale)) !== -1) opts.scale = String(s.scale);
    if (typeof s.prefix === 'string') opts.prefix = s.prefix.slice(0, 40);
    if (PBGS.indexOf(s.previewBg) !== -1) opts.previewBg = s.previewBg;
    if (s.nameStyle === 'numbered' || s.nameStyle === 'original') opts.nameStyle = s.nameStyle;
    if (SORTS.indexOf(s.sort) !== -1) opts.sort = s.sort;
  }
  function syncRadio(row, attr, val) {
    if (!row) return;
    Array.prototype.forEach.call(row.querySelectorAll('[' + attr + ']'), function (b) {
      var on = b.getAttribute(attr) === val;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function optLabel() {
    var p = [];
    if (opts.trim) p.push('empty space removed' + (opts.padding ? ' (' + opts.padding + ' px margin)' : ''));
    if (opts.bg !== 'transparent') p.push(opts.bg + ' background');
    if (opts.scale !== '1') p.push(opts.scale.indexOf('fit') === 0 ? 'max ' + opts.scale.slice(3) + ' px' : (opts.scale === '0.5' ? 'half size' : 'double size'));
    return p.join(' · ');
  }
  function syncOptsUI() {
    trimIn.checked = opts.trim;
    padIn.value = String(opts.padding);
    padIn.disabled = !opts.trim;
    padRow.classList.toggle('is-off', !opts.trim);
    padVal.textContent = opts.padding + ' px';
    syncRadio(bgRow, 'data-bg', opts.bg);
    syncRadio(scaleRow, 'data-scale', opts.scale);
    syncRadio(styleRow, 'data-namestyle', opts.nameStyle);
    syncRadio(pbgRow, 'data-pbg', opts.previewBg);
    groupsEl.classList.remove('pbg-checker', 'pbg-black', 'pbg-white');
    groupsEl.classList.add('pbg-' + opts.previewBg);
    if (prefixIn.value !== opts.prefix) prefixIn.value = opts.prefix;
    var l = optLabel();
    optNote.textContent = l ? 'will change: ' + l : 'nothing changed → you get the original images, full quality';
    optNote.classList.toggle('is-on', !!l);
  }
  function optsChanged(outputChanged) {
    saveOpts();
    syncOptsUI();
    if (outputChanged) {
      items.forEach(function (it) { if (it.status === 'ok') renderCard(it); });
      queueTrims();
    }
    syncNames();
    refreshState();
  }
  function snapshotOpts() {
    return { trim: opts.trim, padding: opts.padding, bg: opts.bg, scale: opts.scale };
  }

  /* ---------- save destination: a folder (File System Access API) — mirrors update icon ---------- */
  var folderSupported = typeof window.showDirectoryPicker === 'function';
  var NO_FOLDER_MSG = 'this browser cannot pick folders — use chrome, edge or opera (brave: turn on brave://flags/#file-system-access-api)';
  var saveTo = 'downloads', saveFormat = 'png';
  var dirHandle = null, dirReady = Promise.resolve(), busy = false;

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
    var o = { id: 'umbra-gltf', mode: 'readwrite', startIn: dirHandle || 'downloads' };
    var p;
    try { p = window.showDirectoryPicker(o); } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function (h) {
      dirHandle = h;
      kvSet(IDB_DIR_KEY, h);
      return h;
    }, function (err) {
      if (err && err.name === 'AbortError') toast('no folder chosen');
      else toast('folder picker unavailable here', 'warn');
      return null;
    });
  }
  function verifyPermission(h) {
    var o = { mode: 'readwrite' };
    if (typeof h.queryPermission !== 'function') return Promise.resolve(true);
    return Promise.resolve().then(function () { return h.queryPermission(o); }).then(function (st) {
      if (st === 'granted') return true;
      if (typeof h.requestPermission !== 'function') return false;
      return h.requestPermission(o).then(function (st2) { return st2 === 'granted'; });
    }).catch(function () { return false; });
  }
  // folder + permission, resolved FIRST in every save click (before any slow work)
  function ensureFolder() {
    return dirReady.then(function () {
      if (!dirHandle) {
        return pickFolder().then(function (h) { setSaveTo(h ? 'folder' : 'downloads'); return h; });
      }
      return verifyPermission(dirHandle).then(function (ok) {
        if (ok) return dirHandle;
        toast('no permission for ' + dirHandle.name, 'warn');
        return null;
      });
    });
  }
  function forgetFolder() { dirHandle = null; kvDel(IDB_DIR_KEY); syncSaveUI(); }
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
      toast("can't reach " + nm + ' — choose the folder again' + tail, 'warn');
    } else if (err && err.code === 'ZIP_LIMIT') {
      toast(err.message, 'warn');
    } else if (err && err.name === 'TypeError' && /name/i.test(err.message || '')) {
      toast("that file name isn't allowed in folders — rename it" + tail, 'warn');
    } else {
      toast('save failed' + tail, 'warn');
    }
  }
  // chromium's file system access api rejects names downloads silently fix
  var FORMAT_CHARS = (function () {
    try { return new RegExp('[\\p{Cf}\\p{Cc}\\p{Noncharacter_Code_Point}]', 'gu'); }
    catch (e) { return /[\x00-\x1f\x7f-\x9f­​-‏‪-‮⁠-⁯﻿]/g; }
  })();
  function folderSafe(base, fallback) {
    var b = String(base).replace(FORMAT_CHARS, '').replace(/^[~_]+/, '');
    if (b.length <= 12) b = b.replace(/~/g, '_');
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9]|clock\$|conin\$|conout\$)(\.|$)/i.test(b)) b = b.replace(/^[^.]*/, '$&_');
    return b || fallback;
  }
  // first free name in the folder: base.ext, base_2.ext, … (never overwrites)
  function freeName(dir, base, ext) {
    var n = 1;
    function attempt() {
      var name = n === 1 ? base + ext : base + '_' + n + ext;
      return dir.getFileHandle(name).then(function () {
        if (++n > 9999) throw new Error('no free file name');
        return attempt();
      }, function (err) {
        if (err && err.name === 'NotFoundError') return name;
        if (err && err.name === 'TypeMismatchError') {
          if (++n > 9999) throw new Error('no free file name');
          return attempt();
        }
        throw err;
      });
    }
    return attempt();
  }
  function writeFile(dir, name, blob) {
    var created = false;
    return dir.getFileHandle(name, { create: true }).then(function (fh) {
      created = true;
      return fh.createWritable();
    }).then(function (w) {
      return Promise.resolve(w.write(blob)).then(function () { return w.close(); }, function (err) {
        var a;
        try { a = w.abort && w.abort(); } catch (e) {}
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
  // sequential writes. jobs: [{ base, ext, blob: () => Promise<Blob|null> }] → never rejects
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

  /* ---------- downloads ---------- */
  // per-session registry so repeats get _2, _3… and windows never asks to replace
  function uniqueName(base) {
    var map;
    try { map = JSON.parse(sessionStorage.getItem(SS_NAMES) || '{}'); } catch (e) { map = {}; }
    if (!map || typeof map !== 'object') map = {};
    var key = base.toLowerCase(), n = (map[key] || 0) + 1;
    map[key] = n;
    try { sessionStorage.setItem(SS_NAMES, JSON.stringify(map)); } catch (e) {}
    return n === 1 ? base : base + '_' + n;
  }
  function uniqueInSet(base, ext, set) {
    var n = 1, name = base + ext;
    while (set[name.toLowerCase()]) { n++; name = base + '_' + n + ext; }
    set[name.toLowerCase()] = true;
    return name;
  }
  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
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

  /* ---------- export ---------- */
  // names AND options are frozen at click time, so edits made while a save runs can't mix
  function snapshot(list) {
    var names = computeNames();
    return list.map(function (it) { return { it: it, base: names[it.id] || it.name }; });
  }
  function noteOf(flags) {
    var t = [];
    if (flags.empty) t.push(plural(flags.empty, 'fully transparent image') + ' kept as 1×1');
    if (flags.capped) t.push(flags.capped + ' capped at ' + CAP + ' px');
    return t.length ? ' · ' + t.join(' · ') : '';
  }
  function tally(flags, r) { if (r.empty) flags.empty++; if (r.capped) flags.capped++; }
  function markEmpty(it) { if (opts.trim && it.trim === null) renderCard(it); }

  function saveSelected() {
    if (busy) return;
    var list = selectedItems();
    if (!list.length) { toast('nothing selected'); return; }
    var zip = saveFormat === 'zip';
    if (zip && !window.UmbraZip) { toast('zip unavailable', 'warn'); return; }
    if (useFolder()) { saveToFolder(list, zip); return; }
    if (zip) { zipToDownloads(list); return; }
    downloadPngs(list);
  }
  function downloadPngs(list) {
    var snap = snapshot(list), o = snapshotOpts(), flags = { empty: 0, capped: 0 }, done = 0;
    setBusy(true);
    toast(snap.length > 1 ? 'saving ' + snap.length + ' pngs…' : 'saving…');
    var chain = Promise.resolve();
    snap.forEach(function (s, k) {
      chain = chain.then(function () {
        if (snap.length > 2) toast('saving ' + (k + 1) + '/' + snap.length + '…');
        return renderOut(s.it, o).then(function (r) {
          tally(flags, r); markEmpty(s.it);
          triggerDownload(r.blob, uniqueName(s.base) + '.png');
          done++;
          return wait(300);
        }, function () { return null; });
      });
    });
    chain.then(function () {
      if (!done) toast('could not export these images', 'warn');
      else toast((snap.length === 1 ? 'saved ' + snap[0].base + '.png' : 'saved ' + done + ' pngs') + (done < snap.length ? ' · ' + (snap.length - done) + ' failed' : '') + noteOf(flags), done < snap.length ? 'warn' : '', 3200);
    }).then(function () { setBusy(false); });
  }
  // every selected image → one zip (entries deduped inside the zip only)
  function buildZip(snap, o, flags) {
    var set = {}, files = [], chain = Promise.resolve();
    snap.forEach(function (s, k) {
      chain = chain.then(function () {
        toast('zipping ' + (k + 1) + '/' + snap.length + '…');
        return renderOut(s.it, o).then(function (r) {
          tally(flags, r); markEmpty(s.it);
          return blobBytes(r.blob).then(function (buf) {
            files.push({ name: uniqueInSet(s.base, '.png', set), data: new Uint8Array(buf) });
          });
        }, function () { return null; });
      });
    });
    return chain.then(function () {
      if (!files.length) throw new Error('nothing rendered');
      return { blob: window.UmbraZip.build(files), count: files.length };
    });
  }
  function zipBaseOf(list) {
    return zipBaseFor(cleanPrefix(opts.prefix), list.map(function (it) { var g = groupOf(it); return g ? g.file : ''; }));
  }
  function zipToDownloads(list) {
    var snap = snapshot(list), o = snapshotOpts(), flags = { empty: 0, capped: 0 }, zb = zipBaseOf(list);
    setBusy(true);
    buildZip(snap, o, flags).then(function (z) {
      var name = uniqueName(zb) + '.zip';
      triggerDownload(z.blob, name);
      toast('saved ' + name + ' · ' + plural(z.count, 'image') + noteOf(flags), '', 3200);
    }).catch(function (err) {
      toast(err && err.code === 'ZIP_LIMIT' ? err.message : 'zip failed', 'warn');
    }).then(function () { setBusy(false); });
  }
  function saveToFolder(list, zip) {
    setBusy(true);
    // folder + permission FIRST (user activation), only then the slow rendering
    ensureFolder().then(function (dir) {
      if (!dir) return;
      var snap = snapshot(list), o = snapshotOpts(), flags = { empty: 0, capped: 0 };
      if (zip) {
        var zb = folderSafe(zipBaseOf(list), 'gltf_images');
        return buildZip(snap, o, flags).then(function (z) {
          return writeJobs(dir, [{ base: zb, ext: '.zip', blob: function () { return z.blob; } }]).then(function (r) {
            if (r.error) folderFail(r.error, 0, 1);
            else toast('saved ' + r.names[0] + ' → ' + dir.name + noteOf(flags), '', 3200);
          });
        });
      }
      var jobs = snap.map(function (s) {
        return {
          base: folderSafe(s.base, 'capture'), ext: '.png',
          blob: function () { return renderOut(s.it, o).then(function (r) { tally(flags, r); markEmpty(s.it); return r.blob; }); }
        };
      });
      return writeJobs(dir, jobs, function (k, n) { if (n > 1) toast('saving ' + k + '/' + n + '…'); }).then(function (r) {
        if (r.error) folderFail(r.error, r.saved, jobs.length);
        else toast((r.saved === 1 ? 'saved ' + r.names[0] : 'saved ' + r.saved + ' pngs') + ' → ' + dir.name + noteOf(flags), '', 3200);
      });
    }).catch(function (err) { folderFail(err, 0, 1); })
      .then(function () { setBusy(false); });
  }
  // per-card: always a single png, honours "save to"
  function saveOne(it) {
    if (busy) return;
    if (useFolder()) { saveToFolderOne(it); return; }
    var base = snapshot([it])[0].base, o = snapshotOpts();
    renderOut(it, o).then(function (r) {
      markEmpty(it);
      var name = uniqueName(base) + '.png';
      triggerDownload(r.blob, name);
      toast('saved ' + name + ' · ' + r.w + '×' + r.h + (r.original ? ' · original' : ''));
    }).catch(function () { toast('could not export this image', 'warn'); });
  }
  function saveToFolderOne(it) {
    setBusy(true);
    ensureFolder().then(function (dir) {
      if (!dir) return;
      var base = folderSafe(snapshot([it])[0].base, 'capture'), o = snapshotOpts();
      return writeJobs(dir, [{ base: base, ext: '.png', blob: function () { return renderOut(it, o).then(function (r) { markEmpty(it); return r.blob; }); } }])
        .then(function (r) {
          if (r.error) folderFail(r.error, r.saved, 1);
          else if (r.saved) toast('saved ' + r.names[0] + ' → ' + dir.name);
          else toast('could not export this image', 'warn');
        });
    }).catch(function (err) { folderFail(err, 0, 1); })
      .then(function () { setBusy(false); });
  }
  function copyOne(it) {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('clipboard image not supported — use save', 'warn'); return;
    }
    var o = snapshotOpts();
    var p = renderOut(it, o).then(function (r) { markEmpty(it); return r.blob; });
    var write;
    // a promise inside the ClipboardItem keeps the click's user activation while a 4k render runs
    try { write = navigator.clipboard.write([new window.ClipboardItem({ 'image/png': p })]); }
    catch (e) { write = p.then(function (b) { return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': b })]); }); }
    Promise.resolve(write).then(function () { toast('copied to clipboard'); })
      .catch(function () { toast('copy failed — use save', 'warn'); });
  }
  // → crop / update icon / frontpage, with the current output options applied
  var SEND_LABEL = { crop: 'crop', update: 'update icon', frontpage: 'frontpage' };
  function sendTo(it, target) {
    if (!window.Hub || typeof Hub.send !== 'function') { toast(SEND_LABEL[target] + ' not available', 'warn'); return; }
    var o = snapshotOpts(), base = snapshot([it])[0].base;
    toast('sending to ' + SEND_LABEL[target] + '…');
    renderOut(it, o).then(function (r) {
      markEmpty(it);
      return blobToDataUrl(r.blob).then(function (dataUrl) {
        if (target === 'crop') Hub.send('crop', { kind: 'thumb', dataUrl: dataUrl, name: base, source: 'gltf' });
        else if (target === 'update') Hub.send('update', { kind: 'icon', dataUrl: dataUrl, name: base, source: 'gltf' });
        // no `name`: frontpage would copy it into the game name
        else Hub.send('frontpage', { kind: r.w / r.h >= 1.5 ? 'thumb' : 'icon', dataUrl: dataUrl, source: 'gltf' });
        if (typeof Hub.show === 'function') Hub.show(target);
      });
    }).catch(function () { toast('could not export this image', 'warn'); });
  }

  /* ---------- save options UI ---------- */
  function setBusy(v) {
    busy = !!v;
    syncSaveUI();
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
    saveTo = (t === 'folder' && folderSupported) ? 'folder' : 'downloads';
    saveFormat = f === 'zip' ? 'zip' : 'png';
  }
  function saveLabel(n) {
    var zip = saveFormat === 'zip';
    if (useFolder()) {
      if (!dirHandle) return zip ? 'choose folder + zip ' + n : 'choose folder + save ' + n;
      return (zip ? 'save .zip (' + n + ') → ' : 'save ' + n + ' → ') + dirHandle.name;
    }
    return zip ? 'save ' + n + ' as .zip' : 'save ' + n + ' selected';
  }
  function syncSaveUI() {
    if (!saveBtn) return;
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
    var n = items.filter(function (it) { return it.status === 'ok' && it.selected; }).length;
    var label = saveLabel(n);
    saveBtn.textContent = label;
    saveBtn.title = label;
    saveBtn.disabled = n === 0 || busy;
    saveBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
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
      else if (!dirHandle) setSaveTo('downloads');
      else { setSaveTo('folder'); toast('saving to ' + dirHandle.name); }
    });
  }

  /* ---------- paste json panel ---------- */
  function setPasteOpen(on) {
    pasteBox.hidden = !on;
    pasteToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    pasteToggle.classList.toggle('active', on);
    if (on) { try { jsonIn.focus({ preventScroll: true }); } catch (e) {} }
  }
  function extractPasted() {
    var text = jsonIn.value;
    if (!text.trim()) { toast('paste the gltf json first'); return; }
    loadJsonText(text);
    jsonIn.value = '';
    extractBtn.disabled = true;
  }
  function looksLikeGltf(text) {
    var t = String(text || '').trim();
    if (t.charAt(0) !== '{') return null;
    try { var j = JSON.parse(t); return j && typeof j === 'object' && j.asset ? j : null; } catch (e) { return null; }
  }

  /* ---------- wiring ---------- */
  function cardItem(el) {
    var card = el && el.closest && el.closest('.gl-card');
    return card ? byId[card.dataset.id] || null : null;
  }
  function wire() {
    // input
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      var fl = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      addFiles(fl);
    });
    pasteToggle.addEventListener('click', function () { setPasteOpen(pasteBox.hidden); });
    jsonIn.addEventListener('input', function () { extractBtn.disabled = !jsonIn.value.trim(); });
    jsonIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); extractPasted(); }
    });
    extractBtn.addEventListener('click', extractPasted);

    // output options
    trimIn.addEventListener('change', function () { opts.trim = trimIn.checked; optsChanged(true); });
    padIn.addEventListener('input', function () { opts.padding = clampPad(padIn.value); optsChanged(true); });
    bgRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bg]'); if (!b) return;
      opts.bg = b.dataset.bg; optsChanged(true);
    });
    scaleRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-scale]'); if (!b) return;
      opts.scale = b.dataset.scale; optsChanged(true);
    });
    styleRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-namestyle]'); if (!b) return;
      opts.nameStyle = b.dataset.namestyle; optsChanged(false);
    });
    prefixIn.addEventListener('input', function () { opts.prefix = prefixIn.value; optsChanged(false); });
    pbgRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pbg]'); if (!b) return;
      opts.previewBg = b.dataset.pbg; saveOpts(); syncOptsUI();
    });

    // toolbar
    selAllBtn.addEventListener('click', function () { setSelected(items.filter(matchesFilter), true); });
    selNoneBtn.addEventListener('click', function () { setSelected(items.filter(matchesFilter), false); });
    searchIn.addEventListener('input', function () { filter = searchIn.value.trim(); applyFilter(); });
    sortSel.addEventListener('change', function () { opts.sort = sortSel.value; saveOpts(); applyOrder(); syncNames(); refreshState(); });
    clearBtn.addEventListener('click', clearAll);

    // groups + cards (delegated)
    groupsEl.addEventListener('click', function (e) {
      var head = e.target.closest('.gl-ghead');
      if (head) {
        var g = null, gEl = head.closest('.gl-group');
        for (var i = 0; i < groups.length; i++) if (groups[i].el === gEl) g = groups[i];
        if (!g) return;
        if (e.target.closest('.gl-gdel')) { removeGroup(g); return; }
        if (e.target.closest('.gl-gtoggle')) {
          g.collapsed = !g.collapsed;
          g.el.classList.toggle('is-collapsed', g.collapsed);
          g.toggle.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true');
        }
        return;
      }
      var it = cardItem(e.target);
      if (!it) return;
      var btn = e.target.closest('[data-act]');
      if (btn) {
        if (btn.disabled || it.status !== 'ok') return;
        var act = btn.dataset.act;
        if (act === 'dl') saveOne(it);
        else if (act === 'copy') copyOne(it);
        else if (act === 'crop') sendTo(it, 'crop');
        else if (act === 'update') sendTo(it, 'update');
        else if (act === 'fp') sendTo(it, 'frontpage');
        return;
      }
      // a click on the preview toggles the selection (the checkbox handles itself)
      if (e.target.closest('.gl-cb')) return;
      if (e.target.closest('.gl-prev') && it.status === 'ok') {
        it.selected = !it.selected;
        renderCard(it);
        var gg = groupOf(it); if (gg) renderGroupHead(gg);
        syncNames(); refreshState();
      }
    });
    groupsEl.addEventListener('change', function (e) {
      var t = e.target;
      if (t.closest('.gl-gsel')) {
        var gEl = t.closest('.gl-group'), g = null;
        for (var i = 0; i < groups.length; i++) if (groups[i].el === gEl) g = groups[i];
        if (g) setSelected(g.items.map(function (id) { return byId[id]; }).filter(Boolean), t.checked);
        return;
      }
      var it = cardItem(t);
      if (it && t.closest('.gl-cb')) {
        it.selected = t.checked && it.status === 'ok';
        renderCard(it);
        var gg = groupOf(it); if (gg) renderGroupHead(gg);
        syncNames(); refreshState();
      }
    });
    // inline rename (enter commits, esc reverts, blur shows the sanitized name)
    groupsEl.addEventListener('input', function (e) {
      var it = cardItem(e.target);
      if (!it || !e.target.closest('.gl-name')) return;
      it.override = e.target.value;
      syncNames();
    });
    groupsEl.addEventListener('focusin', function (e) {
      var it = cardItem(e.target);
      if (it && e.target.closest('.gl-name')) it.prevOverride = it.override;
    });
    groupsEl.addEventListener('keydown', function (e) {
      var it = cardItem(e.target);
      if (!it || !e.target.closest('.gl-name')) return;
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); it.override = it.prevOverride || ''; e.target.value = it.override; syncNames(); e.target.blur(); }
    });
    groupsEl.addEventListener('focusout', function (e) {
      var it = cardItem(e.target);
      if (!it || !e.target.closest('.gl-name')) return;
      var clean = safeBase(it.override);
      it.override = clean;
      e.target.value = clean;
      syncNames();
      renderCard(it);
      items.forEach(function (o) { if (o.dupOf === it.id) renderCard(o); });
    });

    // save
    saveBtn.addEventListener('click', saveSelected);
    saveToRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-saveto]'); if (!b || b.disabled) return;
      if (b.dataset.saveto !== 'folder') { setSaveTo('downloads'); return; }
      if (!folderSupported) { toast(NO_FOLDER_MSG, 'warn'); return; }
      // always open the picker so you can see / change where it saves (cancel keeps the last folder)
      chooseFolder();
    });
    folderBtn.addEventListener('click', function () { if (folderSupported) chooseFolder(); else toast(NO_FOLDER_MSG, 'warn'); });
    formatRow.addEventListener('click', function (e) {
      var b = e.target.closest('[data-format]'); if (!b) return;
      setFormat(b.dataset.format);
    });

    // paste: files, or gltf json text — only while gltf is the active tool, never while typing
    document.addEventListener('paste', function (e) {
      if (!isActive() || typingIn(e.target)) return;
      var cd = e.clipboardData;
      if (!cd) return;
      var files = [];
      if (cd.files && cd.files.length) files = Array.prototype.slice.call(cd.files);
      else if (cd.items) {
        for (var i = 0; i < cd.items.length; i++) {
          if (cd.items[i].kind === 'file') { var f = cd.items[i].getAsFile(); if (f) files.push(f); }
        }
      }
      if (files.length) { e.preventDefault(); addFiles(files); return; }
      var text = cd.getData('text/plain') || cd.getData('text') || '';
      if (!text.trim()) return;
      var j = looksLikeGltf(text);
      if (j) { e.preventDefault(); loadJsonText(text); return; }
      if (text.trim().charAt(0) === '{') toast('that json is not a gltf (no "asset")', 'warn');
    });
    // drag & drop anywhere on the tool; files dropped elsewhere never open in the tab
    var depth = 0;
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
    }
    document.addEventListener('dragover', function (e) { if (isActive() && hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!isActive() || !hasFiles(e)) return;
      e.preventDefault();
      depth = 0; drop.classList.remove('drag-over');
      if (e.target && e.target.closest && e.target.closest('#tool-gltf')) addFiles(e.dataTransfer.files);
    });
    rootEl.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; depth++; drop.classList.add('drag-over'); });
    rootEl.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('drag-over'); });

    document.addEventListener('hub:show', function (e) {
      if (e && e.detail && e.detail.tool !== TOOL && toastEl) { clearTimeout(toastTimer); toastEl.classList.remove('visible'); }
    });
  }

  /* ---------- init ---------- */
  function init() {
    rootEl = $('tool-gltf');
    if (!rootEl) return;
    infoEl = $('gl-info'); drop = $('gl-drop'); fileInput = $('gl-file');
    pasteToggle = $('gl-paste-toggle'); pasteBox = $('gl-paste'); jsonIn = $('gl-json'); extractBtn = $('gl-extract');
    trimIn = $('gl-trim'); padRow = $('gl-pad-row'); padIn = $('gl-pad'); padVal = $('gl-pad-v');
    bgRow = $('gl-bg'); scaleRow = $('gl-scale'); optNote = $('gl-optnote'); styleRow = $('gl-namestyle'); prefixIn = $('gl-prefix');
    saveToRow = $('gl-saveto'); folderRow = $('gl-folder'); folderNameEl = $('gl-folder-name'); folderBtn = $('gl-folder-change');
    formatRow = $('gl-format'); saveBtn = $('gl-save');
    toolbar = $('gl-toolbar'); selAllBtn = $('gl-sel-all'); selNoneBtn = $('gl-sel-none'); selCount = $('gl-selcount');
    searchIn = $('gl-search'); sortSel = $('gl-sort'); pbgRow = $('gl-pbg'); clearBtn = $('gl-clear');
    groupsEl = $('gl-groups'); emptyEl = $('gl-empty'); toastEl = $('gl-toast');
    var required = [infoEl, drop, fileInput, pasteToggle, pasteBox, jsonIn, extractBtn, trimIn, padRow, padIn, padVal,
      bgRow, scaleRow, optNote, styleRow, prefixIn, saveToRow, folderRow, folderNameEl, folderBtn, formatRow, saveBtn,
      toolbar, selAllBtn, selNoneBtn, selCount, searchIn, sortSel, pbgRow, clearBtn, groupsEl, emptyEl];
    for (var i = 0; i < required.length; i++) if (!required[i]) return;

    loadOpts();
    loadSavePrefs();
    loadFolder();
    syncOptsUI();
    wire();
    refreshState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
