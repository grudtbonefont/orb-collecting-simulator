// Map visuals only (own art): seeded zone-themed ground in cached chunk canvases, decor, border/door styling,
// ambient animated details and themed obstacle skins. No gameplay data lives here — sizes/hitboxes come from the caller.
(function () {
  function create(G) {
    const CH = 512, Z = G.ZONE_W, WW = G.WORLD.w, WH = G.WORLD.h;
    const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const P = {
      1: { base: '#62b24a', lite: '#78c65a', dark: '#55a240', grain: ['#86d466', '#4e9a3b', '#9be07a'], patchA: '#82cf62', patchB: '#58a744', path: '#cdb683', pathEdge: '#b9a06b', pathPeb: '#e6d8b0',
        rock: '#a9aba2', rockHi: '#d3d4cc', rockLo: '#7d7f77', tuft: ['#3f9232', '#4ea53c', '#74c457'], fly: '255,250,200' },
      2: { base: '#2f7034', lite: '#3a813c', dark: '#275f2c', grain: ['#3f8a3e', '#235427', '#5a7a35'], patchA: '#23592a', patchB: '#4a6b2e', path: '#6e5a3a', pathEdge: '#5a4830', pathPeb: '#8f7a55',
        rock: '#838b80', rockHi: '#a7b0a2', rockLo: '#585f55', tuft: ['#2f7d34', '#3f8f3c', '#57a447'], fly: '230,255,160' },
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
      add('rock', 1); add('tuft', 6); add('flower', 4); // meadow (zone 1)
      add('stump', 1); add('fern', 3); add('leaf', 5); if (r() < 0.35) add('mush', 1); // forest (zone 2)
      f = L.filter(d => d.x > 0 && d.x < WW && d.y > 0 && d.y < WH);
      if (featCache.size > 600) featCache.clear(); featCache.set(key, f); return f;
    }
    const R = { blob: 170, patch: 150, rock: 16, tuft: 10, flower: 14, mush: 8, bush: 28, stump: 18, fern: 20, leaf: 14, canopy: 130 };
    // ---------------------------------------------------------------- decor painters (world units)
    function rockShape(g, x, y, rr, seed, n = 8) { g.beginPath(); for (let i = 0; i < n; i++) { const a = i / n * 6.283 + seed, q = rr * (0.72 + 0.28 * Math.abs(Math.sin(seed * 9 + i * 1.7))); const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q * 0.8; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.closePath(); }
    function paintDecor(g, d, p, lod) {
      const s = d.s, z = d.z;
      const only = { flower: 1, rock: 1, bush: 2, stump: 2, fern: 2, leaf: 2, mush: 2, canopy: 2 }[d.k];
      if (only && only !== z) return;
      switch (d.k) {
        case 'rock': { const rr = 5 + s * 8; 
          g.fillStyle = p.rock; rockShape(g, d.x, d.y, rr, d.a); g.fill(); g.fillStyle = p.rockHi; rockShape(g, d.x - rr * 0.2, d.y - rr * 0.25, rr * 0.5, d.a + 1, 6); g.fill(); break; }
        case 'tuft': if (lod < 1) break; { const h = 6 + s * 7; g.strokeStyle = p.tuft[(d.v * 3) | 0]; g.lineWidth = 1.7; g.lineCap = 'round'; g.beginPath();
          for (let i = -2; i <= 2; i++) { g.moveTo(d.x + i * 1.6, d.y); g.quadraticCurveTo(d.x + i * 2.6, d.y - h * 0.6, d.x + i * 3.4 + (d.v - 0.5) * 3, d.y - h * (1 - Math.abs(i) * 0.15)); } g.stroke(); break; }
        case 'flower': if (lod < 0.5) break; { const cols = ['#ffffff', '#ffe45c', '#ff9ec7'], c = cols[(d.v * 3) | 0], n = 4 + ((s * 4) | 0);
          for (let i = 0; i < n; i++) { const a = i * 2.4 + d.a, q = 3 + (i * 37 % 11); const x = d.x + Math.cos(a) * q, y = d.y + Math.sin(a) * q * 0.8;
            g.fillStyle = c; g.beginPath(); g.arc(x, y, 1.7, 0, 6.283); g.fill(); if (lod >= 1) { g.fillStyle = c === '#ffe45c' ? '#e08a1a' : '#ffd23a'; g.fillRect(x - 0.5, y - 0.5, 1, 1); } } break; }
        case 'leaf': if (lod < 1) break; { const cols = ['#7a6a32', '#8a7a3a', '#5f6e2c']; for (let i = 0; i < 4; i++) { const a = d.a + i * 1.7, x = d.x + Math.cos(a) * 9 * s, y = d.y + Math.sin(a) * 7 * s;
            g.fillStyle = cols[(i + (d.v * 3 | 0)) % 3]; g.globalAlpha = 0.55; g.beginPath(); g.ellipse(x, y, 3.2, 1.6, a, 0, 6.283); g.fill(); } g.globalAlpha = 1; break; }
        case 'fern': if (lod < 1) break; { const l = 10 + s * 8; g.strokeStyle = '#4b9a45'; g.lineWidth = 1.4; g.lineCap = 'round';
          for (let k = 0; k < 4; k++) { const a = d.a + k * 1.57 + 0.3; g.beginPath(); g.moveTo(d.x, d.y); const ex = d.x + Math.cos(a) * l, ey = d.y + Math.sin(a) * l; g.lineTo(ex, ey);
            for (let j = 1; j <= 4; j++) { const t = j / 5, px = d.x + (ex - d.x) * t, py = d.y + (ey - d.y) * t, w = 4 * (1 - t) + 1; g.moveTo(px, py); g.lineTo(px + Math.cos(a + 1.1) * w, py + Math.sin(a + 1.1) * w); g.moveTo(px, py); g.lineTo(px + Math.cos(a - 1.1) * w, py + Math.sin(a - 1.1) * w); } g.stroke(); } break; }
        case 'bush': { const rr = 13 + s * 10; g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(d.x + 4, d.y + 5, rr * 1.05, rr * 0.9, 0, 0, 6.283); g.fill();
          for (const [ox, oy, k, c] of [[0, 0, 1, '#2f7a30'], [-0.45, -0.2, 0.62, '#3a8c38'], [0.4, -0.25, 0.58, '#3a8c38'], [-0.1, -0.4, 0.5, '#4ea046'], [0.15, 0.15, 0.45, '#358233']]) {
            g.fillStyle = c; g.beginPath(); g.arc(d.x + ox * rr, d.y + oy * rr, rr * k, 0, 6.283); g.fill(); }
          g.fillStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.arc(d.x - rr * 0.3, d.y - rr * 0.45, rr * 0.3, 0, 6.283); g.fill(); break; }
        case 'stump': { const rr = 9 + s * 6; 
          g.fillStyle = '#6b4a2b'; g.beginPath(); g.arc(d.x, d.y, rr, 0, 6.283); g.fill(); g.fillStyle = '#c79b62'; g.beginPath(); g.arc(d.x, d.y, rr * 0.78, 0, 6.283); g.fill();
          g.strokeStyle = 'rgba(110,70,35,.6)'; g.lineWidth = 1; for (const k of [0.55, 0.32]) { g.beginPath(); g.arc(d.x, d.y, rr * k, 0, 6.283); g.stroke(); }
          g.fillStyle = 'rgba(80,150,60,.7)'; g.beginPath(); g.arc(d.x + rr * 0.7, d.y - rr * 0.5, rr * 0.35, 0, 6.283); g.fill(); break; }
        case 'mush': if (lod < 0.5) break; { const c = 3 + s * 3; g.fillStyle = '#efe6cf'; g.fillRect(d.x - c * 0.25, d.y - c * 0.2, c * 0.5, c * 0.9);
          g.fillStyle = d.v > 0.5 ? '#c2563e' : '#a87a4c'; g.beginPath(); g.ellipse(d.x, d.y - c * 0.2, c, c * 0.6, 0, Math.PI, 0); g.closePath(); g.fill(); break; }
        case 'canopy': { const rr = 70 + s * 40; // top-down tree crown in the ground layer (always under entities), translucent
          g.fillStyle = 'rgba(10,40,15,.25)'; g.beginPath(); g.arc(d.x + 14, d.y + 16, rr, 0, 6.283); g.fill();
          g.fillStyle = '#5a3d22'; g.beginPath(); g.arc(d.x, d.y, 7, 0, 6.283); g.fill();
          g.globalAlpha = 0.72;
          for (let i = 0; i < 7; i++) { const a = d.a + i * 0.9, q = i ? rr * 0.5 : 0, k = i ? 0.55 : 0.7; g.fillStyle = i % 2 ? '#2d7a30' : '#358a36'; g.beginPath(); g.arc(d.x + Math.cos(a) * q, d.y + Math.sin(a) * q, rr * k, 0, 6.283); g.fill(); }
          g.fillStyle = 'rgba(160,220,120,.18)'; g.beginPath(); g.arc(d.x - rr * 0.25, d.y - rr * 0.3, rr * 0.4, 0, 6.283); g.fill(); g.globalAlpha = 1; break; }
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
      const r = rng(hash(cx, cy, 3 + zone)), n = lod < 1 ? 30 : 90;
      for (let i = 0; i < n; i++) { g.fillStyle = p.grain[(r() * 3) | 0]; g.globalAlpha = 0.08 + r() * 0.1; const sz = 1 + r() * 1.8; g.fillRect(x0 + r() * CH, y0 + r() * CH, sz, sz * (0.5 + r())); }
      g.globalAlpha = 1;
      // paths
      for (const pa of PATHS) { if (pa[0] !== zone || !pa[1] || pa[2] > 0.7 || pa[2] < 0.3) continue; const s0 = pa[1] ? x0 - 80 : y0 - 80, s1 = pa[1] ? x0 + CH + 80 : y0 + CH + 80;
        const pts = []; for (let s = Math.floor(s0 / 24) * 24; s <= s1; s += 24) pts.push(pathPt(pa, s));
        const vis = pts.some(([x, y]) => x > x0 - 80 && x < x0 + CH + 80 && y > y0 - 80 && y < y0 + CH + 80); if (!vis) continue;
        g.lineCap = 'round'; g.lineJoin = 'round';
        for (const [w, c, a] of [[70, p.pathEdge, 0.22], [54, p.path, 0.3]]) { g.strokeStyle = c; g.globalAlpha = a; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); }
        g.globalAlpha = 1;
        for (const [x, y] of pts) { const rr = rng(hash(Math.round(x), Math.round(y), 5)); for (let k = 0; k < (lod < 1 ? 0 : 1); k++) { g.fillStyle = p.pathPeb; g.globalAlpha = 0.3; const px = x + (rr() - 0.5) * 50, py = y + (rr() - 0.5) * 50; g.beginPath(); g.ellipse(px, py, 2 + rr() * 3, 1.5 + rr() * 2, rr() * 3, 0, 6.283); g.fill(); }
           }
        g.globalAlpha = 1; }
      const order = ['canopy', 'leaf', 'rock', 'stump', 'bush', 'fern', 'mush', 'flower', 'tuft'];
      const dec = near.filter(d => order.includes(d.k)).sort((a, b) => a.y - b.y);
      for (const d of dec) { paintDecor(g, d, p, lod); }
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
      if (budget.n <= 0) { for (const r2 of [1.5, 1, 0.5, 0.25]) { const o = cache.get(cx + ',' + cy + '@' + r2); if (o) return o.c; } return low.get(cx + ',' + cy) || null; }
      budget.n--; e = makeChunk(cx, cy, res); cache.set(key, e); pxUsed += e.px;
      while (pxUsed > PX_CAP && cache.size > 1) { const k = cache.keys().next().value; pxUsed -= cache.get(k).px; cache.delete(k); }
      return e.c;
    }
    // whole-world 0.25-res picture, baked a few chunks per frame after load (never evicted): the fallback while sharper chunks build
    const low = new Map(), NX = Math.ceil(WW / CH), NY = Math.ceil(WH / CH); let bakeI = 0;
    function prebake() { for (let k = 0; k < 3 && bakeI < NX * NY; k++, bakeI++) { const cx = bakeI % NX, cy = (bakeI / NX) | 0; low.set(cx + ',' + cy, makeChunk(cx, cy, 0.25).c); } }
    const resFor = (zoom, dpr) => { const q = zoom * dpr; const r = q >= 1.2 ? 1.5 : q >= 0.7 ? 1 : q >= 0.35 ? 0.5 : 0.25; return COARSE ? (zoom < 0.4 ? 0.25 : Math.min(1, r)) : r; };
    let stats = { chunks: 0, built: 0 };
    let gms = 0; // EMA of the ground's frame cost (ms) — window.OCSMapStats().ms
    function drawGround(g, cam, VW, VH, zoom, dpr, t) { const T0 = performance.now(); drawGround0(g, cam, VW, VH, zoom, dpr, t); gms = gms * 0.95 + (performance.now() - T0) * 0.05; stats.ms = +gms.toFixed(3); }
    function drawGround0(g, cam, VW, VH, zoom, dpr, t) {
      g.fillStyle = '#05060d'; g.fillRect(0, 0, VW, VH);
      const res = resFor(zoom, dpr), budget = { n: res <= 0.5 ? 8 : 3 }, n0 = budget.n;
      const cx0 = Math.max(0, Math.floor(cam.x / CH)), cx1 = Math.min(Math.ceil(WW / CH) - 1, Math.floor((cam.x + VW) / CH));
      const cy0 = Math.max(0, Math.floor(cam.y / CH)), cy1 = Math.min(Math.ceil(WH / CH) - 1, Math.floor((cam.y + VH) / CH));
      prebake(); let cnt = 0, flat = 0; const ov = 1 / (res * zoom * dpr) + 0.01;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = getChunk(cx, cy, res, budget); cnt++;
        const x = cx * CH - cam.x, y = cy * CH - cam.y, w = Math.min(CH, WW - cx * CH), h = Math.min(CH, WH - cy * CH);
        if (c) { const sw = Math.max(1, Math.floor(c.width * w / CH)), sh = Math.max(1, Math.floor(c.height * h / CH)); g.drawImage(c, 0, 0, sw, sh, x, y, w + (w < CH ? 0 : ov), h + (h < CH ? 0 : ov)); }
        else { flat++; g.fillStyle = P[zoneOf(cx * CH + CH / 2)].base; g.fillRect(x, y, w + ov, h + ov); }
      }
      stats = { chunks: cnt, built: n0 - budget.n, cache: cache.size, res, flat, flatMax: Math.max(flat, stats.flatMax || 0), baked: low.size };
    }
    // ambient vignette in screen space (under players/orbs, over the ground)
    function drawVignette(g, VW, VH) {
      // removed: no darkening of the screen edges (kept as a no-op for callers)
    }
    // ---------------------------------------------------------------- patterns: border + door wall + obstacle skins
    function pat(w, h, paint) { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h); return c; }
    const T = {};
    const bricks = (base, cols, moss) => (g, w, h) => { g.fillStyle = base; g.fillRect(0, 0, w, h); const r = rng(5);
      for (let row = 0; row < 4; row++) for (let i = -1; i < 4; i++) { const x = i * 32 + (row % 2) * 16, y = row * 16; g.fillStyle = cols[(r() * 3) | 0]; g.fillRect(x + 1.5, y + 1.5, 29, 13); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 2, y + 2, 27, 2); g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x + 2, y + 12, 27, 2); }
      for (let i = 0; i < moss; i++) { g.fillStyle = 'rgba(80,150,60,.6)'; g.beginPath(); g.ellipse(r() * w, r() * h, 4 + r() * 6, 2 + r() * 3, r() * 3, 0, 6.283); g.fill(); } };
    T.stone = pat(96, 64, bricks('#9a9a90', ['#c4c3b8', '#b6b5aa', '#cfcec4'], 0));           // zone 1: light stone
    T.mossy = pat(96, 64, bricks('#5e6459', ['#7f877a', '#737a6e', '#89917f'], 16));         // zone 2: mossy stone
    T.fence = pat(40, 64, (g, w, h) => { g.fillStyle = '#8a6238'; g.fillRect(0, 0, w, h); for (let i = 0; i < 2; i++) { const x = i * 20; g.fillStyle = i ? '#c8955a' : '#bb8a50'; g.fillRect(x + 1.5, 0, 17, h);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 3, 0, 2, h); g.strokeStyle = 'rgba(90,55,25,.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 10, 6); g.lineTo(x + 11, 30); g.moveTo(x + 8, 38); g.lineTo(x + 9, 58); g.stroke();
      g.fillStyle = '#6b4626'; g.beginPath(); g.arc(x + 10, 16, 1.3, 0, 6.283); g.arc(x + 10, 48, 1.3, 0, 6.283); g.fill(); } });
    T.log = pat(64, 32, (g, w, h) => { g.fillStyle = '#4e331c'; g.fillRect(0, 0, w, h); for (let i = 0; i < 2; i++) { const y = i * 16; const gr = g.createLinearGradient(0, y, 0, y + 16); gr.addColorStop(0, '#8a5e34'); gr.addColorStop(0.5, '#734c28'); gr.addColorStop(1, '#583a1e'); g.fillStyle = gr; g.fillRect(0, y + 1, w, 14);
      g.strokeStyle = 'rgba(40,25,10,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y + 6); g.bezierCurveTo(20, y + 4, 40, y + 9, 64, y + 6); g.stroke(); }
      g.fillStyle = 'rgba(80,150,60,.55)'; g.beginPath(); g.ellipse(18, 2, 8, 3, 0, 0, 6.283); g.ellipse(50, 17, 6, 2.5, 0, 0, 6.283); g.fill(); });
    const patterns = new WeakMap(); const ptn = (g, k) => { let m = patterns.get(g); if (!m) { m = {}; patterns.set(g, m); } return m[k] || (m[k] = g.createPattern(T[k], 'repeat')); };
    function drawBorder(g, t) {
      const B = 46;
      for (const [zone, x0, x1] of [[1, -B, Z], [2, Z, WW + B]]) {
        g.save(); g.beginPath(); g.rect(x0, -B, x1 - x0, WH + 2 * B); g.rect(0, 0, WW, WH); g.clip('evenodd');
        g.fillStyle = ptn(g, zone === 1 ? 'stone' : 'log'); g.fillRect(x0, -B, x1 - x0, WH + 2 * B); g.restore();
      }
      g.save(); g.lineWidth = 4; g.strokeStyle = 'rgba(60,50,30,.6)'; g.strokeRect(0, 0, WW, WH); g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 14; g.strokeRect(-B, -B, WW + 2 * B, WH + 2 * B); g.restore();
    }
    function drawDoorWall(g, y0, y1) {
      g.save(); g.fillStyle = ptn(g, 'stone'); g.fillRect(Z - 22, y0, 22, y1 - y0); g.fillStyle = ptn(g, 'log'); g.fillRect(Z, y0, 22, y1 - y0);
      for (let y = Math.floor(y0 / 220) * 220; y < y1; y += 220) { // posts
        g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(Z - 30, y + 4, 64, 34); g.fillStyle = '#c9c8bd'; g.fillRect(Z - 32, y, 32, 32); g.fillStyle = '#6e4a2a'; g.fillRect(Z, y, 32, 32);
        g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.strokeRect(Z - 32, y, 64, 32); g.fillStyle = 'rgba(255,255,255,.2)'; g.fillRect(Z - 30, y + 2, 60, 3);
        g.fillStyle = '#c79b62'; g.beginPath(); g.arc(Z + 16, y + 16, 9, 0, 6.283); g.fill(); g.strokeStyle = 'rgba(110,70,35,.6)'; g.lineWidth = 1; g.beginPath(); g.arc(Z + 16, y + 16, 5, 0, 6.283); g.stroke();
      }
      g.restore();
    }
    // obstacles — same geometry as before, themed by zone (zone 1: light stone / wooden fence, zone 2: logs / mossy stone)
    function rectObs(g, o, zone) {
      const x0 = o.x - o.w / 2, y0 = o.y - o.h / 2, long = Math.max(o.w, o.h) > Math.min(o.w, o.h) * 1.8;
      const k = zone === 1 ? (long ? 'fence' : 'stone') : (long ? 'log' : 'mossy');
      g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(x0 + 3, y0 + 6, o.w, o.h);
      g.save(); g.translate(x0, y0); if ((k === 'fence' && o.w > o.h) || (k === 'log' && o.h > o.w)) { g.rotate(-Math.PI / 2); g.translate(-o.h, 0); g.fillStyle = ptn(g, k); g.fillRect(0, 0, o.h, o.w); } else { g.fillStyle = ptn(g, k); g.fillRect(0, 0, o.w, o.h); } g.restore();
      const sh = g.createLinearGradient(x0, y0, x0 + o.w, y0 + o.h); sh.addColorStop(0, 'rgba(255,255,255,.12)'); sh.addColorStop(1, 'rgba(0,0,0,.22)'); g.fillStyle = sh; g.fillRect(x0, y0, o.w, o.h);
      g.strokeStyle = k === 'stone' ? '#6e6e66' : k === 'mossy' ? '#3a4036' : '#4a2f18'; g.lineWidth = 3; g.strokeRect(x0 + 1.5, y0 + 1.5, o.w - 3, o.h - 3);
    }
    function rockObs(g, o, zone) {
      const path = () => { g.beginPath(); for (let i = 0; i < 11; i++) { const a = i / 11 * Math.PI * 2, rr = o.r * (0.9 + 0.1 * Math.sin(o.id * 7 + i * 2.3)); i ? g.lineTo(o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr) : g.moveTo(o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr); } g.closePath(); };
      const gr = g.createRadialGradient(o.x - o.r * 0.35, o.y - o.r * 0.4, o.r * 0.1, o.x, o.y, o.r);
      if (zone === 1) { gr.addColorStop(0, '#e2e1d8'); gr.addColorStop(0.6, '#aeada3'); gr.addColorStop(1, '#7c7b73'); } else { gr.addColorStop(0, '#a3ab9c'); gr.addColorStop(0.6, '#6f776b'); gr.addColorStop(1, '#474d44'); }
      g.save(); g.translate(3, 6); g.fillStyle = 'rgba(0,0,0,.16)'; path(); g.fill(); g.restore(); g.fillStyle = gr; path(); g.fill();
      g.save(); path(); g.clip();
      g.fillStyle = zone === 1 ? 'rgba(110,180,80,.45)' : 'rgba(70,140,55,.8)'; g.beginPath(); g.ellipse(o.x - o.r * 0.2, o.y - o.r * 0.8, o.r * (zone === 1 ? 0.5 : 0.85), o.r * 0.4, -0.2, 0, 6.283); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 2; g.beginPath(); g.moveTo(o.x + o.r * 0.1, o.y - o.r * 0.1); g.lineTo(o.x + o.r * 0.45, o.y + o.r * 0.3); g.lineTo(o.x + o.r * 0.3, o.y + o.r * 0.6); g.stroke();
      g.restore();
      path(); g.strokeStyle = zone === 1 ? '#6a6a62' : '#3a4036'; g.lineWidth = 3; g.stroke();
      g.strokeStyle = '#4ea53c'; g.lineWidth = 2; g.lineCap = 'round'; g.beginPath(); for (let i = 0; i < 4; i++) { const a = o.id + i * 1.6, bx = o.x + Math.cos(a) * o.r * 0.95, by = o.y + Math.sin(a) * o.r * 0.95 + 2; for (let k = -1; k <= 1; k++) { g.moveTo(bx + k * 2, by); g.lineTo(bx + k * 3.5, by - 7); } } g.stroke();
    }
    function pylon(g, o, zone, armed, now) {
      const r = o.r;
            g.fillStyle = zone === 1 ? '#b9b8ad' : '#6e4a2a'; g.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283 + 0.39; i ? g.lineTo(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r) : g.moveTo(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r); } g.closePath(); g.fill();
      g.strokeStyle = zone === 1 ? '#c99a4a' : '#3f2a16'; g.lineWidth = 3; g.stroke();
      const gr = g.createRadialGradient(o.x - 4, o.y - 4, 1, o.x, o.y, r * 0.62); gr.addColorStop(0, '#ffd0d0'); gr.addColorStop(0.5, '#e01b30'); gr.addColorStop(1, '#4a0610');
      if (armed) { g.fillStyle = 'rgba(255,40,50,.25)'; g.beginPath(); g.arc(o.x, o.y, r * 0.8, 0, 6.283); g.fill(); }
      g.fillStyle = gr; g.beginPath(); g.arc(o.x, o.y, r * 0.6, 0, 6.283); g.fill(); g.strokeStyle = '#ff8a94'; g.lineWidth = 2; g.stroke();
    }
    function beamFx(g, o, ex, ey, zone, now) { // energy motes running along the (unchanged) red beam
      if (RM) return; g.fillStyle = '#ffe08a';
      for (let i = 0; i < 5; i++) { const k = ((now / 600 + i / 5) % 1), x = o.x + (ex - o.x) * k, y = o.y + (ey - o.y) * k; g.fillRect(x - 2, y - 2, 4, 4); }
    }
    const robotPal = zone => zone === 1 ? ['#f2efe6', '#b9b6a8', '#6f6c60', '#dcd8ca'] : ['#e0e6d6', '#8a9a74', '#3e4a34', '#b8c4a4'];
    return { drawGround, drawVignette, drawBorder, drawDoorWall, rectObs, rockObs, pylon, beamFx, robotPal, zoneOf, stats: () => stats, RM };
  }
  window.OCSMapArtCreate = create;
})();
