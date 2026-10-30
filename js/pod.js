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
  { id: "spreadshirt", label: "Spreadshirt / Spreadshop — 3333×4000 (max 10 MB)", w: 3333, h: 4000, fit: "contain", maxBytes: 10 * 1000 * 1000 },
  { id: "spreadshirt-square", label: "Spreadshirt / Spreadshop — square 4000×4000 (max 10 MB)", w: 4000, h: 4000, fit: "contain", maxBytes: 10 * 1000 * 1000 },
  { id: "teepublic", label: "TeePublic — 5000×5500", w: 5000, h: 5500, fit: "contain" },
  { id: "zazzle-tee", label: "Zazzle — T-shirt 2100×1800", w: 2100, h: 1800, fit: "contain" },
  { id: "displate", label: "Displate — Metal poster 2900×4060", w: 2900, h: 4060, fit: "cover", poster: true },
  { id: "custom", label: "Custom size…", w: 0, h: 0, fit: "contain" },
];

const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

/* ---------- Heavy pixel work runs in a background worker, so the page never freezes.
   Plan B: if this browser can't start the worker, the same code runs on the page. ---------- */
let worker, workerBroken = false, nextId = 1;
const pending = new Map();
function getWorker() {
  if (workerBroken) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./pod-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
      worker.onerror = () => { workerBroken = true; for (const p of pending.values()) p({ ok: false, broken: true }); pending.clear(); };
    } catch (e) { workerBroken = true; return null; }
  }
  return worker;
}
export async function work(op, img, opts = {}) {
  const w = getWorker();
  if (w) {
    const id = nextId++;
    const W = img.width, H = img.height;
    const msg = await new Promise((resolve) => {
      pending.set(id, resolve);
      w.postMessage({ id, op, buf: img.data.buffer, W, H, opts }, [img.data.buffer]);
    });
    if (msg.ok) return { res: msg.res, img: new ImageData(new Uint8ClampedArray(msg.buf), W, H) };
    if (!msg.broken) throw new Error(msg.error);
    window.lampyvaTrack && window.lampyvaTrack("fallback-pod-worker");
    throw new Error("Please try again."); // the image data went to the broken worker
  }
  const { runOp } = await import("./pod-core.js");
  const res = await runOp(op, img.data, img.width, img.height, opts);
  return { res, img };
}

/**
 * Clean a design (in the background): remove white (opts.white = "connected" | "all"), loose specks,
 * then crop to the visible part. Returns { canvas, creamKept, specks }.
 */
export async function cleanDesign(src, opts = {}) {
  const W = src.width, H = src.height;
  const ctx = (src.getContext ? src : (() => { const c = newCanvas(W, H); c.getContext("2d").drawImage(src, 0, 0); return c; })()).getContext("2d");
  let img = ctx.getImageData(0, 0, W, H);
  let out;
  try { out = await work("clean", img, opts); }
  catch (e) { if (workerBroken) { img = ctx.getImageData(0, 0, W, H); out = await work("clean", img, opts); } else throw e; }
  const { res } = out;
  if (!res.box) throw new Error("The image became empty — try another background option.");
  const b = res.box;
  const c = newCanvas(b.w, b.h);
  c.getContext("2d").putImageData(out.img, -b.x, -b.y, b.x, b.y, b.w, b.h);
  return { canvas: c, creamKept: res.creamKept, specks: res.specks };
}

/** Crop to the visible part (in the background). */
export async function trimCanvas(src) {
  return (await cleanDesign(src, {})).canvas;
}

/** PNG as small as possible (best filter per row), with 300 DPI. Falls back to the browser's PNG. */
export async function compactPNG(canvas, dpi = 300) {
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  try {
    const { res } = await work("png", img, { dpi });
    if (res.png) return new Blob([res.png], { type: "image/png" });
  } catch (e) { console.warn("compact PNG failed:", e); }
  return null;
}

/**
 * "Tap to erase" for the touch-up editor — ONLY for white leftovers.
 * The tapped pixel (or, if the finger missed a little, the nearest light pixel within `snap`)
 * must be near white; dark lines, colors and outlines can never be erased by mistake.
 * Flood fill from there: pixels with a color close to it become transparent; a 2-pixel ring
 * around them is softened ("white to alpha"). Returns { rect, before } so it can be undone,
 * or { miss: "transparent" | "notwhite" } when nothing was erased.
 */
