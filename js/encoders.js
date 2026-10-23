// Lampyva — image encoders that run 100% in the browser.

/** Load a classic script once (used for heavy libraries only when needed). */
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}

/** Copy a canvas onto a solid background (for formats without transparency). */
export function flatten(canvas, background = "#ffffff") {
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

export function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Your browser could not create this file."))),
      mime,
      quality
    );
  });
}

/** True if this browser can really encode the given type with canvas.toBlob. */
const support = {};
export async function canEncode(mime) {
  if (mime in support) return support[mime];
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    const b = await canvasToBlob(c, mime, 0.8);
    support[mime] = b.type === mime;
  } catch {
    support[mime] = false;
  }
  return support[mime];
}

function rgba(canvas) {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

/* ---------- BMP (24-bit) ---------- */
export function encodeBMP(canvas, background) {
  const w = canvas.width, h = canvas.height;
  const px = rgba(flatten(canvas, background));
  const stride = (w * 3 + 3) & ~3;
  const size = 54 + stride * h;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, stride * h, true);
  dv.setInt32(38, 2835, true); // 72 DPI
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      u8[o++] = px[i + 2];
      u8[o++] = px[i + 1];
      u8[o++] = px[i];
    }
  }
  return new Blob([buf], { type: "image/bmp" });
}

/* ---------- ICO (PNG images inside, several sizes) ---------- */
export async function encodeICO(canvas) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const scale = Math.min(s / canvas.width, s / canvas.height);
    const dw = Math.max(1, Math.round(canvas.width * scale));
    const dh = Math.max(1, Math.round(canvas.height * scale));
    ctx.drawImage(canvas, Math.floor((s - dw) / 2), Math.floor((s - dh) / 2), dw, dh);
    pngs.push(new Uint8Array(await (await canvasToBlob(c, "image/png")).arrayBuffer()));
  }
  const header = new DataView(new ArrayBuffer(6 + 16 * sizes.length));
  header.setUint16(2, 1, true);
  header.setUint16(4, sizes.length, true);
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.setUint8(e, s >= 256 ? 0 : s);
    header.setUint8(e + 1, s >= 256 ? 0 : s);
    header.setUint16(e + 4, 1, true);
    header.setUint16(e + 6, 32, true);
    header.setUint32(e + 8, pngs[i].length, true);
    header.setUint32(e + 12, offset, true);
    offset += pngs[i].length;
  });
  return new Blob([header, ...pngs], { type: "image/x-icon" });
}

/* ---------- GIF (still image, up to 256 colors, keeps transparency) ---------- */
function quantize(px, maxColors) {
  // 5 bits per channel histogram
  const counts = new Uint32Array(32768);
  let hasAlpha = false;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) { hasAlpha = true; continue; }
    counts[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
  }
  const limit = hasAlpha ? maxColors - 1 : maxColors;
  const buckets = [];
  for (let k = 0; k < 32768; k++) if (counts[k]) buckets.push(k);

  const ch = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const makeBox = (items) => {
    let total = 0;
    const min = [31, 31, 31], max = [0, 0, 0];
    for (const k of items) {
      total += counts[k];
      for (let c = 0; c < 3; c++) {
        const v = ch(k, c);
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { items, total, axis, range: ranges[axis] };
  };

  const boxes = buckets.length ? [makeBox(buckets)] : [];
  while (boxes.length < limit) {
    let best = -1, score = 0;
    boxes.forEach((b, i) => {
      const s = b.range * Math.sqrt(b.total);
      if (b.items.length > 1 && s > score) { score = s; best = i; }
    });
    if (best < 0) break;
    const box = boxes[best];
    box.items.sort((a, b) => ch(a, box.axis) - ch(b, box.axis));
    let acc = 0, cut = 0;
    // stop at length-2 so both halves always keep at least one color
    for (; cut < box.items.length - 2; cut++) {
      acc += counts[box.items[cut]];
      if (acc >= box.total / 2) break;
    }
    boxes.splice(best, 1, makeBox(box.items.slice(0, cut + 1)), makeBox(box.items.slice(cut + 1)));
  }

  const palette = [];
  const lookup = new Int16Array(32768).fill(-1);
  boxes.forEach((b, idx) => {
    let r = 0, g = 0, bl = 0;
    for (const k of b.items) {
      const n = counts[k];
      r += ((k >> 10) * 8 + 4) * n;
      g += (((k >> 5) & 31) * 8 + 4) * n;
      bl += ((k & 31) * 8 + 4) * n;
      lookup[k] = idx;
    }
    palette.push([Math.round(r / b.total), Math.round(g / b.total), Math.round(bl / b.total)]);
  });
  let transparentIndex = -1;
  if (hasAlpha) { transparentIndex = palette.length; palette.push([0, 0, 0]); }
  if (!palette.length) palette.push([0, 0, 0]);

  const indices = new Uint8Array(px.length / 4);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (px[i + 3] < 128) { indices[p] = transparentIndex; continue; }
    indices[p] = lookup[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)];
  }
  return { palette, indices, transparentIndex };
}

