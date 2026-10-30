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

/** One entry point for the worker and for the plan B (same code on the page). */
export async function runOp(op, d, W, H, opts = {}) {
  if (op === "clean") {
    let creamKept = 0, specks = 0;
    if (opts.white) creamKept = removeWhiteData(d, W, H, opts.white, opts).creamKept;
    if (opts.specks) specks = removeSpecks(d, W, H);
    return { creamKept, specks, box: bounds(d, W, H) };
  }
  if (op === "bounds") return { box: bounds(d, W, H) };
  if (op === "png") return { png: await encodePNG(d, W, H, opts.dpi || 300) };
  throw new Error("unknown op " + op);
}
