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
  // multi-colour paints (G.PAINTS): colours are cycled slowly — one interpolated colour per call, cheap enough for every frame
  const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const PAINT_RGB = {};
  for (const [k, p] of Object.entries(G.PAINTS)) PAINT_RGB[k] = p.stops.map(hexRgb);
  const paintOf = v => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(G.PAINTS, v) ? G.PAINTS[v] : null);
  function paintAt(v, x) {
    const c = PAINT_RGB[v], n = c.length; if (n === 1) return `rgb(${c[0][0]},${c[0][1]},${c[0][2]})`;
    const m = ((x % n) + n) % n, i = Math.floor(m), f = m - i, a = c[i], b = c[(i + 1) % n];
    return `rgb(${(a[0] + (b[0] - a[0]) * f) | 0},${(a[1] + (b[1] - a[1]) * f) | 0},${(a[2] + (b[2] - a[2]) * f) | 0})`;
  }
  const colorOf = (eq, t) => { const v = itemVal(eq.color) || '#3ee0ff'; return v === 'rainbow' ? rainbow(t) : paintOf(v) ? paintAt(v, t * 0.6) : v; };

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
    evResultHide(); setEvent(res.event || null); runner = null;
    updateHud();
    if (!reconnect) toast(`Добро пожаловать, ${myName}! Собирайте сферы.`, 'ok');
  }
  function hideGameUi() {
    joined = false; evState = null; runner = null;
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
  socket.on('legend:soon', d => { const sec = Math.max(1, Math.round(((d && d.in) || 0) / 1000)); toast(`🧭 Чутьё легенды: легендарная сфера появится через ~${sec} с`, 'ok'); });

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
    for (const [id, x, y, t, e] of st.oa) orbs.set(id, { x, y, t, born: now, fall: e && t !== 't' ? 1 : 0 }); // e: event orb (rain falls in)
    if (st.rn) {
      if (!runner) runner = { x: st.rn[0], y: st.rn[1], px: st.rn[0], py: st.rn[1], at: now };
      else { runner.px = runnerX(now); runner.py = runnerY(now); runner.x = st.rn[0]; runner.y = st.rn[1]; runner.at = now; }
    } else runner = null;
    for (const [id, pid] of st.od) {
      const o = orbs.get(id);
      if (!o) continue;
      orbs.delete(id);
      fx.push({ o, pid, start: now });
      if (pid === myId) {
        const ot = orbDef(o.t);
        floaters.push({ x: o.x, y: o.y - 10, text: o.t === 't' ? '💰 Сокровище!' : '+' + ot.value, color: ot.color, start: now, big: o.t !== 'c' && o.t !== 'u' });
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
    if (b.l > 0 && joined) floaters.push({ x: dispMe.x + 18, y: dispMe.y - 30, text: '×2!', color: '#4fd36b', start: performance.now(), big: true }); // «Удача»
    if (b.j > 0 && joined) floaters.push({ x: dispMe.x - 10, y: dispMe.y - 52, text: `★ Находка! +${G.ORB_TYPES.e.value}`, color: '#ff9a2e', start: performance.now(), big: true }); // «Удача»: jackpot
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
    if (e.code === 'KeyH') toggleOrbHelp();
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
  function makeOrbSprite(t) {
    const size = Math.ceil(t.r * 8), c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d'), mid = size;
    const grd = g.createRadialGradient(mid, mid, 0, mid, mid, size);
    grd.addColorStop(0, t.glow + '0.55)'); grd.addColorStop(0.18, t.glow + '0.28)'); grd.addColorStop(0.45, t.glow + '0.08)'); grd.addColorStop(1, t.glow + '0)');
    g.fillStyle = grd; g.fillRect(0, 0, size * 2, size * 2);
    const core = g.createRadialGradient(mid - t.r * 0.35, mid - t.r * 0.35, 0, mid, mid, t.r * 2);
    core.addColorStop(0, '#ffffff'); core.addColorStop(0.35, t.color); core.addColorStop(1, t.glow + '0.9)');
    g.fillStyle = core; g.beginPath(); g.arc(mid, mid, t.r * 2, 0, Math.PI * 2); g.fill();
    return { c, half: size / 2 };
  }
  for (const t of Object.values(G.ORB_TYPES)) orbSprites[t.key] = makeOrbSprite(t);
  orbSprites.runner = makeOrbSprite({ r: 14, color: '#c6fdff', glow: 'rgba(125,252,255,' });
  const orbDef = type => (Object.prototype.hasOwnProperty.call(G.ORB_TYPES, type) ? G.ORB_TYPES[type] : G.ORB_TYPES.c); // unknown tier → common look
  function drawOrb(g, x, y, type, t, id, scale = 1) {
    const s = orbSprites[type] || orbSprites.c, ot = orbDef(type);
    const pulse = (1 + 0.09 * Math.sin(t * 3.2 + id * 1.7)) * scale;
    const half = s.half * pulse;
    if (type === 't') { // treasure: a light pillar so it can be spotted from afar
      const gr = g.createLinearGradient(0, y - ot.r * 9, 0, y);
      gr.addColorStop(0, 'rgba(255,230,128,0)'); gr.addColorStop(1, `rgba(255,230,128,${0.32 * scale})`);
      g.fillStyle = gr; g.fillRect(x - ot.r * 0.7, y - ot.r * 9, ot.r * 1.4, ot.r * 9);
    }
    g.drawImage(s.c, x - half, y - half, half * 2, half * 2);
    if (type === 'e') { // epic: two orbiting sparks
      g.save(); g.fillStyle = '#ffe0b8';
      for (let i = 0; i < 2; i++) { const a = t * 2.4 + i * Math.PI + id; g.beginPath(); g.arc(x + Math.cos(a) * ot.r * 1.9 * pulse, y + Math.sin(a) * ot.r * 1.9 * pulse, 2.2 * scale, 0, Math.PI * 2); g.fill(); }
      g.restore();
    } else if (type === 'l') {
      g.save(); g.translate(x, y); g.rotate(t * 1.4);
      g.strokeStyle = 'rgba(255,240,180,0.85)'; g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.moveTo(Math.cos(a) * ot.r * 1.2, Math.sin(a) * ot.r * 1.2); g.lineTo(Math.cos(a) * ot.r * 2.4 * pulse, Math.sin(a) * ot.r * 2.4 * pulse); }
      g.stroke(); g.restore();
    } else if (type === 'm') { // mythic: six rays + a counter-rotating dashed halo
      g.save(); g.translate(x, y); g.rotate(t * 1.8);
      g.strokeStyle = 'rgba(255,170,200,0.9)'; g.lineWidth = 1.8; g.beginPath();
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; g.moveTo(Math.cos(a) * ot.r * 1.2, Math.sin(a) * ot.r * 1.2); g.lineTo(Math.cos(a) * ot.r * 2.7 * pulse, Math.sin(a) * ot.r * 2.7 * pulse); }
      g.stroke(); g.rotate(-t * 3.2);
      g.setLineDash([4, 5]); g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(0, 0, ot.r * 1.85 * pulse, 0, Math.PI * 2); g.stroke();
      g.restore();
    } else if (type === 't') { // treasure: a little golden gem on top
      g.save(); g.translate(x, y); g.rotate(Math.sin(t * 2 + id) * 0.25);
      const k = ot.r * 0.75 * scale;
      g.fillStyle = '#fff6c8'; g.strokeStyle = '#b8860b'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(0, -k); g.lineTo(k * 0.8, -k * 0.25); g.lineTo(0, k); g.lineTo(-k * 0.8, -k * 0.25); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
  }

  const SHAPE_TOP = { circle: 1, square: 0.9, triangle: 1.15, hexagon: 1.05, star: 1.3,
    diamond: 1.3, pentagon: 1.12, octagon: 1.0, drop: 1.5, cross: 1.15, heart: 0.95, gear: 1.15, flower: 1.15, blob: 1.08, crystal: 1.4 };
  const CRYSTAL_PTS = [[0, -1.4], [0.78, -0.55], [0.78, 0.55], [0, 1.4], [-0.78, 0.55], [-0.78, -0.55]];
  function polarPath(g, n, rf) { for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2, rr = rf(a); const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? g.lineTo(x, y) : g.moveTo(x, y); } }
  function polyPath(g, n, rr, rot) { for (let i = 0; i < n; i++) { const a = rot + i * 2 * Math.PI / n; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? g.lineTo(x, y) : g.moveTo(x, y); } }
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
    } else if (shape === 'diamond') {
      g.moveTo(0, -r * 1.3); g.lineTo(r * 1.1, 0); g.lineTo(0, r * 1.3); g.lineTo(-r * 1.1, 0);
    } else if (shape === 'pentagon') {
      polyPath(g, 5, r * 1.12, -Math.PI / 2);
    } else if (shape === 'octagon') {
      polyPath(g, 8, r * 1.07, Math.PI / 8);
    } else if (shape === 'drop') { // teardrop, tip up
      const cy = r * 0.12, tip = -r * 1.5, a = Math.acos(r / (cy - tip));
      g.moveTo(0, tip); g.arc(0, cy, r, -Math.PI / 2 + a, -Math.PI / 2 - a + Math.PI * 2);
    } else if (shape === 'cross') {
      const a = r * 0.45, b = r * 1.15;
      [[-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    } else if (shape === 'heart') {
      g.moveTo(0, r * 1.15);
      g.bezierCurveTo(-r * 1.55, r * 0.05, -r * 1.05, -r * 1.3, 0, -r * 0.5);
      g.bezierCurveTo(r * 1.05, -r * 1.3, r * 1.55, r * 0.05, 0, r * 1.15);
    } else if (shape === 'gear') {
      const rot = t * 0.5, n = 10, ro = r * 1.18, ri = r * 0.96;
      for (let i = 0; i < n; i++) {
        const a = rot + i * 2 * Math.PI / n, s = Math.PI / n;
        const pts = [[ri, a - s * 0.95], [ro, a - s * 0.5], [ro, a + s * 0.5], [ri, a + s * 0.95]];
        pts.forEach(([rr, aa], j) => { const x = Math.cos(aa) * rr, y = Math.sin(aa) * rr; i || j ? g.lineTo(x, y) : g.moveTo(x, y); });
      }
    } else if (shape === 'flower') {
      const rot = t * 0.3; polarPath(g, 48, a => r * (0.97 + 0.2 * Math.cos(6 * (a - rot))));
    } else if (shape === 'crystal') { // exclusive: tall hexagonal crystal
      CRYSTAL_PTS.forEach(([x, y], i) => (i ? g.lineTo(x * r, y * r) : g.moveTo(x * r, y * r)));
    } else if (shape === 'blob') { // wobbling jelly (legendary)
      polarPath(g, 32, a => r * (1.02 + 0.08 * Math.sin(3 * a + t * 3) + 0.05 * Math.sin(5 * a - t * 2.3)));
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
    } else if (hat === 'beanie') {
      g.fillStyle = '#35b9aa'; g.beginPath(); g.arc(0, y + 6, r * 0.78, Math.PI, 0); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1.2; g.beginPath();
      for (let i = -2; i <= 2; i++) { g.moveTo(i * r * 0.2, y + 2); g.lineTo(i * r * 0.16, y + 6 - r * 0.66); } g.stroke();
      g.fillStyle = '#23887d'; g.beginPath(); g.roundRect(-r * 0.84, y + 1, r * 1.68, 6, 3); g.fill();
      g.fillStyle = '#f2f6ff'; g.beginPath(); g.arc(0, y + 6 - r * 0.8, 4, 0, Math.PI * 2); g.fill();
    } else if (hat === 'party') {
      const h = r * 1.25;
      g.save(); g.beginPath(); g.moveTo(-r * 0.5, y + 4); g.lineTo(r * 0.5, y + 4); g.lineTo(0, y + 4 - h); g.closePath();
      g.fillStyle = '#ff5fd2'; g.fill(); g.clip();
      g.strokeStyle = '#ffd34d'; g.lineWidth = 3.5; g.beginPath();
      for (let i = 0; i < 4; i++) { const yy = y + 4 - i * h * 0.3; g.moveTo(-r, yy + 4); g.lineTo(r, yy - 6); } g.stroke(); g.restore();
      g.fillStyle = '#3ee0ff'; g.shadowColor = '#3ee0ff'; g.shadowBlur = 6; g.beginPath(); g.arc(0, y + 4 - h, 3.5, 0, Math.PI * 2); g.fill();
    } else if (hat === 'bunny') {
      for (const s of [-1, 1]) {
        g.save(); g.translate(s * r * 0.36, y + 2); g.rotate(s * (0.2 + Math.sin(t * 2.2 + s) * 0.05));
        g.fillStyle = '#f4f4ff'; g.beginPath(); g.ellipse(0, -r * 0.6, r * 0.22, r * 0.66, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffb3d1'; g.beginPath(); g.ellipse(0, -r * 0.58, r * 0.11, r * 0.48, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    } else if (hat === 'cat') {
      for (const s of [-1, 1]) {
        g.fillStyle = '#2f2b45'; g.beginPath(); g.moveTo(s * r * 0.92, y + r * 0.42); g.lineTo(s * r * 0.78, y - r * 0.5); g.lineTo(s * r * 0.18, y + r * 0.06); g.closePath(); g.fill();
        g.fillStyle = '#ff9ccc'; g.beginPath(); g.moveTo(s * r * 0.78, y + r * 0.26); g.lineTo(s * r * 0.72, y - r * 0.24); g.lineTo(s * r * 0.38, y + r * 0.08); g.closePath(); g.fill();
      }
    } else if (hat === 'headphones') {
      g.strokeStyle = '#2b2f45'; g.lineWidth = 4; g.beginPath(); g.arc(0, 0, top * r + 3, Math.PI + 0.35, -0.35); g.stroke();
      g.fillStyle = '#ff4d6d'; g.shadowColor = '#ff4d6d'; g.shadowBlur = 8;
      for (const s of [-1, 1]) { g.beginPath(); g.roundRect(s * (r * 1.02) - 4.5, -r * 0.45, 9, 15, 4); g.fill(); }
    } else if (hat === 'cowboy') {
      g.fillStyle = '#9a5a26'; g.beginPath(); g.ellipse(0, y + 3, r * 1.2, r * 0.24, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#b8733a'; g.beginPath(); g.moveTo(-r * 0.58, y + 3); g.lineTo(-r * 0.5, y - r * 0.62);
      g.quadraticCurveTo(0, y - r * 0.35, r * 0.5, y - r * 0.62); g.lineTo(r * 0.58, y + 3); g.closePath(); g.fill();
      g.fillStyle = '#5a3415'; g.fillRect(-r * 0.57, y - 2, r * 1.14, 4);
    } else if (hat === 'horns') {
      for (const s of [-1, 1]) {
        const gr = g.createLinearGradient(0, y + 5, 0, y - r * 0.75); gr.addColorStop(0, '#c41f2f'); gr.addColorStop(1, '#ff6b5e');
        g.fillStyle = gr; g.beginPath(); g.moveTo(s * r * 0.62, y + 6); g.quadraticCurveTo(s * r * 1.08, y - r * 0.1, s * r * 0.92, y - r * 0.75);
        g.quadraticCurveTo(s * r * 0.68, y - r * 0.15, s * r * 0.22, y + 4); g.closePath(); g.fill();
      }
    } else if (hat === 'viking') {
      for (const s of [-1, 1]) {
        g.fillStyle = '#f1e6c8'; g.beginPath(); g.moveTo(s * r * 0.7, y + 4); g.quadraticCurveTo(s * r * 1.3, y - r * 0.05, s * r * 1.22, y - r * 0.85);
        g.quadraticCurveTo(s * r * 1.02, y - r * 0.2, s * r * 0.55, y - 2); g.closePath(); g.fill();
      }
      g.fillStyle = '#9aa3b5'; g.beginPath(); g.arc(0, y + 7, r * 0.8, Math.PI, 0); g.closePath(); g.fill();
      g.fillStyle = '#6b5332'; g.fillRect(-r * 0.82, y + 3, r * 1.64, 5);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(-r * 0.25, y - r * 0.25, 3, 0, Math.PI * 2); g.fill();
    } else if (hat === 'propeller') {
      const segs = ['#ff4d6d', '#ffd34d', '#3e8bff'];
      for (let i = 0; i < 3; i++) { g.fillStyle = segs[i]; g.beginPath(); g.moveTo(0, y + 5); g.arc(0, y + 5, r * 0.72, Math.PI + i * Math.PI / 3, Math.PI + (i + 1) * Math.PI / 3); g.closePath(); g.fill(); }
      g.strokeStyle = '#dfe6ff'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, y + 5 - r * 0.72); g.lineTo(0, y - r * 0.95); g.stroke();
      const w = r * 0.85 * Math.abs(Math.cos(t * 9)) + 2;
      g.fillStyle = '#3ee0ff'; g.beginPath(); g.ellipse(-w / 2, y - r * 0.95, w / 2, 2.6, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff4d6d'; g.beginPath(); g.ellipse(w / 2, y - r * 0.95, w / 2, 2.6, 0, 0, Math.PI * 2); g.fill();
    } else if (hat === 'wizard') {
      g.fillStyle = '#3a2a8f'; g.beginPath(); g.ellipse(0, y + 4, r * 0.98, r * 0.2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#5236c9'; g.beginPath(); g.moveTo(-r * 0.56, y + 3); g.quadraticCurveTo(-r * 0.2, y - r * 0.8, r * 0.3, y - r * 1.62);
      g.quadraticCurveTo(r * 0.18, y - r * 0.7, r * 0.56, y + 3); g.closePath(); g.fill();
      g.fillStyle = '#ffd34d'; g.fillRect(-r * 0.52, y - 1, r * 1.04, 3.5);
      g.shadowColor = '#ffe680'; g.shadowBlur = 8;
      [[-r * 0.12, y - r * 0.45, 3.2, 0], [r * 0.16, y - r * 0.95, 2.4, 1.7], [r * 0.3, y - r * 1.62, 3 + Math.sin(t * 4) * 0.8, 3.1]].forEach(([sx, sy, sr, ph]) => {
        g.globalAlpha = 0.65 + 0.35 * Math.sin(t * 3 + ph); g.fillStyle = '#fff3a0'; g.beginPath();
        g.moveTo(sx, sy - sr); g.quadraticCurveTo(sx, sy, sx + sr, sy); g.quadraticCurveTo(sx, sy, sx, sy + sr); g.quadraticCurveTo(sx, sy, sx - sr, sy); g.quadraticCurveTo(sx, sy, sx, sy - sr); g.fill();
      });
      g.globalAlpha = 1;
    } else if (hat === 'shardcrown') { // exclusive: a crown of floating legendary shards
      const by = y + 4, bob = Math.sin(t * 2.2) * 1.5;
      g.fillStyle = '#c99a1e'; g.beginPath(); g.roundRect(-r * 0.8, by - 4, r * 1.6, 6, 3); g.fill();
      const spikes = [[-0.62, 0.55, -0.32], [-0.3, 0.8, -0.14], [0, 1.08, 0], [0.3, 0.8, 0.14], [0.62, 0.55, 0.32]];
      g.shadowColor = '#ffcc33'; g.shadowBlur = 14;
      spikes.forEach(([sx, h, rot], i) => {
        g.save(); g.translate(sx * r, by - 4 + (i % 2 ? bob : -bob) * 0.6); g.rotate(rot);
        const w = r * 0.17, hh = r * h;
        const gr = g.createLinearGradient(0, 0, 0, -hh); gr.addColorStop(0, '#c78b00'); gr.addColorStop(0.5, i === 2 ? '#9de8ff' : '#ffcc33'); gr.addColorStop(1, '#fff7c4');
        g.fillStyle = gr; g.beginPath(); g.moveTo(-w, 0); g.lineTo(-w * 0.8, -hh * 0.7); g.lineTo(0, -hh); g.lineTo(w * 0.8, -hh * 0.7); g.lineTo(w, 0); g.closePath(); g.fill();
        g.restore();
      });
      g.shadowBlur = 0; g.fillStyle = '#fff';
      for (let i = 0; i < 3; i++) { const a = t * 1.6 + i * 2.1; g.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(t * 3 + i)); g.beginPath(); g.arc(Math.cos(a) * r * 0.95, by - r * 0.6 + Math.sin(a) * r * 0.25, 1.6, 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = 1;
    } else if (hat === 'satellites') { // exclusive: three little moons orbiting the head
      const cy = y - r * 0.15, ox = r * 1.15, oy = r * 0.32, cols = ['#9de8ff', '#ffcc33', '#ff9de2'];
      g.strokeStyle = 'rgba(200,220,255,0.35)'; g.lineWidth = 1; g.beginPath(); g.ellipse(0, cy, ox, oy, 0, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 3; i++) {
        const a = t * 1.9 + i * Math.PI * 2 / 3, sx = Math.cos(a) * ox, sy = cy + Math.sin(a) * oy, depth = 0.65 + 0.35 * Math.sin(a);
        g.fillStyle = cols[i]; g.shadowColor = cols[i]; g.shadowBlur = 10 * depth; g.globalAlpha = 0.55 + 0.45 * depth;
        g.beginPath(); g.arc(sx, sy, (3 + 1.6 * depth), 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    g.restore();
  }
  // vertical room the hat takes above the body (nickname is drawn above it)
  const HAT_ROOM = { none: () => 10, tophat: r => r * 1.05 + 8, party: r => r * 1.25 + 4, bunny: r => r * 1.2 + 4, wizard: r => r * 1.62 + 6,
    propeller: r => r * 0.95 + 6, viking: r => r * 0.85 + 6, cowboy: r => r * 0.62 + 8, headphones: () => 14, cat: r => r * 0.5 + 8, shardcrown: r => r * 1.08 + 8, satellites: r => r * 0.5 + 8 };
  const hatRoom = (hat, r) => (HAT_ROOM[hat] ? HAT_ROOM[hat](r) : 22);

  function drawAvatar(g, x, y, r, eq, t, opts = {}) {
    const color = opts.color || colorOf(eq, t + (opts.phase || 0));
    const paintKey = opts.color ? null : itemVal(eq.color), paint = paintOf(paintKey);
    const color2 = paint ? paintAt(paintKey, (t + (opts.phase || 0)) * 0.6 + paint.stops.length / 2) : color;
    const shape = itemVal(eq.shape) || 'circle';
    const top = SHAPE_TOP[shape] || 1;
    g.save(); g.translate(x, y);
    g.shadowColor = paint && paint.glow ? paint.glow : color; g.shadowBlur = (opts.isMe ? 26 : 18) + (paint && paint.fx === 'embers' ? 6 + 6 * Math.sin(t * 4) : 0) + (paint && paint.fx === 'void' ? 8 + 6 * Math.sin(t * 2.5) : 0);
    shapePath(g, shape, r, t);
    const grd = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.1, 0, 0, r * 1.4);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, color); grd.addColorStop(1, color2);
    g.fillStyle = grd; g.fill();
    if (opts.staticRainbow && (itemVal(eq.color) === 'rainbow' || paint)) { // icons: whole rainbow / paint at once instead of the animated colour
      const rb = g.createLinearGradient(-r, -r, r, r);
      if (paint) paint.stops.forEach((c, i) => rb.addColorStop(i / Math.max(1, paint.stops.length - 1), c));
      else for (let i = 0; i <= 5; i++) rb.addColorStop(i / 5, `hsl(${i * 60},100%,62%)`);
      g.fillStyle = rb; g.fill();
      const hl = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.05, -r * 0.2, -r * 0.2, r * 1.1);
      hl.addColorStop(0, 'rgba(255,255,255,0.85)'); hl.addColorStop(0.35, 'rgba(255,255,255,0.12)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = hl; g.fill();
    }
    g.shadowBlur = 0;
    if (paint && paint.fx === 'prism') { // prism: a bright sheen sweeping across the body
      g.save(); g.clip();
      const p = ((t * 0.45) % 1.6) - 0.3, sx = -r * 1.6 + p * r * 3.2;
      const sh = g.createLinearGradient(sx - r * 0.5, -r, sx + r * 0.5, r);
      sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.75)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = sh; g.fillRect(-r * 2, -r * 2, r * 4, r * 4); g.restore();
    }
    if (shape === 'crystal') { // facets
      g.save(); g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.2; g.beginPath();
      g.moveTo(0, -1.4 * r); g.lineTo(0, 1.4 * r); g.moveTo(-0.78 * r, -0.55 * r); g.lineTo(0, -0.2 * r); g.lineTo(0.78 * r, -0.55 * r);
      g.moveTo(-0.78 * r, 0.55 * r); g.lineTo(0, 0.2 * r); g.lineTo(0.78 * r, 0.55 * r); g.stroke(); g.restore();
    }
    g.lineWidth = 2; g.strokeStyle = paint && paint.fx === 'void' ? `rgba(190,140,255,${0.65 + 0.3 * Math.sin(t * 3)})` : 'rgba(255,255,255,0.45)'; g.stroke();
    if (paint && paint.fx === 'void') { // void: violet motes swirling inside the dark body
      g.fillStyle = '#c9a6ff';
      for (let i = 0; i < 5; i++) {
        const a = t * (0.9 + i * 0.13) + i * 1.3, rr = r * (0.25 + 0.12 * i);
        g.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(t * 2 + i)); g.beginPath(); g.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.9, r * 0.06, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    if (paint && paint.fx === 'stars') { // galaxy: a few twinkling stars on the body
      g.fillStyle = '#fff';
      [[-0.45, 0.35, 0], [0.42, -0.05, 2.1], [0.1, 0.55, 4.2], [-0.15, -0.5, 1.3]].forEach(([sx, sy, ph]) => {
        g.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 2.2 + ph)); g.beginPath(); g.arc(sx * r, sy * r, r * 0.07, 0, Math.PI * 2); g.fill();
      });
      g.globalAlpha = 1;
    } else if (paint && paint.fx === 'embers') { // lava: dark crust patches
      g.fillStyle = 'rgba(40,6,0,0.45)';
      [[-0.5, 0.4, 0.22], [0.45, 0.35, 0.16], [0.05, 0.7, 0.13]].forEach(([sx, sy, sr]) => { g.beginPath(); g.arc(sx * r, sy * r, sr * r, 0, Math.PI * 2); g.fill(); });
    }
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
      const ny = -top * r - hatRoom(hat, r);
      drawNameTag(g, opts.name, 0, ny, itemVal(eq.nameColor) || '#fff', t, opts.isMe ? 14 : 13);
    }
    g.restore();
  }
  // nickname text exactly as in the arena (also used for the nickname-color icons)
  function drawNameTag(g, text, x, y, nc, t, px, weight = 700) {
    g.font = `${weight} ${px}px Segoe UI, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    let fill = nc;
    const paint = paintOf(nc);
    if (nc === 'rainbow') {
      const w = g.measureText(text).width;
      fill = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      for (let i = 0; i <= 4; i++) fill.addColorStop(i / 4, rainbow(t, i * 70));
    } else if (paint && !paint.fx) {
      const w = g.measureText(text).width, n = paint.stops.length;
      fill = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      for (let i = 0; i <= 3; i++) fill.addColorStop(i / 3, paintAt(nc, t * 0.8 + i * n / 4));
    } else if (paint && paint.fx === 'shard') {
      const w = g.measureText(text).width, gp = ((t * 0.5) % 1.5) - 0.25;
      fill = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      fill.addColorStop(0, '#ffcc33'); fill.addColorStop(1, '#ffb000');
      for (const [o, c] of [[-0.12, '#ffd966'], [0, '#ffffff'], [0.12, '#9de8ff']]) { const q = gp + o; if (q > 0 && q < 1) fill.addColorStop(q, c); }
    } else if (paint) fill = paint.base;
    g.lineWidth = Math.max(4, px * 0.22); g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.strokeText(text, x, y);
    if (paint && paint.fx === 'glitch') { // RGB-split flicker in short bursts
      const burst = Math.sin(t * 7) > 0.55 || ((t * 0.9) % 1) < 0.1, o = Math.max(1.5, px * 0.09);
      if (burst) {
        g.globalAlpha = 0.85; g.fillStyle = '#ff2fd6'; g.fillText(text, x - o, y); g.fillStyle = '#2ff3ff'; g.fillText(text, x + o, y + (Math.sin(t * 31) > 0 ? 1 : -1)); g.globalAlpha = 1;
      }
      g.fillStyle = '#ffffff'; g.fillText(text, x, y);
      return;
    }
    if (paint && paint.fx === 'pulse') { // neon: glow + brightness pulse
      const k = 0.5 + 0.5 * Math.sin(t * 4);
      g.save(); g.shadowColor = paint.base; g.shadowBlur = 4 + 10 * k; g.fillStyle = paintAt(nc, k); g.fillText(text, x, y); g.restore();
      return;
    }
    g.fillStyle = fill; g.fillText(text, x, y);
    if (paint && paint.fx === 'shard') { // a tiny sparkle hopping along the nickname
      const w = g.measureText(text).width, k = Math.abs(Math.sin(t * 2.6));
      g.save(); g.globalAlpha = k; g.fillStyle = '#fff'; g.shadowColor = '#ffcc33'; g.shadowBlur = 8; g.beginPath();
      starPath(g, x + w / 2 + 3, y - px * 0.85, 2 + 2.5 * k, t); g.fill(); g.restore();
    }
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
    } else if (TRAILS[kind]) {
      TRAILS[kind](g, pts, n, t, now, pl);
    }
    g.restore();
  }
  // New trails: plain fills/strokes only (no per-point gradients or shadows) so dozens of players stay cheap, also on mobile.
  // Every effect is deterministic from the point's own seed/age (no Math.random while drawing).
  const ageK = (p, now, life = 650) => 1 - (now - p.time) / life;
  const hash = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  function heartPath(g, x, y, s) {
    g.moveTo(x, y + s * 0.9); g.bezierCurveTo(x - s * 1.4, y, x - s * 0.8, y - s * 1.1, x, y - s * 0.35);
    g.bezierCurveTo(x + s * 0.8, y - s * 1.1, x + s * 1.4, y, x, y + s * 0.9);
  }
  function starPath(g, x, y, ro, rot) {
    for (let i = 0; i < 10; i++) { const a = rot - Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ro * 0.45 : ro; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.closePath();
  }
  const TRAILS = {
    comet(g, pts, n, t, now) { // exclusive: a thick tapered tail, white-hot at the head
      g.lineCap = 'round';
      for (let i = 1; i < n; i++) {
        const k = i / n;
        g.globalAlpha = 0.25 + k * 0.7; g.lineWidth = 2 + k * 14;
        g.strokeStyle = k > 0.8 ? '#fff7d6' : k > 0.5 ? '#ffcf5a' : k > 0.25 ? '#ff8a2e' : '#ff4d3a';
        g.beginPath(); g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); g.stroke();
      }
      g.globalCompositeOperation = 'lighter'; g.fillStyle = '#ffe9a0';
      for (let i = 0; i < n; i += 3) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        g.globalAlpha = k * 0.8; g.beginPath(); g.arc(p.x + (p.seed - 0.5) * 18, p.y + (hash(p.seed, 2) - 0.5) * 18, 1 + k * 1.6, 0, Math.PI * 2); g.fill();
      }
    },
    crystal(g, pts, n, t, now) { // exclusive: spinning crystal shards
      const pal = ['#9de8ff', '#ffffff', '#c7a6ff', '#7cc8ff'];
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now, 750); if (k <= 0) continue;
        const s = 2.5 + k * 4.5;
        g.save(); g.translate(p.x + (p.seed - 0.5) * 12, p.y + (hash(p.seed, 3) - 0.5) * 12 + (1 - k) * 6); g.rotate(p.seed * 6.28 + t * 3);
        g.globalAlpha = k; g.fillStyle = pal[Math.floor(p.seed * 4) % 4];
        g.beginPath(); g.moveTo(0, -s * 1.5); g.lineTo(s * 0.6, 0); g.lineTo(0, s * 1.5); g.lineTo(-s * 0.6, 0); g.closePath(); g.fill();
        g.globalAlpha = k * 0.7; g.strokeStyle = '#fff'; g.lineWidth = 0.8; g.stroke();
        g.restore();
      }
    },
    smoke(g, pts, n, t, now) {
      g.fillStyle = 'rgb(176,186,210)';
      for (let i = 0; i < n; i++) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        g.globalAlpha = 0.26 * k; g.beginPath(); g.arc(p.x + (p.seed - 0.5) * 8, p.y - (1 - k) * 9, 5 + (1 - k) * 12, 0, Math.PI * 2); g.fill();
      }
    },
    bubbles(g, pts, n, t, now) {
      g.lineWidth = 1.5;
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        const x = p.x + Math.sin(p.seed * 6.28 + (1 - k) * 5) * 6, y = p.y - (1 - k) * 16, rr = 2.5 + p.seed * 4.5;
        g.globalAlpha = 0.9 * k; g.strokeStyle = '#9fe9ff'; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x - rr * 0.35, y - rr * 0.35, Math.max(0.8, rr * 0.25), 0, Math.PI * 2); g.fill();
      }
    },
    pixel(g, pts, n, t, now) {
      const pal = ['#ff4d6d', '#ffd34d', '#3ee0ff', '#9dff4f'];
      for (let i = 0; i < n; i++) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        for (let j = 0; j < 2; j++) {
          const sd = (p.seed + j * 0.5) % 1, sz = 3 + Math.round(k * 3);
          const x = Math.round((p.x + (sd - 0.5) * 14) / 4) * 4, y = Math.round((p.y + (hash(sd, j) - 0.5) * 14) / 4) * 4;
          g.globalAlpha = k; g.fillStyle = pal[Math.floor(sd * 4) % 4]; g.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }
    },
    leaves(g, pts, n, t, now) {
      const pal = ['#7ed957', '#ffb347', '#e8743b'];
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        g.save(); g.translate(p.x + Math.sin(p.seed * 9 + (1 - k) * 4) * 7, p.y + (1 - k) * 14); g.rotate(p.seed * 6.28 + (1 - k) * 3);
        g.globalAlpha = k; g.fillStyle = pal[Math.floor(p.seed * 3) % 3]; g.beginPath(); g.ellipse(0, 0, 5, 2.4, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-4, 0); g.lineTo(4, 0); g.stroke();
        g.restore();
      }
    },
    snow(g, pts, n, t, now) {
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.3; g.lineCap = 'round';
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now, 800); if (k <= 0) continue;
        const x = p.x + Math.sin(p.seed * 6.28 + (1 - k) * 4) * 6, y = p.y + (1 - k) * 12, rr = 2.5 + p.seed * 2;
        g.globalAlpha = k; g.beginPath();
        for (let a = 0; a < 3; a++) { const an = a * Math.PI / 3 + p.seed; g.moveTo(x - Math.cos(an) * rr, y - Math.sin(an) * rr); g.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr); }
        g.stroke();
      }
    },
    hearts(g, pts, n, t, now) {
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        g.globalAlpha = k; g.fillStyle = p.seed < 0.5 ? '#ff5fa2' : '#ff8fc2';
        g.beginPath(); heartPath(g, p.x + (p.seed - 0.5) * 10, p.y - (1 - k) * 16, 3.5 + k * 3.5); g.fill();
      }
    },
    stars(g, pts, n, t, now) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i += 2) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        g.globalAlpha = k; g.fillStyle = p.seed < 0.6 ? '#ffe066' : '#fff6c2';
        g.beginPath(); starPath(g, p.x + (p.seed - 0.5) * 12, p.y + (hash(p.seed, 1) - 0.5) * 12, 3.5 + k * 4, p.seed * 6 + t * 2); g.fill();
      }
    },
    lightning(g, pts, n, t, now) {
      const q = Math.floor(now / 70); // re-jag ~14×/s
      g.lineJoin = 'round'; g.lineCap = 'round';
      const path = () => {
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const p = pts[i], prev = pts[Math.max(0, i - 1)], dx = p.x - prev.x, dy = p.y - prev.y, l = Math.hypot(dx, dy) || 1;
          const off = (hash(i, q) - 0.5) * 12 * (i / n);
          const x = p.x - dy / l * off, y = p.y + dx / l * off; i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
      };
      g.globalAlpha = 0.35; g.strokeStyle = '#7cc8ff'; g.lineWidth = 7; path(); g.stroke();
      g.globalAlpha = 0.95; g.strokeStyle = '#eaffff'; g.lineWidth = 2; path(); g.stroke();
    },
    rainbow(g, pts, n, t, now) {
      g.lineCap = 'round';
      for (let i = 1; i < n; i++) {
        const k = i / n;
        g.globalAlpha = k * 0.85; g.lineWidth = 3 + k * 10; g.strokeStyle = `hsl(${(i * 24 + t * 140) % 360},100%,62%)`;
        g.beginPath(); g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); g.stroke();
      }
    },
    galaxy(g, pts, n, t, now) {
      const pal = ['#8a3cff', '#ff4fd8', '#3ee0ff', '#ffffff'];
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const p = pts[i], k = ageK(p, now); if (k <= 0) continue;
        for (let j = 0; j < 2; j++) {
          const sd = (p.seed + j * 0.37) % 1, d = (1 - k) * 18 + 3, a = sd * 20;
          g.globalAlpha = k * (0.6 + 0.4 * Math.sin(t * 6 + sd * 9)); g.fillStyle = pal[Math.floor(sd * 4) % 4];
          g.beginPath(); g.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 1 + k * 2.2, 0, Math.PI * 2); g.fill();
        }
        if (i % 5 === 0) { g.globalAlpha = k; g.fillStyle = '#ffffff'; g.beginPath(); starPath(g, p.x, p.y, 2 + k * 3, t); g.fill(); }
      }
    },
  };

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

    drawEventZone(t, now);
    // orbs
    const pad = 60;
    for (const [id, o] of orbs) {
      if (o.x < cam.x - pad || o.x > cam.x + W + pad || o.y < cam.y - pad - (o.fall ? 320 : 0) || o.y > cam.y + H + pad) continue;
      let k = Math.min(1, (now - o.born) / 350), oy = o.y;
      if (o.fall) { // «Сферный дождь»: event orbs drop in from above
        const f = Math.min(1, (now - o.born) / 600);
        if (f >= 1) o.fall = 0;
        else {
          k = 1; oy = o.y - (1 - f) * (1 - f) * 320;
          const ot = orbDef(o.t); ctx.strokeStyle = ot.glow + '0.45)'; ctx.lineWidth = ot.r * 0.9; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(o.x, oy - 50); ctx.lineTo(o.x, oy); ctx.stroke();
          ctx.fillStyle = ot.glow + (0.25 * f) + ')'; ctx.beginPath(); ctx.ellipse(o.x, o.y, ot.r * 1.4 * f, ot.r * 0.5 * f, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      drawOrb(ctx, o.x, oy, o.t, t, id, k);
    }
    drawRunner(t, now);
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
    drawCompass(t, now);
    if (frameNo % 2 === 0) drawMinimap(now);
    drawPreviews(t, now);
    if (rushActive) drawRush(now);
  }

  // «Чутьё легенды» compass: arrows at the screen edge to the rarest orbs (and, at level 3, to event targets).
  // Client-side only: every position it uses is already public (orb list, minimap, event broadcast).
  const COMPASS_COLORS = { l: '#ffcc33', m: '#ff3d6e', e: '#ff9a2e', event: '#7dffb0' };
  function drawCompass(t, now) {
    if (!profile || !profile.upgrades.sense) return;
    const evc = evState ? { zone: evState.zone, runner: runner ? { x: runnerX(now), y: runnerY(now) } : null } : null;
    const list = G.compassTargets(profile.upgrades.sense, Array.from(orbs.values()), dispMe, evc);
    for (const tg of list) drawArrow(tg, t);
  }
  function drawArrow(tg, t) {
    const sx = tg.x - cam.x, sy = tg.y - cam.y;
    if (sx > 30 && sx < W - 30 && sy > 30 && sy < H - 30) return; // already on screen
    const color = COMPASS_COLORS[tg.kind] || '#ffcc33';
    const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy, a = Math.atan2(dy, dx);
    const m = 46, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-6), (H / 2 - m) / Math.abs(dy || 1e-6));
    const ax = cx + dx * k, ay = cy + dy * k, pulse = 1 + 0.12 * Math.sin(t * 5), big = tg.kind === 'l' || tg.kind === 'm' || tg.kind === 'event';
    ctx.save(); ctx.translate(ax, ay);
    ctx.save(); ctx.rotate(a); ctx.scale(pulse * (big ? 1 : 0.8), pulse * (big ? 1 : 0.8));
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -11); ctx.lineTo(-3, 0); ctx.lineTo(-8, 11); ctx.closePath(); ctx.fill();
    ctx.restore();
    if (tg.dist != null) {
      const label = (tg.kind === 'event' ? '★ ' : '') + Math.round(tg.dist / 10) + ' м';
      ctx.font = '700 12px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; const tx = -Math.cos(a) * 28, ty = -Math.sin(a) * 22;
      ctx.strokeText(label, tx, ty); ctx.fillStyle = color; ctx.fillText(label, tx, ty);
    }
    ctx.restore();
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
  const idleOrbs = Array.from({ length: 60 }, (_, i) => ({ x: Math.random(), y: Math.random(), t: i % 29 === 0 ? 'm' : i % 25 === 0 ? 'l' : i % 13 === 0 ? 'e' : i % 6 === 0 ? 'r' : i % 4 === 0 ? 'u' : 'c', v: 0.2 + Math.random() * 0.6, id: i }));
  function drawIdleBackground(t) {
    cam.x = t * 25; cam.y = t * 12;
    drawBackground(t);
    for (const o of idleOrbs) {
      const x = ((o.x * W + t * 20 * o.v) % (W + 40)) - 20, y = ((o.y * H + Math.sin(t * o.v + o.id) * 20) + H) % H;
      drawOrb(ctx, x, y, o.t, t, o.id);
    }
  }

  // «Радар»: sonar minimap around the player. A pulse every RADAR.periodMs expands outwards; each blip lights up when
  // the wave reaches it and fades until the next pulse. Only common/uncommon (+ faint rare) orbs and players — see G.radarBlips.
  const mm = $('minimap'), mctx = mm.getContext('2d'), radarBox = $('radar'), radarBtn = $('radarToggle');
  let radarSnap = { at: -1e9, me: null, blips: [], pls: [] };
  const setRadarCollapsed = c => { radarBox.classList.toggle('collapsed', c); radarBtn.textContent = c ? '📡' : '–'; try { localStorage.setItem('ocs_radar', c ? '0' : '1'); } catch (e) {} };
  setRadarCollapsed((() => { try { return localStorage.getItem('ocs_radar') === '0'; } catch (e) { return false; } })());
  radarBtn.addEventListener('click', () => setRadarCollapsed(!radarBox.classList.contains('collapsed')));
  window.OCSRadar = () => ({ tiers: radarSnap.blips.map(b => b.t), players: radarSnap.pls.length, collapsed: radarBox.classList.contains('collapsed') });
  function drawMinimap(now) {
    if (radarBox.classList.contains('collapsed') || !dispMe) return;
    const R = G.RADAR, S = mm.width, c = S / 2, k = (c - 4) / R.range;
    if (now - radarSnap.at >= R.periodMs) { // new pulse: snapshot what the wave will reveal
      radarSnap = { at: now, me: { x: dispMe.x, y: dispMe.y }, blips: G.radarBlips(orbs.values(), dispMe),
        pls: Array.from(players.values()).filter(p => p.pos && p.id !== myId && Math.hypot(p.pos.x - dispMe.x, p.pos.y - dispMe.y) <= R.range).map(p => ({ x: p.pos.x, y: p.pos.y, d: Math.hypot(p.pos.x - dispMe.x, p.pos.y - dispMe.y), col: colorOf(p.eq, 0) })) };
    }
    const age = now - radarSnap.at, wave = age / R.sweepMs; // wave: 0 → 1 while it crosses the radar
    mctx.clearRect(0, 0, S, S);
    mctx.save(); mctx.beginPath(); mctx.arc(c, c, c - 1, 0, Math.PI * 2); mctx.clip();
    mctx.strokeStyle = 'rgba(90,255,170,0.14)'; mctx.lineWidth = 1;
    for (const f of [1 / 3, 2 / 3]) { mctx.beginPath(); mctx.arc(c, c, (c - 4) * f, 0, Math.PI * 2); mctx.stroke(); }
    mctx.beginPath(); mctx.moveTo(c, 0); mctx.lineTo(c, S); mctx.moveTo(0, c); mctx.lineTo(S, c); mctx.stroke();
    const px = (x, y) => [c + (x - dispMe.x) * k, c + (y - dispMe.y) * k];
    // world edge
    const [ex0, ey0] = px(0, 0), [ex1, ey1] = px(G.WORLD.w, G.WORLD.h);
    mctx.strokeStyle = 'rgba(255,120,120,0.35)'; mctx.strokeRect(ex0, ey0, ex1 - ex0, ey1 - ey0);
    if (evState && evState.zone) { // «Царь горы» zone is public and may be shown
      const z = evState.zone, [zx, zy] = px(z.x, z.y);
      mctx.fillStyle = evState.phase === 'active' ? 'rgba(255,204,51,0.25)' : 'rgba(255,204,51,0.1)'; mctx.strokeStyle = 'rgba(255,204,51,0.8)';
      mctx.beginPath(); mctx.arc(zx, zy, Math.max(4, z.r * k), 0, Math.PI * 2); mctx.fill(); mctx.stroke();
    }
    const blip = (b, r, col) => {
      const lit = (b.d / R.range) * R.sweepMs; if (age < lit) return; // the wave hasn't reached it yet
      const a = Math.max(0, 1 - (age - lit) / (R.periodMs - lit)) * (b.a || 1); if (a <= 0.02) return;
      const [x, y] = px(b.x, b.y); mctx.globalAlpha = a; mctx.fillStyle = col;
      mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
    };
    const sc = S / 150;
    for (const b of radarSnap.blips) blip(b, (b.t === 'c' ? 1.4 : 1.8) * sc, b.t === 'r' ? '#b46bff' : '#7dffb8');
    for (const p of radarSnap.pls) blip(p, 3 * sc, p.col);
    mctx.globalAlpha = 1;
    if (wave < 1) { // the pulse wave
      mctx.strokeStyle = `rgba(110,255,180,${0.85 * (1 - wave)})`; mctx.lineWidth = 2 * sc;
      mctx.beginPath(); mctx.arc(c, c, wave * (c - 4), 0, Math.PI * 2); mctx.stroke();
    }
    mctx.restore();
    mctx.fillStyle = '#ffffff'; mctx.beginPath(); mctx.arc(c, c, 3 * sc, 0, Math.PI * 2); mctx.fill(); // you
    if (S >= 120) { mctx.fillStyle = 'rgba(141,255,196,0.75)'; mctx.font = '700 10px Segoe UI, sans-serif'; mctx.textAlign = 'center'; mctx.fillText('РАДАР', c, S - 10); }
  }

  // ------------------------------------------------------------ timed arena events (server-run; the client only shows them)
  let evState = null, kothInfo = null, runner = null, evResultTimer = null;
  const EV_UNITS = { rain: 'сфер', koth: 'очк.', treasure: 'сокр.', runner: '' };
  function setEvent(d) {
    if (!d) { evState = null; kothInfo = null; updateEventUi(); return; }
    const now = performance.now();
    evState = { kind: d.kind, phase: d.phase, startAt: now + (d.in || 0), endAt: now + (d.left || 0), dur: d.dur, zone: d.zone || null, remaining: d.remaining, total: d.total, annTotal: Math.max(1000, d.in || 0) };
    if (d.runner && !runner) runner = { x: d.runner.x, y: d.runner.y, px: d.runner.x, py: d.runner.y, at: now };
    if (d.phase === 'announce') kothInfo = null;
    updateEventUi();
  }
  const runnerK = now => (runner ? Math.min(1, (now - runner.at) / G.TICK_MS) : 1);
  const runnerX = now => (runner ? runner.px + (runner.x - runner.px) * runnerK(now) : 0);
  const runnerY = now => (runner ? runner.py + (runner.y - runner.py) * runnerK(now) : 0);
  function rewardText(r) {
    if (!r) return '';
    const parts = []; if (r.orbs) parts.push(`+${fmt(r.orbs)} ◉`); if (r.shards) parts.push(`+${r.shards} 💎`);
    return parts.join(' ');
  }
  function updateEventUi() {
    const ban = $('evBanner'), hud = $('evHud');
    const now = performance.now(), e = evState, def = e && G.EVENTS[e.kind];
    document.body.classList.toggle('ev-on', !!e);
    if (e && mobileUI()) { const b = Math.max($('hud').querySelector('.stats').getBoundingClientRect().bottom, $('hud').querySelector('.top').getBoundingClientRect().bottom); $('hud').style.setProperty('--ev-top', Math.round(b + 8) + 'px'); }
    if (!e || !def) { ban.classList.add('hidden'); hud.classList.add('hidden'); return; }
    if (e.phase === 'announce') {
      hud.classList.add('hidden'); ban.classList.remove('hidden'); ban.dataset.kind = e.kind;
      $('evBIcon').textContent = def.icon; $('evBName').textContent = `Событие «${def.name}»`;
      const sec = Math.max(0, Math.ceil((e.startAt - now) / 1000));
      $('evBCount').textContent = sec > 0 ? `через ${sec} с` : 'начинается!';
      $('evBDesc').textContent = def.desc + (e.kind === 'koth' ? ' Зона отмечена на карте.' : '');
      $('evBBar').style.width = Math.max(0, Math.min(100, (e.startAt - now) / e.annTotal * 100)) + '%';
      return;
    }
    ban.classList.add('hidden'); hud.classList.remove('hidden'); hud.dataset.kind = e.kind;
    const left = Math.max(0, e.endAt - now);
    $('evHIcon').textContent = def.icon; $('evHName').textContent = def.name;
    const sec = Math.ceil(left / 1000);
    $('evHTime').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    $('evHBar').style.width = Math.max(0, Math.min(100, left / Math.max(1, e.dur) * 100)) + '%';
    let info = '';
    if (e.kind === 'rain') info = 'Дополнительные сферы падают по всей арене — эпические и редкие намного чаще!';
    else if (e.kind === 'koth') {
      const k = kothInfo;
      info = (k && k.inside ? '✅ Вы в зоне' : '⚠️ Вы вне зоны — идите к золотому кругу') + ` · ваши очки: ${k ? k.you : 0}`;
      if (k && k.top && k.top.length) info += ' · лидер: ' + k.top[0][0] + ' (' + k.top[0][1] + ')';
    } else if (e.kind === 'treasure') info = `Осталось сокровищ: ${e.remaining != null ? e.remaining : '?'} из ${e.total != null ? e.total : '?'} — ищите световые столбы и золотые точки на карте`;
    else if (e.kind === 'runner') info = runner ? `Догоните сферу-беглеца! До неё ${Math.round(Math.hypot(runnerX(now) - dispMe.x, runnerY(now) - dispMe.y) / 10)} м` : 'Сфера-беглец где-то на арене…';
    $('evHInfo').textContent = info;
  }
  setInterval(() => { if (joined && evState) updateEventUi(); }, 200);
  function evResultHide() { $('evResult').classList.add('hidden'); clearTimeout(evResultTimer); }
  function showEventResult(d) {
    const def = G.EVENTS[d.kind]; if (!def) return;
    const box = $('evResult'); box.textContent = ''; box.dataset.kind = d.kind;
    const head = document.createElement('div'); head.className = 'evr-head';
    const h = document.createElement('b'); h.textContent = `${def.icon} «${def.name}» — итоги`;
    const x = document.createElement('button'); x.type = 'button'; x.className = 'close'; x.setAttribute('aria-label', 'Закрыть'); x.textContent = '✕'; x.onclick = evResultHide;
    head.append(h, x); box.appendChild(head);
    const you = document.createElement('div'); you.className = 'evr-you';
    let sub = '';
    if (d.kind === 'runner') sub = d.outcome === 'caught' ? `Сферу поймал(а) ${d.results[0] ? d.results[0].name : 'кто-то'}!` : 'Сфера-беглец ускользнула…';
    if (d.kind === 'treasure') sub = `Найдено сокровищ: ${(d.total || 0) - (d.remaining || 0)} из ${d.total || 0}`;
    if (d.you) {
      const unit = EV_UNITS[d.kind];
      you.textContent = `Вы: ${d.you.place}-е место${unit ? ` · ${fmt(d.you.score)} ${unit}` : ''}` + (d.you.reward ? ` · награда ${rewardText(d.you.reward)}` : d.kind === 'koth' ? ` · для награды нужно ≥ ${def.minScore} очков` : '');
      you.classList.add('ok');
    } else you.textContent = 'Вы не участвовали — в следующий раз!';
    if (sub) { const s2 = document.createElement('div'); s2.className = 'evr-sub'; s2.textContent = sub; box.appendChild(s2); }
    box.appendChild(you);
    if (d.results && d.results.length) {
      const ol = document.createElement('ol'); ol.className = 'evr-list';
      for (const r of d.results) {
        const li = document.createElement('li'); const n = document.createElement('span'); n.textContent = r.name;
        const v = document.createElement('b'); v.textContent = (EV_UNITS[d.kind] ? fmt(r.score) + ' ' + EV_UNITS[d.kind] : '') + (r.reward ? '  ' + rewardText(r.reward) : '');
        li.append(n, v); if (r.name === myName) li.className = 'me'; ol.appendChild(li);
      }
      box.appendChild(ol);
    }
    if (d.kind === 'rain' && d.you) { const s3 = document.createElement('div'); s3.className = 'evr-sub'; s3.textContent = 'Все сферы дождя уже зачислены на баланс.'; box.appendChild(s3); }
    box.classList.remove('hidden');
    clearTimeout(evResultTimer); evResultTimer = setTimeout(evResultHide, 12000);
  }
  socket.on('ev:announce', d => { if (!joined || !d) return; evResultHide(); setEvent(d); });
  socket.on('ev:start', d => { if (!joined || !d) return; setEvent(d); const def = G.EVENTS[d.kind]; if (def) toast(`${def.icon} Событие «${def.name}» началось!`, 'ok'); });
  socket.on('ev:koth', d => { kothInfo = d; });
  socket.on('ev:treasure', d => {
    if (!evState || !d) return;
    evState.remaining = d.left;
    toast(`💰 ${d.name} нашёл(ла) сокровище!${d.left ? ' Осталось: ' + d.left : ''}`);
    updateEventUi();
  });
  socket.on('ev:end', d => {
    if (!d) return;
    evState = null; kothInfo = null; runner = null; updateEventUi();
    if (!joined) return;
    if (d.cancelled) { toast('Событие отменено'); return; }
    showEventResult(d);
    if (mobileUI()) { const b = Math.max($('hud').querySelector('.stats').getBoundingClientRect().bottom, $('hud').querySelector('.top').getBoundingClientRect().bottom); $('hud').style.setProperty('--ev-top', Math.round(b + 8) + 'px'); }
  });
  // world layer: king-of-the-hill zone (dim + dashed while announced)
  function drawEventZone(t) {
    if (!evState || !evState.zone) return;
    const z = evState.zone, active = evState.phase === 'active', inside = Math.hypot(dispMe.x - z.x, dispMe.y - z.y) <= z.r;
    if (z.x + z.r < cam.x || z.x - z.r > cam.x + W || z.y + z.r < cam.y || z.y - z.r > cam.y + H) return;
    ctx.save();
    const gr = ctx.createRadialGradient(z.x, z.y, z.r * 0.2, z.x, z.y, z.r);
    const a = active ? 0.16 + 0.06 * Math.sin(t * 3) : 0.06;
    gr.addColorStop(0, `rgba(255,214,90,${a * 0.4})`); gr.addColorStop(1, `rgba(255,204,51,${a + (inside && active ? 0.08 : 0)})`);
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = active ? 4 : 2.5; ctx.strokeStyle = active ? '#ffcc33' : 'rgba(255,204,51,0.6)';
    if (active) { ctx.shadowColor = '#ffcc33'; ctx.shadowBlur = 18; } else { ctx.setLineDash([12, 10]); ctx.lineDashOffset = -t * 30; }
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0; ctx.setLineDash([]);
    if (active) { // rotating ticks around the rim
      ctx.strokeStyle = 'rgba(255,240,180,0.7)'; ctx.lineWidth = 3; ctx.beginPath();
      for (let i = 0; i < 24; i++) { const an = t * 0.4 + i * Math.PI / 12; ctx.moveTo(z.x + Math.cos(an) * (z.r - 10), z.y + Math.sin(an) * (z.r - 10)); ctx.lineTo(z.x + Math.cos(an) * (z.r - 2), z.y + Math.sin(an) * (z.r - 2)); }
      ctx.stroke();
    }
    ctx.font = '800 40px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.globalAlpha = active ? 0.85 : 0.5;
    ctx.fillText('👑', z.x, z.y - 14);
    ctx.font = '800 16px Segoe UI, system-ui, sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.fillStyle = '#ffe08a';
    const label = active ? 'Царь горы' : 'Царь горы — скоро';
    ctx.strokeText(label, z.x, z.y + 22); ctx.fillText(label, z.x, z.y + 22);
    ctx.restore();
  }
  function drawRunner(t, now) {
    if (!runner) return;
    const x = runnerX(now), y = runnerY(now);
    if (x < cam.x - 80 || x > cam.x + W + 80 || y < cam.y - 80 || y > cam.y + H + 80) return;
    const dx = runner.x - runner.px, dy = runner.y - runner.py, l = Math.hypot(dx, dy);
    if (l > 0.5) { // speed lines
      ctx.save(); ctx.strokeStyle = 'rgba(198,253,255,0.5)'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath();
      for (const o of [-8, 0, 8]) { const nx = -dy / l * o, ny = dx / l * o; ctx.moveTo(x - dx / l * 18 + nx, y - dy / l * 18 + ny); ctx.lineTo(x - dx / l * (38 + Math.abs(o) * 1.5) + nx, y - dy / l * (38 + Math.abs(o) * 1.5) + ny); }
      ctx.stroke(); ctx.restore();
    }
    drawOrb(ctx, x, y, 'runner', t * 2, 0, 1.1);
    const d = l > 0.5 ? { x: dx / l, y: dy / l } : { x: 1, y: 0 }; // tiny eyes looking where it runs
    for (const sgn of [-1, 1]) { const ex = x + d.x * 5 - d.y * sgn * 5, ey = y + d.y * 5 + d.x * sgn * 5; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#10142a'; ctx.beginPath(); ctx.arc(ex + d.x * 1.4, ey + d.y * 1.4, 1.7, 0, Math.PI * 2); ctx.fill(); }
  }

  // ------------------------------------------------------------ orb legend (help «?» popover)
  function renderOrbHelp() {
    const box = $('orbHelpList'); if (box.childElementCount) return;
    for (const k of G.ORB_LEGEND) {
      const ot = G.ORB_TYPES[k]; if (!ot) continue;
      const row = document.createElement('div'); row.className = 'oh-row'; row.dataset.orb = k;
      const cv = document.createElement('canvas'); cv.width = cv.height = 56; cv.className = 'oh-orb';
      drawOrb(cv.getContext('2d'), 28, 28, k, 0.4, 0, 0.62);
      const nm = document.createElement('span'); nm.className = 'oh-name'; nm.style.color = ot.color; nm.textContent = ot.name;
      const v = document.createElement('b'); v.textContent = '+' + ot.value;
      const note = document.createElement('small');
      const share = ot.weight > 0 ? (ot.weight / Object.values(G.POOL_WEIGHTS).reduce((a, b) => a + b, 0) * 100) : 0;
      note.textContent = [share ? (share >= 1 ? Math.round(share) + '%' : share.toFixed(2).replace('.', ',') + '%') + ' сфер' : '', ot.note || '', ot.shards ? `+${ot.shards} 💎` : ''].filter(Boolean).join(' · ');
      row.append(cv, nm, v, note); box.appendChild(row);
    }
  }
  function toggleOrbHelp(force) {
    const el = $('orbHelp'), show = force != null ? force : el.classList.contains('hidden');
    if (show) renderOrbHelp();
    el.classList.toggle('hidden', !show);
  }
  $('helpBtn').addEventListener('click', () => toggleOrbHelp());
  $('orbHelpClose').addEventListener('click', () => toggleOrbHelp(false));
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
  const NEUTRAL_BODY = '#d4dcf7';
  const HAT_ICON_H = { wizard: 36 }; // hats taller than ~26 px need a smaller body in the icon                       // shapes in neutral silver so the outline is what you notice
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
      const k = Math.min(1.3, 64 / (G.PLAYER_R + (HAT_ICON_H[def.value] || 0))); // tall hats: shrink a little so they fit
      avatarAt(g, 48, 68, k, eqWith('hat', def.id)); // bigger body so the hat is the focus
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
  // ---- upgrade icons (ids 'u_<key>')
  const UPGRADE_ICON_DEFS = {};
  for (const k of G.UPGRADE_KEYS) UPGRADE_ICON_DEFS['u_' + k] = { id: 'u_' + k, type: 'upgrade', art: 'u_' + k, name: G.UPGRADES[k].name, rarity: ['mult', 'luck'].includes(k) ? 'epic' : 'rare' };
  Object.assign(ICON_ART, {
    u_magnet(g) {
      g.save(); g.lineCap = 'butt'; g.lineWidth = 14; g.lineJoin = 'round';
      g.strokeStyle = '#ff4d5e'; g.shadowColor = '#ff4d5e'; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(28, 66); g.lineTo(28, 46); g.arc(48, 46, 20, Math.PI, 0); g.lineTo(68, 66); g.stroke();
      g.shadowBlur = 0; g.strokeStyle = '#e6ecff';
      g.beginPath(); g.moveTo(28, 66); g.lineTo(28, 78); g.moveTo(68, 66); g.lineTo(68, 78); g.stroke();
      g.strokeStyle = 'rgba(62,224,255,0.65)'; g.lineWidth = 2; g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(14, 88); g.lineTo(22, 82); g.moveTo(84, 88); g.lineTo(75, 82); g.stroke();
      g.restore();
      drawOrb(g, 48, 72, 'c', ICON_T, 0, 1.0); drawOrb(g, 10, 90, 'c', ICON_T, 3, 0.7); drawOrb(g, 88, 90, 'r', ICON_T, 1, 0.6);
    },
    u_speed(g) {
      g.save(); g.lineCap = 'round'; g.strokeStyle = 'rgba(62,224,255,0.7)'; g.lineWidth = 4;
      [[10, 34, 34], [16, 50, 40], [10, 66, 32]].forEach(([x, y, l]) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y); g.stroke(); });
      g.fillStyle = '#3ee0ff'; g.shadowColor = '#3ee0ff'; g.shadowBlur = 12;
      for (const ox of [44, 62]) { g.beginPath(); g.moveTo(ox, 26); g.lineTo(ox + 22, 50); g.lineTo(ox, 74); g.lineTo(ox + 9, 50); g.closePath(); g.fill(); }
      g.restore();
    },
    u_mult(g) {
      drawOrb(g, 38, 44, 'c', ICON_T, 0, 1.7);
      drawOrb(g, 60, 30, 'r', ICON_T, 2, 0.9);
      g.save(); g.font = '900 30px Segoe UI, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeText('×%', 64, 72); g.fillStyle = '#ffcc33'; g.shadowColor = '#ffcc33'; g.shadowBlur = 10; g.fillText('×%', 64, 72);
      g.restore();
    },
    u_luck(g) {
      g.save(); g.translate(46, 46); g.fillStyle = '#4fd36b'; g.shadowColor = '#4fd36b'; g.shadowBlur = 10;
      for (let i = 0; i < 4; i++) { g.save(); g.rotate(i * Math.PI / 2 + Math.PI / 4); g.beginPath(); heartPath(g, 0, -15, 12); g.fill(); g.restore(); }
      g.shadowBlur = 0; g.strokeStyle = '#2f9a48'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(2, 4); g.quadraticCurveTo(10, 26, 24, 38); g.stroke();
      g.restore();
      sparkle(g, 78, 20, 7, '#fff3b0'); sparkle(g, 20, 78, 5, '#ffe27a');
    },
    u_sense(g) {
      g.save(); g.strokeStyle = 'rgba(255,204,51,0.85)'; g.lineWidth = 3; g.shadowColor = '#ffcc33'; g.shadowBlur = 8;
      g.beginPath(); g.arc(48, 50, 32, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,204,51,0.35)'; g.beginPath(); g.arc(48, 50, 20, 0, Math.PI * 2); g.stroke();
      g.shadowBlur = 0; g.translate(48, 50); g.rotate(-0.8);
      g.fillStyle = '#ffcc33'; g.beginPath(); g.moveTo(0, -27); g.lineTo(8, 0); g.lineTo(-8, 0); g.closePath(); g.fill();
      g.fillStyle = '#9aa3c7'; g.beginPath(); g.moveTo(0, 27); g.lineTo(8, 0); g.lineTo(-8, 0); g.closePath(); g.fill();
      g.restore();
      drawOrb(g, 82, 16, 'l', ICON_T, 0, 0.75);
    },
    u_skill(g) {
      g.save(); g.fillStyle = '#7a5cff'; g.shadowColor = '#b46bff'; g.shadowBlur = 12;
      g.beginPath(); g.roundRect(12, 32, 72, 38, 18); g.fill(); g.shadowBlur = 0;
      g.fillStyle = '#e8ecff'; g.fillRect(24, 47, 18, 6); g.fillRect(30, 41, 6, 18);
      [['#ff4d6d', 64, 44], ['#3ee0ff', 72, 52], ['#9dff4f', 56, 52], ['#ffd34d', 64, 60]].forEach(([c, x, y]) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); });
      g.restore();
      sparkle(g, 80, 20, 7, '#ffffff');
    },
  });
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
    const def = Object.prototype.hasOwnProperty.call(G.ITEM_BY_ID, key) ? G.ITEM_BY_ID[key]
      : Object.prototype.hasOwnProperty.call(UPGRADE_ICON_DEFS, key) ? UPGRADE_ICON_DEFS[key] : null;
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
    const def = G.ITEM_BY_ID[id] || UPGRADE_ICON_DEFS[id];
    const box = document.createElement('div');
    box.className = 'ico' + (cls ? ' ' + cls : '');
    box.style.setProperty('--rc', (G.RARITIES[def && def.rarity] || G.RARITIES.common).color);
    const img = document.createElement('img');
    img.src = iconUrl(id); img.alt = def ? def.name : 'Предмет'; img.draggable = false; img.dataset.icon = String(id);
    box.appendChild(img);
    if (def && def.exclusive && cls !== 'sm') { const b = document.createElement('span'); b.className = 'ex-badge'; b.textContent = 'Эксклюзив'; box.appendChild(b); }
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
  const SOURCE_NAMES = { shop: 'Магазин', minigame: 'Мини-игры', arena: 'Арена', event: 'Событие', admin: 'Подарок', legacy: 'Куплено раньше', shard_shop: 'Лавка осколков' };
  function rarityTag(def) { const r = rarityOf(def); const el = document.createElement('div'); el.className = 'rar'; el.style.color = r.color; el.textContent = r.name; return el; }

  // ------------------------------------------------------------ shop (only sells; purchases go to the inventory)
  let shopTab = 'color', shopRarity = 'all', shopSort = 'price-asc', shopHideOwned = false;
  const RAR_RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
  const SHOP_SORTS = {
    'price-asc': (a, b) => a.price - b.price || RAR_RANK[a.rarity] - RAR_RANK[b.rarity],
    'price-desc': (a, b) => b.price - a.price || RAR_RANK[b.rarity] - RAR_RANK[a.rarity],
    rarity: (a, b) => RAR_RANK[a.rarity] - RAR_RANK[b.rarity] || a.price - b.price,
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
  };
  $('shopSort').addEventListener('change', e => { if (SHOP_SORTS[e.target.value]) { shopSort = e.target.value; renderShop(); } });
  $('shopHideOwned').addEventListener('change', e => { shopHideOwned = e.target.checked; renderShop(); });
  function upgradeCard(up) {
    const lvl = G.upLevel(up.key, profile.upgrades[up.key]), price = up.prices[lvl], maxed = lvl >= up.max;
    const el = document.createElement('div'); el.className = 'item up-card'; el.dataset.up = up.key;
    el.appendChild(iconEl('u_' + up.key));
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = `${up.name} — ур. ${lvl}/${up.max}`;
    const pips = document.createElement('div'); pips.className = 'up-level';
    for (let i = 0; i < up.max; i++) { const p = document.createElement('i'); if (i < lvl) p.className = 'on'; pips.appendChild(p); }
    const desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = up.desc;
    const eff = document.createElement('div'); eff.className = 'up-eff';
    const now = document.createElement('div'); now.className = 'now'; now.textContent = 'Сейчас: ' + G.upgradeText(up.key, lvl);
    eff.appendChild(now);
    if (!maxed) { const nx = document.createElement('div'); nx.className = 'next'; nx.textContent = '→ ' + G.upgradeText(up.key, lvl + 1); eff.appendChild(nx); }
    const btn = document.createElement('button'); btn.className = 'btn' + (maxed ? '' : ' primary');
    if (maxed) { btn.textContent = 'Максимум'; btn.disabled = true; }
    else { btn.textContent = `Улучшить · ${fmt(price)} ◉`; btn.disabled = profile.balance < price; btn.onclick = () => socket.emit('upgrade', up.key, res => afterAction(res, `${up.name}: уровень ${lvl + 1}!`)); }
    el.append(nm, pips, desc, eff, btn);
    return el;
  }
  function renderShop() {
    if (!profile) return;
    pruneHidden('shop');
    const tabs = G.CATEGORIES.concat([{ key: 'upgrades', name: '⚡ Улучшения' }, { key: 'shards', name: '💎 Лавка осколков' }]);
    $('shopTabs').innerHTML = tabs.map(c => `<button class="tab ${c.key === shopTab ? 'active' : ''}" data-tab="${c.key}">${c.name}</button>`).join('');
    $('shopTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { shopTab = b.dataset.tab; renderShop(); });
    const grid = $('shopGrid');
    grid.innerHTML = '';
    $('shopTools').classList.toggle('hidden', shopTab === 'upgrades' || shopTab === 'shards');
    $('shopEmpty').classList.add('hidden');
    if (shopTab === 'shards') { renderShardShop(grid); return; }
    if (shopTab === 'upgrades') {
      for (const up of Object.values(G.UPGRADES)) grid.appendChild(upgradeCard(up));
      return;
    }
    const inCat = G.ITEMS.filter(i => i.cat === shopTab && i.price > 0 && i.sources.includes('shop'));
    if (shopRarity !== 'all' && !inCat.some(i => i.rarity === shopRarity)) shopRarity = 'all';
    const chips = [{ key: 'all', name: 'Все', color: '#aab3d9' }].concat(Object.entries(G.RARITIES).map(([k, r]) => ({ key: k, name: r.name, color: r.color })));
    const rc = $('shopRarity'); rc.innerHTML = '';
    for (const c of chips) {
      const n = c.key === 'all' ? inCat.length : inCat.filter(i => i.rarity === c.key).length;
      if (c.key !== 'all' && !n) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rar-chip' + (c.key === shopRarity ? ' active' : ''); b.dataset.rarity = c.key;
      b.style.setProperty('--rc', c.color); b.textContent = `${c.name} ${n}`;
      b.onclick = () => { shopRarity = c.key; renderShop(); };
      rc.appendChild(b);
    }
    $('shopSort').value = shopSort; $('shopHideOwned').checked = shopHideOwned;
    const full = profile.inventory.length >= profile.slots;
    const list = inCat.filter(i => (shopRarity === 'all' || i.rarity === shopRarity) && !(shopHideOwned && owns(i.id))).sort(SHOP_SORTS[shopSort]);
    $('shopEmpty').classList.toggle('hidden', list.length > 0);
    for (const it of list) {
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
  // «Лавка осколков»: exclusives for legendary shards only (+ optional shard → orb exchange)
  const shardCount = () => (profile ? profile.inventory.reduce((n, s) => n + (s.id === G.SHARD_ID ? s.q : 0), 0) : 0);
  function renderShardShop(grid) {
    const have = shardCount(), X = G.SHARD_EXCHANGE;
    const head = document.createElement('div'); head.className = 'shard-head'; head.id = 'shardHead';
    const ico = iconEl(G.SHARD_ID, 'sm');
    const txt = document.createElement('div'); txt.className = 'shard-txt';
    const b = document.createElement('div'); b.className = 'shard-have'; b.innerHTML = 'У вас осколков: <b id="shardCount"></b>'; b.querySelector('b').textContent = fmt(have) + ' 💎';
    const how = document.createElement('div'); how.className = 'muted'; how.textContent = 'Осколки дают легендарные (+1) и мифические (+3) сферы и награды арена-событий. Эксклюзивы нельзя купить за сферы.';
    txt.append(b, how);
    const ex = document.createElement('div'); ex.className = 'shard-ex';
    const lab = document.createElement('label'); lab.htmlFor = 'shardExQty'; lab.textContent = `Обмен: 1 💎 = ${X.orbs} ◉`;
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = 'shardExQty'; inp.min = 1; inp.max = Math.max(1, Math.min(X.maxPerTrade, have)); inp.value = 1; inp.inputMode = 'numeric';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.id = 'shardExBtn';
    const qty = () => Math.max(1, Math.min(X.maxPerTrade, parseInt(inp.value, 10) || 1));
    const upd = () => { btn.textContent = `Обменять → ${fmt(qty() * X.orbs)} ◉`; btn.disabled = have < qty(); };
    inp.oninput = upd; upd();
    btn.onclick = () => { const q = qty(); btn.disabled = true; socket.emit('shard:exchange', q, res => afterAction(res, `Обмен: −${q} 💎, +${fmt(q * X.orbs)} ◉`)); };
    inp.addEventListener('keydown', e => e.stopPropagation());
    ex.append(lab, inp, btn);
    head.append(ico, txt, ex); grid.appendChild(head);
    const list = G.ITEMS.filter(i => i.exclusive).sort((a, b2) => a.shardPrice - b2.shardPrice);
    for (const it of list) {
      const owned = owns(it.id);
      const el = document.createElement('div'); el.className = 'item ex-item rar-' + it.rarity; el.dataset.item = it.id;
      el.appendChild(iconEl(it.id));
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name;
      const cat = document.createElement('div'); cat.className = 'desc'; cat.textContent = (G.CATEGORIES.find(c => c.key === it.cat) || {}).name || '';
      el.append(nm, rarityTag(it), cat);
      const bt = document.createElement('button');
      if (owned) { bt.className = 'btn equipped'; bt.textContent = '✓ В инвентаре'; bt.disabled = true; }
      else {
        bt.className = 'btn primary shard-buy'; bt.textContent = `Купить · ${fmt(it.shardPrice)} 💎`;
        bt.disabled = have < it.shardPrice;
        if (have < it.shardPrice) bt.title = `Не хватает ${it.shardPrice - have} 💎`;
        bt.onclick = () => { bt.disabled = true; socket.emit('shard:buy', it.id, res => afterAction(res, `Куплено: ${it.name} — эксклюзив в инвентаре (I)`)); };
      }
      el.appendChild(bt); grid.appendChild(el);
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
    $('pfUpgrades').textContent = 'Улучшения: ' + G.UPGRADE_KEYS.map(k => `${G.UPGRADES[k].name.toLowerCase()} ${G.upLevel(k, p.upgrades[k])}/${G.UPGRADES[k].max}`).join(' · ');
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
  const safeColor = c => (c === 'rainbow' || paintOf(c) || /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#3ee0ff');
  function lbRow(p) {
    const tr = document.createElement('tr'); if (p.name === myName) tr.className = 'me';
    const td1 = document.createElement('td'); td1.textContent = p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank;
    const td2 = document.createElement('td');
    const dot = document.createElement('i'); dot.className = 'dot';
    const c = safeColor(p.color);
    const pc = paintOf(c);
    dot.style.background = c === 'rainbow' ? 'linear-gradient(90deg,#f55,#ff5,#5f5,#5ff,#a5f)' : pc ? `linear-gradient(90deg, ${pc.stops.join(', ')})` : c;
    dot.style.boxShadow = '0 0 8px ' + (c === 'rainbow' ? '#fff' : pc ? pc.base : c);
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
      <div class="muted">Взнос ${r.fee} · итог ${net >= 0 ? '+' : ''}${net}${r.bonus > 0 ? ` · «Мастер мини-игр» +${Number(r.bonus) | 0}` : ''}</div>
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
    const p = paintOf(c);
    if (c === 'rainbow') el.classList.add('rainbow-text');
    else if (p && p.fx === 'pulse') { el.style.color = p.base; el.style.textShadow = `0 0 6px ${p.base}`; }
    else if (p && p.fx === 'glitch') { el.style.color = '#fff'; el.style.textShadow = '-1px 0 #ff2fd6, 1px 0 #2ff3ff'; }
    else if (p) { el.classList.add('paint-text'); el.style.backgroundImage = `linear-gradient(90deg, ${p.stops.join(', ')})`; }
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
