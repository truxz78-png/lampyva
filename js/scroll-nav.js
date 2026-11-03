// Lampyva — floating ↑ ↓ buttons, and a friendlier "back" button:
// if the visitor is far down the page, the phone's back button first returns to the top
// instead of leaving Lampyva. Pressing back again (at the top) leaves normally.
(function () {
  var box = document.createElement("div");
  box.className = "scroll-nav";
  box.setAttribute("translate", "no");
  box.innerHTML =
    '<button type="button" class="sn-up" aria-label="Go to top" title="Top">↑</button>' +
    '<button type="button" class="sn-down" aria-label="Go down" title="Down">↓</button>';
  document.body.appendChild(box);
  var up = box.querySelector(".sn-up"), down = box.querySelector(".sn-down");

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll("main > section, footer"));
  }
  // One smooth trip to a place on the page, with a final check: if something above changed size
  // during the trip (e.g. text being translated), it lands exactly on the target anyway.
  var trip = 0;
  function headerH() { var h = document.querySelector("header"); return h ? h.getBoundingClientRect().height : 0; }
  function topOf(el) { return el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY - headerH() - 8) : 0; }
  function goTo(el) {
    var id = ++trip;
    window.scrollTo({ top: topOf(el), behavior: "smooth" });
    var fix = function () {
      if (id !== trip) return;
      var want = Math.min(topOf(el), document.documentElement.scrollHeight - window.innerHeight);
      if (Math.abs(window.scrollY - want) > 3) window.scrollTo({ top: want, behavior: "instant" });
    };
    setTimeout(fix, 900); setTimeout(fix, 1600);
  }
  // stop the correction if the visitor starts scrolling by hand
  ["touchstart", "wheel"].forEach(function (ev) { window.addEventListener(ev, function () { trip++; }, { passive: true }); });

  up.addEventListener("click", function () { goTo(null); });
  down.addEventListener("click", function () {
    // next section below the current view (or the very bottom)
    var y = window.scrollY + headerH() + 16;
    var next = sections().find(function (s) { return s.getBoundingClientRect().top + window.scrollY > y; });
    if (next) goTo(next);
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  });

  // Buttons and links to a section of this page (Convert, Enlarge, Remove background, Print-on-demand…):
  // one tap = one smooth trip down. The page handles it itself, so the browser does not add a history step
  // that the "back" helper below would mistake for the back button (that caused the up-and-down jump
  // and the need for a second tap).
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button) return;
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || a.hasAttribute("data-contact")) return;
    var id = decodeURIComponent(a.getAttribute("href").slice(1));
    var el = id && document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    goTo(el);
    try { history.replaceState(history.state, "", "#" + id); } catch (err) {}
  });

  var armed = false, waitTop = false;
  function update() {
    var y = window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
    up.classList.toggle("show", y > 400);
    down.classList.toggle("show", y < max - 400);
    // remember one extra step in the history so "back" brings the visitor to the top first
    if (waitTop && y < 200) waitTop = false; // back at the top: ready again
    // (done when the scrolling stops, so it never interrupts a trip that is still moving)
    clearTimeout(armTimer);
    if (!armed && !waitTop && y > window.innerHeight) armTimer = setTimeout(arm, 300);
  }
  var armTimer = 0;
  function arm() {
    if (armed || waitTop || window.scrollY <= window.innerHeight) return;
    try { history.pushState({ lvTop: 1 }, ""); armed = true; } catch (e) {}
  }
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  window.addEventListener("popstate", function (e) {
    if (!armed || (e.state && (e.state.lvTop || e.state.lvKeep || e.state.lvEd))) return;
    var pe = document.getElementById("pod-editor");
    if (pe && !pe.hidden) return; // the editor handles its own "back"
    armed = false;
    waitTop = true;
    // small delay: the browser restores its own scroll position on "back" first
    if (window.scrollY > 200) setTimeout(function () { goTo(null); }, 60);
    else history.back(); // already at the top: leave normally, no trap
  });

  // Turning the phone (portrait ⇄ landscape): keep the same part of the page on screen
  // instead of jumping somewhere else.
  var anchor = null, lastW = window.innerWidth, saving = 0;
  function saveAnchor() {
    saving = 0;
    var hdr = document.querySelector("header");
    var y = (hdr ? hdr.getBoundingClientRect().bottom : 0) + 12;
    var el = document.elementFromPoint(window.innerWidth / 2, Math.min(window.innerHeight - 1, y));
    if (!el || el === document.documentElement || el === document.body) { anchor = null; return; }
    anchor = { el: el, top: el.getBoundingClientRect().top };
  }
  window.addEventListener("scroll", function () { if (!saving) saving = setTimeout(saveAnchor, 150); }, { passive: true });
  function restore() {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    if (!anchor || !anchor.el.isConnected || window.scrollY < 50) return;
    var a = anchor;
    var go = function () { window.scrollTo({ top: a.el.getBoundingClientRect().top + window.scrollY - a.top, behavior: "instant" }); };
    requestAnimationFrame(function () { go(); setTimeout(go, 250); });
  }
  window.addEventListener("resize", restore);
  window.addEventListener("orientationchange", function () { setTimeout(restore, 50); });
  // while the main buttons at the top are on screen, hide the floating arrows so a finger
  // aiming at a button never lands on an arrow by mistake
  var cta = document.querySelector(".hero .actions");
  if (cta && "IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { box.classList.toggle("away", es[0].isIntersecting); }, { rootMargin: "0px 0px 40px 0px" }).observe(cta);
  }

  saveAnchor();
  update();
})();
