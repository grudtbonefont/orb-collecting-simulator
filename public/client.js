/* Orb Collecting Simulator — browser client (vanilla JS, no build step) */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1, VW = 0, VH = 0, zoom = 1; // VW/VH: visible world size (screen / zoom)
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
  const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true }); // falls back to HTTP long-polling where WebSockets are blocked (school / office / some mobile networks)
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
  let selfFx = { spd: 1, frozen: false, god: false, invis: false }, cevSpd = 1, lastSnapIds = null; // admin effects on this player (server-authoritative; mirrored for prediction)
  const mySpeed = () => G.speedFor(profile ? profile.upgrades.speed : 0) * C.boostMult(profile && profile.stats, 'speed', Date.now() + srvSkew) * (selfFx.frozen ? 0 : selfFx.spd || 1) * (cevSpd || 1) * funSpeedMult() * G.potionMult(profile && profile.stats, 'speed', Date.now() + srvSkew); // quest boost «Скорость +10 %»
  let srvSkew = 0;
  const myPickup = () => G.pickupFor(profile ? profile.upgrades.magnet : 0);
  const fmt = n => Number(n).toLocaleString('ru-RU');
  // currency icons (CSS-drawn, see .cur-orb / .cur-shard): use with innerHTML; amounts go through fmt (numbers only)
  const ORB_I = '<i class="cur-orb" aria-hidden="true"></i>', SHARD_I = '<i class="cur-shard" aria-hidden="true"></i>';
  const orbsH = n => `${fmt(n)}&nbsp;${ORB_I}`, shardsH = n => `${fmt(n)}&nbsp;${SHARD_I}`;
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

  // top notifications by category; each can be switched off in ⚙️ (localStorage ocs_toast_<cat> = '0'). Untagged errors always show.
  const TOAST_CATS = [
    { key: 'events', name: 'Эвенты', ex: '«Событие «Раннеры» началось!», «… нашёл(ла) сокровище!»' },
    { key: 'mini', name: 'Мини-события', ex: '«Мини-событие «Золотой дождь»!», «Сундук открыт», бонусная комната' },
    { key: 'boss', name: 'Босс', ex: '«Через 25 с появится босс», «Босс на арене!»' },
    { key: 'ach', name: 'Достижения', ex: '«🏆 Достижение «Собиратель I»! +30 сфер, +1 оск.»' },
    { key: 'quests', name: 'Задания', ex: '«📜 Задание выполнено: …», бонус за все задания' },
    { key: 'rewards', name: 'Награды и покупки', ex: 'полученные предметы и осколки, промокоды, покупки, призы мини-игр' },
    { key: 'rare', name: 'Легендарные и мифические сферы', ex: '«✨ Появилась легендарная сфера (+25)!»' },
    { key: 'hits', name: 'Лазеры и урон', ex: '«⚡ Лазер! Потеряно 9 сфер…», удары робота и босса' },
    { key: 'disco', name: 'Диско-ивент', ex: '«🪩 Диско-ивент! Сферы ×1,5…», конец диско, бонус ×2 от администратора' },
    { key: 'other', name: 'Прочее', ex: 'приветствие, выход из аккаунта, удаление предметов, подсказки' },
  ];
  const toastOn = cat => { try { return localStorage.getItem('ocs_toast_' + cat) !== '0'; } catch (_) { return true; } };
  function toastC(cat, text, kind, html) { if (toastOn(cat)) toast(text, kind, html); }
  function toast(text, kind, html) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    if (html) el.innerHTML = html; else el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  // ------------------------------------------------------------ auth / connection
  // stage: 'auth' (login form) → 'lobby' (profile screen) → 'game' (arena)
  let stage = 'auth', authMode = 'login', authPending = false, playPending = false, paused = false;
  let summary = null; // last profile summary (rank, play time…) from the server
  const setErr = msg => { $('joinError').textContent = msg || ''; if (msg && $('joinError').scrollIntoView) $('joinError').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
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
  $('showPw').addEventListener('change', () => { const t = $('showPw').checked ? 'text' : 'password'; $('pass').type = t; $('pass2').type = t; });
  $('nick').addEventListener('input', () => {
    if (authMode !== 'register') return;
    const v = $('nick').value.trim();
    setErr(v.length >= 3 ? (RULES.nicknameError(v) || '') : '');
  });
  $('authForm').addEventListener('submit', e => {
    e.preventDefault();
    if (authPending) return;
    const name = $('nick').value.trim();
    // phone keyboards / autofill add stray spaces: registration stores the trimmed password (login also accepts it trimmed)
    const password = authMode === 'register' ? $('pass').value.trim() : $('pass').value, confirm = $('pass2').value.trim();
    if (!name) { setErr('Введите ник'); $('nick').focus(); return; }
    if (authMode === 'register') {
      const ne = RULES.nicknameError(name); if (ne) { setErr(ne); $('nick').focus(); return; }
      const pe = RULES.passwordError(password); if (pe) { setErr(pe); $('pass').focus(); return; }
      if (password !== confirm) { setErr(confirm ? 'Пароли не совпадают — введите пароль ещё раз во втором поле (можно включить «Показать пароль»)' : 'Повторите пароль во втором поле'); $('pass2').value = ''; $('pass2').focus(); return; }
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
  // ------------------------------------------------------------ menu music: loops on start / login / lobby screens, fades out in the arena
  const music = (() => {
    // single audio element: in-game background playlist only (no menu music)
    const btn = $('musicBtn'), KEY = 'ocs_music', TR = ['/audio/bg1.m4a', '/audio/bg2.m4a', '/audio/bg3.m4a'], VOL = 0.3;
    const a = new Audio(); a.preload = 'none'; a.setAttribute('playsinline', ''); a.volume = VOL;
    let muted = store.get(KEY) === '0', on = false, loaded = false, pending = false, disco = false, idx = Math.floor(Math.random() * TR.length);
    const DISCO_SRC = '/audio/disco.m4a';
    const load = i => { idx = (i + TR.length) % TR.length; a.src = TR[idx]; a.loop = false; loaded = true; };
    const loadDisco = () => { a.src = DISCO_SRC; a.loop = true; loaded = true; };
    const play = () => {
      if (muted || !on || pending || !a.paused) return; // guard: never start twice
      if (!loaded) { if (disco) loadDisco(); else load(idx); }
      for (const x of document.querySelectorAll('audio')) if (x !== a) x.pause();
      a.volume = VOL; pending = true;
      const p = a.play(); const done = () => { pending = false; if (muted || !on) a.pause(); };
      if (p && p.then) p.then(done, done); else done();
    };
    a.addEventListener('ended', () => { if (disco) return; load(idx + 1); play(); });
    a.addEventListener('error', () => { if (on && loaded && !disco) { load(idx + 1); setTimeout(play, 500); } });
    const kick = () => play();
    for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(ev, kick, { capture: true, passive: true }); // autoplay blocked → first interaction
    const paint = () => { btn.textContent = muted ? '🔇' : '🔊'; btn.setAttribute('aria-pressed', muted ? 'true' : 'false'); };
    const setMuted = m => { muted = !!m; store.set(KEY, muted ? '0' : '1'); paint(); if (muted) a.pause(); else play(); document.dispatchEvent(new Event('ocs-music')); };
    btn.addEventListener('click', e => { e.stopPropagation(); setMuted(!muted); });
    paint();
    const setDisco = v => { v = !!v; if (v === disco) return; disco = v; a.pause(); pending = false; if (disco) loadDisco(); else load(idx); play(); }; // one element: disco track replaces the playlist, the playlist resumes after
    const bg = { el: a, get idx() { return idx; }, get disco() { return disco; }, next() { if (disco) return; a.pause(); load(idx + 1); play(); } };
    return { menu() { on = false; document.body.classList.remove('in-game'); a.pause(); }, game() { on = true; document.body.classList.add('in-game'); play(); }, el: a, bg, setMuted, setDisco, get muted() { return muted; } };
  })();
  // ------------------------------------------------------------ ⚙️ settings (localStorage): top notifications, music (same switch as 🔊/🔇)
  function buildSettings() {
    const box = $('setCats'); box.textContent = '';
    for (const c of TOAST_CATS) {
      const row = document.createElement('label'); row.className = 'set-row';
      const t = document.createElement('span'); t.textContent = c.name; const sm = document.createElement('small'); sm.textContent = c.ex; t.appendChild(sm);
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.className = 'switch'; inp.dataset.cat = c.key; inp.checked = toastOn(c.key);
      inp.addEventListener('change', () => store.set('ocs_toast_' + c.key, inp.checked ? '1' : '0'));
      row.append(t, inp); box.appendChild(row);
    }
    $('setMusic').checked = !music.muted;
  }
  $('setMusic').addEventListener('change', () => music.setMuted(!$('setMusic').checked));
  document.addEventListener('ocs-music', () => { $('setMusic').checked = !music.muted; });
  $('setBtn').addEventListener('click', e => { e.stopPropagation(); buildSettings(); toggleModal('settings'); });
  window.OCSMusic = () => ({ bgPaused: music.el.paused, bgSrc: music.el.currentSrc || music.el.src, bgIdx: music.bg.idx, bgPreload: music.el.preload, bgNext: () => music.bg.next(), disco: music.bg.disco, muted: music.muted, playing: [...document.querySelectorAll("audio")].concat([music.el]).filter((x, i, s) => s.indexOf(x) === i && !x.paused).length });
  window.OCSMusicCtl = { menu: () => music.menu(), game: () => music.game() };
  music.menu(); // try autoplay on load
  function enterGame(res, reconnect) {
    music.game();
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
    runners.clear(); evResultHide(); setEvent(res.event || null); setObstacles(res.obstacles || []); setWeekend(res.weekend || 0);
    setFx(res.fx || null, true); mapPots = res.pots || []; setFun(res.fun || null); pollS = res.poll || null; myVote = null; renderPoll(); $('admBtn').classList.toggle('hidden', !res.admin); isAdminMe = !!res.admin; selfFx = { spd: 1, frozen: false, god: false, invis: false };
    setMini(res.mini || null); setBoss(res.boss || null); roomUntil = 0; bossRings.length = 0; updateRoomBar();
    updateHud();
    if (!reconnect) toastC('other', `Добро пожаловать, ${myName}! Собирайте сферы.`, 'ok');
  }
  function hideGameUi() {
    joined = false; evState = null; runners.clear(); obstacles = []; wkEnd = 0; updateWeekendChip(); setMini(null); setBoss(null); roomUntil = 0; updateRoomBar();
    $('hud').classList.add('hidden'); $('chat').classList.add('hidden'); $('chatBtn').classList.add('hidden'); closeChat();
    closeModals();
  }
  function showResume(text, buttons) {
    music.menu();
    $('start').classList.remove('hidden'); $('profile').classList.add('hidden');
    $('resumeBox').classList.remove('hidden'); $('authBox').classList.add('hidden');
    $('resumeText').textContent = text;
    $('resumeBtn').classList.toggle('hidden', !buttons); $('resumeLogout').classList.toggle('hidden', !buttons);
  }
  function showStart() {
    music.menu();
    stage = 'auth'; hideGameUi();
    $('start').classList.remove('hidden'); $('profile').classList.add('hidden');
    $('resumeBox').classList.add('hidden'); $('authBox').classList.remove('hidden');
    loadStartLb();
  }
  function showLobby(p) {
    music.menu();
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
    toastC('other', 'Вы вышли из аккаунта');
  }
  $('logoutBtn').addEventListener('click', logout);
  $('resumeLogout').addEventListener('click', logout);
  $('pfLogout').addEventListener('click', logout);
  $('pfPw').addEventListener('click', () => { // change own password (current one required)
    const old = window.prompt('Текущий пароль:'); if (old == null) return;
    const nw = window.prompt('Новый пароль:'); if (nw == null) return;
    const ne = RULES.passwordError(nw); if (ne) { $('pfError').textContent = ne; return; }
    const again = window.prompt('Повторите новый пароль:'); if (again == null) return;
    if (again !== nw) { $('pfError').textContent = 'Пароли не совпадают'; return; }
    socket.emit('pw:change', { old, new: nw }, r => {
      if (!r || !r.ok) { $('pfError').textContent = (r && r.error) || 'Ошибка'; return; }
      $('pfError').textContent = ''; if (summary) summary.mustChangePw = false; if (profile) profile.mustChangePw = false;
      $('pfPwNote').classList.add('hidden'); toastC('other', 'Пароль изменён', 'ok');
    });
  });
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
    players.set(p.id, { id: p.id, name: p.name, eq: p.eq, sz: p.sz || 1, trail: [], dir: { x: 1, y: 0 }, pos: { x: p.x, y: p.y }, last: { x: p.x, y: p.y } });
  }
  socket.on('pjoin', p => { if (!players.has(p.id)) addPlayer(p); });
  socket.on('pleave', id => players.delete(id));
  socket.on('chat', m => addChat(m, true));
  socket.on('pmeta', p => { const pl = players.get(p.id); if (pl) { pl.eq = p.eq; pl.name = p.name; pl.sz = p.sz || 1; } else if (p.id !== myId) addPlayer(p); });
  socket.on('sping', v => socket.emit('spong', v));
  socket.on('announce', a => toastC('rare', '✨ ' + a.text));
  // ------------------------------------------------------------ temporary obstacles + rotating lasers (server-run)
  let obstacles = [], zapFlash = 0, robotState = new Map(), shotsNow = [];
  // «Выходные» chip: ms left until Monday 00:00 MSK, counted down locally between server updates
  let wkEnd = 0;
  function setWeekend(left) { wkEnd = left > 0 ? performance.now() + left : 0; updateWeekendChip(); }
  function updateWeekendChip() {
    const chip = $('wkChip'); if (!chip) return;
    const left = wkEnd ? wkEnd - performance.now() : 0;
    if (!joined || left <= 0) { chip.classList.add('hidden'); chip.classList.remove('open'); return; }
    chip.classList.remove('hidden');
    const m = Math.ceil(left / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    const txt = d ? `${d} д ${h} ч` : h ? `${h}:${String(mm).padStart(2, '0')}` : `${mm} мин`;
    $('wkChipTime').textContent = txt;
    $('wkChipPhase').textContent = `До понедельника 00:00 МСК: ${d ? d + ' д ' : ''}${h} ч ${mm} мин`;
  }
  setInterval(updateWeekendChip, 1000);
  function setObstacles(list) {
    const now = performance.now(), old = new Map(obstacles.map(o => [o.id, o]));
    obstacles = (list || []).map(d => {
      const o = Object.assign({}, d, { born: old.has(d.id) ? old.get(d.id).born : now, endAt: now + d.life });
      if (d.k === 'laser') { o.a0 = d.a; o.t0 = now; o.armAt = now + d.arm; }
      return o;
    });
  }
  socket.on('obs', list => setObstacles(list));
  socket.on('zap', z => {
    if (!z) return; zapFlash = performance.now();
    floaters.push({ x: me.x, y: me.y - 26, text: (z.src === 'robot' ? '💥 −' : '⚡ −') + z.loss, color: '#ff4d5e', start: performance.now(), big: true });
    toastC('hits', `${z.src === 'robot' ? '🤖 Робот попал в вас!' : z.src === 'boss' ? '👹 Удар босса!' : '⚡ Лазер!'} Потеряно ${fmt(z.loss)} сфер — часть рассыпалась рядом. ${Math.round(z.inv / 1000)} с неуязвимости.`, 'err');
  });
  const MA = window.OCSMapArtCreate(G); window.OCSMapStats = () => MA.stats(); // map visuals (public/map-art.js)
  function drawRobot(o, t, now) {
    const st = robotState.get(o.id) || { face: 0, aim: 0 }, r = o.r, a = st.face;
    if (st.aim) { // telegraph: blinking red aim line to the target
      const fl = 0.5 + 0.5 * Math.sin(now / 45);
      ctx.save(); ctx.strokeStyle = `rgba(255,60,60,${0.35 + 0.5 * fl})`; ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.lineDashOffset = -now / 20;
      ctx.beginPath(); ctx.moveTo(o.x + Math.cos(a) * (r + 12), o.y + Math.sin(a) * (r + 12)); ctx.lineTo(st.ax, st.ay); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(st.ax, st.ay, 18 + 4 * fl, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,90,90,0.10)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(o.x, o.y, G.OBSTACLES.robotRange, 0, Math.PI * 2); ctx.stroke(); // range
    const rp = MA.robotPal(G.zoneOf(o.x)), metal = (x0, y0, x1, y1) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, rp[0]); g.addColorStop(0.35, rp[1]); g.addColorStop(0.6, rp[2]); g.addColorStop(1, rp[3]); return g; };
    // (no ground shadow) (no shadowBlur: costly at 2.5x size)
    ctx.fillStyle = metal(o.x - r, o.y - r, o.x + r, o.y + r); ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2); ctx.fill(); // body (player-like round)
    ctx.strokeStyle = '#3a404d'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = 'rgba(40,46,58,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(o.x - r * 0.8, o.y + r * 0.35); ctx.lineTo(o.x + r * 0.8, o.y + r * 0.35); ctx.stroke(); // panel seam
    for (const [dx, dy] of [[-0.6, 0.55], [0.6, 0.55], [-0.6, -0.55], [0.6, -0.55]]) { ctx.fillStyle = '#4a515f'; ctx.beginPath(); ctx.arc(o.x + dx * r, o.y + dy * r, 2.2, 0, Math.PI * 2); ctx.fill(); } // rivets
    ctx.fillStyle = '#7d8696'; ctx.fillRect(o.x - 2, o.y - r - 14, 4, 14); ctx.fillStyle = st.aim ? '#ff3030' : '#ffb347'; ctx.beginPath(); ctx.arc(o.x, o.y - r - 15, 4.5, 0, Math.PI * 2); ctx.fill(); // antenna
    ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(a); // arm cannon pointing at the target
    ctx.fillStyle = metal(0, -8, 0, 8); ctx.fillRect(r - 6, -7, 22, 14); ctx.strokeStyle = '#3a404d'; ctx.lineWidth = 2; ctx.strokeRect(r - 6, -7, 22, 14);
    ctx.fillStyle = st.aim ? '#ff4040' : '#222'; ctx.fillRect(r + 14, -4, 4, 8); ctx.restore();
    const ex = Math.cos(a) * 7, ey = Math.sin(a) * 7; // visor + glowing eyes looking at the target
    ctx.fillStyle = '#1b1f29'; ctx.beginPath(); ctx.ellipse(o.x + ex * 0.6, o.y - 6 + ey * 0.4, r * 0.62, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff3b3b'; ctx.shadowColor = '#ff2020'; ctx.shadowBlur = st.aim ? 16 : 8;
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(o.x + sx * 8 + ex * 0.6, o.y - 6 + ey * 0.4, 3.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.font = '800 12px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.fillStyle = '#d6dce8';
    ctx.strokeText('🤖 Железный робот', o.x, o.y + r + 20); ctx.fillText('🤖 Железный робот', o.x, o.y + r + 20);
  }
  function drawShots(now) {
    for (const b of shotsNow) {
      const k = Math.min(0.25, (now - b.at) / 1000), x = b.x + b.vx * k, y = b.y + b.vy * k, l = Math.hypot(b.vx, b.vy) || 1;
      ctx.save(); ctx.strokeStyle = 'rgba(255,140,40,0.45)'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - b.vx / l * 26, y - b.vy / l * 26); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = '#ffd27a'; ctx.shadowColor = '#ff7a1a'; ctx.shadowBlur = 18; ctx.beginPath(); ctx.arc(x, y, G.OBSTACLES.shotR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }
  function drawObstacles(t, now) {
    for (const o of obstacles) {
      const reach = o.k === 'laser' ? o.len + 30 : o.k === 'rect' ? Math.max(o.w, o.h) : o.r + 10;
      if (o.x < cam.x - reach || o.x > cam.x + VW + reach || o.y < cam.y - reach || o.y > cam.y + VH + reach) continue;
      const fadeIn = Math.min(1, (now - o.born) / 600), left = o.endAt - now, fadeOut = Math.max(0, Math.min(1, left / 1500));
      const blinkOut = left < 5000 ? 0.65 + 0.35 * Math.sin(now / 90) : 1; // flickers before it vanishes
      ctx.save(); ctx.globalAlpha = fadeIn * fadeOut * blinkOut;
      if (o.k === 'robot') { drawRobot(o, t, now); ctx.restore(); continue; }
      if (o.k === 'laser') {
        const a = G.laserAngle(o, now), armed = now >= o.armAt, ex = o.x + Math.cos(a) * o.len, ey = o.y + Math.sin(a) * o.len;
        if (!armed) { // warning: dashed sweep circle + flashing pylon
          const fl = 0.5 + 0.5 * Math.sin(now / 70);
          ctx.strokeStyle = `rgba(255,70,70,${0.25 + 0.35 * fl})`; ctx.setLineDash([12, 10]); ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(o.x, o.y, o.len, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          ctx.strokeStyle = `rgba(255,90,90,${0.35 + 0.4 * fl})`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(ex, ey); ctx.stroke();
          ctx.font = '800 18px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(255,120,120,${0.6 + 0.4 * fl})`;
          ctx.fillText(`⚠ ЛАЗЕР через ${Math.max(1, Math.ceil((o.armAt - now) / 1000))}`, o.x, o.y - o.r - 18);
        } else { // the beam: wide red glow + white-hot core
          ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,40,60,0.18)'; ctx.lineWidth = 34; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(ex, ey); ctx.stroke(); // glow without shadowBlur
          ctx.strokeStyle = 'rgba(255,40,60,0.45)'; ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(ex, ey); ctx.stroke();
          ctx.strokeStyle = '#ff3b4e'; ctx.lineWidth = 7; ctx.stroke();
          ctx.strokeStyle = '#fff2f2'; ctx.lineWidth = 2.2; ctx.stroke();
          MA.beamFx(ctx, o, ex, ey, G.zoneOf(o.x), now);
          ctx.fillStyle = 'rgba(255,80,80,0.9)'; ctx.beginPath(); ctx.arc(ex, ey, 6 + Math.sin(now / 60) * 1.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(255,60,60,0.12)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(o.x, o.y, o.len, 0, Math.PI * 2); ctx.stroke();
        }
        MA.pylon(ctx, o, G.zoneOf(o.x), armed, now);
      } else if (o.k === 'rect') MA.rectObs(ctx, o, G.zoneOf(o.x));
      else MA.rockObs(ctx, o, G.zoneOf(o.x));
      ctx.restore();
    }
  }

  socket.on('s', st => {
    if (!joined) return;
    const now = performance.now();
    const map = new Map();
    lastSnapIds = new Set(st.p.map(r => r[0]));
    for (const [id, x, y, ack] of st.p) {
      map.set(id, [x, y]);
      if (id === myId) reconcile(x, y, ack);
    }
    snapshots.push({ time: now, map });
    while (snapshots.length > 40) snapshots.shift();
    for (const [id, x, y, t, e] of st.oa) orbs.set(id, { x, y, t, born: now, fall: e && t !== 't' ? 1 : 0 }); // e: event orb (rain falls in)
    if (st.rn) syncRunners(st.rn, now); else runners.clear();
    syncBoss(st.bs, now);
    robotState = new Map((st.rb || []).map(r => [r[0], { face: r[1], aim: r[2], ax: r[3], ay: r[4] }]));
    shotsNow = (st.pj || []).map(b => ({ x: b[1], y: b[2], vx: b[3], vy: b[4], at: now }));
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
    for (const i of pending) { const px = p.x; G.applyInput(p, i.x, i.y, mySpeed()); G.zoneGate(p, px, doorOpen()); G.resolveObstacles(p, obstacles); G.resolveObstacles(p, bossSolid()); }
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
    if (d.id === G.SHARD_ID) { toastC('rewards', `✦ +${d.qty} ${d.qty === 1 ? 'осколок' : d.qty < 5 ? 'осколка' : 'осколков'}`, 'ok'); return; }
    const def = G.ITEM_BY_ID[d.id];
    if (def) toastC('rewards', `${def.icon || '🎁'} Получен предмет: ${def.name}${d.qty > 1 ? ' ×' + d.qty : ''} — он в инвентаре (I)`, 'ok');
  });
  // any fresh own-profile from the server: refresh everything that shows it
  function setProfile(p) {
    if (!p) return;
    profile = p;
    updateCalDot();
    if (summary) { Object.assign(summary, p); summary.items = p.inventory.reduce((n, s) => n + s.q, 0); summary.slotsUsed = p.inventory.length; summary.used = p.used; }
    updateHud();
    if (!$('shop').classList.contains('hidden')) renderShop();
    if (!$('ups').classList.contains('hidden')) renderUps();
    if (!$('inv').classList.contains('hidden')) renderInv();
    if (!$('profile').classList.contains('hidden')) renderProfile();
    if (!$('ach').classList.contains('hidden')) renderAch();
    if (!$('quests').classList.contains('hidden')) renderQuests();
  }
  socket.on('top', d => {
    if (d.wk != null) setWeekend(d.wk);
    $('hudOnline').textContent = d.online;
    const ol = $('hudTop'); ol.textContent = '';
    for (const [id, name, s] of d.top) {
      const li = document.createElement('li'); if (id === myId) li.className = 'me';
      li.append(String(name) + ' '); const b = document.createElement('b'); b.textContent = fmt(s); li.appendChild(b); ol.appendChild(li);
    }
  });

  // ---- zones + door (zone 1 violet | wall with a door | zone 2 blue, rarer orbs). Unlock is a server action.
  const doorOpen = () => !!(profile && profile.stats && profile.stats.unlockedDoor2);
  window.OCSZone = () => ({ zone: G.zoneOf(me.x), open: doorOpen(), x: me.x, y: me.y });
  // door prompt: shown once per approach when a locked player touches / comes within ~60px of the wall (zone-1 side);
  // ✕ hides it until the player walks away (>220px) and for 15 s. Works with touch + mouse (plain buttons, fixed above the bottom bar).
  let doorDismissed = false, doorCoolUntil = 0, doorWasNear = false;
  function updateDoorBtn() {
    const b = $('doorBtn'), box = $('doorPrompt'); if (!b || !box) return;
    const d = G.doorDist(me.x), locked = joined && profile && !doorOpen();
    if (d > 220) doorDismissed = false;
    const near = locked && me.x <= G.ZONE_W + 1 && d < G.PLAYER_R + 60 && !doorDismissed && performance.now() >= doorCoolUntil;
    box.classList.toggle('hidden', !near); b.classList.toggle('hidden', !near);
    if (!near) { doorWasNear = false; return; }
    const miss = Math.max(0, G.DOOR_COST - (profile.balance || 0));
    b.disabled = miss > 0; b.innerHTML = `Купить · ${orbsH(G.DOOR_COST)}`;
    const m = $('doorMiss'); m.classList.toggle('hidden', !miss); if (miss) m.textContent = `Не хватает ${fmt(miss)} сфер (у вас ${fmt(profile.balance || 0)})`;
    doorWasNear = true;
  }
  $('doorClose').addEventListener('click', e => { e.stopPropagation(); doorDismissed = true; doorCoolUntil = performance.now() + 15000; updateDoorBtn(); });
  $('doorBtn').addEventListener('click', () => {
    socket.emit('door:unlock', null, res => {
      if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
      setProfile(res.profile); updateDoorBtn();
      toastC('rewards', '🚪 Дверь открыта! В синей зоне редкие сферы попадаются чаще.', 'ok');
    });
  });
  function drawZones(t) {
    const Z = G.ZONE_W, H = G.ZONE_H, D = G.DOOR;
    if (cam.x + VW < Z - 400 && cam.x > -1) return;                             // wall far off-screen
    const open = doorOpen(), pulse = 0.6 + 0.4 * Math.sin(t * 3), col = open ? '#5dff8f' : '#ffcc33';
    ctx.save(); // the whole wall is the door: glowing frame, bars when locked, labels follow the camera
    ctx.fillStyle = open ? 'rgba(93,255,143,0.10)' : 'rgba(255,204,51,0.10)'; ctx.fillRect(Z - 22, 0, 44, H);
    ctx.lineWidth = 5; ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 22 * pulse;
    ctx.beginPath(); ctx.moveTo(Z - 22, 0); ctx.lineTo(Z - 22, H); ctx.moveTo(Z + 22, 0); ctx.lineTo(Z + 22, H); ctx.stroke();
    const y0 = Math.max(0, Math.floor((cam.y - 60) / 28) * 28), y1 = Math.min(H, cam.y + VH + 60);
    ctx.shadowBlur = 0; MA.drawDoorWall(ctx, y0, y1);
    if (!open) { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,204,51,0.75)'; ctx.beginPath(); for (let y = y0; y < y1; y += 28) { ctx.moveTo(Z - 20, y); ctx.lineTo(Z + 20, y); } ctx.stroke(); }
    else { ctx.strokeStyle = 'rgba(93,255,143,0.35)'; ctx.lineWidth = 2; ctx.setLineDash([12, 16]); ctx.lineDashOffset = -t * 40; ctx.beginPath(); ctx.moveTo(Z, y0); ctx.lineTo(Z, y1); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 18px system-ui, sans-serif';
    for (let y = Math.max(350, Math.floor((cam.y - 400) / 1400) * 1400 + 350); y < Math.min(H - 100, cam.y + VH + 350); y += 1400) { // every 1 400 px (half as many labels)
      ctx.fillText(open ? '🚪 Зона 2 — проход открыт' : `🔒 Дверь: ${fmt(G.DOOR_COST)} сфер`, Z, y);
      ctx.font = '600 14px system-ui, sans-serif'; ctx.fillStyle = 'rgba(200,215,255,0.8)'; ctx.fillText('больше редких сфер →', Z + 130, y + 26); ctx.font = '700 18px system-ui, sans-serif'; ctx.fillStyle = '#fff';
    }
    ctx.restore();
  }
  function updateHud(bump) {
    if (!profile) return;
    $('hudBalance').textContent = fmt(profile.balance);
    $('hudShards').textContent = fmt(profile.shards || 0);
    updateBoostsHud(); updateQuestTracker();
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
    if (e.code === 'KeyU') toggleModal('ups');
    if (e.code === 'KeyM') toggleModal('games');
    if (e.code === 'KeyL') toggleModal('lb');
    if (e.code === 'KeyQ') toggleModal('quests');
    if (e.code === 'KeyK') toggleModal('cal');
    if (e.code === 'KeyJ') toggleModal('ach');
    if (e.code === 'KeyH') toggleOrbHelp();
    if (e.code === 'Space' && reactionState === 'go' || e.code === 'Space' && reactionState === 'wait') { e.preventDefault(); reactionClick(); }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; pointer.down = false; joy = null; });
  // camera zoom: wheel / pinch / +− buttons; 0.5×–1.5×, saved in localStorage. Phones start zoomed out (see more of the arena).
  // A second finger on the arena starts a pinch: movement pauses until all fingers are lifted (no jump to a stray finger).
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches, touchUI = coarse || window.innerWidth <= 760;
  const ZOOM_MIN = touchUI ? 0.25 : 0.5, ZOOM_MAX = 1.5, ZOOM_KEY = 'ocs_zoom'; // phones / tablets may zoom out 2× further (the server sends the whole world)
  const clampZ = z => Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 1000) / 1000;
  zoom = clampZ(parseFloat(store.get(ZOOM_KEY)) || (touchUI ? 0.75 : 1));
  function setZoom(z) {
    zoom = clampZ(z); store.set(ZOOM_KEY, String(zoom));
    $('zoomIn').disabled = zoom >= ZOOM_MAX; $('zoomOut').disabled = zoom <= ZOOM_MIN;
  }
  window.OCSZoom = () => zoom; // read-only hook for the UI test
  $('zoomIn').onclick = () => setZoom(zoom * 1.15);
  $('zoomOut').onclick = () => setZoom(zoom / 1.15);
  setZoom(zoom);
  canvas.addEventListener('wheel', e => { if (!joined) return; e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  document.addEventListener('gesturestart', e => e.preventDefault()); // iOS Safari page zoom
  const touchPts = new Map();
  let pinch = null;
  const pinchDist = () => { const [a, b] = Array.from(touchPts.values()); return Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)); };
  // Touch only: a floating joystick appears where a finger lands on the left part of the arena (knob offset = direction,
  // analog speed up to JOY_R px); the right part keeps hold-to-move towards the finger. A second finger cancels it (pinch).
  const JOY_R = 58, JOY_ZONE = 0.55;
  let joy = null;
  // ------------------------------------------------------------ potions on the map, emotes over heads, public profile cards
  let mapPots = [];
  const emotes = new Map(); // player id → { e, at }
  socket.on('pots', l => { mapPots = Array.isArray(l) ? l : []; });
  socket.on('emote', d => { if (d && G.ITEM_BY_ID[d.e]) emotes.set(d.id, { e: G.ITEM_BY_ID[d.e].value, at: performance.now() }); });
  window.OCSPots = () => mapPots.slice();
  // procedural potion bottles (own art, flat glass style): kind → shape + liquid colour; drawn in a ±32 box around (0,0)
  const BOTTLES = {
    speed: { shape: 'tube', liq: '#1e9bff', liq2: '#6fd3ff', cap: '#e8b878' },
    orbs: { shape: 'jar', liq: '#ff9a1f', liq2: '#ffcf5a', cap: '#e8b878' },
    luck: { shape: 'round', liq: '#2fc25b', liq2: '#8be86a', cap: '#e8b878' },
    magnet: { shape: 'heart', liq: '#ff4f86', liq2: '#ff9bbd', cap: '#c9443f' },
    shard: { shape: 'wide', liq: '#8a3cff', liq2: '#c193ff', cap: '#7b7f8c' },
  };
  function bottleBody(g, shape) { // body path (without neck/cork); returns {top, bottom, neckW, neckTop}
    g.beginPath();
    if (shape === 'tube') { g.moveTo(-7, -18); g.lineTo(7, -18); g.lineTo(7, 16); g.arc(0, 16, 7, 0, Math.PI); g.closePath(); return { top: -18, bot: 23, nw: 0, nt: -18, cw: 9, ct: -27 }; }
    if (shape === 'jar') { g.roundRect(-19, -10, 38, 32, 9); return { top: -10, bot: 22, nw: 9, nt: -17, cw: 12, ct: -28 }; }
    if (shape === 'round') { g.arc(0, 6, 18, 0, Math.PI * 2); return { top: -12, bot: 24, nw: 6, nt: -18, cw: 9, ct: -28 }; }
    if (shape === 'heart') { g.moveTo(0, -8); g.bezierCurveTo(10, -16, 26, -10, 24, 2); g.bezierCurveTo(22, 12, 8, 18, 0, 24); g.bezierCurveTo(-8, 18, -22, 12, -24, 2); g.bezierCurveTo(-26, -10, -10, -16, 0, -8); g.closePath(); return { top: -12, bot: 24, nw: 7, nt: -18, cw: 10, ct: -28 }; }
    g.ellipse(0, 7, 24, 15, 0, 0, Math.PI * 2); return { top: -8, bot: 22, nw: 7, nt: -16, cw: 11, ct: -27 }; // wide
  }
  // hand-made SVG sprites (public/potion-art.js) rasterized once to 256px canvases; procedural bottle stays as a fallback
  const POT_SPR = {};
  (function loadPotionSprites() {
    const A = window.OCSPotionArt; if (!A) return;
    for (const k of Object.keys(BOTTLES)) {
      if (!A[k]) continue;
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas'); cv.width = cv.height = 256; cv.getContext('2d').drawImage(im, 0, 0, 256, 256); POT_SPR[k] = cv;
        for (const d of G.ITEMS) if (d.potion === k) { iconCache.delete(String(d.id)); document.querySelectorAll(`img[data-icon="${d.id}"]`).forEach(i => { i.src = iconUrl(d.id); }); }
      };
      im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(A[k]);
    }
  })();
  window.OCSPotSprites = () => Object.keys(POT_SPR);
  function drawPotionBottle(g, kind, x, y, s, t = 0, shadow = true) {
    const spr = POT_SPR[kind];
    if (spr) {
      g.save(); g.translate(x, y); g.scale(s, s);
      if (shadow) { g.fillStyle = 'rgba(5,8,20,0.35)'; g.beginPath(); g.ellipse(0, 27, kind === 'speed' ? 11 : 19, 4, 0, 0, Math.PI * 2); g.fill(); }
      g.drawImage(spr, -36, -36, 72, 72);
      g.restore(); return;
    }
    const B = BOTTLES[kind] || BOTTLES.speed, line = '#16234a';
    g.save(); g.translate(x, y); g.scale(s, s); g.lineJoin = 'round';
    if (shadow) { g.fillStyle = 'rgba(5,8,20,0.45)'; g.beginPath(); g.ellipse(0, 27, B.shape === 'tube' ? 10 : 20, 4.5, 0, 0, Math.PI * 2); g.fill(); }
    // neck
    const m = bottleBody(g, B.shape);
    if (m.nw) { g.fillStyle = 'rgba(160,225,255,0.85)'; g.strokeStyle = line; g.lineWidth = 2; g.beginPath(); g.roundRect(-m.nw, m.nt, m.nw * 2, m.top - m.nt + 4, 3); g.fill(); g.stroke(); }
    // glass body
    bottleBody(g, B.shape); g.fillStyle = 'rgba(150,215,255,0.78)'; g.fill();
    // liquid (clipped to the body), lower ~60 %, lighter surface band + gentle wobble
    g.save(); bottleBody(g, B.shape); g.clip();
    const lv = m.top + (m.bot - m.top) * 0.4 + Math.sin(t * 3) * 0.8;
    g.fillStyle = B.liq; g.fillRect(-30, lv, 60, 40);
    g.fillStyle = B.liq2; g.beginPath(); g.ellipse(0, lv, 30, 3.2, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(8, lv, 30, 40); // flat side shade
    g.restore();
    bottleBody(g, B.shape); g.strokeStyle = line; g.lineWidth = 2.2; g.stroke();
    // cork / cap
    g.fillStyle = B.cap; g.strokeStyle = line; g.lineWidth = 2; g.beginPath(); g.roundRect(-m.cw, m.ct, m.cw * 2, 9, 3.5); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-m.cw + 2.5, m.ct + 2, m.cw * 0.7, 2.2);
    // gloss: white streak + dots
    g.fillStyle = 'rgba(255,255,255,0.85)';
    const hx = B.shape === 'tube' ? -3 : B.shape === 'jar' ? -12 : -11, hy = B.shape === 'tube' ? -10 : m.top + 6;
    g.beginPath(); g.ellipse(hx, hy + 3, B.shape === 'tube' ? 1.6 : 3, B.shape === 'tube' ? 6 : 5, -0.3, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(hx + (B.shape === 'tube' ? 0 : 3), hy + (B.shape === 'tube' ? 9 : 11), 1.6, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(B.shape === 'tube' ? 3 : 10, m.bot - 7, 1.8, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fill();
    if (kind === 'shard') { // epic sparkle
      for (let i = 0; i < 3; i++) {
        const a = t * 1.7 + i * 2.1, sx = Math.cos(a) * 20, sy = 2 + Math.sin(a * 1.3) * 12, r = 2.2 + Math.sin(t * 5 + i) * 1.2;
        g.fillStyle = 'rgba(255,240,255,0.95)'; g.beginPath(); g.moveTo(sx, sy - r * 2); g.lineTo(sx + r * 0.5, sy); g.lineTo(sx, sy + r * 2); g.lineTo(sx - r * 0.5, sy); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(sx - r * 2, sy); g.lineTo(sx, sy + r * 0.5); g.lineTo(sx + r * 2, sy); g.lineTo(sx, sy - r * 0.5); g.closePath(); g.fill();
      }
    }
    g.restore();
  }
  window.OCSBottle = drawPotionBottle;
  function drawPotions(g, t) {
    for (const [, x, y, item] of mapPots) {
      if (x < cam.x - 60 || x > cam.x + VW + 60 || y < cam.y - 60 || y > cam.y + VH + 60) continue;
      const def = G.ITEM_BY_ID[item]; if (!def) continue;
      const bob = Math.sin(t * 2.4 + x) * 3.5, r = G.POTION_MAP.r, col = (BOTTLES[def.potion] || BOTTLES.speed).liq;
      g.save(); const gl = g.createRadialGradient(x, y + bob, 2, x, y + bob, r * 2.4); gl.addColorStop(0, col + '66'); gl.addColorStop(1, col + '00');
      g.globalAlpha = 0.75 + Math.sin(t * 4 + x) * 0.25; g.fillStyle = gl; g.beginPath(); g.arc(x, y + bob, r * 2.4, 0, Math.PI * 2); g.fill(); g.restore();
      g.save(); g.fillStyle = 'rgba(5,8,20,0.4)'; g.beginPath(); g.ellipse(x, y + r * 1.5, r * 1.1 - bob * 0.6, r * 0.25, 0, 0, Math.PI * 2); g.fill(); g.restore(); // shadow stays on the ground
      drawPotionBottle(g, def.potion, x, y + bob - 6, r / 16, t, false);
      const sp = (t * 0.7 + (x % 97) / 97) % 1; // occasional twinkle
      if (sp < 0.18) { const k = Math.sin(sp / 0.18 * Math.PI), sx = x + 12 * (r / 16), sy = y + bob - 22 * (r / 16), z = 5 * k * (r / 16);
        g.save(); g.globalAlpha = k; g.fillStyle = '#fff'; g.beginPath(); g.moveTo(sx, sy - z); g.quadraticCurveTo(sx, sy, sx + z, sy); g.quadraticCurveTo(sx, sy, sx, sy + z); g.quadraticCurveTo(sx, sy, sx - z, sy); g.quadraticCurveTo(sx, sy, sx, sy - z); g.fill(); g.restore(); }
    }
  }
  function drawEmotes(g) {
    const n = performance.now();
    for (const [id, em] of emotes) {
      const k = (n - em.at) / G.EMOTE_MS, pl = players.get(id), pos = id === myId ? dispMe : pl && pl.pos;
      if (k >= 1 || !pl || !pos) { emotes.delete(id); continue; }
      const pop = Math.min(1, k * 8), a = k > 0.85 ? (1 - k) / 0.15 : 1, r = G.PLAYER_R * (pl.sz || 1);
      g.save(); g.globalAlpha = a; g.font = `${Math.round(30 * pop)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillStyle = 'rgba(10,14,32,0.65)'; g.beginPath(); g.arc(pos.x, pos.y - r - 46 - k * 8, 22 * pop, 0, Math.PI * 2); g.fill();
      g.fillText(em.e, pos.x, pos.y - r - 30 - k * 8); g.restore();
    }
  }
  // emote picker (button next to the radar)
  const emoteOwned = def => def.free || owns(def.id);
  function renderEmotePicker() {
    const box = $('emotePicker'); box.innerHTML = '';
    const list = G.ITEMS.filter(i => i.type === 'emote');
    for (const def of list) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'emo' + (emoteOwned(def) ? '' : ' locked'); b.dataset.emote = def.id;
      b.title = def.name + (emoteOwned(def) ? '' : ` — в магазине за ${def.price} сфер`); b.textContent = def.value;
      b.onclick = () => {
        if (!emoteOwned(def)) { toast(`«${def.name}» продаётся в магазине (раздел «Эмоции») за ${fmt(def.price)} сфер`, 'err'); return; }
        socket.emit('emote', def.id, r => { if (r && !r.ok) toast(r.error, 'err'); });
        box.classList.add('hidden');
      };
      box.appendChild(b);
    }
  }
  // emotes in chat: picker next to the chat input; owned ones send a chat emote message, locked ones point to the shop
  function renderChatEmotes() {
    const box = $('chatEmotePicker'); box.innerHTML = '';
    for (const def of G.ITEMS.filter(i => i.type === 'emote')) {
      const own = emoteOwned(def), b = document.createElement('button'); b.type = 'button'; b.className = 'emo' + (own ? '' : ' locked'); b.dataset.emote = def.id;
      b.title = def.name + ' :' + def.id.slice(2) + ':' + (own ? '' : ` — в магазине за ${def.price} сфер`); b.setAttribute('aria-label', def.name); b.textContent = def.value;
      b.onclick = e => {
        e.preventDefault();
        if (!own) { toast(`«${def.name}» продаётся в магазине (раздел «Эмоции») за ${fmt(def.price)} сфер`, 'err'); return; }
        socket.emit('chat:emote', def.id, r => { if (r && !r.ok) toast(r.error, 'err'); });
        box.classList.add('hidden');
      };
      box.appendChild(b);
    }
  }
  $('chatEmoBtn').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const box = $('chatEmotePicker'); if (box.classList.contains('hidden')) renderChatEmotes(); box.classList.toggle('hidden'); });
  document.addEventListener('pointerdown', e => { const box = $('chatEmotePicker'); if (!box.classList.contains('hidden') && !box.contains(e.target) && !$('chatEmoBtn').contains(e.target)) box.classList.add('hidden'); });
  $('emoteBtn').addEventListener('click', e => { e.stopPropagation(); const box = $('emotePicker'); if (box.classList.contains('hidden')) renderEmotePicker(); box.classList.toggle('hidden'); });
  document.addEventListener('pointerdown', e => { const box = $('emotePicker'); if (!box.classList.contains('hidden') && !box.contains(e.target) && e.target !== $('emoteBtn')) box.classList.add('hidden'); });
  // potion HUD: active potion icons with timers
  function updatePotionHud() {
    const el = $('hudPotions'), p = profile && profile.stats && profile.stats.potions, now = Date.now() + srvSkew;
    const on = p ? Object.keys(G.POTIONS).filter(k => p[k] > now) : [];
    el.classList.toggle('hidden', !on.length);
    el.innerHTML = on.map(k => { const def = G.ITEMS.find(i => i.potion === k); return `<span class="pot-chip" data-pot="${k}" title="${esc(def.name)}: ${esc(def.desc)}"><img src="${iconUrl(def.id)}" alt="">${mmss(p[k] - now)}</span>`; }).join('');
  }
  setInterval(() => { if (joined && profile) updatePotionHud(); }, 500);
  function drinkPotion(def) {
    socket.emit('potion:use', def.id, r => {
      if (!r || !r.ok) { toast((r && r.error) || 'Не получилось', 'err'); return; }
      if (r.profile) setProfile(r.profile);
      toastC('rewards', r.stacked ? `🧪 ${def.name}: +${mmss(r.added)} (осталось ${mmss(r.until - Date.now() - srvSkew)})` : `🧪 ${def.name}: ${def.desc}`, 'ok'); renderInv(); updatePotionHud(); updateHud();
    });
  }
  // public profile card: click / tap a player on the map
  const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`);
  function openCard(id) {
    let tries = 0;
    const ask = () => socket.emit('profile:public', id, r => {
      if (r && r.ok) return showCard(r.card);
      if (r && r.error === 'Подождите…' && ++tries < 4) return setTimeout(ask, 350);
      toast((r && r.error) || 'Профиль недоступен', 'err');
    });
    ask();
  }
  function showCard(c) {
    const box = $('pcard'), eq = Object.values(c.equipped || {}).map(id => G.ITEM_BY_ID[id]).filter(d => d && !d.base);
    $('pcName').textContent = c.name + (c.me ? ' (вы)' : ''); $('pcAdmin').classList.toggle('hidden', !c.admin);
    $('pcTrophy').classList.toggle('hidden', !c.trophy);
    const av = $('pcAvatar'), ag = av.getContext('2d'); ag.setTransform(1, 0, 0, 1, 0, 0); ag.clearRect(0, 0, av.width, av.height);
    try { drawAvatar(ag, av.width / 2, av.height / 2 + 6, 26, c.equipped || {}, performance.now() / 1000, { dir: 1, phase: 1 }); } catch (e) {}
    const rows = [['Всего собрано', `${fmt(c.total)} ${ORB_I}`], ['Сейчас сфер', `${fmt(c.balance)} ${ORB_I}`], ['Осколки', shardsH(c.shards)], ['Достижения', `${c.ach}/${c.achMax}`],
      ['Кубок', c.trophy ? '🏆 есть' : '—'], ['Время в игре', fmtMin(c.playMin)], ['Побеждено боссов', fmt(c.bossKills)], ['Мини-игр выиграно', fmt(c.mgWins)], ['Заданий выполнено', fmt(c.questsDone)]];
    $('pcStats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('pcEq').innerHTML = ''; if (!eq.length) $('pcEq').textContent = 'Стандартный образ';
    for (const d of eq) { const t = document.createElement('span'); t.className = 'pc-eq rar-' + d.rarity; t.appendChild(iconEl(d.id, 'sm')); t.append(d.name); $('pcEq').appendChild(t); }
    box.classList.remove('hidden');
  }
  $('pcClose').addEventListener('click', () => $('pcard').classList.add('hidden'));
  window.OCSCard = openCard;
  window.OCSWorldToClient = (x, y) => ({ x: (x - cam.x) * zoom, y: (y - cam.y) * zoom });
  function playerAt(cx, cy) { // client px → player under the pointer (or null)
    const wx = cam.x + cx / zoom, wy = cam.y + cy / zoom; let best = null, bd = 1e9;
    for (const pl of players.values()) {
      if (!pl.pos || (pl.id !== myId && lastSnapIds && !lastSnapIds.has(pl.id))) continue;
      const d = Math.hypot(pl.pos.x - wx, pl.pos.y - wy); if (d < G.PLAYER_R * (pl.sz || 1) + 10 && d < bd) { bd = d; best = pl; }
    }
    return best;
  }
  window.OCSJoy = () => (joy ? { bx: joy.bx, by: joy.by, kx: joy.kx, ky: joy.ky } : null); // read-only hook for the UI test
  window.OCSMe = () => ({ x: me.x, y: me.y });
  const joyMove = (x, y) => { const dx = x - joy.bx, dy = y - joy.by, d = Math.hypot(dx, dy), k = d > JOY_R ? JOY_R / d : 1; joy.kx = joy.bx + dx * k; joy.ky = joy.by + dy * k; };
  canvas.addEventListener('pointerdown', e => {
    if (joined && stage === 'game') { const hit = playerAt(e.clientX, e.clientY); if (hit) { openCard(hit.id); return; } }
    if (e.pointerType === 'touch') {
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPts.size >= 2) { if (!pinch && touchPts.size === 2) pinch = { d: pinchDist(), z: zoom }; pointer.down = false; joy = null; return; }
      if (!pinch && joined && e.clientX < W * JOY_ZONE) {
        const bx = Math.max(JOY_R + 12, e.clientX), by = Math.max(JOY_R + 12, Math.min(H - JOY_R - 12, e.clientY));
        joy = { id: e.pointerId, bx, by, kx: bx, ky: by }; joyMove(e.clientX, e.clientY);
        return;
      }
    }
    if (pinch) return;
    pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY;
  });
  window.addEventListener('pointermove', e => {
    if (touchPts.has(e.pointerId)) touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { if (touchPts.size >= 2) setZoom(pinch.z * pinchDist() / pinch.d); return; }
    if (joy) { if (joy.id === e.pointerId) joyMove(e.clientX, e.clientY); return; }
    pointer.x = e.clientX; pointer.y = e.clientY;
  });
  const ptrEnd = e => { touchPts.delete(e.pointerId); if (pinch && touchPts.size === 0) pinch = null; if (joy && joy.id === e.pointerId) joy = null; pointer.down = false; };
  function drawJoystick(t) {
    if (!joy) return;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(62,224,255,0.75)'; ctx.shadowColor = '#3ee0ff'; ctx.shadowBlur = 16;
    ctx.fillStyle = 'rgba(20,40,90,0.28)';
    ctx.beginPath(); ctx.arc(joy.bx, joy.by, JOY_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(122,92,255,0.45)';
    ctx.beginPath(); ctx.arc(joy.bx, joy.by, JOY_R * 0.55 + Math.sin(t * 4) * 2, 0, Math.PI * 2); ctx.stroke();
    const g = ctx.createRadialGradient(joy.kx - 6, joy.ky - 6, 2, joy.kx, joy.ky, 26);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#7ff0ff'); g.addColorStop(1, 'rgba(62,140,255,0.85)');
    ctx.fillStyle = g; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.arc(joy.kx, joy.ky, 24, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  window.addEventListener('pointerup', ptrEnd);
  window.addEventListener('pointercancel', ptrEnd);

  function getDir() {
    if (anyModal() || chatOpen) return { x: 0, y: 0 };
    let x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    let y = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (x || y) { const l = Math.hypot(x, y); return { x: x / l, y: y / l }; }
    if (joy) {
      const dx = joy.kx - joy.bx, dy = joy.ky - joy.by, d = Math.hypot(dx, dy);
      if (d < 6) return { x: 0, y: 0 };
      const mag = Math.min(1, d / JOY_R); // analog; the server clamps |dir| ≤ 1 anyway
      return { x: dx / d * mag, y: dy / d * mag };
    }
    if (pointer.down) {
      const dx = pointer.x - (dispMe.x - cam.x) * zoom, dy = pointer.y - (dispMe.y - cam.y) * zoom;
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
    G.zoneGate(me, prevMe.x, doorOpen());
    G.resolveObstacles(me, obstacles); G.resolveObstacles(me, bossSolid());
    pending.push(inp);
    updateDoorBtn();
    if (pending.length > 80) pending.shift();
    lastStepAt = performance.now();
    if (inp.x || inp.y) { const l = Math.hypot(inp.x, inp.y); myDir = { x: inp.x / l, y: inp.y / l }; }
  }, G.TICK_MS);

  // ------------------------------------------------------------ rendering helpers
  const orbSprites = {};
  // render-only tints: more saturated, and uncommon pushed to mint so it doesn't melt into the grass
  const ORB_TINT = { c: ['#22d8ff', '#0a5a8a'], u: ['#9dffcf', '#0b6b45'], r: ['#b05cff', '#3d1478'], e: ['#ff8a12', '#7a3300'], l: ['#ffd21a', '#7a5600'], m: ['#ff2d63', '#7a0024'], t: ['#ffe680', '#7a5a00'] };
  function makeOrbSprite(t) {
    const size = Math.ceil(t.r * 8), c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d'), mid = size, R = t.r * 2, [col, dark] = ORB_TINT[t.key] || [t.color, 'rgba(0,30,50,1)'];
    const grd = g.createRadialGradient(mid, mid, R * 0.9, mid, mid, size);   // soft outer halo
    grd.addColorStop(0, t.glow + '0.6)'); grd.addColorStop(0.25, t.glow + '0.25)'); grd.addColorStop(0.6, t.glow + '0.07)'); grd.addColorStop(1, t.glow + '0)');
    g.fillStyle = grd; g.fillRect(0, 0, size * 2, size * 2);
    g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(mid, mid, R * 1.12, 0, 6.2832); g.fill();          // white rim
    g.fillStyle = dark; g.beginPath(); g.arc(mid, mid, R * 0.98, 0, 6.2832); g.fill();                          // dark outline ring
    const core = g.createRadialGradient(mid - R * 0.3, mid - R * 0.35, 0, mid, mid, R * 0.84);
    core.addColorStop(0, '#ffffff'); core.addColorStop(0.3, col); core.addColorStop(1, dark);
    g.fillStyle = core; g.beginPath(); g.arc(mid, mid, R * 0.84, 0, 6.2832); g.fill();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.ellipse(mid - R * 0.3, mid - R * 0.38, R * 0.22, R * 0.14, -0.6, 0, 6.2832); g.fill(); // gloss
    return { c, half: size / 2 };
  }
  for (const t of Object.values(G.ORB_TYPES)) orbSprites[t.key] = makeOrbSprite(t);
  orbSprites.runner = makeOrbSprite({ key: 'runner', r: G.EVENTS.runner.r / 2 / 1.1, color: '#c6fdff', glow: 'rgba(125,252,255,' });
  const orbDef = type => (Object.prototype.hasOwnProperty.call(G.ORB_TYPES, type) ? G.ORB_TYPES[type] : G.ORB_TYPES.c); // unknown tier → common look
  function drawOrb(g, x, y, type, t, id, scale = 1) {
    const s = orbSprites[type] || orbSprites.c, ot = orbDef(type);
    const pulse = (type === 'c' || type === 'u' ? 1 : 1 + 0.09 * Math.sin(t * 3.2 + id * 1.7)) * scale;
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
    if (hat === 'betacap') { // green glossy baseball cap with a «β» badge
      const gr = g.createLinearGradient(0, y - r * 0.6, 0, y + 6); gr.addColorStop(0, '#9dff7a'); gr.addColorStop(0.55, '#3fcf4a'); gr.addColorStop(1, '#1f8f34');
      g.fillStyle = gr; g.shadowColor = '#4dff6a'; g.shadowBlur = 8;
      g.beginPath(); g.arc(0, y + 4, r * 0.62, Math.PI, 0); g.closePath(); g.fill(); g.shadowBlur = 0;
      g.fillStyle = '#1b7a2c'; g.beginPath(); g.ellipse(r * 0.45, y + 4, r * 0.52, r * 0.15, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.45)'; g.beginPath(); g.ellipse(-r * 0.2, y - r * 0.28, r * 0.2, r * 0.09, -0.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = `800 ${Math.round(r * 0.36)}px Segoe UI, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('β', r * 0.08, y - r * 0.12);
      g.fillStyle = '#c8ffb5'; g.beginPath(); g.arc(0, y - r * 0.6 + 4, 2.5, 0, Math.PI * 2); g.fill();
    } else if (hat === 'cap') {
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
    } else if (hat === 'trophy') { // golden cup: two handles, bowl, stem, base
      const w = r * 0.62, by = y + 4, cy = by - r * 0.95;
      g.shadowColor = '#ffcc33'; g.shadowBlur = 14;
      const gr = g.createLinearGradient(-w, 0, w, 0); gr.addColorStop(0, '#b8860b'); gr.addColorStop(0.45, '#fff3a0'); gr.addColorStop(1, '#d4a017');
      g.fillStyle = gr; g.strokeStyle = '#8a6508'; g.lineWidth = 1.2;
      g.fillRect(-w * 0.75, by - 4, w * 1.5, 4); g.strokeRect(-w * 0.75, by - 4, w * 1.5, 4); // base
      g.fillRect(-w * 0.16, by - r * 0.38, w * 0.32, r * 0.36); // stem
      g.beginPath(); g.moveTo(-w, cy); g.lineTo(w, cy); g.quadraticCurveTo(w * 0.95, by - r * 0.3, 0, by - r * 0.36); g.quadraticCurveTo(-w * 0.95, by - r * 0.3, -w, cy); g.closePath(); g.fill(); g.stroke(); // bowl
      g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = '#e6b422';
      g.beginPath(); g.arc(-w, cy + r * 0.25, r * 0.22, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
      g.beginPath(); g.arc(w, cy + r * 0.25, r * 0.22, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(-w * 0.55, cy + 2, w * 0.18, r * 0.3); // shine
      g.fillStyle = '#ff4d6d'; g.beginPath(); g.arc(0, cy + r * 0.22, 2.6, 0, Math.PI * 2); g.fill(); // gem
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
    trophy: r => r * 0.95 + 6, propeller: r => r * 0.95 + 6, viking: r => r * 0.85 + 6, cowboy: r => r * 0.62 + 8, headphones: () => 14, cat: r => r * 0.5 + 8, shardcrown: r => r * 1.08 + 8, satellites: r => r * 0.5 + 8 };
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

  // ---- trail rarity FX: every trail keeps its own renderer (identity); a tier layer on top adds glow / sparkles /
  // bursts by rarity. Performance: particles are the trail points themselves (pooled, interpolated along movement so
  // there are no gaps at high speed), every soft/glowing shape is a pre-rendered cached sprite (shadowBlur only once,
  // when a sprite is built), per-player and per-frame global particle budgets, off-screen trails are skipped by the caller.
  // tier: 0 common · 1 rare · 2 epic · 3 legendary · 4 shard-shop exclusive
  const TRAIL_THEME = { sparks: ['player', '#ffffff'], neon: ['player', '#ffffff'], fire: ['#ff8a2e', '#ffe08a'], smoke: ['#c4cce0', '#8a93b8'],
    bubbles: ['#9fe9ff', '#ffffff'], pixel: ['#3ee0ff', '#ff4d6d'], leaves: ['#7ed957', '#ffb347'], snow: ['#e8f6ff', '#9fd8ff'], hearts: ['#ff5fa2', '#ffd1e6'],
    stars: ['#ffe066', '#fff6c2'], lightning: ['#7cc8ff', '#eaffff'], rainbow: ['rainbow', '#ffffff'], galaxy: ['#b46bff', '#7cc8ff'], comet: ['#ffcf5a', '#7cd8ff'], crystal: ['#9de8ff', '#ffb8f0'], pages: ['#ffffff', '#ff5a5a'] };
  const TIER_OF = { common: 0, rare: 1, epic: 2, legendary: 3, exclusive: 3 };
  const TRAIL_LIFE = [650, 700, 800, 1000, 1150], TRAIL_PTS = [34, 38, 44, 54, 60]; // higher tiers keep a longer luminous tail
  const TRAIL_STEP = 6; // world px between emitted points (interpolated: fast movement leaves no gaps)
  const trailTier = id => { const d = G.ITEM_BY_ID[id]; return !d ? 0 : d.exclusive ? 4 : (TIER_OF[d.rarity] || 0); };
  const FX_CAP = [0, 6, 18, 30, 40]; // tier-layer particles per player per frame (halved at reduced quality)
  const BASE_CAP = [14, 24, 32]; // base-renderer particles per player per frame by fxLod
  const GLOBAL_CAP = [260, 650, 1300]; // all trail particles on screen per frame by fxLod
  let fxLod = 2, fpsEma = 60, lastFrameAt = 0; // 2 full · 1 reduced · 0 glow only — set every frame from FPS, trails on screen, mobile
  let trailBudget = 1e9, trailLive = null; // live: drawing the main canvas (budgets apply); previews are never throttled
  function trailFrame(lod) { trailBudget = GLOBAL_CAP[lod]; }
  // pooled trail points
  const TP_POOL = [];
  function trailPoint(x, y, time) { const p = TP_POOL.pop() || { x: 0, y: 0, time: 0, seed: 0 }; p.x = x; p.y = y; p.time = time; p.seed = Math.random(); return p; }
  function trailClear(pl) { for (const p of pl.trail) if (TP_POOL.length < 4000) TP_POOL.push(p); pl.trail.length = 0; }
  function trailStep(pl, p, now) { // emit points every TRAIL_STEP px along the movement since the last point; trim by age / count
    const L = pl.last, dx = p.x - L.x, dy = p.y - L.y, d = Math.hypot(dx, dy);
    if (d > 260) { trailClear(pl); L.x = p.x; L.y = p.y; pl.lastT = now; } // teleport / respawn: no streak across the map
    else if (d >= TRAIL_STEP) {
      const steps = Math.min(10, Math.floor(d / TRAIL_STEP)), t0 = pl.lastT && now - pl.lastT < 250 ? pl.lastT : now - 16;
      for (let i = 1; i <= steps; i++) { const f = i / steps; pl.trail.push(trailPoint(L.x + dx * f, L.y + dy * f, t0 + (now - t0) * f)); }
      L.x = p.x; L.y = p.y; pl.lastT = now;
    }
    const tr = trailTier(pl.eq.trail), life = TRAIL_LIFE[tr], max = TRAIL_PTS[tr], tl = pl.trail;
    let cut = 0; while (cut < tl.length && (now - tl[cut].time > life || tl.length - cut > max)) cut++;
    if (cut) { for (let i = 0; i < cut; i++) if (TP_POOL.length < 4000) TP_POOL.push(tl[i]); tl.splice(0, cut); }
  }
  // cached sprites (built once per key; soft glows baked in)
  const SPR = new Map();
  function spr(key, size, draw) {
    let c = SPR.get(key); if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); g.translate(size / 2, size / 2); draw(g, size / 2);
    if (SPR.size > 160) SPR.delete(SPR.keys().next().value); SPR.set(key, c); return c;
  }
  const glowSpr = col => spr('glow' + col, 32, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, col); gr.addColorStop(0.25, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2); });
  const softSpr = (key, stops) => spr(key, 48, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); for (const [o, c] of stops) gr.addColorStop(o, c); g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2); });
  const shapeSpr = (key, glow, fn) => { const c = spr(key, 64, g => { g.shadowColor = glow || 'transparent'; g.shadowBlur = glow ? 9 : 0; fn(g); }); c.k = 1.6; return c; }; // shape drawn in a ±20 box (+ glow margin)
  const S = {
    flameO: () => softSpr('flameO', [[0, 'rgba(255,190,60,0.95)'], [0.45, 'rgba(255,100,20,0.6)'], [1, 'rgba(200,20,0,0)']]),
    flameY: () => softSpr('flameY', [[0, 'rgba(255,255,235,1)'], [0.35, 'rgba(255,225,110,0.85)'], [1, 'rgba(255,140,30,0)']]),
    smoke: () => softSpr('smoke', [[0, 'rgba(206,214,232,0.75)'], [0.55, 'rgba(176,186,210,0.4)'], [1, 'rgba(150,160,190,0)']]),
    nebula: c => softSpr('neb' + c, [[0, c], [1, 'rgba(0,0,0,0)']]),
    bubble: () => shapeSpr('bubble', null, g => { g.fillStyle = 'rgba(159,233,255,0.16)'; g.beginPath(); g.arc(0, 0, 18, 0, 6.283); g.fill(); g.lineWidth = 2.6; g.strokeStyle = 'rgba(190,245,255,0.95)'; g.stroke();
      g.strokeStyle = 'rgba(255,170,240,0.5)'; g.lineWidth = 1.6; g.beginPath(); g.arc(0, 0, 15, 0.6, 1.9); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(-7, -7, 4.5, 3, -0.7, 0, 6.283); g.fill(); g.beginPath(); g.arc(-1, -11, 1.6, 0, 6.283); g.fill(); }),
    star: c => shapeSpr('star' + c, c, g => { g.fillStyle = c; g.beginPath(); starPath(g, 0, 0, 18, 0); g.fill(); g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); starPath(g, -2, -3, 7, 0); g.fill(); }),
    spark4: c => shapeSpr('sp4' + c, c, g => { g.fillStyle = c; sparkle(g, 0, 0, 19); g.fillStyle = '#fff'; sparkle(g, 0, 0, 8); }),
    heart: c => shapeSpr('heart' + c, c, g => { g.fillStyle = c; g.beginPath(); heartPath(g, 0, 1, 15); g.fill(); g.shadowBlur = 0; g.lineWidth = 1.6; g.strokeStyle = 'rgba(120,0,50,0.35)'; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.ellipse(-6, -5, 3.6, 2.2, -0.6, 0, 6.283); g.fill(); }),
    flake: () => shapeSpr('flake', '#9fd8ff', g => { g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineWidth = 2.6; g.beginPath();
      for (let a = 0; a < 6; a++) { const c = Math.cos(a * 1.0472), s = Math.sin(a * 1.0472); g.moveTo(0, 0); g.lineTo(c * 17, s * 17); g.moveTo(c * 10, s * 10); g.lineTo(c * 10 + Math.cos(a * 1.0472 + 0.7) * 5, s * 10 + Math.sin(a * 1.0472 + 0.7) * 5); g.moveTo(c * 10, s * 10); g.lineTo(c * 10 + Math.cos(a * 1.0472 - 0.7) * 5, s * 10 + Math.sin(a * 1.0472 - 0.7) * 5); }
      g.stroke(); g.fillStyle = '#e8f6ff'; g.beginPath(); g.arc(0, 0, 3, 0, 6.283); g.fill(); }),
    leaf: c => shapeSpr('leaf' + c, null, g => { g.fillStyle = c; g.beginPath(); g.moveTo(-17, 0); g.quadraticCurveTo(-4, -12, 17, 0); g.quadraticCurveTo(-4, 12, -17, 0); g.fill();
      g.lineWidth = 1.6; g.strokeStyle = 'rgba(0,0,0,0.28)'; g.stroke(); g.beginPath(); g.moveTo(-15, 0); g.lineTo(14, 0); g.moveTo(-3, 0); g.lineTo(3, -5); g.moveTo(3, 0); g.lineTo(8, -4); g.moveTo(-3, 0); g.lineTo(3, 5); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.ellipse(-3, -4, 6, 2, -0.2, 0, 6.283); g.fill(); }),
    pix: c => shapeSpr('pix' + c, null, g => { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-14, -12, 30, 30); g.fillStyle = c; g.fillRect(-16, -16, 30, 30); g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(-16, -16, 30, 7); g.fillRect(-16, -16, 7, 30); }),
    shard: c => shapeSpr('shard' + c, c, g => { g.fillStyle = c; g.beginPath(); g.moveTo(0, -20); g.lineTo(8, -3); g.lineTo(0, 20); g.lineTo(-8, -3); g.closePath(); g.fill(); g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,0.65)'; g.beginPath(); g.moveTo(0, -20); g.lineTo(8, -3); g.lineTo(0, 0); g.closePath(); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, -20); g.lineTo(8, -3); g.lineTo(0, 20); g.lineTo(-8, -3); g.closePath(); g.stroke(); }),
    page: () => shapeSpr('page', null, g => { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(-12, -14, 26, 32); g.fillStyle = '#fdfcf7'; g.fillRect(-14, -16, 26, 32); g.fillStyle = '#ff5a5a'; g.fillRect(-14, -16, 26, 9);
      g.fillStyle = '#fff'; g.fillRect(-9, -18, 3, 6); g.fillRect(3, -18, 3, 6); g.fillStyle = 'rgba(40,50,80,0.6)'; g.fillRect(-9, 0, 16, 2.5); g.fillRect(-9, 6, 11, 2.5);
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1.2; g.strokeRect(-14, -16, 26, 32); }),
    ember: () => softSpr('ember', [[0, 'rgba(255,255,220,1)'], [0.3, 'rgba(255,190,80,0.9)'], [1, 'rgba(255,90,0,0)']]),
  };
  // blit a sprite centred at (x, y) with world size s; optional rotation / non-uniform y-scale (flip)
  function blit(g, img, x, y, s, a, rot, sy) {
    if (a <= 0.01 || s <= 0.2) return; g.globalAlpha = a > 1 ? 1 : a; if (img.k) s *= img.k;
    if (!rot && sy == null) { g.drawImage(img, x - s / 2, y - s / 2, s, s); return; }
    let k = sy == null ? 1 : sy; if (k > -0.08 && k < 0.08) k = k < 0 ? -0.08 : 0.08; // edge-on sheet: keep a sliver
    const c = Math.cos(rot || 0), sn = Math.sin(rot || 0), A = c, B = sn, Cc = -sn * k, D = c * k, det = A * D - B * Cc;
    g.transform(A, B, Cc, D, x, y); g.drawImage(img, -s / 2, -s / 2, s, s);
    g.transform(D / det, -B / det, -Cc / det, A / det, (Cc * y - D * x) / det, (B * x - A * y) / det);
  }
  function glowPath(g, pts, n, color, width, alpha, step) { // tapered soft stroke in 4 alpha bands (4 draw calls)
    g.strokeStyle = color; step = step || 1;
    for (let c = 0; c < 4; c++) {
      const a = Math.floor(c * (n - 1) / 4), b = Math.floor((c + 1) * (n - 1) / 4); if (b <= a) continue;
      g.globalAlpha = alpha * (c + 1) / 4; g.lineWidth = width * (0.45 + 0.55 * (c + 1) / 4);
      g.beginPath(); g.moveTo(pts[a].x, pts[a].y); for (let i = a + step; i < b; i += step) g.lineTo(pts[i].x, pts[i].y); g.lineTo(pts[b].x, pts[b].y); g.stroke();
    }
  }
  function sparkle(g, x, y, s) { g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.25, y - s * 0.25); g.lineTo(x + s, y); g.lineTo(x + s * 0.25, y + s * 0.25); g.lineTo(x, y + s); g.lineTo(x - s * 0.25, y + s * 0.25); g.lineTo(x - s, y); g.lineTo(x - s * 0.25, y - s * 0.25); g.closePath(); g.fill(); }
  function trailFx(g, pl, pts, n, t, now, kind, tier, lod, under) {
    const th = TRAIL_THEME[kind] || ['#ffffff', '#ffffff'];
    const c1 = th[0] === 'player' ? colorOf(pl.eq, t) : th[0] === 'rainbow' ? `hsl(${Math.floor(t * 140) % 360},100%,62%)` : th[0], c2 = th[1];
    const life = TRAIL_LIFE[tier], st = n > 30 ? 2 : 1;
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (under) { // glow below the base trail
      if (tier === 0) { glowPath(g, pts, n, c1, 6, 0.12, st); return; }
      g.globalCompositeOperation = 'lighter';
      const pulse = tier >= 3 ? 0.78 + 0.22 * Math.sin(t * 6 + (pl.id ? pl.id.length : 0)) : 1;
      if (tier === 1) glowPath(g, pts, n, c1, 12, 0.2, st);
      else if (tier === 2) { glowPath(g, pts, n, c1, 22, 0.12, st); glowPath(g, pts, n, c2, 9, 0.12 + 0.14 * (0.5 + 0.5 * Math.sin(t * 3)), st); } // shimmer: colour shifts c1 ↔ c2
      else { glowPath(g, pts, n, c1, 34 * pulse, 0.11, st); glowPath(g, pts, n, c2, 15 * pulse, 0.18, st); if (lod) glowPath(g, pts, n, '#ffffff', 4, 0.3, st); }
      return;
    }
    if (tier === 0 || lod === 0) return;
    g.globalCompositeOperation = 'lighter';
    let budget = lod === 2 ? FX_CAP[tier] : FX_CAP[tier] >> 1;
    if (trailLive) { budget = Math.min(budget, trailBudget); trailBudget -= budget; }
    const sp = S.spark4(tier === 1 ? c2 : '#ffffff'), sStep = (tier === 1 ? 5 : 4) * st;
    for (let i = n - 1; i >= 0 && budget > 0; i -= sStep) { // twinkling 4-point sparkles near the path
      const p = pts[i], k = 1 - (now - p.time) / life; if (k <= 0) break;
      const tw = 0.5 + 0.5 * Math.sin(t * 9 + p.seed * 20);
      blit(g, sp, p.x + (p.seed - 0.5) * 24, p.y + (hash(p.seed, 5) - 0.5) * 24, (4 + tw * (tier >= 3 ? 9 : 6)) * (0.6 + 0.4 * k), k * (0.35 + 0.65 * tw)); budget--;
    }
    if (tier >= 2) { // drifting glow motes that fly off the path
      const ga = glowSpr(c2 === '#ffffff' ? '#ffffff' : c2), gb = th[0] === 'player' || th[0] === 'rainbow' ? ga : glowSpr(c1);
      for (let i = n - 1; i >= 0 && budget > 0; i -= 3 * st) {
        const p = pts[i], k = 1 - (now - p.time) / life; if (k <= 0) break;
        const a = p.seed * 6.283 + t * 1.5, d = (1 - k) * (tier >= 3 ? 30 : 20) + 3;
        blit(g, i & 2 ? gb : ga, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 5 + k * 6, k * 0.85); budget--;
      }
    }
    if (tier >= 3 && lod === 2) { // swirl: two strands spiralling around the tail
      g.fillStyle = c2;
      for (let i = st; i < n && budget > 1; i += 2 * st) {
        const p = pts[i], q = pts[i - 1], dx = p.x - q.x, dy = p.y - q.y, l = Math.hypot(dx, dy) || 1, f = i / n;
        const off = Math.sin(i * 0.6 / st - t * 9) * (6 + 8 * f), r = 1.2 + 1.6 * f;
        g.globalAlpha = 0.25 + 0.7 * f; g.fillStyle = c2; g.fillRect(p.x - dy / l * off - r, p.y + dx / l * off - r, r * 2, r * 2);
        g.fillStyle = c1; g.fillRect(p.x + dy / l * off - r, p.y - dx / l * off - r, r * 2, r * 2);
        budget -= 2;
      }
    }
    if (tier >= 3) { // bursts from the head every 0.9 s
      const h = pts[n - 1], u = (now % 900) / 900, rot = Math.floor(now / 900) * 0.7, m = lod === 2 ? 8 : 4, gs = glowSpr(th[0] === 'player' || th[0] === 'rainbow' ? '#ffffff' : c1);
      for (let j = 0; j < m; j++) { const a = rot + j * 6.283 / m, r = 8 + u * 34; blit(g, gs, h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, 4 + 8 * (1 - u), (1 - u) * 0.9); }
    }
    if (tier === 4) { // shard-shop exclusives: unique signature effects
      const h = pts[n - 1], pu = 0.8 + 0.2 * Math.sin(t * 8);
      if (kind === 'comet') { // blazing coma at the head
        blit(g, S.flameO(), h.x, h.y, 64 * pu, 0.5); blit(g, S.flameY(), h.x, h.y, 34 * pu, 0.85);
      } else if (kind === 'crystal') { // spinning prism halo
        g.lineWidth = 2;
        for (let r = 0; r < 2; r++) {
          const rad = (r ? 24 : 15) * pu, rotH = t * (r ? -1.6 : 2.4);
          g.strokeStyle = r ? '#ffb8f0' : '#9de8ff'; g.globalAlpha = r ? 0.45 : 0.7; g.beginPath();
          for (let j = 0; j <= 6; j++) { const a = rotH + j * 1.0472; j ? g.lineTo(h.x + Math.cos(a) * rad, h.y + Math.sin(a) * rad) : g.moveTo(h.x + Math.cos(a) * rad, h.y + Math.sin(a) * rad); }
          g.stroke();
        }
      } else { const s4 = S.spark4('#ffffff'); for (let j = 0; j < 6; j++) { const a = t * 3 + j * 1.047; blit(g, s4, h.x + Math.cos(a) * 20, h.y + Math.sin(a) * 20, 9, 0.6); } }
    }
  }
  function drawTrail(g, pl, t, now) {
    const kind = itemVal(pl.eq.trail) || 'none';
    if (kind === 'none' || pl.trail.length < 2) return;
    const pts = pl.trail, n = pts.length, tier = trailTier(pl.eq.trail), lod = g === ctx ? fxLod : 2;
    trailLive = g === ctx;
    let cap = BASE_CAP[lod]; if (trailLive) { cap = Math.min(cap, Math.max(4, trailBudget)); trailBudget -= cap; }
    g.save();
    trailFx(g, pl, pts, n, t, now, kind, tier, lod, true);
    g.restore(); g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (TRAILS[kind]) TRAILS[kind](g, pts, n, t, now, pl, cap, Math.max(1, Math.ceil(n / cap)), lod);
    g.restore(); g.save();
    trailFx(g, pl, pts, n, t, now, kind, tier, lod, false);
    g.restore();
  }
  // Base renderers: (g, pts, n, t, now, pl, cap, stride, lod). Particles = every `stride`-th point newest→oldest, max `cap`.
  // Everything is deterministic from the point's own seed/age (no Math.random while drawing).
  const ageK = (p, now, life = 650) => 1 - (now - p.time) / life;
  const hash = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const ease = k => k * k * (3 - 2 * k);
  function heartPath(g, x, y, s) {
    g.moveTo(x, y + s * 0.9); g.bezierCurveTo(x - s * 1.4, y, x - s * 0.8, y - s * 1.1, x, y - s * 0.35);
    g.bezierCurveTo(x + s * 0.8, y - s * 1.1, x + s * 1.4, y, x, y + s * 0.9);
  }
  function starPath(g, x, y, ro, rot) {
    for (let i = 0; i < 10; i++) { const a = rot - Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ro * 0.45 : ro; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.closePath();
  }
  function taper(g, pts, n, w0, w1, wob, t, st) { // filled tapered ribbon (tail → head), one path
    g.beginPath(); st = st || 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < n; j += st) {
        const i = pass ? n - 1 - j : j, p = pts[i], q = pts[Math.max(0, i - 1)], r = pts[Math.min(n - 1, i + 1)];
        let dx = r.x - q.x, dy = r.y - q.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const f = i / (n - 1), w = (w0 + (w1 - w0) * f * f) * (1 + (wob ? Math.sin(t * 11 + i * 0.7) * wob * (1 - f) : 0)), s = pass ? -1 : 1;
        const x = p.x - dy * w * s, y = p.y + dx * w * s; (j || pass) ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      if (!pass) { const p = pts[n - 1]; g.lineTo(p.x, p.y); }
    }
    g.closePath(); g.fill();
  }
  const each = (pts, n, cap, stride, fn) => { let c = 0; for (let i = n - 1; i >= 0 && c < cap; i -= stride, c++) fn(pts[i], i); };
  const TRAILS = {
    smoke(g, pts, n, t, now, pl, cap, st) { // soft puffs that swell, rise and dissolve
      const img = S.smoke();
      each(pts, n, cap, st, p => { const k = ageK(p, now); if (k <= 0) return; const f = 1 - k;
        blit(g, img, p.x + (p.seed - 0.5) * 8 + Math.sin(p.seed * 9 + f * 3) * 4, p.y - f * 14, 12 + f * 30 * (0.7 + p.seed * 0.6), 0.55 * ease(k)); });
    },
    bubbles(g, pts, n, t, now, pl, cap, st) { // wobbling bubbles float up and pop
      const img = S.bubble();
      each(pts, n, cap, Math.max(2, st), p => { const k = ageK(p, now, 700); if (k <= 0) return; const f = 1 - k, pop = k < 0.12 ? 1 + (0.12 - k) * 6 : 1;
        blit(g, img, p.x + Math.sin(p.seed * 6.28 + f * 6) * 7, p.y - f * 22, (6 + p.seed * 10) * (0.6 + 0.4 * Math.min(1, f * 4)) * pop, k < 0.12 ? k * 8 : 0.95); });
    },
    sparks(g, pts, n, t, now, pl, cap, st) { // player-coloured sparks shoot out as short streaks with a hot core
      g.globalCompositeOperation = 'lighter'; const col = colorOf(pl.eq, t), gw = glowSpr('#ffffff');
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath();
      each(pts, n, cap >> 1, st, (p, i) => { const k = ageK(p, now, 700); if (k <= 0) return; for (let j = 0; j < 2; j++) { const a = p.seed * 6.28 + j * 3.1 + i * 0.3, d = (1 - k) * 26 + 4, x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d + (1 - k) * (1 - k) * 10, L = 3 + k * 5;
        g.moveTo(x, y); g.lineTo(x - Math.cos(a) * L, y - Math.sin(a) * L); } });
      g.globalAlpha = 0.9; g.stroke();
      each(pts, n, cap >> 1, st, (p, i) => { const k = ageK(p, now, 700); if (k <= 0) return; const a = p.seed * 6.28 + i * 0.3, d = (1 - k) * 26 + 4;
        blit(g, gw, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d + (1 - k) * (1 - k) * 10, 5 + k * 7, k); });
    },
    pixel(g, pts, n, t, now, pl, cap, st) { // retro blocks snap to a grid, drop in steps and blink out
      const pal = ['#ff4d6d', '#ffd34d', '#3ee0ff', '#9dff4f'];
      each(pts, n, cap, st, p => { const k = ageK(p, now); if (k <= 0) return; const f = 1 - k;
        const sz = 4 * Math.max(1, Math.round((1 + p.seed * 2) * (0.5 + k))), x = Math.round((p.x + (p.seed - 0.5) * 18) / 4) * 4, y = Math.round((p.y + (hash(p.seed, 1) - 0.5) * 18 + Math.floor(f * 4) * 4) / 4) * 4;
        if (k < 0.3 && Math.floor(now / 70 + p.seed * 7) % 2) return; // blink out
        blit(g, S.pix(pal[Math.floor(p.seed * 4) % 4]), x, y, sz * 1.1, 1); });
    },
    leaves(g, pts, n, t, now, pl, cap, st) { // tumbling leaves (flip + spin) drift down and sway
      const pal = ['#7ed957', '#ffb347', '#e8743b', '#c9e25a'];
      each(pts, n, cap, Math.max(2, st), p => { const k = ageK(p, now, 700); if (k <= 0) return; const f = 1 - k;
        blit(g, S.leaf(pal[Math.floor(p.seed * 4) % 4]), p.x + Math.sin(p.seed * 9 + f * 5) * 10, p.y + f * 18, 12 + p.seed * 6, Math.min(1, k * 2), p.seed * 6.28 + f * 4 * (p.seed > 0.5 ? 1 : -1), Math.cos(p.seed * 11 + f * 9)); });
    },
    snow(g, pts, n, t, now, pl, cap, st) { // glowing flakes of varied size slowly spin and float down
      const img = S.flake();
      each(pts, n, cap, Math.max(2, st), p => { const k = ageK(p, now, 800); if (k <= 0) return; const f = 1 - k;
        blit(g, img, p.x + Math.sin(p.seed * 6.28 + f * 4) * 8, p.y + f * 14, (6 + p.seed * 8) * (0.7 + 0.3 * k), Math.min(1, k * 1.6), p.seed * 3 + f * 1.5 * (p.seed - 0.5)); });
    },
    neon(g, pts, n, t, now, pl, cap, st) { // glowing tube in the player colour with a white-hot core (no shadowBlur)
      const color = colorOf(pl.eq, t), s2 = n > 30 ? 2 : 1; g.globalCompositeOperation = 'lighter';
      glowPath(g, pts, n, color, 26, 0.16, s2); glowPath(g, pts, n, color, 13, 0.5, s2); glowPath(g, pts, n, '#ffffff', 4, 0.9, s2);
      const h = pts[n - 1]; blit(g, glowSpr(color), h.x, h.y, 26 + 4 * Math.sin(t * 8), 0.7);
    },
    hearts(g, pts, n, t, now, pl, cap, st) { // beating hearts float up and sway, two shades
      each(pts, n, cap, Math.max(2, st), p => { const k = ageK(p, now, 750); if (k <= 0) return; const f = 1 - k, beat = 1 + 0.15 * Math.max(0, Math.sin(t * 9 + p.seed * 6));
        blit(g, S.heart(p.seed < 0.5 ? '#ff5fa2' : '#ff8fc2'), p.x + (p.seed - 0.5) * 12 + Math.sin(f * 5 + p.seed * 9) * 5, p.y - f * 22, (8 + p.seed * 7) * beat * (0.5 + 0.5 * Math.min(1, f * 5)), Math.min(1, k * 1.8), (p.seed - 0.5) * 0.6 + Math.sin(f * 6) * 0.25); });
    },
    stars(g, pts, n, t, now, pl, cap, st) { // spinning golden stars that twinkle, plus a fine glitter dust
      g.globalCompositeOperation = 'lighter'; const dust = glowSpr('#fff6c2');
      each(pts, n, cap, Math.max(2, st), (p, i) => { const k = ageK(p, now, 800); if (k <= 0) return; const tw = 0.6 + 0.4 * Math.sin(t * 10 + p.seed * 30), big = p.seed > 0.85 ? 1.6 : 1;
        blit(g, S.star(p.seed < 0.6 ? '#ffe066' : '#fff6c2'), p.x + (p.seed - 0.5) * 14, p.y + (hash(p.seed, 1) - 0.5) * 14 + (1 - k) * 6, (9 + k * 7) * tw * big, k, p.seed * 6 + t * 2.5 * (p.seed > 0.5 ? 1 : -1));
        if (i & 1) blit(g, dust, p.x + (hash(p.seed, 7) - 0.5) * 26, p.y + (hash(p.seed, 8) - 0.5) * 26, 4, k * tw); });
    },
    lightning(g, pts, n, t, now, pl, cap, st) { // jagged bolt that re-forks ~14×/s, with branches and bright nodes
      const q = Math.floor(now / 70), s2 = n > 30 ? 2 : 1; g.globalCompositeOperation = 'lighter';
      const path = () => { g.beginPath(); for (let i = 0; i < n; i += s2) { const p = pts[i], prev = pts[Math.max(0, i - s2)], dx = p.x - prev.x, dy = p.y - prev.y, l = Math.hypot(dx, dy) || 1, off = (hash(i, q) - 0.5) * 16 * (i / n); const x = p.x - dy / l * off, y = p.y + dx / l * off; i ? g.lineTo(x, y) : g.moveTo(x, y); } };
      g.globalAlpha = 0.22; g.strokeStyle = '#7cc8ff'; g.lineWidth = 12; path(); g.stroke();
      g.globalAlpha = 0.55; g.lineWidth = 5; path(); g.stroke();
      g.globalAlpha = 1; g.strokeStyle = '#eaffff'; g.lineWidth = 2; path(); g.stroke();
      g.beginPath(); g.lineWidth = 1.4; g.strokeStyle = '#bfe6ff'; g.globalAlpha = 0.85;
      for (let b = 0; b < 3; b++) { const i = Math.floor(hash(b, q) * (n - 2)) + 1, p = pts[i], a = hash(b + 5, q) * 6.283, L = 8 + hash(b + 9, q) * 14 * (i / n);
        g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(a) * L * 0.6 + 3, p.y + Math.sin(a) * L * 0.6 - 3); g.lineTo(p.x + Math.cos(a) * L, p.y + Math.sin(a) * L); }
      g.stroke();
      const gl = glowSpr('#bfe6ff'); blit(g, gl, pts[n - 1].x, pts[n - 1].y, 22 + 8 * hash(q, 3), 0.9);
    },
    fire(g, pts, n, t, now, pl, cap, st) { // flickering flame tongues (hot core + orange body) and rising embers
      g.globalCompositeOperation = 'lighter'; const o = S.flameO(), y = S.flameY(), em = S.ember();
      each(pts, n, cap, st, (p, i) => { const k = ageK(p, now, 700); if (k <= 0) return; const f = 1 - k, fl = 0.8 + 0.3 * Math.sin(t * 22 + p.seed * 40), x = p.x + Math.sin(p.seed * 9 + t * 7) * 3 * f, yy = p.y - f * 16;
        blit(g, o, x, yy, (10 + k * 22) * fl, k * 0.9); if (k > 0.35) blit(g, y, x, yy + 2, (6 + k * 12) * fl, k);
        if (i % 3 === 0) { const ef = (f * 1.4) % 1; blit(g, em, p.x + (hash(p.seed, 3) - 0.5) * 20 + Math.sin(t * 9 + p.seed * 20) * 3, p.y - ef * 34, 3 + 3 * (1 - ef), (1 - ef) * 0.95); } });
    },
    rainbow(g, pts, n, t, now, pl, cap, st) { // six-band ribbon that waves and flows, sparkly edges
      const s2 = n > 30 ? 2 : 1, h0 = t * 120;
      for (let b = 0; b < 6; b++) {
        g.strokeStyle = `hsl(${(h0 + b * 50) % 360},100%,${62 + (b === 0 ? 8 : 0)}%)`; g.lineWidth = 3.2; g.beginPath();
        for (let i = 0; i < n; i += s2) { const p = pts[i], q = pts[Math.max(0, i - 1)], r = pts[Math.min(n - 1, i + 1)]; let dx = r.x - q.x, dy = r.y - q.y; const l = Math.hypot(dx, dy) || 1, f = i / (n - 1);
          const off = (b - 2.5) * 2.6 * (0.35 + 0.65 * f) + Math.sin(t * 6 - i * 0.25) * 3 * (1 - f); const x = p.x - dy / l * off, y = p.y + dx / l * off; i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.globalAlpha = 0.85; g.stroke();
      }
    },
    galaxy(g, pts, n, t, now, pl, cap, st) { // swirling cosmic dust in a faint nebula, with twinkling stars
      const pal = ['#8a3cff', '#ff4fd8', '#3ee0ff', '#ffffff']; g.globalCompositeOperation = 'lighter';
      each(pts, n, cap >> 2, st * 4, p => { const k = ageK(p, now, 1000); if (k <= 0) return; blit(g, S.nebula(p.seed < 0.5 ? 'rgba(138,60,255,0.5)' : 'rgba(255,79,216,0.4)'), p.x, p.y, 30 + (1 - k) * 20, k * 0.45); });
      each(pts, n, cap, st, (p, i) => { const k = ageK(p, now, 1000); if (k <= 0) return; const sd = p.seed, d = (1 - k) * 22 + 3, a = sd * 20 + (1 - k) * 3;
        blit(g, glowSpr(pal[Math.floor(sd * 4) % 4]), p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 4 + k * 6, k * (0.6 + 0.4 * Math.sin(t * 6 + sd * 9)));
        if (i % 6 === 0) blit(g, S.spark4('#ffffff'), p.x, p.y, (4 + k * 7) * (0.6 + 0.4 * Math.sin(t * 8 + sd * 20)), k); });
    },
    comet(g, pts, n, t, now, pl, cap, st) { // exclusive: tapered fiery tail (red → orange → white-hot core), blue ion streak, debris
      const s2 = n > 30 ? 2 : 1;
      g.globalAlpha = 0.45; g.fillStyle = '#ff5a3a'; taper(g, pts, n, 1, 14, 0.25, t, s2);
      g.globalAlpha = 0.7; g.fillStyle = '#ffb347'; taper(g, pts, n, 0.5, 9, 0.2, t, s2);
      g.globalAlpha = 0.95; g.fillStyle = '#fff3c4'; taper(g, pts, n, 0, 4, 0, t, s2);
      g.globalCompositeOperation = 'lighter'; g.strokeStyle = '#7cd8ff'; g.lineWidth = 1.6; g.globalAlpha = 0.5; g.beginPath();
      for (let i = 0; i < n; i += s2) { const p = pts[i], f = 1 - i / n, w = 10 * f + Math.sin(t * 5 + i * 0.4) * 3 * f; i ? g.lineTo(p.x + w * 0.7, p.y - w) : g.moveTo(p.x + w * 0.7, p.y - w); }
      g.stroke(); const em = S.ember();
      each(pts, n, cap >> 1, st * 2, p => { const k = ageK(p, now, 900); if (k <= 0) return; blit(g, em, p.x + (p.seed - 0.5) * 22, p.y + (hash(p.seed, 2) - 0.5) * 22, 3 + k * 4, k); });
    },
    crystal(g, pts, n, t, now, pl, cap, st) { // exclusive: spinning prismatic shards with glints
      const pal = ['#9de8ff', '#ffffff', '#c7a6ff', '#ffb8f0'];
      each(pts, n, cap, Math.max(2, st), (p, i) => { const k = ageK(p, now, 900); if (k <= 0) return;
        blit(g, S.shard(pal[Math.floor(p.seed * 4) % 4]), p.x + (p.seed - 0.5) * 14, p.y + (hash(p.seed, 3) - 0.5) * 14 + (1 - k) * 8, (7 + k * 9) * (0.7 + p.seed * 0.5), Math.min(1, k * 1.5), p.seed * 6.28 + t * 3 * (p.seed > 0.5 ? 1 : -1));
        if (i % 3 === 0) { g.globalCompositeOperation = 'lighter'; blit(g, S.spark4('#e9fbff'), p.x + (hash(p.seed, 4) - 0.5) * 24, p.y + (hash(p.seed, 6) - 0.5) * 24, 8 * Math.max(0, Math.sin(t * 7 + p.seed * 25)), k); g.globalCompositeOperation = 'source-over'; } });
    },
    pages(g, pts, n, t, now, pl, cap, st) { // daily calendar: sheets with a red header flutter, flip and spin as they fall
      const img = S.page();
      each(pts, n, cap >> 1, Math.max(3, st * 2), p => { const k = ageK(p, now, 1000); if (k <= 0) return; const f = 1 - k, sw = Math.sin(p.seed * 11 + f * 5);
        blit(g, img, p.x + sw * 11 + (p.seed - 0.5) * 10, p.y + f * f * 30 + f * 6, 11 + p.seed * 4, Math.min(1, k * 1.6), (p.seed - 0.5) * 1.2 + sw * 0.7 + f * 2 * (p.seed - 0.5), Math.cos(p.seed * 7 + f * 7)); });
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
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over'; ctx.setLineDash([]); // a throw mid-frame can't leak state into the next frame
    VW = W; VH = H;
    if (!joined) { drawIdleBackground(t); drawPreviews(t, now); return; }

    const a = Math.min(1, (now - lastStepAt) / G.TICK_MS);
    corr.x *= 0.86; corr.y *= 0.86;
    dispMe.x = prevMe.x + (me.x - prevMe.x) * a + corr.x;
    dispMe.y = prevMe.y + (me.y - prevMe.y) * a + corr.y;
    VW = W / zoom; VH = H / zoom; // culling + camera work in world units of the zoomed viewport
    cam.x = dispMe.x - VW / 2; cam.y = dispMe.y - VH / 2;

    const pos = interpPositions(now);
    pos.set(myId, { x: dispMe.x, y: dispMe.y });
    for (const pl of players.values()) {
      const p = pos.get(pl.id);
      if (!p) continue;
      const dx = p.x - pl.last.x, dy = p.y - pl.last.y, dd = Math.hypot(dx, dy);
      if (pl.id === myId) pl.dir = myDir;
      else if (dd > 0.5) pl.dir = { x: dx / dd, y: dy / dd };
      trailStep(pl, p, now);
      pl.pos = p;
    }

    ctx.setTransform(DPR * zoom, 0, 0, DPR * zoom, 0, 0);
    drawBackground(t);
    ctx.save(); ctx.translate(-cam.x, -cam.y);
    drawZones(t);
    // world border
    MA.drawBorder(ctx, t);

    drawBonusRoom(t);
    drawEventZone(t, now);
    drawMiniWorld(t, now);
    drawObstacles(t, now);
    drawShots(now);
    // orbs
    const pad = 60;
    for (const [id, o] of orbs) {
      if (o.x < cam.x - pad || o.x > cam.x + VW + pad || o.y < cam.y - pad - (o.fall ? 320 : 0) || o.y > cam.y + VH + pad) continue;
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
    drawRunner(t, now); checkRunnerTouch(now);
    drawBoss(t, now);
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
    // trail quality: FPS (EMA), how many trails are on screen, phone → fxLod 2 / 1 / 0; off-screen trails are skipped
    const fdt = lastFrameAt ? now - lastFrameAt : 16.7; lastFrameAt = now;
    if (fdt > 0 && fdt < 500) fpsEma = fpsEma * 0.95 + (1000 / fdt) * 0.05;
    let onScreen = 0;
    for (const pl of players.values()) {
      const h = pl.trail.length ? pl.trail[pl.trail.length - 1] : null;
      pl.trailVis = !!h && h.x > cam.x - 260 && h.x < cam.x + VW + 260 && h.y > cam.y - 260 && h.y < cam.y + VH + 260;
      if (pl.trailVis && (itemVal(pl.eq.trail) || 'none') !== 'none') onScreen++;
    }
    fxLod = onScreen > 22 || fpsEma < 30 ? 0 : onScreen > 10 || fpsEma < 45 || mobileUI() ? 1 : 2;
    trailFrame(fxLod);
    drawFunUnder(ctx, t);
    drawPotions(ctx, t);
    for (const pl of players.values()) if (pl.trailVis && (pl.id === myId || !lastSnapIds || lastSnapIds.has(pl.id))) drawTrail(ctx, pl, t, now);
    const order = Array.from(players.values()).sort((p, q) => (p.id === myId) - (q.id === myId));
    for (const pl of order) {
      if (!pl.pos) continue;
      if (pl.pos.x < cam.x - 120 || pl.pos.x > cam.x + VW + 120 || pl.pos.y < cam.y - 120 || pl.pos.y > cam.y + VH + 120) continue;
      if (pl.id !== myId && lastSnapIds && !lastSnapIds.has(pl.id)) continue; // invisible (admin) or not in the latest update
      const ghost = pl.id === myId && selfFx.invis; if (ghost) ctx.globalAlpha = 0.4;
      drawAvatar(ctx, pl.pos.x, pl.pos.y, G.PLAYER_R * (pl.sz || 1), pl.eq, t, { name: pl.name, dir: pl.dir, isMe: pl.id === myId, phase: pl.id });
      if (ghost) ctx.globalAlpha = 1;
    }
    drawFunOver(ctx, t);
    drawEmotes(ctx);
    // floating texts
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i], k = (now - f.start) / 900;
      if (k >= 1) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - k; ctx.fillStyle = f.color; ctx.font = `800 ${f.big ? 22 : 15}px Segoe UI, sans-serif`; ctx.textAlign = 'center';
      ctx.shadowColor = f.color; ctx.shadowBlur = 10;
      ctx.fillText(f.text, f.x, f.y - k * 40); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // screen-space overlays (compass arrows) are not zoomed
    if (now - zapFlash < 450) { const k = 1 - (now - zapFlash) / 450, g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,30,0)'); g.addColorStop(1, `rgba(255,20,40,${0.55 * k})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    if (evState && evState.kind === 'lucky' && evState.phase === 'active') { // «Волна удачи»: soft green glow at the screen edges
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(80,255,140,0)'); g.addColorStop(1, `rgba(80,255,140,${0.16 + 0.06 * Math.sin(t * 3)})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    drawCompass(t, now);
    drawJoystick(t);
    if (frameNo % 2 === 0) drawMinimap(now);
    drawPreviews(t, now);
    if (rushActive) drawRush(now);
    if (mg2) drawMg2(now);
  }

  // «Чутьё легенды» compass: arrows at the screen edge to the rarest orbs (and, at level 3, to event targets).
  // Client-side only: every position it uses is already public (orb list, minimap, event broadcast).
  const COMPASS_COLORS = { l: '#ffcc33', m: '#ff3d6e', e: '#ff9a2e', event: '#7dffb0' };
  function drawCompass(t, now) {
    if (!profile || !profile.upgrades.sense) return;
    const evc = evState ? { zone: evState.zone, runners: Array.from(runners.values(), r => ({ x: runnerX(r, now), y: runnerY(r, now) })) } : null;
    const list = G.compassTargets(profile.upgrades.sense, Array.from(orbs.values()), dispMe, evc);
    for (const tg of list) drawArrow(tg, t);
  }
  function drawArrow(tg, t) {
    const sx = (tg.x - cam.x) * zoom, sy = (tg.y - cam.y) * zoom;
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
  function drawBackground(t) { // natural zone-themed ground from cached chunks (public/map-art.js), no grid
    MA.drawGround(ctx, cam, VW, VH, zoom, DPR, t); MA.drawVignette(ctx, VW, VH);
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
        pls: Array.from(players.values()).filter(p => p.pos && p.id !== myId && (!lastSnapIds || lastSnapIds.has(p.id)) && Math.hypot(p.pos.x - dispMe.x, p.pos.y - dispMe.y) <= R.range).map(p => ({ x: p.pos.x, y: p.pos.y, d: Math.hypot(p.pos.x - dispMe.x, p.pos.y - dispMe.y), col: colorOf(p.eq, 0) })) };
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
    { const [wx] = px(G.ZONE_W, 0); mctx.strokeStyle = doorOpen() ? 'rgba(93,255,143,0.8)' : 'rgba(255,204,51,0.8)'; mctx.lineWidth = 2.5; mctx.beginPath(); mctx.moveTo(wx, ey0); mctx.lineTo(wx, ey1); mctx.stroke(); mctx.lineWidth = 1; } // wall-door
    if (evState && evState.zone) { // «Царь горы» zone is public and may be shown
      const z = evState.zone, [zx, zy] = px(z.x, z.y);
      mctx.fillStyle = evState.phase === 'active' ? 'rgba(255,204,51,0.25)' : 'rgba(255,204,51,0.1)'; mctx.strokeStyle = 'rgba(255,204,51,0.8)';
      mctx.beginPath(); mctx.arc(zx, zy, Math.max(4, z.r * k), 0, Math.PI * 2); mctx.fill(); mctx.stroke();
    }
    if (miniState) { const [mx, my] = px(miniState.x, miniState.y); mctx.fillStyle = '#ffd24a'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.beginPath(); mctx.arc(Math.max(6, Math.min(S - 6, mx)), Math.max(6, Math.min(S - 6, my)), 4.5 + Math.sin(now / 150), 0, Math.PI * 2); mctx.fill(); mctx.stroke(); }
    if (bossState) { const b = bossPos(now), [bx, by] = px(b.x, b.y); mctx.fillStyle = '#ff3355'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.beginPath(); mctx.arc(Math.max(7, Math.min(S - 7, bx)), Math.max(7, Math.min(S - 7, by)), 6, 0, Math.PI * 2); mctx.fill(); mctx.stroke(); }
    for (const o of obstacles) { // obstacles + lasers are always shown (they are public map features)
      const [ox, oy] = px(o.x, o.y);
      if (o.k === 'robot') { mctx.fillStyle = '#c3cad6'; mctx.strokeStyle = '#ff4040'; mctx.lineWidth = 1.5; mctx.fillRect(ox - 3.5, oy - 3.5, 7, 7); mctx.strokeRect(ox - 3.5, oy - 3.5, 7, 7); continue; }
      if (o.k === 'laser') { const armed = now >= o.armAt; mctx.strokeStyle = armed ? 'rgba(255,60,70,0.9)' : `rgba(255,90,90,${0.4 + 0.4 * Math.sin(now / 90)})`; mctx.lineWidth = 1.5;
        mctx.beginPath(); mctx.arc(ox, oy, Math.max(3, o.len * k), 0, Math.PI * 2); mctx.stroke(); mctx.fillStyle = '#ff3b4e'; mctx.beginPath(); mctx.arc(ox, oy, 2.5, 0, Math.PI * 2); mctx.fill(); }
      else if (o.k === 'rect') { mctx.fillStyle = 'rgba(170,180,230,0.75)'; mctx.fillRect(ox - Math.max(1.5, o.w * k / 2), oy - Math.max(1.5, o.h * k / 2), Math.max(3, o.w * k), Math.max(3, o.h * k)); }
      else { mctx.fillStyle = 'rgba(170,180,230,0.75)'; mctx.beginPath(); mctx.arc(ox, oy, Math.max(2, o.r * k), 0, Math.PI * 2); mctx.fill(); }
    }
    mctx.fillStyle = '#ff9a2e'; for (const b of shotsNow) { const [bx, by] = px(b.x, b.y); mctx.beginPath(); mctx.arc(bx, by, 1.8, 0, Math.PI * 2); mctx.fill(); }
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
  let evState = null, kothInfo = null, evResultTimer = null;
  const runners = new Map(); // «Раннеры»: id -> {x,y,px,py,at}
  const EV_UNITS = { rain: 'сфер', koth: 'очк.', treasure: 'сокр.', runner: 'шт.', lucky: 'сфер' };
  function syncRunners(list, now) {
    const seen = new Set();
    for (const [id, x, y] of list) {
      seen.add(id); const r = runners.get(id);
      if (!r) runners.set(id, { x, y, px: x, py: y, at: now });
      else { r.px = runnerX(r, now); r.py = runnerY(r, now); r.x = x; r.y = y; r.at = now; }
    }
    for (const id of Array.from(runners.keys())) if (!seen.has(id)) runners.delete(id);
  }
  function nearestRunner(now) { let b = null, bd = Infinity; for (const r of runners.values()) { const d = Math.hypot(runnerX(r, now) - dispMe.x, runnerY(r, now) - dispMe.y); if (d < bd) { bd = d; b = r; } } return b ? { r: b, d: bd } : null; }
  function setEvent(d) {
    if (!d) { evState = null; kothInfo = null; updateEventUi(); return; }
    const now = performance.now();
    evState = { kind: d.kind, phase: d.phase, startAt: now + (d.in || 0), endAt: now + (d.left || 0), dur: d.dur, zone: d.zone || null, remaining: d.remaining, total: d.total, annTotal: Math.max(1000, d.in || 0) };
    if (d.runners) { evState.remaining = d.runners.length; if (!runners.size) syncRunners(d.runners, now); }
    if (d.phase === 'announce') kothInfo = null;
    updateEventUi();
  }
  const runnerK = (r, now) => Math.min(1, (now - r.at) / G.TICK_MS);
  const runnerX = (r, now) => r.px + (r.x - r.px) * runnerK(r, now);
  const runnerY = (r, now) => r.py + (r.y - r.py) * runnerK(r, now);
  function rewardText(r) {
    if (!r) return '';
    const parts = []; if (r.orbs) parts.push('+' + orbsH(r.orbs)); if (r.shards) parts.push('+' + shardsH(r.shards));
    return parts.join(' ');
  }
  function updateEventUi() {
    const ban = $('evBanner'), hud = $('evHud');
    const now = performance.now(), e = evState, def = e && G.EVENTS[e.kind];
    document.body.classList.toggle('ev-on', !!e);
    if (e && mobileUI()) { const b = Math.max($('hud').querySelector('.stats').getBoundingClientRect().bottom, $('hud').querySelector('.top').getBoundingClientRect().bottom); $('hud').style.setProperty('--ev-top', Math.round(b + 8) + 'px'); }
    updateEventChip(now, e, def);
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
    else if (e.kind === 'runner') { const nr = nearestRunner(now); info = nr ? `Осталось ${runners.size} из ${e.total || G.EVENTS.runner.count} Раннеров · ближайший в ${Math.round(nr.d / 10)} м` : 'Раннеры где-то на карте…'; }
    else if (e.kind === 'lucky') info = '🍀 Сфер на карте ×1.25, шанс редких и более ценных сфер ×2!';
    $('evHInfo').textContent = info; $('evChipInfo').textContent = info;
  }
  function updateEventChip(now, e, def) {
    const chip = $('evChip');
    if (!e || !def) { chip.classList.add('hidden'); chip.classList.remove('open'); return; }
    chip.classList.remove('hidden'); chip.dataset.kind = e.kind; chip.dataset.phase = e.phase;
    $('evChipIcon').textContent = def.icon; $('evChipName').textContent = def.name; $('evChipDesc').textContent = def.desc;
    const ann = e.phase === 'announce', sec = Math.max(0, Math.ceil(((ann ? e.startAt : e.endAt) - now) / 1000));
    const mmss = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    $('evChipTime').textContent = ann ? 'через ' + mmss : mmss;
    $('evChipPhase').textContent = ann ? `Начнётся через ${sec} с` : `Идёт · осталось ${mmss}`;
    if (ann) $('evChipInfo').textContent = '';
  }
  for (const id of ['discoChip', 'x2Chip', 'cevChip']) { $(id + 'Btn').addEventListener('click', ev => { ev.stopPropagation(); $(id).classList.toggle('open'); }); document.addEventListener('pointerdown', ev => { if (!$(id).contains(ev.target)) $(id).classList.remove('open'); }); }
  for (const id of ['evChip', 'wkChip']) {
    $(id + 'Btn').addEventListener('click', ev => { ev.stopPropagation(); for (const o of ['evChip', 'wkChip']) if (o !== id) $(o).classList.remove('open'); $(id).classList.toggle('open'); });
    $(id).addEventListener('pointerdown', ev => ev.stopPropagation());
  }
  document.addEventListener('pointerdown', ev => { for (const id of ['evChip', 'wkChip']) if (!$(id).contains(ev.target)) $(id).classList.remove('open'); });
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
    if (d.kind === 'runner') sub = d.caught ? `Поймано ${d.caught} из ${d.total} Раннеров` : 'Все Раннеры ускользнули…';
    if (d.kind === 'lucky') sub = 'Волна удачи закончилась — спавн сфер вернулся к обычному.';
    if (d.kind === 'treasure') sub = `Найдено сокровищ: ${(d.total || 0) - (d.remaining || 0)} из ${d.total || 0}`;
    if (d.you) {
      const unit = EV_UNITS[d.kind];
      you.innerHTML = `Вы: ${Number(d.you.place) | 0}-е место${unit ? ` · ${fmt(d.you.score)} ${unit}` : ''}` + (d.you.reward ? ` · награда ${rewardText(d.you.reward)}` : d.kind === 'koth' ? ` · для награды нужно ≥ ${def.minScore} очков` : '');
      you.classList.add('ok');
    } else you.textContent = 'Вы не участвовали — в следующий раз!';
    if (sub) { const s2 = document.createElement('div'); s2.className = 'evr-sub'; s2.textContent = sub; box.appendChild(s2); }
    box.appendChild(you);
    if (d.results && d.results.length) {
      const ol = document.createElement('ol'); ol.className = 'evr-list';
      for (const r of d.results) {
        const li = document.createElement('li'); const n = document.createElement('span'); n.textContent = r.name;
        const v = document.createElement('b'); v.innerHTML = (EV_UNITS[d.kind] ? fmt(r.score) + ' ' + EV_UNITS[d.kind] : '') + (r.reward ? ' ' + rewardText(r.reward) : '');
        li.append(n, v); if (r.name === myName) li.className = 'me'; ol.appendChild(li);
      }
      box.appendChild(ol);
    }
    if (d.kind === 'rain' && d.you) { const s3 = document.createElement('div'); s3.className = 'evr-sub'; s3.textContent = 'Все сферы дождя уже зачислены на баланс.'; box.appendChild(s3); }
    box.classList.remove('hidden');
    clearTimeout(evResultTimer); evResultTimer = setTimeout(evResultHide, 12000);
  }
  socket.on('ev:announce', d => { if (!joined || !d) return; evResultHide(); setEvent(d); });
  socket.on('ev:start', d => { if (!joined || !d) return; setEvent(d); const def = G.EVENTS[d.kind]; if (def) toastC('events', `${def.icon} Событие «${def.name}» началось!`, 'ok'); });
  socket.on('ev:koth', d => { kothInfo = d; });
  socket.on('ev:treasure', d => {
    if (!evState || !d) return;
    evState.remaining = d.left;
    toastC('events', `💰 ${d.name} нашёл(ла) сокровище!${d.left ? ' Осталось: ' + d.left : ''}`);
    updateEventUi();
  });
  socket.on('ev:runner', d => {
    if (!evState || !d) return;
    toastC('events', `💨 ${d.name} поймал(а) Раннера!${d.left ? ' Осталось: ' + d.left : ''}`);
  });
  socket.on('ev:end', d => {
    if (!d) return;
    evState = null; kothInfo = null; runners.clear(); updateEventUi();
    if (!joined) return;
    if (d.cancelled) { toastC('events', 'Событие отменено'); return; }
    showEventResult(d);
    if (mobileUI()) { const b = Math.max($('hud').querySelector('.stats').getBoundingClientRect().bottom, $('hud').querySelector('.top').getBoundingClientRect().bottom); $('hud').style.setProperty('--ev-top', Math.round(b + 8) + 'px'); }
  });
  // world layer: king-of-the-hill zone (dim + dashed while announced)
  function drawEventZone(t) {
    if (!evState || !evState.zone) return;
    const z = evState.zone, active = evState.phase === 'active', inside = Math.hypot(dispMe.x - z.x, dispMe.y - z.y) <= z.r;
    if (z.x + z.r < cam.x || z.x - z.r > cam.x + VW || z.y + z.r < cam.y || z.y - z.r > cam.y + VH) return;
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
  function drawRunner(t, now) { for (const r of runners.values()) drawOneRunner(r, t, now); }
  // what you see is what you catch: when my drawn ball overlaps a drawn Раннер, claim it (server validates with tolerance)
  let lastTouch = 0;
  function checkRunnerTouch(now) {
    if (!runners.size || now - lastTouch < 100) return;
    for (const [id, r] of runners) {
      if (Math.hypot(runnerX(r, now) - dispMe.x, runnerY(r, now) - dispMe.y) > G.PLAYER_R + G.EVENTS.runner.r) continue;
      lastTouch = now; socket.emit('ev:touch', { id, x: Math.round(me.x), y: Math.round(me.y) }); return;
    }
  }
  function drawOneRunner(runner, t, now) {
    const x = runnerX(runner, now), y = runnerY(runner, now);
    if (x < cam.x - 80 || x > cam.x + VW + 80 || y < cam.y - 80 || y > cam.y + VH + 80) return;
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

  // ------------------------------------------------------------ content update: mini-events, bonus room, boss, achievements, daily quests
  // (all server-run; the client only shows them)
  let miniState = null, roomUntil = 0, bossState = null;
  const bossRings = [];
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function setMini(d) {
    if (!d) { miniState = null; updateMiniChip(); return; }
    const now = performance.now();
    miniState = Object.assign({}, d, { endAt: now + (d.left || 0), at: now });
    updateMiniChip();
  }
  socket.on('mini:start', d => { if (!joined || !d) return; setMini(d); const def = C.MINI[d.kind]; if (def) toastC('mini', `${def.icon} Мини-событие «${def.name}»! Отмечено на радаре.`, 'ok'); });
  socket.on('mini', d => { if (!joined) return; setMini(d); });
  socket.on('mini:end', d => {
    if (!joined) return; const k = miniState && miniState.kind; setMini(null);
    if (d && d.reason === 'opened' && k === 'chest') toastC('mini', `🧰 Сундук открыт: ${(d.names || []).map(String).join(', ')}`);
  });
  socket.on('mini:reward', d => { if (d && d.reward) toastC('mini', `🧰 Награда из сундука: ${C.rewardText(d.reward)}`, 'ok'); });
  socket.on('room', d => {
    roomUntil = d && d.left > 0 ? performance.now() + d.left : 0;
    toastC('mini', roomUntil ? '🌀 Бонусная комната! Собирайте сферы — через 30 с вернётесь обратно.' : '🌀 Вы вернулись на арену.', 'ok');
    updateRoomBar();
  });
  function updateRoomBar() {
    const el = $('roomBar'), left = roomUntil - performance.now();
    if (!joined || left <= 0) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); el.textContent = `🌀 Бонусная комната · ${Math.ceil(left / 1000)} с`;
  }
  function updateMiniChip() {
    const chip = $('miniChip'), m = miniState, def = m && C.MINI[m.kind];
    if (!joined || !m || !def) { chip.classList.add('hidden'); chip.classList.remove('open'); return; }
    const now = performance.now(), left = m.endAt - now;
    chip.classList.remove('hidden'); chip.dataset.kind = m.kind;
    $('miniChipIcon').textContent = def.icon; $('miniChipName').textContent = def.name; $('miniChipDesc').textContent = def.desc;
    $('miniChipTime').textContent = mmss(left); $('miniChipPhase').textContent = `Мини-событие · осталось ${mmss(left)}`;
    const d = Math.round(Math.hypot(m.x - dispMe.x, m.y - dispMe.y) / 10);
    let info = `До места: ${d} м`;
    if (m.kind === 'chest') info += ` · рядом: ${m.near || 0} · замок ${Math.min(100, Math.round((m.prog || 0) / Math.max(1, m.need) * 100))} %`;
    $('miniChipInfo').textContent = info;
  }
  // ---- boss
  function setBoss(d) {
    if (!d) { bossState = null; updateBossUi(); return; }
    const now = performance.now(), prev = bossState;
    bossState = { phase: d.phase, x: d.x, y: d.y, px: prev ? bossPos(now).x : d.x, py: prev ? bossPos(now).y : d.y, at: now, hp: d.hp, max: d.max, startAt: now + (d.in || 0), endAt: now + (d.in || 0) + (d.phase === 'announce' ? d.dur : d.left), r: d.r || C.BOSS.r };
    if (d.phase === 'active') bossState.endAt = now + d.left;
    updateBossUi();
  }
  function syncBoss(bs, now) {
    if (!bossState || !bs) return;
    const p = bossPos(now); bossState.px = p.x; bossState.py = p.y; bossState.x = bs[0]; bossState.y = bs[1]; bossState.at = now; bossState.hp = bs[2]; bossState.max = bs[3];
    if (bossState.phase !== 'active') { bossState.phase = 'active'; updateBossUi(); }
  }
  function bossPos(now) { const b = bossState, k = Math.min(1, (now - b.at) / G.TICK_MS); return { x: b.px + (b.x - b.px) * k, y: b.py + (b.y - b.py) * k }; }
  function bossSolid() { if (!bossState || bossState.phase !== 'active') return []; const p = bossPos(performance.now()); return [{ k: 'circle', x: p.x, y: p.y, r: bossState.r }]; }
  socket.on('boss', d => { if (!joined) return; const was = bossState; setBoss(d); if (d && d.phase === 'announce' && !was) toastC('boss', `👹 Через ${Math.ceil((d.in || 0) / 1000)} с появится босс «${C.BOSS.name}»! Он отмечен на радаре.`, 'ok'); if (d && d.phase === 'active') toastC('boss', '👹 Босс на арене! Толкайте его, чтобы нанести урон.', 'ok'); });
  socket.on('boss:ring', d => { if (!joined || !d) return; bossRings.push(Object.assign({}, d, { at: performance.now() + d.warn })); });
  socket.on('boss:hit', d => { if (!joined || !d) return; floaters.push({ x: dispMe.x, y: dispMe.y - 40, text: `−${d.dmg} HP`, color: '#ff7a8a', start: performance.now(), big: true }); });
  socket.on('boss:end', d => {
    bossState = null; bossRings.length = 0; updateBossUi();
    if (!joined || !d) return;
    const box = $('evResult'); box.textContent = ''; box.dataset.kind = 'boss';
    const head = document.createElement('div'); head.className = 'evr-head';
    const h = document.createElement('b'); h.textContent = d.killed ? `👹 Босс повержен!` : '👹 Босс ушёл…';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'close'; x.setAttribute('aria-label', 'Закрыть'); x.textContent = '✕'; x.onclick = evResultHide;
    head.append(h, x); box.appendChild(head);
    const you = document.createElement('div'); you.className = 'evr-you';
    if (d.you) { you.innerHTML = `Вы: ${Number(d.you.place) | 0}-е место · урон ${fmt(d.you.dmg)} (${Number(d.you.share) | 0} %)` + (d.you.reward ? ` · награда ${rewardText(d.you.reward)}` : ''); you.classList.add('ok'); }
    else you.textContent = d.killed ? 'Вы не нанесли урона — в следующий раз!' : 'Его не успели победить за 3 минуты.';
    box.appendChild(you);
    if (d.results && d.results.length) {
      const ol = document.createElement('ol'); ol.className = 'evr-list';
      for (const r of d.results) { const li = document.createElement('li'); const n = document.createElement('span'); n.textContent = r.name; const v = document.createElement('b'); v.innerHTML = fmt(r.dmg) + ' урона' + (r.reward ? ' ' + rewardText(r.reward) : ''); li.append(n, v); if (r.name === myName) li.className = 'me'; ol.appendChild(li); }
      box.appendChild(ol);
    }
    box.classList.remove('hidden'); clearTimeout(evResultTimer); evResultTimer = setTimeout(evResultHide, 12000);
  });
  function updateBossUi() {
    const bar = $('bossBar'), chip = $('bossChip'), b = bossState, now = performance.now();
    document.body.classList.toggle('boss-on', !!(joined && b && b.phase === 'active'));
    if (!joined || !b) { bar.classList.add('hidden'); chip.classList.add('hidden'); chip.classList.remove('open'); return; }
    chip.classList.remove('hidden'); chip.dataset.phase = b.phase;
    const ann = b.phase === 'announce', left = ann ? b.startAt - now : b.endAt - now;
    $('bossChipTime').textContent = (ann ? 'через ' : '') + mmss(left);
    $('bossChipName').textContent = `Босс «${C.BOSS.name}»`; $('bossChipDesc').textContent = C.BOSS.desc;
    $('bossChipPhase').textContent = ann ? `Появится через ${Math.ceil(left / 1000)} с` : `На арене · уйдёт через ${mmss(left)}`;
    const p = bossPos(now); $('bossChipInfo').textContent = `До босса: ${Math.round(Math.hypot(p.x - dispMe.x, p.y - dispMe.y) / 10)} м (1-я зона)` + (ann ? '' : ` · HP ${fmt(b.hp)} / ${fmt(b.max)}`);
    if (ann) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden'); $('bossName').textContent = C.BOSS.name; $('bossTime').textContent = mmss(left);
    $('bossHpFill').style.width = Math.max(0, Math.min(100, b.hp / Math.max(1, b.max) * 100)) + '%';
    $('bossHpText').textContent = `${fmt(Math.max(0, b.hp))} / ${fmt(b.max)} HP`;
  }
  for (const id of ['miniChip', 'bossChip']) {
    $(id + 'Btn').addEventListener('click', ev => { ev.stopPropagation(); for (const o of ['evChip', 'wkChip', 'miniChip', 'bossChip']) if (o !== id) $(o).classList.remove('open'); $(id).classList.toggle('open'); });
    $(id).addEventListener('pointerdown', ev => ev.stopPropagation());
  }
  document.addEventListener('pointerdown', ev => { for (const id of ['miniChip', 'bossChip']) if (!$(id).contains(ev.target)) $(id).classList.remove('open'); });
  setInterval(() => { if (!joined) return; updateMiniChip(); updateBossUi(); updateRoomBar(); }, 200);
  // world layer
  function drawBonusRoom(t) {
    const R = G.BONUS_ROOM;
    if (R.x > cam.x + VW || R.x + R.w < cam.x || R.y > cam.y + VH || R.y + R.h < cam.y) return;
    ctx.save();
    const g = ctx.createLinearGradient(R.x, R.y, R.x + R.w, R.y + R.h); g.addColorStop(0, 'rgba(70,30,120,0.35)'); g.addColorStop(1, 'rgba(20,70,140,0.35)');
    ctx.fillStyle = g; ctx.fillRect(R.x, R.y, R.w, R.h);
    ctx.strokeStyle = `rgba(190,140,255,${0.7 + 0.2 * Math.sin(t * 3)})`; ctx.lineWidth = 5; ctx.shadowColor = '#b48cff'; ctx.shadowBlur = 18; ctx.strokeRect(R.x, R.y, R.w, R.h); ctx.shadowBlur = 0;
    ctx.font = '800 28px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(220,200,255,0.5)'; ctx.fillText('🌀 Бонусная комната', R.x + R.w / 2, R.y + 42);
    ctx.restore();
  }
  function drawMiniWorld(t, now) {
    const m = miniState; if (!m) return;
    if (m.x < cam.x - 300 || m.x > cam.x + VW + 300 || m.y < cam.y - 300 || m.y > cam.y + VH + 300) return;
    ctx.save(); ctx.translate(m.x, m.y);
    if (m.kind === 'goldrain') {
      const r = m.r || C.MINI.goldrain.radius;
      ctx.strokeStyle = 'rgba(255,214,90,0.55)'; ctx.lineWidth = 3; ctx.setLineDash([10, 9]); ctx.lineDashOffset = -t * 30;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, 'rgba(255,220,100,0.16)'); gr.addColorStop(1, 'rgba(255,200,60,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    } else if (m.kind === 'chest') {
      const def = C.MINI.chest, k = Math.min(1, (m.prog || 0) / Math.max(1, m.need || def.duoMs));
      ctx.strokeStyle = 'rgba(255,204,51,0.35)'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.arc(0, 0, def.openR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.shadowColor = '#ffcc33'; ctx.shadowBlur = 16 + 8 * Math.sin(t * 4);
      ctx.fillStyle = '#8a5a2b'; ctx.fillRect(-30, -16, 60, 36); ctx.fillStyle = '#a8703a'; ctx.beginPath(); ctx.moveTo(-30, -16); ctx.quadraticCurveTo(0, -42, 30, -16); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#ffcc33'; ctx.fillRect(-30, -4, 60, 6); ctx.fillRect(-4, -18, 8, 38);
      ctx.fillStyle = '#d9d9e6'; ctx.fillRect(-8, 2, 16, 13); ctx.strokeStyle = '#d9d9e6'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 2, 6, Math.PI, 0); ctx.stroke(); // padlock
      ctx.strokeStyle = '#5dff8f'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(0, -2, 52, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); ctx.stroke();
      ctx.font = '800 14px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.fillStyle = '#ffe08a';
      const solo = (m.need || 0) > def.duoMs, label = solo ? 'Сундук: стойте рядом 8 с' : `Сундук: нужно 2 игрока (${m.near || 0}/2)`;
      ctx.strokeText(label, 0, 76); ctx.fillText(label, 0, 76);
    } else if (m.kind === 'portal') {
      const r = C.MINI.portal.r;
      for (let i = 0; i < 4; i++) { ctx.strokeStyle = `hsla(${270 + i * 25},100%,${65 + i * 5}%,${0.8 - i * 0.15})`; ctx.lineWidth = 6 - i; ctx.beginPath(); ctx.ellipse(0, 0, r - i * 9, (r - i * 9) * 0.92, t * (1.5 + i * 0.6), 0.3, Math.PI * 1.75); ctx.stroke(); }
      const gr = ctx.createRadialGradient(0, 0, 2, 0, 0, r); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.4, 'rgba(170,110,255,0.45)'); gr.addColorStop(1, 'rgba(90,40,200,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.font = '800 14px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.fillStyle = '#e2ccff';
      ctx.strokeText('Бонусный портал', 0, r + 22); ctx.fillText('Бонусный портал', 0, r + 22);
    }
    ctx.restore();
  }
  function drawBoss(t, now) {
    for (let i = bossRings.length - 1; i >= 0; i--) { // shockwave rings: dashed warning, then the expanding wave
      const r = bossRings[i], rr = (now - r.at) / 1000 * r.speed;
      if (rr > r.max) { bossRings.splice(i, 1); continue; }
      ctx.save();
      if (rr < 0) { ctx.strokeStyle = `rgba(255,70,90,${0.4 + 0.3 * Math.sin(now / 60)})`; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.arc(r.x, r.y, r.max, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.strokeStyle = `rgba(255,80,110,${0.85 * (1 - rr / r.max) + 0.15})`; ctx.lineWidth = r.w; ctx.shadowColor = '#ff3355'; ctx.shadowBlur = 20; ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(1, rr), 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    }
    const b = bossState; if (!b) return;
    const p = bossPos(now), R = b.r;
    if (p.x < cam.x - 200 || p.x > cam.x + VW + 200 || p.y < cam.y - 200 || p.y > cam.y + VH + 200) return;
    ctx.save(); ctx.translate(p.x, p.y);
    if (b.phase === 'announce') { // summoning circle
      ctx.strokeStyle = `rgba(255,60,90,${0.5 + 0.3 * Math.sin(t * 5)})`; ctx.lineWidth = 4; ctx.setLineDash([14, 10]); ctx.lineDashOffset = -t * 40;
      ctx.beginPath(); ctx.arc(0, 0, R + 20, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '800 16px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff9aa6'; ctx.fillText(`Босс через ${Math.max(0, Math.ceil((b.startAt - now) / 1000))} с`, 0, 6);
      ctx.restore(); return;
    }
    const spikes = 14; ctx.rotate(t * 0.4);
    ctx.shadowColor = '#ff2b6a'; ctx.shadowBlur = 30;
    ctx.beginPath(); for (let i = 0; i <= spikes * 2; i++) { const a = i / (spikes * 2) * Math.PI * 2, rr = i % 2 ? R : R * 1.16 + 3 * Math.sin(t * 6 + i); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    const gr = ctx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.1, 0, 0, R * 1.2); gr.addColorStop(0, '#ff9ad0'); gr.addColorStop(0.45, '#b0185e'); gr.addColorStop(1, '#3a0626');
    ctx.fillStyle = gr; ctx.fill(); ctx.shadowBlur = 0; ctx.rotate(-t * 0.4);
    for (const s of [-1, 1]) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(s * R * 0.32, -R * 0.15, R * 0.17, R * 0.13, s * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#ff2040'; ctx.beginPath(); ctx.arc(s * R * 0.32 + (dispMe.x - p.x) / 200, -R * 0.15 + (dispMe.y - p.y) / 200, R * 0.07, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#1a0010'; ctx.beginPath(); ctx.ellipse(0, R * 0.3, R * 0.38, R * 0.14 + 4 * Math.abs(Math.sin(t * 3)), 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(i * R * 0.1 - 5, R * 0.2); ctx.lineTo(i * R * 0.1 + 5, R * 0.2); ctx.lineTo(i * R * 0.1, R * 0.3); ctx.fill(); }
    // small HP bar above
    const w = R * 2; ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-w / 2, -R - 30, w, 9); ctx.fillStyle = '#ff3355'; ctx.fillRect(-w / 2, -R - 30, w * Math.max(0, b.hp / Math.max(1, b.max)), 9);
    ctx.restore();
  }
  // ---- achievements
  const achProfile = p => ({ total: p.total, stats: p.stats || {}, codesUsed: p.codesUsed || 0, items: C.itemsOwned(p.inventory), liveMs: 0 });
  socket.on('trophy', () => { toast('🏆 Все достижения выполнены! Награда: «Кубок» — он в инвентаре (шапка).', 'ok'); floaters.push({ x: me.x, y: me.y - 50, text: '🏆 Кубок!', color: '#ffcc33', start: performance.now(), big: true }); });
  socket.on('ach', d => {
    if (!d) return;
    if (d.ids) { toastC('ach', `🏆 Достижения: ${d.ids.length ? d.ids.length + ' ступеней получено' : 'пересчитаны'} · ${C.rewardText(d.reward)}`, 'ok'); return; }
    const a = C.ACH_BY_ID[d.id]; if (a) toastC('ach', `🏆 Достижение «${a.name}»! ${C.rewardText(d.reward)}`, 'ok');
  });
  let achCat = C.ACH_CATS[0].key;
  function chainState(ch, p, got) { // tiers done (prefix of paid tiers), the next tier and progress to it
    let done = 0; while (done < ch.tiers.length && got[ch.tiers[done].id]) done++;
    const next = ch.tiers[done] || null, v = C.achValue(ch.tiers[0], p);
    return { done, next, v, max: done === ch.tiers.length };
  }
  const CAT_COL = { orbs: '#4fc3ff', boss: '#ff4d6d', events: '#ffb020', games: '#9b7bff', quests: '#ffd166', danger: '#ff7a1a', explore: '#2ee6a6', collect: '#ff6bd6' };
  const METALS = ['bronze', 'silver', 'gold', 'diamond'];
  const metalOf = (i, n) => METALS[n === 1 ? 2 : Math.round(i * 3 / (n - 1))];
  function rwChips(rw) { // reward → chips (text kept compatible with rewardText)
    const box = document.createElement('span'); box.className = 'rw-chips';
    const add = (cls, t) => { const s = document.createElement('span'); s.className = 'rw-chip ' + cls; s.textContent = t; box.appendChild(s); };
    if (!rw) return box;
    if (rw.orbs) add('orb', `🔮 +${fmt(rw.orbs)} сфер`);
    if (rw.shards) add('shard', `✦ +${rw.shards} оск.`);
    if (rw.boost) add('boost', `${C.BOOSTS[rw.boost].icon} ${C.BOOSTS[rw.boost].name} · ${rw.min} мин`);
    if (rw.item) { const it = G.ITEM_BY_ID[rw.item]; add('item', `🎁 «${it ? it.name : rw.item}»`); }
    if (rw.potion) add('potion', '+ 🧪 зелье');
    return box;
  }
  function confetti(el) { // burst in a layer over the modal card (survives list re-renders)
    if (!el || !el.isConnected) return; const card = el.closest('.modal-card') || document.body, cr = card.getBoundingClientRect(), er = el.getBoundingClientRect();
    const fx = document.createElement('div'); fx.className = 'cf-layer'; fx.style.left = (er.left - cr.left + 34) + 'px'; fx.style.top = (er.top - cr.top + er.height / 2) + 'px';
    const cols = ['#ffd166', '#ff6bd6', '#4fc3ff', '#5dff8f', '#ff7a1a', '#fff'];
    for (let i = 0; i < 28; i++) { const s = document.createElement('i'); s.className = 'cf'; const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
      s.style.cssText = `--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 30}px;--r:${Math.random() * 720 - 360}deg;background:${cols[i % cols.length]};animation-delay:${Math.random() * 80}ms`; fx.appendChild(s); }
    card.appendChild(fx); el.classList.add('burst'); setTimeout(() => fx.remove(), 1300);
  }
  window.OCSConfetti = confetti;
  let achSeen = null;
  function renderAch() {
    if (!profile) return;
    const p = achProfile(profile), got = (profile.stats && profile.stats.ach) || {};
    const nDone = C.ACH.filter(a => got[a.id]).length, fresh = achSeen ? C.ACH.filter(a => got[a.id] && !achSeen.has(a.id)) : [];
    achSeen = new Set(C.ACH.filter(a => got[a.id]).map(a => a.id));
    $('achCount').textContent = `${nDone} / ${C.ACH.length}`;
    const pct = Math.round(nDone / C.ACH.length * 100);
    const tr = $('achTrophy'); if (tr) { tr.classList.toggle('done', nDone >= C.ACH.length); $('achTrophyTxt').textContent = nDone >= C.ACH.length ? 'Получено!' : `${nDone} / ${C.ACH.length} · ${pct}%`; $('achTrophyBar').style.width = pct + '%'; }
    const card = $('ach').querySelector('.modal-card'); card.classList.add('ach-v2'); card.style.setProperty('--ac', CAT_COL[achCat] || '#4fc3ff');
    const tabs = $('achTabs'); tabs.textContent = '';
    for (const c of C.ACH_CATS) {
      const tiers = C.ACH.filter(a => a.cat === c.key), n = tiers.filter(a => got[a.id]).length, col = CAT_COL[c.key];
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ach-tab' + (c.key === achCat ? ' active' : '') + (n === tiers.length ? ' full' : ''); b.dataset.cat = c.key; b.setAttribute('role', 'tab');
      b.style.setProperty('--c', col); b.style.setProperty('--p', (n / tiers.length * 360).toFixed(0) + 'deg');
      b.innerHTML = `<span class="ring"><span class="ic">${c.icon}</span></span><span class="nm">${esc(c.name)}</span><span class="cnt">${n}/${tiers.length}</span>`;
      b.onclick = () => { achCat = c.key; renderAch(); };
      tabs.appendChild(b);
    }
    const list = $('achList'); list.textContent = '';
    const cat = C.ACH_CATS.find(c => c.key === achCat), catT = C.ACH.filter(a => a.cat === achCat), catN = catT.filter(a => got[a.id]).length;
    const hd = document.createElement('div'); hd.className = 'ach-cathead'; hd.innerHTML = `<span class="big">${cat.icon}</span><div><b>${esc(cat.name)}</b><small>${catN} из ${catT.length} ступеней</small></div>`; list.appendChild(hd);
    const chains = C.CHAINS.filter(x => x.cat === achCat).map(ch => [ch, chainState(ch, p, got)]).sort((a, b) => a[1].max - b[1].max);
    for (const [ch, s] of chains) {
      const n = ch.tiers.length;
      const el = document.createElement('div'); el.className = 'ach-item v2 ' + (s.max ? 'done' : s.v > 0 ? 'active' : 'fresh'); el.dataset.chain = ch.id;
      const ic = document.createElement('div'); ic.className = 'ach-ic'; ic.textContent = ch.icon;
      if (s.max) { const ck = document.createElement('span'); ck.className = 'ach-check'; ck.textContent = '✓'; ic.appendChild(ck); }
      const body = document.createElement('div'); body.className = 'ach-body';
      const nm = document.createElement('b'); nm.className = 'ach-nm'; nm.textContent = s.done ? ch.tiers[s.done - 1].name : ch.name;
      const medals = document.createElement('span'); medals.className = 'ach-medals';
      ch.tiers.forEach((t, i) => { const m = document.createElement('span'); m.className = `medal ${metalOf(i, n)} ${i < s.done ? 'got' : i === s.done ? 'next' : 'locked'}`; m.textContent = n > 1 ? ['I', 'II', 'III', 'IV', 'V'][i] : '★'; m.title = `${t.name}: ${t.desc}`; medals.appendChild(m); });
      const top = document.createElement('div'); top.className = 'ach-top'; top.append(nm, medals);
      const ds = document.createElement('div'); ds.className = 'ach-desc';
      ds.textContent = s.max ? 'Все ступени пройдены!' : `Дальше: ${s.next.name} — ${s.next.desc}`;
      const goal = s.max ? ch.tiers[n - 1].goal : s.next.goal;
      const bar = document.createElement('div'); bar.className = 'ach-bar big'; const fill = document.createElement('i'); fill.style.width = Math.min(100, s.v / goal * 100) + '%'; bar.appendChild(fill);
      const meta = document.createElement('div'); meta.className = 'ach-meta';
      const pv = document.createElement('span'); pv.className = 'pv'; pv.textContent = `${fmt(Math.min(s.v, goal))} / ${fmt(goal)}${ch.unit ? ' ' + ch.unit : ''}`; meta.appendChild(pv);
      if (!s.max) meta.appendChild(rwChips(s.next.reward));
      body.append(top, ds, bar, meta); el.append(ic, body); list.appendChild(el);
      if (fresh.some(a => a.chain === ch.id) && !$('ach').classList.contains('hidden')) requestAnimationFrame(() => confetti(document.querySelector(`#achList .ach-item[data-chain="${ch.id}"]`)));
    }
  }
  // ---- daily quests + boosts
  socket.on('quest', d => {
    if (!d) return;
    if (d.all) { toastC('quests', `📜 Все задания дня выполнены! Серия: ${d.streak} 🔥 · ${C.rewardText(d.reward)}`, 'ok'); return; }
    if (d.weekly) { const w = C.WEEKLY_BY_ID[d.id]; if (w) toastC('quests', `🗓 Еженедельное задание выполнено: «${w.text}» · ${C.rewardText(d.reward)}`, 'ok'); return; }
    const q = C.QUEST_BY_ID[d.id]; if (q) toastC('quests', `📜 Задание выполнено: «${q.text}» · ${C.rewardText(d.reward)}`, 'ok');
  });
  const streakNow = st => (st && st.streakDay != null && st.streakDay >= C.dayKey() - 1 ? st.streak || 0 : 0);
  // tracker collapse (localStorage): ▾ → tiny 📜 n/3 chip; tap the chip to expand
  let qtMin = store.get('ocs_qt_min') === '1';
  $('qTrack').addEventListener('click', e => {
    const fold = e.target.closest && e.target.closest('.qt-x');
    if (!fold && !qtMin) return; // normal click opens the quests modal
    e.stopImmediatePropagation(); e.preventDefault();
    qtMin = !!fold; store.set('ocs_qt_min', qtMin ? '1' : '0'); updateQuestTracker();
  });
  const Q_ICON = { orbs: '🔮', rare: '💠', runner: '💨', mg: '🎮', zone2: '🚪', boss: '👹', chest: '🧰', portal: '🌀', event: '🎪', play: '⏱️', gold: '🌧️' };
  const DIFF_NM = ['', 'Лёгкое', 'Среднее', 'Сложное'];
  function updateQuestTracker() {
    const el = $('qTrack'), d = profile && profile.stats && profile.stats.daily;
    if (!d || !Array.isArray(d.q)) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const n = d.q.filter(q => q.done).length, sk = streakNow(profile.stats);
    el.textContent = ''; el.classList.toggle('qt-min', qtMin); el.classList.toggle('qt-all', n === d.q.length);
    if (qtMin) { el.textContent = `📜 ${n}/${d.q.length}` + (sk ? ` 🔥${sk}` : ''); el.title = 'Развернуть задания'; return; }
    el.title = 'Задания дня (Q)';
    const x = document.createElement('span'); x.className = 'qt-x'; x.textContent = '▾'; x.title = 'Свернуть'; x.setAttribute('role', 'button'); el.appendChild(x);
    const h = document.createElement('div'); h.className = 'qt-head'; h.innerHTML = `<span>📜 Задания <b>${n}/${d.q.length}</b></span>` + (sk ? `<span class="qt-fl">🔥${sk}</span>` : ''); el.appendChild(h);
    for (const q of d.q) {
      const def = C.QUEST_BY_ID[q.id]; if (!def) continue;
      const row = document.createElement('div'); row.className = 'qt-row d' + def.diff + (q.done ? ' done' : '');
      row.innerHTML = `<span class="qt-i">${q.done ? '✅' : Q_ICON[def.kind] || '▫️'}</span><span class="qt-t"></span><span class="qt-n">${q.done ? '' : `${fmt(q.p)}/${fmt(def.goal)}`}</span><i class="qt-bar" style="width:${Math.min(100, q.p / def.goal * 100)}%"></i>`;
      row.querySelector('.qt-t').textContent = def.text; el.appendChild(row);
    }
  }
  let questTab = 'daily';
  document.querySelectorAll('#qTabs .tab').forEach(b => b.addEventListener('click', () => { questTab = b.dataset.qtab; $('qRrDlg').classList.add('hidden'); renderQuests(); }));
  const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), p = x => String(x).padStart(2, '0'); return (d ? d + ' д ' : '') + `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };
  function qTimer() { const t = document.querySelector('#qReset .qr-t'); if (!t) return; t.textContent = hms(questTab === 'weekly' ? C.weekResetIn(Date.now() + srvSkew) : C.resetIn(Date.now())); }
  setInterval(() => { if (!$('quests').classList.contains('hidden')) qTimer(); }, 1000);
  function qCard(def, q, weekly, rw) {
    const el = document.createElement('div'); el.className = 'q-item v2' + (weekly ? ' weekly' : ' d' + def.diff) + (q.done ? ' done' : ''); if (weekly) el.dataset.weekly = q.id; else el.dataset.diff = def.diff;
    const ic = document.createElement('div'); ic.className = 'q-ic'; ic.textContent = Q_ICON[def.kind] || '📜';
    const body = document.createElement('div'); body.className = 'q-body';
    const top = document.createElement('div'); top.className = 'q-top';
    const nm = document.createElement('b'); nm.textContent = def.text;
    const df = document.createElement('span'); df.className = 'q-diff'; df.textContent = weekly ? '👑 Неделя' : '★'.repeat(def.diff) + ' ' + DIFF_NM[def.diff];
    top.append(nm, df);
    const pctv = Math.min(100, q.p / def.goal * 100);
    const bar = document.createElement('div'); bar.className = 'ach-bar big'; const fill = document.createElement('i'); fill.style.width = pctv + '%'; bar.appendChild(fill);
    const meta = document.createElement('div'); meta.className = 'ach-meta';
    const pv = document.createElement('span'); pv.className = 'pv'; pv.textContent = `${fmt(Math.floor(Math.min(q.p, def.goal)))} / ${fmt(def.goal)} · ${Math.floor(pctv)}%`;
    meta.append(pv, rwChips(rw));
    body.append(top, bar, meta); el.append(ic, body);
    if (q.done) { const st = document.createElement('span'); st.className = 'q-stamp'; st.textContent = 'ВЫПОЛНЕНО'; el.appendChild(st); }
    return el;
  }
  function renderWeekly() {
    const list = $('qList'), st = profile.stats || {}, wk = C.weekKey(Date.now() + srvSkew);
    const w = st.weekly && st.weekly.wk === wk ? st.weekly : { q: C.WEEKLY.map(q => ({ id: q.id, p: 0, done: false })) };
    $('qStreak').textContent = `👑 ${w.q.filter(q => q.done).length}/${w.q.length}`; $('qStreak').className = 'pill q-pill wk';
    $('qReset').innerHTML = `<span class="qr-l">⏳ Сброс в понедельник 00:00 МСК</span><span class="qr-t"></span><small>5 больших заданий на неделю. Прогресс сохраняется.</small>`;
    $('qBonus').innerHTML = '';
    for (const q of w.q) { const def = C.WEEKLY_BY_ID[q.id]; if (def) list.appendChild(qCard(def, q, true, Object.assign({ potion: 1 }, def.rw))); }
    qTimer();
  }
  function renderReroll() {
    const cost = C.REROLL_COST[questTab], have = (profile && profile.shards) || 0;
    $('qRerollBtn').innerHTML = `🎲 Сбросить за ${fmt(cost)} <i class="cur-shard" aria-hidden="true"></i>`; $('qRerollBtn').classList.toggle('poor', have < cost);
    $('qRerollHint').textContent = questTab === 'weekly' ? 'Новые 5 заданий недели, прогресс обнулится' : 'Новые 3 задания, прогресс обнулится; бонус дня не повторяется';
  }
  $('qRerollBtn').addEventListener('click', () => {
    const cost = C.REROLL_COST[questTab], have = (profile && profile.shards) || 0;
    if (have < cost) return toast(`Не хватает осколков: нужно ${fmt(cost)} ✦, у вас ${fmt(have)}`, 'err');
    $('qRrText').textContent = `Сбросить ${questTab === 'weekly' ? 'еженедельные' : 'ежедневные'} задания за ${fmt(cost)} ✦? Текущий прогресс по ним пропадёт.`;
    $('qRrDlg').dataset.which = questTab; $('qRrDlg').classList.remove('hidden');
  });
  $('qRrNo').addEventListener('click', () => $('qRrDlg').classList.add('hidden'));
  $('qRrYes').addEventListener('click', () => {
    const which = $('qRrDlg').dataset.which; $('qRrDlg').classList.add('hidden'); $('qRrYes').disabled = true;
    socket.emit('quest:reroll', which, r => {
      $('qRrYes').disabled = false;
      if (!r || !r.ok) return toast((r && r.error) || 'Не удалось сбросить задания', 'err');
      if (r.profile) setProfile(r.profile);
      toast(`🎲 Задания обновлены (−${fmt(r.spent)} ✦)`, 'ok'); renderQuests();
    });
  });
  function renderQuests() {
    if (!profile) return;
    renderReroll();
    document.querySelectorAll('#qTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.qtab === questTab));
    $('quests').querySelector('.modal-card').classList.toggle('q-wk', questTab === 'weekly'); $('quests').querySelector('.modal-card').classList.add('q-v2');
    $('questsTitle').textContent = questTab === 'weekly' ? '🗓 Еженедельные задания' : '📜 Задания дня';
    if (questTab === 'weekly') { $('qList').textContent = ''; renderWeekly(); return; }
    const d = profile.stats && profile.stats.daily, list = $('qList'); list.textContent = '';
    const sk = streakNow(profile.stats);
    $('qStreak').className = 'pill q-pill' + (sk ? ' hot' : ''); $('qStreak').innerHTML = `<span class="fl">🔥</span> Серия: <b>${fmt(sk)}</b>`;
    $('qReset').innerHTML = `<span class="qr-l">⏳ Новые задания через</span><span class="qr-t"></span><small>Сброс в 00:00 по Москве. Выполните все три — бонус и +1 к серии.</small>`;
    qTimer();
    if (!d) return;
    for (const q of d.q) { const def = C.QUEST_BY_ID[q.id]; if (def) list.appendChild(qCard(def, q, false, Object.assign({ potion: 1 }, q.rw))); }
    const st = profile.stats, next = st.streakDay === d.day ? st.streak : streakNow(st) + 1;
    $('qBonus').className = 'q-bonus' + (d.bonus ? ' got' : '');
    $('qBonus').innerHTML = d.bonus ? `🎉 Бонус за все задания получен! Серия: <b>${fmt(st.streak || 0)}</b> 🔥` : `🎁 Бонус за все 3: <b>${esc(C.rewardText(C.allDoneBonus(next)))}</b> <small>(растёт с серией)</small>`;
  }
  // ------------------------------------------------------------ daily rewards calendar (server: lib/daily.js, C.CALENDAR)
  const CAL_SKIP = 50;
  const calInfo = () => { const c = (profile && profile.stats && profile.stats.cal) || {}, n = Math.max(0, c.n | 0), L = C.CALENDAR.length, t = C.dayKey(Date.now()), can = c.day !== t; return { n, idx: n % L, cycle: Math.floor(n / L), can, skip: !can && c.skip !== t }; };
  function updateCalDot() { const d = $('calDot'); if (d) d.classList.toggle('hidden', !(profile && calInfo().can)); }
  function calRewardHtml(rw) { // icon-based: item/potion sprites (same as inventory), currency icons, amounts; names in title
    const out = [];
    if (rw.item) { const it = G.ITEM_BY_ID[rw.item]; const ow = profile && (profile.inventory || []).some(s => s.id === rw.item);
      out.push(`<span class="cal-ic cal-it" data-icon="${esc(rw.item)}" title="${esc(it.name)} (${esc(G.RARITIES[it.rarity].name)})"></span>${ow ? `<small class="cal-dup" title="Уже есть — выдаются осколки">→ ${shardsH(rw.dup)}</small>` : ''}`); }
    if (rw.orbs) out.push(`<span class="cal-ic cal-cur" title="${fmt(rw.orbs)} сфер">${ORB_I}<b>${fmt(rw.orbs)}</b></span>`);
    if (rw.shards) out.push(`<span class="cal-ic cal-cur" title="${fmt(rw.shards)} осколков">${SHARD_I}<b>${fmt(rw.shards)}</b></span>`);
    for (const p of rw.potions || []) out.push(`<span class="cal-ic cal-it" data-icon="${esc(p)}" title="${esc(G.ITEM_BY_ID[p].name)}"></span>`);
    return out.join('');
  }
  function renderCal() {
    if (!profile) return;
    const s = calInfo(), grid = $('calGrid'); grid.textContent = '';
    $('calCycle').textContent = `Круг ${s.cycle + 1} · день ${s.idx + 1}/${C.CALENDAR.length}`;
    C.CALENDAR.forEach((rw, i) => {
      const st = i < s.idx ? 'got' : i === s.idx ? (s.can ? 'today' : 'next') : 'locked';
      const el = document.createElement('div'); el.className = 'cal-day ' + st + (rw.item ? ' big' : ''); el.dataset.day = i + 1; if (st === 'next') el.title = 'Завтра';
      el.innerHTML = `<div class="cal-n">День ${i + 1}</div><div class="cal-rw">${calRewardHtml(rw)}</div>${st === 'got' ? '<div class="cal-ok">✓</div>' : ''}`;
      el.querySelectorAll('.cal-it').forEach(sp => sp.appendChild(iconEl(sp.dataset.icon, 'sm')));
      grid.appendChild(el);
    });
    const btn = $('calClaim'); btn.disabled = !s.can; btn.textContent = s.can ? `Забрать награду дня ${s.idx + 1}` : '✓ Сегодня получено';
    const sk = $('calSkip'), have = (profile.stats && profile.stats.shards) || 0; sk.classList.toggle('hidden', !s.skip); sk.classList.toggle('poor', have < CAL_SKIP);
    sk.innerHTML = `⏭ Пропустить день за ${CAL_SKIP} ${SHARD_I}`; sk.title = `Забрать награду дня ${s.idx + 1} сейчас (1 раз в день). У вас ${fmt(have)} осколков`;
    calTick();
  }
  function calTick() { const el = $('calTimer'); if (!el || $('cal').classList.contains('hidden')) return; el.textContent = calInfo().can ? '' : `Следующая через ${fmtDur(C.resetIn(Date.now()))}`; }
  setInterval(() => { calTick(); updateCalDot(); }, 1000);
  const calAct = (ev, btn) => { btn.disabled = true;
    socket.emit(ev, res => {
      if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); btn.disabled = false; renderCal(); return; }
      btn.disabled = false;
      setProfile(res.profile); renderCal();
      const r = res.reward, parts = [];
      if (r.item) parts.push('«' + G.ITEM_BY_ID[r.item].name + '»');
      if (r.orbs) parts.push(orbsH(r.orbs)); if (r.shards) parts.push(shardsH(r.shards));
      for (const p of (r.potions || []).concat(r.pending || [])) parts.push(G.ITEM_BY_ID[p].icon + ' ' + esc(G.ITEM_BY_ID[p].name));
      toast('', 'ok', `${r.skip ? `⏭ Пропуск за ${r.cost} ${SHARD_I} — награда` : '📅 Награда'} дня ${r.day}: ${parts.join(', ')}${r.dup ? ' <small>(предмет уже был — выданы осколки)</small>' : ''}${r.pending ? ' <small>(зелья придут, когда освободится место)</small>' : ''}`);
    });
  };
  $('calClaim').onclick = () => calAct('daily:claim', $('calClaim'));
  $('calSkip').onclick = () => calAct('daily:skip', $('calSkip'));
  function updateBoostsHud() {
    const el = $('hudBoosts'), b = profile && profile.stats && profile.stats.boosts, now = Date.now();
    const on = b ? Object.keys(C.BOOSTS).filter(k => b[k] > now) : [];
    el.classList.toggle('hidden', !on.length);
    el.textContent = on.map(k => `${C.BOOSTS[k].icon} ${C.BOOSTS[k].name} · ${mmss(b[k] - now)}`).join('  ');
  }
  setInterval(() => { if (joined && profile) updateBoostsHud(); }, 1000);
  function layoutContentHud() { // quest tracker under the stats panel; on phones the boss bar goes below the top panels
    if (!joined) return;
    const st = document.querySelector('#hud .stats').getBoundingClientRect(), tp = document.querySelector('#hud .top').getBoundingClientRect();
    $('qTrack').style.top = Math.round(st.bottom + 8) + 'px';
    const q = $('qTrack').getBoundingClientRect();
    $('bossBar').style.top = mobileUI() ? Math.round(Math.max(st.bottom, tp.bottom, q.height ? q.bottom : 0) + 6) + 'px' : '';
  }
  setInterval(layoutContentHud, 500); addEventListener('resize', layoutContentHud);

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
      note.innerHTML = [share ? (share >= 1 ? Math.round(share) + '%' : share.toFixed(2).replace('.', ',') + '%') + ' сфер' : '', ot.note ? esc(ot.note) : '', ot.shards ? '+' + shardsH(ot.shards) : ''].filter(Boolean).join(' · ');
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
    if (id === 'ups') renderUps();
    if (id === 'inv') renderInv();
    if (id === 'lb') loadLb();
    if (id === 'ach') renderAch();
    if (id === 'quests') renderQuests();
    if (id === 'cal') renderCal();
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
    const art = def && (def.type === 'cosmetic' ? ICON_ART[def.cat] : def.type === 'potion' ? (g2 => drawPotionBottle(g2, def.potion, ICON_PX / 2, ICON_PX / 2 - 2, ICON_PX / 66, 0.4)) : ICON_ART[def.art]);
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
    return box;
  }
  window.OCSIcons = Object.freeze({ url: iconUrl }); // read-only hook for the UI tests / debugging
  // Trail showcase (UI tests / screenshots): every trail, by rarity, drawn live with the arena renderer on a given canvas.
  window.OCSTrailShowcase = cv => {
    const g = cv.getContext('2d'), list = G.ITEMS.filter(i => i.cat === 'trail' && i.value !== 'none').sort((a, b) => trailTier(a.id) - trailTier(b.id) || (a.price || 0) - (b.price || 0));
    const cols = 3, cw = cv.width / cols, ch = cv.height / Math.ceil(list.length / cols), fakes = list.map(d => ({ id: 'demo' + d.id, eq: eqWith('trail', d.id), trail: [] }));
    const tick = () => {
      if (!cv.isConnected) return;
      requestAnimationFrame(tick);
      const now = performance.now(), t = now / 1000;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#060912'; g.fillRect(0, 0, cv.width, cv.height);
      list.forEach((d, idx) => {
        const x0 = (idx % cols) * cw, y0 = Math.floor(idx / cols) * ch, tier = trailTier(d.id), N = TRAIL_PTS[tier], life = TRAIL_LIFE[tier], f = fakes[idx];
        const hx = x0 + cw - 70, hy = y0 + ch * 0.55;
        f.trail.length = 0;
        for (let i = 0; i < N; i++) { const tm = now - (N - 1 - i) * (life / N), back = (N - 1 - i) * (cw * 0.62 / N); f.trail.push({ x: hx - back, y: hy + Math.sin(tm / 160) * 14 * (back / cw + 0.15), time: tm, seed: (i * 0.618 + idx * 0.13) % 1 }); }
        drawTrail(g, f, t, now);
        drawAvatar(g, hx, hy, G.PLAYER_R, f.eq, t, { dir: { x: 1, y: 0 }, phase: idx });
        const r = rarityOf(d);
        g.globalAlpha = 1; g.textAlign = 'left'; g.font = '700 15px Segoe UI, sans-serif'; g.fillStyle = '#fff'; g.fillText(d.name, x0 + 14, y0 + 22);
        g.font = '600 12px Segoe UI, sans-serif'; g.fillStyle = r.color; g.fillText(r.name, x0 + 14, y0 + 38);
      });
    };
    tick();
    return list.length;
  };

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
  const SOURCE_NAMES = { shop: 'Магазин', minigame: 'Мини-игры', arena: 'Арена', event: 'Событие', admin: 'Подарок', legacy: 'Куплено раньше', shard_shop: 'Лавка осколков', beta: 'Бета-тест', daily: 'Ежедневные награды' };
  function rarityTag(def) { const r = rarityOf(def); const el = document.createElement('div'); el.className = 'rar' + (def.rarity === 'exclusive' ? ' rar-ex' : ''); if (def.rarity !== 'exclusive') el.style.color = r.color; el.textContent = r.name; return el; }

  // ------------------------------------------------------------ shop (only sells; purchases go to the inventory)
  let shopTab = 'color', shopRarity = 'all', shopSort = 'price-asc', shopHideOwned = false;
  const RAR_RANK = { common: 0, rare: 1, epic: 2, legendary: 3, exclusive: 4 };
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
    else { btn.innerHTML = `Улучшить · ${orbsH(price)}`; btn.disabled = profile.balance < price; btn.onclick = () => socket.emit('upgrade', up.key, res => afterAction(res, `${up.name}: уровень ${lvl + 1}!`)); }
    el.append(nm, pips, desc, eff, btn);
    return el;
  }
  // «Улучшения»: own window from the menu bar (was a shop tab)
  function renderUps() {
    if (!profile) return;
    const grid = $('upsGrid'); grid.innerHTML = '';
    for (const up of Object.values(G.UPGRADES)) grid.appendChild(upgradeCard(up));
  }
  function renderShop() {
    if (!profile) return;
    pruneHidden('shop');
    if (shopTab === 'upgrades') shopTab = 'color'; // upgrades have their own window now («Улучшения», U)
    const tabs = G.CATEGORIES.concat([{ key: 'emote', name: 'Эмоции', icon: '😀' }, { key: 'shards', name: 'Лавка осколков', icon: SHARD_I }, { key: 'codes', name: '🎟 Коды' }]);
    $('shopTabs').innerHTML = tabs.map(c => `<button class="tab ${c.key === shopTab ? 'active' : ''}" data-tab="${c.key}">${c.icon ? c.icon + ' ' : ''}${c.name}</button>`).join('');
    $('shopTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { shopTab = b.dataset.tab; renderShop(); }); $('shop').dataset.tab = shopTab;
    const grid = $('shopGrid');
    grid.innerHTML = '';
    $('shopTools').classList.toggle('hidden', shopTab === 'shards' || shopTab === 'codes');
    $('shopEmpty').classList.add('hidden');
    if (shopTab === 'shards') { renderShardShop(grid); return; }
    if (shopTab === 'codes') { renderCodes(grid); return; }
    const inCat = G.ITEMS.filter(i => i.cat === shopTab && i.price > 0 && i.sources.includes('shop'));
    if (shopRarity !== 'all' && !inCat.some(i => i.rarity === shopRarity)) shopRarity = 'all';
    const chips = [{ key: 'all', name: 'Все', color: '#aab3d9' }].concat(Object.entries(G.RARITIES).filter(([k]) => k !== 'exclusive').map(([k, r]) => ({ key: k, name: r.name, color: r.color })));
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
    const list = inCat.filter(i => (shopRarity === 'all' || i.rarity === shopRarity) && !(shopHideOwned && owns(i.id))).sort(SHOP_SORTS[shopSort]);
    $('shopEmpty').classList.toggle('hidden', list.length > 0);
    for (const it of list) {
      const owned = owns(it.id);
      const el = document.createElement('div'); el.className = 'item rar-' + it.rarity;
      el.dataset.item = it.id;
      el.appendChild(iconEl(it.id));
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name; el.append(nm, rarityTag(it));
      buyControls(el, it, it.price, profile.balance, orbsH, 'buy', owned);
      grid.appendChild(el);
    }
  }
  // «Лавка осколков»: exclusives for legendary shards only (+ optional shard → orb exchange)
  const shardCount = () => (profile ? profile.shards || 0 : 0); // shards are a currency (profile.shards)
  function renderShardShop(grid) {
    const have = shardCount(), X = G.SHARD_EXCHANGE;
    const head = document.createElement('div'); head.className = 'shard-head'; head.id = 'shardHead';
    const ico = iconEl(G.SHARD_ID, 'sm');
    const txt = document.createElement('div'); txt.className = 'shard-txt';
    const b = document.createElement('div'); b.className = 'shard-have'; b.innerHTML = 'У вас осколков: <b id="shardCount"></b>'; b.querySelector('b').innerHTML = shardsH(have);
    const how = document.createElement('div'); how.className = 'muted'; how.textContent = 'Осколки дают легендарные (+1) и мифические (+3) сферы и награды арена-событий. Товары лавки продаются только за осколки.';
    txt.append(b, how);
    const ex = document.createElement('div'); ex.className = 'shard-ex';
    const lab = document.createElement('label'); lab.htmlFor = 'shardExQty'; lab.innerHTML = `Обмен: 1&nbsp;${SHARD_I} = ${orbsH(X.orbs)}`;
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = 'shardExQty'; inp.min = 1; inp.max = Math.max(1, Math.min(X.maxPerTrade, have)); inp.value = 1; inp.inputMode = 'numeric';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.id = 'shardExBtn';
    const qty = () => Math.max(1, Math.min(X.maxPerTrade, parseInt(inp.value, 10) || 1));
    const upd = () => { btn.innerHTML = `Обменять → ${orbsH(qty() * X.orbs)}`; btn.disabled = have < qty(); };
    inp.oninput = upd; upd();
    btn.onclick = () => { const q = qty(); btn.disabled = true; socket.emit('shard:exchange', q, res => afterAction(res, `Обмен: −${q} осколк., +${fmt(q * X.orbs)} сфер`)); };
    inp.addEventListener('keydown', e => e.stopPropagation());
    ex.append(lab, inp, btn);
    head.append(ico, txt, ex); grid.appendChild(head);
    const list = G.ITEMS.filter(i => i.exclusive).sort((a, b2) => a.shardPrice - b2.shardPrice);
    for (const it of list) {
      const owned = owns(it.id);
      const el = document.createElement('div'); el.className = 'item rar-' + it.rarity; el.dataset.item = it.id;
      el.appendChild(iconEl(it.id));
      const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = it.name;
      const cat = document.createElement('div'); cat.className = 'desc'; cat.textContent = (G.CATEGORIES.find(c => c.key === it.cat) || {}).name || '';
      el.append(nm, rarityTag(it), cat);
      buyControls(el, it, it.shardPrice, have, shardsH, 'shard:buy', owned);
      grid.appendChild(el);
    }
  }
  // promo codes: the server checks everything (once per account, expiry, uses, inventory space, rate limit)
  function renderCodes(grid) {
    const box = document.createElement('div');
    box.className = 'code-box';
    box.innerHTML = `<div class="code-title">🎟 Промокод</div><div class="code-hint">Введите код из новостей или от разработчика. Каждый код можно активировать один раз.</div>
      <form class="code-row" id="codeForm"><input id="codeIn" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Например: SUMMER2026"><button class="btn" id="codeBtn" type="submit">Активировать</button></form>`;
    grid.appendChild(box);
    box.querySelector('#codeForm').onsubmit = e => {
      e.preventDefault();
      const inp = box.querySelector('#codeIn'), btn = box.querySelector('#codeBtn'), v = inp.value.trim();
      if (!v) { toast('Введите код', 'err'); return; }
      btn.disabled = true;
      socket.emit('code:redeem', v, res => {
        btn.disabled = false;
        if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
        inp.value = '';
        setProfile(res.profile);
        const r = res.rewards, parts = [];
        if (r.orbs) parts.push('+' + orbsH(r.orbs));
        if (r.shards) parts.push('+' + shardsH(r.shards));
        for (const it of r.items) { const d = G.ITEM_BY_ID[it.id]; parts.push(esc(d ? d.name : it.id) + (it.qty > 1 ? ' ×' + it.qty : '')); }
        toastC('rewards', '', 'ok', 'Код активирован! ' + (parts.join(', ') || 'Готово'));
      });
    };
  }
  function afterAction(res, okMsg) {
    if (!res || !res.ok) { toast((res && res.error) || 'Ошибка', 'err'); return; }
    setProfile(res.profile);
    if (okMsg) toastC('rewards', okMsg, 'ok');
  }

  // ------------------------------------------------------------ inventory (100 slots; stackable items up to 99 per slot)
  let invTab = 'all';
  const invUsed = () => profile.inventory.reduce((n, s) => n + s.q, 0);
  const invCap = () => profile.cap || G.INV_CAP;
  // quantity selector (− / qty / + / Макс) + «Купить ×N · total»; the server re-checks qty, money and space
  function buyControls(el, it, unit, money, priceH, ev, owned) {
    const n = profile.inventory.reduce((k, s) => k + (s.id === it.id ? s.q : 0), 0);
    if (owned) { const o = document.createElement('div'); o.className = 'owned-n'; o.textContent = `✓ В инвентаре: ${n}`; el.appendChild(o); }
    const maxQ = () => Math.max(1, Math.min(G.BUY_MAX_QTY, Math.floor(money / unit), invCap() - invUsed()));
    const row = document.createElement('div'); row.className = 'qty-row';
    const mk = (t, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'qbtn ' + cls; b.textContent = t; return b; };
    const minus = mk('−', 'q-minus'), plus = mk('+', 'q-plus'), mx = mk('Макс', 'q-max');
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 1; inp.max = G.BUY_MAX_QTY; inp.value = 1; inp.className = 'q-in'; inp.setAttribute('aria-label', 'Количество');
    const btn = document.createElement('button'); btn.className = 'btn primary buy-btn' + (ev === 'shard:buy' ? ' shard-buy' : '');
    const q = () => Math.max(1, Math.min(G.BUY_MAX_QTY, Math.floor(Number(inp.value)) || 1));
    const upd = () => {
      const k = q(), cost = unit * k, room = invCap() - invUsed();
      btn.innerHTML = `Купить${k > 1 ? ' ×' + k : ''} · ${priceH(cost)}`;
      btn.disabled = money < cost || room < k;
      btn.title = room < k ? `Инвентарь полон (${invUsed()} / ${invCap()})` : money < cost ? 'Не хватает' : '';
    };
    minus.onclick = () => { inp.value = Math.max(1, q() - 1); upd(); };
    plus.onclick = () => { inp.value = Math.min(G.BUY_MAX_QTY, q() + 1); upd(); };
    mx.onclick = () => { inp.value = maxQ(); upd(); };
    inp.oninput = upd;
    btn.onclick = () => { const k = q(); btn.disabled = true; socket.emit(ev, it.id, k, res => afterAction(res, `Куплено: ${it.name}${k > 1 ? ' ×' + k : ''} — в инвентаре (I)`)); };
    row.append(minus, inp, plus, mx);
    el.append(row, btn); upd();
  }
  // inventory sort (display only; slot indexes stay the server's), saved in localStorage
  const INV_SORT_KEY = 'ocs_inv_sort', INV_SORTS = ['default', 'newest', 'price_desc', 'price_asc', 'rarity', 'type', 'name', 'qty'];
  let invSort = INV_SORTS.includes(store.get(INV_SORT_KEY)) ? store.get(INV_SORT_KEY) : 'default';
  const itemValue = d => (d.price > 0 ? d.price : d.shardPrice ? d.shardPrice * G.SHARD_EXCHANGE.orbs : 0);
  function invOrder(inv) {
    const idx = inv.map((_, i) => i), D = i => G.ITEM_BY_ID[inv[i].id] || {}, nm = i => D(i).name || '', by = f => (a, b) => f(a, b) || nm(a).localeCompare(nm(b), 'ru') || a - b;
    const catRank = Object.fromEntries(G.INV_CATEGORIES.map((c, k) => [c.key, k]));
    const cmp = {
      newest: by((a, b) => (inv[b].at || 0) - (inv[a].at || 0) || b - a),
      price_desc: by((a, b) => itemValue(D(b)) - itemValue(D(a))), price_asc: by((a, b) => itemValue(D(a)) - itemValue(D(b))),
      rarity: by((a, b) => (RAR_RANK[D(b).rarity] || 0) - (RAR_RANK[D(a).rarity] || 0)),
      type: by((a, b) => (catRank[D(a).cat] ?? 99) - (catRank[D(b).cat] ?? 99)),
      name: (a, b) => nm(a).localeCompare(nm(b), 'ru') || a - b,
      qty: by((a, b) => inv[b].q - inv[a].q),
    }[invSort];
    return cmp ? idx.sort(cmp) : idx;
  }
  $('invSort').addEventListener('change', () => { invSort = INV_SORTS.includes($('invSort').value) ? $('invSort').value : 'default'; store.set(INV_SORT_KEY, invSort); renderInv(); });
  function renderInv() {
    if (!profile) return;
    pruneHidden('inv');
    const inv = profile.inventory, used = invUsed(), cap = invCap();
    $('invCount').textContent = `${fmt(used)} / ${fmt(cap)}`; $('invCount').title = 'Предметов в инвентаре (каждая штука в стопке считается)';
    $('invMeter').style.width = Math.min(100, used / cap * 100) + '%';
    $('invMeter').classList.toggle('full', used >= cap);
    const tabs = [{ key: 'all', name: 'Все' }].concat(G.INV_CATEGORIES);
    $('invTabs').innerHTML = tabs.map(c => {
      const n = c.key === 'all' ? inv.length : inv.filter(s => (G.ITEM_BY_ID[s.id] || {}).cat === c.key).length;
      return `<button class="tab ${c.key === invTab ? 'active' : ''}" data-tab="${c.key}">${c.name} <span class="cnt">${n}</span></button>`;
    }).join('');
    $('invTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { invTab = b.dataset.tab; renderInv(); });
    const grid = $('invGrid');
    grid.innerHTML = '';
    let shown = 0;
    $('invSort').value = invSort;
    const order = invOrder(inv);
    order.forEach(i => { const slot = inv[i];
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
      } else if (def.type === 'potion') {
        btn.className = 'btn primary'; btn.textContent = `🧪 Выпить · ${def.desc}`; btn.dataset.drink = def.id; btn.onclick = () => drinkPotion(def);
      } else if (def.type === 'emote') { btn.className = 'btn'; btn.textContent = 'Эмоция — кнопка 😀 у радара'; btn.disabled = true;
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
  trashZone.addEventListener('click', () => toastC('other', 'Нажмите 🗑 на предмете или перетащите его сюда'));
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
      toastC('other', `🗑 Удалено: ${def.name}${def.stackable ? ' ×' + qty : ''}${res.unequipped ? ' (снято)' : ''}`);
    });
  };

  // ------------------------------------------------------------ profile screen
  const fmtDur = ms => { const m = Math.floor((ms || 0) / 60000), h = Math.floor(m / 60); return h ? `${h} ч ${m % 60} мин` : `${m} мин`; };
  const fmtDate = ts => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  function renderProfile() {
    const p = summary || profile;
    if (!p) return;
    $('pfPwNote').classList.toggle('hidden', !p.mustChangePw);
    pruneHidden('profile');
    addPreview($('pfAvatar'), Object.assign({}, p.equipped), 'all', { owner: 'profile', size: 120, r: 28, name: p.name });
    $('pfName').textContent = p.name;
    $('pfShards').innerHTML = shardsH(p.shards || 0);
    $('pfAch').textContent = `${Object.keys((p.stats && p.stats.ach) || {}).length} / ${C.ACH.length}`;
    $('pfEq').replaceChildren(...G.CATEGORIES.map(c => {
      const id = p.equipped[c.key], def = G.ITEM_BY_ID[id];
      const chip = iconEl(id, 'sm'); chip.title = `${c.name}: ${def ? def.name : '—'}`; chip.dataset.cat = c.key;
      return chip;
    }));
    $('pfRankLine').textContent = p.rank ? `🏆 Место в рейтинге: #${p.rank}` : '🏆 Пока без места в рейтинге — соберите первую сферу';
    $('pfSince').textContent = 'Аккаунт создан: ' + fmtDate(p.createdAt);
    $('pfBalance').innerHTML = orbsH(p.balance);
    $('pfTotal').textContent = fmt(p.total);
    $('pfRank').textContent = p.rank ? '#' + fmt(p.rank) : '—';
    $('pfTime').textContent = fmtDur(p.playMs != null ? p.playMs : (p.stats && p.stats.playMs));
    const st = p.stats || {};
    $('pfSessions').textContent = fmt(st.sessions || 0);
    $('pfItems').textContent = `${fmt(p.items != null ? p.items : p.inventory.reduce((n, s) => n + s.q, 0))} / ${fmt(p.cap || G.INV_CAP)}`;
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
  let mg2 = null; // state of the current memory / shell / throw / chain game
  let mgRunning = null, reactionState = null, rushActive = false, rushStart = 0, rushScore = 0;
  let rushTargets = [];
  const rushPops = [];
  function showGamesList() {
    $('gamesList').classList.remove('hidden');
    $('reactionArea').classList.add('hidden'); $('rushArea').classList.add('hidden'); $('mg2Area').classList.add('hidden'); mg2 = null;
    $('mgResult').classList.add('hidden');
  }
  (function gameTexts() {
    const re = G.MINIGAMES.reaction, ru = G.MINIGAMES.rush;
    $('reactionPrizes').textContent = G.REACTION_PRIZES.map(([ms, p]) => `<${ms} мс: ${p * G.MG_PRIZE_MULT}`).join(' · ') + ` · пауза ${re.cooldownMs / 1000} с`;
    $('rushPrizes').textContent = `Выплата: ${Math.round(ru.payoutRate * 100 * G.MG_PRIZE_MULT)}% от очков, не больше ${ru.maxPrize * G.MG_PRIZE_MULT} сфер · пауза ${ru.cooldownMs / 1000} с`;
    const M = G.MINIGAMES;
    $('memoryPrizes').innerHTML = `+${M.memory.perRound * G.MG_PRIZE_MULT} за раунд после ${M.memory.freeRounds}-го, до ${orbsH(M.memory.maxPrize * G.MG_PRIZE_MULT)} · пауза ${M.memory.cooldownMs / 1000} с`;
    $('shellPrizes').innerHTML = `Угадали — ${orbsH(M.shell.prize * G.MG_PRIZE_MULT)} · пауза ${M.shell.cooldownMs / 1000} с`;
    $('throwPrizes').innerHTML = `Очки ${M.throw.points.map(p => p[1]).join('/')} за бросок → ${Math.round(M.throw.payoutRate * 100 * G.MG_PRIZE_MULT)}%, до ${orbsH(M.throw.maxPrize * G.MG_PRIZE_MULT)} · пауза ${M.throw.cooldownMs / 1000} с`;
    $('chainPrizes').innerHTML = M.chain.prizes.map(([ms, p]) => `<${ms / 1000} с: ${p * G.MG_PRIZE_MULT}`).join(' · ') + ` · пауза ${M.chain.cooldownMs / 1000} с`;
    document.querySelectorAll('[data-game]').forEach(b => { b.innerHTML = `Играть — взнос ${orbsH(G.MINIGAMES[b.dataset.game].fee)}`; });
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
      } else if (kind !== 'rush') {
        mg2 = { kind, start: performance.now(), info: 'Приготовьтесь…' };
        $('mg2Info').textContent = mg2.info; $('mg2Time').textContent = '';
        $('mg2Area').classList.remove('hidden');
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
    if (mg2 && mg2.kind === r.kind && (r.kind === 'shell' || r.kind === 'throw' || r.kind === 'memory')) { // let the reveal play for a moment
      mg2.reveal = r; mg2.revealAt = performance.now(); mg2.over = true;
      setTimeout(() => showMgResult(r), r.kind === 'shell' ? 1400 : 900);
    } else showMgResult(r);
  });
  function showMgResult(r) {
    mg2 = null; $('mg2Area').classList.add('hidden');
    const name = G.MINIGAMES[r.kind].name;
    const net = r.prize - r.fee;
    const box = $('mgResult');
    box.innerHTML = `<div>${esc(name)}: ${esc(r.message || '')}</div><span class="big">${r.prize > 0 ? '+' + orbsH(r.prize) : '0&nbsp;' + ORB_I}</span>
      <div class="muted">Взнос ${r.fee} · итог ${net >= 0 ? '+' : ''}${net}${r.bonus > 0 ? ` · «Мастер мини-игр» +${Number(r.bonus) | 0}` : ''}</div>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:center">
        <button class="btn primary" id="mgAgain">Ещё раз</button><button class="btn" id="mgBack">К списку игр</button></div>`;
    box.classList.remove('hidden');
    $('reactionArea').classList.add('hidden'); $('rushArea').classList.add('hidden');
    $('mgAgain').onclick = () => startGame(r.kind);
    $('mgBack').onclick = () => { box.classList.add('hidden'); showGamesList(); updateGameButtons(); };
    if ($('games').classList.contains('hidden')) toastC('rewards', `${name}: ${r.prize > 0 ? '+' + r.prize + ' сфер' : 'без выигрыша'}`, r.prize > 0 ? 'ok' : 'err');
    if (r.prize > 0) floaters.push({ x: dispMe.x, y: dispMe.y - 40, text: '+' + r.prize, color: '#ffcc33', start: performance.now(), big: true });
    updateGameButtons();
  }

  // ---- the four newer menu games share one canvas (600×400). The server owns every outcome; the client only shows it.
  const m2cv = $('mg2Canvas'), m2 = m2cv.getContext('2d');
  const MEM_COLORS = ['#ff4d6d', '#5dff8f', '#3ea8ff', '#ffcc33'], MEM_POS = [[200, 115], [400, 115], [200, 285], [400, 285]];
  const SHELL_X = [150, 300, 450];
  const setInfo = t => { if (mg2 && mg2.info !== t) { mg2.info = t; $('mg2Info').textContent = t; } };
  const act = (d, cb) => socket.emit('mg:act', d, res => cb && cb(res || {}));
  socket.on('mg:memory:show', d => { if (!mg2 || mg2.kind !== 'memory') return; Object.assign(mg2, { round: d.round, seq: d.seq, on: d.onMs, gap: d.gapMs, lead: d.leadMs, t0: performance.now(), input: [], flash: null, sent: false }); });
  socket.on('mg:shell:setup', d => {
    if (!mg2 || mg2.kind !== 'shell') return;
    let t = d.showMs; const sw = d.swaps.map(([a, b, ms]) => { const o = { a, b, from: t, ms }; t += ms; return o; });
    Object.assign(mg2, { ball: d.start, sw, endAt: t, t0: performance.now(), picked: null });
  });
  socket.on('mg:throw:start', d => { if (!mg2 || mg2.kind !== 'throw') return; mg2.cur = Object.assign({}, d, { t0: performance.now(), stop: null }); mg2.hist = mg2.hist || []; });
  socket.on('mg:throw:stopped', d => { if (mg2 && mg2.cur && mg2.cur.i === d.i) { mg2.cur.stop = { pos: d.pos, pts: 0 }; mg2.hist.push(0); } });
  socket.on('mg:chain:setup', d => { if (!mg2 || mg2.kind !== 'chain') return; Object.assign(mg2, { orbs: d.orbs.map(o => Object.assign({}, o)), goAt: performance.now() + d.startIn, next: 1, limit: d.limitMs }); });
  function m2pt(e) { const r = m2cv.getBoundingClientRect(); return [(e.clientX - r.left) * (m2cv.width / r.width), (e.clientY - r.top) * (m2cv.height / r.height)]; }
  function throwStop() {
    const c = mg2 && mg2.kind === 'throw' && mg2.cur; if (!c || c.stop || c.sending) return;
    c.sending = true; c.localStop = performance.now();
    act({ i: c.i }, res => { c.sending = false; if (res.ok) { c.stop = { pos: res.pos, pts: res.pts }; mg2.hist.push(res.pts); } else if (res.early) { c.localStop = null; } });
  }
  m2cv.addEventListener('pointerdown', e => {
    if (!mg2 || mg2.over) return; e.preventDefault();
    const [x, y] = m2pt(e), now = performance.now();
    if (mg2.kind === 'memory' && mg2.seq && !mg2.sent && now - mg2.t0 >= mg2.lead + mg2.seq.length * (mg2.on + mg2.gap)) {
      const c = MEM_POS.findIndex(([px, py]) => Math.hypot(x - px, y - py) <= 75); if (c < 0) return;
      mg2.input.push(c); mg2.flash = { c, at: now };
      const k = mg2.input.length - 1, wrong = mg2.input[k] !== mg2.seq[k];
      if (wrong || mg2.input.length === mg2.seq.length) { mg2.sent = true; act({ round: mg2.round, input: mg2.input.slice() }); }
    } else if (mg2.kind === 'shell' && mg2.sw && mg2.picked == null && now - mg2.t0 >= mg2.endAt) {
      const slot = SHELL_X.findIndex(px => Math.abs(x - px) < 65 && y > 150 && y < 330); if (slot < 0) return;
      mg2.picked = slot; act({ cup: slot });
    } else if (mg2.kind === 'throw') throwStop();
    else if (mg2.kind === 'chain' && mg2.orbs && now >= mg2.goAt) {
      const o = mg2.orbs[mg2.next - 1]; if (!o || Math.hypot(x - o.x, y - o.y) > o.r * 1.25) { mg2.miss = now; return; }
      o.hit = now; mg2.next++;
      act({ n: o.n, x: Math.round(x), y: Math.round(y) }, res => { if (!res.ok) { o.hit = null; mg2.next = Math.min(mg2.next, o.n); } });
    }
  });
  document.addEventListener('keydown', e => { if (e.code === 'Space' && mg2 && mg2.kind === 'throw' && !$('games').classList.contains('hidden')) { e.preventDefault(); throwStop(); } });
  function orbBall(x, y, r, color, alpha) {
    m2.save(); m2.globalAlpha = alpha == null ? 1 : alpha; m2.shadowColor = color; m2.shadowBlur = r * 0.8;
    const g = m2.createRadialGradient(x - r * 0.3, y - r * 0.35, 1, x, y, r); g.addColorStop(0, '#fff'); g.addColorStop(0.35, color); g.addColorStop(1, color);
    m2.fillStyle = g; m2.beginPath(); m2.arc(x, y, r, 0, Math.PI * 2); m2.fill(); m2.restore();
  }
  function drawCup(x, y, lift) {
    m2.save(); m2.translate(x, y - lift);
    const g = m2.createLinearGradient(-55, 0, 55, 0); g.addColorStop(0, '#5a3df0'); g.addColorStop(0.5, '#9b7dff'); g.addColorStop(1, '#4a2fd0');
    m2.fillStyle = g; m2.beginPath(); m2.moveTo(-40, -70); m2.lineTo(40, -70); m2.lineTo(56, 30); m2.lineTo(-56, 30); m2.closePath(); m2.fill();
    m2.fillStyle = '#c9b8ff'; m2.fillRect(-60, 24, 120, 10); m2.fillStyle = 'rgba(255,255,255,0.25)'; m2.fillRect(-28, -62, 10, 80);
    m2.restore();
  }
  function drawMg2(now) {
    const g = m2; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#070b18'; g.fillRect(0, 0, 600, 400);
    const k = mg2.kind, R = mg2.reveal;
    if (k === 'memory') {
      let lit = -1, phase = 'wait';
      if (mg2.seq) {
        const t = now - mg2.t0 - mg2.lead, step = mg2.on + mg2.gap, i = Math.floor(t / step);
        if (t < 0) phase = 'look'; else if (i < mg2.seq.length) { phase = 'show'; if (t - i * step < mg2.on) lit = mg2.seq[i]; } else phase = 'input';
      }
      if (mg2.flash && now - mg2.flash.at < 220) lit = mg2.flash.c;
      MEM_POS.forEach(([x, y], c) => orbBall(x, y, lit === c ? 74 : 64, MEM_COLORS[c], lit === c ? 1 : 0.32));
      setInfo(R ? `Пройдено раундов: ${R.rounds}` : !mg2.seq ? 'Приготовьтесь…' : phase === 'input' ? `Раунд ${mg2.round}: повторите (${mg2.input.length}/${mg2.seq.length})` : `Раунд ${mg2.round}: запоминайте`);
      $('mg2Time').textContent = mg2.round ? `раунд ${mg2.round}/${G.MINIGAMES.memory.maxRounds}` : '';
    } else if (k === 'shell') {
      const slotX = SHELL_X; let xs = SHELL_X.slice(), ys = [0, 0, 0]; const lift = [0, 0, 0], ballSlot = mg2.ball;
      // pos[c] = slot of cup c; each swap exchanges the cups in two slots (arc animation); the orb stays with its cup
      const pos = [0, 1, 2];
      if (mg2.sw) {
        const t = now - mg2.t0; let anim = null;
        for (const s of mg2.sw) {
          if (t >= s.from + s.ms) { const ca = pos.indexOf(s.a), cb = pos.indexOf(s.b); pos[ca] = s.b; pos[cb] = s.a; }
          else { if (t > s.from) anim = s; break; }
        }
        xs = pos.map(p => slotX[p]);
        if (anim) {
          const ca = pos.indexOf(anim.a), cb = pos.indexOf(anim.b), u = (t - anim.from) / anim.ms, e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2, h = Math.sin(u * Math.PI) * 26;
          xs[ca] = slotX[anim.a] + (slotX[anim.b] - slotX[anim.a]) * e; ys[ca] = -h; xs[cb] = slotX[anim.b] + (slotX[anim.a] - slotX[anim.b]) * e; ys[cb] = h;
        }
        const showing = t < G.MINIGAMES.shell.showMs;
        if (showing) lift[pos.indexOf(ballSlot)] = 70 * Math.sin(Math.min(1, t / G.MINIGAMES.shell.showMs) * Math.PI);
        if (R) { const u = Math.min(1, (now - mg2.revealAt) / 350); lift[pos.indexOf(R.cup)] = 70 * u; if (R.pick != null && R.pick !== R.cup) lift[pos.indexOf(R.pick)] = 40 * u; }
        if (showing || R) { const bx = slotX[R ? R.cup : ballSlot]; orbBall(bx, 268, 22, '#3ee0ff'); }
        setInfo(R ? (R.prize > 0 ? 'Угадали!' : 'Мимо!') : showing ? 'Запомните, где сфера' : t < mg2.endAt ? 'Следите за чашей…' : mg2.picked != null ? 'Проверяем…' : 'Где сфера? Выберите чашу');
      } else setInfo('Приготовьтесь…');
      for (let c = 0; c < 3; c++) drawCup(xs[c], 290 + ys[c], lift[c]);
      if (mg2.picked != null && !R) { g.strokeStyle = '#ffcc33'; g.lineWidth = 3; g.strokeRect(slotX[mg2.picked] - 62, 200, 124, 140); }
      $('mg2Time').textContent = '';
    } else if (k === 'throw') {
      const c = mg2.cur, X0 = 60, X1 = 540, Y = 200, W2 = X1 - X0;
      g.fillStyle = '#141b36'; g.fillRect(X0, Y - 18, W2, 36);
      if (c) {
        const bands = G.MINIGAMES.throw.points.slice().reverse(), cols = ['rgba(255,204,51,0.18)', 'rgba(255,204,51,0.35)', 'rgba(255,204,51,0.6)', '#ffcc33'];
        bands.forEach(([d], i) => { const a = Math.max(0, c.target - d), b = Math.min(1, c.target + d); g.fillStyle = cols[i]; g.fillRect(X0 + a * W2, Y - 18, (b - a) * W2, 36); });
        const pos = c.stop ? (c.stop.pos == null ? null : c.stop.pos) : G.throwPos((c.localStop || now) - c.t0, c.period, c.phase);
        if (pos != null) { const x = X0 + pos * W2; g.fillStyle = '#fff'; g.shadowColor = '#3ee0ff'; g.shadowBlur = 12; g.beginPath(); g.moveTo(x, Y - 26); g.lineTo(x - 9, Y - 40); g.lineTo(x + 9, Y - 40); g.fill(); g.fillRect(x - 2, Y - 24, 4, 48); g.shadowBlur = 0; }
        g.font = '800 30px Segoe UI, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#ffcc33';
        if (c.stop) g.fillText(c.stop.pos == null ? 'Не успели' : c.stop.pts ? `+${c.stop.pts}` : 'Мимо', 300, 300);
        const total = (mg2.hist || []).reduce((a, b) => a + b, 0);
        setInfo(`Бросок ${c.i + 1}/${c.of} · очки: ${total}`);
        g.font = '600 16px Segoe UI, sans-serif'; g.fillStyle = '#aab3d9'; g.fillText('Тапните или нажмите пробел, чтобы остановить', 300, 120);
      } else setInfo('Приготовьтесь…');
      $('mg2Time').textContent = '';
    } else if (k === 'chain') {
      if (mg2.orbs) {
        const left = mg2.goAt - now;
        for (const o of mg2.orbs) {
          const done = o.n < mg2.next; if (done && o.hit && now - o.hit > 250) continue;
          orbBall(o.x, o.y, o.r, o.n === mg2.next ? '#ffcc33' : '#3ee0ff', done ? Math.max(0, 1 - (now - o.hit) / 250) : left > 0 ? 0.5 : 1);
          g.fillStyle = '#071022'; g.font = '800 22px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(o.n), o.x, o.y + 1);
        }
        g.textBaseline = 'alphabetic';
        if (left > 0) { g.fillStyle = '#fff'; g.font = '800 64px Segoe UI, sans-serif'; g.textAlign = 'center'; g.fillText(String(Math.ceil(left / 400)), 300, 220); }
        if (mg2.miss && now - mg2.miss < 200) { g.strokeStyle = 'rgba(255,77,109,0.7)'; g.lineWidth = 6; g.strokeRect(3, 3, 594, 394); }
        setInfo(left > 0 ? 'Приготовьтесь…' : `Следующая: ${Math.min(mg2.next, G.MINIGAMES.chain.n)}`);
        $('mg2Time').textContent = left > 0 ? '' : ((Math.min(now - mg2.goAt, mg2.limit)) / 1000).toFixed(2) + ' с';
      } else setInfo('Приготовьтесь…');
    }
  }

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
    if (m.em && G.ITEM_BY_ID[m.em]) { el.classList.add('emo-msg'); t.className = 't emo-big'; t.title = G.ITEM_BY_ID[m.em].name; }
    else if (/^(\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u.test(t.textContent) && t.textContent.trim()) t.classList.add('emo-only');
    return el;
  }
  // two tabs: 'chat' (players, input) and 'sys' (system messages, read-only); choice kept in localStorage
  const sysLog = $('sysLog'), tabUnread = { chat: 0, sys: 0 };
  let chatTab = store.get('ocs_chat_tab') === 'sys' ? 'sys' : 'chat';
  const tabLog = t => (t === 'sys' ? sysLog : chatLog);
  function paintTabs() {
    for (const t of ['chat', 'sys']) {
      const btn = $(t === 'sys' ? 'tabSys' : 'tabChat'), b = $(t === 'sys' ? 'tabSysBadge' : 'tabChatBadge'), on = t === chatTab;
      btn.classList.toggle('active', on); btn.setAttribute('aria-selected', on ? 'true' : 'false');
      tabLog(t).classList.toggle('hidden', !on);
      b.textContent = tabUnread[t] > 99 ? '99+' : String(tabUnread[t]); b.classList.toggle('hidden', on || !tabUnread[t]);
    }
    $('chatForm').classList.toggle('hidden', chatTab === 'sys');
  }
  function setChatTab(t) {
    chatTab = t === 'sys' ? 'sys' : 'chat'; store.set('ocs_chat_tab', chatTab); tabUnread[chatTab] = 0; paintTabs();
    const log = tabLog(chatTab); log.scrollTop = log.scrollHeight;
    if (chatTab === 'sys' && document.activeElement === chatInput) chatInput.blur();
  }
  for (const b of document.querySelectorAll('.chat-tab')) b.addEventListener('click', e => { e.stopPropagation(); setChatTab(b.dataset.tab); });
  paintTabs();
  function addChat(m, live) {
    if (!m || typeof m !== 'object') return;
    const tab = m.sys ? 'sys' : 'chat', log = tabLog(tab);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(chatLine(m));
    while (log.childElementCount > 100) log.firstElementChild.remove();
    if (atBottom || m.notice || (m.n && m.n === myName)) log.scrollTop = log.scrollHeight;
    if (live && tab !== chatTab) { tabUnread[tab]++; paintTabs(); }
    if (live && joined && mobileUI() && !chatOpen && m.n && m.n !== myName) { unread++; updateBadge(); showChatToast(m); }
  }
  function resetChat(history) {
    chatLog.textContent = ''; sysLog.textContent = ''; unread = 0; tabUnread.chat = tabUnread.sys = 0; updateBadge(); paintTabs();
    for (const m of history) addChat(m, false);
    chatLog.scrollTop = chatLog.scrollHeight; sysLog.scrollTop = sysLog.scrollHeight;
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
    tabLog(chatTab).scrollTop = tabLog(chatTab).scrollHeight;
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
      if (res && res.cmd) { addChat({ notice: !res.ok, sys: false, t: (res.ok ? '✔ ' + (res.msg || 'OK') : '✖ ' + (res.error || 'Ошибка')) }); return; } // admin command: local echo only
      if (!res || !res.ok) {
        addChat({ notice: true, t: (res && res.error) || 'Сообщение не отправлено' });
        if (!chatInput.value) chatInput.value = text; // let the player retry
      }
    });
    chatInput.value = '';
    if (!mobileUI()) chatInput.blur();
  });

  // ------------------------------------------------------------ admin effects (disco, x2), announcements, admin panel
  let isAdminMe = false, discoEnd = 0, x2End = 0, discoWas = false, cev = null, weatherNow = '', nightNow = false, restartEnd = 0;
  function setFx(f, silent) {
    f = f || {}; const now = performance.now();
    const wasDisco = discoEnd > now;
    discoEnd = f.disco > 0 ? now + f.disco : 0; x2End = f.x2 > 0 ? now + f.x2 : 0;
    cev = f.custom ? Object.assign({}, f.custom, { end: now + f.custom.left }) : null; weatherNow = f.weather || ''; nightNow = !!f.night; restartEnd = f.restart > 0 ? now + f.restart : 0;
    if (!silent && cev && !f._seen) toastC('events', `⭐ Событие «${cev.name}»!`, 'ok');
    if (!silent && !wasDisco && discoEnd) toastC('disco', '🪩 Диско-ивент! Сферы ×1,5 и удача ×1,5', 'ok');
    updateFx();
  }
  function fmtLeft(ms) { const s = Math.ceil(ms / 1000), m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s} с`; }
  function updateFx() {
    const now = performance.now(), dl = discoEnd - now, xl = x2End - now, d = joined && dl > 0;
    $('discoChip').classList.toggle('hidden', !d); $('x2Chip').classList.toggle('hidden', !(joined && xl > 0));
    if (d) { $('discoChipTime').textContent = fmtLeft(dl); $('discoChipPhase').textContent = 'Осталось ' + fmtLeft(dl); }
    if (joined && xl > 0) { $('x2ChipTime').textContent = fmtLeft(xl); $('x2ChipPhase').textContent = 'Осталось ' + fmtLeft(xl); }
    $('discoFx').classList.toggle('hidden', !d);
    const cl = cev ? cev.end - now : 0, ce = joined && cl > 0; cevSpd = ce ? cev.spd : 1;
    $('cevChip').classList.toggle('hidden', !ce);
    if (ce) { $('cevChipTime').textContent = fmtLeft(cl); $('cevChipName').textContent = '⭐ ' + cev.name; $('cevChipPhase').textContent = 'Осталось ' + fmtLeft(cl); $('cevChipDesc').textContent = `Сферы ×${cev.orb}, удача ×${cev.luck}, скорость ×${cev.spd}`; }
    const wx = $('weatherFx'); wx.className = 'weather-fx' + (joined && weatherNow ? ' ' + weatherNow : ' hidden');
    $('nightFx').classList.toggle('hidden', !(joined && nightNow));
    const rl = restartEnd - now; $('restartBar').classList.toggle('hidden', !(rl > 0)); if (rl > 0) $('restartBar').textContent = `⚠️ Перезапуск сервера через ${fmtLeft(rl)}`;
    if (d !== discoWas) { discoWas = d; music.setDisco(d); if (!d && joined && discoEnd) toastC('disco', '🪩 Диско закончилось', ''); }
    const go = $('admDiscoGo'); if (go) go.textContent = dl > 0 ? '⏹ Выключить диско' : '🪩 Включить диско';
  }
  setInterval(updateFx, 500);
  socket.on('fx', f => setFx(f));
  socket.on('adm:self', s => { if (s) selfFx = { spd: Number(s.spd) || 1, frozen: !!s.frozen, god: !!s.god, invis: !!s.invis }; });
  socket.on('chat:clear', () => { chatLog.textContent = ''; });
  let annT = null;
  socket.on('adm:warn', w => {
    if (!w) return; $('annOverlay').classList.add('warn'); $('annTitle').textContent = `⚠️ Предупреждение от администратора (${w.n})`;
    $('annText').textContent = String(w.r) + (w.muted ? ' — чат отключён на 10 мин.' : ''); $('annOverlay').classList.remove('hidden');
    clearTimeout(annT); annT = setTimeout(() => $('annOverlay').classList.add('hidden'), 8000);
  });
  socket.on('adm:announce', a => {
    if (!a || !a.t) return; $('annOverlay').classList.remove('warn'); $('annTitle').textContent = '📢 Объявление';
    $('annText').textContent = String(a.t); $('annOverlay').classList.remove('hidden');
    clearTimeout(annT); annT = setTimeout(() => $('annOverlay').classList.add('hidden'), 6000);
  });
  $('annOverlay').addEventListener('click', () => $('annOverlay').classList.add('hidden'));

  const adm = (d, cb) => socket.emit('adm', d, r => { r = r || { ok: false, error: 'Нет ответа' }; const m = $('admMsg'); m.textContent = r.ok ? '✔ ' + (r.msg || 'Готово') : '✖ ' + (r.error || 'Ошибка'); m.classList.toggle('err', !r.ok); if (r.players) admPlayers(r.players); if (r.bans) admBans(r.bans); if (r.codes) admCodes(r.codes); if (cb) cb(r); });
  const opt = (sel, list) => { sel.textContent = ''; for (const [v, t] of list) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); } };
  const mkBtn = (txt, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = txt; b.addEventListener('click', fn); return b; };
  function admPlayers(list) {
    const box = $('admPlayers'); box.textContent = '';
    for (const p of list) {
      const row = document.createElement('div'); row.className = 'adm-pl' + (p.name === admSel ? ' sel' : ''); row.dataset.name = p.name; row.title = 'Выбрать игрока';
      const n = document.createElement('b'); n.textContent = p.name + (p.admin ? ' 🛡️' : '') + (p.muted ? ' 🔇' : '') + (p.frozen ? ' ❄️' : ''); row.appendChild(n);
      if (!p.admin) {
        row.append(mkBtn('📍', () => adm({ a: 'cmd', text: '/tp ' + p.name })), mkBtn(p.frozen ? '🔥' : '❄️', () => adm({ a: 'cmd', text: (p.frozen ? '/unfreeze ' : '/freeze ') + p.name }, () => adm({ a: 'players' }))),
          mkBtn(p.muted ? '🔊' : '🔇', () => adm({ a: 'cmd', text: p.muted ? '/unmute ' + p.name : '/mute ' + p.name + ' 10' }, () => adm({ a: 'players' }))),
          mkBtn('Кик', () => adm({ a: 'kick', name: p.name })), mkBtn('Бан', () => admConfirm('Забанить ' + p.name + '?', () => adm({ a: 'ban', name: p.name })), 'danger'));
      }
      box.appendChild(row);
    }
    opt($('admGivePl'), list.map(p => [p.name, p.name])); opt($('admPl2'), list.map(p => [p.name, p.name]));
    admOnline = list; if (admSel) admSelect(admSel);
  }
  function admBans(list) {
    const box = $('admBans'); box.textContent = '';
    if (!list.length) { box.textContent = 'Нет'; return; }
    for (const b of list) { const row = document.createElement('div'); row.className = 'adm-pl'; const n = document.createElement('b'); n.textContent = b.name; row.append(n, mkBtn('Разбанить', () => adm({ a: 'unban', name: b.name }))); box.appendChild(row); }
  }
  function openAdmin() {
    if (!isAdminMe) return;
    openModal('admin');
    if (window.OCSAdmOpened) window.OCSAdmOpened();
    adm({ a: 'init' }, r => {
      if (!r.ok) return;
      const ev = $('admEvents'); ev.textContent = ''; for (const e of r.events) ev.appendChild(mkBtn(e.name, () => adm({ a: 'event', kind: e.k })));
      const mi = $('admMinis'); mi.textContent = ''; for (const e of r.minis) mi.appendChild(mkBtn(e.icon + ' ' + e.name, () => adm({ a: 'mini', kind: e.k })));
      opt($('admRarity'), r.rarities.map(x => [x.k, x.name])); opt($('admRainT'), r.rarities.map(x => [x.k, x.name])); opt($('admGiveItem'), r.items.map(x => [x.id, x.name])); opt($('admCodeItem'), [['', 'без предмета']].concat(r.items.map(x => [x.id, x.name])));
      if (r.players) admPlayers(r.players);
      $('admMsg').textContent = '';
    });
  }
  $('admBtn').addEventListener('click', e => { e.stopPropagation(); openAdmin(); });
  for (const t of document.querySelectorAll('.adm-tab')) t.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.adm-tab')) x.classList.toggle('active', x === t);
    for (const s of document.querySelectorAll('.adm-sec')) s.classList.toggle('hidden', s.dataset.sec !== t.dataset.sec);
    if (t.dataset.sec === 'pl') { adm({ a: 'players' }); adm({ a: 'bans' }); }
    if (t.dataset.sec === 'codes') adm({ a: 'codes' });
    if (t.dataset.sec === 'log') admLoadLog();
  });
  $('admin').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && e.target.id === 'admCmd') $('admCmdGo').click(); });
  $('admBoss').addEventListener('click', () => adm({ a: 'boss' }));
  $('admOrbGo').addEventListener('click', () => adm({ a: 'orbs', t: $('admRarity').value, n: Number($('admOrbN').value), where: $('admOrbWhere').value }));
  $('admObsGo').addEventListener('click', () => adm({ a: 'obstacle', kind: $('admObsKind').value, where: $('admObsWhere').value }));
  $('admPlRefresh').addEventListener('click', () => { adm({ a: 'players' }); adm({ a: 'bans' }); });
  $('admGiveWhat').addEventListener('change', () => $('admGiveItem').classList.toggle('hidden', $('admGiveWhat').value !== 'item'));
  $('admGiveGo').addEventListener('click', () => adm({ a: 'give', name: $('admGivePl').value, what: $('admGiveWhat').value, item: $('admGiveItem').value, qty: Number($('admGiveQty').value) }));
  $('admBanGo').addEventListener('click', () => { const n = $('admBanName').value.trim(); if (n) adm({ a: 'ban', name: n }); });
  $('admCmdGo').addEventListener('click', () => { const t = $('admCmd').value.trim(); if (t) adm({ a: 'cmd', text: t }, r => { if (r.ok) $('admCmd').value = ''; }); });
  $('admDiscoGo').addEventListener('click', () => adm({ a: 'disco', min: Number($('admDiscoMin').value) }));
  function admCodes(list) {
    const box = $('admCodes'); box.textContent = ''; if (!list.length) { box.textContent = 'Нет'; return; }
    for (const c of list) { const row = document.createElement('div'); row.className = 'adm-pl'; const n = document.createElement('b'); const rw = c.rewards || {};
      n.textContent = `${c.code} · ${[rw.orbs ? rw.orbs + ' сфер' : '', rw.shards ? rw.shards + ' оск.' : '', rw.items ? rw.items.map(i => i.id).join(',') : ''].filter(Boolean).join(', ')} · ${c.uses}/${c.maxUses || '∞'}${c.expiresAt ? ' · до ' + new Date(c.expiresAt).toLocaleDateString('ru-RU') : ''}${c.disabled ? ' · ВЫКЛ' : ''}`;
      row.append(n, mkBtn(c.disabled ? 'Включить' : 'Отключить', () => adm({ a: 'code:toggle', code: c.code }))); box.appendChild(row); }
  }
  function admLoadLog() { socket.emit('adm', { a: 'log' }, r => { const box = $('admLog'); box.textContent = ''; if (!r || !r.ok) return; for (const e of r.log) { const d = document.createElement('div'); d.textContent = `${new Date(e.at).toLocaleTimeString('ru-RU')} ${e.by}: ${e.action} ${e.d || ''}`; box.appendChild(d); } }); }
  $('admBossTimer').addEventListener('click', () => adm({ a: 'bosstimer' }));
  $('admCevGo').addEventListener('click', () => adm({ a: 'custom', name: $('admCevName').value, orb: $('admCevOrb').value, luck: $('admCevLuck').value, spd: $('admCevSpd').value, min: $('admCevMin').value }));
  $('admRainGo').addEventListener('click', () => adm({ a: 'rain', t: $('admRainT').value, n: Number($('admRainN').value), sec: Number($('admRainSec').value) }));
  $('admInfoGo').addEventListener('click', () => adm({ a: 'info', name: $('admPl2').value }, r => { const i = r.info; $('admInfo').textContent = !r.ok ? '' : `${i.name}${i.online ? ' (онлайн)' : ''}\nБаланс: ${i.balance} · всего ${i.total} · осколки ${i.shards}\nПредметы: ${i.items} (ячеек ${i.slots}) · в игре ${i.playMin} мин\nПредупреждения: ${i.warns.length}${i.warns.length ? ' — ' + i.warns.slice(-3).map(w => w.r).join('; ') : ''}\nБан: ${i.banned ? 'да' : 'нет'} · мут: ${i.mutedMin ? i.mutedMin + ' мин' : 'нет'}`; }));
  $('admWarnGo').addEventListener('click', () => adm({ a: 'warn', name: $('admPl2').value, reason: $('admWarnReason').value }, r => { if (r.ok) $('admWarnReason').value = ''; }));
  $('admTrSizeGo').addEventListener('click', () => adm({ a: 'troll', name: $('admPl2').value, size: Number($('admTrSize').value), sec: Number($('admTrSec').value) }));
  $('admTrColorGo').addEventListener('click', () => adm({ a: 'troll', name: $('admPl2').value, color: $('admTrColor').value, sec: Number($('admTrSec').value) }));
  for (const b of document.querySelectorAll('#admin [data-w]')) b.addEventListener('click', () => adm({ a: 'weather', w: b.dataset.w }));
  $('admNight').addEventListener('click', () => adm({ a: 'night' }));
  $('admInvis').addEventListener('click', () => adm({ a: 'invis' }));
  $('admGiftGo').addEventListener('click', () => adm({ a: 'gift', what: $('admGiftWhat').value, n: Number($('admGiftN').value) }));
  $('admRestartGo').addEventListener('click', () => adm({ a: 'restart', sec: Number($('admRestartSec').value) }));
  $('admRestartOff').addEventListener('click', () => adm({ a: 'restart', sec: 0 }));
  $('admCodeGo').addEventListener('click', () => adm({ a: 'code:create', code: $('admCode').value, orbs: $('admCodeOrbs').value, shards: $('admCodeShards').value, item: $('admCodeItem').value, maxUses: $('admCodeMax').value, days: $('admCodeDays').value }, r => { if (r.ok) $('admCode').value = ''; }));
  $('admLogRefresh').addEventListener('click', admLoadLog);
  window.OCSFx = () => ({ cev: !!cev && cev.end > performance.now(), weather: weatherNow, night: nightNow, restart: restartEnd > performance.now(), disco: discoEnd > performance.now(), x2: x2End > performance.now(), overlay: !$('discoFx').classList.contains('hidden'), admin: isAdminMe, btn: !$('admBtn').classList.contains('hidden'), selfFx });

  // ------------------------------------------------------------ admin fun events (hunt, giant orb, chaos, lava, ghost, map freeze, chest, poll)
  let funS = {}, funAt = performance.now(), pollS = null, myVote = null;
  function setFun(f) { funS = f || {}; funAt = performance.now(); updateFunBar(); }
  const funLeft = ms => Math.max(0, ms - (performance.now() - funAt));
  function funSpeedMult() { if (isAdminMe) return 1; if (funS.freeze) return 0; return funS.chaos && funLeft(funS.chaos) > 0 ? -1 : 1; }
  function updateFunBar() {
    const parts = [];
    if (funS.hunt && funLeft(funS.hunt.left) > 0) parts.push(`🏃 Охота на админа ${fmtLeft(funLeft(funS.hunt.left))}`);
    if (funS.giant) parts.push(`🟣 Гигантская сфера ${fmtLeft(funLeft(funS.giant.left))} · коснулись ${funS.giant.n}`);
    if (funS.chaos && funLeft(funS.chaos) > 0) parts.push(`🌀 Хаос ${fmtLeft(funLeft(funS.chaos))}`);
    if (funS.lava && funLeft(funS.lava.left) > 0) parts.push(`🌋 Лава ${fmtLeft(funLeft(funS.lava.left))}`);
    if (funS.ghost) parts.push('👻 Призрак на охоте');
    if (funS.freeze) parts.push('🧊 Карта заморожена');
    if (funS.chest) parts.push('🎁 Сундук спрятан');
    const b = $('funBar'); b.textContent = parts.join('  ·  '); b.classList.toggle('hidden', !(joined && parts.length));
    $('lavaFx').classList.toggle('hidden', !(joined && funS.lava && funLeft(funS.lava.left) > 0));
  }
  setInterval(updateFunBar, 500);
  socket.on('fun', setFun);
  function drawFunUnder(g, t) {
    if (funS.lava && funLeft(funS.lava.left) > 0) for (const i of funS.lava.islands) { g.beginPath(); g.arc(i.x, i.y, i.r, 0, Math.PI * 2); g.fillStyle = 'rgba(80,255,160,.18)'; g.fill(); g.lineWidth = 4; g.strokeStyle = 'rgba(120,255,180,.8)'; g.stroke(); }
  }
  function drawFunOver(g, t) {
    if (funS.giant) { const p = funS.giant, k = 1 + Math.sin(t * 3) * 0.04; g.save(); g.shadowColor = '#c46bff'; g.shadowBlur = 40; g.beginPath(); g.arc(p.x, p.y, p.r * k, 0, Math.PI * 2);
      const gr = g.createRadialGradient(p.x - 20, p.y - 20, 8, p.x, p.y, p.r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.3, '#e0a8ff'); gr.addColorStop(1, '#7a2bd6'); g.fillStyle = gr; g.fill(); g.restore();
      g.font = '800 16px Segoe UI, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText(`${p.total} сфер на всех`, p.x, p.y - p.r - 12); }
    if (funS.chest) { const c = funS.chest; g.font = '44px Segoe UI Emoji, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🎁', c.x, c.y + Math.sin(t * 4) * 4); g.textBaseline = 'alphabetic'; }
    const hl = (id, col) => { const p = players.get(id); if (!p || !p.pos) return; g.beginPath(); g.arc(p.pos.x, p.pos.y, G.PLAYER_R * (p.sz || 1) + 10 + Math.sin(t * 6) * 3, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = col; g.stroke(); };
    if (funS.ghost) { hl(funS.ghost, 'rgba(255,80,110,.9)'); const p = players.get(funS.ghost); if (p && p.pos) { g.font = '26px Segoe UI Emoji, sans-serif'; g.textAlign = 'center'; g.fillText('👻', p.pos.x, p.pos.y - 44); } }
    if (funS.hunt && funLeft(funS.hunt.left) > 0) for (const p of players.values()) if (p.name === 'DragonzTV') hl(p.id, 'rgba(255,220,60,.95)');
  }
  // poll
  function renderPoll() {
    const box = $('pollBox'); if (!pollS || !joined) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden'); $('pollQ').textContent = '📊 ' + pollS.q + (pollS.done ? ' — итоги' : '');
    const tot = pollS.counts.reduce((a, b) => a + b, 0) || 1, list = $('pollOpts'); list.textContent = '';
    pollS.opts.forEach((o, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'poll-opt' + (myVote === i ? ' mine' : ''); b.disabled = !!pollS.done;
      const bar = document.createElement('i'); bar.style.width = Math.round(pollS.counts[i] / tot * 100) + '%'; const tx = document.createElement('span'); tx.textContent = `${o} — ${pollS.counts[i]}`; b.append(bar, tx);
      b.addEventListener('click', () => socket.emit('poll:vote', { id: pollS.id, i }, r => { if (r && r.ok) { myVote = i; renderPoll(); } })); list.appendChild(b); });
  }
  socket.on('poll', p => { if (p && (!pollS || pollS.id !== p.id)) myVote = null; pollS = p; renderPoll(); if (p && p.done) setTimeout(() => { if (pollS && pollS.id === p.id && pollS.done) { pollS = null; renderPoll(); } }, 10000); });
  $('pollClose').addEventListener('click', () => $('pollBox').classList.add('hidden'));
  // panel: fun tab
  const fv = id => $(id).value;
  $('admHuntGo').addEventListener('click', () => adm({ a: 'fun', kind: 'hunt', o: { orbs: fv('admHuntOrbs'), shards: fv('admHuntShards'), min: fv('admHuntMin') } }));
  $('admGiantGo').addEventListener('click', () => adm({ a: 'fun', kind: 'giant', o: { total: fv('admGiantTotal'), sec: fv('admGiantSec') } }));
  $('admChaosGo').addEventListener('click', () => adm({ a: 'fun', kind: 'chaos', o: { sec: 60 } }));
  $('admLavaGo').addEventListener('click', () => adm({ a: 'fun', kind: 'lava', o: { sec: fv('admLavaSec') } }));
  $('admGhostGo').addEventListener('click', () => adm({ a: 'fun', kind: 'ghost', o: { sec: fv('admGhostSec') } }));
  $('admFreezeAllGo').addEventListener('click', () => adm({ a: 'fun', kind: 'freeze' }));
  $('admChestGo').addEventListener('click', () => adm({ a: 'fun', kind: 'chest', o: { orbs: fv('admChestOrbs'), shards: fv('admChestShards'), min: 10 } }));
  $('admPollGo').addEventListener('click', () => adm({ a: 'fun', kind: 'poll', o: { q: fv('admPollQ'), opts: fv('admPollOpts').split('|').map(x => x.trim()).filter(Boolean), sec: fv('admPollSec') } }));
  $('admPollEnd').addEventListener('click', () => adm({ a: 'fun', kind: 'endpoll' }));
  // ------------------------------------------------------------ admin panel v2 UX (client-side only; the server still authorizes every 'adm' call)
  const LS = { get: (k, d) => { try { const v = JSON.parse(localStorage.getItem('ocsAdm.' + k)); return v == null ? d : v; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem('ocsAdm.' + k, JSON.stringify(v)); } catch (e) {} } };
  const admCard = document.querySelector('#admin .adm-card');
  let admSel = '', admOnline = [];
  // custom confirm (only for destructive actions)
  let confirmCb = null;
  function admConfirm(text, cb) { $('admConfirmText').textContent = text; confirmCb = cb; $('admConfirm').classList.remove('hidden'); $('admConfirmYes').focus(); }
  $('admConfirmYes').addEventListener('click', () => { $('admConfirm').classList.add('hidden'); const f = confirmCb; confirmCb = null; if (f) f(); });
  $('admConfirmNo').addEventListener('click', () => { $('admConfirm').classList.add('hidden'); confirmCb = null; });
  const DESTRUCTIVE = { admBanGo: () => `Забанить ${$('admBanName').value || '?'}?`, admGiftGo: () => `Подарить всем онлайн ${$('admGiftN').value} ${$('admGiftWhat').value === 'shards' ? 'осколков' : 'сфер'}?`,
    admRestartGo: () => `Запустить отсчёт перезапуска (${$('admRestartSec').value} с)?`, admFreezeAllGo: () => (funS.freeze ? 'Разморозить карту?' : 'Заморозить всю карту?') };
  const CMD_DESTRUCTIVE = /^\/(clearchat|gift|restart(?! off))\b/i;
  document.querySelector('#admin').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b._ok) { if (b) b._ok = false; return; }
    let q = DESTRUCTIVE[b.id] && DESTRUCTIVE[b.id]();
    if (b.id === 'admCmdGo' && CMD_DESTRUCTIVE.test($('admCmd').value.trim())) q = `Выполнить «${$('admCmd').value.trim()}»?`;
    if (!q) return;
    e.stopImmediatePropagation(); e.preventDefault(); admConfirm(q, () => { b._ok = true; b.click(); });
  }, true);
  // groups: wrap each <h4> + following nodes into a collapsible group
  const collapsed = LS.get('collapsed', {});
  for (const sec of document.querySelectorAll('#admin .adm-sec')) {
    const kids = Array.from(sec.childNodes); let grp = null;
    for (const n of kids) {
      if (n.nodeType === 1 && n.tagName === 'H4') {
        grp = document.createElement('div'); grp.className = 'adm-grp'; const key = sec.dataset.sec + ':' + n.textContent.trim().slice(0, 24); grp.dataset.key = key;
        sec.insertBefore(grp, n); grp.appendChild(n); const body = document.createElement('div'); body.className = 'adm-grp-body'; grp.appendChild(body); grp._body = body;
        n.classList.add('adm-grp-h'); n.tabIndex = 0; if (collapsed[key]) grp.classList.add('collapsed');
        const gg = grp; n.addEventListener('click', e => { if (e.target.closest('button')) return; gg.classList.toggle('collapsed'); collapsed[key] = gg.classList.contains('collapsed'); LS.set('collapsed', collapsed); });
      } else if (grp) grp._body.appendChild(n);
    }
  }
  // tabs: remember last tab
  const showTab = sec => { const t = document.querySelector(`.adm-tab[data-sec="${sec}"]`); if (t) t.click(); };
  for (const t of document.querySelectorAll('.adm-tab')) t.addEventListener('click', () => LS.set('tab', t.dataset.sec));
  // search: filters actions (buttons / groups) across all tabs
  function admSearch() {
    const q = $('admSearch').value.trim().toLowerCase(), tabs = document.querySelector('#admin .adm-tabs');
    const secs = document.querySelectorAll('#admin .adm-sec'); let any = false;
    tabs.classList.toggle('dim', !!q);
    for (const s of secs) {
      if (!q) { s.classList.toggle('hidden', s.dataset.sec !== (document.querySelector('.adm-tab.active') || {}).dataset?.sec); s.classList.remove('searching'); }
      else s.classList.add('searching');
      let secHit = false;
      for (const g of s.querySelectorAll('.adm-grp')) {
        const hit = !q || g.textContent.toLowerCase().includes(q) || Array.from(g.querySelectorAll('input[placeholder],option')).some(x => (x.placeholder || x.textContent).toLowerCase().includes(q));
        g.classList.toggle('adm-miss', !hit); if (q && hit) g.classList.remove('collapsed'); if (hit) secHit = true;
        if (q) for (const b of g.querySelectorAll('.adm-grid > .btn')) b.classList.toggle('adm-hit', b.textContent.toLowerCase().includes(q));
        else for (const b of g.querySelectorAll('.adm-hit')) b.classList.remove('adm-hit');
      }
      const plain = !s.querySelector('.adm-grp') && (!q || s.textContent.toLowerCase().includes(q));
      if (q) s.classList.toggle('hidden', !(secHit || plain)); if (secHit || plain) any = true;
    }
    $('admNoRes').classList.toggle('hidden', !q || any);
  }
  $('admSearch').addEventListener('input', admSearch);
  // recent / favourites (stores button ids only)
  let recent = LS.get('recent', []), favs = LS.get('favs', []);
  const btnLabel = b => (b.textContent || b.title || b.id).trim().slice(0, 28);
  function renderFav() {
    const box = $('admFav'); box.textContent = ''; const ids = favs.concat(recent.filter(x => !favs.includes(x))).slice(0, 8);
    for (const id of ids) { const b = $(id) || document.querySelector(`#admin [data-w="${id.slice(2)}"]`); if (!b) continue;
      const chip = document.createElement('span'); chip.className = 'adm-chip' + (favs.includes(id) ? ' fav' : '');
      const go = document.createElement('button'); go.type = 'button'; go.className = 'adm-chip-go'; go.textContent = btnLabel(b); go.title = 'Выполнить'; go.addEventListener('click', () => b.click());
      const st = document.createElement('button'); st.type = 'button'; st.className = 'adm-chip-star'; st.textContent = favs.includes(id) ? '★' : '☆'; st.title = 'В избранное';
      st.addEventListener('click', () => { favs = favs.includes(id) ? favs.filter(x => x !== id) : favs.concat(id).slice(-8); LS.set('favs', favs); renderFav(); });
      chip.append(st, go); box.appendChild(chip); }
    box.classList.toggle('hidden', !box.childNodes.length);
  }
  document.querySelector('#admin').addEventListener('click', e => {
    const b = e.target.closest('.adm-sec button'); if (!b) return; const id = b.id || (b.dataset.w ? 'w:' + b.dataset.w : ''); if (!id || /Refresh$/.test(id)) return;
    recent = [id].concat(recent.filter(x => x !== id)).slice(0, 6); LS.set('recent', recent); renderFav();
  });
  // player picker (search / autocomplete), shared by every player action
  function admSelect(name) {
    admSel = name || ''; $('admPick').value = admSel; $('admPickList').classList.add('hidden');
    for (const id of ['admPl2', 'admGivePl']) { const s = $(id); if (admSel && !Array.from(s.options).some(o => o.value === admSel)) { const o = document.createElement('option'); o.value = o.textContent = admSel; s.appendChild(o); } if (admSel) s.value = admSel; }
    if (admSel) $('admBanName').value = admSel;
    for (const r of document.querySelectorAll('#admPlayers .adm-pl')) r.classList.toggle('sel', r.dataset.name === admSel);
    renderPickActs();
  }
  function renderPickActs() {
    const box = $('admPickActs'); box.textContent = ''; box.classList.toggle('hidden', !admSel); if (!admSel) return;
    const p = admOnline.find(x => x.name === admSel) || {}; const n = admSel;
    const lab = document.createElement('b'); lab.textContent = '👤 ' + n + (p.name ? '' : ' (не в сети)'); box.appendChild(lab);
    box.append(mkBtn('ℹ️ Инфо', () => $('admInfoGo').click()), mkBtn('📍 К игроку', () => adm({ a: 'cmd', text: '/tp ' + n })), mkBtn('🧲 Ко мне', () => adm({ a: 'cmd', text: '/tphere ' + n })),
      mkBtn(p.frozen ? '🔥 Разморозить' : '❄️ Заморозить', () => adm({ a: 'cmd', text: (p.frozen ? '/unfreeze ' : '/freeze ') + n }, () => adm({ a: 'players' }))),
      mkBtn(p.muted ? '🔊 Размутить' : '🔇 Мут 10 мин', () => adm({ a: 'cmd', text: p.muted ? '/unmute ' + n : '/mute ' + n + ' 10' }, () => adm({ a: 'players' }))),
      mkBtn('⚠️ Предупредить', () => { showTab('pl'); $('admWarnReason').focus(); }), mkBtn('🎁 Выдать', () => { showTab('pl'); $('admGiveQty').focus(); }),
      mkBtn('Кик', () => adm({ a: 'kick', name: n })), mkBtn('Бан', () => admConfirm('Забанить ' + n + '?', () => adm({ a: 'ban', name: n })), 'danger'), mkBtn('✕', () => admSelect(''), 'adm-x'));
  }
  function pickAc() {
    const q = $('admPick').value.trim().toLowerCase(), box = $('admPickList'); box.textContent = '';
    const list = admOnline.filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 8);
    for (const p of list) { const o = document.createElement('div'); o.className = 'adm-ac-i'; o.textContent = p.name + (p.admin ? ' 🛡️' : ''); o.addEventListener('mousedown', e => { e.preventDefault(); admSelect(p.name); }); box.appendChild(o); }
    if (q && !list.some(p => p.name.toLowerCase() === q)) { const o = document.createElement('div'); o.className = 'adm-ac-i muted'; o.textContent = `Офлайн: «${$('admPick').value.trim()}»`; o.addEventListener('mousedown', e => { e.preventDefault(); admSelect($('admPick').value.trim()); }); box.appendChild(o); }
    box.classList.toggle('hidden', !box.childNodes.length);
  }
  $('admPick').addEventListener('focus', () => { if (!admOnline.length) adm({ a: 'players' }); pickAc(); });
  $('admPick').addEventListener('input', pickAc);
  $('admPick').addEventListener('blur', () => setTimeout(() => $('admPickList').classList.add('hidden'), 120));
  $('admPick').addEventListener('keydown', e => { if (e.key === 'Enter') { const f = $('admPickList').querySelector('.adm-ac-i'); if (f) f.dispatchEvent(new MouseEvent('mousedown')); } if (e.key === 'Escape') admSelect(''); });
  $('admPlayers').addEventListener('click', e => { const r = e.target.closest('.adm-pl'); if (r && !e.target.closest('button')) admSelect(r.dataset.name); });
  // command autocomplete + usage hints
  const CMDS = [['/announce', '<текст>', 'объявление всем'], ['/tp', '<ник>', 'телепорт к игроку'], ['/tphere', '<ник>', 'игрока к себе'], ['/x2', '<мин|0>', 'сферы ×2 (0 — выкл)'], ['/mute', '<ник> <мин>', 'мут'], ['/unmute', '<ник>', 'снять мут'],
    ['/clearchat', '', 'очистить чат'], ['/freeze', '<ник>', 'заморозить'], ['/unfreeze', '<ник>', 'разморозить'], ['/god', '', 'неуязвимость'], ['/speed', '<0.1–5>', 'своя скорость'], ['/disco', '[мин]', 'диско вкл/выкл'],
    ['/rain', '<тип> [кол-во] [сек]', 'дождь из сфер'], ['/invis', '', 'невидимость'], ['/size', '<ник> <0.3–3> [сек]', 'размер игрока'], ['/skin', '<ник> <#rrggbb> [сек]', 'цвет игрока'], ['/info', '<ник>', 'инфо об игроке'],
    ['/warn', '<ник> <причина>', 'предупреждение'], ['/gift', '<orbs|shards> <кол-во>', 'подарок всем онлайн'], ['/weather', '<rain|snow|off>', 'погода'], ['/night', '', 'ночь вкл/выкл'], ['/event', '<имя> <сферы> <удача> <скор> <мин> | off', 'своё событие'],
    ['/bosstimer', '', 'сброс таймера босса'], ['/restart', '<сек|off>', 'отсчёт перезапуска'], ['/code', '<КОД> <сферы> [осколки] [активаций] [дней] | off <КОД> | list', 'промокоды'], ['/hunt', '[сферы] [осколки] [мин]', 'охота на админа'],
    ['/giant', '[награда] [сек]', 'гигантская сфера'], ['/chaos', '[сек]', 'хаос'], ['/lava', '[сек]', 'пол — лава'], ['/ghost', '[сек]', 'призрак'], ['/freezeall', '', 'заморозить карту'], ['/chest', '[сферы] [осколки] [мин]', 'сундук'],
    ['/poll', 'Вопрос | вариант | вариант', 'опрос'], ['/endpoll', '', 'завершить опрос']];
  window.OCSAdmCmds = CMDS.map(c => c[0]);
  let acIdx = 0;
  function cmdAc() {
    const v = $('admCmd').value, box = $('admCmdAc'); box.textContent = ''; const sp = v.indexOf(' ');
    let items = [];
    if (sp < 0) items = CMDS.filter(c => c[0].startsWith(v.toLowerCase() || '/')).map(c => ({ fill: c[0] + (c[1] ? ' ' : ''), t: c[0], h: `${c[1]} — ${c[2]}` }));
    else { const c = CMDS.find(x => x[0] === v.slice(0, sp).toLowerCase()); if (c) { const rest = v.slice(sp + 1); if (/^<ник>/.test(c[1]) && !rest.includes(' ')) items = admOnline.filter(p => p.name.toLowerCase().startsWith(rest.toLowerCase())).slice(0, 6).map(p => ({ fill: c[0] + ' ' + p.name + ' ', t: p.name, h: c[1] })); items.unshift({ hint: true, t: c[0] + ' ' + c[1], h: c[2] }); } }
    acIdx = Math.min(acIdx, Math.max(0, items.filter(i => !i.hint).length - 1)); let k = 0;
    for (const it of items.slice(0, 9)) { const o = document.createElement('div'); o.className = 'adm-ac-i' + (it.hint ? ' hint' : (k++ === acIdx ? ' on' : '')); const b = document.createElement('b'); b.textContent = it.t; const s = document.createElement('small'); s.textContent = ' ' + it.h; o.append(b, s);
      if (!it.hint) { o.dataset.fill = it.fill; o.addEventListener('mousedown', e => { e.preventDefault(); $('admCmd').value = it.fill; cmdAc(); $('admCmd').focus(); }); } box.appendChild(o); }
    box.classList.toggle('hidden', !items.length || document.activeElement !== $('admCmd'));
  }
  $('admCmd').addEventListener('input', () => { acIdx = 0; cmdAc(); });
  $('admCmd').addEventListener('focus', cmdAc);
  $('admCmd').addEventListener('blur', () => setTimeout(() => $('admCmdAc').classList.add('hidden'), 120));
  $('admCmd').addEventListener('keydown', e => {
    const opts = Array.from($('admCmdAc').querySelectorAll('.adm-ac-i[data-fill]')); if (!opts.length || $('admCmdAc').classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length; cmdAc(); }
    if (e.key === 'Tab') { e.preventDefault(); $('admCmd').value = opts[acIdx].dataset.fill; acIdx = 0; cmdAc(); }
  });
  // 'Активно' strip with stop buttons
  function renderActive() {
    if ($('admin').classList.contains('hidden')) return;
    const now = performance.now(), items = [];
    const add = (t, stop) => items.push([t, stop]);
    if (evState && G.EVENTS[evState.kind]) add(`${G.EVENTS[evState.kind].icon || ''} ${G.EVENTS[evState.kind].name}`, () => adm({ a: 'stop', kind: 'event' }));
    if (miniState && C.MINI[miniState.kind]) add(`${C.MINI[miniState.kind].icon} ${C.MINI[miniState.kind].name}`, () => adm({ a: 'stop', kind: 'mini' }));
    if (bossState) add('👹 Босс', () => adm({ a: 'stop', kind: 'boss' }));
    if (discoEnd > now) add('🪩 Диско ' + fmtLeft(discoEnd - now), () => adm({ a: 'disco' }));
    if (x2End > now) add('✖️2 Сферы ×2 ' + fmtLeft(x2End - now), () => adm({ a: 'cmd', text: '/x2 0' }));
    if (cev && cev.end > now) add('⭐ ' + cev.name + ' ' + fmtLeft(cev.end - now), () => adm({ a: 'custom', off: true }));
    if (weatherNow) add(weatherNow === 'rain' ? '🌧️ Дождь' : '❄️ Снег', () => adm({ a: 'weather', w: 'off' }));
    if (nightNow) add('🌙 Ночь', () => adm({ a: 'night' }));
    if (restartEnd > now) add('⚠️ Перезапуск ' + fmtLeft(restartEnd - now), () => adm({ a: 'restart', sec: 0 }));
    const fk = (k, t) => add(t, () => adm({ a: 'fun', kind: k }));
    if (funS.hunt && funLeft(funS.hunt.left) > 0) fk('hunt', '🏃 Охота'); if (funS.giant) fk('giant', '🟣 Гигантская сфера'); if (funS.chaos && funLeft(funS.chaos) > 0) fk('chaos', '🌀 Хаос');
    if (funS.lava && funLeft(funS.lava.left) > 0) fk('lava', '🌋 Лава'); if (funS.ghost) fk('ghost', '👻 Призрак'); if (funS.freeze) fk('freeze', '🧊 Заморозка карты'); if (funS.chest) fk('chest', '🎁 Сундук');
    if (pollS && !pollS.done) fk('endpoll', '📊 Опрос');
    if (selfFx.god) add('🛡️ Неуязвимость', () => adm({ a: 'cmd', text: '/god' })); if (selfFx.invis) add('👻 Невидимость', () => adm({ a: 'invis' }));
    if (selfFx.spd && selfFx.spd !== 1) add(`💨 Скорость ×${selfFx.spd}`, () => adm({ a: 'cmd', text: '/speed 1' }));
    const box = $('admActiveList'), sig = items.map(i => i[0]).join('|'); if (box._sig === sig) return; box._sig = sig; box.textContent = '';
    for (const [t, stop] of items) { const c = document.createElement('span'); c.className = 'adm-act'; c.textContent = t; const x = document.createElement('button'); x.type = 'button'; x.className = 'adm-stop'; x.textContent = '⏹'; x.title = 'Остановить'; x.addEventListener('click', () => { stop(); box._sig = null; }); c.appendChild(x); box.appendChild(c); }
    $('admActive').classList.toggle('hidden', !items.length);
  }
  setInterval(renderActive, 500);
  // draggable + resizable on desktop, remembered; fullscreen sheet on mobile (CSS)
  const desk = () => !window.matchMedia('(max-width: 640px)').matches;
  function applyGeom() { const g = LS.get('geom', null); if (!desk() || !g) { admCard.style.left = admCard.style.top = admCard.style.width = admCard.style.height = ''; admCard.classList.remove('placed'); return; }
    const w = Math.min(Math.max(360, g.w), innerWidth - 8), h = Math.min(Math.max(260, g.h), innerHeight - 8);
    admCard.classList.add('placed'); admCard.style.width = w + 'px'; admCard.style.height = h + 'px'; admCard.style.left = Math.min(Math.max(0, g.x), innerWidth - w) + 'px'; admCard.style.top = Math.min(Math.max(0, g.y), innerHeight - 40) + 'px'; }
  const saveGeom = () => { if (!desk() || $('admin').classList.contains('hidden')) return; const r = admCard.getBoundingClientRect(); LS.set('geom', { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }); };
  $('admHead').addEventListener('pointerdown', e => {
    if (!desk() || e.target.closest('button')) return; e.preventDefault(); const r = admCard.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    if (!admCard.classList.contains('placed')) { LS.set('geom', { x: r.left, y: r.top, w: r.width, h: r.height }); applyGeom(); }
    const mv = ev => { admCard.style.left = Math.min(Math.max(0, ev.clientX - ox), innerWidth - 80) + 'px'; admCard.style.top = Math.min(Math.max(0, ev.clientY - oy), innerHeight - 40) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); saveGeom(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  if (window.ResizeObserver) { let rt = null; new ResizeObserver(() => { if (!admCard.classList.contains('placed')) return; clearTimeout(rt); rt = setTimeout(saveGeom, 250); }).observe(admCard); }
  admCard.addEventListener('pointerup', () => { if (desk() && !admCard.classList.contains('placed')) { const r = admCard.getBoundingClientRect(); if (Math.abs(r.width - admCard._w) > 2 || Math.abs(r.height - admCard._h) > 2) { LS.set('geom', { x: r.left, y: r.top, w: r.width, h: r.height }); applyGeom(); } } });
  $('admReset').addEventListener('click', () => { LS.set('geom', null); applyGeom(); });
  addEventListener('resize', applyGeom);
  // open hook: last tab, geometry, picker data
  window.OCSAdmOpened = () => { applyGeom(); const r = admCard.getBoundingClientRect(); admCard._w = r.width; admCard._h = r.height; const t = LS.get('tab', 'ev'); if (!$('admSearch').value) showTab(t); renderFav(); renderActive(); if (admSel) renderPickActs(); };
  // keyboard shortcut (admin only): backquote / ё toggles the panel
  window.addEventListener('keydown', e => {
    if (e.code !== 'Backquote' || !isAdminMe || !joined || e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    e.preventDefault(); if ($('admin').classList.contains('hidden')) openAdmin(); else closeModals();
  });
  window.OCSAdmUI = () => ({ open: !$('admin').classList.contains('hidden'), sel: admSel, tab: (document.querySelector('.adm-tab.active') || {}).dataset?.sec, active: Array.from(document.querySelectorAll('#admActiveList .adm-act')).map(x => x.firstChild.textContent), fav: Array.from(document.querySelectorAll('#admFav .adm-chip-go')).map(x => x.textContent), placed: admCard.classList.contains('placed') });
  window.OCSEmit = (ev, d) => new Promise(r => socket.emit(ev, d, r)); // test/automation helper (same socket the UI uses; the server validates everything)
  window.OCSAdm = d => new Promise(r => socket.emit('adm', d, r)); // test/automation helper; the server authorizes every call
  window.OCSDebugSnap = () => (lastSnapIds ? Array.from(lastSnapIds) : null);
  window.OCSDebugPl = name => { for (const p of players.values()) if (p.name === name) return { sz: p.sz || 1, eq: p.eq }; return null; };
  window.OCSDebugMe = () => ({ x: me.x, y: me.y });
  window.OCSFun = () => ({ fun: funS, poll: pollS, mult: funSpeedMult(), bar: $('funBar').textContent, pollShown: !$('pollBox').classList.contains('hidden') });
})();
