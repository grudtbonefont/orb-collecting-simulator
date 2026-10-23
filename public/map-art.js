// Map visuals only (own art): seeded zone-themed ground in cached chunk canvases, decor, border/door styling,
// ambient animated details and themed obstacle skins. No gameplay data lives here — sizes/hitboxes come from the caller.
(function () {
  function create(G) {
    const CH = 512, Z = G.ZONE_W, WW = G.WORLD.w, WH = G.WORLD.h;
    const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const P = {
      1: { base: '#16382f', lite: '#1f4a3a', dark: '#0f281f', grain: ['#2a5a40', '#0c2219', '#33623f'], patchA: '#245a36', patchB: '#3a3826', path: '#3d3a28', pathEdge: '#2a2a1c', pathPeb: '#5b5843',
        pool: '#1f6670', poolRim: 'rgba(140,230,220,.35)', rock: '#5f6b63', rockHi: '#7f8c81', rockLo: '#3f4842', tuft: ['#3f8a55', '#2f7046', '#4f9d5c'], cry: '#7fd6c8', lamp: '255,190,110', fly: '210,255,140' },
      2: { base: '#191334', lite: '#241b4a', dark: '#0e0a22', grain: ['#2d2358', '#0a0719', '#3a2b6a'], patchA: '#2a1f55', patchB: '#100c24', path: '#2a2050', pathEdge: '#1a1338', pathPeb: '#4c3d86',
        pool: '#4a2a9a', poolRim: 'rgba(200,150,255,.4)', rock: '#3c3558', rockHi: '#5a5080', rockLo: '#241f38', tuft: ['#6a50b0', '#5040a0', '#7d62c8'], cry: '#a98bff', lamp: '170,130,255', fly: '200,170,255' },
    };
    const zoneOf = x => (x < Z ? 1 : 2);
    function rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const hash = (x, y, s = 0) => (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s + 7, 83492791)) | 0;
    // global winding paths (continuous across chunks): [zone, horizontal?, base, amp1, f1, amp2, f2, phase]
    const PATHS = [[1, 1, 0.22, 260, 900, 90, 330, 0.3], [1, 1, 0.64, 220, 1100, 120, 410, 2.1], [1, 0, 0.45, 240, 1000, 80, 360, 4.2],
      [2, 1, 0.35, 200, 800, 110, 300, 1.4], [2, 1, 0.8, 240, 1200, 90, 380, 3.3], [2, 0, 0.6, 260, 950, 100, 340, 5.1]];
    const pathPt = (p, s) => { const off = p[3] * Math.sin(s / p[4] + p[7]) + p[5] * Math.sin(s / p[6] + p[7] * 2);
      return p[1] ? [s, p[2] * WH + off] : [(p[0] === 1 ? 0 : Z) + p[2] * Z + off, s]; };
    // features of one chunk (deterministic)
    const featCache = new Map();
    function feats(cx, cy) {
      const key = cx + ',' + cy; let f = featCache.get(key); if (f) return f;
      const r = rng(hash(cx, cy, 11)), x0 = cx * CH, y0 = cy * CH, L = [];
      const add = (k, n, extra) => { for (let i = 0; i < n; i++) { const x = x0 + r() * CH, y = y0 + r() * CH; L.push(Object.assign({ k, x, y, z: zoneOf(x), s: r(), a: r() * 6.283, v: r() }, extra ? extra(r) : null)); } };
      add('blob', 6); if (r() < 0.6) add('patch', 1); // calm ground: no pools, mushrooms, ruins or lanterns
      if (r() < 0.6) add('rock', 1); add('tuft', 7); add('flower', 3); add('cry', 2);
      f = L.filter(d => d.x > 0 && d.x < WW && d.y > 0 && d.y < WH);
      if (featCache.size > 600) featCache.clear(); featCache.set(key, f); return f;
    }
    const R = { blob: 170, patch: 150, pool: 70, rock: 20, tuft: 10, flower: 6, mush: 10, cry: 26, ruin: 50, lamp: 60 };
    // ---------------------------------------------------------------- decor painters (world units)
    function rockShape(g, x, y, rr, seed, n = 8) { g.beginPath(); for (let i = 0; i < n; i++) { const a = i / n * 6.283 + seed, q = rr * (0.72 + 0.28 * Math.abs(Math.sin(seed * 9 + i * 1.7))); const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q * 0.8; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.closePath(); }
    function paintDecor(g, d, p, lod) {
      const s = d.s;
      switch (d.k) {
        case 'rock': { const rr = 6 + s * 12; g.fillStyle = 'rgba(0,0,0,.28)'; rockShape(g, d.x + 2, d.y + 3, rr, d.a); g.fill();
          g.fillStyle = p.rock; rockShape(g, d.x, d.y, rr, d.a); g.fill(); g.fillStyle = p.rockHi; rockShape(g, d.x - rr * 0.2, d.y - rr * 0.25, rr * 0.55, d.a + 1, 6); g.fill();
          g.strokeStyle = p.rockLo; g.lineWidth = 1.5; rockShape(g, d.x, d.y, rr, d.a); g.stroke();
          if (d.z === 1 && d.v > 0.5) { g.fillStyle = 'rgba(80,150,80,.6)'; rockShape(g, d.x - rr * 0.3, d.y - rr * 0.4, rr * 0.4, d.a + 2, 5); g.fill(); } break; }
        case 'tuft': if (lod < 1) break; { const h = 6 + s * 8; g.strokeStyle = p.tuft[(d.v * 3) | 0]; g.lineWidth = d.z === 1 ? 1.8 : 1.3; g.lineCap = 'round'; g.beginPath();
          for (let i = -2; i <= 2; i++) { g.moveTo(d.x + i * 1.6, d.y); g.quadraticCurveTo(d.x + i * 2.6, d.y - h * 0.6, d.x + i * 3.4 + (d.v - 0.5) * 3, d.y - h * (1 - Math.abs(i) * 0.15)); } g.stroke(); break; }
        case 'flower': if (lod < 1 || d.z !== 1) break; { const cols = ['#d8c37c', '#c98aa8', '#a6b4e0', '#e0a27a']; g.strokeStyle = '#3a7a48'; g.lineWidth = 1; g.beginPath(); g.moveTo(d.x, d.y + 5); g.lineTo(d.x, d.y); g.stroke();
          g.fillStyle = cols[(d.v * 4) | 0]; g.globalAlpha = 0.85; for (let i = 0; i < 5; i++) { const a = i * 1.2566 + d.a; g.beginPath(); g.ellipse(d.x + Math.cos(a) * 2.2, d.y + Math.sin(a) * 2.2, 1.8, 1.1, a, 0, 6.283); g.fill(); }
          g.globalAlpha = 1; g.fillStyle = '#f3e3a0'; g.fillRect(d.x - 0.8, d.y - 0.8, 1.6, 1.6); break; }
        case 'mush': { const c = 4 + s * 5, cap = d.z === 1 ? (d.v > 0.5 ? '#a8584a' : '#9b7a52') : '#5fb8b0'; g.fillStyle = '#d9cfb8'; g.fillRect(d.x - c * 0.25, d.y - c * 0.2, c * 0.5, c * 0.9);
          if (d.z === 2) { g.fillStyle = 'rgba(95,200,190,.18)'; g.beginPath(); g.ellipse(d.x, d.y, c * 2.2, c * 1.6, 0, 0, 6.283); g.fill(); }
          g.fillStyle = cap; g.beginPath(); g.ellipse(d.x, d.y - c * 0.2, c, c * 0.55, 0, Math.PI, 0); g.closePath(); g.fill(); g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(d.x - c * 0.4, d.y - c * 0.55, c * 0.25, c * 0.15); break; }
        case 'cry': if (d.z === 1) break; { const n = 1 + ((d.v * 10) | 0) % 2, hgt = 8 + s * 8;
          g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(d.x + 3, d.y + 2, hgt * 0.5, hgt * 0.18, 0, 0, 6.283); g.fill();
          for (let i = 0; i < n; i++) { const a = -1.57 + (i - (n - 1) / 2) * 0.45, l = hgt * (1 - i * 0.18), w = 3.5 + s * 2.5, bx = d.x + (i - (n - 1) / 2) * 4;
            g.save(); g.translate(bx, d.y); g.rotate(a + 1.57); g.beginPath(); g.moveTo(-w, 0); g.lineTo(-w, -l * 0.75); g.lineTo(0, -l); g.lineTo(w, -l * 0.75); g.lineTo(w, 0); g.closePath();
            g.fillStyle = d.z === 2 ? 'rgba(130,100,230,.85)' : 'rgba(110,190,180,.8)'; g.fill(); g.fillStyle = 'rgba(255,255,255,.28)'; g.beginPath(); g.moveTo(-w, 0); g.lineTo(-w, -l * 0.75); g.lineTo(0, -l); g.lineTo(0, 0); g.closePath(); g.fill();
            g.strokeStyle = d.z === 2 ? 'rgba(40,20,90,.9)' : 'rgba(20,60,55,.9)'; g.lineWidth = 1.2; g.stroke(); g.restore(); } break; }
        case 'ruin': { const w = 26 + s * 18, x = d.x, y = d.y; g.save(); g.translate(x, y); g.rotate(d.a * 0.2 - 0.6);
          g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(-w / 2 + 4, -w / 2 + 5, w, w);
          g.fillStyle = d.z === 1 ? '#6d726a' : '#3a3460'; g.beginPath(); g.moveTo(-w / 2, -w / 2); g.lineTo(w / 2 - 6, -w / 2); g.lineTo(w / 2, -w / 2 + 8); g.lineTo(w / 2, w / 2); g.lineTo(-w / 2, w / 2); g.closePath(); g.fill();
          g.strokeStyle = d.z === 1 ? '#474b45' : '#221d40'; g.lineWidth = 2; g.stroke(); g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.moveTo(-w / 2 + 4, -w / 6); g.lineTo(w / 2 - 4, -w / 6); g.moveTo(0, -w / 6); g.lineTo(0, w / 2 - 3); g.stroke();
          if (d.z === 1) { g.fillStyle = 'rgba(80,150,80,.55)'; g.fillRect(-w / 2, -w / 2, w * 0.5, 5); } else { g.strokeStyle = 'rgba(170,130,255,.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-5, 6); g.lineTo(0, -2); g.lineTo(5, 6); g.moveTo(-3, 3); g.lineTo(3, 3); g.stroke(); }
          g.fillStyle = d.z === 1 ? '#5f645c' : '#332d55'; g.fillRect(w / 2 + 6, w / 4, w * 0.45, w * 0.3); g.restore(); break; }
        case 'lamp': { const gl = g.createRadialGradient(d.x, d.y - 10, 2, d.x, d.y - 10, 55); gl.addColorStop(0, `rgba(${p.lamp},.22)`); gl.addColorStop(1, `rgba(${p.lamp},0)`); g.fillStyle = gl; g.fillRect(d.x - 56, d.y - 66, 112, 112);
          g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(d.x - 2, d.y - 2, 9, 4); g.fillStyle = '#2a2622'; g.fillRect(d.x - 1.5, d.y - 14, 3, 15);
          g.fillStyle = '#3a332b'; g.fillRect(d.x - 5, d.y - 22, 10, 9); g.fillStyle = `rgba(${p.lamp},.95)`; g.fillRect(d.x - 3, d.y - 20, 6, 5); break; }
      }
    }
    function paintZone(g, cx, cy, zone, lod) {
      const p = P[zone], x0 = cx * CH, y0 = cy * CH;
      g.fillStyle = p.base; g.fillRect(x0, y0, CH, CH);
      const near = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const d of feats(cx + i, cy + j)) if (d.z === zone && d.x + R[d.k] > x0 && d.x - R[d.k] < x0 + CH && d.y + R[d.k] > y0 && d.y - R[d.k] < y0 + CH) near.push(d);
      for (const d of near) if (d.k === 'blob') { const rr = 90 + d.s * 80, gr = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, rr); const c = d.v > 0.5 ? p.lite : p.dark; g.globalAlpha = 0.5; gr.addColorStop(0, c); gr.addColorStop(1, c + '00'); g.fillStyle = gr; g.fillRect(d.x - rr, d.y - rr, rr * 2, rr * 2); g.globalAlpha = 1; }
      for (const d of near) if (d.k === 'patch') { const rr = 60 + d.s * 80; g.fillStyle = d.v > 0.5 ? p.patchA : p.patchB; g.globalAlpha = 0.22;
        const pts = []; for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283, q = rr * (0.78 + 0.22 * Math.sin(d.a * 5 + i * 2.1)); pts.push([d.x + Math.cos(a) * q, d.y + Math.sin(a) * q * 0.75]); }
        g.beginPath(); for (let i = 0; i <= 10; i++) { const A = pts[i % 10], B = pts[(i + 1) % 10], mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2; i ? g.quadraticCurveTo(A[0], A[1], mx, my) : g.moveTo(mx, my); } g.closePath(); g.fill(); g.globalAlpha = 1; }
      // grain (texture specks)
      const r = rng(hash(cx, cy, 3 + zone)), n = lod < 1 ? 30 : 110;
      for (let i = 0; i < n; i++) { g.fillStyle = p.grain[(r() * 3) | 0]; g.globalAlpha = 0.15 + r() * 0.2; const sz = 1 + r() * 1.8; g.fillRect(x0 + r() * CH, y0 + r() * CH, sz, sz * (0.5 + r())); }
      g.globalAlpha = 1;
      // paths
      for (const pa of PATHS) { if (pa[0] !== zone || !pa[1] || pa[2] > 0.7) continue; const s0 = pa[1] ? x0 - 80 : y0 - 80, s1 = pa[1] ? x0 + CH + 80 : y0 + CH + 80;
        const pts = []; for (let s = Math.floor(s0 / 24) * 24; s <= s1; s += 24) pts.push(pathPt(pa, s));
        const vis = pts.some(([x, y]) => x > x0 - 80 && x < x0 + CH + 80 && y > y0 - 80 && y < y0 + CH + 80); if (!vis) continue;
        g.lineCap = 'round'; g.lineJoin = 'round';
        for (const [w, c, a] of [[70, p.pathEdge, 0.22], [54, p.path, 0.3]]) { g.strokeStyle = c; g.globalAlpha = a; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); }
        g.globalAlpha = 1;
        for (const [x, y] of pts) { const rr = rng(hash(Math.round(x), Math.round(y), 5)); for (let k = 0; k < (lod < 1 ? 0 : 1); k++) { g.fillStyle = p.pathPeb; g.globalAlpha = 0.3; const px = x + (rr() - 0.5) * 50, py = y + (rr() - 0.5) * 50; g.beginPath(); g.ellipse(px, py, 2 + rr() * 3, 1.5 + rr() * 2, rr() * 3, 0, 6.283); g.fill(); }
          if (zone === 2 && rr() < 0.05) { g.globalAlpha = 0.45; g.fillStyle = '#8c6bff'; g.fillRect(x - 2, y - 2, 4, 4); } }
        g.globalAlpha = 1; }
      const order = ['ruin', 'rock', 'mush', 'cry', 'flower', 'tuft', 'lamp'];
      const dec = near.filter(d => order.includes(d.k)).sort((a, b) => a.y - b.y);
      for (const d of dec) { if (lod < 0.5 && (d.k === 'mush' || d.k === 'lamp')) continue; paintDecor(g, d, p, lod); }
    }
    // ---------------------------------------------------------------- chunk cache
    const cache = new Map(); let pxUsed = 0; const PX_CAP = COARSE ? 9e6 : 16e6;
    function makeChunk(cx, cy, res) {
      const sz = Math.max(16, Math.round(CH * res)), c = document.createElement('canvas'); c.width = c.height = sz;
      const g = c.getContext('2d'); g.scale(sz / CH, sz / CH); g.translate(-cx * CH, -cy * CH);
      const lod = res >= 0.5 ? 1 : res >= 0.3 ? 0.5 : 0.25, x0 = cx * CH, x1 = x0 + CH;
      for (const zone of [1, 2]) { const zx0 = zone === 1 ? 0 : Z, zx1 = zone === 1 ? Z : WW; if (x1 <= zx0 || x0 >= zx1) continue;
        g.save(); g.beginPath(); g.rect(Math.max(x0, zx0), cy * CH, Math.min(x1, zx1) - Math.max(x0, zx0), CH); g.clip(); paintZone(g, cx, cy, zone, lod); g.restore(); }
      return { c, px: sz * sz };
    }
    function getChunk(cx, cy, res, budget) {
      const key = cx + ',' + cy + '@' + res; let e = cache.get(key);
      if (e) { cache.delete(key); cache.set(key, e); return e.c; }
      if (budget.n <= 0) { for (const r2 of [1.5, 1, 0.5, 0.25]) { const o = cache.get(cx + ',' + cy + '@' + r2); if (o) return o.c; } return null; }
      budget.n--; e = makeChunk(cx, cy, res); cache.set(key, e); pxUsed += e.px;
      while (pxUsed > PX_CAP && cache.size > 1) { const k = cache.keys().next().value; pxUsed -= cache.get(k).px; cache.delete(k); }
      return e.c;
    }
    const resFor = (zoom, dpr) => { const q = zoom * dpr; const r = q >= 1.2 ? 1.5 : q >= 0.7 ? 1 : q >= 0.35 ? 0.5 : 0.25; return COARSE ? (zoom < 0.4 ? 0.25 : Math.min(1, r)) : r; };
    let stats = { chunks: 0, built: 0 };
    function drawGround(g, cam, VW, VH, zoom, dpr, t) {
      g.fillStyle = '#05060d'; g.fillRect(0, 0, VW, VH);
      const res = resFor(zoom, dpr), budget = { n: res <= 0.5 ? 8 : 3 }, n0 = budget.n;
      const cx0 = Math.max(0, Math.floor(cam.x / CH)), cx1 = Math.min(Math.ceil(WW / CH) - 1, Math.floor((cam.x + VW) / CH));
      const cy0 = Math.max(0, Math.floor(cam.y / CH)), cy1 = Math.min(Math.ceil(WH / CH) - 1, Math.floor((cam.y + VH) / CH));
      let cnt = 0; const ov = 1 / (res * zoom * dpr) + 0.01;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = getChunk(cx, cy, res, budget); cnt++;
        const x = cx * CH - cam.x, y = cy * CH - cam.y, w = Math.min(CH, WW - cx * CH), h = Math.min(CH, WH - cy * CH);
        if (c) g.drawImage(c, 0, 0, c.width * w / CH, c.height * h / CH, x, y, w + ov, h + ov);
        else { g.fillStyle = P[zoneOf(cx * CH + CH / 2)].base; g.fillRect(x, y, w + ov, h + ov); }
      }
      stats = { chunks: cnt, built: n0 - budget.n, cache: cache.size, res };
      // live details: swaying grass, fireflies, crystal shimmer (skipped when zoomed far out)
      if (zoom >= 0.45) {
        g.save(); g.translate(-cam.x, -cam.y);
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
          const r = rng(hash(cx, cy, 21));
          for (let i = 0; i < 2; i++) { const x = cx * CH + r() * CH, y = cy * CH + r() * CH, z = zoneOf(x), p = P[z], h = 12 + r() * 9, sw = RM ? 0 : Math.sin(t * 1.7 + x * 0.013 + y * 0.007) * 3.2;
            if (x > WW || y > WH) continue;
            g.strokeStyle = p.tuft[i % 3]; g.lineWidth = z === 1 ? 2 : 1.5; g.lineCap = 'round'; g.beginPath();
            for (let k = -2; k <= 2; k++) { g.moveTo(x + k * 2, y); g.quadraticCurveTo(x + k * 3 + sw * 0.4, y - h * 0.55, x + k * 4.2 + sw, y - h * (1 - Math.abs(k) * 0.14)); } g.stroke(); }
          if (!RM) {
            for (let i = 0; i < 1; i++) { const bx = cx * CH + r() * CH, by = cy * CH + r() * CH, ph = r() * 9, z = zoneOf(bx); if (r() < 0.6) continue;
              const x = bx + Math.sin(t * 0.6 + ph) * 40, y = by + Math.cos(t * 0.45 + ph * 1.3) * 30, a = 0.35 + 0.65 * Math.max(0, Math.sin(t * 1.9 + ph * 3));
              if (x > WW || y > WH) continue;
              const gl = g.createRadialGradient(x, y, 0, x, y, 9); gl.addColorStop(0, `rgba(${P[z].fly},${0.55 * a})`); gl.addColorStop(1, `rgba(${P[z].fly},0)`); g.fillStyle = gl; g.fillRect(x - 9, y - 9, 18, 18);
              g.fillStyle = `rgba(255,255,230,${0.9 * a})`; g.fillRect(x - 1, y - 1, 2, 2); }
            for (const d of feats(cx, cy)) if (d.k === 'cry' && d.z === 2 && d.v < 0.4) { const a = Math.max(0, Math.sin(t * 2.3 + d.a * 7)); if (a < 0.7) continue;
              const x = d.x + (d.v - 0.5) * 8, y = d.y - (8 + d.s * 8) * 0.8, s = 4 * (a - 0.7) / 0.3 + 1; g.fillStyle = `rgba(255,255,255,${(a - 0.7) * 3})`;
              g.beginPath(); g.moveTo(x, y - s * 2); g.lineTo(x + s * 0.4, y); g.lineTo(x, y + s * 2); g.lineTo(x - s * 0.4, y); g.closePath(); g.fill(); g.fillRect(x - s * 1.6, y - 0.6, s * 3.2, 1.2); }
          }
        }
        g.restore();
      }
    }
    // ambient vignette in screen space (under players/orbs, over the ground)
    function drawVignette(g, VW, VH) {
      const vg = g.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,8,0.45)'); g.fillStyle = vg; g.fillRect(0, 0, VW, VH);
    }
    // ---------------------------------------------------------------- patterns: border + door wall + obstacle skins
    function pat(w, h, paint) { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return c; }
    const T = {};
    T.stone = pat(96, 64, (g, w, h) => { g.fillStyle = '#4a514a'; g.fillRect(0, 0, w, h); const r = rng(5);
      for (let row = 0; row < 4; row++) for (let i = -1; i < 4; i++) { const x = i * 32 + (row % 2) * 16, y = row * 16; g.fillStyle = ['#5c645b', '#535a52', '#666e63'][(r() * 3) | 0]; g.fillRect(x + 1.5, y + 1.5, 29, 13); g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(x + 2, y + 2, 27, 2); g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x + 2, y + 12, 27, 2); }
      for (let i = 0; i < 14; i++) { g.fillStyle = 'rgba(90,160,80,.55)'; g.beginPath(); g.ellipse(r() * w, r() * h, 4 + r() * 6, 2 + r() * 3, r() * 3, 0, 6.283); g.fill(); } });
    T.obsidian = pat(96, 96, (g, w, h) => { g.fillStyle = '#1a1530'; g.fillRect(0, 0, w, h); const r = rng(9);
      for (let i = 0; i < 9; i++) { g.fillStyle = ['#241d42', '#15112a', '#2c2350'][(r() * 3) | 0]; g.beginPath(); const x = r() * w, y = r() * h; g.moveTo(x, y); for (let k = 0; k < 4; k++) g.lineTo(x + (r() - 0.5) * 50, y + (r() - 0.5) * 50); g.closePath(); g.fill(); }
      g.strokeStyle = 'rgba(160,120,255,.35)'; g.lineWidth = 1.2; g.beginPath(); for (let i = 0; i < 5; i++) { let x = r() * w, y = r() * h; g.moveTo(x, y); for (let k = 0; k < 3; k++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; g.lineTo(x, y); } } g.stroke(); });
    const patterns = new WeakMap(); const ptn = (g, k) => { let m = patterns.get(g); if (!m) { m = {}; patterns.set(g, m); } return m[k] || (m[k] = g.createPattern(T[k], 'repeat')); };
    function drawBorder(g, t) {
      const B = 46;
      for (const [zone, x0, x1] of [[1, -B, Z], [2, Z, WW + B]]) {
        g.save(); g.beginPath(); g.rect(x0, -B, x1 - x0, WH + 2 * B); g.rect(0, 0, WW, WH); g.clip('evenodd');
        g.fillStyle = ptn(g, zone === 1 ? 'stone' : 'obsidian'); g.fillRect(x0, -B, x1 - x0, WH + 2 * B); g.restore();
      }
      g.save(); g.lineWidth = 4; g.strokeStyle = '#2b3a2c'; g.beginPath(); g.moveTo(Z, 0); g.lineTo(0, 0); g.lineTo(0, WH); g.lineTo(Z, WH); g.stroke();
      g.strokeStyle = 'rgba(160,120,255,.9)'; g.shadowColor = '#8c5cff'; g.shadowBlur = RM ? 8 : 10 + 6 * Math.sin(t * 2); g.beginPath(); g.moveTo(Z, 0); g.lineTo(WW, 0); g.lineTo(WW, WH); g.lineTo(Z, WH); g.stroke(); g.restore();
      g.save(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 14; g.strokeRect(-B, -B, WW + 2 * B, WH + 2 * B); g.restore();
    }
    function drawDoorWall(g, y0, y1) {
      g.save(); g.fillStyle = ptn(g, 'stone'); g.fillRect(Z - 22, y0, 22, y1 - y0); g.fillStyle = ptn(g, 'obsidian'); g.fillRect(Z, y0, 22, y1 - y0);
      for (let y = Math.floor(y0 / 220) * 220; y < y1; y += 220) { // pillars
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(Z - 30, y + 4, 64, 34); g.fillStyle = '#6a7268'; g.fillRect(Z - 32, y, 32, 32); g.fillStyle = '#3a3168'; g.fillRect(Z, y, 32, 32);
        g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 2; g.strokeRect(Z - 32, y, 64, 32); g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(Z - 30, y + 2, 60, 3);
        g.fillStyle = 'rgba(180,140,255,.85)'; g.fillRect(Z + 12, y + 10, 8, 12); g.fillStyle = 'rgba(110,190,110,.8)'; g.fillRect(Z - 22, y + 4, 14, 5);
      }
      g.restore();
    }
    // obstacles — same geometry as before, themed by zone
    function rectObs(g, o, zone) {
      const x0 = o.x - o.w / 2, y0 = o.y - o.h / 2;
      g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 16; g.shadowOffsetY = 6; g.fillStyle = zone === 1 ? '#4a514a' : '#1a1530'; g.fillRect(x0, y0, o.w, o.h); g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.save(); g.translate(x0, y0); g.fillStyle = ptn(g, zone === 1 ? 'stone' : 'obsidian'); g.fillRect(0, 0, o.w, o.h); g.restore();
      const sh = g.createLinearGradient(x0, y0, x0 + o.w, y0 + o.h); sh.addColorStop(0, 'rgba(255,255,255,.12)'); sh.addColorStop(1, 'rgba(0,0,0,.3)'); g.fillStyle = sh; g.fillRect(x0, y0, o.w, o.h);
      if (zone === 1) { g.fillStyle = 'rgba(80,150,70,.75)'; for (let i = 0; i < o.w; i += 14) { const hh = 4 + 4 * Math.abs(Math.sin(o.id * 3 + i)); g.fillRect(x0 + i, y0, 12, hh); } }
      else { g.strokeStyle = 'rgba(180,140,255,.75)'; g.shadowColor = '#9d6bff'; g.shadowBlur = 10; g.lineWidth = 2; const cx = o.x, cy = o.y, s = Math.min(o.w, o.h) * 0.22;
        g.beginPath(); g.moveTo(cx - s, cy + s); g.lineTo(cx, cy - s); g.lineTo(cx + s, cy + s); g.moveTo(cx - s * 0.6, cy + s * 0.2); g.lineTo(cx + s * 0.6, cy + s * 0.2); g.stroke(); g.shadowBlur = 0; }
      g.strokeStyle = zone === 1 ? '#262b26' : '#0b0818'; g.lineWidth = 3; g.strokeRect(x0 + 1.5, y0 + 1.5, o.w - 3, o.h - 3);
      g.strokeStyle = zone === 1 ? 'rgba(200,220,190,.35)' : 'rgba(170,140,255,.55)'; g.lineWidth = 1.5; g.strokeRect(x0 + 4, y0 + 4, o.w - 8, o.h - 8);
    }
    function rockObs(g, o, zone) {
      const path = () => { g.beginPath(); for (let i = 0; i < 11; i++) { const a = i / 11 * Math.PI * 2, rr = o.r * (0.9 + 0.1 * Math.sin(o.id * 7 + i * 2.3)); i ? g.lineTo(o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr) : g.moveTo(o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr); } g.closePath(); };
      const gr = g.createRadialGradient(o.x - o.r * 0.35, o.y - o.r * 0.4, o.r * 0.1, o.x, o.y, o.r);
      if (zone === 1) { gr.addColorStop(0, '#9aa294'); gr.addColorStop(0.6, '#646c60'); gr.addColorStop(1, '#3c423a'); } else { gr.addColorStop(0, '#5d5390'); gr.addColorStop(0.6, '#2e2752'); gr.addColorStop(1, '#16122a'); }
      g.fillStyle = gr; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 16; g.shadowOffsetY = 6; path(); g.fill(); g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.save(); path(); g.clip();
      if (zone === 1) { g.fillStyle = 'rgba(90,160,80,.7)'; g.beginPath(); g.ellipse(o.x - o.r * 0.2, o.y - o.r * 0.75, o.r * 0.7, o.r * 0.35, -0.2, 0, 6.283); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(o.x + o.r * 0.1, o.y - o.r * 0.1); g.lineTo(o.x + o.r * 0.45, o.y + o.r * 0.3); g.lineTo(o.x + o.r * 0.3, o.y + o.r * 0.6); g.stroke(); }
      else { for (let i = 0; i < 3; i++) { const a = o.id * 2 + i * 2.1, bx = o.x + Math.cos(a) * o.r * 0.45, by = o.y + Math.sin(a) * o.r * 0.45; g.fillStyle = 'rgba(160,120,255,.85)';
        g.beginPath(); g.moveTo(bx, by - o.r * 0.32); g.lineTo(bx + o.r * 0.12, by); g.lineTo(bx, by + o.r * 0.2); g.lineTo(bx - o.r * 0.12, by); g.closePath(); g.fill(); g.fillStyle = 'rgba(255,255,255,.4)'; g.fillRect(bx - 1, by - o.r * 0.2, 2, o.r * 0.15); } }
      g.restore();
      path(); g.strokeStyle = zone === 1 ? '#2a2f28' : '#0c0918'; g.lineWidth = 3; g.stroke();
      if (zone === 1) { g.strokeStyle = '#4f9d5c'; g.lineWidth = 2; g.lineCap = 'round'; g.beginPath(); for (let i = 0; i < 4; i++) { const a = o.id + i * 1.6, bx = o.x + Math.cos(a) * o.r * 0.95, by = o.y + Math.sin(a) * o.r * 0.95 + 2; for (let k = -1; k <= 1; k++) { g.moveTo(bx + k * 2, by); g.lineTo(bx + k * 3.5, by - 7); } } g.stroke(); }
    }
    function pylon(g, o, zone, armed, now) {
      const r = o.r;
      g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12; g.shadowOffsetY = 5;
      g.fillStyle = zone === 1 ? '#5c6259' : '#221b40'; g.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283 + 0.39; i ? g.lineTo(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r) : g.moveTo(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r); } g.closePath(); g.fill();
      g.shadowBlur = 0; g.shadowOffsetY = 0; g.strokeStyle = zone === 1 ? '#c99a4a' : '#a27bff'; g.lineWidth = 3; g.stroke();
      const gr = g.createRadialGradient(o.x - 4, o.y - 4, 1, o.x, o.y, r * 0.62); gr.addColorStop(0, '#ffd0d0'); gr.addColorStop(0.5, '#e01b30'); gr.addColorStop(1, '#4a0610');
      g.fillStyle = gr; g.shadowColor = '#ff2030'; g.shadowBlur = armed ? 20 : 8 + 6 * Math.sin(now / 70);
      g.beginPath(); if (zone === 1) g.arc(o.x, o.y, r * 0.6, 0, 6.283); else { g.moveTo(o.x, o.y - r * 0.7); g.lineTo(o.x + r * 0.5, o.y); g.lineTo(o.x, o.y + r * 0.7); g.lineTo(o.x - r * 0.5, o.y); g.closePath(); } g.fill(); g.shadowBlur = 0;
      g.strokeStyle = '#ff8a94'; g.lineWidth = 2; g.stroke();
    }
    function beamFx(g, o, ex, ey, zone, now) { // themed energy motes running along the (unchanged) red beam
      if (RM) return; const L = Math.hypot(ex - o.x, ey - o.y) || 1;
      g.fillStyle = zone === 1 ? '#ffd27a' : '#ff9cf0';
      for (let i = 0; i < 5; i++) { const k = ((now / 600 + i / 5) % 1), x = o.x + (ex - o.x) * k, y = o.y + (ey - o.y) * k; g.globalAlpha *= 1; g.fillRect(x - 2, y - 2, 4, 4); }
      void L;
    }
    const robotPal = zone => zone === 1 ? ['#e9dcc0', '#b08d5a', '#6e5636', '#d4bf93'] : ['#c9c3e8', '#6f66a0', '#2f2a52', '#9c92d0'];
    return { drawGround, drawVignette, drawBorder, drawDoorWall, rectObs, rockObs, pylon, beamFx, robotPal, zoneOf, stats: () => stats, RM };
  }
  window.OCSMapArtCreate = create;
})();
