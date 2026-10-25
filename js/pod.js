// Lampyva — print-on-demand helpers: store presets, white-background removal, trim, fit, 300 DPI PNG.
import { crc32 } from "./zip.js";

/** Store presets. fit: "contain" = design with margin on transparent canvas, "cover" = fill the whole canvas. */
export const PRESETS = [
  { id: "universal", label: "All stores — 5000×6000 (recommended)", w: 5000, h: 6000, fit: "contain" },
  { id: "amazon-tee", label: "Amazon Merch — T-shirt 4500×5400", w: 4500, h: 5400, fit: "contain" },
  { id: "amazon-hoodie", label: "Amazon Merch — Hoodie 4500×4050", w: 4500, h: 4050, fit: "contain" },
  { id: "amazon-tote", label: "Amazon Merch — Tote bag / Pillow 2925×2925", w: 2925, h: 2925, fit: "contain" },
  { id: "amazon-phone", label: "Amazon Merch — Phone case 1800×3200", w: 1800, h: 3200, fit: "cover" },
  { id: "amazon-popsocket", label: "Amazon Merch — PopSockets 485×485", w: 485, h: 485, fit: "cover" },
  { id: "redbubble", label: "Redbubble — all products 5000×6000", w: 5000, h: 6000, fit: "contain" },
  { id: "redbubble-sticker", label: "Redbubble — Sticker 2800×2800", w: 2800, h: 2800, fit: "contain" },
  { id: "spreadshirt", label: "Spreadshirt / Spreadshop — 4000×4000 (max 10 MB)", w: 4000, h: 4000, fit: "contain", maxBytes: 10 * 1024 * 1024 },
  { id: "teepublic", label: "TeePublic — 5000×5500", w: 5000, h: 5500, fit: "contain" },
  { id: "zazzle-tee", label: "Zazzle — T-shirt 2100×1800", w: 2100, h: 1800, fit: "contain" },
  { id: "displate", label: "Displate — Metal poster 2900×4060 (full)", w: 2900, h: 4060, fit: "cover" },
  { id: "custom", label: "Custom size…", w: 0, h: 0, fit: "contain" },
];

const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

/**
 * Remove white background.
 * mode "connected": only white touching the edges (keeps whites inside the drawing — illustrations).
 * mode "all": every white pixel (text / lettering designs, so letter holes become transparent too).
 * Soft edges: pixels that are almost white become partly transparent and lose the white fringe.
 */
export function removeWhite(src, mode = "connected", fuzz = 0.12) {
  const W = src.width, H = src.height;
  const c = newCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const t0 = 441.7 * fuzz, t1 = t0 * 2.2;
  const dist = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const r = 255 - d[p * 4], g = 255 - d[p * 4 + 1], b = 255 - d[p * 4 + 2];
    dist[p] = d[p * 4 + 3] < 8 ? 0 : Math.sqrt(r * r + g * g + b * b);
  }
  const bg = new Uint8Array(W * H); // 1 = background
  if (mode === "all") {
    for (let p = 0; p < W * H; p++) if (dist[p] < t0) bg[p] = 1;
  } else {
    const stack = new Int32Array(W * H);
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
  }
  for (let p = 0; p < W * H; p++) {
    if (bg[p]) { d[p * 4 + 3] = 0; continue; }
    if (dist[p] >= t1) continue;
    // soft edge only next to removed pixels (or everywhere in "all" mode)
    const x = p % W;
    const near = mode === "all" || (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (p >= W && bg[p - W]) || (p < W * (H - 1) && bg[p + W]);
    if (!near) continue;
    const a = Math.max(0.05, (dist[p] - t0) / (t1 - t0));
    for (let k = 0; k < 3; k++) d[p * 4 + k] = Math.max(0, Math.min(255, (d[p * 4 + k] - 255 * (1 - a)) / a));
    d[p * 4 + 3] = Math.round(d[p * 4 + 3] * a);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Cut away empty (transparent) borders. */
export function trim(src) {
  const W = src.width, H = src.height;
  const d = src.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error("The image became empty — try another background option.");
  if (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1) return src;
  const c = newCanvas(x1 - x0 + 1, y1 - y0 + 1);
  c.getContext("2d").drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

export function hasTransparency(src) {
  const d = src.getContext("2d").getImageData(0, 0, src.width, src.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
  return false;
}

/** Place the design on the store canvas. margin = fraction of the canvas kept empty on each side. */
export function place(design, W, H, fit = "contain", margin = 0.04) {
  const c = newCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (fit === "cover") {
    const s = Math.max(W / design.width, H / design.height);
    const w = design.width * s, h = design.height * s;
    ctx.drawImage(design, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    const bw = W * (1 - 2 * margin), bh = H * (1 - 2 * margin);
    const s = Math.min(bw / design.width, bh / design.height);
    const w = Math.round(design.width * s), h = Math.round(design.height * s);
    ctx.drawImage(design, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
  }
  return c;
}

/** How much the design must grow to fill its place on the canvas. */
export function neededScale(design, W, H, fit = "contain", margin = 0.04) {
  return fit === "cover"
    ? Math.max(W / design.width, H / design.height)
    : Math.min((W * (1 - 2 * margin)) / design.width, (H * (1 - 2 * margin)) / design.height);
}

/** Add 300 DPI information to a PNG file (stores and printers read it). */
export async function pngWithDpi(blob, dpi = 300) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1;
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  // drop any existing pHYs, insert ours right after IHDR (8-byte signature + 25-byte IHDR)
  const parts = [buf.subarray(0, 33), chunk];
  let p = 33;
  while (p < buf.length) {
    const len = new DataView(buf.buffer, buf.byteOffset + p).getUint32(0);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    if (type !== "pHYs") parts.push(buf.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  return new Blob(parts, { type: "image/png" });
}
