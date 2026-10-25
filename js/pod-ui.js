// Lampyva — "Print-on-demand ready" screen.
// One button does the whole job: remove background → trim → enlarge with AI → place on the store size → 300 DPI PNG.
import { PRESETS, removeWhite, trim, hasTransparency, place, neededScale, pngWithDpi } from "./pod.js";
import { Upscaler, resizeCanvas } from "./upscaler.js";
import { BackgroundRemover } from "./bgremover.js";
import { openImage } from "./formats.js";
import { makeZip } from "./zip.js";

const $ = (s) => document.querySelector(s);
const track = (n) => window.lampyvaTrack && window.lampyvaTrack(n);
const MAX_PIXELS = 4096 * 4096;   // safe size for the AI step on phones
const MAX_SIDE = 8000;            // biggest store canvas we allow
const state = { files: [], results: [], ai: undefined, remover: null };

const human = (n) =>
  n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const baseName = (n) => (n.lastIndexOf(".") > 0 ? n.slice(0, n.lastIndexOf(".")) : n);
const tick = () => new Promise((r) => setTimeout(r, 0));

function getAI() {
  if (state.ai === undefined) { try { state.ai = Upscaler.create("models/"); } catch { state.ai = null; } }
  return state.ai;
}

function preset() {
  const p = PRESETS.find((x) => x.id === $("#pod-preset").value);
  if (p.id !== "custom") return p;
  const w = Math.round(Number($("#pod-w").value)), h = Math.round(Number($("#pod-h").value));
  return { ...p, w, h, label: `Custom ${w}×${h}` };
}

function refreshOptions() {
  const p = PRESETS.find((x) => x.id === $("#pod-preset").value);
  $("#pod-custom").hidden = p.id !== "custom";
  $("#pod-margin-row").hidden = p.fit === "cover";
  $("#pod-cover-note").hidden = p.fit !== "cover";
}

