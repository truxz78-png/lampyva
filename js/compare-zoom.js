// Lampyva — magnifier for the before/after comparisons.
// Tap the picture to zoom in where you tapped (tap again to zoom out), drag to move around,
// or use the 1× 2× 4× 8× buttons. Before and after always stay perfectly aligned.
const LEVELS = [1, 2, 4, 8];

function attach(stage) {
  const imgs = () => stage.querySelectorAll("img");
  let z = 1, tx = 0, ty = 0;

  const bar = document.createElement("div");
  bar.className = "zoom-bar";
  bar.innerHTML = `<span>🔍 Zoom</span>` + LEVELS.map((l) => `<button type="button" data-z="${l}">${l}×</button>`).join("");
  stage.after(bar);

  function clamp() {
    const W = stage.clientWidth, H = stage.clientHeight;
    tx = Math.min(0, Math.max(W - W * z, tx));
    ty = Math.min(0, Math.max(H - H * z, ty));
  }
  function apply() {
    clamp();
    for (const i of imgs()) { i.style.transformOrigin = "0 0"; i.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`; }
    stage.classList.toggle("zoomed", z > 1);
    bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.z) === z));
  }
  function zoomAt(px, py, nz) {
    // keep the point under the finger in the same place
    tx = px - (px - tx) * (nz / z);
    ty = py - (py - ty) * (nz / z);
    z = nz;
    apply();
    if (nz > 1 && window.lampyvaTrack) window.lampyvaTrack("use-zoom");
  }

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, Number(b.dataset.z));
  });

  let down = null, moved = false;
  stage.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, tx, ty };
    moved = false;
    if (z > 1) stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!down || z === 1) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    tx = down.tx + dx; ty = down.ty + dy;
    apply();
  });
  stage.addEventListener("pointerup", (e) => {
    if (down && !moved) {
      const r = stage.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, z === 1 ? 4 : 1);
    }
    down = null;
  });
  stage.addEventListener("pointercancel", () => { down = null; });

  // new picture → back to normal view
  for (const i of imgs()) i.addEventListener("load", () => { z = 1; tx = ty = 0; apply(); });
  window.addEventListener("resize", apply);
  apply();
}

document.querySelectorAll(".up-stage").forEach(attach);
