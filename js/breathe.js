// Lampyva — let the page breathe during long work, and keep working when the visitor looks away.
// - breathe(): heavy steps call it between small pieces of work; the browser gets a frame to draw,
//   and while the visitor is scrolling the work waits a moment, so scrolling stays smooth.
//   When the page is in the background (another app), it does not wait for frames at all.
// - keepAwake(): the screen does not turn off by itself while a job runs.
// - notifyDone(): a notification (and vibration) when the job is finished, if the visitor allowed it.
let lastInput = 0;
for (const ev of ["scroll", "touchstart", "touchmove", "wheel", "pointerdown", "keydown"]) {
  addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true, capture: true });
}

// a tick that is not slowed down in background tabs (timers are)
const chan = new MessageChannel();
const waiting = [];
chan.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
const fastTick = () => new Promise((r) => { waiting.push(r); chan.port2.postMessage(0); });

const frame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 50);
});

/** Is the visitor touching or scrolling the page right now? */
export const userActive = () => !document.hidden && performance.now() - lastInput < 300;

export async function breathe() {
  if (document.hidden) return fastTick();
  await frame();
  const t0 = performance.now();
  while (!document.hidden && performance.now() - lastInput < 250 && performance.now() - t0 < 1500) {
    await new Promise((r) => setTimeout(r, 60));
  }
}

/* ---------- screen on while working ---------- */
let lock = null, jobs = 0;
async function takeLock() {
  try { if (jobs > 0 && !lock && navigator.wakeLock && !document.hidden) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); } } catch (e) { lock = null; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) takeLock(); });
export function keepAwake(on) {
  jobs = Math.max(0, jobs + (on ? 1 : -1));
  document.documentElement.classList.toggle("lv-busy", jobs > 0); // lighter page effects while working
  if (jobs > 0) takeLock();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}

/* ---------- "it's ready" notification ---------- */
const KEY = "lampyva-notify";
const store = (v) => { try { if (v === undefined) return localStorage.getItem(KEY); localStorage.setItem(KEY, v); } catch (e) { return null; } };
let reg = null;
async function registration() {
  if (reg || !("serviceWorker" in navigator)) return reg;
  try { reg = await navigator.serviceWorker.register("sw.js"); } catch (e) { reg = null; }
  return reg;
}
export const canNotify = () => "Notification" in window && "serviceWorker" in navigator;
export const notifyWanted = () => canNotify() && store() === "1" && Notification.permission === "granted";

/** Turn the notification on/off (asks the browser the first time). Returns true if it is on. */
export async function setNotify(on) {
  if (!on) { store("0"); return false; }
  if (!canNotify()) return false;
  let p = Notification.permission;
  if (p === "default") { try { p = await Notification.requestPermission(); } catch (e) { p = "denied"; } }
  store(p === "granted" ? "1" : "0");
  if (p === "granted") registration();
  return p === "granted";
}

const baseTitle = document.title;
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = baseTitle; });

/** Tell the visitor the job is finished: notification when the page is not visible, plus the tab title. */
export async function notifyDone(title, body) {
  if (!document.hidden) return;
  document.title = "✓ " + title;
  try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch (e) {}
  if (!notifyWanted()) return;
  try {
    const r = await registration();
    const opts = { body, icon: "assets/icon-192.png", badge: "assets/icon-192.png", tag: "lampyva-done" };
    if (r) await r.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (e) { /* no notification on this browser */ }
}

/** A "Notify me when it's ready" switch, added under a tool's buttons. */
export function notifySwitch(container) {
  if (!canNotify() || !container) return;
  const label = document.createElement("label");
  label.className = "cv-check notify-switch";
  label.innerHTML = '<input type="checkbox"><span>🔔 Notify me when it\'s ready (you can use other apps meanwhile)</span>';
  const box = label.querySelector("input");
  const note = document.createElement("p");
  note.className = "cv-note notify-note";
  note.hidden = true;
  note.textContent = "Your browser did not allow notifications for this page. To allow them: tap the icon to the left of the web address → Permissions → Notifications → Allow. Then tick the box again.";
  box.checked = notifyWanted();
  box.addEventListener("change", async () => {
    const want = box.checked;
    const on = await setNotify(want);
    document.querySelectorAll(".notify-switch input").forEach((b) => { b.checked = on; });
    // if it could not be turned on, say why and how to fix it (instead of silently unticking)
    document.querySelectorAll(".notify-note").forEach((n) => { n.hidden = true; });
    if (want && !on) note.hidden = false;
  });
  container.after(label);
  label.after(note);
}
