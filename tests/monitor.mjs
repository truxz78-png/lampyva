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
  "js/formats.js", "js/encoders.js", "js/zip.js", "js/pod.js", "js/pod-ui.js", "js/compare-zoom.js", "js/i18n.js", "js/scroll-nav.js", "lang/es.json", "lang/ja.json", "lang/ar.json",
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
  const r = await useTool(page, "pod", [SMALL], { "#pod-preset": "amazon-tee", "#pod-bg": "keep", "#pod-type": "art" });
  if (!/Done/.test(r.status)) throw new Error(`${r.status} ${r.lines.join(" ")}`);
  const eng = await page.evaluate(() => document.body.dataset.podEngine);
  if (eng !== "ai") warnings.push("Print on demand: la IA no funcionó en el teléfono normal y se usó el plan B.");
  const ok2 = await page.evaluate(() => { const a = document.querySelector("#pod-results li .cv-size"); return a && /4500×5400/.test(a.textContent); });
  if (!ok2) throw new Error("tamaño incorrecto");
  return eng === "ai" ? "con IA" : "con plan B";
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
  // 3) with the option the closed white gaps go, the tiny eye highlight stays
  await setHoles(true);
  r = await useTool(page, "pod", [HOLES], opts);
  if (!/Done/.test(r.status)) throw new Error(r.status);
  const after = await whitePx();
  await setHoles(false);
  if (after > 60) throw new Error("quedaron huecos blancos encerrados (" + after + " píxeles blancos)");
  if (after < 1) throw new Error("se borró también el brillo pequeño del ojo");
  return `huecos: ${before} → ${after} píxeles blancos; retoque y deshacer funcionan`;
});

await step("Flechas ↑ ↓, barra de arriba fija y botón atrás", async () => {
  const pg = await ctx.newPage();
  await pg.goto("about:blank");
  await pg.goto(BASE, { waitUntil: "load" });
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

await step("Plan B — print on demand: Spreadshirt 4000×4000 y Displate 2900×4060", async () => {
  let r = await useTool(phone2.page, "pod", [DESIGN], { "#pod-preset": "spreadshirt", "#pod-bg": "white" });
  if (!/Done/.test(r.status)) throw new Error(`Spreadshirt: ${r.status}`);
  await checkPrintFile(phone2.page, 4000, 4000);
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
