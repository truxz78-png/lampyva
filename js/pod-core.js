// Lampyva — print-on-demand pixel work, with no page access (it runs in a background worker,
// so the page keeps scrolling smoothly while big images are processed).
// Every function works on raw RGBA bytes: d = Uint8ClampedArray, W × H pixels.

/**
 * Remove white background.
 * mode "connected": only white touching the edges (keeps whites inside the drawing — illustrations).
 * mode "all": every white pixel (text / lettering designs, so letter holes become transparent too).
 * opts.holes: also remove PURE white areas closed inside the design (between stems, leaves…),
 *   bigger than opts.holeMin (fraction of the image). Cream, ivory and light colors always stay;
 *   they are counted in creamKept so the page can say so.
 * Clean edges: the light, grayish pixels around the outlines are turned into the outline color
 * with partial transparency ("white to alpha"), so there is no light halo on dark shirts.
 */
export function removeWhiteData(d, W, H, mode = "connected", opts = {}) {
  const fuzz = opts.fuzz || 0.12;
  const N = W * H;
  const t0 = 441.7 * fuzz;
  const dist = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const r = 255 - d[p * 4], g = 255 - d[p * 4 + 1], b = 255 - d[p * 4 + 2];
    dist[p] = d[p * 4 + 3] < 8 ? 0 : Math.sqrt(r * r + g * g + b * b);
  }
  const bg = new Uint8Array(N); // 1 = background
  const stack = new Int32Array(N);
  let creamKept = 0;
  if (mode === "all") {
    for (let p = 0; p < N; p++) if (dist[p] < t0) bg[p] = 1;
  } else {
    let n = 0;
    const push = (p) => { if (!bg[p] && dist[p] < t0) { bg[p] = 1; stack[n++] = p; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (n) {
      const p = stack[--n], x = p % W;
      if (x > 0) push(p - 1);
      if (x < W - 1) push(p + 1);
      if (p >= W) push(p - W);
      if (p < W * (H - 1)) push(p + W);
    }
    if (opts.holes) creamKept = removeHoles(bg, d, W, H, stack, opts.holeMin || 2e-5);
  }
  cleanEdges(d, bg, W, H, Math.max(2, Math.round(Math.min(W, H) / 500)));
  return { creamKept };
}

/**
 * Closed light areas inside the design. Only areas that are PURE white on average
 * (almost #FFFFFF, no color) are removed. Cream, ivory, pastel and gray areas stay —
 * they are often part of the drawing (sugar cubes, flowers, pages of a book).
 * Returns how many big light-colored areas were kept.
 */
function removeHoles(bg, d, W, H, stack, holeMin) {
  const N = W * H, minArea = Math.max(20, Math.round(N * holeMin));
  const light = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (d[i + 3] >= 8 && mn >= 200 && mx - mn <= 40) light[p] = 1;
  }
  const seen = new Uint8Array(N);
  const members = [];
  let creamKept = 0;
  for (let s = 0; s < N; s++) {
    if (bg[s] || seen[s] || !light[s]) continue;
    let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sumMin = 0, sumChroma = 0;
    members.length = 0;
    seen[s] = 1; stack[n++] = s;
    while (n) {
      const p = stack[--n], x = p % W, y = (p - x) / W, i = p * 4;
      members.push(p);
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      sumMin += mn; sumChroma += mx - mn;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0) { const q = p - 1; if (!seen[q] && !bg[q] && light[q]) { seen[q] = 1; stack[n++] = q; } }
      if (x < W - 1) { const q = p + 1; if (!seen[q] && !bg[q] && light[q]) { seen[q] = 1; stack[n++] = q; } }
      if (p >= W) { const q = p - W; if (!seen[q] && !bg[q] && light[q]) { seen[q] = 1; stack[n++] = q; } }
      if (p < N - W) { const q = p + W; if (!seen[q] && !bg[q] && light[q]) { seen[q] = 1; stack[n++] = q; } }
    }
    const area = members.length;
    if (area < minArea) continue;
    // pure white only: bright and with (almost) no color
    if (sumMin / area < 232 || sumChroma / area > 6) { if (area >= Math.max(minArea * 10, N * 2e-4)) creamKept++; continue; }
    // a small ROUND white spot is usually a highlight (eyes, shine): keep it.
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const round = area / (bw * bh) > 0.62 && Math.max(bw, bh) / Math.min(bw, bh) < 1.6;
    if (round && area < minArea * 40) continue;
    for (const p of members) bg[p] = 1;
  }
  return creamKept;
}

