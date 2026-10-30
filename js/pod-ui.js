// Lampyva — "Print-on-demand ready" screen.
// One button does the whole job: remove background → trim → enlarge with AI → place on the store size → 300 DPI PNG.
import { PRESETS, cleanDesign, trimCanvas, compactPNG, hasTransparency, place, neededScale, pngWithDpi, eraseAt, undoErase } from "./pod.js";
import { breathe, keepAwake, notifyDone, notifySwitch } from "./breathe.js";
import { makePin, makeMockup } from "./promo.js";
import { Upscaler, resizeCanvas } from "./upscaler.js";
import { BackgroundRemover } from "./bgremover.js";
import { openImage } from "./formats.js";
import { makeZip } from "./zip.js";

const $ = (s) => document.querySelector(s);
const track = (n) => window.lampyvaTrack && window.lampyvaTrack(n);
const MAX_PIXELS = 4096 * 4096;   // safe size for the AI step on phones
const MAX_SIDE = 8000;            // biggest store canvas we allow
const state = { files: [], results: [], promos: [], ai: undefined, remover: null };

const human = (n) =>
  n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const baseName = (n) => (n.lastIndexOf(".") > 0 ? n.slice(0, n.lastIndexOf(".")) : n);
const tick = () => new Promise((r) => setTimeout(r, 0));

function getAI() {
  if (state.ai === undefined) { try { state.ai = Upscaler.create("models/"); } catch { state.ai = null; } }
  return state.ai;
}

function preset(id = $("#pod-preset").value) {
  const p = PRESETS.find((x) => x.id === id);
  if (p.id !== "custom") return p;
  const w = Math.round(Number($("#pod-w").value)), h = Math.round(Number($("#pod-h").value));
  return { ...p, w, h, label: `Custom ${w}×${h}` };
}

const HOLE_LABELS = ["Tiny", "Small", "Small", "Medium", "Medium", "Medium", "Large", "Large", "Large", "Large"];
const holeMin = () => { const v = Number($("#pod-holesize").value); return 2.5e-6 * v * v; }; // Small (2) = 0.001% of the image; round spots (highlights) are protected
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

function refreshOptions() {
  const bgv = $("#pod-bg").value;
  $("#pod-holes-row").hidden = bgv !== "white";
  const holes = bgv === "white" && $("#pod-holes").checked;
  $("#pod-holesize-row").hidden = !holes;
  $("#pod-holes-note").hidden = !holes;
  $("#pod-holesize-val").textContent = HOLE_LABELS[Number($("#pod-holesize").value) - 1];
  const p = PRESETS.find((x) => x.id === $("#pod-preset").value);
  $("#pod-custom").hidden = p.id !== "custom";
  // extra sizes: every store size except the main one
  const box = $("#pod-extra");
  const chosen = new Set(extraIds());
  box.innerHTML = "";
  for (const x of PRESETS) {
    if (x.id === "custom" || x.id === p.id) continue;
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${x.id}"><span></span>`;
    l.querySelector("span").textContent = x.label.replace(" (recommended)", "");
    l.querySelector("input").checked = chosen.has(x.id);
    l.querySelector("input").addEventListener("change", () => { store("lampyva-pod-extra", extraIds().join(",")); refreshPoster(); });
    box.appendChild(l);
  }
  refreshPoster();
}
const extraIds = () => {
  const box = $("#pod-extra");
  if (box && box.children.length) return [...box.querySelectorAll("input:checked")].map((i) => i.value);
  return (store("lampyva-pod-extra") || "").split(",").filter(Boolean);
};
function refreshPoster() {
  const n = extraIds().length;
  $("#pod-extra-count").textContent = n ? `(+${n})` : "";
  const ids = [$("#pod-preset").value, ...extraIds()];
  const p = PRESETS.find((x) => x.id === $("#pod-preset").value);
  const poster = ids.some((id) => (PRESETS.find((x) => x.id === id) || {}).poster);
  $("#pod-poster-row").hidden = !poster;
  $("#pod-postercolor-row").hidden = $("#pod-poster").value !== "fit";
  const fill = (x) => x.fit === "cover" && !(x.poster && $("#pod-poster").value === "fit");
  $("#pod-margin-row").hidden = fill(p);
  $("#pod-cover-note").hidden = !fill(p);
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
  for (const r of state.promos) URL.revokeObjectURL(r.url);
  state.results = []; state.promos = [];
  $("#pod-results").innerHTML = "";
  $("#pod-promo-list").innerHTML = "";
  $("#pod-promo-status").textContent = "";
  $("#pod-results-box").hidden = true;
}

