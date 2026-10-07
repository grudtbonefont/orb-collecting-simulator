/* Item Collecting Simulator — browser client (vanilla JS, no build step) */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }
  resize();
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------ identity
  function genToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.random() * 256);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  let token = localStorage.getItem('ics_token');
  if (!token || !/^[A-Za-z0-9-]{16,64}$/.test(token)) { token = genToken(); localStorage.setItem('ics_token', token); }
  $('nick').value = localStorage.getItem('ics_nick') || '';

  // ------------------------------------------------------------ state
  const socket = io({ transports: ['websocket', 'polling'] });
  let joined = false, wantJoin = false, myName = '', myId = null, profile = null, sessionScore = 0;
  const players = new Map();   // id -> {id,name,eq,trail:[],dir:{x,y},pos:{x,y}}
  const snapshots = [];        // {time, map}
  const orbs = new Map();      // id -> {x,y,t,born}
  const fx = [], floaters = [];
  const me = { x: 0, y: 0 }, prevMe = { x: 0, y: 0 }, corr = { x: 0, y: 0 }, cam = { x: 0, y: 0 };
  let pending = [], seq = 0, lastStepAt = 0, myDir = { x: 1, y: 0 };
  const keys = {};
  const pointer = { down: false, x: 0, y: 0 };

  const itemVal = id => (G.ITEM_BY_ID[id] || {}).value;
  const mySpeed = () => G.speedFor(profile ? profile.upgrades.speed : 0);
  const myPickup = () => G.pickupFor(profile ? profile.upgrades.magnet : 0);
  const fmt = n => Number(n).toLocaleString('ru-RU');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rainbow = (t, off = 0) => `hsl(${((t * 90 + off) % 360 + 360) % 360},100%,62%)`;
  const colorOf = (eq, t) => { const v = itemVal(eq.color) || '#3ee0ff'; return v === 'rainbow' ? rainbow(t) : v; };

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  // ------------------------------------------------------------ join / connection
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('nick').value.trim();
    if (name.length < 2) { $('joinError').textContent = 'Введите ник (минимум 2 символа)'; return; }
    myName = name; wantJoin = true; doJoin();
  });
  function doJoin() {
    if (!socket.connected) { $('joinError').textContent = 'Подключение к серверу…'; return; }
    socket.emit('join', { name: myName, token }, res => {
      if (!res || !res.ok) { wantJoin = false; joined = false; $('joinError').textContent = (res && res.error) || 'Ошибка входа'; showStart(); return; }
      $('joinError').textContent = '';
      localStorage.setItem('ics_nick', myName);
      myId = res.you; profile = res.profile; myName = profile.name; sessionScore = 0;
      players.clear(); orbs.clear(); snapshots.length = 0; pending = []; seq = 0; fx.length = 0;
      for (const p of res.players) addPlayer(p);
      const mine = players.get(myId);
      me.x = prevMe.x = mine.pos.x; me.y = prevMe.y = mine.pos.y; corr.x = corr.y = 0;
      const now = performance.now();
      for (const [id, x, y, t] of res.orbs) orbs.set(id, { x, y, t, born: now - 1000 });
      joined = true;
      $('start').classList.add('hidden'); $('hud').classList.remove('hidden');
      updateHud();
      toast(`Добро пожаловать, ${myName}! Собирайте сферы.`, 'ok');
    });
  }
  function showStart() {
    $('start').classList.remove('hidden'); $('hud').classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    loadStartLb();
  }
  socket.on('connect', () => { if (wantJoin) doJoin(); else if ($('joinError').textContent === 'Подключение к серверу…') $('joinError').textContent = ''; });
  socket.on('disconnect', () => { if (joined) toast('Соединение потеряно, переподключаемся…', 'err'); joined = false; });
  socket.on('kicked', msg => { wantJoin = false; joined = false; $('joinError').textContent = msg; showStart(); });

  function addPlayer(p) {
    players.set(p.id, { id: p.id, name: p.name, eq: p.eq, trail: [], dir: { x: 1, y: 0 }, pos: { x: p.x, y: p.y }, last: { x: p.x, y: p.y } });
  }
  socket.on('pjoin', p => { if (!players.has(p.id)) addPlayer(p); });
  socket.on('pleave', id => players.delete(id));
  socket.on('pmeta', p => { const pl = players.get(p.id); if (pl) { pl.eq = p.eq; pl.name = p.name; } });
  socket.on('sping', v => socket.emit('spong', v));
  socket.on('announce', a => toast('✨ ' + a.text));

  socket.on('s', st => {
    if (!joined) return;
    const now = performance.now();
    const map = new Map();
    for (const [id, x, y, ack] of st.p) {
      map.set(id, [x, y]);
      if (id === myId) reconcile(x, y, ack);
    }
    snapshots.push({ time: now, map });
    while (snapshots.length > 40) snapshots.shift();
    for (const [id, x, y, t] of st.oa) orbs.set(id, { x, y, t, born: now });
    for (const [id, pid] of st.od) {
      const o = orbs.get(id);
      if (!o) continue;
      orbs.delete(id);
      fx.push({ o, pid, start: now });
      if (pid === myId) {
        const ot = G.ORB_TYPES[o.t];
        floaters.push({ x: o.x, y: o.y - 10, text: '+' + ot.value, color: ot.color, start: now, big: o.t !== 'c' });
      }
    }
  });
  function reconcile(x, y, ack) {
    pending = pending.filter(i => i.s > ack);
    const p = { x, y };
    for (const i of pending) G.applyInput(p, i.x, i.y, mySpeed());
    const ex = me.x - p.x, ey = me.y - p.y;
    if (Math.abs(ex) + Math.abs(ey) > 0.01) {
      if (Math.hypot(ex, ey) > 250) { corr.x = corr.y = 0; prevMe.x = p.x; prevMe.y = p.y; }
      else { corr.x += ex; corr.y += ey; }
      me.x = p.x; me.y = p.y;
      prevMe.x -= ex; prevMe.y -= ey;
    }
  }

  socket.on('bal', b => {
    if (!profile) return;
    profile.balance = b.b; profile.total = b.t; sessionScore = b.s;
    updateHud(true);
  });
  socket.on('profile', p => { profile = p; updateHud(); if (!$('shop').classList.contains('hidden')) renderShop(); });
  socket.on('top', d => {
    $('hudOnline').textContent = d.online;
    $('hudTop').innerHTML = d.top.map(([id, name, s]) => `<li class="${id === myId ? 'me' : ''}">${esc(name)} <b>${fmt(s)}</b></li>`).join('');
  });

  function updateHud(bump) {
    if (!profile) return;
    $('hudBalance').textContent = fmt(profile.balance);
    $('hudTotal').textContent = fmt(profile.total);
    $('hudSession').textContent = fmt(sessionScore);
    document.querySelectorAll('.bal').forEach(e => e.textContent = fmt(profile.balance));
    if (bump) { const b = $('hudBalance').parentElement; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    if (!$('games').classList.contains('hidden')) updateGameButtons();
  }

  // ------------------------------------------------------------ input
  const anyModal = () => Array.from(document.querySelectorAll('.modal')).some(m => !m.classList.contains('hidden'));
  window.addEventListener('keydown', e => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    keys[e.code] = true;
    if (!joined) return;
    if (e.code === 'Escape') closeModals();
    if (e.code === 'KeyB') toggleModal('shop');
    if (e.code === 'KeyM') toggleModal('games');
    if (e.code === 'KeyL') toggleModal('lb');
    if (e.code === 'Space' && reactionState === 'go' || e.code === 'Space' && reactionState === 'wait') { e.preventDefault(); reactionClick(); }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; pointer.down = false; });
  canvas.addEventListener('pointerdown', e => { pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; });
  window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; });
  window.addEventListener('pointerup', () => { pointer.down = false; });
  window.addEventListener('pointercancel', () => { pointer.down = false; });

  function getDir() {
    if (anyModal()) return { x: 0, y: 0 };
    let x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    let y = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (x || y) { const l = Math.hypot(x, y); return { x: x / l, y: y / l }; }
    if (pointer.down) {
      const dx = pointer.x - (dispMe.x - cam.x), dy = pointer.y - (dispMe.y - cam.y);
      const d = Math.hypot(dx, dy);
      if (d < 8) return { x: 0, y: 0 };
      const mag = Math.min(1, d / 90);
      return { x: dx / d * mag, y: dy / d * mag };
    }
    return { x: 0, y: 0 };
  }
  const r3 = v => Math.round(v * 1000) / 1000;
  setInterval(() => {
    if (!joined || !socket.connected) return;
    const d = getDir();
    const inp = { s: ++seq, x: r3(d.x), y: r3(d.y) };
    socket.emit('input', inp);
    prevMe.x = me.x; prevMe.y = me.y;
    G.applyInput(me, inp.x, inp.y, mySpeed());
    pending.push(inp);
    if (pending.length > 80) pending.shift();
    lastStepAt = performance.now();
    if (inp.x || inp.y) { const l = Math.hypot(inp.x, inp.y); myDir = { x: inp.x / l, y: inp.y / l }; }
  }, G.TICK_MS);

  // ------------------------------------------------------------ rendering helpers
  const orbSprites = {};
  for (const t of Object.values(G.ORB_TYPES)) {
    const size = Math.ceil(t.r * 8), c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d'), mid = size;
    const grd = g.createRadialGradient(mid, mid, 0, mid, mid, size);
    grd.addColorStop(0, t.glow + '0.55)'); grd.addColorStop(0.18, t.glow + '0.28)'); grd.addColorStop(0.45, t.glow + '0.08)'); grd.addColorStop(1, t.glow + '0)');
    g.fillStyle = grd; g.fillRect(0, 0, size * 2, size * 2);
    const core = g.createRadialGradient(mid - t.r * 0.35, mid - t.r * 0.35, 0, mid, mid, t.r * 2);
    core.addColorStop(0, '#ffffff'); core.addColorStop(0.35, t.color); core.addColorStop(1, t.glow + '0.9)');
    g.fillStyle = core; g.beginPath(); g.arc(mid, mid, t.r * 2, 0, Math.PI * 2); g.fill();
    orbSprites[t.key] = { c, half: size / 2 };
  }
  function drawOrb(g, x, y, type, t, id, scale = 1) {
    const s = orbSprites[type], ot = G.ORB_TYPES[type];
    const pulse = (1 + 0.09 * Math.sin(t * 3.2 + id * 1.7)) * scale;
    const half = s.half * pulse;
    g.drawImage(s.c, x - half, y - half, half * 2, half * 2);
    if (type === 'l') {
      g.save(); g.translate(x, y); g.rotate(t * 1.4);
      g.strokeStyle = 'rgba(255,240,180,0.85)'; g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.moveTo(Math.cos(a) * ot.r * 1.2, Math.sin(a) * ot.r * 1.2); g.lineTo(Math.cos(a) * ot.r * 2.4 * pulse, Math.sin(a) * ot.r * 2.4 * pulse); }
      g.stroke(); g.restore();
    }
  }

  const SHAPE_TOP = { circle: 1, square: 0.9, triangle: 1.15, hexagon: 1.05, star: 1.3 };
  function shapePath(g, shape, r, t) {
    g.beginPath();
    if (shape === 'square') {
      const s = r * 0.9, k = r * 0.28;
      g.moveTo(-s + k, -s); g.lineTo(s - k, -s); g.quadraticCurveTo(s, -s, s, -s + k); g.lineTo(s, s - k); g.quadraticCurveTo(s, s, s - k, s);
      g.lineTo(-s + k, s); g.quadraticCurveTo(-s, s, -s, s - k); g.lineTo(-s, -s + k); g.quadraticCurveTo(-s, -s, -s + k, -s);
    } else if (shape === 'triangle') {
      for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 3; const x = Math.cos(a) * r * 1.3, y = Math.sin(a) * r * 1.15 + r * 0.15; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    } else if (shape === 'hexagon') {
      for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; const x = Math.cos(a) * r * 1.08, y = Math.sin(a) * r * 1.05; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    } else if (shape === 'star') {
      const rot = t * 0.6;
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5 + rot; const rr = i % 2 ? r * 0.62 : r * 1.3; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    } else {
      g.arc(0, 0, r, 0, Math.PI * 2);
    }
    g.closePath();
  }

  function drawHat(g, hat, r, top, t) {
    const y = -top * r;
    g.save();
    if (hat === 'cap') {
      g.fillStyle = '#ff4d5e'; g.shadowColor = '#ff4d5e'; g.shadowBlur = 8;
      g.beginPath(); g.arc(0, y + 4, r * 0.62, Math.PI, 0); g.closePath(); g.fill();
      g.fillStyle = '#d93245'; g.beginPath(); g.ellipse(r * 0.45, y + 4, r * 0.5, r * 0.14, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(0, y - r * 0.6 + 4, 2.5, 0, Math.PI * 2); g.fill();
    } else if (hat === 'tophat') {
      g.fillStyle = '#15151c'; g.strokeStyle = '#555a75'; g.lineWidth = 1;
      g.fillRect(-r * 0.75, y - 1, r * 1.5, 5); g.strokeRect(-r * 0.75, y - 1, r * 1.5, 5);
      g.fillRect(-r * 0.48, y - r * 1.05, r * 0.96, r * 1.05); g.strokeRect(-r * 0.48, y - r * 1.05, r * 0.96, r * 1.05);
      g.fillStyle = '#b46bff'; g.shadowColor = '#b46bff'; g.shadowBlur = 8; g.fillRect(-r * 0.48, y - r * 0.38, r * 0.96, 4);
    } else if (hat === 'halo') {
      g.strokeStyle = '#ffe680'; g.lineWidth = 3.5; g.shadowColor = '#ffd84d'; g.shadowBlur = 16;
      g.beginPath(); g.ellipse(0, y - 9 + Math.sin(t * 2.5) * 2, r * 0.75, r * 0.24, 0, 0, Math.PI * 2); g.stroke();
    } else if (hat === 'crown') {
      const w = r * 0.85, h = r * 0.75, by = y + 3;
      g.fillStyle = '#ffcc33'; g.shadowColor = '#ffcc33'; g.shadowBlur = 14;
      g.beginPath(); g.moveTo(-w, by); g.lineTo(-w, by - h * 0.7); g.lineTo(-w * 0.5, by - h * 0.35); g.lineTo(0, by - h); g.lineTo(w * 0.5, by - h * 0.35); g.lineTo(w, by - h * 0.7); g.lineTo(w, by); g.closePath(); g.fill();
      g.shadowBlur = 0;
      const gems = ['#ff4d6d', '#3ee0ff', '#9dff4f'];
      [-w * 0.55, 0, w * 0.55].forEach((gx, i) => { g.fillStyle = gems[i]; g.beginPath(); g.arc(gx, by - h * 0.22, 2.6, 0, Math.PI * 2); g.fill(); });
    }
    g.restore();
  }

  function drawAvatar(g, x, y, r, eq, t, opts = {}) {
    const color = colorOf(eq, t + (opts.phase || 0));
    const shape = itemVal(eq.shape) || 'circle';
    const top = SHAPE_TOP[shape] || 1;
    g.save(); g.translate(x, y);
    g.shadowColor = color; g.shadowBlur = opts.isMe ? 26 : 18;
    shapePath(g, shape, r, t);
    const grd = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.1, 0, 0, r * 1.4);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, color); grd.addColorStop(1, color);
    g.fillStyle = grd; g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.45)'; g.stroke();
    // eyes
    const d = opts.dir || { x: 1, y: 0 };
    for (const s of [-1, 1]) {
      const ex = d.x * r * 0.3 + (-d.y) * s * r * 0.32, ey = d.y * r * 0.3 + d.x * s * r * 0.32 - r * 0.05;
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ex, ey, r * 0.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#10142a'; g.beginPath(); g.arc(ex + d.x * r * 0.07, ey + d.y * r * 0.07, r * 0.1, 0, Math.PI * 2); g.fill();
    }
    const hat = itemVal(eq.hat) || 'none';
    if (hat !== 'none') drawHat(g, hat, r, top, t);
    if (opts.name) {
      const ny = -top * r - (hat === 'none' ? 10 : hat === 'tophat' ? r * 1.05 + 8 : 22);
      g.font = `700 ${opts.isMe ? 14 : 13}px Segoe UI, system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      const nc = itemVal(eq.nameColor) || '#fff';
      let fill = nc;
      if (nc === 'rainbow') {
        const w = g.measureText(opts.name).width;
        fill = g.createLinearGradient(-w / 2, 0, w / 2, 0);
        for (let i = 0; i <= 4; i++) fill.addColorStop(i / 4, rainbow(t, i * 70));
      }
      g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.strokeText(opts.name, 0, ny);
      g.fillStyle = fill; g.fillText(opts.name, 0, ny);
    }
    g.restore();
  }

  function drawTrail(g, pl, t, now) {
    const kind = itemVal(pl.eq.trail) || 'none';
    if (kind === 'none' || pl.trail.length < 2) return;
    const pts = pl.trail, n = pts.length;
    g.save();
    if (kind === 'neon') {
      const color = colorOf(pl.eq, t);
      g.lineCap = 'round'; g.shadowColor = color; g.shadowBlur = 14; g.strokeStyle = color;
      for (let i = 1; i < n; i++) {
        const k = i / n;
        g.globalAlpha = k * 0.75; g.lineWidth = 3 + k * 12;
        g.beginPath(); g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); g.stroke();
      }
    } else if (kind === 'sparks') {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const p = pts[i], age = (now - p.time) / 700, k = 1 - age;
        if (k <= 0) continue;
        for (let j = 0; j < 2; j++) {
          const a = p.seed * 6.28 + j * 3.1, dist = (1 - k) * 22 + 4;
          g.globalAlpha = k;
          g.fillStyle = j ? '#ffffff' : colorOf(pl.eq, t + i * 0.05);
          g.beginPath(); g.arc(p.x + Math.cos(a) * dist, p.y + Math.sin(a) * dist, 1.5 + k * 2.2, 0, Math.PI * 2); g.fill();
        }
      }
    } else if (kind === 'fire') {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const p = pts[i], k = 1 - (now - p.time) / 650;
        if (k <= 0) continue;
        const rr = 4 + k * 13;
        const grd = g.createRadialGradient(p.x, p.y - (1 - k) * 10, 0, p.x, p.y - (1 - k) * 10, rr);
        grd.addColorStop(0, `rgba(255,240,150,${0.7 * k})`); grd.addColorStop(0.4, `rgba(255,140,30,${0.55 * k})`); grd.addColorStop(1, 'rgba(255,40,0,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(p.x, p.y - (1 - k) * 10, rr, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  }

  // ------------------------------------------------------------ main loop
  const dispMe = { x: 0, y: 0 };
  function interpPositions(now) {
    const out = new Map();
    if (!snapshots.length) return out;
    const rt = now - 110;
    let a = null, b = null;
    for (let i = snapshots.length - 1; i >= 0; i--) { if (snapshots[i].time <= rt) { a = snapshots[i]; b = snapshots[i + 1] || null; break; } }
    if (!a) { a = snapshots[0]; b = null; }
    for (const [id, pa] of a.map) {
      const pb = b && b.map.get(id);
      if (pb) { const k = Math.min(1, (rt - a.time) / Math.max(1, b.time - a.time)); out.set(id, { x: pa[0] + (pb[0] - pa[0]) * k, y: pa[1] + (pb[1] - pa[1]) * k }); }
      else out.set(id, { x: pa[0], y: pa[1] });
    }
    // players that only exist in newest snapshot
    const last = snapshots[snapshots.length - 1];
    for (const [id, p] of last.map) if (!out.has(id)) out.set(id, { x: p[0], y: p[1] });
    return out;
  }

  let frameNo = 0;
  function frame() {
    requestAnimationFrame(frame);
    frameNo++;
    const now = performance.now(), t = now / 1000;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!joined) { drawIdleBackground(t); return; }

    const a = Math.min(1, (now - lastStepAt) / G.TICK_MS);
    corr.x *= 0.86; corr.y *= 0.86;
    dispMe.x = prevMe.x + (me.x - prevMe.x) * a + corr.x;
    dispMe.y = prevMe.y + (me.y - prevMe.y) * a + corr.y;
    cam.x = dispMe.x - W / 2; cam.y = dispMe.y - H / 2;

    const pos = interpPositions(now);
    pos.set(myId, { x: dispMe.x, y: dispMe.y });
    for (const pl of players.values()) {
      const p = pos.get(pl.id);
      if (!p) continue;
      const dx = p.x - pl.last.x, dy = p.y - pl.last.y, dd = Math.hypot(dx, dy);
      if (pl.id === myId) pl.dir = myDir;
      else if (dd > 0.5) pl.dir = { x: dx / dd, y: dy / dd };
      if (dd > 5) { pl.trail.push({ x: p.x, y: p.y, time: now, seed: Math.random() }); pl.last = { x: p.x, y: p.y }; }
      while (pl.trail.length && (now - pl.trail[0].time > 650 || pl.trail.length > 26)) pl.trail.shift();
      pl.pos = p;
    }

    drawBackground(t);
    ctx.save(); ctx.translate(-cam.x, -cam.y);
    // world border
    ctx.strokeStyle = 'rgba(120,90,255,0.8)'; ctx.lineWidth = 4; ctx.shadowColor = '#7a5cff'; ctx.shadowBlur = 20;
    ctx.strokeRect(0, 0, G.WORLD.w, G.WORLD.h); ctx.shadowBlur = 0;

    // orbs
    const pad = 60;
    for (const [id, o] of orbs) {
      if (o.x < cam.x - pad || o.x > cam.x + W + pad || o.y < cam.y - pad || o.y > cam.y + H + pad) continue;
      const k = Math.min(1, (now - o.born) / 350);
      drawOrb(ctx, o.x, o.y, o.t, t, id, k);
    }
    // collect fx
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i], k = (now - f.start) / 220;
      const target = pos.get(f.pid);
      if (k >= 1 || !target) { fx.splice(i, 1); continue; }
      const x = f.o.x + (target.x - f.o.x) * k * k, y = f.o.y + (target.y - f.o.y) * k * k;
      drawOrb(ctx, x, y, f.o.t, t, 0, 1 - k * 0.7);
    }
    // magnet ring
    if (profile && profile.upgrades.magnet > 0) {
      ctx.save(); ctx.strokeStyle = 'rgba(62,224,255,0.18)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 1.5;
      ctx.lineDashOffset = -t * 20;
      ctx.beginPath(); ctx.arc(dispMe.x, dispMe.y, myPickup(), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    // trails then players (me last)
    for (const pl of players.values()) drawTrail(ctx, pl, t, now);
    const order = Array.from(players.values()).sort((p, q) => (p.id === myId) - (q.id === myId));
    for (const pl of order) {
      if (!pl.pos) continue;
      if (pl.pos.x < cam.x - 120 || pl.pos.x > cam.x + W + 120 || pl.pos.y < cam.y - 120 || pl.pos.y > cam.y + H + 120) continue;
      drawAvatar(ctx, pl.pos.x, pl.pos.y, G.PLAYER_R, pl.eq, t, { name: pl.name, dir: pl.dir, isMe: pl.id === myId, phase: pl.id });
    }
    // floating texts
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i], k = (now - f.start) / 900;
      if (k >= 1) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - k; ctx.fillStyle = f.color; ctx.font = `800 ${f.big ? 22 : 15}px Segoe UI, sans-serif`; ctx.textAlign = 'center';
      ctx.shadowColor = f.color; ctx.shadowBlur = 10;
      ctx.fillText(f.text, f.x, f.y - k * 40); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (frameNo % 4 === 0) drawMinimap();
    if (!$('shop').classList.contains('hidden')) drawShopPreviews(t, now);
    if (rushActive) drawRush(now);
  }

  function drawBackground(t) {
    ctx.fillStyle = '#060912'; ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(30,40,100,0.25)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    const step = 64;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(90,120,255,0.09)';
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(cam.x / step) * step), x1 = Math.min(G.WORLD.w, cam.x + W);
    const y0 = Math.max(0, Math.floor(cam.y / step) * step), y1 = Math.min(G.WORLD.h, cam.y + H);
    for (let x = x0; x <= x1; x += step) { ctx.moveTo(x - cam.x + 0.5, Math.max(0, -cam.y)); ctx.lineTo(x - cam.x + 0.5, Math.min(H, G.WORLD.h - cam.y)); }
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(Math.max(0, -cam.x), y - cam.y + 0.5); ctx.lineTo(Math.min(W, G.WORLD.w - cam.x), y - cam.y + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,120,255,0.16)'; ctx.beginPath();
    for (let x = Math.max(0, Math.floor(cam.x / 512) * 512); x <= x1; x += 512) { ctx.moveTo(x - cam.x + 0.5, Math.max(0, -cam.y)); ctx.lineTo(x - cam.x + 0.5, Math.min(H, G.WORLD.h - cam.y)); }
    for (let y = Math.max(0, Math.floor(cam.y / 512) * 512); y <= y1; y += 512) { ctx.moveTo(Math.max(0, -cam.x), y - cam.y + 0.5); ctx.lineTo(Math.min(W, G.WORLD.w - cam.x), y - cam.y + 0.5); }
    ctx.stroke();
  }
  const idleOrbs = Array.from({ length: 60 }, (_, i) => ({ x: Math.random(), y: Math.random(), t: i % 25 === 0 ? 'l' : i % 6 === 0 ? 'r' : 'c', v: 0.2 + Math.random() * 0.6, id: i }));
  function drawIdleBackground(t) {
    cam.x = t * 25; cam.y = t * 12;
    drawBackground(t);
    for (const o of idleOrbs) {
      const x = ((o.x * W + t * 20 * o.v) % (W + 40)) - 20, y = ((o.y * H + Math.sin(t * o.v + o.id) * 20) + H) % H;
      drawOrb(ctx, x, y, o.t, t, o.id);
    }
  }

  const mm = $('minimap'), mctx = mm.getContext('2d');
  function drawMinimap() {
    const s = mm.width / G.WORLD.w;
    mctx.clearRect(0, 0, mm.width, mm.height);
    mctx.strokeStyle = 'rgba(120,150,255,0.35)'; mctx.strokeRect(cam.x * s, cam.y * s, W * s, H * s);
    for (const o of orbs.values()) { if (o.t === 'c') continue; mctx.fillStyle = G.ORB_TYPES[o.t].color; mctx.fillRect(o.x * s - 1, o.y * s - 1, o.t === 'l' ? 4 : 2, o.t === 'l' ? 4 : 2); }
    for (const pl of players.values()) {
      if (!pl.pos) continue;
      mctx.fillStyle = pl.id === myId ? '#ffffff' : colorOf(pl.eq, 0);
      mctx.beginPath(); mctx.arc(pl.pos.x * s, pl.pos.y * s, pl.id === myId ? 3.5 : 2.5, 0, Math.PI * 2); mctx.fill();
    }
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ modals
  function openModal(id) {
    closeModals();
    $(id).classList.remove('hidden');
    if (id === 'shop') renderShop();
    if (id === 'lb') loadLb();
    if (id === 'games') { if (!mgRunning) showGamesList(); updateGameButtons(); }
    updateHud();
  }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
  function toggleModal(id) { $(id).classList.contains('hidden') ? openModal(id) : closeModals(); }
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.open)));
  document.querySelectorAll('.modal .close').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) closeModals(); }));

  // ------------------------------------------------------------ shop
  let shopTab = 'color';
  const shopPreviews = [];
  function renderShop() {
    if (!profile) return;
    const tabs = G.CATEGORIES.concat([{ key: 'upgrades', name: '⚡ Улучшения' }]);
    $('shopTabs').innerHTML = tabs.map(c => `<button class="tab ${c.key === shopTab ? 'active' : ''}" data-tab="${c.key}">${c.name}</button>`).join('');
    $('shopTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { shopTab = b.dataset.tab; renderShop(); });
    shopPreviews.length = 0;
    const grid = $('shopGrid');
    grid.innerHTML = '';
    if (shopTab === 'upgrades') {
      for (const up of Object.values(G.UPGRADES)) {
        const lvl = profile.upgrades[up.key] || 0, price = up.prices[lvl];
        const el = document.createElement('div'); el.className = 'item';
        const cur = up.key === 'magnet' ? `Радиус сбора: ${G.pickupFor(lvl)}` : `Скорость: ${Math.round(G.speedFor(lvl))}`;
        el.innerHTML = `<div style="font-size:44px;line-height:96px">${up.key === 'magnet' ? '🧲' : '👟'}</div>
          <div class="name">${up.name} — ур. ${lvl}/${up.max}</div><div class="desc">${up.desc}<br>${cur}</div>`;
        const btn = document.createElement('button'); btn.className = 'btn' + (lvl < up.max ? ' primary' : '');
        if (lvl >= up.max) { btn.textContent = 'Максимум'; btn.disabled = true; }
        else { btn.textContent = `Улучшить · ${fmt(price)} ◉`; btn.disabled = profile.balance < price; btn.onclick = () => socket.emit('upgrade', up.key, res => afterShop(res, `${up.name}: уровень ${lvl + 1}!`)); }
        el.appendChild(btn); grid.appendChild(el);
      }
      return;
    }
    for (const it of G.ITEMS.filter(i => i.cat === shopTab)) {
      const owned = profile.owned.includes(it.id), equipped = profile.equipped[it.cat] === it.id;
      const el = document.createElement('div'); el.className = 'item';
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 192;
      el.appendChild(cv);
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name; el.appendChild(nm);
      const ds = document.createElement('div'); ds.className = 'desc'; ds.textContent = it.price ? `${fmt(it.price)} сфер` : 'Бесплатно'; el.appendChild(ds);
      const btn = document.createElement('button');
      if (equipped) { btn.className = 'btn equipped'; btn.textContent = '✓ Надето'; btn.disabled = true; }
      else if (owned) { btn.className = 'btn'; btn.textContent = 'Надеть'; btn.onclick = () => socket.emit('equip', it.id, res => afterShop(res)); }
      else { btn.className = 'btn primary'; btn.textContent = `Купить · ${fmt(it.price)} ◉`; btn.disabled = profile.balance < it.price; btn.onclick = () => socket.emit('buy', it.id, res => afterShop(res, `Куплено: ${it.name}!`)); }
      el.appendChild(btn); grid.appendChild(el);
      shopPreviews.push({ cv, eq: Object.assign({}, profile.equipped, { [it.cat]: it.id }), cat: it.cat });
    }
  }
  function afterShop(res, okMsg) {
    if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
    profile = res.profile; updateHud(); renderShop();
    if (okMsg) toast(okMsg, 'ok');
  }
  function drawShopPreviews(t, now) {
    for (const p of shopPreviews) {
      const g = p.cv.getContext('2d');
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, 96, 96);
      const cx = 48 + (p.cat === 'trail' ? 14 : 0), cy = 58;
      if (p.cat === 'trail') {
        const fake = { eq: p.eq, trail: [] };
        for (let i = 0; i < 14; i++) fake.trail.push({ x: cx - 60 + i * 4.2, y: cy + Math.sin(t * 4 + i * 0.5) * 6, time: now - (14 - i) * 40, seed: (i * 0.37) % 1 });
        drawTrail(g, fake, t, now);
      }
      drawAvatar(g, cx, cy, 18, p.eq, t, { dir: { x: 1, y: 0 } });
    }
  }

  // ------------------------------------------------------------ leaderboard
  function lbRows(list) {
    return list.map(p => `<tr class="${p.name === myName ? 'me' : ''}"><td>${p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank}</td>
      <td><i class="dot" style="background:${p.color === 'rainbow' ? 'linear-gradient(90deg,#f55,#ff5,#5f5,#5ff,#a5f)' : p.color};box-shadow:0 0 8px ${p.color === 'rainbow' ? '#fff' : p.color}"></i>${esc(p.name)}${p.online ? '<span class="on" title="онлайн"></span>' : ''}</td>
      <td class="num">${fmt(p.total)}</td></tr>`).join('');
  }
  function loadLb() {
    $('lbBody').innerHTML = '<tr><td colspan="3" class="muted">Загрузка…</td></tr>';
    fetch(`/api/leaderboard?limit=50&name=${encodeURIComponent(myName)}`).then(r => r.json()).then(d => {
      $('lbBody').innerHTML = lbRows(d.players) || '<tr><td colspan="3" class="muted">Пока пусто — станьте первым!</td></tr>';
      $('lbMe').innerHTML = d.me ? `Ваше место: <b>#${d.me.rank}</b> из ${d.totalPlayers} · собрано ${fmt(d.me.total)} сфер` : 'Соберите хотя бы одну сферу, чтобы попасть в рейтинг.';
    }).catch(() => { $('lbBody').innerHTML = '<tr><td colspan="3">Ошибка загрузки</td></tr>'; });
  }
  function loadStartLb() {
    fetch('/api/leaderboard?limit=5').then(r => r.json()).then(d => {
      $('startLb').innerHTML = d.players.length ? d.players.map(p => `<li>${esc(p.name)} <b>${fmt(p.total)}</b></li>`).join('') : '<li class="muted">Пока никого — будьте первым!</li>';
    }).catch(() => { $('startLb').innerHTML = '<li class="muted">Не удалось загрузить</li>'; });
  }
  loadStartLb();

  // ------------------------------------------------------------ mini-games
  let mgRunning = null, reactionState = null, rushActive = false, rushStart = 0, rushScore = 0;
  let rushTargets = [];
  const rushPops = [];
  function showGamesList() {
    $('gamesList').classList.remove('hidden');
    $('reactionArea').classList.add('hidden'); $('rushArea').classList.add('hidden');
    $('mgResult').classList.add('hidden');
  }
  function updateGameButtons() {
    document.querySelectorAll('[data-game]').forEach(b => { const fee = G.MINIGAMES[b.dataset.game].fee; b.disabled = !!mgRunning || !profile || profile.balance < fee; });
  }
  document.querySelectorAll('[data-game]').forEach(b => b.addEventListener('click', () => startGame(b.dataset.game)));
  function startGame(kind) {
    if (mgRunning) return;
    socket.emit('mg:start', kind, res => {
      if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
      mgRunning = kind;
      $('mgResult').classList.add('hidden');
      $('gamesList').classList.add('hidden');
      if (kind === 'reaction') {
        reactionState = 'wait';
        const box = $('reactionBox'); box.className = 'reaction-box'; box.textContent = 'Ждите зелёного…';
        $('reactionArea').classList.remove('hidden');
      } else {
        rushActive = true; rushStart = performance.now(); rushScore = 0; rushTargets = []; rushPops.length = 0;
        $('rushScore').textContent = '0';
        $('rushArea').classList.remove('hidden');
      }
    });
  }
  socket.on('mg:reaction:go', () => {
    if (reactionState !== 'wait') return;
    reactionState = 'go';
    const box = $('reactionBox'); box.className = 'reaction-box go'; box.textContent = 'ЖМИ!';
  });
  function reactionClick() {
    if (reactionState !== 'wait' && reactionState !== 'go') return;
    reactionState = 'sent';
    socket.emit('mg:reaction:click');
  }
  $('reactionBox').addEventListener('pointerdown', e => { e.preventDefault(); reactionClick(); });

  socket.on('mg:rush:spawn', tg => { if (rushActive) rushTargets.push(Object.assign(tg, { born: performance.now() })); });
  const rushCv = $('rushCanvas'), rctx = rushCv.getContext('2d');
  rushCv.addEventListener('pointerdown', e => {
    if (!rushActive) return;
    e.preventDefault();
    const rect = rushCv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (rushCv.width / rect.width), y = (e.clientY - rect.top) * (rushCv.height / rect.height);
    const now = performance.now();
    for (let i = rushTargets.length - 1; i >= 0; i--) {
      const tg = rushTargets[i];
      if (tg.hit || now - tg.born > tg.life + 100) continue;
      if (Math.hypot(x - tg.x, y - tg.y) <= tg.r * 1.25) {
        tg.hit = true;
        socket.emit('mg:rush:hit', { id: tg.id, x: Math.round(x), y: Math.round(y) }, res => {
          if (res && res.ok) {
            rushScore = res.score; $('rushScore').textContent = rushScore;
            rushPops.push({ x: tg.x, y: tg.y, text: (res.v > 0 ? '+' : '') + res.v, color: res.v > 0 ? (tg.type === 'g' ? '#ffcc33' : '#3ee0ff') : '#ff4d6d', start: performance.now() });
          }
        });
        return;
      }
    }
  });
  function drawRush(now) {
    const g = rctx, t = now / 1000;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#070b18'; g.fillRect(0, 0, 600, 400);
    g.strokeStyle = 'rgba(90,120,255,0.1)'; g.beginPath();
    for (let x = 0; x <= 600; x += 40) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, 400); }
    for (let y = 0; y <= 400; y += 40) { g.moveTo(0, y + 0.5); g.lineTo(600, y + 0.5); }
    g.stroke();
    const left = Math.max(0, G.MINIGAMES.rush.duration - (now - rushStart));
    $('rushTime').textContent = (left / 1000).toFixed(1);
    for (const tg of rushTargets) {
      const age = now - tg.born;
      if (tg.hit || age > tg.life) continue;
      const k = Math.min(1, age / 120) * (age > tg.life - 250 ? Math.max(0, (tg.life - age) / 250) : 1);
      const color = tg.type === 'g' ? '#ffcc33' : tg.type === 'b' ? '#ff3b5c' : '#3ee0ff';
      g.save(); g.translate(tg.x, tg.y); g.scale(k, k);
      g.shadowColor = color; g.shadowBlur = 25;
      const grd = g.createRadialGradient(-tg.r * 0.3, -tg.r * 0.3, 1, 0, 0, tg.r);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.4, color); grd.addColorStop(1, color);
      g.fillStyle = grd; g.beginPath(); g.arc(0, 0, tg.r, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      if (tg.type === 'b') { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(-8, -8); g.lineTo(8, 8); g.moveTo(8, -8); g.lineTo(-8, 8); g.stroke(); }
      if (tg.type === 'g') { g.fillStyle = '#5a3a00'; g.font = '800 16px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('3', 0, 1); }
      // life ring
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2;
      g.beginPath(); g.arc(0, 0, tg.r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - age / tg.life)); g.stroke();
      g.restore();
    }
    for (let i = rushPops.length - 1; i >= 0; i--) {
      const p = rushPops[i], k = (now - p.start) / 700;
      if (k >= 1) { rushPops.splice(i, 1); continue; }
      g.globalAlpha = 1 - k; g.fillStyle = p.color; g.font = '800 24px sans-serif'; g.textAlign = 'center';
      g.fillText(p.text, p.x, p.y - k * 30); g.globalAlpha = 1;
    }
  }

  socket.on('mg:result', r => {
    mgRunning = null; reactionState = null; rushActive = false;
    const name = G.MINIGAMES[r.kind].name;
    const net = r.prize - r.fee;
    const box = $('mgResult');
    box.innerHTML = `<div>${esc(name)}: ${esc(r.message || '')}</div><span class="big">${r.prize > 0 ? '+' + r.prize + ' ◉' : '0 ◉'}</span>
      <div class="muted">Взнос ${r.fee} · итог ${net >= 0 ? '+' : ''}${net}</div>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:center">
        <button class="btn primary" id="mgAgain">Ещё раз</button><button class="btn" id="mgBack">К списку игр</button></div>`;
    box.classList.remove('hidden');
    $('reactionArea').classList.add('hidden'); $('rushArea').classList.add('hidden');
    $('mgAgain').onclick = () => startGame(r.kind);
    $('mgBack').onclick = () => { box.classList.add('hidden'); showGamesList(); updateGameButtons(); };
    if ($('games').classList.contains('hidden')) toast(`${name}: ${r.prize > 0 ? '+' + r.prize + ' сфер' : 'без выигрыша'}`, r.prize > 0 ? 'ok' : 'err');
    if (r.prize > 0) floaters.push({ x: dispMe.x, y: dispMe.y - 40, text: '+' + r.prize, color: '#ffcc33', start: performance.now(), big: true });
    updateGameButtons();
  });
})();
