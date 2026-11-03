// Lampyva — automatic check ("robot").
// Uses the site like real visitors do: real phone-size photos, long file names, 2x and 4x,
// every tool, and a second "phone" without graphics acceleration to prove that plan B works.
// Usage: BASE=https://truxz78-png.github.io/lampyva/ node tests/monitor.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = (process.env.BASE || "http://localhost:8765/").replace(/\/?$/, "/");
const HERE = dirname(fileURLToPath(import.meta.url));
const T = (f) => join(HERE, f);
const PHONE_PHOTO = T("IMG_20261024_173512_foto_de_telefono_con_un_nombre_muy_largo.jpg"); // 1888×2272
const SMALL = T("sample.png");        // 48×48 logo
const PRODUCT = T("sample-photo.jpg"); // 150×200 product photo
const DESIGN = T("sample-design.png"); // 1024×1229 drawing on white, like a Gemini image
const SPECKS = T("sample-specks.png"); // text design with almost invisible gray scratches near the edges, like Gemini
const HOLES = T("sample-holes.png");   // 320×320 drawing with white gaps closed between stems + a tiny eye highlight
const WIDTH = 360;                     // small phone

const problems = [], warnings = [], ok = [];
const pageErrors = [];

async function step(name, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    ok.push(`${name}${r ? " — " + r : ""} (${Math.round((Date.now() - t) / 1000)} s)`);
  } catch (e) {
    problems.push(`${name}: ${String(e.message).split("\n")[0]}`);
  }
}

async function openPhone(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // the robot's own visits must not count in the statistics
  await ctx.route("https://script.google.com/**", (r) => r.fulfill({ body: "ok" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
  // security policy: Lampyva's own code must never be blocked by it
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) pageErrors.push(`${label}: seguridad bloqueó algo propio: ${m.text().slice(0, 160)}`); });
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  // the robot scrolls instantly (smooth scrolling makes automatic clicks wait for moving buttons)
  await page.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
  for (const s of ["#cv-format option", "#up-format option", "#bg-format option"])
    await page.waitForSelector(s, { state: "attached", timeout: 30000 });
  return { ctx, page };
}

async function noOverflow(page, where) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > WIDTH) throw new Error(`${where}: la página se sale de la pantalla (${w}px de ancho en un teléfono de ${WIDTH}px)`);
}

