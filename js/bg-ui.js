// Lampyva — background remover screen.
import { BackgroundRemover } from "./bgremover.js";
import { openImage, availableOutputs } from "./formats.js";
import { makeZip } from "./zip.js";

const $ = (s) => document.querySelector(s);
const track = (n) => window.lampyvaTrack && window.lampyvaTrack(n);
const MAX_SIDE = 4096;
const remover = new BackgroundRemover("models/");
const state = { files: [], results: [], outputs: [] };

const human = (n) =>
  n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const baseName = (n) => (n.lastIndexOf(".") > 0 ? n.slice(0, n.lastIndexOf(".")) : n);

function renderFiles() {
  const list = $("#bg-files");
  list.innerHTML = "";
  state.files.forEach((file, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${human(file.size)}</span><button type="button" class="cv-x" aria-label="Remove">✕</button>`;
    li.querySelector(".cv-name").textContent = file.name;
    li.querySelector(".cv-x").onclick = () => { state.files.splice(i, 1); renderFiles(); };
    list.appendChild(li);
  });
  $("#bg-empty").hidden = state.files.length > 0;
  $("#bg-clear").hidden = state.files.length === 0;
  $("#bg-run").disabled = state.files.length === 0;
}

function refreshOptions() {
  const solid = $("#bg-fill").value === "color";
  $("#bg-color-row").hidden = !solid;
  const fmt = state.outputs.find((f) => f.id === $("#bg-format").value);
  $("#bg-jpg-note").hidden = solid || !fmt || fmt.alpha;
}

function clearResults() {
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $("#bg-results").innerHTML = "";
  $("#bg-results-box").hidden = true;
  $("#bg-compare").hidden = true;
}

function showResult(r) {
  const li = document.createElement("li");
  if (r.error) {
    li.className = "cv-error";
    li.innerHTML = `<span class="cv-name"></span><span class="cv-msg"></span>`;
    li.querySelector(".cv-name").textContent = r.source;
    li.querySelector(".cv-msg").textContent = r.error;
  } else {
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${human(r.blob.size)}</span><a class="btn btn-sm btn-ghost" download>Download</a>`;
    li.querySelector(".cv-name").textContent = r.name;
    const a = li.querySelector("a");
    a.href = r.url;
    a.download = r.name;
  }
  $("#bg-results").appendChild(li);
  $("#bg-results-box").hidden = false;
}

function setSplit(v) {
  $("#bg-before-wrap").style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $("#bg-line").style.left = v + "%";
}
function showCompare(src, outCanvas) {
  $("#bg-before").src = src.toDataURL("image/jpeg", 0.85);
  $("#bg-after").src = outCanvas.toDataURL("image/png");
  $("#bg-compare").hidden = false;
  setSplit($("#bg-split").value);
}

/** Keep huge photos safe on phones. */
function limitSize(c) {
  const s = Math.min(1, MAX_SIDE / Math.max(c.width, c.height));
  if (s === 1) return c;
  const o = document.createElement("canvas");
  o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
  const ctx = o.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(c, 0, 0, o.width, o.height);
  return o;
}

async function run() {
  if (!state.files.length) return;
  clearResults();
  track("use-remove-bg");
  const edge = Number($("#bg-edge").value);
  const solid = $("#bg-fill").value === "color";
  const fmt = state.outputs.find((f) => f.id === $("#bg-format").value);
  const opts = { quality: 0.92, background: solid ? $("#bg-color").value : "#ffffff" };
  const btn = $("#bg-run");
  btn.disabled = true;
  const status = $("#bg-status");
  $("#bg-progress").hidden = false;
  if (remover.engine === "cpu") { $("#bg-slow").hidden = false; track("fallback-bg-cpu"); }
  let compared = false;

  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i];
    const label = state.files.length > 1 ? ` (${i + 1} of ${state.files.length})` : "";
    $("#bg-bar").style.width = "0%";
    try {
      status.textContent = `Opening image…${label}`;
      const src = limitSize(await openImage(file));
      status.textContent = `Finding the subject…${label}`;
      let out = await remover.remove(src, { edge }, (p) => { $("#bg-bar").style.width = Math.round(p * 100) + "%"; });
      document.body.dataset.bgEngine = remover.engine;
      if (remover.engine === "cpu") $("#bg-slow").hidden = false;
      if (solid) {
        const f = document.createElement("canvas");
        f.width = out.width; f.height = out.height;
        const ctx = f.getContext("2d");
        ctx.fillStyle = opts.background;
        ctx.fillRect(0, 0, f.width, f.height);
        ctx.drawImage(out, 0, 0);
        out = f;
      }
      status.textContent = `Saving…${label}`;
      let blob, ext = fmt.ext;
      try {
        blob = await fmt.encode(out, opts);
      } catch (e) {
        // plan B: if this format fails on this device, save as PNG
        track("fallback-format-" + fmt.id);
        const png = state.outputs.find((f) => f.id === "png");
        blob = await png.encode(out, opts); ext = "png";
      }
      const r = { name: `${baseName(file.name)}-no-bg.${ext}`, blob, url: URL.createObjectURL(blob) };
      state.results.push(r);
      showResult(r);
      if (!compared) { showCompare(src, out); compared = true; }
    } catch (e) {
      console.error(e);
      track("error-remove-bg");
      showResult({ source: file.name, error: e.message === "Model not found" ? "Could not download the AI model. Check your connection and try again." : (e.message || "Something went wrong.") });
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  $("#bg-progress").hidden = true;
  $("#bg-zip").hidden = state.results.length < 2;
  const ok = state.results.length;
  status.textContent = ok ? `Done! ${ok} image${ok > 1 ? "s" : ""} ready.` : "No images could be processed.";
  btn.disabled = false;
  $("#bg-results-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadZip() {
  const btn = $("#bg-zip");
  btn.disabled = true;
  btn.textContent = "Preparing ZIP…";
  try {
    const zip = await makeZip(state.results.map((r) => ({ name: r.name, blob: r.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = "lampyva-no-background.zip";
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
  state.outputs = all.filter((f) => ["png", "webp", "jpg"].includes(f.id));
  $("#bg-format").innerHTML = state.outputs.map((f) => `<option value="${f.id}">${f.label}</option>`).join("");
  $("#bg-format").value = "png";

  const input = $("#bg-input");
  input.addEventListener("change", () => { for (const f of input.files) state.files.push(f); input.value = ""; renderFiles(); });
  const drop = $("#bg-drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { for (const f of e.dataTransfer.files) state.files.push(f); renderFiles(); });

  $("#bg-fill").addEventListener("change", refreshOptions);
  $("#bg-format").addEventListener("change", refreshOptions);
  $("#bg-run").addEventListener("click", run);
  $("#bg-zip").addEventListener("click", downloadZip);
  $("#bg-split").addEventListener("input", (e) => setSplit(e.target.value));
  $("#bg-clear").addEventListener("click", () => { state.files = []; renderFiles(); clearResults(); $("#bg-status").textContent = ""; $("#bg-slow").hidden = true; });
  renderFiles();
  refreshOptions();
}

init();
