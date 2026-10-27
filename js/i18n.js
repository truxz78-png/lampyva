// Lampyva — automatic translation without any Google banner or logo.
// Technique: walk every text node of the page and translate it one by one with fetch(),
// detect the visitor's language, never translate brand names or file names,
// fix the first capital letter, and keep translating text that appears later (results, messages).
// Reviewed translations come first: lang/<code>.json has every text of the site translated and
// checked by hand (exact texts, plus "patterns" for messages with numbers, e.g. "Done! {1} images ready.").
// The automatic service is used only for a text that is not in that file yet.
// Plan B: if the translation service fails, the page simply stays in English.
(function () {
  var LANGS = [
    ["en", "English"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"],
    ["it", "Italiano"], ["nl", "Nederlands"], ["pl", "Polski"], ["ru", "Русский"], ["uk", "Українська"],
    ["tr", "Türkçe"], ["ar", "العربية"], ["hi", "हिन्दी"], ["bn", "বাংলা"], ["id", "Bahasa Indonesia"],
    ["vi", "Tiếng Việt"], ["th", "ไทย"], ["tl", "Filipino"], ["zh-CN", "中文 (简体)"], ["zh-TW", "中文 (繁體)"],
    ["ja", "日本語"], ["ko", "한국어"], ["he", "עברית"], ["fa", "فارسی"], ["sw", "Kiswahili"],
  ];
  var RTL = { ar: 1, he: 1, fa: 1, ur: 1 };
  // never translated (exact match, any capitals)
  var BRANDS = ["Lampyva", "PayPal", "Bitcoin", "Ethereum", "Tether", "BTC", "ETH", "USDT", "Binance", "Redbubble",
    "Spreadshirt", "Spreadshop", "Zazzle", "Displate", "Amazon Merch", "TeePublic", "PopSockets", "GitHub", "Nortevia",
    "DriftforgeDev", "PNG", "JPG", "JPEG", "WebP", "AVIF", "GIF", "BMP", "ICO", "TIFF", "HEIC", "SVG", "PDF", "ZIP",
    "1×", "2×", "4×", "8×", "300 DPI"].map(function (b) { return b.toLowerCase(); });
  var SKIP = '[translate="no"], .notranslate, script, style, noscript, code, textarea, .cv-name, .cv-size, .brand, .formats, #cv-inputs, #cv-outputs, .don-addr';
  var KEY = "lampyva-lang";

  var original = new WeakMap();   // text node → English text
  var applied = new WeakMap();    // text node → text we wrote (to ignore our own changes)
  var lang = "en", cache = {}, pending = {}, failed = false;
  var dict = {}, pats = [], dictReady = Promise.resolve();

  // reviewed translations: lang/<code>.json (same folder as the pages)
  function loadDict(code) {
    dict = {}; pats = [];
    if (code === "en") return Promise.resolve();
    var done = fetch("lang/" + code + ".json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
      if (lang !== code) return;
      dict = d.strings || {};
      pats = Object.keys(d.patterns || {}).map(function (k) {
        var names = [];
        var rx = k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d)\}/g, function (m, n) { names.push(n); return "(.+?)"; });
        return { rx: new RegExp("^" + rx + "$"), names: names, out: d.patterns[k] };
      });
    }).catch(function () { /* no reviewed file: automatic translation only */ });
    // never wait more than 4 s for the file
    return Promise.race([done, new Promise(function (r) { setTimeout(r, 4000); })]);
  }
  function reviewed(text) {
    if (dict[text] !== undefined) return dict[text];
    for (var i = 0; i < pats.length; i++) {
      var m = text.match(pats[i].rx);
      if (!m) continue;
      var out = pats[i].out;
      pats[i].names.forEach(function (n, j) { var v = m[j + 1]; out = out.split("{" + n + "}").join(reviewed(v) != null ? reviewed(v) : v); });
      return out;
    }
    return null;
  }

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function detect() {
    var saved = store(KEY);
    if (saved) return saved;
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || navigator.userLanguage || "en";
    var base = nav.toLowerCase().split("-")[0];
    if (base === "zh") return /tw|hk|mo|hant/i.test(nav) ? "zh-TW" : "zh-CN";
    if (base === "fil") return "tl";
    if (base === "iw") return "he";
    return base;
  }

  function loadCache() {
    try { cache = JSON.parse(store("lampyva-tr-" + lang) || "{}"); } catch (e) { cache = {}; }
  }
  var saveTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { try { store("lampyva-tr-" + lang, JSON.stringify(cache)); } catch (e) {} }, 800);
  }

  function capitalFix(src, out) {
    var a = src.trim().charAt(0), b = out.charAt(0);
    if (a && a === a.toUpperCase() && a !== a.toLowerCase() && b && b !== b.toUpperCase()) return b.toUpperCase() + out.slice(1);
    return out;
  }

  // fetch with a small queue (max 4 at a time)
  var queue = [], running = 0;
  function translate(text) {
    var ok = reviewed(text);
    if (ok != null) return Promise.resolve(ok);
    if (cache[text] !== undefined) return Promise.resolve(cache[text]);
    if (pending[text]) return pending[text];
    pending[text] = new Promise(function (resolve) { queue.push({ text: text, resolve: resolve }); pump(); });
    return pending[text];
  }
  function pump() {
    while (running < 4 && queue.length) {
      var job = queue.shift();
      if (failed) { delete pending[job.text]; job.resolve(null); continue; } // service down: stay in English
      running++;
      (function (job, target) {
        var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=" + encodeURIComponent(target) +
          "&dt=t&q=" + encodeURIComponent(job.text);
        fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
          var out = (d && d[0] || []).map(function (s) { return s[0] || ""; }).join("");
          out = out ? capitalFix(job.text, out) : job.text;
          if (target === lang) { cache[job.text] = out; saveCache(); }
          job.resolve(out);
        }).catch(function () {
          if (!failed) {
            failed = true;
            if (window.lampyvaTrack) window.lampyvaTrack("fallback-translate");
            var label = document.getElementById("lang-code");
            if (label) label.textContent = "EN";
          }
          job.resolve(null); // plan B: keep English
        }).then(function () { delete pending[job.text]; running--; pump(); });
      })(job, lang);
    }
  }

  function skip(node) {
    var el = node.parentElement;
    return !el || !!el.closest(SKIP);
  }

  function handle(node, force) {
    if (skip(node)) return;
    var cur = node.nodeValue;
    var ours = applied.get(node) === cur;            // text we wrote ourselves
    if (ours && !force) return;
    if (!ours) { original.set(node, cur); applied.delete(node); } // new text from the page
    var en = original.get(node);
    var core = en.trim();
    if (!core || !/[A-Za-z]/.test(core) || BRANDS.indexOf(core.toLowerCase()) >= 0) return;
    if (lang === "en") {
      if (cur !== en) { applied.set(node, en); node.nodeValue = en; }
      return;
    }
    var want = lang;
    dictReady.then(function () { return translate(core); }).then(function (t) {
      if (t == null || lang !== want || original.get(node) !== en) return;
      var lead = en.match(/^\s*/)[0], tail = en.match(/\s*$/)[0];
      var out = lead + t + tail;
      applied.set(node, out);
      node.nodeValue = out;
    });
  }

  function walk(root, force) {
    if (root.nodeType === 3) { handle(root, force); return; }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) handle(n, force);
  }

  var titleEn = document.title;
  function setLang(code, remember) {
    lang = code || "en";
    if (remember) store(KEY, lang);
    failed = false;
    loadCache();
    dictReady = loadDict(lang);
    var notes = document.querySelectorAll(".tr-note");
    for (var i = 0; i < notes.length; i++) notes[i].hidden = lang === "en";
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL[lang.split("-")[0]] ? "rtl" : "ltr";
    var label = document.getElementById("lang-code");
    if (label) label.textContent = lang.split("-")[0].toUpperCase();
    var pick = document.getElementById("lang-pick");
    if (pick) pick.value = LANGS.some(function (l) { return l[0] === lang; }) ? lang : "en";
    walk(document.body, true);
    if (lang === "en") document.title = titleEn;
    else dictReady.then(function () { return translate(titleEn); }).then(function (t) { if (t) document.title = t; });
  }

  function buildPicker() {
    var pick = document.getElementById("lang-pick");
    if (!pick) return;
    pick.innerHTML = LANGS.map(function (l) { return '<option value="' + l[0] + '">' + l[1] + "</option>"; }).join("");
    pick.addEventListener("change", function () {
      if (window.lampyvaTrack) window.lampyvaTrack("lang-" + pick.value.toLowerCase());
      setLang(pick.value, true);
    });
  }

  function start() {
    buildPicker();
    setLang(detect(), false);
    // keep translating anything the tools add later (messages, results, options)
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === "characterData") handle(m.target);
        else m.addedNodes.forEach(function (n) { if (n.nodeType === 1 || n.nodeType === 3) walk(n); });
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.lampyvaSetLanguage = function (code) { setLang(code, true); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