/** Run one tool and wait for it to finish. Returns the status text and the result lines. */
async function useTool(page, prefix, files, options = {}, timeout = 300000) {
  await page.evaluate((p) => document.querySelector(`#${p}-clear`).click(), prefix);
  // set options like a visitor would (hidden options, e.g. AI settings on phones without AI, are set silently)
  await page.evaluate((o) => {
    for (const [sel, val] of Object.entries(o)) {
      const el = document.querySelector(sel);
      el.value = val;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, options);
  await page.setInputFiles(`#${prefix}-input`, files);
  await noOverflow(page, "lista de archivos");
  await page.click(`#${prefix}-run`);
  await page.waitForFunction((p) => /Done|No images|No files|No designs/.test(document.querySelector(`#${p}-status`).textContent), prefix, { timeout });
  await noOverflow(page, "resultados");
  return {
    status: await page.textContent(`#${prefix}-status`),
    lines: await page.$$eval(`#${prefix}-results li`, (l) => l.map((x) => x.textContent)),
  };
}

/** Check a background-removal result: subject kept (center opaque), background gone (corners clear). */
async function checkCutout(page) {
  const r = await page.evaluate(async () => {
    const a = document.querySelector("#bg-results li a");
    if (!a) return null;
    const img = new Image(); img.src = a.href; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const at = (x, y) => g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
    const W = img.width, H = img.height;
    return { center: at(W / 2, H * 0.55), corners: [at(2, 2), at(W - 3, 2), at(2, H - 3), at(W - 3, H - 3)] };
  });
  if (!r) throw new Error("no hay imagen de resultado");
  if (r.center < 200) throw new Error(`borró también el objeto (centro con opacidad ${r.center}/255)`);
  if (Math.max(...r.corners) > 60) throw new Error(`no quitó el fondo (esquinas con opacidad ${r.corners.join(", ")})`);
  return r;
}


/** Check a print-ready file: exact size, 300 DPI inside the PNG, transparent corners, design kept. */
async function checkPrintFile(page, W, H) {
  const r = await page.evaluate(async () => {
    const a = document.querySelector("#pod-results li a");
    if (!a) return null;
    const bytes = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    const head = String.fromCharCode(...bytes.subarray(0, 200));
    const img = new Image(); img.src = a.href; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, dpi: head.includes("pHYs"),
      corner: g.getImageData(3, 3, 1, 1).data[3], center: g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data[3] };
  });
  if (!r) throw new Error("no hay archivo de resultado");
  if (r.w !== W || r.h !== H) throw new Error(`tamaño ${r.w}×${r.h}, se esperaba ${W}×${H}`);
  if (!r.dpi) throw new Error("el PNG no tiene la información de 300 DPI");
  if (r.corner > 10) throw new Error("las esquinas no son transparentes");
  if (r.center < 200) throw new Error("se perdió el diseño");
}

const FILES = [
  "", "privacy.html", "terms.html", "style.css", "config.js",
  "js/site.js", "js/converter.js", "js/upscale-ui.js", "js/upscaler.js", "js/bg-ui.js", "js/bgremover.js",
  "js/formats.js", "js/encoders.js", "js/zip.js", "js/pod.js", "js/pod-ui.js", "js/pod-core.js", "js/pod-worker.js", "js/breathe.js", "js/promo.js", "sw.js", "js/compare-zoom.js", "js/i18n.js", "js/scroll-nav.js", "lang/es.json", "lang/ja.json", "lang/ar.json",
  "vendor/qrcode.js", "vendor/UTIF.js", "vendor/heic2any.min.js",
  "models/models.json", "models/photo-x2.bin", "models/photo-x2-noise1.bin", "models/photo-x2-noise2.bin",
  "models/art-x2.bin", "models/art-x2-noise1.bin", "models/art-x2-noise2.bin",
  "models/u2netp.json", "models/u2netp.bin",
  "assets/icon.svg", "assets/icon-32.png", "assets/icon-180.png", "assets/share.png",
];

/* ================= Phone 1: normal phone (with graphics acceleration) ================= */
const gpuBrowser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const { ctx, page } = await openPhone(gpuBrowser, "teléfono normal");

await step("Archivos del sitio disponibles", async () => {
  const bad = [];
  for (const f of FILES) {
    const r = await ctx.request.get(BASE + f);
    if (r.status() !== 200) bad.push(`${f || "index.html"} (${r.status()})`);
  }
  if (bad.length) throw new Error("No cargan: " + bad.join(", "));
  return `${FILES.length} archivos`;
});

await step("Página principal abre en un teléfono de 360 px", async () => {
  if (!/Lampyva/.test(await page.title())) throw new Error("título inesperado");
  await noOverflow(page, "inicio");
});

await step("Convertir: foto de teléfono a JPG, WebP, PDF, GIF e ICO", async () => {
  const done = [];
  for (const f of ["jpg", "webp", "pdf", "gif", "ico"]) {
    const r = await useTool(page, "cv", [PHONE_PHOTO], { "#cv-format": f }, 120000);
    if (!/Done/.test(r.status)) throw new Error(`${f}: ${r.status} ${r.lines.join(" ")}`);
    done.push(f.toUpperCase());
  }
  return done.join(", ");
});

await step("Quitar un solo resultado (✕) sin borrar los demás", async () => {
  await useTool(page, "cv", [SMALL, PHONE_PHOTO], { "#cv-format": "png" }, 120000);
  const count = () => page.evaluate(() => [document.querySelectorAll("#cv-results li").length, document.querySelectorAll("#cv-files li").length]);
  const [r0, f0] = await count();
  if (r0 !== 2 || f0 !== 2) throw new Error(`esperaba 2 resultados, hay ${r0}/${f0}`);
  await page.click("#cv-results li:first-child .res-x");
  const [r1, f1] = await count();
  if (r1 !== 1 || f1 !== 1) throw new Error(`después de quitar uno quedan ${r1} resultados y ${f1} archivos`);
  await page.click("#cv-results li .res-x");
  if (!(await page.isHidden("#cv-results-box"))) throw new Error("la caja de resultados no se ocultó al quitar todo");
  return "quedó 1 de 2, luego 0";
});

await step("Agrandar con IA: logo pequeño 2x", async () => {
  const r = await useTool(page, "up", [SMALL], { "#up-scale": "2", "#up-type": "art" });
  if (!/Done/.test(r.status) || !/96×96/.test(r.lines[0])) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  const eng = await page.evaluate(() => document.body.dataset.upscaleEngine);
  if (eng !== "ai") warnings.push("Agrandar: la IA no funcionó en el teléfono normal y se usó el plan B.");
  return eng === "ai" ? "con IA" : "con plan B";
});

await step("Lupa del comparador (4×, mover y volver)", async () => {
  await page.$eval("#up-compare", (e) => e.scrollIntoView());
  await page.click("#up-compare + * .zoom-bar button[data-z='4'], #up-compare .zoom-bar button[data-z='4']");
  const t = await page.$eval("#up-after", (e) => e.style.transform);
  if (!/scale\(4\)/.test(t)) throw new Error("la lupa no amplía: " + t);
  const same = await page.evaluate(() => document.querySelector("#up-after").style.transform === document.querySelector("#up-before").style.transform);
  if (!same) throw new Error("el antes y el después no quedan alineados");
  await page.click("#up-compare .zoom-bar button[data-z='1']");
  await noOverflow(page, "lupa");
});

await step("Agrandar con IA: logo pequeño 4x", async () => {
  const r = await useTool(page, "up", [SMALL], { "#up-scale": "4", "#up-type": "art" });
  if (!/Done/.test(r.status) || !/192×192/.test(r.lines[0])) throw new Error(`${r.status} ${r.lines.join(" ")}`);
});

await step("Quitar fondo: foto de producto", async () => {
  const r = await useTool(page, "bg", [PRODUCT], { "#bg-fill": "none", "#bg-format": "png" });
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  await checkCutout(page);
  const eng = await page.evaluate(() => document.body.dataset.bgEngine);
  if (eng !== "gpu") warnings.push("Quitar fondo: la aceleración gráfica falló en el teléfono normal y se usó el plan B.");
  return eng === "gpu" ? "objeto conservado y fondo quitado" : "con plan B";
});

await step("Print on demand con IA: logo pequeño → Amazon Merch 4500×5400", async () => {
  const r = await useTool(page, "pod", [SMALL], { "#pod-preset": "amazon-tee", "#pod-bg": "keep", "#pod-type": "art", "#pod-quality": "best" });
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  const eng = await page.evaluate(() => document.body.dataset.podEngine);
  if (eng !== "ai") warnings.push("Print on demand: la IA no funcionó en el teléfono normal y se usó el plan B.");
  const ok2 = await page.evaluate(() => { const a = document.querySelector("#pod-results li .cv-size"); return a && /4500×5400/.test(a.textContent); });
  if (!ok2) throw new Error("tamaño incorrecto");
  return eng === "ai" ? "con IA" : "con plan B";
});

await step("Print on demand rápido (sin IA): dibujo de Gemini → 5000×6000 en segundos", async () => {
  const t0 = Date.now();
  const r = await useTool(page, "pod", [DESIGN], { "#pod-preset": "universal", "#pod-bg": "white", "#pod-type": "art", "#pod-quality": "fast" }, 120000);
  await page.evaluate(() => { const s = document.querySelector("#pod-quality"); s.value = "best"; s.dispatchEvent(new Event("change")); });
  if (!/Done/.test(r.status)) throw new Error(r.status);
  await checkPrintFile(page, 5000, 6000);
  const s = Math.round((Date.now() - t0) / 1000);
  return `5000×6000 en ${s} s`;
});

await step("Print on demand: varias medidas a la vez, Spreadshop, Displate con color, nombre, puntitos sueltos, pines y camisetas", async () => {
  const setExtras = (ids) => page.evaluate((ids) => {
    document.querySelectorAll("#pod-extra input").forEach((i) => { i.checked = ids.includes(i.value); i.dispatchEvent(new Event("change")); });
  }, ids);
  await page.evaluate(() => { const s = document.querySelector("#pod-poster"); s.value = "fit"; s.dispatchEvent(new Event("change")); const c = document.querySelector("#pod-postercolor"); c.value = "#f5ebdd"; c.dispatchEvent(new Event("change")); });
  try {
    await page.evaluate(() => { document.querySelector("#pod-preset").value = "universal"; document.querySelector("#pod-preset").dispatchEvent(new Event("change")); });
    await setExtras(["spreadshirt", "displate"]);
    await page.fill("#pod-prefix", "C01 prueba");
    const r = await useTool(page, "pod", [SPECKS], { "#pod-preset": "universal", "#pod-bg": "white-all", "#pod-type": "art", "#pod-quality": "fast" }, 180000);
    if (!/Done/.test(r.status)) throw new Error(r.status);
    const files = await page.evaluate(async () => Promise.all([...document.querySelectorAll("#pod-results li")].map(async (li) => {
      const a = li.querySelector("a");
      const blob = await (await fetch(a.href)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, x1 = -1;
      for (let y = 0; y < c.height; y += 4) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      return { name: a.download, w: c.width, h: c.height, size: blob.size, corner: [...d.subarray(0, 4)], x0, x1 };
    })));
    const names = files.map((f) => f.name).join(", ");
    const want = ["C01-prueba-universal-5000x6000", "C01-prueba-spreadshirt-3334x4000", "C01-prueba-displate-2900x4060"];
    for (const w of want) if (!files.some((f) => f.name.startsWith(w) && f.name.endsWith(".png"))) throw new Error("faltan medidas o nombres: " + names);
    const sp = files.find((f) => f.name.includes("spreadshirt"));
    if (sp.w !== 3334 || sp.h !== 4000) throw new Error(`Spreadshop ${sp.w}×${sp.h}`);
    if (sp.size > 10 * 1000 * 1000) throw new Error("Spreadshop pasa de 10 MB");
    const dp = files.find((f) => f.name.includes("displate"));
    if (dp.corner[3] < 250 || Math.abs(dp.corner[0] - 245) > 3 || Math.abs(dp.corner[2] - 221) > 3) throw new Error("Displate sin el color de fondo elegido: " + dp.corner);
    const un = files.find((f) => f.name.includes("universal"));
    // the gray specks near the edges must not make the crop bigger: the text fills the width (4% margin = 200 px)
    // (the smart crop keeps a small safety margin, like the Termux recipe: ~60 px each side)
    if (un.x0 > 330 || un.x1 < 4670) throw new Error(`los puntitos sueltos achicaron el diseño (x ${un.x0}–${un.x1})`);
    if (!/^Done! 1 design /.test(r.status)) throw new Error("cuenta de diseños: " + r.status);
    await page.fill("#pod-pintitle", "Cozy test");
    await page.click("#pod-pins");
    await page.waitForFunction(() => document.querySelectorAll("#pod-promo-list li").length >= 1, null, { timeout: 60000 });
    await page.click("#pod-mockups");
    await page.waitForFunction(() => document.querySelectorAll("#pod-promo-list li").length >= 2, null, { timeout: 60000 });
    const promo = await page.$$eval("#pod-promo-list li .cv-size", (l) => l.map((x) => x.textContent));
    if (!/1000×1500/.test(promo[0]) || !/2000×1200/.test(promo[1])) throw new Error("pin o camiseta con tamaño incorrecto: " + promo.join(" / "));
    await noOverflow(page, "pines y camisetas");
    return `3 medidas (${files.map((f) => f.w + "×" + f.h).join(", ")}), Spreadshop ${(sp.size / 1e6).toFixed(1)} MB, pin y camiseta`;
  } finally {
    await setExtras([]);
    await page.fill("#pod-prefix", "");
    await page.evaluate(() => { const s = document.querySelector("#pod-quality"); s.value = "best"; s.dispatchEvent(new Event("change")); });
  }
});

await step("Print on demand: huecos blancos encerrados y retoque tocando para borrar", async () => {
  const opts = { "#pod-preset": "custom", "#pod-w": "300", "#pod-h": "300", "#pod-bg": "white", "#pod-type": "art" };
  const setHoles = (on) => page.evaluate((on) => { const c = document.querySelector("#pod-holes"); c.checked = on; c.dispatchEvent(new Event("change")); }, on);
  const whitePx = () => page.evaluate(async () => {
    const a = document.querySelector("#pod-results li a");
    const bmp = await createImageBitmap(await (await fetch(a.href)).blob());
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) n++;
    return n;
  });
  // 1) without the option the closed white gaps stay
  await setHoles(false);
  let r = await useTool(page, "pod", [HOLES], opts);
  if (!/Done/.test(r.status)) throw new Error(r.status);
  const before = await whitePx();
  if (before < 1000) throw new Error("la prueba no tiene huecos blancos (" + before + ")");
  // 2) touch-up editor: tap a white spot → transparent, undo → back, save → smaller white area
  await page.click("#pod-results .pod-edit");
  await page.waitForFunction(() => !document.querySelector("#pod-editor").hidden && document.querySelector("#pe-status").textContent === "", null, { timeout: 30000 });
  const pt = await page.evaluate(() => {
    const c = document.querySelector("#pe-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 250 && d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) {
        c.scrollIntoView({ block: "center" }); const b = c.getBoundingClientRect();
        return { x, y, cx: b.left + ((x + 0.5) / c.width) * b.width, cy: b.top + ((y + 0.5) / c.height) * b.height };
      }
    }
    return null;
  });
  if (!pt) throw new Error("el editor no muestra el diseño");
  const alpha = () => page.evaluate((pt) => document.querySelector("#pe-canvas").getContext("2d").getImageData(pt.x, pt.y, 1, 1).data[3], pt);
  const tap = async () => { await page.mouse.move(pt.cx, pt.cy); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(300); };
  // tapping a dark outline must NEVER erase it (it once erased all the connected outlines)
  const dark = await page.evaluate(() => {
    const c = document.querySelector("#pe-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 250 && d[i] < 90 && d[i + 1] < 70 && d[i + 2] < 60) {
        // only pixels in the middle of a thick outline (no white within 8 px)
        let ok = true;
        for (let k = -8; k <= 8 && ok; k++) for (const [xx, yy] of [[x + k, y], [x, y + k]]) {
          const j = (yy * c.width + xx) * 4; if (d[j] > 200 && d[j + 3] > 200) ok = false;
        }
        if (!ok) continue;
        const b = c.getBoundingClientRect();
        return { x, y, cx: b.left + ((x + 0.5) / c.width) * b.width, cy: b.top + ((y + 0.5) / c.height) * b.height };
      }
    }
    return null;
  });
  if (dark) {
    const outlineBefore = await page.evaluate((p) => document.querySelector("#pe-canvas").getContext("2d").getImageData(p.x, p.y, 1, 1).data[3], dark);
    await page.mouse.move(dark.cx, dark.cy); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(300);
    const outlineAfter = await page.evaluate((p) => document.querySelector("#pe-canvas").getContext("2d").getImageData(p.x, p.y, 1, 1).data[3], dark);
    if (outlineAfter !== outlineBefore) throw new Error("tocar un contorno oscuro lo borró (solo debe borrar restos blancos)");
    // the finger search may have found a white spot right next to the outline: put it back before going on
    while (!(await page.isDisabled("#pe-undo"))) await page.click("#pe-undo");
  }
  await tap();
  if ((await alpha()) !== 0) throw new Error("tocar para borrar no volvió transparente la zona blanca");
  await page.click("#pe-undo");
  if ((await alpha()) < 250) throw new Error("deshacer no devolvió la zona");
  await tap();
  await page.click("#pe-save");
  await page.waitForFunction(() => document.querySelector("#pod-editor").hidden, null, { timeout: 60000 });
  const edited = await whitePx();
  if (!(edited < before)) throw new Error("al guardar no se aplicó el retoque");
  const dpi = await page.evaluate(async () => { const b = await (await fetch(document.querySelector("#pod-results li a").href)).blob(); return String.fromCharCode(...new Uint8Array(await b.slice(0, 80).arrayBuffer())).includes("pHYs"); });
  if (!dpi) throw new Error("el PNG retocado perdió los 300 DPI");
  // 2b) 8× zoom shows real, sharp pixels; the phone's back button closes the editor and stays on Lampyva
  await page.click("#pod-results .pod-edit");
  await page.waitForFunction(() => !document.querySelector("#pod-editor").hidden && document.querySelector("#pe-status").textContent === "", null, { timeout: 30000 });
  await page.click("#pod-editor [data-z='8']");
  await page.waitForTimeout(200);
  const z8 = await page.evaluate(() => ({
    ratio: document.querySelector("#pe-sizer").offsetWidth / document.querySelector("#pe-view").clientWidth,
    smooth: document.querySelector("#pe-canvas").getContext("2d").imageSmoothingEnabled,
    painted: (() => { const c = document.querySelector("#pe-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++; return n; })(),
  }));
  if (z8.ratio < 4) throw new Error("el zoom 8× no amplía (" + z8.ratio.toFixed(1) + "×)");
  if (z8.smooth) throw new Error("el zoom 8× se ve borroso (debe mostrar píxeles nítidos)");
  if (!z8.painted) throw new Error("el zoom 8× se ve vacío");
  const urlBefore = page.url();
  await page.goBack().catch(() => {});
  await page.waitForFunction(() => document.querySelector("#pod-editor").hidden, null, { timeout: 5000 });
  if (page.url() !== urlBefore || !(await page.$("#pod-results li a"))) throw new Error("el botón atrás sacó al visitante de la página");
  if (!(await page.$("#pod-results li .pod-prev img"))) throw new Error("no se ve la vista previa final grande");
  // 3) with the option the closed white gaps go, the tiny eye highlight stays
  await setHoles(true);
  r = await useTool(page, "pod", [HOLES], opts);
  if (!/Done/.test(r.status)) throw new Error(r.status);
  const after = await whitePx();
  await setHoles(false);
  if (after > 200) throw new Error("quedaron huecos blancos encerrados (" + after + " píxeles blancos)"); // ~80 = the round highlight that must stay
  if (after < 1) throw new Error("se borró también el brillo pequeño del ojo");
  return `huecos: ${before} → ${after} píxeles blancos; retoque y deshacer funcionan`;
});

await step("Casilla 🔔 Avisarme cuando esté listo: se marca o explica cómo permitir avisos", async () => {
  const label = page.locator("#pod-run").locator("xpath=../following-sibling::label[contains(@class,'notify-switch')]");
  if (!(await label.count())) throw new Error("no aparece la casilla de aviso");
  await label.locator("input").click();
  await page.waitForTimeout(800);
  const checked = await label.locator("input").isChecked();
  const noteShown = await label.locator("xpath=following-sibling::p[1]").evaluate((n) => !n.hidden && n.textContent.length > 20);
  if (!checked && !noteShown) throw new Error("la casilla no se marca y no explica por qué");
  if (checked) await label.locator("input").click();
  return checked ? "se marca" : "el navegador no permite avisos: muestra cómo permitirlos";
});

await step("Botones de arriba: un solo toque baja directo a cada sección (sin subir y bajar)", async () => {
  const done = [];
  for (const id of ["convert", "upscale", "remove-bg", "pod"]) {
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(400);
    const ys = [];
    await page.click(`.hero a[href="#${id}"]`);
    for (let i = 0; i < 22; i++) { ys.push(await page.evaluate(() => scrollY)); await page.waitForTimeout(80); }
    const top = await page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top, id);
    if (top < 40 || top > 120) throw new Error(`${id}: con un toque quedó en ${Math.round(top)} px (debía llegar al título)`);
    for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1] - 5) throw new Error(`${id}: subió y bajó (${ys.join(",")})`);
    done.push(id);
  }
  await page.click(".sn-up");
  await page.waitForTimeout(1500);
  if ((await page.evaluate(() => scrollY)) > 5) throw new Error("la flecha ↑ no volvió al inicio");
  return done.join(", ") + " + ↑ al inicio";
});

