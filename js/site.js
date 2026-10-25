// Lampyva — shared page code: statistics, donation options, contact link.
(function () {
  var C = window.LAMPYVA || {};

  /* ---------- Statistics (own robot: Google Apps Script → the owner's Google Sheet) ----------
     Only anonymous counts: action name, page, the site the visitor came from, language,
     time zone and phone/computer. No cookies, no IDs, no IP addresses, never the images. */
  var LOCAL = /^(localhost|127\.)/.test(location.hostname);
  function send(name) {
    if (!C.stats || LOCAL) return;
    try {
      var tz = "";
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
      var ref = "";
      if (name === "visit" && document.referrer) {
        try { var h = new URL(document.referrer).hostname; if (h !== location.hostname) ref = h; } catch (e) {}
      }
      var q = "e=" + encodeURIComponent(name) +
        "&p=" + encodeURIComponent(location.pathname) +
        "&r=" + encodeURIComponent(ref) +
        "&l=" + encodeURIComponent((navigator.language || "").slice(0, 10)) +
        "&z=" + encodeURIComponent(tz) +
        "&d=" + (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop");
      var url = C.stats + (C.stats.indexOf("?") < 0 ? "?" : "&") + q;
      if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
        fetch(url, { method: "POST", mode: "no-cors", keepalive: true }).catch(function () {});
      }
    } catch (e) { /* statistics must never break the page */ }
  }
  var sent = {};
  /** Count an action, e.g. lampyvaTrack("donate-paypal"). Repeated errors/plan B are counted once per visit. */
  window.lampyvaTrack = function (name) {
    if (/^(error|fallback)/.test(name)) { if (sent[name]) return; sent[name] = 1; }
    send(name);
  };
  send("visit");

  window.addEventListener("error", function () { window.lampyvaTrack("error-page"); });
  window.addEventListener("unhandledrejection", function () { window.lampyvaTrack("error-page"); });
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (el) window.lampyvaTrack(el.getAttribute("data-track"));
  });

  /* ---------- Donation options ---------- */
  var CRYPTO = [
    { key: "btc", name: "Bitcoin", sym: "BTC", net: "Bitcoin (BTC)" },
    { key: "eth", name: "Ethereum", sym: "ETH", net: "Ethereum (ERC20)" },
    { key: "usdt", name: "Tether (digital dollar)", sym: "USDT", net: "BNB Smart Chain (BEP20)" },
  ];

  function qrSvg(text, id) {
    if (typeof window.qrcode !== "function") return "";
    try {
      var q = window.qrcode(0, "M");
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: { text: "QR code", id: "qr-" + id } });
    } catch (e) { return ""; }
  }

  function copy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = old; }, 1800);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (e) {}
    t.remove();
  }

  function buildDonate() {
    var pp = document.getElementById("don-paypal");
    if (pp) {
      if (C.paypal && C.paypal.indexOf("http") === 0) {
        pp.href = C.paypal; pp.target = "_blank"; pp.rel = "noopener";
        pp.removeAttribute("aria-disabled");
      } else {
        pp.classList.add("is-soon");
        pp.setAttribute("aria-disabled", "true");
        pp.removeAttribute("href");
        var s = pp.querySelector(".don-soon"); if (s) s.hidden = false;
      }
    }
    var box = document.getElementById("don-crypto");
    if (!box) return;
    var any = false;
    CRYPTO.forEach(function (c) {
      var addr = (C[c.key] || "").trim();
      if (!addr) return;
      any = true;
      var card = document.createElement("div");
      card.className = "don-coin";
      card.innerHTML =
        '<div class="don-qr"></div>' +
        '<div class="don-info"><h4></h4><p class="don-net"></p><code class="don-addr"></code>' +
        '<button type="button" class="btn btn-sm btn-ghost">Copy address</button></div>';
      card.querySelector("h4").textContent = c.name + " (" + c.sym + ")";
      card.querySelector(".don-net").textContent = "Network: " + c.net + " only";
      card.querySelector(".don-addr").textContent = addr;
      card.querySelector(".don-qr").innerHTML = qrSvg(addr, c.key);
      var b = card.querySelector("button");
      b.addEventListener("click", function () { copy(addr, b); window.lampyvaTrack("donate-copy-" + c.key); });
      box.appendChild(card);
    });
    document.getElementById("don-crypto-soon").hidden = any;
    document.getElementById("don-crypto-warn").hidden = !any;
  }

  /* ---------- Contact: ideas and problems ---------- */
  function buildContact() {
    var mail = (C.contact || "").trim();
    document.querySelectorAll("[data-contact]").forEach(function (a) {
      if (!mail) { a.hidden = true; return; }
      var body = "Write your idea or the problem here:\n\n\n\n---\nPage: " + location.href +
        "\nBrowser: " + navigator.userAgent;
      a.href = "mailto:" + mail + "?subject=" + encodeURIComponent("Lampyva — idea / problem") +
        "&body=" + encodeURIComponent(body);
    });
    document.querySelectorAll("[data-contact-email]").forEach(function (el) { el.textContent = mail; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var y = document.getElementById("year");
    if (y) y.textContent = new Date().getFullYear();
    buildDonate();
    buildContact();
  });
})();
