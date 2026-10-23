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
    const PAL = P;
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
      if (r() < 0.5) add('rock', 1); add('tuft', 3); add('flower', 2); // meadow (zone 1)
      if (r() < 0.5) add('stump', 1); add('fern', 1 + (r() < 0.5 ? 1 : 0)); add('leaf', 3); if (r() < 0.18) add('mush', 1); // forest (zone 2)
      // sparse decor hugging the inner side of the walls (border + both faces of the door wall)
      const edge = (x, y) => { const z = zoneOf(x), k = r() < 0.5 ? 'tuft' : (z === 1 ? (r() < 0.6 ? 'flower' : 'rock') : (r() < 0.5 ? 'fern' : 'leaf')); L.push({ k, x, y, z, s: r(), a: r() * 6.283, v: r() }); };
      for (let t = 0; t < CH; t += 90) { if (r() > 0.55) continue; const j = 30 + r() * 30, u = t + r() * 60;
        if (cy === 0) edge(x0 + u, j); if (y0 + CH >= WH && y0 < WH) edge(x0 + u, WH - j); if (cx === 0) edge(j, y0 + u); if (x0 + CH >= WW && x0 < WW) edge(WW - j, y0 + u);
        if (x0 <= Z && x0 + CH > Z) { edge(Z - 30 - j, y0 + u); edge(Z + 30 + j, y0 + t + r() * 60); } }
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
          g.fillStyle = '#5a4430'; g.beginPath(); g.arc(d.x, d.y, rr, 0, 6.283); g.fill(); g.fillStyle = '#8a6a45'; g.beginPath(); g.arc(d.x, d.y, rr * 0.72, 0, 6.283); g.fill();
          break; }
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
      for (const d of near) if (d.k === 'blob') { const rr = 90 + d.s * 80, gr = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, rr); const c = p.lite; g.globalAlpha = 0.5; gr.addColorStop(0, c); gr.addColorStop(1, c + '00'); g.fillStyle = gr; g.fillRect(d.x - rr, d.y - rr, rr * 2, rr * 2); g.globalAlpha = 1; }
      for (const d of near) if (d.k === 'patch') { const rr = 60 + d.s * 80; g.fillStyle = d.v > 0.5 ? p.patchA : p.patchB; g.globalAlpha = 0.22;
        const pts = []; for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283, q = rr * (0.78 + 0.22 * Math.sin(d.a * 5 + i * 2.1)); pts.push([d.x + Math.cos(a) * q, d.y + Math.sin(a) * q * 0.75]); }
        g.beginPath(); for (let i = 0; i <= 10; i++) { const A = pts[i % 10], B = pts[(i + 1) % 10], mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2; i ? g.quadraticCurveTo(A[0], A[1], mx, my) : g.moveTo(mx, my); } g.closePath(); g.fill(); g.globalAlpha = 1; }
      // grain (texture specks)
      const r = rng(hash(cx, cy, 3 + zone)), n = lod < 1 ? 30 : 90;
      for (let i = 0; i < n; i++) { g.fillStyle = p.grain[(r() * 3) | 0]; g.globalAlpha = 0.08 + r() * 0.1; const sz = 1 + r() * 1.8; g.fillRect(x0 + r() * CH, y0 + r() * CH, sz, sz * (0.5 + r())); }
      g.globalAlpha = 1;
      // paths
      for (const pa of []) { if (pa[0] !== zone || !pa[1] || pa[2] > 0.7 || pa[2] < 0.3) continue; const s0 = pa[1] ? x0 - 80 : y0 - 80, s1 = pa[1] ? x0 + CH + 80 : y0 + CH + 80;
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
    // polished flat skins (cached sprites). zone 1: warm stone slabs w/ grass rim, white picket fence; zone 2: bark logs w/ end rings, mossy stone w/ moss cap.
    const rr = (g, x, y, w, h, r) => { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    const circ = (g, x, y, r, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
    // ================================================================ walls & obstacles: one art set (flat cartoon, 3px dark outline, light from top-left)
    // zone 1 «поляна»: flowering hedges + rounded boulders; zone 2 «деревья»: top-down round-canopy trees + stumps
    const PZ = {
      hedge: { o: '#2b5a24', rim: '#3e8a35', base: '#57ab45', hi: '#82cf63', fl: ['#ffffff', '#ffe066', '#ff9ec7'] },
      tree: { o: '#123a1c', rim: '#1f5f2c', base: '#2f7f3a', hi: '#4fa24e', dot: '#256b32' },
      rock: { o: '#57544c', rim: '#8f8c80', base: '#bdbaad', hi: '#e2e0d6' },
      stump: { o: '#3f2a1a', bark: '#7a5232', top: '#d2a56b', in: '#bf8f58' } };
    const OW = 3;
    function hedgeMass(g, L) { const P = PZ.hedge; // merged cloud: all outlines, then rims, bases, highlights, flowers
      g.fillStyle = P.o; for (const p of L) { g.beginPath(); g.arc(p.x, p.y, p.r + OW, 0, 6.2832); g.fill(); }
      g.fillStyle = P.rim; for (const p of L) { g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.2832); g.fill(); }
      g.fillStyle = P.base; for (const p of L) { g.beginPath(); g.arc(p.x - p.r * 0.1, p.y - p.r * 0.13, p.r * 0.8, 0, 6.2832); g.fill(); }
      g.fillStyle = P.hi; for (const p of L) { g.beginPath(); g.ellipse(p.x - p.r * 0.32, p.y - p.r * 0.38, p.r * 0.34, p.r * 0.24, -0.6, 0, 6.2832); g.fill(); }
      for (const p of L) { if (p.v > 0.4) continue; const n = 1 + ((p.v * 10) | 0) % 3, fr = Math.max(1.8, p.r * 0.1);
        for (let i = 0; i < n; i++) { const a = p.v * 40 + i * 2.3, q = p.r * (0.25 + 0.4 * ((i * 0.37 + p.v) % 1)), x = p.x + Math.cos(a) * q, y = p.y + Math.sin(a) * q;
          g.fillStyle = P.fl[(i + ((p.v * 7) | 0)) % 3]; for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(x + Math.cos(k * 1.2566) * fr, y + Math.sin(k * 1.2566) * fr, fr * 0.75, 0, 6.2832); g.fill(); }
          g.fillStyle = '#f2a33a'; g.beginPath(); g.arc(x, y, fr * 0.6, 0, 6.2832); g.fill(); } } }
    function treeOne(g, p) { const P = PZ.tree, r = p.r; // single top-down canopy
      g.fillStyle = P.o; g.beginPath(); g.arc(p.x, p.y, r + OW, 0, 6.2832); g.fill();
      g.fillStyle = P.rim; g.beginPath(); g.arc(p.x, p.y, r, 0, 6.2832); g.fill();
      g.fillStyle = P.base; g.beginPath(); g.arc(p.x - r * 0.08, p.y - r * 0.1, r * 0.84, 0, 6.2832); g.fill();
      g.fillStyle = P.rim; for (let i = 0; i < 3; i++) { const a = p.v * 9 + i * 2.1, q = r * 0.5; g.beginPath(); g.arc(p.x + Math.cos(a) * q, p.y + Math.sin(a) * q, r * 0.2, a + 0.6, a + 2.6); g.lineTo(p.x + Math.cos(a) * q, p.y + Math.sin(a) * q); g.fill(); }
      g.fillStyle = P.hi; g.beginPath(); g.arc(p.x - r * 0.3, p.y - r * 0.32, r * 0.36, 0, 6.2832); g.fill();
      g.fillStyle = '#7cc46a'; g.beginPath(); g.arc(p.x - r * 0.4, p.y - r * 0.44, r * 0.12, 0, 6.2832); g.fill(); }
    function trees(g, L) { L = L.slice().sort((a, b) => a.y - b.y || a.x - b.x); for (const p of L) treeOne(g, p); }
    function boulderPath(g, cx, cy, rx, ry, seed) { const R = rng(seed), n = 9, P = []; for (let i = 0; i < n; i++) { const a = i / n * 6.2832 + 0.3, q = 0.9 + R() * 0.1, c = Math.cos(a), s = Math.sin(a), e = 1 / Math.pow(Math.pow(Math.abs(c), 3) + Math.pow(Math.abs(s), 3), 1 / 3);
        P.push({ x: cx + c * e * rx * q, y: cy + s * e * ry * q }); } g.beginPath(); smoothPath(g, P, true); }
    function boulder(g, cx, cy, rx, ry, seed) { const P = PZ.rock;
      boulderPath(g, cx, cy, rx, ry, seed); g.fillStyle = P.rim; g.fill(); g.lineWidth = OW * 2; g.strokeStyle = P.o; g.lineJoin = 'round';
      g.save(); boulderPath(g, cx, cy, rx, ry, seed); g.clip();
      boulderPath(g, cx - rx * 0.07, cy - ry * 0.1, rx * 0.86, ry * 0.82, seed); g.fillStyle = P.base; g.fill();
      g.fillStyle = P.hi; g.beginPath(); g.ellipse(cx - rx * 0.38, cy - ry * 0.42, Math.max(4, rx * 0.26), Math.max(3, ry * 0.15), -0.5, 0, 6.2832); g.fill();
      g.strokeStyle = P.rim; g.lineWidth = 2; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx + rx * 0.2, cy + ry * 0.05); g.lineTo(cx + rx * 0.38, cy + ry * 0.28); g.stroke();
      g.restore(); boulderPath(g, cx, cy, rx, ry, seed); g.lineWidth = OW; g.strokeStyle = P.o; g.stroke(); }
    function tufts(g, x0, x1, y, seed) { return; const R = rng(seed), L = []; for (let x = x0 + 6; x < x1 - 4; x += 14 + R() * 18) L.push({ x, y: y - 2 + R() * 3, r: 6 + R() * 3, v: 1 }); hedgeMass(g, L); }
    function stump(g, x, y, r) { const P = PZ.stump;
      g.fillStyle = P.o; for (let i = 0; i < 4; i++) { const a = 0.5 + i * 1.57 + (r % 3) * 0.2; g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, r * 0.32 + OW, r * 0.22 + OW, a, 0, 6.2832); g.fill(); }
      g.beginPath(); g.arc(x, y, r + OW, 0, 6.2832); g.fill();
      g.fillStyle = P.bark; for (let i = 0; i < 4; i++) { const a = 0.5 + i * 1.57 + (r % 3) * 0.2; g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85, r * 0.32, r * 0.22, a, 0, 6.2832); g.fill(); }
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
      g.fillStyle = P.top; g.beginPath(); g.arc(x - r * 0.04, y - r * 0.06, r * 0.78, 0, 6.2832); g.fill();
      g.strokeStyle = P.in; g.lineWidth = Math.max(1.5, r * 0.06); g.beginPath(); g.arc(x - r * 0.04, y - r * 0.06, r * 0.45, 0, 6.2832); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.ellipse(x - r * 0.35, y - r * 0.38, r * 0.22, r * 0.12, -0.6, 0, 6.2832); g.fill(); }
    function fillRect2(w, h, rMin, rMax, seed, inset) { // puffs covering a w×h box; edge puffs overhang ~0.3r outward
      const R = rng(seed), L = [], m = Math.min(w, h), r0 = Math.max(rMin, Math.min(rMax, m * 0.55)), st = r0 * 1.05;
      const nx = Math.max(1, Math.round((w - r0 * 1.4) / st) + 1), ny = Math.max(1, Math.round((h - r0 * 1.4) / st) + 1);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const r = r0 * (0.9 + R() * 0.2), x = nx === 1 ? w / 2 : r0 * inset + (w - 2 * r0 * inset) * i / (nx - 1), y = ny === 1 ? h / 2 : r0 * inset + (h - 2 * r0 * inset) * j / (ny - 1);
        L.push({ x: x + (R() - 0.5) * r0 * 0.15, y: y + (R() - 0.5) * r0 * 0.15, r, v: R() }); }
      return L; }
    function art(g, k, w, h) {
      if (k === 'hedge') { g.fillStyle = PZ.hedge.rim; rr(g, 4, 4, w - 8, h - 8, 6); g.fill(); hedgeMass(g, fillRect2(w, h, 12, 24, w * 7 + h, 0.7)); }
      else if (k === 'trees') { trees(g, fillRect2(w, h, 16, 34, w * 13 + h, 0.7)); }
      else if (k === 'boulder') { boulder(g, w / 2, h / 2, w / 2, h / 2, w * 3 + h); tufts(g, w * 0.12, w * 0.88, h - 3, w + h * 5); } }
    const sprites = new Map(); let spriteN = 0; const SS = 2, PAD = 16;
    function sprite(k, w, h) { const key = k + w + 'x' + h; let c = sprites.get(key); if (c) return c;
      if (sprites.size > 300) sprites.clear();
      c = document.createElement('canvas'); c.width = (w + PAD * 2) * SS; c.height = (h + PAD * 2) * SS; const g = c.getContext('2d'); g.scale(SS, SS); g.translate(PAD, PAD);
      art(g, k, w, h); sprites.set(key, c); spriteN++; return c; }
    const blit = (g, k, x, y, w, h) => g.drawImage(sprite(k, w, h), x - PAD, y - PAD, w + PAD * 2, h + PAD * 2);
    function smoothPath(g, P, closed) { // quadratic curves through midpoints
      const n = P.length, m = (a, b) => [(a.x + b.x) / 2, (a.y + b.y) / 2];
      if (closed) { let q = m(P[n - 1], P[0]); g.moveTo(q[0], q[1]); for (let i = 0; i < n; i++) { q = m(P[i], P[(i + 1) % n]); g.quadraticCurveTo(P[i].x, P[i].y, q[0], q[1]); } g.closePath(); }
      else { g.moveTo(P[0].x, P[0].y); for (let i = 1; i < n - 1; i++) { const q = m(P[i], P[i + 1]); g.quadraticCurveTo(P[i].x, P[i].y, q[0], q[1]); } g.lineTo(P[n - 1].x, P[n - 1].y); } }
    // ---------------------------------------------------------------- world border + door wall: global deterministic puff lists, baked into overlapping 512px chunks
    const OUT = 900; let WL = null;
    function initWalls() { if (WL) return; WL = { b1: [], b2: [], d1: [], d2: [] };
      const put = (z, x, y, r, v, door) => (door ? (z === 1 ? WL.d1 : WL.d2) : (z === 1 ? WL.b1 : WL.b2)).push({ x, y, r, v });
      // edge rows: tangent-ish to the real boundary, centre 0.7r outside -> ~0.3r soft overhang, edge fully covered
      const R = rng(9137), side = (x0, y0, x1, y1, nx, ny) => { const L = Math.hypot(x1 - x0, y1 - y0); let s = -40;
        while (s < L + 40) { const f = s / L, x = x0 + (x1 - x0) * f, z = x < Z ? 1 : 2, r = z === 1 ? 20 + R() * 7 : 30 + R() * 12;
          put(z, x + nx * r * 0.7, y0 + (y1 - y0) * f + ny * r * 0.7, r, R()); s += r * (z === 1 ? 1.0 : 1.1); } };
      side(0, 0, WW, 0, 0, -1); side(WW, 0, WW, WH, 1, 0); side(0, WH, WW, WH, 0, 1); side(0, 0, 0, WH, -1, 0);
      // fill behind the edge rows (fully outside the world)
      for (let gy = -OUT; gy < WH + OUT; gy += 46) for (let gx = -OUT; gx < WW + OUT; gx += 46) { const Rc = rng(hash(gx, gy, 77)), x = gx + Rc() * 40, y = gy + Rc() * 40, z = x < Z ? 1 : 2, r = z === 1 ? 24 + Rc() * 10 : 34 + Rc() * 14;
        const dx = Math.max(-x, x - WW, 0), dy = Math.max(-y, y - WH, 0); if (Math.hypot(dx, dy) < r * 1.6) continue; put(z, x, y, r, Rc()); }
      // door wall: hitbox x in [Z-22, Z+22]; hedge row on the zone-1 face, tree row on the zone-2 face
      const Rd = rng(5151); for (let y = -60; y < WH + 60; y += 0) { const r = 13 + Rd() * 3; put(1, Z - 22 + r * 0.72, y, r, Rd(), 1); y += r * 1.0; }
      for (let y = -60; y < WH + 60; y += 0) { const r = 14 + Rd() * 3; put(2, Z + 22 - r * 0.72, y, r, Rd(), 1); y += r * 1.05; }
      for (const k in WL) { const A = WL[k]; A.grid = new Map(); for (const p of A) { const key = Math.floor(p.x / 512) + ',' + Math.floor(p.y / 512); (A.grid.get(key) || A.grid.set(key, []).get(key)).push(p); } } }
    function near(A, x0, y0, x1, y1) { const out = []; for (let cy = Math.floor((y0 - 70) / 512); cy <= Math.floor((y1 + 70) / 512); cy++) for (let cx = Math.floor((x0 - 70) / 512); cx <= Math.floor((x1 + 70) / 512); cx++) for (const p of A.grid.get(cx + ',' + cy) || []) if (p.x + p.r + 6 > x0 && p.x - p.r - 6 < x1 && p.y + p.r + 6 > y0 && p.y - p.r - 6 < y1) out.push(p); return out; }
    function paintWalls(g, x0, y0, x1, y1, door) {
      if (door) { // solid body exactly on the hitbox, puffs on top
        g.fillStyle = PZ.hedge.rim; g.fillRect(Z - 22, y0, 22, y1 - y0); g.fillStyle = PZ.tree.rim; g.fillRect(Z, y0, 22, y1 - y0);
        trees(g, near(WL.d2, x0, y0, x1, y1)); hedgeMass(g, near(WL.d1, x0, y0, x1, y1)); return; }
      const outW = new Path2D(); outW.rect(-OUT - 100, -OUT - 100, WW + OUT * 2 + 200, WH + OUT * 2 + 200); outW.rect(0, 0, WW, WH);
      g.save(); g.clip(outW, 'evenodd'); g.fillStyle = PZ.hedge.rim; g.fillRect(x0, y0, Math.max(0, Math.min(x1, Z) - x0), y1 - y0); if (x1 > Z) { g.fillStyle = PZ.tree.rim; g.fillRect(Math.max(x0, Z), y0, x1 - Math.max(x0, Z), y1 - y0); } g.restore();
      hedgeMass(g, near(WL.b1, x0, y0, x1, y1)); trees(g, near(WL.b2, x0, y0, x1, y1)); }
    const WC = 512, WOV = 3, wallCache = new Map();
    function wallChunk(cx, cy, door) { const key = (door ? 'd' : 'b') + cx + ',' + cy; let c = wallCache.get(key); if (c) return c;
      if (wallCache.size > 90) wallCache.delete(wallCache.keys().next().value);
      const x0 = cx * WC - WOV, y0 = cy * WC - WOV, S = WC + WOV * 2; c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
      g.translate(-x0, -y0); paintWalls(g, x0, y0, x0 + S, y0 + S, door); wallCache.set(key, c); return c; }
    function viewRect(g) { const inv = g.getTransform().inverse(), a = inv.transformPoint({ x: 0, y: 0 }), b = inv.transformPoint({ x: g.canvas.width, y: g.canvas.height }); return [a.x, a.y, b.x, b.y]; }
    function drawChunks(g, door, X0, Y0, X1, Y1, need) { initWalls();
      for (let cy = Math.floor(Y0 / WC); cy <= Math.floor(Y1 / WC); cy++) for (let cx = Math.floor(X0 / WC); cx <= Math.floor(X1 / WC); cx++) {
        if (!need(cx * WC, cy * WC, cx * WC + WC, cy * WC + WC)) continue;
        g.drawImage(wallChunk(cx, cy, door), cx * WC - WOV, cy * WC - WOV, WC + WOV * 2, WC + WOV * 2); } }
    function drawBorder(g, t) { const [X0, Y0, X1, Y1] = viewRect(g), M = 80;
      drawChunks(g, false, Math.max(X0, -OUT), Math.max(Y0, -OUT), Math.min(X1, WW + OUT), Math.min(Y1, WH + OUT),
        (a, b, c, d) => a < M || b < M || c > WW - M || d > WH - M); }
    function drawDoorWall(g) { const [, Y0, , Y1] = viewRect(g); drawChunks(g, true, Z - 60, Math.max(-60, Y0), Z + 60, Math.min(WH + 60, Y1), (a, b, c) => a < Z + 60 && c > Z - 60); }
    function rectObs(g, o, zone) {
      const long = Math.max(o.w, o.h) > Math.min(o.w, o.h) * 1.8;
      const k = zone === 1 ? (long ? 'hedge' : 'boulder') : 'trees';
      blit(g, k, Math.round(o.x - o.w / 2), Math.round(o.y - o.h / 2), Math.round(o.w), Math.round(o.h));
    }
    const rockSpr = new Map();
    function rockObs(g, o, zone) { const r = Math.round(o.r), key = zone + ':' + r + ':' + (o.id % 5); let c = rockSpr.get(key);
      if (!c) { if (rockSpr.size > 200) rockSpr.clear(); const S = r * 2 + PAD * 2; c = document.createElement('canvas'); c.width = S * SS; c.height = S * SS; const q = c.getContext('2d'); q.scale(SS, SS); q.translate(S / 2, S / 2);
        if (zone === 1) { boulder(q, 0, 0, r, r * 0.95, r * 7 + (o.id % 5)); tufts(q, -r * 0.7, r * 0.7, r * 0.9, r + (o.id % 5)); } else stump(q, 0, 0, r * 0.95);
        rockSpr.set(key, c); }
      const S = r * 2 + PAD * 2; g.drawImage(c, o.x - S / 2, o.y - S / 2, S, S); }
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