await step("Flechas ↑ ↓, barra de arriba fija y botón atrás", async () => {
  const pg = await ctx.newPage();
  await pg.goto("about:blank");
  await pg.goto(BASE, { waitUntil: "load" });
  // at the very top the arrows step aside (the main buttons are there); a little lower they come back
  if (!(await pg.evaluate(() => document.querySelector(".scroll-nav").classList.contains("away")))) throw new Error("las flechas tapan los botones principales arriba");
  await pg.evaluate(() => window.scrollTo({ top: 700, behavior: "instant" }));
  await pg.waitForTimeout(500);
  await pg.click(".sn-down");
  await pg.waitForTimeout(1200);
  await pg.evaluate(() => window.scrollTo({ top: 3000, behavior: "instant" }));
  await pg.waitForTimeout(400);
  const st = await pg.evaluate(() => ({
    up: document.querySelector(".sn-up").classList.contains("show"),
    header: document.querySelector("header").getBoundingClientRect().top,
  }));
  if (!st.up) throw new Error("no aparece la flecha ↑ al bajar");
  if (Math.abs(st.header) > 2) throw new Error("la barra de arriba no se queda fija al bajar");
  await pg.goBack();
  await pg.waitForTimeout(2000);
  if (!pg.url().startsWith(BASE)) throw new Error("el botón atrás sacó al visitante de la página en vez de subir");
  const y = await pg.evaluate(() => window.scrollY);
  if (y > 50) throw new Error("el botón atrás no subió al inicio");
  await pg.goBack();
  await pg.waitForTimeout(800);
  if (pg.url().startsWith(BASE)) throw new Error("estando arriba, atrás no deja salir (trampa)");
  await pg.close();
});

