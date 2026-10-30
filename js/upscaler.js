import { breathe } from "./breathe.js";
// Lampyva — AI upscaler (waifu2x "upconv_7" models) running on the visitor's GPU with WebGL2.
// Nothing is uploaded: the model files are downloaded once and everything runs locally.

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// 3x3 convolution, no padding, LeakyReLU(0.1). 4 output channels per draw.
const CONV_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
uniform sampler2DArray uIn; uniform highp sampler2D uW; uniform highp sampler2D uB;
uniform int uInLayers; uniform int uGroup;
out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = texelFetch(uB, ivec2(uGroup, 0), 0);
  int row0 = uGroup * uInLayers;
  for (int l = 0; l < uInLayers; l++) {
    int row = row0 + l;
    for (int t = 0; t < 9; t++) {
      vec4 v = texelFetch(uIn, ivec3(p.x + t % 3, p.y + t / 3, l), 0);
      int x = t * 4;
      mat4 m = mat4(texelFetch(uW, ivec2(x, row), 0), texelFetch(uW, ivec2(x + 1, row), 0),
                    texelFetch(uW, ivec2(x + 2, row), 0), texelFetch(uW, ivec2(x + 3, row), 0));
      acc += m * v;
    }
  }
  o = max(acc, 0.1 * acc);
}`;

// 4x4 transposed convolution, stride 2, padding 3 → RGB output (2x size).
const DECONV_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
uniform sampler2DArray uIn; uniform highp sampler2D uW; uniform highp sampler2D uB;
uniform int uInLayers; uniform ivec2 uInSize;
out vec4 o;
void main(){
  ivec2 P = ivec2(gl_FragCoord.xy) + 3;
  vec4 acc = texelFetch(uB, ivec2(0, 0), 0);
  for (int a = 0; a < 2; a++) {
    int ky = (P.y & 1) + a * 2; int iy = (P.y - ky) / 2;
    if (iy < 0 || iy >= uInSize.y) continue;
    for (int b = 0; b < 2; b++) {
      int kx = (P.x & 1) + b * 2; int ix = (P.x - kx) / 2;
      if (ix < 0 || ix >= uInSize.x) continue;
      int x = (ky * 4 + kx) * 4;
      for (int l = 0; l < uInLayers; l++) {
        vec4 v = texelFetch(uIn, ivec3(ix, iy, l), 0);
        mat4 m = mat4(texelFetch(uW, ivec2(x, l), 0), texelFetch(uW, ivec2(x + 1, l), 0),
                      texelFetch(uW, ivec2(x + 2, l), 0), texelFetch(uW, ivec2(x + 3, l), 0));
        acc += m * v;
      }
    }
  }
  o = vec4(clamp(acc.rgb, 0.0, 1.0), 1.0);
}`;