function lzw(indices, minCodeSize) {
  const out = [];
  let cur = 0, shift = 0;
  const emit = (code, size) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) { out.push(cur & 0xff); cur >>>= 8; shift -= 8; }
  };
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let table = new Map();
  emit(clear, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found === undefined) {
      emit(prefix, codeSize);
      if (next === 4096) {
        emit(clear, codeSize);
        next = eoi + 1;
        codeSize = minCodeSize + 1;
        table = new Map();
      } else {
        if (next >= 1 << codeSize) codeSize++;
        table.set(key, next++);
      }
      prefix = k;
    } else {
      prefix = found;
    }
  }
  emit(prefix, codeSize);
  emit(eoi, codeSize);
  if (shift > 0) out.push(cur & 0xff);
  return out;
}

export function encodeGIF(canvas) {
  const w = canvas.width, h = canvas.height;
  const { palette, indices, transparentIndex } = quantize(rgba(canvas), 256);
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const tableSize = 1 << bits;
  const minCodeSize = Math.max(2, bits);
  const bytes = [];
  const push16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  bytes.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  push16(w); push16(h);
  bytes.push(0x80 | 0x70 | (bits - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    bytes.push(c[0], c[1], c[2]);
  }
  if (transparentIndex >= 0) bytes.push(0x21, 0xf9, 0x04, 0x01, 0, 0, transparentIndex, 0);
  bytes.push(0x2c); push16(0); push16(0); push16(w); push16(h); bytes.push(0);
  bytes.push(minCodeSize);
  const data = lzw(indices, minCodeSize);
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    bytes.push(chunk.length, ...chunk);
  }
  bytes.push(0, 0x3b);
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

/* ---------- PDF (one image per page, page = image size) ---------- */
export async function encodePDF(canvases, background, quality = 0.92) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const add = (part) => {
    const b = typeof part === "string" ? enc.encode(part) : part;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n, body) => { offsets[n] = pos; add(`${n} 0 obj\n${body}\nendobj\n`); };

  add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = canvases.length;
  const pageNums = canvases.map((_, i) => 3 + i * 3);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(" ")}] /Count ${n} >>`);

  for (let i = 0; i < n; i++) {
    const c = canvases[i];
    const pw = +(c.width * 0.75).toFixed(2), ph = +(c.height * 0.75).toFixed(2); // 96 DPI
    const p = pageNums[i], img = p + 1, content = p + 2;
    const jpg = new Uint8Array(await (await canvasToBlob(flatten(c, background), "image/jpeg", quality)).arrayBuffer());
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    offsets[img] = pos;
    add(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    add(jpg);
    add("\nendstream\nendobj\n");
    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  const total = 3 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
  add(x);
  add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

/* ---------- TIFF (uses UTIF.js, loaded only when needed) ---------- */
export async function encodeTIFF(canvas) {
  await loadScript("vendor/UTIF.js");
  const px = rgba(canvas);
  const buf = window.UTIF.encodeImage(px.buffer.slice(0), canvas.width, canvas.height);
  return new Blob([buf], { type: "image/tiff" });
}
