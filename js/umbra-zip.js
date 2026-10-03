/* =========================================================================
   UMBRA ZIP — tiny zero-dependency zip writer (STORE method, no compression)
   window.UmbraZip.build([{ name, data: Uint8Array | ArrayBuffer }]) → Blob
   PKZIP APPNOTE 4.3: local headers + data, central directory, end record.
   UTF-8 names (general-purpose flag bit 11), CRC-32 (IEEE), DOS timestamps.
   No ZIP64: throws (err.code = 'ZIP_LIMIT') above 65535 entries or 4 GiB.
   PNGs are already deflated, so STORE loses nothing and stays instant.
   ========================================================================= */
(function (root) {
  'use strict';

  var MAX_ENTRIES = 0xFFFF;
  var MAX_U32 = 0xFFFFFFFF;

  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(u8) {
    var t = crcTable(), c = 0xFFFFFFFF;
    for (var i = 0, n = u8.length; i < n; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // MS-DOS time/date (local time, 2-second resolution, 1980..2107)
  function dosDateTime(d) {
    var y = d.getFullYear();
    if (y < 1980) return { time: 0, date: (1 << 5) | 1 };            // 1980-01-01 00:00:00
    if (y > 2107) y = 2107;
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data == null) return new Uint8Array(0);
    throw new TypeError('UmbraZip: entry data must be a Uint8Array or ArrayBuffer');
  }

  function limit(msg) { var e = new Error(msg); e.code = 'ZIP_LIMIT'; return e; }

  function build(files) {
    files = files || [];
    if (files.length > MAX_ENTRIES) throw limit('zip: too many files (max ' + MAX_ENTRIES + ')');

    var stamp = dosDateTime(new Date());
    var parts = [], central = [], offset = 0, cdSize = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var name = String((f && f.name) || ('file-' + (i + 1))).replace(/\\/g, '/').replace(/^\/+/, '');
      var nameBytes = utf8(name);
      if (nameBytes.length > 0xFFFF) throw limit('zip: file name too long');
      var data = toBytes(f && f.data);
      var size = data.length;
      if (size > MAX_U32 || offset + 30 + nameBytes.length + size > MAX_U32) throw limit('zip: archive larger than 4 GiB');
      var crc = crc32(data);

      // local file header (30 bytes + name)
      var lh = new Uint8Array(30 + nameBytes.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);              // version needed: 2.0
      lv.setUint16(6, 0x0800, true);          // flags: bit 11 = utf-8 names
      lv.setUint16(8, 0, true);               // method: store
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);           // compressed size
      lv.setUint32(22, size, true);           // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);              // extra length
      lh.set(nameBytes, 30);

      // central directory record (46 bytes + name)
      var ch = new Uint8Array(46 + nameBytes.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);              // version made by: 2.0, MS-DOS attrs
      cv.setUint16(6, 20, true);              // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);              // extra length
      cv.setUint16(32, 0, true);              // comment length
      cv.setUint16(34, 0, true);              // disk number start
      cv.setUint16(36, 0, true);              // internal attrs
      cv.setUint32(38, 0, true);              // external attrs
      cv.setUint32(42, offset, true);         // local header offset
      ch.set(nameBytes, 46);

      parts.push(lh, data);
      central.push(ch);
      offset += lh.length + size;
      cdSize += ch.length;
    }
    if (offset + cdSize + 22 > MAX_U32) throw limit('zip: archive larger than 4 GiB');

    // end of central directory (22 bytes)
    var eo = new Uint8Array(22), ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [eo]), { type: 'application/zip' });
  }

  root.UmbraZip = { build: build, crc32: crc32 };
})(typeof window !== 'undefined' ? window : this);