await step("Sección de donar y buzón de ideas", async () => {
  if (!(await page.locator("#don-paypal").count())) throw new Error("falta la opción de PayPal");
  const mail = await page.getAttribute("[data-contact]", "href");
  if (!/^mailto:/.test(mail || "")) throw new Error("el enlace de contacto no funciona");
  await noOverflow(page, "donar");
});

for (const p of ["privacy.html", "terms.html"]) {
  await step(`Página legal ${p}`, async () => {
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => pageErrors.push(`${p}: ${e.message}`));
    const r = await pg.goto(BASE + p, { timeout: 60000 });
    if (r.status() !== 200) throw new Error("estado " + r.status());
    await pg.close();
  });
}
await step("Idiomas: visitante en español (traducción revisada, nombres de archivo y marcas intactos)", async () => {
  const c = await gpuBrowser.newContext({ viewport: { width: WIDTH, height: 780 }, locale: "es-ES" });
  await c.route("https://script.google.com/**", (r) => r.fulfill({ body: "ok" }));
  // the automatic translator must NOT be needed: every text has a reviewed translation (lang/es.json)
  const machine = [];
  await c.route("https://translate.googleapis.com/**", (r) => {
    const q = new URL(r.request().url()).searchParams.get("q");
    machine.push(q);
    r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify([[["ES " + q, q, null, null, 1]], null, "en"]) });
  });
  const pg = await c.newPage();
  pg.on("pageerror", (e) => pageErrors.push(`idiomas: ${e.message}`));
  await pg.goto(BASE, { waitUntil: "load" });
  await pg.waitForFunction(() => /Dale a tus imágenes/.test(document.querySelector("h1").textContent), null, { timeout: 20000 });
  await pg.setInputFiles("#cv-input", PHONE_PHOTO);
  await pg.waitForTimeout(800);
  const name = await pg.textContent("#cv-files .cv-name");
  if (!/^IMG_20261024/.test(name)) throw new Error("tradujo el nombre del archivo: " + name);
  if ((await pg.textContent(".brand")).trim() !== "Lampyva") throw new Error("tradujo la marca Lampyva");
  if (machine.length) throw new Error("textos sin traducción revisada (usaron el traductor automático): " + machine.slice(0, 5).join(" | "));
  await noOverflow(pg, "página traducida");
  // the header must not overlap with long words (Russian "Пожертвовать" is a long one)
  const hdr = await pg.evaluate(() => {
    document.querySelector("nav .btn-donate").textContent = "Пожертвовать";
    const g = (s) => document.querySelector(s).getBoundingClientRect();
    const a = g(".brand"), l = g(".lang"), d = g("nav .btn-donate");
    return a.right <= l.left + 1 && l.right <= d.left + 1 && d.right <= innerWidth;
  });
  if (!hdr) throw new Error("los botones de arriba se montan uno encima del otro con palabras largas");
  await pg.selectOption("#lang-pick", "en");
  await pg.waitForFunction(() => document.querySelector("h1").textContent === "Give your images new light", null, { timeout: 5000 });
  await c.close();
  return "traducción revisada, no toca archivos ni marcas, vuelve a inglés";
});