function showResult(r, replace) {
  const li = document.createElement("li");
  if (r.error) {
    li.className = "cv-error";
    li.innerHTML = `<span class="cv-name"></span><span class="cv-msg"></span>`;
    li.querySelector(".cv-name").textContent = r.source;
    li.querySelector(".cv-msg").textContent = r.error;
  } else {
    li.className = "pod-item";
    li.innerHTML = `<div class="pod-prev"><img class="pod-thumb" alt="Preview"></div>
      <div class="pod-bgs"><button type="button" class="pe-chip on" data-pbg="">Dark</button><button type="button" class="pe-chip" data-pbg="light">Light</button><button type="button" class="pe-chip" data-pbg="checker">Checker</button></div>
      <div class="pod-meta"><span class="cv-name"></span>
      <span class="cv-size">${r.w}×${r.h} · 300 DPI · ${human(r.blob.size)}</span><span class="cv-msg pod-warn" hidden></span>
      <a class="btn btn-sm btn-ghost" download>Download</a>
      <button type="button" class="btn btn-sm btn-ghost pod-edit">✏️ Check &amp; touch up</button></div>`;
    li.querySelector(".cv-name").textContent = r.name;
    li.querySelector(".pod-thumb").src = r.thumb;
    if (r.warns && r.warns.length) {
      const w = li.querySelector(".pod-warn");
      w.hidden = false;
      for (const t of r.warns) { const sp = document.createElement("span"); sp.className = "pod-warn-line"; sp.textContent = t; w.appendChild(sp); }
    }
    const a = li.querySelector("a");
    a.href = r.url;
    a.download = r.name;
    a.addEventListener("click", () => { keepPage(); a.classList.add("done"); rememberName(r.name); });
    const prev = li.querySelector(".pod-prev");
    li.querySelectorAll("[data-pbg]").forEach((b) => b.addEventListener("click", () => {
      li.querySelectorAll("[data-pbg]").forEach((x) => x.classList.toggle("on", x === b));
      prev.className = "pod-prev" + (b.dataset.pbg ? " bg-" + b.dataset.pbg : "");
    }));
    const open = () => openEditor(r);
    li.querySelector(".pod-edit").onclick = open;
    li.querySelector(".pod-thumb").onclick = open;
  }
  if (replace) { replace.replaceWith(li); r.li = li; return; }
  r.li = li;
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
  const t = shrink(c, Math.min(1, 720 / Math.max(c.width, c.height)));
  return t.toDataURL("image/webp", 0.92); // keeps transparency; browsers without WebP give PNG
}

/* ---------- File names: optional code/prefix, and never the same name twice on this device
   (the phone would add "(1)"; Lampyva adds -v2, -v3… instead) ---------- */
const cleanName = (t) => t.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
const sessionNames = new Set(); // names given on this visit (downloaded or not)
function usedNames() {
  const u = new Set((store("lampyva-pod-names") || "").split("|").filter(Boolean));
  for (const n of sessionNames) u.add(n);
  return u;
}
function rememberName(n) { const u = [...usedNames()].filter((x) => x !== n); u.push(n); store("lampyva-pod-names", u.slice(-300).join("|")); }
function uniqueName(base, ext, taken) {
  let n = `${base}${ext}`, v = 2;
  while (taken.has(n)) n = `${base}-v${v++}${ext}`;
  taken.add(n); sessionNames.add(n);
  return n;
}