const LIGHT = 90;   // max distance from pure white to count as a "white leftover"
export function eraseAt(canvas, x, y, tol = 30, snap = 0) {
  const W = canvas.width, H = canvas.height, ctx = canvas.getContext("2d");
  let win = Math.max(512, snap * 2);
  for (;;) {
    const x0 = Math.max(0, x - win), y0 = Math.max(0, y - win);
    const x1 = Math.min(W, x + win), y1 = Math.min(H, y + win);
    const w = x1 - x0, h = y1 - y0;
    const img = ctx.getImageData(x0, y0, w, h), d = img.data;
    const wd = (p) => { const r = 255 - d[p * 4], g = 255 - d[p * 4 + 1], b = 255 - d[p * 4 + 2]; return Math.sqrt(r * r + g * g + b * b); };
    const isLight = (p) => d[p * 4 + 3] >= 10 && wd(p) < LIGHT;
    // find the start: the tapped pixel, or the nearest light pixel within `snap`
    const tx = x - x0, ty = y - y0;
    let s = ty * w + tx;
    if (!isLight(s)) {
      let best = -1, bd = Infinity;
      for (let dy = -snap; dy <= snap; dy++) for (let dx = -snap; dx <= snap; dx++) {
        const px = tx + dx, py = ty + dy, dd = dx * dx + dy * dy;
        if (px < 0 || py < 0 || px >= w || py >= h || dd > snap * snap || dd >= bd) continue;
        if (isLight(py * w + px)) { best = py * w + px; bd = dd; }
      }
      if (best < 0) return { miss: d[s * 4 + 3] < 10 ? "transparent" : "notwhite" };
      s = best;
    }
    const sr = d[s * 4], sg = d[s * 4 + 1], sb = d[s * 4 + 2];
    const cd = (p) => { const r = d[p * 4] - sr, g = d[p * 4 + 1] - sg, b = d[p * 4 + 2] - sb; return Math.sqrt(r * r + g * g + b * b); };
    const M = w * h, mark = new Uint8Array(M), stack = [s];
    let touches = false;
    mark[s] = 1;
    while (stack.length) {
      const p = stack.pop(), px = p % w, py = (p - px) / w;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touches = true;
      const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && !mark[q] && isLight(q) && cd(q) < tol) { mark[q] = 1; stack.push(q); }
    }
    const whole = w === W && h === H;
    if (touches && !whole) { win *= 2; continue; } // the white area is bigger: look wider
    const before = new ImageData(new Uint8ClampedArray(d), w, h);
    // soft ring: 2 pixels around the erased area, "white to alpha" (never touches dark pixels)
    let ring = mark.slice();
    for (let r = 0; r < 2; r++) {
      const next = ring.slice();
      for (let p = 0; p < M; p++) {
        if (ring[p]) continue;
        const px = p % w;
        if ((px > 0 && ring[p - 1]) || (px < w - 1 && ring[p + 1]) || (p >= w && ring[p - w]) || (p < M - w && ring[p + w])) next[p] = 2;
      }
      ring = next;
    }
    for (let p = 0; p < M; p++) {
      const i = p * 4;
      if (mark[p]) { d[i + 3] = 0; continue; }
      if (ring[p] !== 2 || d[i + 3] === 0) continue;
      const a = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]) / 255;
      if (a < 0.02) { d[i + 3] = 0; continue; }
      if (a < 0.999) { for (let k = 0; k < 3; k++) d[i + k] = Math.round(255 - (255 - d[i + k]) / a); d[i + 3] = Math.round(d[i + 3] * a); }
    }
    ctx.putImageData(img, x0, y0);
    return { rect: { x: x0, y: y0, w, h }, before };
  }
}

/** Undo one eraseAt. */
export function undoErase(canvas, step) {
  canvas.getContext("2d").putImageData(step.before, step.rect.x, step.rect.y);
}

export function hasTransparency(src) {
  const d = src.getContext("2d").getImageData(0, 0, src.width, src.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
  return false;
}

/** Place the design on the store canvas. margin = fraction of the canvas kept empty on each side. */
export function place(design, W, H, fit = "contain", margin = 0.04, bgColor = "") {
  const c = newCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
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