await step("Idiomas: los 24 idiomas tienen traducción revisada completa y se ven bien", async () => {
  const LANGS = ["es", "pt", "fr", "de", "it", "nl", "pl", "ru", "uk", "tr", "ar", "hi", "bn", "id", "vi", "th", "tl", "zh-CN", "zh-TW", "ja", "ko", "he", "fa", "sw"];
  const bad = [];
  for (const L of LANGS) {
    const c = await gpuBrowser.newContext({ viewport: { width: WIDTH, height: 780 } });
    await c.addInitScript((l) => { try { localStorage.setItem("lampyva-lang", l); } catch (e) {} }, L);
    await c.route("https://script.google.com/**", (r) => r.fulfill({ body: "ok" }));
    const machine = [];
    await c.route("https://translate.googleapis.com/**", (r) => { machine.push(new URL(r.request().url()).searchParams.get("q")); r.abort(); });
    const pg = await c.newPage();
    pg.on("pageerror", (e) => pageErrors.push(`idioma ${L}: ${e.message}`));
    for (const p of ["", "privacy.html", "terms.html"]) {
      await pg.goto(BASE + p, { waitUntil: "load" });
      await pg.waitForTimeout(1500);
      const st = await pg.evaluate(() => {
        const W = innerWidth, out = [];
        if (document.documentElement.scrollWidth > W + 1) out.push("la página se sale de la pantalla");
        const boxes = [".brand", ".lang", "nav .btn-donate"].map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
        for (let i = 0; i < boxes.length; i++) {
          if (boxes[i].left < -1 || boxes[i].right > W + 1) out.push("botón de arriba fuera de la pantalla");
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push("botones de arriba montados");
          }
        }
        return out;
      });
      if (st.length) bad.push(`${L} ${p || "inicio"}: ${[...new Set(st)].join(", ")}`);
    }
    if (machine.length) bad.push(`${L}: ${machine.length} textos sin traducción revisada (ej.: "${machine[0]}")`);
    await c.close();
  }
  if (bad.length) throw new Error(bad.join(" | "));
  return `${LANGS.length} idiomas × 3 páginas`;
});

