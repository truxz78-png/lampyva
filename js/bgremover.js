import { breathe } from "./breathe.js";
// Lampyva — automatic background remover (U²-Net "u2netp", Apache-2.0).
// Runs on the visitor's device: GPU (WebGL2) when possible, otherwise a slower CPU path (plan B).
// Nothing is uploaded.

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

function f16(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

let modelPromise = null;
/** Download the model once (≈2.2 MB) and keep it in memory. */
function loadModel(base) {
  if (!modelPromise) {
    modelPromise = Promise.all([
      fetch(base + "u2netp.json").then((r) => { if (!r.ok) throw new Error("Model not found"); return r.json(); }),
      fetch(base + "u2netp.bin").then((r) => { if (!r.ok) throw new Error("Model not found"); return r.arrayBuffer(); }),
    ]).then(([graph, buf]) => {
      const raw = new Uint16Array(buf);
      const w = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) w[i] = f16(raw[i]);
      return { graph, w };
    }).catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

/** Image → normalized 3×320×320 input (same as the original model's preprocessing). */
function prepareInput(src) {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, SIZE, SIZE);
  const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
  max = max || 255;
  const x = new Float32Array(3 * SIZE * SIZE);
  for (let p = 0; p < SIZE * SIZE; p++)
    for (let ch = 0; ch < 3; ch++) x[ch * SIZE * SIZE + p] = (d[p * 4 + ch] / max - MEAN[ch]) / STD[ch];
  return x;
}

const tick = () => breathe();

/* ------------------------------------------------------------------ GPU (WebGL2) */

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
out vec4 o;
`;
const SHADERS = {
  conv: HEAD + `uniform sampler2DArray uIn; uniform highp sampler2D uW; uniform highp sampler2D uB;
uniform int uInLayers, uGroup, uK, uD, uRelu; uniform ivec2 uSize;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = texelFetch(uB, ivec2(uGroup, 0), 0);
  int h = uK / 2, taps = uK * uK;
  for (int t = 0; t < taps; t++) {
    ivec2 q = p + ivec2(t % uK - h, t / uK - h) * uD;
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    int x = t * 4;
    for (int l = 0; l < uInLayers; l++) {
      int row = uGroup * uInLayers + l;
      vec4 v = texelFetch(uIn, ivec3(q, l), 0);
      acc += mat4(texelFetch(uW, ivec2(x, row), 0), texelFetch(uW, ivec2(x + 1, row), 0),
                  texelFetch(uW, ivec2(x + 2, row), 0), texelFetch(uW, ivec2(x + 3, row), 0)) * v;
    }
  }
  o = uRelu == 1 ? max(acc, 0.0) : acc;
}`,
  pool: HEAD + `uniform sampler2DArray uIn; uniform int uLayer; uniform ivec2 uInSize;
void main(){
  ivec2 b = ivec2(gl_FragCoord.xy) * 2;
  vec4 m = texelFetch(uIn, ivec3(b, uLayer), 0);
  for (int i = 1; i < 4; i++) {
    ivec2 q = b + ivec2(i & 1, i >> 1);
    if (q.x < uInSize.x && q.y < uInSize.y) m = max(m, texelFetch(uIn, ivec3(q, uLayer), 0));
  }
  o = m;
}`,
  resize: HEAD + `uniform sampler2DArray uIn; uniform int uLayer; uniform ivec2 uInSize, uOutSize;
void main(){
  vec2 c = max((gl_FragCoord.xy) * vec2(uInSize) / vec2(uOutSize) - 0.5, 0.0);
  ivec2 a = ivec2(floor(c)); ivec2 b = min(a + 1, uInSize - 1); vec2 f = c - vec2(a);
  vec4 v00 = texelFetch(uIn, ivec3(a.x, a.y, uLayer), 0), v10 = texelFetch(uIn, ivec3(b.x, a.y, uLayer), 0);
  vec4 v01 = texelFetch(uIn, ivec3(a.x, b.y, uLayer), 0), v11 = texelFetch(uIn, ivec3(b.x, b.y, uLayer), 0);
  o = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}`,
  copy: HEAD + `uniform sampler2DArray uIn; uniform int uLayer;
void main(){ o = texelFetch(uIn, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0); }`,
  add: HEAD + `uniform sampler2DArray uIn, uIn2; uniform int uLayer;
void main(){ ivec3 q = ivec3(ivec2(gl_FragCoord.xy), uLayer); o = texelFetch(uIn, q, 0) + texelFetch(uIn2, q, 0); }`,
  sigmoid: HEAD + `uniform sampler2DArray uIn;
