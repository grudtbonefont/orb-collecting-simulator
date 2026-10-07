/* Orb Collecting Simulator — browser client (vanilla JS, no build step) */
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

  // ------------------------------------------------------------ identity (session token issued by the server)
  const TOKEN_KEY = 'ocs_session', NICK_KEY = 'ocs_nick';
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del: k => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  store.del('ics_token'); store.del('ics_nick'); // old prototype keys
  let token = store.get(TOKEN_KEY);
  if (token && !/^[A-Za-z0-9_-]{43}$/.test(token)) { token = null; store.del(TOKEN_KEY); }
  $('nick').value = store.get(NICK_KEY) || '';

  // ------------------------------------------------------------ state
  const socket = io({ transports: ['websocket', 'polling'] });
  let trashSlot = null, trashBusy = false; // inventory trash dialog
  let joined = false, myName = store.get(NICK_KEY) || '', myId = null, profile = null, sessionScore = 0;
  const players = new Map();   // id -> {id,name,eq,trail:[],dir:{x,y},pos:{x,y}}
  const snapshots = [];        // {time, map}
  const orbs = new Map();      // id -> {x,y,t,born}
  const fx = [], floaters = [];
  const me = { x: 0, y: 0 }, prevMe = { x: 0, y: 0 }, corr = { x: 0, y: 0 }, cam = { x: 0, y: 0 };
  let pending = [], seq = 0, lastStepAt = 0, myDir = { x: 1, y: 0 };
  const keys = {};
  const MQ = window.matchMedia('(max-width: 760px), (pointer: coarse)');
  const mobileUI = () => MQ.matches;
  let chatOpen = false, unread = 0, chatToastTimer = null;
  const chatLog = $('chatLog'), chatInput = $('chatInput');
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

  // ------------------------------------------------------------ auth / connection
  // stage: 'auth' (login form) → 'lobby' (profile screen) → 'game' (arena)
  let stage = 'auth', authMode = 'login', authPending = false, playPending = false, paused = false;
  let summary = null; // last profile summary (rank, play time…) from the server
  const setErr = msg => { $('joinError').textContent = msg || ''; };
  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const reg = mode === 'register';
    $('pass2').classList.toggle('hidden', !reg);
    $('authRules').classList.toggle('hidden', !reg);
    $('pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    $('authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
    setErr('');
  }
  document.querySelectorAll('.auth-tab').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $('nick').addEventListener('input', () => {
    if (authMode !== 'register') return;
    const v = $('nick').value.trim();
    setErr(v.length >= 3 ? (RULES.nicknameError(v) || '') : '');
  });
  $('authForm').addEventListener('submit', e => {
    e.preventDefault();
    if (authPending) return;
    const name = $('nick').value.trim(), password = $('pass').value, confirm = $('pass2').value;
    if (!name) { setErr('Введите ник'); $('nick').focus(); return; }
    if (authMode === 'register') {
      const ne = RULES.nicknameError(name); if (ne) { setErr(ne); $('nick').focus(); return; }
      const pe = RULES.passwordError(password); if (pe) { setErr(pe); $('pass').focus(); return; }
      if (password !== confirm) { setErr('Пароли не совпадают'); $('pass2').focus(); return; }
    } else if (!password) { setErr('Введите пароль'); $('pass').focus(); return; }
    if (!socket.connected) { setErr('Нет связи с сервером, подождите…'); socket.connect(); return; }
    authPending = true; $('authSubmit').disabled = true; setErr('');
    const payload = { mode: authMode, name, password, enter: false };
    if (authMode === 'register') payload.confirm = confirm;
    socket.emit('auth', payload, res => {
      authPending = false; $('authSubmit').disabled = false;
      if (!res || !res.ok) { setErr((res && res.error) || 'Ошибка входа'); return; }
      token = res.token; store.set(TOKEN_KEY, token);
      $('pass').value = ''; $('pass2').value = '';
      showLobby(res.profile);
    });
  });
  // saved token → profile screen (does not enter the arena)
  function trySession() {
    if (!token || authPending || paused) return;
    const silent = stage === 'lobby';
    if (!socket.connected) { if (!silent) showResume('Подключение к серверу…', false); socket.connect(); return; }
    authPending = true;
    if (!silent) showResume('Входим как ' + (myName || 'игрок') + '…', false);
    socket.emit('session', { token }, res => {
      authPending = false;
      if (res && res.ok) { showLobby(res.profile); return; }
      sessionFailed(res);
    });
  }
  function sessionFailed(res) {
    stage = 'auth'; hideGameUi();
    if (res && res.expired) { token = null; store.del(TOKEN_KEY); showStart(); setErr(res.error); return; }
    paused = true; showResume((res && res.error) || 'Не удалось войти', true);
  }
  // reconnect while playing → straight back into the arena
  function tryResume() {
    if (!token || joined || authPending) return;
    authPending = true;
    socket.emit('resume', { token }, res => {
      authPending = false;
      if (res && res.ok) { enterGame(res, true); return; }
      sessionFailed(res);
    });
  }
  function play() {
    if (stage === 'game') { closeProfile(); return; }
    if (playPending) return;
    if (!socket.connected) { $('pfError').textContent = 'Нет связи с сервером, подождите…'; return; }
    playPending = true; $('pfPlay').disabled = true; $('pfError').textContent = '';
    socket.emit('play', null, res => {
      playPending = false; $('pfPlay').disabled = false;
      if (res && res.ok) { enterGame(res); return; }
      if (res && res.expired) { sessionFailed(res); return; }
      $('pfError').textContent = (res && res.error) || 'Не удалось войти в игру';
    });
  }
  function enterGame(res, reconnect) {
    setErr(''); stage = 'game'; paused = false;
    myId = res.you; profile = res.profile; myName = profile.name; sessionScore = 0;
    store.set(NICK_KEY, myName); $('nick').value = myName;
    players.clear(); orbs.clear(); snapshots.length = 0; pending = []; seq = 0; fx.length = 0;
    for (const p of res.players) addPlayer(p);
    const mine = players.get(myId);
    me.x = prevMe.x = mine.pos.x; me.y = prevMe.y = mine.pos.y; corr.x = corr.y = 0;
    const now = performance.now();
    for (const [id, x, y, t] of res.orbs) orbs.set(id, { x, y, t, born: now - 1000 });
    joined = true;
    $('start').classList.add('hidden'); $('profile').classList.add('hidden'); closeModals();
    $('hud').classList.remove('hidden');
    $('chat').classList.remove('hidden'); $('chatBtn').classList.remove('hidden');
    $('hudName').textContent = '👤 ' + myName;
    resetChat(res.chat || []);
    updateHud();
    if (!reconnect) toast(`Добро пожаловать, ${myName}! Собирайте сферы.`, 'ok');
  }
  function hideGameUi() {
    joined = false;
    $('hud').classList.add('hidden'); $('chat').classList.add('hidden'); $('chatBtn').classList.add('hidden'); closeChat();
    closeModals();
  }
  function showResume(text, buttons) {
    $('start').classList.remove('hidden'); $('profile').classList.add('hidden');
    $('resumeBox').classList.remove('hidden'); $('authBox').classList.add('hidden');
    $('resumeText').textContent = text;
    $('resumeBtn').classList.toggle('hidden', !buttons); $('resumeLogout').classList.toggle('hidden', !buttons);
  }
  function showStart() {
    stage = 'auth'; hideGameUi();
    $('start').classList.remove('hidden'); $('profile').classList.add('hidden');
    $('resumeBox').classList.add('hidden'); $('authBox').classList.remove('hidden');
    loadStartLb();
  }
  function showLobby(p) {
    stage = 'lobby'; paused = false; hideGameUi();
    summary = p; profile = p; myName = p.name;
    store.set(NICK_KEY, myName); $('nick').value = myName;
    $('start').classList.add('hidden');
    renderProfile();
    $('profile').classList.remove('hidden');
  }
  function logout() {
    const t = token;
    token = null; store.del(TOKEN_KEY); paused = false; profile = null; summary = null;
    if (socket.connected) socket.emit('logout', { token: t }, () => {});
    showStart(); setAuthMode('login'); $('pass').value = '';
    toast('Вы вышли из аккаунта');
  }
  $('logoutBtn').addEventListener('click', logout);
  $('resumeLogout').addEventListener('click', logout);
  $('pfLogout').addEventListener('click', logout);
  $('pfPlay').addEventListener('click', play);
  $('resumeBtn').addEventListener('click', () => { paused = false; trySession(); });
  if (token) showResume('Входим как ' + (myName || 'игрок') + '…', false);

  socket.on('connect', () => {
    if (!token) { if (/связи/.test($('joinError').textContent)) setErr(''); return; }
    if (stage === 'game') tryResume(); else trySession();
  });
  socket.on('disconnect', () => {
    authPending = false; playPending = false; $('authSubmit').disabled = false; $('pfPlay').disabled = false;
    if (joined) toast('Соединение потеряно, переподключаемся…', 'err');
    joined = false;
  });
  socket.on('kicked', msg => { paused = true; stage = 'auth'; hideGameUi(); showResume(msg, true); });

  function addPlayer(p) {
    players.set(p.id, { id: p.id, name: p.name, eq: p.eq, trail: [], dir: { x: 1, y: 0 }, pos: { x: p.x, y: p.y }, last: { x: p.x, y: p.y } });
  }
  socket.on('pjoin', p => { if (!players.has(p.id)) addPlayer(p); });
  socket.on('pleave', id => players.delete(id));
  socket.on('chat', m => addChat(m, true));
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
  socket.on('profile', p => { setProfile(p); });
  socket.on('chat:clear', () => { resetChat([]); }); // periodic server-side wipe: the log just becomes empty
  socket.on('item', d => {
    if (!d) return;
    if (d.error) { toast(d.error, 'err'); return; }
    const def = G.ITEM_BY_ID[d.id];
    if (def) toast(`${def.icon || '🎁'} Получен предмет: ${def.name}${d.qty > 1 ? ' ×' + d.qty : ''} — он в инвентаре (I)`, 'ok');
  });
  // any fresh own-profile from the server: refresh everything that shows it
  function setProfile(p) {
    if (!p) return;
    profile = p;
    if (summary) { Object.assign(summary, p); summary.items = p.inventory.reduce((n, s) => n + s.q, 0); summary.slotsUsed = p.inventory.length; }
    updateHud();
    if (!$('shop').classList.contains('hidden')) renderShop();
    if (!$('inv').classList.contains('hidden')) renderInv();
    if (!$('profile').classList.contains('hidden')) renderProfile();
  }
  socket.on('top', d => {
    $('hudOnline').textContent = d.online;
    const ol = $('hudTop'); ol.textContent = '';
    for (const [id, name, s] of d.top) {
      const li = document.createElement('li'); if (id === myId) li.className = 'me';
      li.append(String(name) + ' '); const b = document.createElement('b'); b.textContent = fmt(s); li.appendChild(b); ol.appendChild(li);
    }
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
  const anyModalOnly = () => Array.from(document.querySelectorAll('.modal')).some(m => !m.classList.contains('hidden'));
  const anyModal = () => anyModalOnly() || !$('profile').classList.contains('hidden') || !$('trashDlg').classList.contains('hidden');
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };
  window.addEventListener('keydown', e => {
    if (!$('trashDlg').classList.contains('hidden')) { if (e.code === 'Escape') closeTrash(); return; } // confirm dialog is modal
    if (typing()) return;                 // chat / login inputs: no movement, no hotkeys
    if (joined && chatOpen) { if (e.code === 'Escape') closeChat(); return; }
    if (joined && !anyModal() && !mobileUI() && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyT') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); chatInput.focus(); return;
    }
    keys[e.code] = true;
    if (stage === 'lobby' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.code === 'KeyI') toggleModal('inv');
      if (e.code === 'Escape') closeModals();
      return;
    }
    if (!joined || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') { if (!$('profile').classList.contains('hidden') && !anyModalOnly()) closeProfile(); else closeModals(); }
    if (e.code === 'KeyP') toggleProfile();
    if (e.code === 'KeyI') toggleModal('inv');
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
    if (anyModal() || chatOpen) return { x: 0, y: 0 };
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
    const color = opts.color || colorOf(eq, t + (opts.phase || 0));
    const shape = itemVal(eq.shape) || 'circle';
    const top = SHAPE_TOP[shape] || 1;
    g.save(); g.translate(x, y);
    g.shadowColor = color; g.shadowBlur = opts.isMe ? 26 : 18;
    shapePath(g, shape, r, t);
    const grd = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.1, 0, 0, r * 1.4);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, color); grd.addColorStop(1, color);
    g.fillStyle = grd; g.fill();
    if (opts.staticRainbow && itemVal(eq.color) === 'rainbow') { // icons: whole rainbow at once instead of the animated hue
      const rb = g.createLinearGradient(-r, -r, r, r);
      for (let i = 0; i <= 5; i++) rb.addColorStop(i / 5, `hsl(${i * 60},100%,62%)`);
      g.fillStyle = rb; g.fill();
      const hl = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.05, -r * 0.2, -r * 0.2, r * 1.1);
      hl.addColorStop(0, 'rgba(255,255,255,0.85)'); hl.addColorStop(0.35, 'rgba(255,255,255,0.12)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = hl; g.fill();
    }
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
      drawNameTag(g, opts.name, 0, ny, itemVal(eq.nameColor) || '#fff', t, opts.isMe ? 14 : 13);
    }
    g.restore();
  }
  // nickname text exactly as in the arena (also used for the nickname-color icons)
  function drawNameTag(g, text, x, y, nc, t, px, weight = 700) {
    g.font = `${weight} ${px}px Segoe UI, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    let fill = nc;
    if (nc === 'rainbow') {
      const w = g.measureText(text).width;
      fill = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      for (let i = 0; i <= 4; i++) fill.addColorStop(i / 4, rainbow(t, i * 70));
    }
    g.lineWidth = Math.max(4, px * 0.22); g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.strokeText(text, x, y);
    g.fillStyle = fill; g.fillText(text, x, y);
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
    if (!joined) { drawIdleBackground(t); drawPreviews(t, now); return; }

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
    drawPreviews(t, now);
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
    if (id !== 'inv') { if (stage !== 'game') return; closeProfile(); }
    $(id).classList.remove('hidden');
    if (id === 'shop') renderShop();
    if (id === 'inv') renderInv();
    if (id === 'lb') loadLb();
    if (id === 'games') { if (!mgRunning) showGamesList(); updateGameButtons(); }
    updateHud();
  }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); closeTrash(); }
  function toggleModal(id) { $(id).classList.contains('hidden') ? openModal(id) : closeModals(); }
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.open)));
  document.querySelectorAll('.modal .close').forEach(b => b.addEventListener('click', closeModals));
  $('hudName').addEventListener('click', () => toggleProfile());
  $('profileClose').addEventListener('click', () => closeProfile());
  $('pfInv').addEventListener('click', () => openModal('inv'));
  $('profile').addEventListener('pointerdown', e => { if (e.target === $('profile') && stage === 'game') closeProfile(); });
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) closeModals(); }));

  // ------------------------------------------------------------ item icons
  // Data-driven: cosmetics are drawn by category with the game's own renderer (drawAvatar / drawTrail / hats / name tags),
  // collectibles by their `art` key, anything else gets a fallback gem. Drawn lazily once per item at devicePixelRatio
  // and cached as PNG data URLs (allowed by the CSP's img-src data:).
  const ICON_PX = 96, ICON_T = 0.35, ICON_NOW = 10000; // fixed animation time → deterministic icons
  const NEUTRAL_BODY = '#d4dcf7';                       // shapes in neutral silver so the outline is what you notice
  const iconCache = new Map();
  const eqWith = (cat, id) => Object.assign({}, G.DEFAULT_EQUIPPED, { [cat]: id });
  function avatarAt(g, x, y, k, eq, opts = {}) {
    g.save(); g.translate(x, y); g.scale(k, k);
    drawAvatar(g, 0, 0, G.PLAYER_R, eq, ICON_T, Object.assign({ dir: { x: 0.6, y: 0.8 } }, opts));
    g.restore();
  }
  function dashedHint(g, draw) { g.save(); g.setLineDash([4, 4]); g.lineWidth = 2; g.strokeStyle = 'rgba(170,180,215,0.55)'; g.beginPath(); draw(); g.stroke(); g.restore(); }
  function sparkle(g, x, y, r, color) {
    g.save(); g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 8; g.beginPath();
    g.moveTo(x, y - r); g.quadraticCurveTo(x, y, x + r, y); g.quadraticCurveTo(x, y, x, y + r); g.quadraticCurveTo(x, y, x - r, y); g.quadraticCurveTo(x, y, x, y - r);
    g.fill(); g.restore();
  }
  const ICON_ART = {
    color(g, def) { avatarAt(g, 48, 50, 1.3, eqWith('color', def.id), { staticRainbow: true }); },
    shape(g, def) { avatarAt(g, 48, 52, 1.25, eqWith('shape', def.id), { color: NEUTRAL_BODY }); },
    trail(g, def) {
      const eq = eqWith('trail', def.id);
      if (def.value === 'none') {
        dashedHint(g, () => { g.moveTo(8, 52); g.lineTo(44, 52); });
        g.save(); g.strokeStyle = 'rgba(255,120,140,0.8)'; g.lineWidth = 2.5; g.beginPath(); g.arc(22, 52, 8, 0, Math.PI * 2); g.moveTo(16, 58); g.lineTo(28, 46); g.stroke(); g.restore();
      } else {
        const fake = { eq, trail: [] };
        for (let i = 0; i < 16; i++) fake.trail.push({ x: 6 + i * 3.6, y: 52 + Math.sin(i * 0.55) * 5, time: ICON_NOW - (16 - i) * 38, seed: (i * 0.37) % 1 });
        drawTrail(g, fake, ICON_T, ICON_NOW);
      }
      avatarAt(g, 66, 52, 0.95, eq);
    },
    nameColor(g, def) {
      g.save(); g.fillStyle = 'rgba(8,12,28,0.55)'; g.beginPath(); g.roundRect(12, 30, 72, 40, 12); g.fill(); g.restore();
      drawNameTag(g, 'Aa', 48, 68, def.value, ICON_T, 36, 800);
    },
    hat(g, def) {
      avatarAt(g, 48, 68, 1.3, eqWith('hat', def.id)); // bigger body so the hat is the focus
      if (def.value === 'none') dashedHint(g, () => g.arc(48, 68 - 26 - 5, 16, Math.PI, 0));
    },
    shard(g) {
      const pts = [[50, 8], [68, 32], [62, 82], [44, 90], [30, 42]];
      g.save();
      g.shadowColor = '#ffcc33'; g.shadowBlur = 18;
      const gr = g.createLinearGradient(30, 10, 68, 90);
      gr.addColorStop(0, '#fff7c4'); gr.addColorStop(0.45, '#ffcc33'); gr.addColorStop(1, '#b07a00');
      g.fillStyle = gr; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,250,220,0.9)'; g.lineWidth = 1.5; g.stroke();
      g.strokeStyle = 'rgba(120,80,0,0.55)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(50, 8); g.lineTo(50, 48); g.lineTo(44, 90); g.moveTo(50, 48); g.lineTo(68, 32); g.moveTo(50, 48); g.lineTo(30, 42); g.moveTo(50, 48); g.lineTo(62, 82); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.moveTo(50, 12); g.lineTo(58, 26); g.lineTo(50, 44); g.lineTo(36, 40); g.closePath(); g.fill();
      g.restore();
      sparkle(g, 76, 20, 7, '#fff3b0'); sparkle(g, 22, 72, 5, '#ffe27a'); sparkle(g, 78, 70, 4, '#ffffff');
    },
  };
  function drawFallbackIcon(g, def) {
    const rc = (G.RARITIES[def && def.rarity] || G.RARITIES.common).color;
    g.save(); g.shadowColor = rc; g.shadowBlur = 16; g.fillStyle = rc; g.globalAlpha = 0.9;
    g.beginPath(); g.moveTo(48, 12); g.lineTo(80, 48); g.lineTo(48, 84); g.lineTo(16, 48); g.closePath(); g.fill();
    g.globalAlpha = 1; g.shadowBlur = 0; g.fillStyle = '#0b1024'; g.font = '800 30px Segoe UI, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((def && def.icon) || '?', 48, 50); g.restore();
  }
  function iconUrl(id) {
    const key = String(id);
    if (iconCache.has(key)) return iconCache.get(key);
    const def = Object.prototype.hasOwnProperty.call(G.ITEM_BY_ID, key) ? G.ITEM_BY_ID[key] : null;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const cv = document.createElement('canvas'); cv.width = cv.height = Math.round(ICON_PX * dpr);
    const g = cv.getContext('2d');
    const art = def && (def.type === 'cosmetic' ? ICON_ART[def.cat] : ICON_ART[def.art]);
    try { g.setTransform(dpr, 0, 0, dpr, 0, 0); (art || drawFallbackIcon)(g, def || { rarity: 'common' }); }
    catch (_) { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, ICON_PX, ICON_PX); drawFallbackIcon(g, def); }
    const url = cv.toDataURL('image/png');
    iconCache.set(key, url);
    return url;
  }
  // <div class="ico"> with a rarity-coloured frame/glow and the cached icon
  function iconEl(id, cls) {
    const def = G.ITEM_BY_ID[id];
    const box = document.createElement('div');
    box.className = 'ico' + (cls ? ' ' + cls : '');
    box.style.setProperty('--rc', (G.RARITIES[def && def.rarity] || G.RARITIES.common).color);
    const img = document.createElement('img');
    img.src = iconUrl(id); img.alt = def ? def.name : 'Предмет'; img.draggable = false; img.dataset.icon = String(id);
    box.appendChild(img);
    return box;
  }
  window.OCSIcons = Object.freeze({ url: iconUrl }); // read-only hook for the UI tests / debugging

  // ------------------------------------------------------------ live avatar previews (profile)
  const previews = []; // {cv, eq, cat, size, r, name}
  function addPreview(cv, eq, cat, opts = {}) { previews.push(Object.assign({ cv, eq, cat, size: 96, r: 18 }, opts)); return cv; }
  function pruneHidden(owner) { for (let i = previews.length - 1; i >= 0; i--) if (previews[i].owner === owner) previews.splice(i, 1); }
  function drawPreviews(t, now) {
    for (const p of previews) {
      if (!p.cv.isConnected || p.cv.offsetParent === null) continue;
      const g = p.cv.getContext('2d'), S = p.size;
      g.setTransform(p.cv.width / S, 0, 0, p.cv.height / S, 0, 0);
      g.clearRect(0, 0, S, S);
      const trail = p.cat === 'trail' || (p.cat === 'all' && (itemVal(p.eq.trail) || 'none') !== 'none');
      const cx = S / 2 + (trail ? S * 0.14 : 0), cy = S * (p.name ? 0.64 : 0.6);
      if (trail) {
        const fake = { eq: p.eq, trail: [] }, k = S / 96;
        for (let i = 0; i < 14; i++) fake.trail.push({ x: cx - 60 * k + i * 4.2 * k, y: cy + Math.sin(t * 4 + i * 0.5) * 6 * k, time: now - (14 - i) * 40, seed: (i * 0.37) % 1 });
        drawTrail(g, fake, t, now);
      }
      drawAvatar(g, cx, cy, p.r, p.eq, t, { dir: { x: 1, y: 0 }, name: p.name, isMe: !!p.name });
    }
  }
  const owns = id => !!(profile && profile.inventory.some(s => s.id === id));
  const rarityOf = def => G.RARITIES[def.rarity] || G.RARITIES.common;
  const SOURCE_NAMES = { shop: 'Магазин', minigame: 'Мини-игры', arena: 'Арена', event: 'Событие', admin: 'Подарок', legacy: 'Куплено раньше' };
  function rarityTag(def) { const r = rarityOf(def); const el = document.createElement('div'); el.className = 'rar'; el.style.color = r.color; el.textContent = r.name; return el; }

  // ------------------------------------------------------------ shop (only sells; purchases go to the inventory)
  let shopTab = 'color';
  function renderShop() {
    if (!profile) return;
    pruneHidden('shop');
    const tabs = G.CATEGORIES.concat([{ key: 'upgrades', name: '⚡ Улучшения' }]);
    $('shopTabs').innerHTML = tabs.map(c => `<button class="tab ${c.key === shopTab ? 'active' : ''}" data-tab="${c.key}">${c.name}</button>`).join('');
    $('shopTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { shopTab = b.dataset.tab; renderShop(); });
    const grid = $('shopGrid');
    grid.innerHTML = '';
    if (shopTab === 'upgrades') {
      for (const up of Object.values(G.UPGRADES)) {
        const lvl = profile.upgrades[up.key] || 0, price = up.prices[lvl];
        const el = document.createElement('div'); el.className = 'item';
        const cur = up.key === 'magnet' ? `Радиус сбора: ${G.pickupFor(lvl)}` : `Скорость: ${Math.round(G.speedFor(lvl))}`;
        el.innerHTML = `<div class="big-icon">${up.key === 'magnet' ? '🧲' : '👟'}</div>
          <div class="name">${up.name} — ур. ${lvl}/${up.max}</div><div class="desc">${up.desc}<br>${cur}</div>`;
        const btn = document.createElement('button'); btn.className = 'btn' + (lvl < up.max ? ' primary' : '');
        if (lvl >= up.max) { btn.textContent = 'Максимум'; btn.disabled = true; }
        else { btn.textContent = `Улучшить · ${fmt(price)} ◉`; btn.disabled = profile.balance < price; btn.onclick = () => socket.emit('upgrade', up.key, res => afterAction(res, `${up.name}: уровень ${lvl + 1}!`)); }
        el.appendChild(btn); grid.appendChild(el);
      }
      return;
    }
    const full = profile.inventory.length >= profile.slots;
    for (const it of G.ITEMS.filter(i => i.cat === shopTab && i.price > 0 && i.sources.includes('shop'))) {
      const owned = owns(it.id);
      const el = document.createElement('div'); el.className = 'item rar-' + it.rarity;
      el.dataset.item = it.id;
      el.appendChild(iconEl(it.id));
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name; el.append(nm, rarityTag(it));
      const btn = document.createElement('button');
      if (owned) { btn.className = 'btn equipped'; btn.textContent = '✓ В инвентаре'; btn.disabled = true; }
      else {
        btn.className = 'btn primary'; btn.textContent = `Купить · ${fmt(it.price)} ◉`;
        btn.disabled = profile.balance < it.price;
        if (full) btn.title = 'Инвентарь полон';
        btn.onclick = () => socket.emit('buy', it.id, res => afterAction(res, `Куплено: ${it.name} — предмет в инвентаре (I)`));
      }
      el.appendChild(btn); grid.appendChild(el);
    }
  }
  function afterAction(res, okMsg) {
    if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
    setProfile(res.profile);
    if (okMsg) toast(okMsg, 'ok');
  }

  // ------------------------------------------------------------ inventory (100 slots; stackable items up to 99 per slot)
  let invTab = 'all';
  function renderInv() {
    if (!profile) return;
    pruneHidden('inv');
    const inv = profile.inventory, slots = profile.slots || G.INV_SLOTS;
    $('invCount').textContent = `Занято ${inv.length}/${slots}`;
    $('invMeter').style.width = Math.min(100, inv.length / slots * 100) + '%';
    $('invMeter').classList.toggle('full', inv.length >= slots);
    const tabs = [{ key: 'all', name: 'Все' }].concat(G.INV_CATEGORIES);
    $('invTabs').innerHTML = tabs.map(c => {
      const n = c.key === 'all' ? inv.length : inv.filter(s => (G.ITEM_BY_ID[s.id] || {}).cat === c.key).length;
      return `<button class="tab ${c.key === invTab ? 'active' : ''}" data-tab="${c.key}">${c.name} <span class="cnt">${n}</span></button>`;
    }).join('');
    $('invTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { invTab = b.dataset.tab; renderInv(); });
    const grid = $('invGrid');
    grid.innerHTML = '';
    let shown = 0;
    inv.forEach((slot, i) => {
      const def = G.ITEM_BY_ID[slot.id];
      if (!def || (invTab !== 'all' && def.cat !== invTab)) return;
      shown++;
      const el = document.createElement('div'); el.className = 'item inv-item rar-' + def.rarity; el.dataset.item = def.id; el.dataset.slot = i;
      el.appendChild(iconEl(def.id));
      if (def.stackable) { const q = document.createElement('span'); q.className = 'qty'; q.textContent = '×' + slot.q; el.appendChild(q); }
      const tb = document.createElement('button'); tb.type = 'button'; tb.className = 'trash-btn'; tb.title = 'Удалить'; tb.setAttribute('aria-label', 'Удалить ' + def.name); tb.textContent = '🗑';
      tb.onclick = e => { e.stopPropagation(); openTrash(i); };
      el.appendChild(tb);
      if (!mobileUI()) {
        el.draggable = true;
        el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; $('invTrash').classList.add('armed'); });
        el.addEventListener('dragend', () => $('invTrash').classList.remove('armed', 'over'));
      }
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = def.name; el.append(nm, rarityTag(def));
      const src = document.createElement('div'); src.className = 'desc'; src.textContent = SOURCE_NAMES[slot.src] || ''; el.appendChild(src);
      const btn = document.createElement('button');
      if (def.type === 'cosmetic') {
        const on = profile.equipped[def.cat] === def.id;
        btn.className = on ? 'btn equipped' : 'btn primary'; btn.textContent = on ? '✓ Надето · Снять' : 'Надеть';
        btn.onclick = on ? () => socket.emit('inv:unequip', def.cat, res => afterAction(res, `Снято: ${def.name}`))
          : () => socket.emit('inv:equip', def.id, res => afterAction(res, `Надето: ${def.name}`));
      } else { btn.className = 'btn'; btn.textContent = def.stackable ? `Коллекция · до ${def.maxStack} в ячейке` : 'Коллекция'; btn.disabled = true; }
      el.appendChild(btn); grid.appendChild(el);
    });
    if (!shown) {
      const em = document.createElement('div'); em.className = 'inv-empty muted';
      em.textContent = inv.length ? 'В этой категории пока ничего нет.' : 'Инвентарь пуст. Купите что-нибудь в магазине (B) — покупки появятся здесь.';
      grid.appendChild(em);
    }
  }

  // ------------------------------------------------------------ trash (delete items for good, no refund)
  const trashZone = $('invTrash');
  trashZone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; trashZone.classList.add('over'); });
  trashZone.addEventListener('dragleave', () => trashZone.classList.remove('over'));
  trashZone.addEventListener('drop', e => {
    e.preventDefault(); trashZone.classList.remove('over', 'armed');
    const i = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isInteger(i)) openTrash(i);
  });
  trashZone.addEventListener('click', () => toast('Нажмите 🗑 на предмете или перетащите его сюда'));
  function trashQty() { const v = parseInt($('trashQty').value, 10); return Number.isFinite(v) ? v : 0; }
  function setTrashQty(v) {
    const max = trashSlot ? trashSlot.q : 1;
    v = Math.max(1, Math.min(max, Math.round(v) || 1));
    $('trashQty').value = v; $('trashRange').value = v;
    const def = G.ITEM_BY_ID[trashSlot.id];
    $('trashOk').textContent = def.stackable ? `Удалить ${v} шт.` : 'Удалить';
  }
  function openTrash(i) {
    if (!profile) return;
    const slot = profile.inventory[i], def = slot && G.ITEM_BY_ID[slot.id];
    if (!def) return;
    trashSlot = { index: i, id: slot.id, q: slot.q };
    $('trashName').textContent = def.name + (def.stackable ? ` (в ячейке ${slot.q} шт.)` : '');
    $('trashIco').replaceChildren(iconEl(def.id, 'lg'));
    const equipped = def.type === 'cosmetic' && profile.equipped[def.cat] === def.id;
    $('trashEquipped').classList.toggle('hidden', !equipped);
    $('trashQtyBox').classList.toggle('hidden', !def.stackable || slot.q < 2);
    $('trashRange').max = slot.q;
    setTrashQty(1);
    $('trashErr').textContent = '';
    $('trashDlg').classList.remove('hidden');
    $('trashCancel').focus();
  }
  function closeTrash() { $('trashDlg').classList.add('hidden'); trashSlot = null; }
  $('trashMinus').onclick = () => setTrashQty(trashQty() - 1);
  $('trashPlus').onclick = () => setTrashQty(trashQty() + 1);
  $('trashAll').onclick = () => setTrashQty(trashSlot ? trashSlot.q : 1);
  $('trashRange').oninput = () => setTrashQty(Number($('trashRange').value));
  $('trashQty').onchange = () => setTrashQty(trashQty());
  $('trashCancel').onclick = closeTrash;
  $('trashDlg').addEventListener('pointerdown', e => { if (e.target === $('trashDlg')) closeTrash(); });
  $('trashDlg').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeTrash(); if (e.key === 'Enter' && e.target.id === 'trashQty') { e.preventDefault(); setTrashQty(trashQty()); } });
  $('trashOk').onclick = () => {
    if (!trashSlot || trashBusy) return;
    const def = G.ITEM_BY_ID[trashSlot.id], qty = def.stackable ? trashQty() : 1;
    trashBusy = true; $('trashOk').disabled = true;
    socket.emit('inv:trash', { id: trashSlot.id, qty, slot: trashSlot.index }, res => {
      trashBusy = false; $('trashOk').disabled = false;
      if (!res || !res.ok) { $('trashErr').textContent = (res && res.error) || 'Не удалось удалить'; return; }
      closeTrash();
      setProfile(res.profile);
      toast(`🗑 Удалено: ${def.name}${def.stackable ? ' ×' + qty : ''}${res.unequipped ? ' (снято)' : ''}`);
    });
  };

  // ------------------------------------------------------------ profile screen
  const fmtDur = ms => { const m = Math.floor((ms || 0) / 60000), h = Math.floor(m / 60); return h ? `${h} ч ${m % 60} мин` : `${m} мин`; };
  const fmtDate = ts => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  function renderProfile() {
    const p = summary || profile;
    if (!p) return;
    pruneHidden('profile');
    addPreview($('pfAvatar'), Object.assign({}, p.equipped), 'all', { owner: 'profile', size: 120, r: 28, name: p.name });
    $('pfName').textContent = p.name;
    $('pfEq').replaceChildren(...G.CATEGORIES.map(c => {
      const id = p.equipped[c.key], def = G.ITEM_BY_ID[id];
      const chip = iconEl(id, 'sm'); chip.title = `${c.name}: ${def ? def.name : '—'}`; chip.dataset.cat = c.key;
      return chip;
    }));
    $('pfRankLine').textContent = p.rank ? `🏆 Место в рейтинге: #${p.rank}` : '🏆 Пока без места в рейтинге — соберите первую сферу';
    $('pfSince').textContent = 'Аккаунт создан: ' + fmtDate(p.createdAt);
    $('pfBalance').textContent = fmt(p.balance) + ' ◉';
    $('pfTotal').textContent = fmt(p.total);
    $('pfRank').textContent = p.rank ? '#' + fmt(p.rank) : '—';
    $('pfTime').textContent = fmtDur(p.playMs != null ? p.playMs : (p.stats && p.stats.playMs));
    const st = p.stats || {};
    $('pfSessions').textContent = fmt(st.sessions || 0);
    $('pfItems').textContent = `${fmt(p.items != null ? p.items : p.inventory.length)} · ${p.slotsUsed != null ? p.slotsUsed : p.inventory.length}/${p.slots}`;
    $('pfReaction').textContent = st.bestReaction ? st.bestReaction + ' мс' : '—';
    $('pfRush').textContent = st.bestRush ? st.bestRush + ' очк.' : '—';
    $('pfGames').textContent = fmt(st.minigames || 0);
    $('pfUpgrades').textContent = `Улучшения: магнит ${p.upgrades.magnet}/${G.UPGRADES.magnet.max} · ускорение ${p.upgrades.speed}/${G.UPGRADES.speed.max}`;
    const inGame = stage === 'game';
    $('pfPlay').textContent = inGame ? '▶ Продолжить' : '▶ Играть';
    $('profileClose').classList.toggle('hidden', !inGame);
    $('profile').classList.toggle('in-game', inGame);
  }
  let profileReq = 0;
  function openProfile() {
    if (stage !== 'game') return;
    closeModals();
    summary = Object.assign({}, profile, { rank: summary && summary.rank });
    renderProfile(); $('pfError').textContent = '';
    $('profile').classList.remove('hidden');
    const id = ++profileReq;
    socket.emit('profile:get', null, res => { if (res && res.ok && id === profileReq) { summary = res.profile; renderProfile(); } });
  }
  function closeProfile() { if (stage === 'game') $('profile').classList.add('hidden'); }
  function toggleProfile() { $('profile').classList.contains('hidden') ? openProfile() : closeProfile(); }

  // ------------------------------------------------------------ leaderboard
  const safeColor = c => (c === 'rainbow' || /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#3ee0ff');
  function lbRow(p) {
    const tr = document.createElement('tr'); if (p.name === myName) tr.className = 'me';
    const td1 = document.createElement('td'); td1.textContent = p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank;
    const td2 = document.createElement('td');
    const dot = document.createElement('i'); dot.className = 'dot';
    const c = safeColor(p.color);
    dot.style.background = c === 'rainbow' ? 'linear-gradient(90deg,#f55,#ff5,#5f5,#5ff,#a5f)' : c;
    dot.style.boxShadow = '0 0 8px ' + (c === 'rainbow' ? '#fff' : c);
    td2.append(dot, String(p.name));
    if (p.online) { const on = document.createElement('span'); on.className = 'on'; on.title = 'онлайн'; td2.appendChild(on); }
    const td3 = document.createElement('td'); td3.className = 'num'; td3.textContent = fmt(p.total);
    tr.append(td1, td2, td3);
    return tr;
  }
  function msgRow(text) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.className = 'muted'; td.textContent = text; tr.appendChild(td); return tr; }
  function loadLb() {
    const body = $('lbBody'); body.replaceChildren(msgRow('Загрузка…'));
    fetch(`/api/leaderboard?limit=50&name=${encodeURIComponent(myName)}`).then(r => r.json()).then(d => {
      body.replaceChildren(...(d.players.length ? d.players.map(lbRow) : [msgRow('Пока пусто — станьте первым!')]));
      $('lbMe').textContent = d.me ? `Ваше место: #${d.me.rank} из ${d.totalPlayers} · собрано ${fmt(d.me.total)} сфер` : 'Соберите хотя бы одну сферу, чтобы попасть в рейтинг.';
    }).catch(() => { body.replaceChildren(msgRow('Ошибка загрузки')); });
  }
  function loadStartLb() {
    const ol = $('startLb');
    const li = (text, cls, num) => { const el = document.createElement('li'); if (cls) el.className = cls; el.textContent = text; if (num != null) { const b = document.createElement('b'); b.textContent = num; el.append(' ', b); } return el; };
    fetch('/api/leaderboard?limit=5').then(r => r.json()).then(d => {
      ol.replaceChildren(...(d.players.length ? d.players.map(p => li(p.name, '', fmt(p.total))) : [li('Пока никого — будьте первым!', 'muted')]));
    }).catch(() => { ol.replaceChildren(li('Не удалось загрузить', 'muted')); });
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
  (function gameTexts() {
    const re = G.MINIGAMES.reaction, ru = G.MINIGAMES.rush;
    $('reactionPrizes').textContent = G.REACTION_PRIZES.map(([ms, p]) => `<${ms} мс: ${p}`).join(' · ') + ` · пауза ${re.cooldownMs / 1000} с`;
    $('rushPrizes').textContent = `Выплата: ${Math.round(ru.payoutRate * 100)}% от очков, не больше ${ru.maxPrize} сфер · пауза ${ru.cooldownMs / 1000} с`;
    document.querySelectorAll('[data-game]').forEach(b => { b.textContent = `Играть — взнос ${G.MINIGAMES[b.dataset.game].fee} ◉`; });
  })();
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

  // ------------------------------------------------------------ chat
  // User content is only ever rendered with textContent (never innerHTML).
  function nameColorize(el, c) {
    if (c === 'rainbow') el.classList.add('rainbow-text');
    else if (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) el.style.color = c;
  }
  function chatLine(m) {
    const el = document.createElement('div');
    el.className = 'chat-msg' + (m.sys ? ' sys' : '') + (m.notice ? ' notice' : '') + (m.n && m.n === myName ? ' mine' : '');
    if (m.n) { const n = document.createElement('span'); n.className = 'n'; n.textContent = String(m.n); nameColorize(n, m.c); el.append(n, ': '); }
    const t = document.createElement('span'); t.className = 't'; t.textContent = String(m.t == null ? '' : m.t); el.appendChild(t);
    return el;
  }
  function addChat(m, live) {
    if (!m || typeof m !== 'object') return;
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.appendChild(chatLine(m));
    while (chatLog.childElementCount > 80) chatLog.firstElementChild.remove();
    if (atBottom || m.notice || (m.n && m.n === myName)) chatLog.scrollTop = chatLog.scrollHeight;
    if (live && joined && mobileUI() && !chatOpen && m.n && m.n !== myName) { unread++; updateBadge(); showChatToast(m); }
  }
  function resetChat(history) {
    chatLog.textContent = ''; unread = 0; updateBadge();
    for (const m of history) addChat(m, false);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function updateBadge() {
    const b = $('chatBadge');
    b.textContent = unread > 9 ? '9+' : String(unread);
    b.classList.toggle('hidden', unread === 0);
  }
  function showChatToast(m) {
    const el = $('chatToast');
    el.replaceChildren(chatLine(m));
    el.classList.remove('hidden', 'fade');
    clearTimeout(chatToastTimer);
    chatToastTimer = setTimeout(() => { el.classList.add('fade'); chatToastTimer = setTimeout(() => el.classList.add('hidden'), 450); }, 3200);
  }
  // keep the sheet exactly inside the visible area while the on-screen keyboard is open
  function fitSheet() {
    const chat = $('chat'), vv = window.visualViewport;
    if (!chatOpen || !vv) { chat.style.top = ''; chat.style.height = ''; return; }
    chat.style.top = Math.max(0, vv.offsetTop) + 'px';
    chat.style.height = vv.height + 'px';
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', fitSheet); visualViewport.addEventListener('scroll', fitSheet); }
  function openChat() {
    if (!joined) return;
    chatOpen = true; unread = 0; updateBadge();
    for (const k in keys) keys[k] = false;
    pointer.down = false;
    $('chat').classList.add('open'); $('chatToast').classList.add('hidden');
    fitSheet();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function closeChat() {
    chatOpen = false;
    $('chat').classList.remove('open');
    if (document.activeElement === chatInput) chatInput.blur();
    fitSheet();
  }
  $('chatBtn').addEventListener('click', openChat);
  $('chatClose').addEventListener('click', closeChat);
  if (MQ.addEventListener) MQ.addEventListener('change', () => { if (!mobileUI()) closeChat(); });
  chatInput.addEventListener('focus', () => { for (const k in keys) keys[k] = false; pointer.down = false; $('chat').classList.add('active'); });
  chatInput.addEventListener('blur', () => $('chat').classList.remove('active'));
  chatInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); chatInput.blur(); if (mobileUI()) closeChat(); }
  });
  let lastSend = 0;
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) { if (!mobileUI()) chatInput.blur(); return; }
    if (!joined || !socket.connected) { addChat({ notice: true, t: 'Нет связи с сервером' }); return; }
    const now = Date.now();
    if (now - lastSend < 300) return;
    lastSend = now;
    socket.emit('chat', text, res => {
      if (!res || !res.ok) {
        addChat({ notice: true, t: (res && res.error) || 'Сообщение не отправлено' });
        if (!chatInput.value) chatInput.value = text; // let the player retry
      }
    });
    chatInput.value = '';
    if (!mobileUI()) chatInput.blur();
  });
})();