function f16(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

let manifestPromise = null;
function loadManifest(base) {
  if (!manifestPromise) manifestPromise = fetch(base + "models.json").then((r) => r.json());
  return manifestPromise;
}

export class Upscaler {
  /** Returns an Upscaler, or null if this device can't run the AI (then use the plain resize). */
  static create(base = "models/") {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl) return null;
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
    try {
      return new Upscaler(gl, base);
    } catch (e) {
      console.warn("Upscaler unavailable:", e);
      return null;
    }
  }

  constructor(gl, base) {
    this.gl = gl;
    this.base = base;
    this.models = {};
    this.tile = 128;
    this.conv = this.program(CONV_FS);
    this.deconv = this.program(DECONV_FS);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fb = gl.createFramebuffer();
    this.allocate(this.tile);
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
    for (const n of ["uIn", "uW", "uB", "uInLayers", "uGroup", "uInSize"]) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  /** Two ping-pong feature buffers (up to 256 channels) and one RGBA8 output for a tile. */
  allocate(tile) {
    const gl = this.gl;
    const size = tile + 14;
    this.feat = [0, 1].map(() => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, size, size, 64);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, gl.NEAREST);
      return t;
    });
    this.outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.outTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tile * 2, tile * 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.feat[1], 0, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Float render targets not supported");
  }

  floatTex(data, w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    return t;
  }

  async loadModel(name) {
    if (this.models[name]) return this.models[name];
    const manifest = await loadManifest(this.base);
    const info = manifest[name];
    const raw = new Uint16Array(await (await fetch(this.base + name + ".bin")).arrayBuffer());
    const w = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) w[i] = f16(raw[i]);
    let pos = 0;
    const layers = info.layers.map((L) => {
      const k = L.k, kk = k * k;
      const W = w.subarray(pos, pos + L.in * L.out * kk); pos += L.in * L.out * kk;
      const B = w.subarray(pos, pos + L.out); pos += L.out;
      const inLayers = Math.ceil(L.in / 4), outGroups = Math.ceil(L.out / 4);
      const bias = new Float32Array(outGroups * 4);
      bias.set(B);
      let tex, width, height;
      if (L.type === "conv") {
        // row = group*inLayers + l, x = tap*4 + c, texel = 4 outputs
        width = 9 * 4; height = outGroups * inLayers;
        tex = new Float32Array(width * height * 4);
        for (let o = 0; o < L.out; o++) for (let i = 0; i < L.in; i++) for (let t = 0; t < 9; t++) {
          const row = (o >> 2) * inLayers + (i >> 2), x = t * 4 + (i & 3);
          tex[(row * width + x) * 4 + (o & 3)] = W[((o * L.in + i) * 3 + ((t / 3) | 0)) * 3 + (t % 3)];
        }
      } else {
        // torch SpatialFullConvolution weight: [in][out][ky][kx]; row = l, x = (ky*4+kx)*4 + c
        width = 16 * 4; height = inLayers;
        tex = new Float32Array(width * height * 4);
        for (let i = 0; i < L.in; i++) for (let o = 0; o < L.out; o++) for (let t = 0; t < 16; t++) {
          const x = t * 4 + (i & 3);
          tex[((i >> 2) * width + x) * 4 + o] = W[(i * L.out + o) * 16 + t];
        }
      }
      return { ...L, inLayers, outGroups, w: this.floatTex(tex, width, height), b: this.floatTex(bias, outGroups, 1) };
    });
    this.models[name] = layers;
    return layers;
  }

  /** Run the network on one padded tile (RGB floats, size (tile+14)^2) → Uint8 RGBA (2*tile)^2. */
  runTile(layers, rgb, size) {
    const gl = this.gl;
    const inTex = this.feat[0];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, 1, gl.RGBA, gl.FLOAT, rgb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.bindVertexArray(this.vao);
    let cur = 0, s = size;
    for (const L of layers) {
      const prog = L.type === "conv" ? this.conv : this.deconv;
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.feat[cur]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L.w);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, L.b);
      gl.uniform1i(prog.u.uIn, 0); gl.uniform1i(prog.u.uW, 1); gl.uniform1i(prog.u.uB, 2);
      gl.uniform1i(prog.u.uInLayers, L.inLayers);
      if (L.type === "conv") {
        const out = s - 2;
        gl.viewport(0, 0, out, out);
        for (let g = 0; g < L.outGroups; g++) {
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.feat[1 - cur], 0, g);
          gl.uniform1i(prog.u.uGroup, g);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        cur = 1 - cur; s = out;
      } else {
        const out = s * 2 - 4;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outTex, 0);
        gl.viewport(0, 0, out, out);
        gl.uniform2i(prog.u.uInSize, s, s);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return { out };
      }
    }
  }

  /** Wait until the GPU has finished, without blocking the page (it keeps scrolling meanwhile). */
  async gpuDone() {
    const gl = this.gl;
    if (!gl.fenceSync) return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const t0 = performance.now();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED && performance.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, document.hidden ? 0 : 4));
    }
    gl.deleteSync(sync);
  }

  readTile(out) {
    const gl = this.gl;
    const px = new Uint8Array(out * out * 4);
    gl.readPixels(0, 0, out, out, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  /**
   * Upscale a canvas 2x with the AI model. onProgress(0..1).
   * Transparent images: colors are "bled" into transparent areas, alpha is scaled smoothly.
   */
  async upscale2x(src, modelName, onProgress = () => {}) {
    const layers = await this.loadModel(modelName);
    const W = src.width, H = src.height, T = this.tile, P = 7, S = T + 2 * P;
    const data = src.getContext("2d").getImageData(0, 0, W, H).data;
    const hasAlpha = hasTransparency(data);
    const rgbSrc = hasAlpha ? bleed(data, W, H) : data;

    const out = document.createElement("canvas");
    out.width = W * 2; out.height = H * 2;
    const octx = out.getContext("2d");
    const tilesX = Math.ceil(W / T), tilesY = Math.ceil(H / T);
    const buf = new Float32Array(S * S * 4);
    let done = 0;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * T, y0 = ty * T;
        for (let y = 0; y < S; y++) {
          const sy = Math.min(H - 1, Math.max(0, y0 + y - P));
          for (let x = 0; x < S; x++) {
            const sx = Math.min(W - 1, Math.max(0, x0 + x - P));
            const i = (sy * W + sx) * 4, j = (y * S + x) * 4;
            buf[j] = rgbSrc[i] / 255; buf[j + 1] = rgbSrc[i + 1] / 255; buf[j + 2] = rgbSrc[i + 2] / 255; buf[j + 3] = 0;
          }
        }
        const { out: outSize } = this.runTile(layers, buf, S);
        await this.gpuDone();
        const px = this.readTile(outSize);
        const tw = Math.min(T, W - x0) * 2, th = Math.min(T, H - y0) * 2;
        const img = octx.createImageData(tw, th);
        for (let y = 0; y < th; y++) img.data.set(px.subarray(y * T * 2 * 4, (y * T * 2 + tw) * 4), y * tw * 4);
        octx.putImageData(img, x0 * 2, y0 * 2);
        onProgress(++done / (tilesX * tilesY));
        await breathe(); // let the page scroll and draw between tiles
      }
    }
    if (hasAlpha) applyAlpha(out, src);
    return out;
  }
}

