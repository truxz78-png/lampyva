// Lampyva — images to promote a design: a vertical Pinterest pin and a T-shirt preview (white + black).
// Everything is drawn here (no photos or templates from anyone else).

const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

/** Draw `img` inside the box, as big as possible without cutting it. */
function drawContain(ctx, img, x, y, w, h) {
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Light text on dark colors, dark text on light colors. */
function textColorFor(hex) {
  const n = parseInt(hex.replace("#", ""), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1b1b1b" : "#ffffff";
}

/** Split a title into lines that fit the width (max 3 lines). */
function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width <= maxW || !line) line = t;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Pinterest pin 1000×1500: the design on a color background, optional title at the bottom. */
export function makePin(design, { bg = "#1e3a6e", title = "" } = {}) {
  const W = 1000, H = 1500, c = newCanvas(W, H), ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // soft light behind the design so it stands out
  const glow = ctx.createRadialGradient(W / 2, H * 0.42, 50, W / 2, H * 0.42, W * 0.75);
  glow.addColorStop(0, "rgba(255,255,255,0.18)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  let areaH = H - 160;
  if (title) {
    ctx.font = "700 64px Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
    let lines = wrap(ctx, title, W - 140);
    if (lines.length > 2) { ctx.font = "700 52px Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"; lines = wrap(ctx, title, W - 140); }
    const lh = parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 1.2;
    const blockH = lines.length * lh;
    areaH = H - blockH - 200;
    ctx.fillStyle = textColorFor(bg);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((l, i) => ctx.fillText(l, W / 2, H - 110 - blockH + lh * (i + 0.5)));
  }
  drawContain(ctx, design, 80, 80, W - 160, areaH);
  return c;
}

/** T-shirt outline in a w×h box (generic shape drawn with lines and curves). */
function shirtPath(ctx, x, y, w, h) {
  const P = (px, py) => [x + px * w, y + py * h];
  ctx.beginPath();
  ctx.moveTo(...P(0.38, 0.035));
  ctx.quadraticCurveTo(...P(0.5, 0.13), ...P(0.62, 0.035));
  ctx.lineTo(...P(0.8, 0.085));
  ctx.quadraticCurveTo(...P(0.92, 0.15), ...P(0.995, 0.31));
  ctx.lineTo(...P(0.865, 0.395));
  ctx.lineTo(...P(0.785, 0.32));
  ctx.quadraticCurveTo(...P(0.79, 0.65), ...P(0.795, 0.985));
  ctx.quadraticCurveTo(...P(0.5, 1.0), ...P(0.205, 0.985));
  ctx.quadraticCurveTo(...P(0.21, 0.65), ...P(0.215, 0.32));
  ctx.lineTo(...P(0.135, 0.395));
  ctx.lineTo(...P(0.005, 0.31));
  ctx.quadraticCurveTo(...P(0.08, 0.15), ...P(0.2, 0.085));
  ctx.closePath();
}

function drawShirt(ctx, design, x, y, w, h, dark) {
  const fill = dark ? "#1c1c1f" : "#f7f7f5", line = dark ? "#000000" : "#c9c9c4";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.22)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  shirtPath(ctx, x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  // soft folds and light
  ctx.save();
  shirtPath(ctx, x, y, w, h);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, dark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.25)");
  g.addColorStop(0.55, "rgba(0,0,0,0)");
  g.addColorStop(1, dark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.07)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // the design on the chest
  drawContain(ctx, design, x + w * 0.31, y + h * 0.2, w * 0.38, h * 0.44);
  ctx.restore();
  // outline and collar
  ctx.lineWidth = Math.max(2, w * 0.006);
  ctx.strokeStyle = line;
  shirtPath(ctx, x, y, w, h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + w * 0.375, y + h * 0.04);
  ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.16, x + w * 0.625, y + h * 0.04);
  ctx.lineWidth = Math.max(4, w * 0.018);
  ctx.strokeStyle = dark ? "#2b2b30" : "#e4e4df";
  ctx.stroke();
}

/** T-shirt preview 2000×1200: the design on a white and on a black T-shirt. */
export function makeMockup(design) {
  const W = 2000, H = 1200, c = newCanvas(W, H), ctx = c.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#ecebe7");
  bg.addColorStop(1, "#d9d7d1");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const sw = 900, sh = 1000;
  drawShirt(ctx, design, 70, 100, sw, sh, false);
  drawShirt(ctx, design, W - 70 - sw, 100, sw, sh, true);
  return c;
}