/* Control de calidad de la navegación, como un cliente real: con el dedo, en un teléfono, en los 24 idiomas.
   Un toque en cada botón de arriba debe bajar directo al título de su sección (sin subir y bajar, sin segundo toque),
   la flecha ↑ debe volver al inicio y la flecha ↓ debe ir sección por sección. */
async function navCheck(L) {
  const c = await gpuBrowser.newContext({ viewport: { width: WIDTH, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await c.addInitScript((l) => { try { localStorage.setItem("lampyva-lang", l); } catch (e) {} }, L);
  await c.route("https://script.google.com/**", (r) => r.fulfill({ body: "ok" }));
  await c.route("https://translate.googleapis.com/**", (r) => r.abort());
  const pg = await c.newPage();
  const bad = [];
  try {
    await pg.goto(BASE, { waitUntil: "load" });
    await pg.waitForTimeout(600);
    const cdp = await c.newCDPSession(pg);
    const drag = async (dy) => { // a finger swipe
      const x = 180, y0 = dy < 0 ? 650 : 130;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (dy * i) / 10 }] }); await pg.waitForTimeout(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await pg.waitForTimeout(200);
    };
    const tap = async (sel) => { const bb = await (await pg.$(sel)).boundingBox(); await pg.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); };
    const ys = async () => { const o = []; for (let i = 0; i < 20; i++) { o.push(await pg.evaluate(() => scrollY)); await pg.waitForTimeout(90); } return o; };
    const titleTop = (id) => pg.evaluate((id) => document.getElementById(id).getBoundingClientRect().top, id);
    // the 4 main buttons: all fully on the first screen, and no floating arrow on top of them
    const vis = await pg.evaluate(() => {
      const out = [], H = innerHeight;
      const arrows = [...document.querySelectorAll(".scroll-nav button")].filter((b) => getComputedStyle(b).visibility === "visible" && getComputedStyle(b).opacity !== "0").map((b) => b.getBoundingClientRect());
      for (const a of document.querySelectorAll(".hero .actions a")) {
        const r = a.getBoundingClientRect();
        if (r.bottom > H - 16) out.push(`"${a.textContent.trim()}" queda fuera de la primera pantalla`);
        if (arrows.some((b) => b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom)) out.push(`una flecha tapa "${a.textContent.trim()}"`);
      }
      return out;
    });
    bad.push(...vis);
    const hist0 = await pg.evaluate(() => history.length);
    for (const id of ["convert", "upscale", "remove-bg", "pod", "convert"]) {
      for (let k = 0; k < 30 && (await pg.evaluate(() => scrollY)) > 0; k++) await drag(520); // back to the top by hand
      await pg.waitForTimeout(500);
      await tap(`.hero a[href="#${id}"]`);
      const y = await ys();
      const t = await titleTop(id);
      if (t < 40 || t > 130) bad.push(`${id}: un toque dejó el título a ${Math.round(t)} px`);
      for (let i = 1; i < y.length; i++) if (y[i] < y[i - 1] - 5) { bad.push(`${id}: subió y bajó`); break; }
    }
    if ((await pg.evaluate(() => history.length)) > hist0 + 1) bad.push("los botones llenan el historial (el botón atrás fallaría)");
    await tap(".sn-up"); await pg.waitForTimeout(1600);
    if ((await pg.evaluate(() => scrollY)) > 5) bad.push("↑ no volvió al inicio");
    // ↓ goes one section at a time, always down, each time to a section title
    await drag(-450); await pg.waitForTimeout(600); // past the main buttons: the arrows come back
    let prev = await pg.evaluate(() => scrollY);
    for (let k = 0; k < 4; k++) {
      await tap(".sn-down"); await pg.waitForTimeout(1600);
      const y = await pg.evaluate(() => scrollY);
      if (y <= prev) { bad.push(`↓ no bajó (paso ${k + 1})`); break; }
      const ok = await pg.evaluate(() => [...document.querySelectorAll("main > section")].some((s) => { const t = s.getBoundingClientRect().top; return t > 40 && t < 130; }));
      if (!ok) bad.push(`↓ paso ${k + 1}: no quedó en el título de una sección`);
      prev = y;
    }
  } finally { await c.close(); }
  return bad;
}

