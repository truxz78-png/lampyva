// Lampyva — AI upscaler screen.
import { Upscaler, resizeCanvas } from "./upscaler.js";
import { openImage, availableOutputs } from "./formats.js";
import { makeZip } from "./zip.js";

const $ = (s) => document.querySelector(s);
const track = (n) => window.lampyvaTrack && window.lampyvaTrack(n);
const MAX_PIXELS = 4096 * 4096; // safe canvas size on phones
const state = { files: [], results: [], outputs: [], ai: undefined };

const human = (n) =>
  n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const baseName = (n) => (n.lastIndexOf(".") > 0 ? n.slice(0, n.lastIndexOf(".")) : n);

function modelName() {
  const type = $("#up-type").value;      // photo | art
  const noise = $("#up-noise").value;    // 0 | 1 | 2
  return `${type}-x2${noise === "0" ? "" : "-noise" + noise}`;
}

function getAI() {
  if (state.ai === undefined) {
    try { state.ai = Upscaler.create("models/"); } catch { state.ai = null; }
  }
  return state.ai;
}

function renderFiles() {
  const list = $("#up-files");
  list.innerHTML = "";
  state.files.forEach((file, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${human(file.size)}</span><button type="button" class="cv-x" aria-label="Remove">✕</button>`;
    li.querySelector(".cv-name").textContent = file.name;
    li.querySelector(".cv-x").onclick = () => { state.files.splice(i, 1); renderFiles(); };
    list.appendChild(li);
  });
  $("#up-empty").hidden = state.files.length > 0;
  $("#up-clear").hidden = state.files.length === 0;
  $("#up-run").disabled = state.files.length === 0;
}

function clearResults() {
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $("#up-results").innerHTML = "";
  $("#up-results-box").hidden = true;
  $("#up-compare").hidden = true;
}

function showResult(r) {
  const li = document.createElement("li");
  if (r.error) {
    li.className = "cv-error";
    li.innerHTML = `<span class="cv-name"></span><span class="cv-msg"></span>`;
    li.querySelector(".cv-name").textContent = r.source;
    li.querySelector(".cv-msg").textContent = r.error;
  } else {
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${r.w}×${r.h}${r.max ? " (max)" : ""} · ${human(r.blob.size)}</span><a class="btn btn-sm btn-ghost" download>Download</a>`;
    li.querySelector(".cv-name").textContent = r.name;
    const a = li.querySelector("a");
    a.href = r.url;
    a.download = r.name;
  }
  $("#up-results").appendChild(li);
  $("#up-results-box").hidden = false;
}

/** Before / after slider using the first result. */
function showCompare(srcCanvas, outUrl) {
  const box = $("#up-compare");
  const before = $("#up-before");
  before.src = srcCanvas.toDataURL("image/png");
  $("#up-after").src = outUrl;
  box.hidden = false;
  setSplit($("#up-split").value);
}
function setSplit(v) {
  $("#up-before-wrap").style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $("#up-line").style.left = v + "%";
}

function shrink(c, k) {
  const o = document.createElement("canvas");
  o.width = Math.max(1, Math.round(c.width * k)); o.height = Math.max(1, Math.round(c.height * k));
  const ctx = o.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(c, 0, 0, o.width, o.height);
  return o;
}

function setProgress(p) {
  $("#up-bar").style.width = Math.round(p * 100) + "%";
}

async function run() {
  if (!state.files.length) return;
  clearResults();
  track("use-upscale");
  const scale = Number($("#up-scale").value);
  const fmt = state.outputs.find((f) => f.id === $("#up-format").value);
  const opts = { quality: 0.92, background: "#ffffff" };
  const ai = getAI();
  const btn = $("#up-run");
  btn.disabled = true;
  const status = $("#up-status");
  $("#up-progress").hidden = false;
  let compared = false;
  let limited = 0;

  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i];
    const label = state.files.length > 1 ? ` (${i + 1} of ${state.files.length})` : "";
    setProgress(0);
    try {
      status.textContent = `Opening image…${label}`;
      const original = await openImage(file);
      // Never fail for size: if the requested result is too big for a phone,
      // make the largest safe result instead (≈16 megapixels).
      let factor = scale, src = original, passes = Math.log2(scale);
      const room = Math.sqrt(MAX_PIXELS / (original.width * original.height));
      if (room < scale) {
        if (room <= 1.05) throw new Error(`This image is already very large (${original.width}×${original.height}). It can't be enlarged safely on a phone, but it's already big enough for most uses.`);
        factor = room;
        passes = factor > 2 ? 2 : 1;
        src = shrink(original, factor / 2 ** passes); // AI then multiplies by 2 per pass
        limited++;
      }
      let out = src;
      let aiOk = false;
      if (ai) {
        try {
          for (let p = 0; p < passes; p++) {
            status.textContent = `Enhancing with AI${passes > 1 ? `, step ${p + 1} of ${passes}` : ""}…${label}`;
            out = await ai.upscale2x(out, modelName(), (f) => setProgress((p + f) / passes));
          }
          aiOk = true;
        } catch (e) {
          // plan B: the AI failed on this device → high-quality resize
          console.warn("AI upscale failed, using plan B:", e);
          track("fallback-upscale-resize");
          out = src;
        }
      } else {
        track("fallback-upscale-noai");
      }
      document.body.dataset.upscaleEngine = aiOk ? "ai" : "resize";
      if (!aiOk) {
        status.textContent = `Enlarging…${label}`;
        out = resizeCanvas(src, 2 ** passes);
        setProgress(1);
      }
      status.textContent = `Saving…${label}`;
      let blob, ext = fmt.ext;
      try {
        blob = await fmt.encode(out, opts);
      } catch (e) {
        track("fallback-format-" + fmt.id);
        blob = await state.outputs.find((f) => f.id === "png").encode(out, opts); ext = "png";
      }
      const tag = factor === scale ? `${scale}x` : `${factor.toFixed(1)}x`;
      const r = { name: `${baseName(file.name)}-${tag}.${ext}`, blob, url: URL.createObjectURL(blob), w: out.width, h: out.height, max: factor !== scale };
      state.results.push(r);
      showResult(r);
      if (!compared) { showCompare(original, r.url); compared = true; }
    } catch (e) {
      console.error(e);
      track("error-upscale");
      showResult({ source: file.name, error: e.message || "Something went wrong." });
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  $("#up-progress").hidden = true;
  $("#up-zip").hidden = state.results.length < 2;
  const ok = state.results.length;
  status.textContent = ok ? `Done! ${ok} image${ok > 1 ? "s" : ""} ready.` + (limited ? " Big photos were enlarged to the largest safe size (about 16 megapixels)." : "") : "No images could be enlarged.";
  btn.disabled = false;
  $("#up-results-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadZip() {
  const btn = $("#up-zip");
  btn.disabled = true;
  btn.textContent = "Preparing ZIP…";
  try {
    const zip = await makeZip(state.results.map((r) => ({ name: r.name, blob: r.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = "lampyva-upscaled.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download all (ZIP)";
  }
}

async function init() {
  const all = await availableOutputs();
  state.outputs = all.filter((f) => ["png", "jpg", "webp"].includes(f.id));
  $("#up-format").innerHTML = state.outputs.map((f) => `<option value="${f.id}">${f.label}</option>`).join("");
  $("#up-format").value = "png";

  if (!getAI()) {
    $("#up-noai").hidden = false;
    $("#up-type-row").hidden = true;
    $("#up-noise-row").hidden = true;
  }

  const input = $("#up-input");
  input.addEventListener("change", () => { for (const f of input.files) state.files.push(f); input.value = ""; renderFiles(); });
  const drop = $("#up-drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { for (const f of e.dataTransfer.files) state.files.push(f); renderFiles(); });

  $("#up-run").addEventListener("click", run);
  $("#up-zip").addEventListener("click", downloadZip);
  $("#up-split").addEventListener("input", (e) => setSplit(e.target.value));
  $("#up-clear").addEventListener("click", () => { state.files = []; renderFiles(); clearResults(); $("#up-status").textContent = ""; });
  renderFiles();
}

init();