/**
 * Pixels within `R` of the removed background: "white to alpha".
 * A light pixel next to the background is a mix of the drawing and white, so it becomes the
 * drawing color with the matching transparency (gray → semi-transparent dark), never a light fringe.
 */
function cleanEdges(d, bg, W, H, R) {
  const N = W * H;
  let ring = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (bg[p]) ring[p] = 1;
  const near = new Uint8Array(N);
  for (let r = 0; r < R; r++) {
    const next = ring.slice();
    for (let p = 0; p < N; p++) {
      if (ring[p]) continue;
      const x = p % W;
      if ((x > 0 && ring[p - 1]) || (x < W - 1 && ring[p + 1]) || (p >= W && ring[p - W]) || (p < N - W && ring[p + W])) { next[p] = 1; near[p] = 1; }
    }
    ring = next;
  }
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (bg[p]) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
    if (!near[p]) continue;
    const a = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]) / 255; // how far from white
    if (a >= 0.999) continue;
    if (a < 0.02) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(255 - (255 - d[i + k]) / a);
    d[i + 3] = Math.round(d[i + 3] * a);
  }
}

/**
 * Loose specks: AI images often have almost invisible gray scratches and dots near the edges.
 * They are separate from the design, so they would make the crop too big (small, off-center design).
 * Removed: faint pieces (never fully visible) and dust of a few pixels.
 * Kept: anything clearly visible (stars, dots, separate letters).
 */
export function removeSpecks(d, W, H) {
  const N = W * H;
  const label = new Int32Array(N); // 0 = empty, k = piece number k
  const stack = new Int32Array(N);
  const dust = Math.max(3, Math.round(N * 1.5e-6)), faintMax = Math.round(N * 0.004);
  let areas = new Int32Array(1024), maxAs = new Uint8Array(1024), k = 0;
  for (let s = 0; s < N; s++) {
    if (label[s] || d[s * 4 + 3] <= 10) continue;
    k++;
    if (k >= areas.length) { const a = new Int32Array(areas.length * 2); a.set(areas); areas = a; const m = new Uint8Array(maxAs.length * 2); m.set(maxAs); maxAs = m; }
    let n = 0, area = 0, maxA = 0;
    label[s] = k; stack[n++] = s;
    while (n) {
      const p = stack[--n], x = p % W;
      area++;
      if (d[p * 4 + 3] > maxA) maxA = d[p * 4 + 3];
      for (let dy = -1; dy <= 1; dy++) {
        const row = p + dy * W;
        if (row < 0 || row >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = row + dx;
          if (!label[q] && d[q * 4 + 3] > 10) { label[q] = k; stack[n++] = q; }
        }
      }
    }
    areas[k] = area; maxAs[k] = maxA;
  }
  const drop = new Uint8Array(k + 1);
  let removed = 0;
  for (let j = 1; j <= k; j++) if (areas[j] < dust || (maxAs[j] < 110 && areas[j] <= faintMax)) { drop[j] = 1; removed++; }
  if (removed) for (let p = 0; p < N; p++) if (drop[label[p]]) { const i = p * 4; d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
  return removed;
}

/** Box around the visible pixels, or null if the image is empty. */
export function bounds(d, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------- Small PNG encoder with the best filter per row: smaller files than the browser's own
   (Spreadshop accepts at most 10 MB). Uses the browser's built-in deflate. ---------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc(out, 4, 8 + data.length));
  return out;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** RGBA bytes → PNG file bytes (with 300 DPI). Returns null if this browser can't compress. */
export async function encodePNG(d, W, H, dpi = 300) {
  if (typeof CompressionStream === "undefined") return null;
  const hasAlpha = (() => { for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true; return false; })();
  const bpp = hasAlpha ? 4 : 3, stride = W * bpp;
  const raw = new Uint8Array((stride + 1) * H);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride), cand = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    // this row's bytes (transparent pixels → 0, they compress much better)
    for (let x = 0, s = y * W * 4, o = 0; x < W; x++, s += 4, o += bpp) {
      if (hasAlpha && d[s + 3] === 0) { cur[o] = cur[o + 1] = cur[o + 2] = cur[o + 3] = 0; continue; }
      cur[o] = d[s]; cur[o + 1] = d[s + 1]; cur[o + 2] = d[s + 2]; if (hasAlpha) cur[o + 3] = d[s + 3];
    }
    // try the 5 PNG filters, keep the one with the smallest "sum of differences"
    let best = 0, bestScore = Infinity;
    const out = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (f === 0) v = cur[i];
        else if (f === 1) v = cur[i] - a;
        else if (f === 2) v = cur[i] - b;
        else if (f === 3) v = cur[i] - ((a + b) >> 1);
        else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        v &= 255;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { bestScore = score; best = f; out.set(cand); }
    }
    raw[y * (stride + 1)] = best;
    prev.set(cur);
  }
  // zlib stream = 2-byte header + raw deflate + adler32
  const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const z = new Uint8Array(deflated.length + 6);
  z[0] = 0x78; z[1] = 0xda;
  z.set(deflated, 2);
  new DataView(z.buffer).setUint32(z.length - 4, adler32(raw));
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W); iv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = hasAlpha ? 6 : 2;
  const ppm = Math.round(dpi / 0.0254), phys = new Uint8Array(9), pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("pHYs", phys), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0), file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  return file;
}