function hasTransparency(d) {
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** Spread nearby colors into fully transparent pixels so edges don't get dark halos. */
function bleed(d, W, H) {
  const out = new Uint8ClampedArray(d);
  let known = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) known[p] = d[p * 4 + 3] > 0 ? 1 : 0;
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
        if (known[q]) { r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; n++; }
      }
      if (n) { out[p * 4] = r / n; out[p * 4 + 1] = g / n; out[p * 4 + 2] = b / n; next[p] = 1; changed = true; }
    }
    known = next;
    if (!changed) break;
  }
  return out;
}

/** Use the original transparency, scaled smoothly to the new size. */
function applyAlpha(out, src) {
  const a = document.createElement("canvas");
  a.width = out.width; a.height = out.height;
  const actx = a.getContext("2d");
  actx.imageSmoothingQuality = "high";
  actx.drawImage(src, 0, 0, a.width, a.height);
  const ad = actx.getImageData(0, 0, a.width, a.height).data;
  const octx = out.getContext("2d");
  const od = octx.getImageData(0, 0, out.width, out.height);
  for (let i = 3; i < od.data.length; i += 4) od.data[i] = ad[i];
  octx.putImageData(od, 0, 0);
}

/** Plain high-quality resize (fallback when AI is not available). */
export function resizeCanvas(src, scale) {
  let cur = src;
  let remaining = scale;
  while (remaining > 1) {
    const step = Math.min(2, remaining);
    const c = document.createElement("canvas");
    c.width = Math.round(cur.width * step); c.height = Math.round(cur.height * step);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; remaining /= step;
  }
  return cur;
}
