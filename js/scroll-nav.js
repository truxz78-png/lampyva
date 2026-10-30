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
  up.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
  down.addEventListener("click", function () {
    // next section below the current view (or the very bottom)
    var y = window.scrollY + 80;
    var next = sections().find(function (s) { return s.getBoundingClientRect().top + window.scrollY > y + 10; });
    var top = next ? next.getBoundingClientRect().top + window.scrollY - 64 : document.documentElement.scrollHeight;
    window.scrollTo({ top: top, behavior: "smooth" });
  });

  var armed = false, waitTop = false;
  function update() {
    var y = window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
    up.classList.toggle("show", y > 400);
    down.classList.toggle("show", y < max - 400);
    // remember one extra step in the history so "back" brings the visitor to the top first
    if (waitTop && y < 200) waitTop = false; // back at the top: ready again
    if (!armed && !waitTop && y > window.innerHeight) {
      try { history.pushState({ lvTop: 1 }, ""); armed = true; } catch (e) {}
    }
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
    if (window.scrollY > 200) setTimeout(function () { window.scrollTo({ top: 0, behavior: "smooth" }); }, 60);
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
  saveAnchor();
  update();
})();