/** Spread nearby colors into fully transparent pixels (before AI enlarging) so edges don't get dark halos. */
export function bleedData(d, W, H) {
  const N = W * H;
  let known = new Uint8Array(N);
  for (let p = 0; p < N; p++) known[p] = d[p * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < 16; pass++) {
    const next = known.slice();
    let changed = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (known[p]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (known[q]) { r += d[q * 4]; g += d[q * 4 + 1]; b += d[q * 4 + 2]; n++; }
      }
      if (n) { d[p * 4] = r / n; d[p * 4 + 1] = g / n; d[p * 4 + 2] = b / n; next[p] = 1; changed = true; }
    }
    known = next;
    if (!changed) break;
  }
}

/** One entry point for the worker and for the plan B (same code on the page). */
export async function runOp(op, d, W, H, opts = {}, progress = () => {}) {
  if (op === "pod") return podJob(d, W, H, opts, progress);
  if (op === "clean") {
    let creamKept = 0, specks = 0;
    if (opts.white) creamKept = removeWhiteData(d, W, H, opts.white, opts).creamKept;
    if (opts.specks) specks = removeSpecks(d, W, H);
    return { creamKept, specks, box: bounds(d, W, H) };
  }
  if (op === "bounds") return { box: bounds(d, W, H) };
  if (op === "bleed") { bleedData(d, W, H); return {}; }
  if (op === "png") return { png: await encodePNG(d, W, H, opts.dpi || 300) };
  throw new Error("unknown op " + op);
}

/* =====================================================================================
   PRINT-ON-DEMAND, THE TERMUX / IMAGEMAGICK WAY (same steps, same order):
   1) enlarge the ORIGINAL (white background still on) with Lanczos + light unsharp mask
   2) remove the background: flood fill from the corner (12% of white, 4 sides connected);
      cream background → corner color, 6%, from the corner only. Text: all white ≤ 6% (or 4%).
   3) smart crop: alpha mask at 10% → threshold 50% → open (disk 1) → dilate (disk 3) → box ×10
   4) fit the cropped design in the box (Lanczos) and center it on the store canvas
   5) PNG with 300 DPI
   ===================================================================================== */

const FUZZ = (pct) => 441.67 * pct; // ImageMagick -fuzz: percent of the biggest color distance