void main(){ float v = texelFetch(uIn, ivec3(ivec2(gl_FragCoord.xy), 0), 0).r; o = vec4(vec3(1.0 / (1.0 + exp(-v))), 1.0); }`,
};
const UNIFORMS = ["uIn", "uIn2", "uW", "uB", "uInLayers", "uGroup", "uK", "uD", "uRelu", "uSize", "uLayer", "uInSize", "uOutSize"];

class GPURunner {
  static create() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { antialias: false, depth: false });
      if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
      return new GPURunner(gl);
    } catch (e) {
      console.warn("GPU background remover unavailable:", e);
      return null;
    }
  }

  constructor(gl) {
    this.gl = gl;
    this.progs = {};
    for (const k in SHADERS) this.progs[k] = this.program(SHADERS[k]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fb = gl.createFramebuffer();
    this.pool = new Map();
    this.prepared = null;
    // Check that float targets really work on this device.
    const t = this.tex(4, 4, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t.t, 0, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Float render targets not supported");
    this.release(t);
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (const n of UNIFORMS) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  tex(w, h, layers) {
    const key = `${w}x${h}x${layers}`;
    const free = this.pool.get(key);
    if (free && free.length) return free.pop();
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, w, h, layers);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, gl.NEAREST);
    return { t, w, h, layers, key };
  }
  release(x) {
    if (!this.pool.has(x.key)) this.pool.set(x.key, []);
    this.pool.get(x.key).push(x);
  }
  floatTex(data, w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    return t;
  }

  /** Work out where every channel lives (layer*4 + component) and pack the conv weights. */
  prepare(model) {
    if (this.prepared) return this.prepared;
    const { graph, w } = model;
    const maps = { 0: [0, 1, 2] }; // input: RGB in layer 0
    const layersOf = { 0: 1 };
    const steps = [];
    const lastUse = {};
    graph.ops.forEach((o, i) => { for (const x of [].concat(o.i, o.like ?? [])) lastUse[x] = i; });
    for (const o of graph.ops) {
      const s = { ...o };
      if (o.op === "conv") {
        const inMap = maps[o.i], inLayers = layersOf[o.i], groups = Math.ceil(o.cout / 4), kk = o.k * o.k;
        const width = kk * 4, height = groups * inLayers;
        const tex = new Float32Array(width * height * 4);
        for (let oc = 0; oc < o.cout; oc++) for (let ic = 0; ic < o.cin; ic++) {
          const phys = inMap[ic], l = phys >> 2, comp = phys & 3, row = (oc >> 2) * inLayers + l;
          for (let t = 0; t < kk; t++)
            tex[(row * width + t * 4 + comp) * 4 + (oc & 3)] = w[o.w + (oc * o.cin + ic) * kk + t];
        }
        const bias = new Float32Array(groups * 4);
        bias.set(w.subarray(o.w + o.cout * o.cin * kk, o.w + o.cout * o.cin * kk + o.cout));
        s.wt = this.floatTex(tex, width, height);
        s.bt = this.floatTex(bias, groups, 1);
        s.inLayers = inLayers;
        maps[o.o] = Array.from({ length: o.cout }, (_, c) => c);
        layersOf[o.o] = groups;
      } else if (o.op === "concat") {
        const map = []; let off = 0;
        for (const x of o.i) { for (const ph of maps[x]) map.push(ph + off * 4); off += layersOf[x]; }
        maps[o.o] = map; layersOf[o.o] = off;
      } else if (o.op === "add") {
        maps[o.o] = maps[o.i[0]]; layersOf[o.o] = layersOf[o.i[0]];
      } else if (o.op !== "sigmoid") {
        maps[o.o] = maps[o.i]; layersOf[o.o] = layersOf[o.i];
      }
      s.outLayers = layersOf[o.o];
      steps.push(s);
    }
    this.prepared = { steps, lastUse };
    return this.prepared;
  }

  draw(prog, target, layer, w, h) {
    const gl = this.gl;
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target.t, 0, layer);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindIn(prog, x, unit = 0, name = "uIn") {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, x.t);
    gl.uniform1i(prog.u[name], unit);
  }

  async run(model, input, onProgress) {
    const gl = this.gl;
    const { steps, lastUse } = this.prepare(model);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.bindVertexArray(this.vao);
    const T = {};
    // upload input (RGB in layer 0, rows top→bottom)
    const inp = this.tex(SIZE, SIZE, 1);
    const px = new Float32Array(SIZE * SIZE * 4);
    for (let p = 0; p < SIZE * SIZE; p++) for (let c = 0; c < 3; c++) px[p * 4 + c] = input[c * SIZE * SIZE + p];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, inp.t);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, SIZE, SIZE, 1, gl.RGBA, gl.FLOAT, px);
    T[0] = inp;
    let mask = null;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const [, H, W] = s.shape;
      if (s.op === "sigmoid") {
        const p = this.progs.sigmoid;
        gl.useProgram(p.p);
        this.bindIn(p, T[s.i]);
        const out = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, out);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const buf = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.deleteTexture(out);
        mask = new Float32Array(W * H);
        for (let p = 0; p < W * H; p++) mask[p] = buf[p * 4] / 255;
      } else {
        const out = this.tex(W, H, s.outLayers);
        const p = this.progs[s.op === "concat" ? "copy" : s.op];
        gl.useProgram(p.p);
        if (s.op === "conv") {
          const x = T[s.i];
          this.bindIn(p, x);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, s.wt); gl.uniform1i(p.u.uW, 1);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, s.bt); gl.uniform1i(p.u.uB, 2);
          gl.uniform1i(p.u.uInLayers, s.inLayers);
          gl.uniform1i(p.u.uK, s.k); gl.uniform1i(p.u.uD, s.d); gl.uniform1i(p.u.uRelu, s.relu ? 1 : 0);
          gl.uniform2i(p.u.uSize, W, H);
          for (let g = 0; g < s.outLayers; g++) { gl.uniform1i(p.u.uGroup, g); this.draw(p, out, g, W, H); }
        } else if (s.op === "concat") {
          let off = 0;
          for (const xi of s.i) {
            const x = T[xi];
            this.bindIn(p, x);
            for (let l = 0; l < x.layers; l++) { gl.uniform1i(p.u.uLayer, l); this.draw(p, out, off + l, W, H); }
            off += x.layers;
          }
        } else if (s.op === "add") {
          this.bindIn(p, T[s.i[0]], 0, "uIn"); this.bindIn(p, T[s.i[1]], 1, "uIn2");
          for (let l = 0; l < s.outLayers; l++) { gl.uniform1i(p.u.uLayer, l); this.draw(p, out, l, W, H); }
        } else {
          const x = T[s.i];
          this.bindIn(p, x);
          gl.uniform2i(p.u.uInSize, x.w, x.h);
          if (s.op === "resize") gl.uniform2i(p.u.uOutSize, W, H);
          for (let l = 0; l < s.outLayers; l++) { gl.uniform1i(p.u.uLayer, l); this.draw(p, out, l, W, H); }
        }
        T[s.o] = out;
      }
      for (const x of [].concat(s.i, s.like ?? [])) if (lastUse[x] === i && T[x]) { this.release(T[x]); delete T[x]; }
      if (s.op === "conv" && i % 6 === 0) {
        gl.finish();
        onProgress(i / steps.length);
        await tick();
      }
    }
    for (const k in T) this.release(T[k]);
    const err = gl.getError();
    if (err) throw new Error("GPU error " + err);
    return mask;
  }
}

/* ------------------------------------------------------------------ CPU (plan B) */

async function runCPU(model, input, onProgress) {
  const { graph, w } = model;
  const T = { 0: { d: input, c: 3, h: SIZE, w: SIZE } };
  const lastUse = {};
  graph.ops.forEach((o, i) => { for (const x of [].concat(o.i, o.like ?? [])) lastUse[x] = i; });
  let lastTick = performance.now();
  for (let i = 0; i < graph.ops.length; i++) {
    const o = graph.ops[i];
    const [C, H, W] = o.shape;
    const out = new Float32Array(C * H * W);
    if (o.op === "conv") {
      const x = T[o.i], k = o.k, kk = k * k, d = o.d, h = k >> 1, HW = H * W;
      const wb = o.w + o.cout * o.cin * kk;
      for (let oc = 0; oc < o.cout; oc++) {
        const od = out.subarray(oc * HW, (oc + 1) * HW);
        od.fill(w[wb + oc]);
        for (let ic = 0; ic < o.cin; ic++) {
          const xd = x.d.subarray(ic * HW, (ic + 1) * HW);
          for (let t = 0; t < kk; t++) {
            const wt = w[o.w + (oc * o.cin + ic) * kk + t];
            if (wt === 0) continue;
            const dy = ((t / k) | 0) - h, dx = (t % k) - h;
            const oy = dy * d, ox = dx * d;
            const y0 = Math.max(0, -oy), y1 = Math.min(H, H - oy), x0 = Math.max(0, -ox), x1 = Math.min(W, W - ox);
            for (let y = y0; y < y1; y++) {
              const ro = y * W, ri = (y + oy) * W + ox;
              for (let xx = x0; xx < x1; xx++) od[ro + xx] += wt * xd[ri + xx];
            }
          }
        }
        if (o.relu) for (let p = 0; p < HW; p++) if (od[p] < 0) od[p] = 0;
        if (performance.now() - lastTick > 150) {
          onProgress((i + oc / o.cout) / graph.ops.length);
          await tick();
          lastTick = performance.now();
        }
      }
    } else if (o.op === "pool") {
      const x = T[o.i];
      for (let c = 0; c < C; c++) for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        let m = -Infinity;
        for (let j = 0; j < 4; j++) {
          const sy = y * 2 + (j >> 1), sx = xx * 2 + (j & 1);
          if (sy < x.h && sx < x.w) m = Math.max(m, x.d[(c * x.h + sy) * x.w + sx]);
        }
        out[(c * H + y) * W + xx] = m;
      }
    } else if (o.op === "resize") {
      const x = T[o.i];
      for (let y = 0; y < H; y++) {
        const cy = Math.max((y + 0.5) * x.h / H - 0.5, 0), y0 = Math.floor(cy), y1 = Math.min(y0 + 1, x.h - 1), fy = cy - y0;
        for (let xx = 0; xx < W; xx++) {
          const cx = Math.max((xx + 0.5) * x.w / W - 0.5, 0), x0 = Math.floor(cx), x1 = Math.min(x0 + 1, x.w - 1), fx = cx - x0;
          for (let c = 0; c < C; c++) {
            const b = c * x.h * x.w, g = (r, s) => x.d[b + r * x.w + s];
            out[(c * H + y) * W + xx] = (g(y0, x0) * (1 - fx) + g(y0, x1) * fx) * (1 - fy) + (g(y1, x0) * (1 - fx) + g(y1, x1) * fx) * fy;
          }
        }
      }
    } else if (o.op === "concat") {
      let off = 0;
      for (const xi of o.i) { out.set(T[xi].d, off); off += T[xi].d.length; }
    } else if (o.op === "add") {
      const a = T[o.i[0]].d, b = T[o.i[1]].d;
      for (let p = 0; p < out.length; p++) out[p] = a[p] + b[p];
    } else if (o.op === "sigmoid") {
      const a = T[o.i].d;
      for (let p = 0; p < out.length; p++) out[p] = 1 / (1 + Math.exp(-a[p]));
    }
    T[o.o] = { d: out, c: C, h: H, w: W };
    for (const x of [].concat(o.i, o.like ?? [])) if (lastUse[x] === i) delete T[x];
  }
  return T[graph.ops[graph.ops.length - 1].o].d;
}

/* ------------------------------------------------------------------ public API */

export class BackgroundRemover {
  constructor(base = "models/") {
    this.base = base;
    this.gpu = undefined;
  }

  /** "gpu" or "cpu" — which engine will be used on this device. */
  get engine() {
    if (this.gpu === undefined) this.gpu = GPURunner.create();
    return this.gpu ? "gpu" : "cpu";
  }

  /** Returns the 320×320 mask (0..1). Falls back to the CPU if the GPU fails. */
  async mask(src, onProgress = () => {}) {
    const model = await loadModel(this.base);
    const input = prepareInput(src);
    let m = null;
    if (this.engine === "gpu") {
      try {
        m = await this.gpu.run(model, input, onProgress);
        if (!m || m.some((v) => Number.isNaN(v))) throw new Error("bad GPU result");
      } catch (e) {
        console.warn("GPU failed, using CPU plan B:", e);
        this.gpu = null;
        m = null;
      }
    }
    if (!m) m = await runCPU(model, input, onProgress);
    // normalize like the original (min..max → 0..1)
    let lo = Infinity, hi = -Infinity;
    for (const v of m) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const r = hi - lo || 1;
    for (let i = 0; i < m.length; i++) m[i] = (m[i] - lo) / r;
    onProgress(1);
    return m;
  }

  /**
   * Remove the background. Returns a new canvas (same size) with transparency.
   * edge: 0 = soft, 1 = sharper edges.
   */
  async remove(src, { edge = 0.5 } = {}, onProgress) {
    const m = await this.mask(src, onProgress);
    // mask → small canvas → smooth upscale to the image size
    const mc = document.createElement("canvas");
    mc.width = mc.height = SIZE;
    const mctx = mc.getContext("2d");
    const md = mctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < m.length; i++) { md.data[i * 4 + 3] = 255; md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = Math.round(m[i] * 255); }
    mctx.putImageData(md, 0, 0);
    const W = src.width, H = src.height;
    const big = document.createElement("canvas");
    big.width = W; big.height = H;
    const bctx = big.getContext("2d");
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(mc, 0, 0, W, H);
    const a = bctx.getImageData(0, 0, W, H).data;

    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    const img = octx.getImageData(0, 0, W, H);
    // edge: stretch the soft border so edges look crisper (0 → no change)
    const lo = 0.5 * edge * 0.6, hi = 1 - 0.5 * edge * 0.6;
    for (let i = 0; i < W * H; i++) {
      let v = a[i * 4] / 255;
      v = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * v);
    }
    octx.putImageData(img, 0, 0);
    return out;
  }
}
