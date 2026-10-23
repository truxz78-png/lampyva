// Lampyva — format modules.
// To add a new format later, add one entry to INPUTS (to open it) or OUTPUTS (to save it).

import {
  loadScript, canvasToBlob, canEncode, flatten,
  encodeBMP, encodeICO, encodeGIF, encodePDF, encodeTIFF,
} from "./encoders.js";

const ext = (name) => (name.split(".").pop() || "").toLowerCase();

/* ---------------- OPEN (decoders) ---------------- */

function imageToCanvas(img, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c;
}

async function decodeWithBrowser(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { w = 1024; h = 1024; } // SVG without size
    return imageToCanvas(img, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
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
