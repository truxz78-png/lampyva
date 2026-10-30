// Lampyva — background worker for the heavy pixel work (the page stays smooth meanwhile).
import { runOp } from "./pod-core.js";

self.onmessage = async (e) => {
  const { id, op, buf, W, H, opts } = e.data;
  try {
    const d = new Uint8ClampedArray(buf);
    const res = await runOp(op, d, W, H, opts);
    const transfer = [d.buffer];
    if (res.png) transfer.push(res.png.buffer);
    self.postMessage({ id, ok: true, res, buf: d.buffer }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