function renderFiles() {
  const list = $("#pod-files");
  list.innerHTML = "";
  state.files.forEach((file, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="cv-name"></span><span class="cv-size">${human(file.size)}</span><button type="button" class="cv-x" aria-label="Remove">✕</button>`;
    li.querySelector(".cv-name").textContent = file.name;
    li.querySelector(".cv-x").onclick = () => { state.files.splice(i, 1); renderFiles(); };
    list.appendChild(li);
  });
  $("#pod-empty").hidden = state.files.length > 0;
  $("#pod-clear").hidden = state.files.length === 0;
  $("#pod-run").disabled = state.files.length === 0;
}

function clearResults() {
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $("#pod-results").innerHTML = "";
  $("#pod-results-box").hidden = true;
}

function showResult(r) {
  const li = document.createElement("li");
  if (r.error) {
    li.className = "cv-error";
    li.innerHTML = `<span class="cv-name"></span><span class="cv-msg"></span>`;
    li.querySelector(".cv-name").textContent = r.source;
    li.querySelector(".cv-msg").textContent = r.error;
  } else {
    li.className = "pod-item";
    li.innerHTML = `<img class="pod-thumb" alt="Preview"><div class="pod-meta"><span class="cv-name"></span>
      <span class="cv-size">${r.w}×${r.h} · 300 DPI · ${human(r.blob.size)}</span><span class="cv-msg pod-warn" hidden></span>
      <a class="btn btn-sm btn-ghost" download>Download</a></div>`;
    li.querySelector(".cv-name").textContent = r.name;
    li.querySelector(".pod-thumb").src = r.thumb;
    if (r.warn) { const w = li.querySelector(".pod-warn"); w.hidden = false; w.textContent = r.warn; }
    const a = li.querySelector("a");
    a.href = r.url;
    a.download = r.name;
  }
  $("#pod-results").appendChild(li);
  $("#pod-results-box").hidden = false;
}

function shrink(c, k) {
  const o = document.createElement("canvas");
  o.width = Math.max(1, Math.round(c.width * k)); o.height = Math.max(1, Math.round(c.height * k));
  const ctx = o.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(c, 0, 0, o.width, o.height);
  return o;
}

function thumbnail(c) {
  const t = shrink(c, Math.min(1, 240 / Math.max(c.width, c.height)));
  return t.toDataURL("image/png");
}

async function processOne(file, P, opts, say, progress) {
  say("Opening image…");
  let d = await openImage(file);
  if (d.width * d.height > MAX_PIXELS) d = shrink(d, Math.sqrt(MAX_PIXELS / (d.width * d.height)));

  // 1) background
  if (opts.bg === "white" || opts.bg === "white-all") {
    say("Removing the white background…");
    await tick();
    d = removeWhite(d, opts.bg === "white" ? "connected" : "all");
  } else if (opts.bg === "ai") {
    say("Removing the background with AI…");
    if (!state.remover) state.remover = new BackgroundRemover("models/");
    if (state.remover.engine === "cpu") track("fallback-bg-cpu");
    d = await state.remover.remove(d, { edge: 0.5 }, (f) => progress(f * 0.3));
  }
  // 2) trim empty borders so the design uses all the space
  if (opts.bg !== "keep" || hasTransparency(d)) d = trim(d);

  // 3) enlarge with AI only as much as needed (max 2 steps, within the safe size)
  const need = neededScale(d, P.w, P.h, P.fit, opts.margin);
  let usedAI = false, aiFactor = 1;
  if (need > 1.15) {
    const ai = getAI();
    // grow as much as needed, but never past the safe size for phones
    const target = Math.min(need, Math.sqrt(MAX_PIXELS / (d.width * d.height)));
    const passes = target > 2.3 ? 2 : target > 1.15 ? 1 : 0;
    if (passes) {
      const pre = target / 2 ** passes;
      if (pre < 1) d = shrink(d, pre); // so the AI result lands exactly on the target
      if (ai) {
        const before = d;
        try {
          for (let p = 0; p < passes; p++) {
            say(`Enhancing with AI${passes > 1 ? `, step ${p + 1} of ${passes}` : ""}…`);
            d = await ai.upscale2x(d, opts.model, (f) => progress(0.3 + ((p + f) / passes) * 0.6));
          }
          usedAI = true; aiFactor = Math.min(target, 2 ** passes);
        } catch (e) {
          console.warn("AI failed, plan B:", e);
          track("fallback-upscale-resize");
          d = before;
        }
      } else {
        track("fallback-upscale-noai");
      }
      if (!usedAI) d = resizeCanvas(d, 2 ** passes);
    }
  }

  // 4) place on the store canvas and save as 300 DPI PNG
  say("Placing on the canvas…");
  await tick();
  const out = place(d, P.w, P.h, P.fit, opts.margin);
  progress(0.95);
  say("Saving PNG…");
  const raw = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("This phone could not save such a big image. Try a smaller size."))), "image/png"));
  const blob = await pngWithDpi(raw, 300);
  let warn = "";
  if (P.maxBytes && blob.size > P.maxBytes) warn = `The file is ${human(blob.size)}; this store accepts up to ${human(P.maxBytes)}. Try "Spreadshirt" with a simpler design or a smaller custom size.`;
  if (need / aiFactor > 1.6) warn = (warn ? warn + " " : "") + "The original image is small for this size, so it may look soft when printed big.";
  return { blob, w: out.width, h: out.height, thumb: thumbnail(out), warn, usedAI };
}

async function run() {
  if (!state.files.length) return;
  const P = preset();
  if (!(P.w >= 100 && P.h >= 100 && P.w <= MAX_SIDE && P.h <= MAX_SIDE)) {
    $("#pod-status").textContent = `Please enter a size between 100 and ${MAX_SIDE} pixels.`;
    return;
  }
  clearResults();
  track("use-pod-" + P.id);
  const opts = {
    bg: $("#pod-bg").value,
    margin: Number($("#pod-margin").value),
    model: $("#pod-type").value === "photo" ? "photo-x2-noise1" : "art-x2-noise1",
  };
  const btn = $("#pod-run");
  btn.disabled = true;
  const status = $("#pod-status");
  $("#pod-progress").hidden = false;

  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i];
    const label = state.files.length > 1 ? ` (${i + 1} of ${state.files.length})` : "";
    $("#pod-bar").style.width = "0%";
    try {
      const r = await processOne(file, P, opts, (t) => { status.textContent = t + label; }, (f) => { $("#pod-bar").style.width = Math.round(f * 100) + "%"; });
      document.body.dataset.podEngine = r.usedAI ? "ai" : "resize";
      const res = { ...r, name: `${baseName(file.name)}-${P.id}-${r.w}x${r.h}.png`, url: URL.createObjectURL(r.blob) };
      state.results.push(res);
      showResult(res);
    } catch (e) {
      console.error(e);
      track("error-pod");
      showResult({ source: file.name, error: e.message || "Something went wrong." });
    }
    await tick();
  }

  $("#pod-progress").hidden = true;
  $("#pod-zip").hidden = state.results.length < 2;
  const ok = state.results.length;
  status.textContent = ok ? `Done! ${ok} design${ok > 1 ? "s" : ""} ready to upload.` : "No designs could be prepared.";
  btn.disabled = false;
  $("#pod-results-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadZip() {
  const btn = $("#pod-zip");
  btn.disabled = true;
  btn.textContent = "Preparing ZIP…";
  try {
    const zip = await makeZip(state.results.map((r) => ({ name: r.name, blob: r.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = "lampyva-print-ready.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download all (ZIP)";
  }
}

function init() {
  $("#pod-preset").innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  const input = $("#pod-input");
  input.addEventListener("change", () => { for (const f of input.files) state.files.push(f); input.value = ""; renderFiles(); });
  const drop = $("#pod-drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { for (const f of e.dataTransfer.files) state.files.push(f); renderFiles(); });
  $("#pod-preset").addEventListener("change", refreshOptions);
  $("#pod-run").addEventListener("click", run);
  $("#pod-zip").addEventListener("click", downloadZip);
  $("#pod-clear").addEventListener("click", () => { state.files = []; renderFiles(); clearResults(); $("#pod-status").textContent = ""; });
  renderFiles();
  refreshOptions();
}

init();
