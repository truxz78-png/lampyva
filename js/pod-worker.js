// Lampyva — background worker for the heavy pixel work (the page stays smooth meanwhile).
import { runOp } from "./pod-core.js";

self.onmessage = async (e) => {
  const { id, op, buf, W, H, opts } = e.data;
  try {
    const d = new Uint8ClampedArray(buf);
    let last = 0;
    const progress = (f) => { const now = Date.now(); if (now - last > 200 || f >= 1) { last = now; self.postMessage({ id, progress: f }); } };
    const res = await runOp(op, d, W, H, opts, progress);
    const transfer = [];
    if (res.png) transfer.push(res.png.buffer);
    if (res.outs) for (const o of res.outs) { if (o.png) transfer.push(o.png.buffer); if (o.raw) transfer.push(o.raw.buffer); if (o.preview) transfer.push(o.preview.data.buffer); }
    if (op !== "pod") transfer.push(d.buffer);
    self.postMessage({ id, ok: true, res, buf: op !== "pod" ? d.buffer : null }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