/** Lanczos-3 resize of RGBA (separable). premul: weight colors by alpha (designs with transparency). */
export function resizeLanczos(src, sw, sh, dw, dh, premul = false) {
  const a = 3;
  const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const L = (x) => (x > -a && x < a ? sinc(x) * sinc(x / a) : 0);
  function weights(sLen, dLen) {
    const scale = dLen / sLen, fs = scale < 1 ? scale : 1; // shrinking: wider filter
    const support = a / fs;
    const idx = [], wts = [];
    for (let i = 0; i < dLen; i++) {
      const center = (i + 0.5) / scale - 0.5;
      const lo = Math.max(0, Math.floor(center - support) + 1), hi = Math.min(sLen - 1, Math.floor(center + support));
      const ws = []; let sum = 0;
      for (let j = lo; j <= hi; j++) { const w = L((j - center) * fs); ws.push(w); sum += w; }
      idx.push(lo); wts.push(Float32Array.from(ws, (w) => w / (sum || 1)));
    }
    return { idx, wts };
  }
  const src4 = premul ? (() => {
    const f = new Float32Array(sw * sh * 4);
    for (let p = 0; p < sw * sh; p++) { const i = p * 4, al = src[i + 3] / 255; f[i] = src[i] * al; f[i + 1] = src[i + 1] * al; f[i + 2] = src[i + 2] * al; f[i + 3] = src[i + 3]; }
    return f;
  })() : src;
  // horizontal: sw×sh → dw×sh
  const H1 = weights(sw, dw), tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4, orow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const lo = H1.idx[x], w = H1.wts[x];
      let r = 0, g = 0, b = 0, al = 0;
      for (let k = 0; k < w.length; k++) { const i = row + (lo + k) * 4, wk = w[k]; r += src4[i] * wk; g += src4[i + 1] * wk; b += src4[i + 2] * wk; al += src4[i + 3] * wk; }
      const o = orow + x * 4; tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = al;
    }
  }
  // vertical: dw×sh → dw×dh
  const V = weights(sh, dh), out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const lo = V.idx[y], w = V.wts[y], orow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let k = 0; k < w.length; k++) { const i = ((lo + k) * dw + x) * 4, wk = w[k]; r += tmp[i] * wk; g += tmp[i + 1] * wk; b += tmp[i + 2] * wk; al += tmp[i + 3] * wk; }
      const o = orow + x * 4;
      if (premul) { const aa = al / 255; if (aa > 0.002) { r /= aa; g /= aa; b /= aa; } else { r = g = b = 0; } }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = al;
    }
  }
  return out;
}

/** ImageMagick -unsharp 0x{sigma} (amount 1, threshold 5%), on the colors only. */
export function unsharp(d, W, H, sigma = 0.75, amount = 1, threshold = 0.05) {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H * 3), blur = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a0 = 0, a1 = 0, a2 = 0;
    for (let t = -r; t <= r; t++) { const xx = Math.min(W - 1, Math.max(0, x + t)), i = (y * W + xx) * 4, w = k[t + r]; a0 += d[i] * w; a1 += d[i + 1] * w; a2 += d[i + 2] * w; }
    const o = (y * W + x) * 3; tmp[o] = a0; tmp[o + 1] = a1; tmp[o + 2] = a2;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a0 = 0, a1 = 0, a2 = 0;
    for (let t = -r; t <= r; t++) { const yy = Math.min(H - 1, Math.max(0, y + t)), i = (yy * W + x) * 3, w = k[t + r]; a0 += tmp[i] * w; a1 += tmp[i + 1] * w; a2 += tmp[i + 2] * w; }
    const o = (y * W + x) * 3; blur[o] = a0; blur[o + 1] = a1; blur[o + 2] = a2;
  }
  const th = threshold * 255;
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) {
    const i = p * 4 + c, diff = d[i] - blur[p * 3 + c];
    if (Math.abs(diff) >= th) d[i] = d[i] + amount * diff;
  }
}

/**
 * Flood fill from the edges, like "-bordercolor white -border 4 -fuzz 12% -draw 'alpha 0,0 floodfill'":
 * every pixel CONNECTED to the outside whose color is within `tol` of `target` becomes transparent.
 * seeds: "edges" (the white border touches all 4 sides) or "corner" (only from 0,0).
 * Scanline fill: little memory even on 30-megapixel images.
 */
export function floodFillBg(d, W, H, target, tol, seeds = "edges") {
  const [tr, tg, tb] = target, t2 = tol * tol;
  const N = W * H, done = new Uint8Array(N);
  const ok = (p) => { if (done[p]) return false; const i = p * 4, r = d[i] - tr, g = d[i + 1] - tg, b = d[i + 2] - tb; return d[i + 3] < 8 || r * r + g * g + b * b <= t2; };
  const stack = [];
  const push = (x, y) => { const p = y * W + x; if (ok(p)) stack.push(p); };
  if (seeds === "corner") push(0, 0);
  else { for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); } for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); } }
  let filled = 0;
  while (stack.length) {
    const p0 = stack.pop();
    if (!ok(p0)) continue;
    const y = (p0 / W) | 0;
    let x0 = p0 - y * W, x1 = x0;
    while (x0 > 0 && ok(y * W + x0 - 1)) x0--;
    while (x1 < W - 1 && ok(y * W + x1 + 1)) x1++;
    let upOpen = false, downOpen = false;
    for (let x = x0; x <= x1; x++) {
      const p = y * W + x;
      done[p] = 1; d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = d[p * 4 + 3] = 0; filled++;
      if (y > 0) { const q = p - W; if (ok(q)) { if (!upOpen) { stack.push(q); upOpen = true; } } else upOpen = false; }
      if (y < H - 1) { const q = p + W; if (ok(q)) { if (!downOpen) { stack.push(q); downOpen = true; } } else downOpen = false; }
    }
  }
  return filled;
}