await step("Navegación con el dedo en los 24 idiomas: botones de arriba (un toque), ↑ y ↓", async () => {
  const LANGS = ["en", "es", "pt", "fr", "de", "it", "nl", "pl", "ru", "uk", "tr", "ar", "hi", "bn", "id", "vi", "th", "tl", "zh-CN", "zh-TW", "ja", "ko", "he", "fa", "sw"];
  const bad = [];
  for (const L of LANGS) for (const b of await navCheck(L)) bad.push(`${L}: ${b}`);
  if (bad.length) throw new Error(bad.slice(0, 8).join(" | "));
  return `${LANGS.length} idiomas OK`;
});

await step("Versión: el teléfono siempre usa la última versión publicada", async () => {
  const v = await page.evaluate(async () => {
    const meta = document.querySelector('meta[name="lampyva-version"]').content;
    const j = await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json();
    const old = [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map((e) => e.getAttribute("src") || e.getAttribute("href")).filter((u) => !/^https?:/.test(u) && !u.endsWith("?v=" + meta));
    return { meta, file: j.v, old };
  });
  if (v.meta !== v.file) throw new Error(`index.html dice ${v.meta} pero version.json dice ${v.file}`);
  if (v.old.length) throw new Error("archivos sin ?v=: " + v.old.join(", "));
  // a phone with an old copy open: it updates itself, or offers "Update" if the visitor has work open
  const c = await gpuBrowser.newContext({ viewport: { width: WIDTH, height: 780 } });
  await c.route("https://script.google.com/**", (r) => r.fulfill({ body: "ok" }));
  await c.route("**/version.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ v: "9999" }) }));
  const pg = await c.newPage();
  await pg.goto(BASE, { waitUntil: "load" });
  await pg.waitForURL(/\?v=9999/, { timeout: 10000 });
  await pg.waitForTimeout(3500); // must not reload again and again
  if (!/\?v=9999/.test(pg.url())) throw new Error("no se actualizó sola");
  await pg.evaluate(() => sessionStorage.clear());
  await pg.setInputFiles("#cv-input", SMALL);
  await pg.evaluate(() => window.lampyvaCheckVersion());
  await pg.waitForSelector("#lv-update", { timeout: 5000 });
  await c.close();
  return `versión ${v.meta}; se actualiza sola y, con trabajo abierto, ofrece "Actualizar"`;
});

await step("Idiomas: servicio de traducción en línea", async () => {
  const r = await ctx.request.get("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=" + encodeURIComponent("Remove background"), { timeout: 20000 }).catch(() => null);
  let ok2 = false;
  try { ok2 = !!r && r.ok() && /fondo/i.test(JSON.stringify(await r.json())); } catch (e) {}
  if (!ok2) warnings.push("Idiomas: el servicio de traducción no respondió; la página se queda en inglés (plan B).");
  return ok2 ? "responde" : "no responde (plan B: inglés)";
});

await gpuBrowser.close();

/* ================= Phone 2: phone WITHOUT graphics acceleration → plan B ================= */
const cpuBrowser = await chromium.launch({ args: ["--disable-webgl", "--disable-3d-apis"] });
const phone2 = await openPhone(cpuBrowser, "teléfono sin aceleración");

await step("Plan B — agrandar foto de teléfono 4x (1888×2272)", async () => {
  const r = await useTool(phone2.page, "up", [PHONE_PHOTO], { "#up-scale": "4", "#up-type": "photo" });
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  if (!/\(max\)/.test(r.lines[0])) throw new Error("no se limitó al tamaño máximo seguro: " + r.lines[0]);
  return r.lines[0].match(/\d+×\d+/)[0];
});

await step("Plan B — quitar fondo sin aceleración gráfica", async () => {
  const r = await useTool(phone2.page, "bg", [PRODUCT], { "#bg-fill": "none", "#bg-format": "png" }, 600000);
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  const eng = await phone2.page.evaluate(() => document.body.dataset.bgEngine);
  if (eng !== "cpu") throw new Error("no usó el plan B");
  await checkCutout(phone2.page);
  return "funciona";
});
await step("Plan B — print on demand: dibujo de Gemini → todas las tiendas 5000×6000", async () => {
  const r = await useTool(phone2.page, "pod", [DESIGN], { "#pod-preset": "universal", "#pod-bg": "white", "#pod-type": "art" });
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  await checkPrintFile(phone2.page, 5000, 6000);
  return "5000×6000, 300 DPI, fondo transparente";
});

await step("Plan B — print on demand: Spreadshop 3334×4000 y Displate 2900×4060", async () => {
  let r = await useTool(phone2.page, "pod", [DESIGN], { "#pod-preset": "spreadshirt", "#pod-bg": "white" });
  if (!/Done/.test(r.status)) throw new Error(`Spreadshirt: ${r.status}`);
  await checkPrintFile(phone2.page, 3334, 4000);
  r = await useTool(phone2.page, "pod", [DESIGN], { "#pod-preset": "displate", "#pod-bg": "keep" });
  if (!/Done/.test(r.status)) throw new Error(`Displate: ${r.status}`);
  const size = await phone2.page.textContent("#pod-results li .cv-size");
  if (!/2900×4060/.test(size)) throw new Error("Displate: tamaño incorrecto " + size);
});
await cpuBrowser.close();

if (pageErrors.length) problems.push("Errores de código en la página: " + [...new Set(pageErrors)].join(" | "));

const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const report = [
  `## Revisión automática de Lampyva — ${now}`,
  `Sitio revisado: ${BASE}`,
  "",
  problems.length ? "### ❌ Problemas" : "### ✅ Todo funciona",
  ...problems.map((x) => "- " + x),
  warnings.length ? "\n### ⚠️ Plan B usado" : "",
  ...warnings.map((x) => "- " + x),
  "\n### Revisado",
  ...ok.map((x) => "- ✔ " + x),
].join("\n");
console.log(report);
writeFileSync("monitor-report.md", report);
process.exit(problems.length ? 1 : 0);
