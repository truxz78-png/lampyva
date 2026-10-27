/**
 * Lampyva — robot de estadísticas (Google Apps Script).
 *
 * Recibe los conteos anónimos de la página (visitas y clics), los guarda en TU propia hoja de
 * Google y te manda un resumen por correo cada mañana. Si ve muchos errores, el asunto del
 * correo empieza con ⚠️ para que lo revisemos juntos.
 *
 * No guarda nombres, correos, IP ni imágenes: solo la acción, la página, de qué sitio llegó
 * el visitante, idioma, zona horaria y si usa teléfono o computadora.
 *
 * Instalación desde el teléfono (Termux + clasp, sin usar el editor web):
 *   clasp create → clasp push → clasp deploy, y luego abrir una vez
 *   https://script.google.com/macros/s/ID/exec?setup=1 con la cuenta dueña y dar "Permitir".
 */

var ALLOWED = /^[a-z0-9-]{1,48}$/;
var KEEP_DAYS = 400;

function doGet(e) {
  // run from the editor (▶ Ejecutar, no visitor data): install the robot
  if (!e) { setup(); return out_("Lampyva: robot instalado."); }
  // one-time installation from the phone: open the web app URL with ?setup=1 (as the owner)
  if (e && e.parameter && e.parameter.setup) {
    if (PropertiesService.getScriptProperties().getProperty("SHEET_ID")) return out_("Lampyva: el robot ya estaba instalado. Todo listo.");
    setup();
    return out_("Lampyva: robot instalado. Revisa tu correo: te llegó el primer resumen con el enlace a la hoja.");
  }
  return record_(e);
}
function doPost(e) { return record_(e); }

function record_(e) {
  try {
    var p = (e && e.parameter) || {};
    var ev = String(p.e || "").toLowerCase();
    if (!ALLOWED.test(ev)) return out_("bad");
    sheet_("Eventos").appendRow([new Date(), ev, clip_(p.p, 80), clip_(p.r, 80), clip_(p.l, 12), clip_(p.z, 40), clip_(p.d, 8)]);
    return out_("ok");
  } catch (err) {
    return out_("error");
  }
}

function clip_(v, n) { return String(v || "").replace(/^[=+@\-]+/, "").slice(0, n); }
function out_(t) { return ContentService.createTextOutput(t); }

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  return SpreadsheetApp.openById(id);
}
function sheet_(name) { return book_().getSheetByName(name); }

