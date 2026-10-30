// Lampyva — converter screen.
import { openImage, availableOutputs, INPUT_LABELS } from "./formats.js";
import { makeZip } from "./zip.js";
import { keepAwake, notifyDone } from "./breathe.js";

const $ = (s) => document.querySelector(s);
const track = (n) => window.lampyvaTrack && window.lampyvaTrack(n);
const state = { files: [], results: [], outputs: [] };

const human = (n) =>
  n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const baseName = (n) => (n.lastIndexOf(".") > 0 ? n.slice(0, n.lastIndexOf(".")) : n);

function selectedFormat() {
  return state.outputs.find((f) => f.id === $("#cv-format").value);
}

function refreshOptions() {
  const f = selectedFormat();
  if (!f) return;
  $("#cv-quality-row").hidden = !f.quality;
  $("#cv-bg-row").hidden = !!f.alpha;
  $("#cv-combine-row").hidden = !(f.multi && state.files.length > 1);
  $("#cv-run").disabled = state.files.length === 0;
  $("#cv-quality-val").textContent = $("#cv-quality").value + "%";
}

function renderFiles() {
  const list = $("#cv-files");
  list.innerHTML = "";
  state.files.forEach((file, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${human(file.size)}</span><button type="button" class="cv-x" aria-label="Remove">✕</button>`;
    li.querySelector(".cv-name").textContent = file.name;
    li.querySelector(".cv-x").onclick = () => { state.files.splice(i, 1); renderFiles(); };
    list.appendChild(li);
  });
  $("#cv-empty").hidden = state.files.length > 0;
  $("#cv-clear").hidden = state.files.length === 0;
  refreshOptions();
}

function addFiles(fileList) {
  for (const f of fileList) state.files.push(f);
  renderFiles();
}

function clearResults() {
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $("#cv-results").innerHTML = "";
  $("#cv-results-box").hidden = true;
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
  $("#cv-results").appendChild(li);
  $("#cv-results-box").hidden = false;
}

async function runJob() {
  const fmt = selectedFormat();
  if (!fmt || !state.files.length) return;
  clearResults();
  track("use-convert-" + fmt.id);
  const opts = {
    quality: Number($("#cv-quality").value) / 100,
    background: $("#cv-bg").value,
  };
  const combine = fmt.multi && state.files.length > 1 && $("#cv-combine").checked;
  const btn = $("#cv-run");
  btn.disabled = true;
  const status = $("#cv-status");
  const canvases = [];

  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i];
    status.textContent = `Working… ${i + 1} of ${state.files.length}`;
    try {
      const canvas = await openImage(file);
      if (combine) { canvases.push(canvas); continue; }
      let blob, ext = fmt.ext;
      try {
        blob = await fmt.encode(canvas, opts);
      } catch (err) {
        // plan B: this format failed on this device → save as PNG and say so
        track("fallback-format-" + fmt.id);
        const png = state.outputs.find((f) => f.id === "png");
        if (fmt.id === "png" || !png) throw err;
        blob = await png.encode(canvas, opts); ext = "png";
        showResult({ source: file.name, error: `${fmt.label} is not supported on this device, so it was saved as PNG.` });
      }
      const r = { name: `${baseName(file.name)}.${ext}`, blob, url: URL.createObjectURL(blob) };
      state.results.push(r);
      showResult(r);
    } catch (e) {
      track("error-convert");
      showResult({ source: file.name, error: e.message || "Something went wrong." });
    }
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }

  if (combine && canvases.length) {
    try {
      status.textContent = "Creating PDF…";
      const blob = await fmt.encodeMany(canvases, opts);
      const r = { name: "lampyva-images.pdf", blob, url: URL.createObjectURL(blob) };
      state.results.push(r);
      showResult(r);
    } catch (e) {
      showResult({ source: "PDF", error: e.message || "Something went wrong." });
    }
  }

  $("#cv-zip").hidden = state.results.length < 2;
  const ok = state.results.length;
  status.textContent = ok ? `Done! ${ok} file${ok > 1 ? "s" : ""} ready.` : "No files could be converted.";
  btn.disabled = false;
  $("#cv-results-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadZip() {
  const btn = $("#cv-zip");
  btn.disabled = true;
  btn.textContent = "Preparing ZIP…";
  try {
    const zip = await makeZip(state.results.map((r) => ({ name: r.name, blob: r.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = "lampyva-converted.zip";
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
  state.outputs = await availableOutputs();
  const sel = $("#cv-format");
  sel.innerHTML = state.outputs.map((f) => `<option value="${f.id}">${f.label}</option>`).join("");
  sel.value = "png";
  $("#cv-inputs").textContent = INPUT_LABELS.join(" · ");
  $("#cv-outputs").textContent = state.outputs.map((f) => f.label.replace(" (icon)", "")).join(" · ");

  const input = $("#cv-input");
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  // files chosen while the page was still loading are not lost
  if (input.files.length) { addFiles(input.files); input.value = ""; }
  const drop = $("#cv-drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  sel.addEventListener("change", refreshOptions);
  $("#cv-quality").addEventListener("input", refreshOptions);
  $("#cv-run").addEventListener("click", run);
  $("#cv-zip").addEventListener("click", downloadZip);
  $("#cv-clear").addEventListener("click", () => { state.files = []; renderFiles(); clearResults(); $("#cv-status").textContent = ""; });
  renderFiles();
}

init();

// screen stays on while working, and a notification when it is done (if the visitor allowed it)
async function run() {
  keepAwake(true);
  try { await runJob(); } finally {
    keepAwake(false);
    const st = document.querySelector("#cv-status");
    if (st && /Done|No /.test(st.textContent)) notifyDone("Lampyva", st.textContent);
  }
}
