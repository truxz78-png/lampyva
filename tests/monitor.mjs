// Lampyva — automatic check ("robot").
// Opens the site in a real browser, uses every tool and writes a report.
// Usage: BASE=https://truxz78-png.github.io/lampyva/ node tests/monitor.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = (process.env.BASE || "http://localhost:8765/").replace(/\/?$/, "/");
const HERE = dirname(fileURLToPath(import.meta.url));
const problems = [];   // major: something is broken
const warnings = [];   // plan B was used
const ok = [];

const FILES = [
  "", "privacy.html", "terms.html", "style.css", "config.js",
  "js/site.js", "js/converter.js", "js/upscale-ui.js", "js/upscaler.js", "js/bg-ui.js", "js/bgremover.js",
  "js/formats.js", "js/encoders.js", "js/zip.js",
  "vendor/qrcode.js", "vendor/UTIF.js", "vendor/heic2any.min.js",
  "models/models.json", "models/photo-x2-noise1.bin", "models/art-x2.bin", "models/u2netp.json", "models/u2netp.bin",
  "assets/icon.svg", "assets/share.png",
];

async function step(name, fn) {
  try {
    const r = await fn();
    ok.push(name + (r ? ` — ${r}` : ""));
  } catch (e) {
    problems.push(`${name}: ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const pageErrors = [];

await step("Archivos del sitio disponibles", async () => {
  const bad = [];
  for (const f of FILES) {
    const r = await ctx.request.get(BASE + f);
    if (r.status() !== 200) bad.push(`${f || "index.html"} (${r.status()})`);
  }
  if (bad.length) throw new Error("No cargan: " + bad.join(", "));
  return `${FILES.length} archivos`;
});

const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(e.message));

await step("Página principal abre", async () => {
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  const t = await page.title();
  if (!/Lampyva/.test(t)) throw new Error("título inesperado: " + t);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`la página se sale de la pantalla (ancho ${w}px)`);
});

await step("Convertir formatos (PNG → JPG)", async () => {
  await page.waitForSelector("#cv-format option", { state: "attached", timeout: 30000 });
  await page.setInputFiles("#cv-input", join(HERE, "sample.png"));
  await page.selectOption("#cv-format", "jpg");
  await page.click("#cv-run");
  await page.waitForFunction(() => /Done|No files/.test(document.querySelector("#cv-status").textContent), null, { timeout: 60000 });
  const s = await page.textContent("#cv-status");
  if (!/Done/.test(s)) throw new Error(s);
});

await step("Agrandar con IA (2x)", async () => {
  await page.waitForSelector("#up-format option", { state: "attached", timeout: 30000 });
  await page.setInputFiles("#up-input", join(HERE, "sample.png"));
  await page.click("#up-run");
  await page.waitForFunction(() => /Done|No images/.test(document.querySelector("#up-status").textContent), null, { timeout: 240000 });
  const s = await page.textContent("#up-status");
  if (!/Done/.test(s)) throw new Error(s + " " + (await page.textContent("#up-results")));
  const res = await page.textContent("#up-results");
  if (!/96×96/.test(res)) throw new Error("tamaño incorrecto: " + res);
  const eng = await page.evaluate(() => document.body.dataset.upscaleEngine);
  if (eng !== "ai") warnings.push("Agrandar: la IA no funcionó y se usó el plan B (redimensionado normal).");
  return eng === "ai" ? "con IA" : "con plan B";
});

await step("Quitar fondo", async () => {
  await page.waitForSelector("#bg-format option", { state: "attached", timeout: 30000 });
  await page.setInputFiles("#bg-input", join(HERE, "sample-photo.jpg"));
  await page.click("#bg-run");
  await page.waitForFunction(() => /Done|No images/.test(document.querySelector("#bg-status").textContent), null, { timeout: 400000 });
  const s = await page.textContent("#bg-status");
  if (!/Done/.test(s)) throw new Error(s + " " + (await page.textContent("#bg-results")));
  const eng = await page.evaluate(() => document.body.dataset.bgEngine);
  if (eng !== "gpu") warnings.push("Quitar fondo: la aceleración gráfica falló y se usó el plan B (más lento).");
  return eng === "gpu" ? "con aceleración gráfica" : "con plan B";
});

await step("Sección de donar y contacto", async () => {
  const n = await page.locator("#don-paypal").count();
  if (!n) throw new Error("falta el botón de PayPal");
  const mail = await page.getAttribute("[data-contact]", "href");
  if (!/^mailto:/.test(mail || "")) throw new Error("el enlace de contacto no funciona");
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

if (pageErrors.length) problems.push("Errores de código en la página: " + [...new Set(pageErrors)].join(" | "));
await browser.close();

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