/* ---------- Time left: one countdown for the whole job that only goes down ---------- */
function etaMeter(el) {
  const t0 = performance.now();
  let shown = Infinity, shownAt = 0;
  return (f) => {
    const now = performance.now(), spent = (now - t0) / 1000;
    if (f >= 0.995) { el.hidden = true; return; }
    if (f < 0.03 || spent < 3) return;
    let left = (spent * (1 - f)) / f;
    if (shown !== Infinity) left = Math.min(left, Math.max(0, shown - (now - shownAt) / 1000)); // never goes up
    shown = left; shownAt = now;
    el.textContent = left < 3 ? "Almost done…" : left < 60 ? `About ${Math.ceil(left)} s left` : `About ${Math.ceil(left / 60)} min left`;
    el.hidden = false;
  };
}

/**
 * One design → all the chosen store sizes. The background is removed and the design enlarged
 * only once (as much as the biggest size needs), then placed on each size.
 * progress(f) with f from 0 to 1, weighted by the real work of each step.
 */
async function processOne(file, sizes, opts, say, progress) {
  say("Opening image…");
  let d = await openImage(file);
  if (d.width * d.height > MAX_PIXELS) d = shrink(d, Math.sqrt(MAX_PIXELS / (d.width * d.height)));
  await breathe();

  // how the work is shared: background, AI passes (the 2nd pass is 4× the 1st), saving each size
  const W = { bg: opts.bg === "ai" ? 0.25 : 0.06, ai: opts.fast ? 0 : 0.6, save: 0.12 * sizes.length };
  const total = W.bg + W.ai + W.save;
  const at = (start, part) => (f) => progress((start + part * f) / total);

  // 1) background + loose specks, then crop to the design
  let creamKept = 0;
  if (opts.bg === "ai") {
    say("Removing the background with AI…");
    if (!state.remover) state.remover = new BackgroundRemover("models/");
    if (state.remover.engine === "cpu") track("fallback-bg-cpu");
    d = await state.remover.remove(d, { edge: 0.5 }, at(0, W.bg * 0.8));
    d = (await cleanDesign(d, { specks: true })).canvas;
  } else if (opts.bg === "white" || opts.bg === "white-all") {
    say("Removing the white background…");
    const r = await cleanDesign(d, { white: opts.bg === "white" ? "connected" : "all", holes: opts.holes, holeMin: opts.holeMin, specks: true });
    d = r.canvas; creamKept = r.creamKept;
  } else if (hasTransparency(d)) {
    d = (await cleanDesign(d, { specks: true })).canvas;
  }
  progress(W.bg / total);

  // 2) enlarge with AI only as much as the biggest size needs (max 2 steps, within the safe size)
  const need = Math.max(...sizes.map((P) => neededScale(d, P.w, P.h, P.fitNow, opts.margin)));
  let usedAI = false, aiFactor = 1;
  if (need > 1.15 && opts.fast) {
    track("use-pod-fast"); // simple enlarge: placing on the canvas scales the design (seconds)
  } else if (need > 1.15) {
    const ai = getAI();
    const target = Math.min(need, Math.sqrt(MAX_PIXELS / (d.width * d.height)));
    const passes = target > 2.3 ? 2 : target > 1.15 ? 1 : 0;
    if (passes) {
      const pre = target / 2 ** passes;
      if (pre < 1) d = shrink(d, pre); // so the AI result lands exactly on the target
      if (ai) {
        const before = d;
        const share = passes === 2 ? [0.2, 0.8] : [1];
        try {
          let start = W.bg;
          for (let p = 0; p < passes; p++) {
            say(`Enhancing with AI${passes > 1 ? `, step ${p + 1} of ${passes}` : ""}…`);
            d = await ai.upscale2x(d, opts.model, at(start, W.ai * share[p]));
            start += W.ai * share[p];
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
  progress((W.bg + W.ai) / total);

  // 3) each size: place on the store canvas and save as a 300 DPI PNG
  const outs = [];
  for (let k = 0; k < sizes.length; k++) {
    const P = sizes[k];
    say(sizes.length > 1 ? `Saving ${P.w}×${P.h}…` : "Saving PNG…");
    await breathe();
    const out = place(d, P.w, P.h, P.fitNow, P.fitNow === "cover" ? 0 : opts.margin, P.bgColor || "");
    let blob = null;
    if (P.maxBytes) blob = await compactPNG(out, 300); // smallest possible file for size-limited stores
    const raw = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("This phone could not save such a big image. Try a smaller size."))), "image/png"));
    const std = await pngWithDpi(raw, 300);
    if (!blob || std.size < blob.size) blob = std;
    const warns = [];
    if (P.maxBytes && blob.size > P.maxBytes) warns.push(`The file is ${human(blob.size)}; this store accepts up to 10 MB. Try a bigger "Space around the design" or a simpler design.`);
    if (need / aiFactor > 1.6 && k === 0) warns.push("The original image is small for this size, so it may look soft when printed big.");
    if (creamKept && k === 0) warns.push(`Light-colored areas kept inside the design: ${creamKept}. Only pure white is removed. Use ✏️ Check & touch up to remove one by hand.`);
    outs.push({ P, blob, w: out.width, h: out.height, thumb: thumbnail(out), warns, usedAI });
    progress((W.bg + W.ai + 0.12 * (k + 1)) / total);
  }
  return outs;
}

async function run() {
  if (!state.files.length) return;
  const main = preset();
  if (!(main.w >= 100 && main.h >= 100 && main.w <= MAX_SIDE && main.h <= MAX_SIDE)) {
    $("#pod-status").textContent = `Please enter a size between 100 and ${MAX_SIDE} pixels.`;
    return;
  }
  const posterFit = $("#pod-poster").value === "fit", posterColor = $("#pod-postercolor").value;
  const sizes = [main, ...extraIds().map((id) => preset(id)).filter(Boolean)].map((P) => ({
    ...P,
    fitNow: P.poster && posterFit ? "contain" : P.fit,
    bgColor: P.poster && posterFit ? posterColor : "",
  }));
  clearResults();
  for (const P of sizes) track("use-pod-" + P.id);
  if (sizes.length > 1) track("use-pod-multi");
  if ($("#pod-bg").value === "white" && $("#pod-holes").checked) track("use-pod-holes");
  const opts = {
    bg: $("#pod-bg").value,
    holes: $("#pod-bg").value === "white" && $("#pod-holes").checked,
    fast: $("#pod-quality").value === "fast",
    holeMin: holeMin(),
    margin: Number($("#pod-margin").value),
    model: $("#pod-type").value === "photo" ? "photo-x2-noise1" : "art-x2-noise1",
  };
  const prefix = cleanName($("#pod-prefix").value || "");
  const taken = usedNames();
  const btn = $("#pod-run");
  btn.disabled = true;
  const status = $("#pod-status");
  $("#pod-progress").hidden = false;
  $("#pod-bar").style.width = "0%";
  const eta = $("#pod-eta");
  eta.hidden = true;
  const meter = etaMeter(eta);
  const n = state.files.length;
  keepAwake(true);
  try {
    for (let i = 0; i < n; i++) {
      const file = state.files[i];
      const label = n > 1 ? ` (${i + 1} of ${n})` : "";
      const base = prefix ? (n > 1 ? `${prefix}-${String(i + 1).padStart(2, "0")}` : prefix) : cleanName(baseName(file.name)) || "design";
      try {
        const say = (t) => { status.textContent = t + label; };
        const prog = (f) => {
          const all = (i + Math.min(1, f)) / n;
          $("#pod-bar").style.width = Math.round(all * 100) + "%";
          meter(all);
        };
        // anti-failure: if something goes wrong, try again by itself before showing any error;
        // the last try enlarges without AI, which needs much less memory
        let outs;
        try { outs = await processOne(file, sizes, opts, say, prog); }
        catch (e1) {
          if (e1.code === "read") throw e1;
          console.warn("retrying:", e1);
          track("retry-pod");
          await new Promise((r) => setTimeout(r, 800));
          try { outs = await processOne(file, sizes, opts, say, prog); }
          catch (e2) {
            if (opts.fast || e2.code === "read") throw e2;
            track("fallback-pod-fast");
            outs = await processOne(file, sizes, { ...opts, fast: true }, say, prog);
            for (const o of outs) o.warns.unshift("Enlarged without AI this time, to save the phone's memory.");
          }
        }
        for (const o of outs) {
          document.body.dataset.podEngine = o.usedAI ? "ai" : "resize";
          const res = { ...o, group: i, base, name: uniqueName(`${base}-${o.P.id}-${o.w}x${o.h}`, ".png", taken), url: URL.createObjectURL(o.blob) };
          state.results.push(res);
          showResult(res);
        }
      } catch (e) {
        console.error(e);
        track("error-pod-" + (e.code === "read" ? "read" : /memory|open/i.test(e.message || "") ? "open" : "other"));
        showResult({ source: file.name, error: e.message || "Something went wrong." });
      }
      await breathe();
    }
  } finally {
    keepAwake(false);
  }

  $("#pod-progress").hidden = true;
  eta.hidden = true;
  $("#pod-zip").hidden = state.results.length < 2;
  const ok = new Set(state.results.map((r) => r.group)).size;
  status.textContent = ok ? `Done! ${ok} design${ok > 1 ? "s" : ""} ready to upload.` : "No designs could be prepared.";
  btn.disabled = false;
  notifyDone("Lampyva", ok ? status.textContent : "No designs could be prepared.");
  $("#pod-results-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function downloadZip() {
  const btn = $("#pod-zip");
  btn.disabled = true;
  btn.textContent = "Preparing ZIP…";
  try {
    const files = [...state.results, ...state.promos].map((r) => ({ name: r.name, blob: r.blob }));
    const zip = await makeZip(files);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    const taken = usedNames();
    a.download = uniqueName(cleanName($("#pod-prefix").value || "") || "lampyva-print-ready", ".zip", taken);
    rememberName(a.download);
    document.body.appendChild(a);
    keepPage();
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download all (ZIP)";
  }
}

/* ---------- Promote: Pinterest pins and T-shirt previews, one per design ---------- */
async function makePromos(kind) {
  const groups = [];
  for (const r of state.results) if (!groups.some((g) => g.group === r.group)) groups.push(r);
  if (!groups.length) return;
  const btn = $(kind === "pin" ? "#pod-pins" : "#pod-mockups"), st = $("#pod-promo-status");
  btn.disabled = true;
  keepAwake(true);
  const taken = usedNames();
  try {
    for (let k = 0; k < groups.length; k++) {
      const r = groups[k];
      st.textContent = (kind === "pin" ? "Making Pinterest pins…" : "Making T-shirt previews…") + (groups.length > 1 ? ` (${k + 1} of ${groups.length})` : "");
      await breathe();
      const bmp = await createImageBitmap(r.blob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      const design = await trimCanvas(c);
      const out = kind === "pin"
        ? makePin(design, { bg: $("#pod-pincolor").value, title: $("#pod-pintitle").value.trim() })
        : makeMockup(design);
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      const base = r.base;
      const p = { blob, url: URL.createObjectURL(blob), w: out.width, h: out.height, name: uniqueName(`${base}-${kind === "pin" ? "pinterest" : "tshirt-preview"}-${out.width}x${out.height}`, ".jpg", taken) };
      state.promos.push(p);
      showPromo(p);
    }
    track(kind === "pin" ? "use-pod-pins" : "use-pod-mockups");
    st.textContent = "";
    $("#pod-zip").hidden = state.results.length + state.promos.length < 2;
  } catch (e) {
    console.error(e);
    st.textContent = e.message || "Something went wrong.";
  } finally {
    keepAwake(false);
    btn.disabled = false;
  }
}

function showPromo(p) {
  const li = document.createElement("li");
  li.className = "pod-item pod-promo-item";
  li.innerHTML = `<img alt="Preview"><div class="pod-meta"><span class="cv-name"></span><span class="cv-size">${p.w}×${p.h} · ${human(p.blob.size)}</span><a class="btn btn-sm btn-ghost" download>Download</a></div>`;
  li.querySelector("img").src = p.url;
  li.querySelector(".cv-name").textContent = p.name;
  const a = li.querySelector("a");
  a.href = p.url; a.download = p.name;
  a.addEventListener("click", () => { keepPage(); a.classList.add("done"); rememberName(p.name); });
  $("#pod-promo-list").appendChild(li);
}

/* ---------- Keep the visitor on Lampyva: the phone's back button after a download
   (or inside the editor) stays on the page instead of leaving and losing the results ---------- */
function keepPage() {
  try { if (!(history.state && history.state.lvKeep)) history.pushState({ lvKeep: 1 }, ""); } catch (e) {}
}

/* ---------- "Check & touch up" editor: tap to erase white leftovers, with undo.
   The view draws only the visible part straight from the full-size image, so even 8× stays sharp
   (real pixels, no blur). Works with a finger (scroll, tap) and a mouse (drag, click, wheel). ---------- */
const ed = { r: null, full: null, small: null, ds: 1, steps: [], zoom: 1, base: 1, ox: 0, oy: 0, raf: 0 };

function edStatus(t) { $("#pe-status").textContent = t; }
function edButtons() { $("#pe-undo").disabled = !ed.steps.length; $("#pe-save").disabled = !ed.steps.length; }

// keep the reduced copy (used for the zoomed-out views) in sync after an erase or undo
function syncSmall(rect) {
  const ctx = ed.small.getContext("2d"), s = ed.ds;
  const x = Math.max(0, Math.floor(rect.x * s) - 1), y = Math.max(0, Math.floor(rect.y * s) - 1);
  const w = Math.ceil(rect.w * s) + 2, h = Math.ceil(rect.h * s) + 2;
  ctx.clearRect(x, y, w, h);
  ctx.drawImage(ed.full, x / s, y / s, w / s, h / s, x, y, w, h);
}

function layout(keep) {
  const view = $("#pe-view"), sc = $("#pe-scroll"), W = ed.full.width, H = ed.full.height;
  const vw = view.clientWidth;
  const vh = Math.max(200, Math.min(Math.round(window.innerHeight * 0.6), Math.round(vw * H / W)));
  view.style.height = vh + "px";
  // remember which image point is in the middle, to keep it there after zooming
  let cx = W / 2, cy = H / 2;
  if (keep) { cx = (sc.scrollLeft + vw / 2 - ed.ox) / (ed.base * ed.zoomOld); cy = (sc.scrollTop + vh / 2 - ed.oy) / (ed.base * ed.zoomOld); }
  ed.base = Math.min(vw / W, vh / H);
  const k = ed.base * ed.zoom, cw = W * k, ch = H * k;
  ed.ox = Math.max(0, (vw - cw) / 2); ed.oy = Math.max(0, (vh - ch) / 2);
  const sz = $("#pe-sizer");
  sz.style.width = Math.max(vw, cw) + "px"; sz.style.height = Math.max(vh, ch) + "px";
  sc.scrollLeft = cx * k + ed.ox - vw / 2; sc.scrollTop = cy * k + ed.oy - vh / 2;
  paint();
}

function paint() {
  ed.raf = 0;
  if (!ed.full) return;
  const view = $("#pe-view"), sc = $("#pe-scroll"), c = $("#pe-canvas");
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const vw = view.clientWidth, vh = view.clientHeight;
  const pw = Math.round(vw * dpr), ph = Math.round(vh * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  const k = ed.base * ed.zoom;                 // screen px per image px
  const kd = k * dpr;                          // device px per image px
  // visible part of the image, in image pixels
  const x0 = Math.max(0, (sc.scrollLeft - ed.ox) / k), y0 = Math.max(0, (sc.scrollTop - ed.oy) / k);
  const x1 = Math.min(ed.full.width, (sc.scrollLeft - ed.ox + vw) / k), y1 = Math.min(ed.full.height, (sc.scrollTop - ed.oy + vh) / k);
  if (x1 <= x0 || y1 <= y0) return;
  const dx = (x0 * k + ed.ox - sc.scrollLeft) * dpr, dy = (y0 * k + ed.oy - sc.scrollTop) * dpr;
  const dw = (x1 - x0) * kd, dh = (y1 - y0) * kd;
  if (kd >= 1) {
    // zoomed in: every image pixel becomes a crisp square, nothing is blurred or invented
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ed.full, x0, y0, x1 - x0, y1 - y0, dx, dy, dw, dh);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const useSmall = kd <= ed.ds, src = useSmall ? ed.small : ed.full, f = useSmall ? ed.ds : 1;
    ctx.drawImage(src, x0 * f, y0 * f, (x1 - x0) * f, (y1 - y0) * f, dx, dy, dw, dh);
  }
}
function schedulePaint() { if (!ed.raf) ed.raf = requestAnimationFrame(paint); }

async function openEditor(r) {
  ed.r = r; ed.steps = [];
  $("#pod-editor").hidden = false;
  document.body.style.overflow = "hidden";
  try { history.pushState({ lvEd: 1 }, ""); } catch (e) {}
  edButtons();
  edStatus("Loading…");
  const bmp = await createImageBitmap(r.blob);
  const full = document.createElement("canvas");
  full.width = bmp.width; full.height = bmp.height;
  full.getContext("2d").drawImage(bmp, 0, 0);
  ed.full = full;
  ed.ds = Math.min(1, 1600 / Math.max(full.width, full.height));
  ed.small = shrink(full, ed.ds);
  setZoom(1);
  edStatus("");
  track("use-pod-touchup");
}

function closeEditor(fromBack) {
  if ($("#pod-editor").hidden) return;
  $("#pod-editor").hidden = true;
  document.body.style.overflow = "";
  ed.full = null; ed.small = null; ed.steps = []; ed.r = null;
  if (!fromBack && history.state && history.state.lvEd) { try { history.back(); } catch (e) {} }
}

function setZoom(z) {
  ed.zoomOld = ed.zoom || 1;
  const keep = !!ed.full && z !== ed.zoom && $("#pe-sizer").style.width;
  ed.zoom = z;
  document.querySelectorAll("#pod-editor [data-z]").forEach((b) => b.classList.toggle("on", Number(b.dataset.z) === z));
  if (ed.full) layout(keep);
}

function tapErase(clientX, clientY) {
  if (!ed.full) return;
  const sc = $("#pe-scroll"), box = sc.getBoundingClientRect(), k = ed.base * ed.zoom;
  const x = Math.floor((clientX - box.left + sc.scrollLeft - ed.ox) / k);
  const y = Math.floor((clientY - box.top + sc.scrollTop - ed.oy) / k);
  if (x < 0 || y < 0 || x >= ed.full.width || y >= ed.full.height) return;
  // a finger is not a needle: look for the white spot up to ~16 screen pixels around the tap
  // (the more you zoom in, the smaller and more precise this search gets)
  const snap = Math.max(1, Math.round(16 / k));
  const step = eraseAt(ed.full, x, y, 30, snap);
  if (step.miss) { edStatus("Only white leftovers can be erased. Tap on (or right next to) a white spot."); return; }
  ed.steps.push(step);
  syncSmall(step.rect);
  paint();
  edButtons();
  edStatus("Erased. Tap Save changes when you're done.");
}

async function saveEditor() {
  const r = ed.r;
  if (!r || !ed.steps.length) return;
  $("#pe-save").disabled = true;
  edStatus("Saving PNG…");
  const raw = await new Promise((res, rej) => ed.full.toBlob((b) => (b ? res(b) : rej(new Error("This phone could not save such a big image. Try a smaller size."))), "image/png"));
  const blob = await pngWithDpi(raw, 300);
  URL.revokeObjectURL(r.url);
  r.blob = blob; r.url = URL.createObjectURL(blob); r.thumb = thumbnail(ed.full);
  showResult(r, r.li);
  edStatus("Saved ✓");
  closeEditor();
}

function initEditor() {
  const sc = $("#pe-scroll");
  let start = null;
  sc.addEventListener("scroll", schedulePaint, { passive: true });
  window.addEventListener("resize", () => { if (ed.full) { ed.zoomOld = ed.zoom; layout(true); } });
  sc.addEventListener("pointerdown", (e) => {
    start = { x: e.clientX, y: e.clientY, sx: sc.scrollLeft, sy: sc.scrollTop, mouse: e.pointerType === "mouse", lx: e.clientX, ly: e.clientY };
  });
  sc.addEventListener("pointermove", (e) => {
    if (!start || !start.mouse || !(e.buttons & 1)) return;
    // mouse: drag to move around the zoomed image
    sc.scrollLeft -= e.clientX - start.lx; sc.scrollTop -= e.clientY - start.ly;
    start.lx = e.clientX; start.ly = e.clientY;
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 10) sc.classList.add("drag");
  });
  sc.addEventListener("pointerup", (e) => {
    sc.classList.remove("drag");
    if (!start) return;
    const moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) + Math.abs(sc.scrollLeft - start.sx) + Math.abs(sc.scrollTop - start.sy);
    start = null;
    if (moved < 10) tapErase(e.clientX, e.clientY); // a tap, not a scroll
  });
  sc.addEventListener("pointercancel", () => { start = null; sc.classList.remove("drag"); });
  // mouse wheel with Ctrl (or a laptop pinch): zoom in/out
  sc.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !ed.full) return;
    e.preventDefault();
    const zs = [1, 2, 4, 8], i = zs.indexOf(ed.zoom);
    const n = zs[Math.max(0, Math.min(zs.length - 1, i + (e.deltaY < 0 ? 1 : -1)))];
    if (n !== ed.zoom) setZoom(n);
  }, { passive: false });
  document.querySelectorAll("#pod-editor [data-bg]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#pod-editor [data-bg]").forEach((x) => x.classList.toggle("on", x === b));
    $("#pe-view").className = "pe-view bg-" + b.dataset.bg;
  }));
  document.querySelectorAll("#pod-editor [data-z]").forEach((b) => b.addEventListener("click", () => setZoom(Number(b.dataset.z))));
  $("#pe-undo").addEventListener("click", () => {
    const step = ed.steps.pop();
    if (!step) return;
    undoErase(ed.full, step);
    syncSmall(step.rect);
    paint();
    edButtons();
    edStatus("");
  });
  $("#pe-save").addEventListener("click", () => saveEditor().catch((e) => { edStatus(e.message || "Something went wrong."); $("#pe-save").disabled = false; }));
  $("#pe-cancel").addEventListener("click", () => closeEditor());
  $("#pe-close").addEventListener("click", () => closeEditor());
  // phone back button inside the editor: close the editor, stay on the page
  window.addEventListener("popstate", () => { if (!$("#pod-editor").hidden) closeEditor(true); });
  // leaving with finished designs that would be lost: the browser asks first
  window.addEventListener("beforeunload", (e) => {
    if (state.results && state.results.some((r) => !r.error)) { e.preventDefault(); e.returnValue = ""; }
  });
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
  const q = store("lampyva-pod-quality"); if (q) $("#pod-quality").value = q;
  $("#pod-quality").addEventListener("change", () => store("lampyva-pod-quality", $("#pod-quality").value));
  // white holes option (remembered on this device)
  $("#pod-holes").checked = store("lampyva-pod-holes") === "1";
  const hs = store("lampyva-pod-holesize"); if (hs) $("#pod-holesize").value = hs;
  $("#pod-bg").addEventListener("change", refreshOptions);
  $("#pod-holes").addEventListener("change", () => { store("lampyva-pod-holes", $("#pod-holes").checked ? "1" : "0"); refreshOptions(); });
  $("#pod-holesize").addEventListener("input", () => { store("lampyva-pod-holesize", $("#pod-holesize").value); refreshOptions(); });
  $("#pod-poster").addEventListener("change", () => { store("lampyva-pod-poster", $("#pod-poster").value); refreshPoster(); });
  const pv = store("lampyva-pod-poster"); if (pv) $("#pod-poster").value = pv;
  const pc = store("lampyva-pod-postercolor"); if (pc) $("#pod-postercolor").value = pc;
  $("#pod-postercolor").addEventListener("change", () => store("lampyva-pod-postercolor", $("#pod-postercolor").value));
  const pin = store("lampyva-pod-pincolor"); if (pin) $("#pod-pincolor").value = pin;
  $("#pod-pincolor").addEventListener("change", () => store("lampyva-pod-pincolor", $("#pod-pincolor").value));
  $("#pod-pins").addEventListener("click", () => makePromos("pin"));
  $("#pod-mockups").addEventListener("click", () => makePromos("mockup"));
  notifySwitch(document.querySelector("#pod-run").parentElement);
  initEditor();
  $("#pod-run").addEventListener("click", run);
  $("#pod-zip").addEventListener("click", downloadZip);
  $("#pod-clear").addEventListener("click", () => { state.files = []; renderFiles(); clearResults(); $("#pod-status").textContent = ""; });
  renderFiles();
  refreshOptions();
}

init();
