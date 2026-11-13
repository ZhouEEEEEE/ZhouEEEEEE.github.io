/* =====================================================================
   heatmap.js — dotted world map + visitor heat, rendered on <canvas>.
   Dependency-free. Reads land grid from window.WORLD (world-data.js).
   ===================================================================== */

const Heatmap = (() => {
  "use strict";

  const W = window.WORLD;
  let canvas, ctx, landLayer, landCtx;
  let cssW = 0, cssH = 0, dpr = 1;
  let fit = { x: 0, y: 0, w: 0, h: 0 };
  let points = [];          // [{lat, lon, count}]
  let maxCount = 1;
  let highlight = null;      // {lat, lon} — pulses
  let rafId = null;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Decode base64 → Uint8Array bitmask
  const landBits = (() => {
    const bin = atob(W.mask);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  })();
  const isLand = (cx, cy) => {
    const i = cy * W.gw + cx;
    return (landBits[i >> 3] >> (i & 7)) & 1;
  };

  // Theme-aware colors (re-read on theme change)
  let col = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    col = {
      dark,
      land: rgba(cs.getPropertyValue("--ink"), dark ? 0.30 : 0.20),
      blue: parseRGB(cs.getPropertyValue("--blue")),
      bright: parseRGB(cs.getPropertyValue("--blue-bright")),
    };
  }
  function parseRGB(str) {
    str = str.trim();
    if (str.startsWith("#")) {
      const h = str.slice(1);
      const n = h.length === 3
        ? h.split("").map((c) => parseInt(c + c, 16))
        : [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      return n;
    }
    const m = str.match(/\d+/g);
    return m ? m.slice(0, 3).map(Number) : [60, 100, 255];
  }
  const rgba = (color, a) => { const [r,g,b] = parseRGB(color); return `rgba(${r},${g},${b},${a})`; };
  const blueA = (a) => `rgba(${col.blue[0]},${col.blue[1]},${col.blue[2]},${a})`;
  const brightA = (a) => `rgba(${col.bright[0]},${col.bright[1]},${col.bright[2]},${a})`;

  // lon/lat → canvas px (CSS units)
  function project(lon, lat) {
    const fx = (lon - W.lonMin) / (W.lonMax - W.lonMin);
    const fy = (W.latMax - lat) / (W.latMax - W.latMin);
    return [fit.x + fx * fit.w, fit.y + fy * fit.h];
  }

  function computeFit() {
    const pad = Math.min(cssW, cssH) * 0.04;
    const availW = cssW - pad * 2, availH = cssH - pad * 2;
    const worldAspect = (W.lonMax - W.lonMin) / (W.latMax - W.latMin);
    let w = availW, h = w / worldAspect;
    if (h > availH) { h = availH; w = h * worldAspect; }
    fit = { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [canvas, landLayer]) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    landCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeFit();
    renderLand();
    draw();
  }

  // Static land dots → offscreen layer
  function renderLand() {
    landCtx.clearRect(0, 0, cssW, cssH);
    const dotR = Math.max(0.6, (fit.w / W.gw) * 0.38);
    landCtx.fillStyle = col.land;
    for (let cy = 0; cy < W.gh; cy++) {
      for (let cx = 0; cx < W.gw; cx++) {
        if (!isLand(cx, cy)) continue;
        const lon = W.lonMin + (cx + 0.5) / W.gw * (W.lonMax - W.lonMin);
        const lat = W.latMax - (cy + 0.5) / W.gh * (W.latMax - W.latMin);
        const [x, y] = project(lon, lat);
        landCtx.beginPath();
        landCtx.arc(x, y, dotR, 0, Math.PI * 2);
        landCtx.fill();
      }
    }
  }

  function drawPoint(lon, lat, count) {
    const [x, y] = project(lon, lat);
    const t = Math.sqrt(count / maxCount);            // 0..1
    const glowR = (4 + t * 26) * (fit.w / 600 + 0.6);
    const coreR = (1.4 + t * 3.2) * (fit.w / 600 + 0.6);

    // glow
    const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    g.addColorStop(0, blueA(col.dark ? 0.55 : 0.42));
    g.addColorStop(0.5, blueA(col.dark ? 0.22 : 0.16));
    g.addColorStop(1, blueA(0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();

    // core
    ctx.fillStyle = brightA(0.95);
    ctx.beginPath(); ctx.arc(x, y, coreR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col.dark ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.85)";
    ctx.beginPath(); ctx.arc(x, y, coreR * 0.42, 0, Math.PI * 2); ctx.fill();
  }

  function draw(time) {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(landLayer, 0, 0, cssW, cssH);

    if (col.dark) ctx.globalCompositeOperation = "lighter";
    for (const p of points) drawPoint(p.lon, p.lat, p.count);
    ctx.globalCompositeOperation = "source-over";

    // pulse ring on the current visitor
    if (highlight && !reduceMotion) {
      const [x, y] = project(highlight.lon, highlight.lat);
      const phase = ((time || 0) % 2600) / 2600;       // 0..1
      const r = (3 + phase * 30) * (fit.w / 600 + 0.6);
      ctx.strokeStyle = brightA((1 - phase) * 0.7);
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    } else if (highlight) {
      const [x, y] = project(highlight.lon, highlight.lat);
      ctx.strokeStyle = brightA(0.6); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function loop(time) {
    draw(time);
    rafId = requestAnimationFrame(loop);
  }
  function startLoop() {
    if (rafId != null) return;
    if (highlight && !reduceMotion) rafId = requestAnimationFrame(loop);
    else draw();
  }
  function stopLoop() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }

  // ─── Public ───
  function init(el) {
    canvas = el;
    ctx = canvas.getContext("2d");
    landLayer = document.createElement("canvas");
    landCtx = landLayer.getContext("2d");
    readColors();
    resize();

    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 150); });

    // Pause animation when off-screen
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => {
        es.forEach((e) => { e.isIntersecting ? startLoop() : stopLoop(); });
      }, { threshold: 0.05 }).observe(canvas);
    }
  }

  function setData(pts, hi) {
    points = (pts || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    maxCount = points.reduce((m, p) => Math.max(m, p.count || 1), 1);
    highlight = hi || null;
    stopLoop();
    startLoop();
  }

  function refreshTheme() { readColors(); renderLand(); draw(); }

  return { init, setData, refreshTheme };
})();

window.Heatmap = Heatmap;
