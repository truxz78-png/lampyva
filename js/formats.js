// Lampyva — format modules.
// To add a new format later, add one entry to INPUTS (to open it) or OUTPUTS (to save it).

import {
  loadScript, canvasToBlob, canEncode, flatten,
  encodeBMP, encodeICO, encodeGIF, encodePDF, encodeTIFF,
} from "./encoders.js";

const ext = (name) => (name.split(".").pop() || "").toLowerCase();

/* ---------------- OPEN (decoders) ---------------- */

const MAX_OPEN = 50e6; // pixels: bigger pictures are opened a bit smaller, so the phone does not run out of memory

function toCanvas(src, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no memory for the canvas");
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}
function fit(w, h) {
  const k = w * h > MAX_OPEN ? Math.sqrt(MAX_OPEN / (w * h)) : 1;
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function viaBitmap(blob) {
  let bmp = await createImageBitmap(blob);
  try {
    const [w, h] = fit(bmp.width, bmp.height);
    if (w !== bmp.width) { bmp.close(); bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" }); }
    return toCanvas(bmp, w, h);
  } finally { bmp.close(); }
}

async function viaImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { w = 1024; h = 1024; } // SVG without size
    [w, h] = fit(w, h);
    return toCanvas(img, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Open with the browser. Robust on phones: the file is read first (so a file the phone no longer
 * lets us read is reported as such), then two ways of decoding are tried, and once more after a
 * short pause (the phone may need a moment to free memory after big images).
 */
async function decodeWithBrowser(blob) {
  // can the phone still read this file? (reading a few bytes is enough; no extra copy in memory)
  try { await blob.slice(0, 64).arrayBuffer(); }
  catch (e) { const err = new Error("read failed"); err.code = "read"; throw err; }
  const data = blob;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (typeof createImageBitmap === "function") { try { return await viaBitmap(data); } catch (e) { last = e; } }
    try { return await viaImg(data); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw last;
}

export const INPUTS = [
  {
    id: "heic",
    label: "HEIC / HEIF",
    match: (f) => /image\/hei[cf]/.test(f.type) || ["heic", "heif"].includes(ext(f.name)),
    async decode(file) {
      await loadScript("vendor/heic2any.min.js");
      let out = await window.heic2any({ blob: file, toType: "image/png" });
      if (Array.isArray(out)) out = out[0];
      return decodeWithBrowser(out);
    },
  },
  {
    id: "tiff",
    label: "TIFF",
    match: (f) => f.type === "image/tiff" || ["tif", "tiff"].includes(ext(f.name)),
    async decode(file) {
      await loadScript("vendor/UTIF.js");
      const buf = await file.arrayBuffer();
      const ifds = window.UTIF.decode(buf);
      const page = ifds.find((d) => d.width && d.height) || ifds[0];
      window.UTIF.decodeImage(buf, page, ifds);
      const px = window.UTIF.toRGBA8(page);
      const c = document.createElement("canvas");
      c.width = page.width;
      c.height = page.height;
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px.buffer), page.width, page.height), 0, 0);
      return c;
    },
  },
  {
    // PNG, JPG, WebP, GIF (first frame), BMP, AVIF, ICO, SVG and any other format the browser can open
    id: "browser",
    label: "Browser",
    match: () => true,
    decode: decodeWithBrowser,
  },
];

export async function openImage(file) {
  const mod = INPUTS.find((m) => m.match(file));
  try {
    return await mod.decode(file);
  } catch (e) {
    console.warn("open failed:", file.name, e);
    if (e && e.code === "read") { const err = new Error("This file could not be read from the phone. Please choose it again."); err.code = "read"; throw err; }
    if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext(file.name)))
      throw new Error("This image could not be opened: it may be damaged, or the phone ran out of memory. Try again with fewer images at once.");
    const what = ext(file.name).toUpperCase() || "this";
    throw new Error(`Your browser can't open ${what} files yet. Try another browser or format.`);
  }
}

export const INPUT_LABELS = ["PNG", "JPG", "WebP", "AVIF", "GIF", "BMP", "ICO", "SVG", "TIFF", "HEIC"];

/* ---------------- SAVE (encoders) ---------------- */
// alpha: keeps transparency · quality: shows the quality slider · multi: can combine many images in one file

export const OUTPUTS = [
  { id: "png", label: "PNG", ext: "png", alpha: true,
    encode: (c) => canvasToBlob(c, "image/png") },
  { id: "jpg", label: "JPG", ext: "jpg", quality: true,
    encode: (c, o) => canvasToBlob(flatten(c, o.background), "image/jpeg", o.quality) },
  { id: "webp", label: "WebP", ext: "webp", alpha: true, quality: true,
    available: () => canEncode("image/webp"),
    encode: (c, o) => canvasToBlob(c, "image/webp", o.quality) },
  { id: "avif", label: "AVIF", ext: "avif", alpha: true, quality: true,
    available: () => canEncode("image/avif"),
    encode: (c, o) => canvasToBlob(c, "image/avif", o.quality) },
  { id: "gif", label: "GIF", ext: "gif", alpha: true,
    encode: (c) => encodeGIF(c) },
  { id: "bmp", label: "BMP", ext: "bmp",
    encode: (c, o) => encodeBMP(c, o.background) },
  { id: "tiff", label: "TIFF", ext: "tiff", alpha: true,
    encode: (c) => encodeTIFF(c) },
  { id: "ico", label: "ICO (icon)", ext: "ico", alpha: true,
    encode: (c) => encodeICO(c) },
  { id: "pdf", label: "PDF", ext: "pdf", quality: true, multi: true,
    encode: (c, o) => encodePDF([c], o.background, o.quality),
    encodeMany: (list, o) => encodePDF(list, o.background, o.quality) },
];

export async function availableOutputs() {
  const list = [];
  for (const f of OUTPUTS) if (!f.available || (await f.available())) list.push(f);
  return list;
}