/** "-fuzz N% -transparent white": every pixel within `tol` of white becomes transparent (text, letter holes). */
export function allWhite(d, W, H, tol) {
  const t2 = tol * tol;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4, r = 255 - d[i], g = 255 - d[i + 1], b = 255 - d[i + 2];
    if (r * r + g * g + b * b <= t2) d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
  }
}

/** Color of the background corner: average of a small square at (0,0). */
function cornerColor(d, W, H) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < Math.min(6, H); y++) for (let x = 0; x < Math.min(6, W); x++) { const i = (y * W + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return [r / n, g / n, b / n];
}

/**
 * Smart crop that ignores loose specks (Termux recipe):
 * alpha → 10% → threshold 50% → open with Disk:1 → dilate with Disk:3 → bounding box × 10.
 */
export function smartCropBox(d, W, H) {
  const s = 10, w = Math.max(1, Math.ceil(W / s)), h = Math.max(1, Math.ceil(H / s));
  let m = new Uint8Array(w * h);
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
    let sum = 0, n = 0;
    for (let y = by * s; y < Math.min(H, by * s + s); y++) for (let x = bx * s; x < Math.min(W, bx * s + s); x++) { sum += d[(y * W + x) * 4 + 3]; n++; }
    m[by * w + bx] = sum / n >= 127.5 ? 1 : 0;
  }
  const morph = (src, r, dilate) => {
    const out = new Uint8Array(w * h), off = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) off.push([dx, dy]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (const [dx, dy] of off) {
        const xx = x + dx, yy = y + dy;
        const s2 = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        if (dilate && s2) { v = 1; break; }
        if (!dilate && !s2) { v = 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  m = morph(morph(m, 1, false), 1, true); // open: erase specks
  m = morph(m, 3, true);                  // a little safety margin
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return bounds(d, W, H); // tiny design: plain crop
  const X0 = Math.max(0, x0 * s), Y0 = Math.max(0, y0 * s), X1 = Math.min(W, (x1 + 1) * s), Y1 = Math.min(H, (y1 + 1) * s);
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}

function cropRGBA(d, W, box) {
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) out.set(d.subarray(((box.y + y) * W + box.x) * 4, ((box.y + y) * W + box.x + box.w) * 4), y * box.w * 4);
  return out;
}

/** Put the design on the store canvas: contain (centered in the box) or cover (fills, edges cut), optional background color. */
function placeOnCanvas(dsg, dw, dh, P) {
  const W = P.w, H = P.h, out = new Uint8ClampedArray(W * H * 4);
  let s, bw, bh;
  if (P.fit === "cover") s = Math.max(W / dw, H / dh);
  else { bw = W * (1 - 2 * P.margin); bh = H * (1 - 2 * P.margin); s = Math.min(bw / dw, bh / dh); }
  const nw = Math.max(1, Math.round(dw * s)), nh = Math.max(1, Math.round(dh * s));
  const img = resizeLanczos(dsg, dw, dh, nw, nh, true);
  const ox = Math.round((W - nw) / 2), oy = Math.round((H - nh) / 2);
  let br = 0, bg = 0, bb = 0, solid = false;
  if (P.bgColor) { const n = parseInt(P.bgColor.slice(1), 16); br = (n >> 16) & 255; bg = (n >> 8) & 255; bb = n & 255; solid = true; }
  if (solid) for (let p = 0; p < W * H; p++) { const i = p * 4; out[i] = br; out[i + 1] = bg; out[i + 2] = bb; out[i + 3] = 255; }
  for (let y = 0; y < nh; y++) {
    const ty = oy + y; if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < nw; x++) {
      const tx = ox + x; if (tx < 0 || tx >= W) continue;
      const si = (y * nw + x) * 4, di = (ty * W + tx) * 4, a = img[si + 3] / 255;
      if (!solid) { out[di] = img[si]; out[di + 1] = img[si + 1]; out[di + 2] = img[si + 2]; out[di + 3] = img[si + 3]; }
      else { out[di] = img[si] * a + br * (1 - a); out[di + 1] = img[si + 1] * a + bg * (1 - a); out[di + 2] = img[si + 2] * a + bb * (1 - a); }
    }
  }
  return { data: out, scale: s };
}

/** Small preview (max side `max`) for the results list. */
function previewOf(d, W, H, max = 720) {
  // fast: average blocks first (box filter), then a small Lanczos step
  let src = d, sw = W, sh = H;
  const step = Math.floor(Math.max(W, H) / (max * 2));
  if (step >= 2) {
    const w2 = Math.floor(W / step), h2 = Math.floor(H / step), o = new Uint8ClampedArray(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = 0; yy < step; yy++) for (let xx = 0; xx < step; xx++) {
        const i = ((y * step + yy) * W + x * step + xx) * 4, al = d[i + 3];
        r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
      }
      const q = (y * w2 + x) * 4, n = step * step;
      if (a) { o[q] = r / a; o[q + 1] = g / a; o[q + 2] = b / a; }
      o[q + 3] = a / n;
    }
    src = o; sw = w2; sh = h2;
  }
  const k = Math.min(1, max / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  return { data: k < 1 ? resizeLanczos(src, sw, sh, w, h, true) : new Uint8ClampedArray(src), w, h };
}

/**
 * The whole print-on-demand job for one design (runs in the worker).
 * opts: { bg: "white" | "white-all" | "white-all-4" | "ai" | "keep", holes, holeMin,
 *         enlarge: { w, h } | null (Lanczos + unsharp to fit this box before removing the background),
 *         sharpen, sizes: [{ w, h, fit, margin, bgColor }] }
 */
export async function podJob(d, W, H, opts, progress = () => {}) {
  let img = d, w = W, h = H;
  // 1) enlarge first, background still on
  if (opts.enlarge) {
    const s = Math.min(opts.enlarge.w / w, opts.enlarge.h / h);
    if (s > 1.01) {
      const nw = Math.round(w * s), nh = Math.round(h * s);
      img = resizeLanczos(img, w, h, nw, nh, opts.bg === "keep" || opts.bg === "ai"); w = nw; h = nh;
      progress(0.35);
      if (opts.sharpen) unsharp(img, w, h, 0.75);
    }
  }
  progress(0.5);
  // 2) background
  let creamKept = 0, cream = false;
  if (opts.bg === "white") {
    const c = cornerColor(img, w, h), dist = Math.hypot(255 - c[0], 255 - c[1], 255 - c[2]);
    if (dist <= FUZZ(0.06)) floodFillBg(img, w, h, [255, 255, 255], FUZZ(0.12), "edges");
    else { cream = true; floodFillBg(img, w, h, c, FUZZ(0.06), "corner"); }
    if (opts.holes) {
      const N = w * h, bg = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (img[p * 4 + 3] === 0) bg[p] = 1;
      creamKept = removeHoles(bg, img, w, h, new Int32Array(N), opts.holeMin || 2e-5);
      for (let p = 0; p < N; p++) if (bg[p]) { const i = p * 4; img[i] = img[i + 1] = img[i + 2] = img[i + 3] = 0; }
    }
  } else if (opts.bg === "white-all") allWhite(img, w, h, FUZZ(0.06));
  else if (opts.bg === "white-all-4") allWhite(img, w, h, FUZZ(0.04));
  progress(0.6);
  // 3) smart crop
  const box = smartCropBox(img, w, h);
  if (!box || box.w < 2 || box.h < 2) throw new Error("The image became empty — try another background option.");
  const dsg = cropRGBA(img, w, box);
  img = null;
  // 4) + 5) every store size, PNG with 300 DPI
  const outs = [];
  for (let k = 0; k < opts.sizes.length; k++) {
    const P = opts.sizes[k];
    const placed = placeOnCanvas(dsg, box.w, box.h, P);
    const png = await encodePNG(placed.data, P.w, P.h, 300);
    const pv = previewOf(placed.data, P.w, P.h);
    outs.push({ png, raw: png ? null : placed.data, w: P.w, h: P.h, preview: pv, scale: placed.scale });
    progress(0.6 + (0.4 * (k + 1)) / opts.sizes.length);
  }
  return { outs, creamKept, cream, box, designW: box.w, designH: box.h };
}