/** Ejecutar UNA vez: crea la hoja, el robot diario y manda el primer correo. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SHEET_ID");
  var book;
  try { book = id ? SpreadsheetApp.openById(id) : null; } catch (e) { book = null; }
  if (!book) {
    book = SpreadsheetApp.create("Lampyva — estadísticas");
    props.setProperty("SHEET_ID", book.getId());
    var ev = book.getSheets()[0];
    ev.setName("Eventos");
    ev.appendRow(["Fecha", "Acción", "Página", "Llegó desde", "Idioma", "Zona horaria", "Equipo"]);
    ev.setFrozenRows(1);
    book.insertSheet("Resumen");
  }
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("dailyReport").timeBased().everyDays(1).atHour(7).create();
  dailyReport();
}

var NAMES = {
  "visit": "Visitas a la página",
  "click-donate-header": "Clic en Donate (arriba)",
  "donate-paypal": "Clic en donar con PayPal",
  "donate-copy-btc": "Copiaron dirección Bitcoin",
  "donate-copy-eth": "Copiaron dirección Ethereum",
  "donate-copy-usdt": "Copiaron dirección USDT/USDC",
  "donate-copy-usdc": "Copiaron dirección USDC",
  "click-contact": "Clic en enviar idea / problema",
  "use-upscale": "Usaron Agrandar con IA",
  "use-remove-bg": "Usaron Quitar fondo",
  "use-zoom": "Usaron la lupa",
};
function label_(ev) {
  if (NAMES[ev]) return NAMES[ev];
  if (ev.indexOf("use-convert-") === 0) return "Convertir a " + ev.slice(12).toUpperCase();
  if (ev.indexOf("use-pod-") === 0) return "Print on demand: " + ev.slice(8);
  if (ev.indexOf("fallback-") === 0) return "Plan B usado: " + ev.slice(9);
  if (ev.indexOf("error-") === 0) return "ERROR: " + ev.slice(6);
  return ev;
}

/** Robot diario: arma el resumen en la hoja, limpia lo viejo y manda el correo. */
function dailyReport() {
  var book = book_();
  var ev = book.getSheetByName("Eventos");
  var rows = ev.getLastRow() > 1 ? ev.getRange(2, 1, ev.getLastRow() - 1, 7).getValues() : [];
  var now = new Date().getTime(), DAY = 86400000;

  // limpiar filas muy viejas
  var old = 0;
  while (old < rows.length && now - new Date(rows[old][0]).getTime() > KEEP_DAYS * DAY) old++;
  if (old) { ev.deleteRows(2, old); rows = rows.slice(old); }

  var counts = {}, refs = {}, zones = {}, langs = {}, devs = {};
  var errorsToday = 0;
  rows.forEach(function (r) {
    var age = (now - new Date(r[0]).getTime()) / DAY, k = r[1];
    if (!counts[k]) counts[k] = [0, 0, 0, 0];
    counts[k][3]++;
    if (age <= 30) counts[k][2]++;
    if (age <= 7) counts[k][1]++;
    if (age <= 1) {
      counts[k][0]++;
      if (String(k).indexOf("error") === 0) errorsToday++;
    }
    if (age <= 30 && k === "visit") {
      if (r[3]) refs[r[3]] = (refs[r[3]] || 0) + 1;
      if (r[5]) zones[r[5]] = (zones[r[5]] || 0) + 1;
      if (r[4]) langs[r[4]] = (langs[r[4]] || 0) + 1;
      if (r[6]) devs[r[6]] = (devs[r[6]] || 0) + 1;
    }
  });

  var keys = Object.keys(counts).sort(function (a, b) {
    if (a === "visit") return -1; if (b === "visit") return 1;
    return counts[b][2] - counts[a][2];
  });
  var top = function (o, n) {
    return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n).map(function (k) { return [k, o[k]]; });
  };

  // hoja Resumen
  var res = book.getSheetByName("Resumen");
  res.clear();
  var table = [["Acción", "Últimas 24 h", "Últimos 7 días", "Últimos 30 días", "Total"]];
  keys.forEach(function (k) { table.push([label_(k)].concat(counts[k])); });
  if (table.length === 1) table.push(["(todavía no hay datos)", 0, 0, 0, 0]);
  res.getRange(1, 1, table.length, 5).setValues(table);
  res.getRange(1, 1, 1, 5).setFontWeight("bold");
  var row = table.length + 2;
  [["De dónde llegan (30 días)", top(refs, 10)], ["Zona horaria / país (30 días)", top(zones, 10)],
   ["Idioma (30 días)", top(langs, 10)], ["Equipo (30 días)", top(devs, 3)]].forEach(function (blk) {
    res.getRange(row, 1).setValue(blk[0]).setFontWeight("bold");
    if (blk[1].length) res.getRange(row + 1, 1, blk[1].length, 2).setValues(blk[1]);
    row += blk[1].length + 2;
  });
  res.getRange(row, 1).setValue("Actualizado: " + new Date());
  res.autoResizeColumn(1);

  // correo
  var v = counts["visit"] || [0, 0, 0, 0];
  var html = "<h2>Lampyva — resumen</h2>" +
    "<p><b>Visitas:</b> " + v[0] + " hoy · " + v[1] + " en 7 días · " + v[2] + " en 30 días</p>" +
    "<table border='1' cellpadding='6' style='border-collapse:collapse'>" +
    table.map(function (r, i) { var t = i ? "td" : "th"; return "<tr>" + r.map(function (c) { return "<" + t + ">" + c + "</" + t + ">"; }).join("") + "</tr>"; }).join("") +
    "</table><p>Hoja completa: <a href='" + book.getUrl() + "'>" + book.getUrl() + "</a></p>";
  var subject = (errorsToday >= 3 ? "⚠️ Lampyva: " + errorsToday + " errores hoy — revisar" : "Lampyva: " + v[0] + " visitas hoy");
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: subject, htmlBody: html });
}
