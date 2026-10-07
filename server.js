'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const G = require('./public/shared.js');
const R = require('./public/rules.js');
const { createStore } = require('./lib/storage');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_ORBS = 380;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const FLUSH_MS = 3000;
const BCRYPT_COST = 10;
const AUTH_MAX_FAILS = 5, AUTH_LOCK_MS = 60 * 1000;
const CHAT_HISTORY = 50, CHAT_MIN_GAP_MS = 1500, CHAT_WINDOW_MS = 10000, CHAT_WINDOW_MAX = 5;
const VERSION = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev';
const has = (obj, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeAck = ack => (typeof ack === 'function' ? ack : () => {});
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const store = createStore();

// ---------------------------------------------------------------- accounts (live cache + debounced persistence)
const profiles = new Map(); // account key -> live account object (online or not yet flushed)
const dirty = new Set();
function markDirty(acc) { dirty.add(acc.key); }
function newAccount(name, passHash) {
  const now = Date.now();
  return {
    key: name.toLowerCase(), name, passHash, balance: 0, total: 0,
    owned: G.DEFAULT_OWNED.slice(), equipped: Object.assign({}, G.DEFAULT_EQUIPPED),
    upgrades: { magnet: 0, speed: 0 }, stats: { minigames: 0, bestReaction: null, bestRush: 0 },
    createdAt: now, lastSeen: now,
  };
}
// Only what the owner may see about their own account (never the hash/key).
function ownProfile(a) { return { name: a.name, balance: a.balance, total: a.total, owned: a.owned, equipped: a.equipped, upgrades: a.upgrades, stats: a.stats }; }
async function loadAccount(key) {
  if (profiles.has(key)) return profiles.get(key);
  const acc = await store.getAccount(key);
  if (!acc) return null;
  if (profiles.has(key)) return profiles.get(key); // loaded concurrently
  normalizeAccount(acc);
  profiles.set(key, acc);
  return acc;
}
function normalizeAccount(a) {
  a.owned = Array.isArray(a.owned) ? a.owned.filter(id => has(G.ITEM_BY_ID, id)) : [];
  for (const id of G.DEFAULT_OWNED) if (!a.owned.includes(id)) a.owned.push(id);
  a.equipped = Object.assign({}, G.DEFAULT_EQUIPPED, isObj(a.equipped) ? a.equipped : {});
  a.upgrades = Object.assign({ magnet: 0, speed: 0 }, isObj(a.upgrades) ? a.upgrades : {});
  a.stats = Object.assign({ minigames: 0, bestReaction: null, bestRush: 0 }, isObj(a.stats) ? a.stats : {});
}

let flushing = Promise.resolve();
function flush() {
  flushing = flushing.then(async () => {
    if (!dirty.size) return;
    const keys = Array.from(dirty);
    dirty.clear();
    const list = keys.map(k => profiles.get(k)).filter(Boolean);
    try {
      await store.saveAccounts(list);
      lbCache.clear();
    } catch (e) {
      console.error('Save failed (will retry):', e.message);
      for (const k of keys) dirty.add(k);
      return;
    }
    for (const k of keys) if (!byKey.has(k) && !dirty.has(k)) profiles.delete(k); // evict offline, clean accounts
  });
  return flushing;
}
let flushSoonTimer = null;
function flushSoon() { if (!flushSoonTimer) flushSoonTimer = setTimeout(() => { flushSoonTimer = null; flush(); }, 250); }

// ---------------------------------------------------------------- game state
const players = new Map();  // public id -> player
const byKey = new Map();    // account key -> player
const orbs = new Map();     // id -> {id,x,y,t}
let nextOrbId = 1;
let pendingAdds = [], pendingDels = [];
let io = null;

function newPublicId() { let id; do { id = crypto.randomInt(1, 2 ** 31 - 1); } while (players.has(id)); return id; }

const typeTable = Object.values(G.ORB_TYPES);
const totalWeight = typeTable.reduce((s, t) => s + t.weight, 0);
function randomType() {
  let r = Math.random() * totalWeight;
  for (const t of typeTable) { if ((r -= t.weight) < 0) return t.key; }
  return 'c';
}
function spawnOrb(forceType) {
  const t = forceType || randomType();
  const m = 40;
  const o = { id: nextOrbId++, x: Math.round(m + Math.random() * (G.WORLD.w - 2 * m)), y: Math.round(m + Math.random() * (G.WORLD.h - 2 * m)), t };
  orbs.set(o.id, o);
  pendingAdds.push([o.id, o.x, o.y, o.t]);
  if (t === 'l' && io) io.to('arena').emit('announce', { text: 'Появилась легендарная сфера (+25)!', x: o.x, y: o.y });
  return o;
}
for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
pendingAdds = [];

// Public data about a player: public id, nickname, cosmetics, position. Nothing else.
function playerMeta(pl) { return { id: pl.id, name: pl.acc.name, eq: pl.acc.equipped, x: pl.x, y: pl.y }; }
function emitProfile(pl) { pl.socket.emit('profile', ownProfile(pl.acc)); }
function nameColorOf(acc) { const it = G.ITEM_BY_ID[acc.equipped.nameColor]; return it ? it.value : '#ffffff'; }

// ---------------------------------------------------------------- chat
const chatHistory = [];
let chatSeq = 0;
function pushChat(msg, keep) {
  msg.id = ++chatSeq; msg.ts = Date.now();
  if (keep) { chatHistory.push(msg); while (chatHistory.length > CHAT_HISTORY) chatHistory.shift(); }
  io.to('arena').emit('chat', msg);
}
function systemChat(text) { pushChat({ sys: true, t: text }, false); }

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render puts exactly one proxy in front of the app (used only for req.secure / HSTS)
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:\-[\]]/g, '');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    `connect-src 'self'${host ? ` wss://${host} ws://${host}` : ''}`, "font-src 'self'", "object-src 'none'",
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, index: 'index.html' }));

const lbCache = new Map();
async function leaderboard(limit, name) {
  const meKey = typeof name === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(name) ? name.toLowerCase() : null;
  const ck = limit + '|' + (meKey || '');
  const hit = lbCache.get(ck);
  if (hit && Date.now() - hit.at < 2000) return hit.data;
  if (dirty.size) await flush();
  const d = await store.leaderboard(limit, meKey);
  const map = r => ({ rank: r.rank, name: r.name, total: r.total, color: (G.ITEM_BY_ID[r.equipped && r.equipped.color] || {}).value || '#3ee0ff', online: byKey.has(r.name.toLowerCase()) });
  const data = { updatedAt: new Date().toISOString(), totalPlayers: d.totalPlayers, players: d.rows.map((r, i) => map(Object.assign({ rank: i + 1 }, r))), me: d.me ? map(d.me) : null };
  if (lbCache.size > 200) lbCache.clear();
  lbCache.set(ck, { at: Date.now(), data });
  return data;
}
app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  try { res.json(await leaderboard(limit, req.query.name)); }
  catch (e) { console.error('leaderboard failed:', e.message); res.status(503).json({ error: 'unavailable' }); }
});
app.get('/api/health', (req, res) => res.json({ ok: true, online: players.size, orbs: orbs.size, storage: store.mode, version: VERSION, uptimeSec: Math.round(process.uptime()) }));
app.get('/api/shop', (req, res) => res.json({ items: G.ITEMS, upgrades: G.UPGRADES, minigames: G.MINIGAMES }));
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => { console.error('http error:', err && err.message); res.status(500).type('text').send('Server error'); }); // eslint-disable-line no-unused-vars

const server = http.createServer(app);
io = new Server(server, { maxHttpBufferSize: 10 * 1024, pingInterval: 10000, pingTimeout: 20000, serveClient: true });

// ---------------------------------------------------------------- auth helpers
const nameFails = new Map(); // account key -> {n, until, last}  (in memory only)
function lockLeft(entry, now) { return entry && entry.until > now ? Math.ceil((entry.until - now) / 1000) : 0; }
function addFail(map, key, now) {
  let e = map.get(key);
  if (!e || now - e.last > 15 * 60 * 1000) { e = { n: 0, until: 0, last: now }; map.set(key, e); }
  e.n++; e.last = now;
  if (e.n >= AUTH_MAX_FAILS) { e.until = now + AUTH_LOCK_MS; e.n = 0; }
  return e;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of nameFails) if (e.until < now && now - e.last > 15 * 60 * 1000) nameFails.delete(k); }, 60000).unref();
const globalAuth = { at: 0, n: 0 }; // global bcrypt budget so the CPU can't be exhausted
function takeGlobalAuth(now) { if (now - globalAuth.at > 10000) { globalAuth.at = now; globalAuth.n = 0; } return ++globalAuth.n <= 100; }
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);
const lockMsg = s => `Слишком много неудачных попыток. Попробуйте снова через ${s} с.`;

async function newSession(key) {
  const token = crypto.randomBytes(32).toString('base64url');
  await store.createSession(sha256(token), key, Date.now() + SESSION_TTL_MS);
  return token;
}

function removePlayer(pl, opts = {}) {
  if (!pl || !players.has(pl.id)) return;
  if (pl.mg) finishMinigame(pl, { aborted: true });
  players.delete(pl.id);
  if (byKey.get(pl.acc.key) === pl) byKey.delete(pl.acc.key);
  pl.socket.leave('arena');
  pl.acc.lastSeen = Date.now();
  markDirty(pl.acc);
  flushSoon();
  io.to('arena').emit('pleave', pl.id);
  if (!opts.silent) systemChat(`${pl.acc.name} покинул(а) арену`);
}

// ---------------------------------------------------------------- mini-games
function finishMinigame(pl, info) {
  const mg = pl.mg;
  if (!mg) return;
  for (const t of mg.timers) clearTimeout(t);
  pl.mg = null;
  pl.mgCooldownUntil = Date.now() + 1500;
  let prize = 0;
  const result = { kind: mg.kind, fee: G.MINIGAMES[mg.kind].fee };
  const s = pl.acc.stats;
  if (mg.kind === 'reaction') {
    if (info.early) { result.message = 'Слишком рано! Взнос сгорел.'; }
    else if (info.timeout) { result.message = 'Время вышло — вы не нажали.'; }
    else if (info.rt != null) {
      result.rt = info.rt;
      for (const [ms, p] of G.REACTION_PRIZES) if (info.rt < ms) { prize = p; break; }
      result.message = `Время реакции: ${info.rt} мс`;
      if (s.bestReaction == null || info.rt < s.bestReaction) s.bestReaction = info.rt;
    }
  } else if (mg.kind === 'rush') {
    prize = Math.max(0, mg.score);
    result.score = mg.score; result.hits = mg.hits;
    result.message = `Очки: ${mg.score} (попаданий: ${mg.hits})`;
    if (mg.score > (s.bestRush || 0)) s.bestRush = mg.score;
  }
  if (info.aborted && mg.kind === 'reaction') prize = 0;
  result.prize = prize;
  pl.acc.balance += prize;
  pl.acc.total += prize;
  s.minigames = (s.minigames || 0) + 1;
  markDirty(pl.acc);
  if (!info.aborted) { pl.socket.emit('mg:result', result); emitProfile(pl); }
}

function startMinigame(pl, kind) {
  if (!has(G.MINIGAMES, kind)) return { ok: false, error: 'Неизвестная мини-игра' };
  const def = G.MINIGAMES[kind];
  if (pl.mg) return { ok: false, error: 'Мини-игра уже идёт' };
  if (Date.now() < (pl.mgCooldownUntil || 0)) return { ok: false, error: 'Подождите секунду…' };
  if (pl.acc.balance < def.fee) return { ok: false, error: `Нужно ${def.fee} сфер для входа` };
  pl.acc.balance -= def.fee;
  markDirty(pl.acc);
  emitProfile(pl);
  const mg = { kind, timers: [], startedAt: Date.now() };
  pl.mg = mg;
  if (kind === 'reaction') {
    mg.phase = 'wait';
    const delay = 1500 + Math.random() * 3000;
    mg.timers.push(setTimeout(() => {
      if (pl.mg !== mg) return;
      mg.phase = 'go'; mg.goAt = Date.now();
      pl.socket.emit('mg:reaction:go');
      mg.timers.push(setTimeout(() => { if (pl.mg === mg) finishMinigame(pl, { timeout: true }); }, 3000));
    }, delay));
  } else if (kind === 'rush') {
    mg.score = 0; mg.hits = 0; mg.targets = new Map();
    let t = 600, id = 1;
    while (t < def.duration - 800) {
      const roll = Math.random();
      const type = roll < 0.68 ? 'c' : roll < 0.85 ? 'g' : 'b';
      const r = type === 'g' ? 20 : type === 'b' ? 26 : 26 + Math.random() * 8;
      const target = { id: id++, type, v: type === 'c' ? 1 : type === 'g' ? 3 : -3, r: Math.round(r),
        x: Math.round(40 + Math.random() * (def.w - 80)), y: Math.round(40 + Math.random() * (def.h - 80)),
        life: type === 'g' ? 900 : 1100 + Math.round(Math.random() * 500) };
      mg.targets.set(target.id, target);
      mg.timers.push(setTimeout(() => {
        if (pl.mg !== mg) return;
        target.spawnedAt = Date.now();
        pl.socket.emit('mg:rush:spawn', { id: target.id, type: target.type, x: target.x, y: target.y, r: target.r, life: target.life });
      }, t));
      t += 280 + Math.random() * 260;
    }
    mg.timers.push(setTimeout(() => { if (pl.mg === mg) finishMinigame(pl, {}); }, def.duration + 300));
  }
  return { ok: true, kind, duration: def.duration };
}

// ---------------------------------------------------------------- sockets
io.on('connection', socket => {
  let pl = null;
  let authBusy = false, registrations = 0;
  const sockFails = new Map();
  // generic flood guard: >120 events in 2 s disconnects the socket
  let evWindow = Date.now(), evCount = 0;
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - evWindow > 2000) { evWindow = now; evCount = 0; }
    if (++evCount > 120) { socket.disconnect(true); return; }
    next();
  });

  function enterGame(acc, sessionHash) {
    const existing = byKey.get(acc.key);
    if (existing) {
      existing.socket.emit('kicked', 'Вы вошли в игру с другой вкладки или устройства.');
      removePlayer(existing, { silent: true });
      existing.socket.disconnect(true);
    }
    pl = {
      id: newPublicId(), acc, socket, sessionHash,
      x: 200 + Math.random() * (G.WORLD.w - 400), y: 200 + Math.random() * (G.WORLD.h - 400),
      inputs: [], budget: 2, lastSeq: 0, session: 0, gained: 0, rtt: 100, mg: null, joinedAt: Date.now(), chatTimes: [], lastChat: '',
    };
    acc.lastSeen = Date.now();
    markDirty(acc);
    players.set(pl.id, pl);
    byKey.set(acc.key, pl);
    socket.join('arena');
    socket.to('arena').emit('pjoin', playerMeta(pl));
    if (!existing) systemChat(`${acc.name} зашёл(ла) на арену`);
    console.log(`join: ${acc.name}, online ${players.size}`);
    return {
      you: pl.id, profile: ownProfile(acc), world: G.WORLD,
      orbs: Array.from(orbs.values(), o => [o.id, o.x, o.y, o.t]),
      players: Array.from(players.values(), playerMeta),
      chat: chatHistory,
    };
  }

  // checks socket lockout; returns error object or null
  function preAuth(now) {
    const left = lockLeft(sockFails.get('s'), now);
    if (left) return { ok: false, error: lockMsg(left), retryIn: left };
    if (!takeGlobalAuth(now)) return { ok: false, error: 'Сервер перегружен, попробуйте через несколько секунд.' };
    return null;
  }
  const failSock = now => addFail(sockFails, 's', now);

  socket.on('auth', async (data, ack) => {
    ack = safeAck(ack);
    if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
    if (authBusy) return ack({ ok: false, error: 'Подождите…' });
    authBusy = true;
    try {
      const now = Date.now();
      const pre = preAuth(now);
      if (pre) return ack(pre);
      if (!isObj(data) || (data.mode !== 'login' && data.mode !== 'register')) return ack({ ok: false, error: 'Неверный запрос' });
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      const password = typeof data.password === 'string' ? data.password : '';
      let acc;
      if (data.mode === 'register') {
        const nErr = R.nicknameError(name);
        if (nErr) { failSock(now); return ack({ ok: false, error: nErr, field: 'name' }); }
        const pErr = R.passwordError(password);
        if (pErr) { failSock(now); return ack({ ok: false, error: pErr, field: 'password' }); }
        if (data.confirm !== undefined && data.confirm !== password) { failSock(now); return ack({ ok: false, error: 'Пароли не совпадают', field: 'confirm' }); }
        if (registrations >= 3) return ack({ ok: false, error: 'Слишком много регистраций. Обновите страницу позже.' });
        const key = name.toLowerCase();
        if (profiles.has(key) || await store.getAccount(key)) { failSock(now); return ack({ ok: false, error: 'Этот ник уже занят. Выберите другой.', field: 'name' }); }
        const hash = await bcrypt.hash(password, BCRYPT_COST);
        acc = newAccount(name, hash);
        if (!(await store.createAccount(acc))) { failSock(now); return ack({ ok: false, error: 'Этот ник уже занят. Выберите другой.', field: 'name' }); }
        registrations++;
        profiles.set(acc.key, acc);
        console.log(`register: ${acc.name}`);
      } else {
        const key = name.toLowerCase();
        const nameLeft = lockLeft(nameFails.get(key), now);
        if (nameLeft) { failSock(now); return ack({ ok: false, error: lockMsg(nameLeft), retryIn: nameLeft }); }
        const valid = /^[A-Za-z0-9_]{3,20}$/.test(name);
        const found = valid && password ? (profiles.get(key) || await store.getAccount(key)) : null; // cached only on success
        const okPw = await bcrypt.compare(password.slice(0, 200), found ? found.passHash : DUMMY_HASH);
        if (!found || !okPw) {
          const se = failSock(now);
          const ne = valid ? addFail(nameFails, key, now) : null;
          const left = Math.max(lockLeft(se, now), lockLeft(ne, now));
          if (left) return ack({ ok: false, error: lockMsg(left), retryIn: left });
          const remaining = AUTH_MAX_FAILS - Math.max(se.n, ne ? ne.n : 0);
          return ack({ ok: false, error: 'Неверный ник или пароль.' + (remaining <= 2 ? ` Осталось попыток: ${remaining}.` : '') });
        }
        nameFails.delete(key); sockFails.delete('s');
        if (profiles.has(key)) acc = profiles.get(key);
        else { normalizeAccount(found); profiles.set(key, found); acc = found; }
      }
      const token = await newSession(acc.key);
      if (!socket.connected) return;
      if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
      ack(Object.assign({ ok: true, token }, enterGame(acc, sha256(token))));
    } catch (e) {
      console.error('auth error:', e.message);
      ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' });
    } finally { authBusy = false; }
  });

  socket.on('resume', async (data, ack) => {
    ack = safeAck(ack);
    if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
    if (authBusy) return ack({ ok: false, error: 'Подождите…' });
    authBusy = true;
    try {
      const now = Date.now();
      const left = lockLeft(sockFails.get('s'), now);
      if (left) return ack({ ok: false, error: lockMsg(left), retryIn: left });
      const token = isObj(data) && typeof data.token === 'string' ? data.token : '';
      const expired = { ok: false, expired: true, error: 'Сессия истекла. Войдите снова.' };
      if (!TOKEN_RE.test(token)) { failSock(now); return ack(expired); }
      const h = sha256(token);
      const sess = await store.getSession(h);
      if (!sess) { failSock(now); return ack(expired); }
      if (sess.expiresAt <= now) { await store.deleteSession(h); return ack(expired); }
      const acc = await loadAccount(sess.key);
      if (!acc) { await store.deleteSession(h); return ack(expired); }
      await store.touchSession(h, now + SESSION_TTL_MS); // sliding expiry
      if (!socket.connected) return;
      if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
      ack(Object.assign({ ok: true }, enterGame(acc, h)));
    } catch (e) {
      console.error('resume error:', e.message);
      ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' });
    } finally { authBusy = false; }
  });

  socket.on('logout', async (data, ack) => {
    ack = safeAck(ack);
    try {
      let h = pl ? pl.sessionHash : null;
      if (!h && isObj(data) && typeof data.token === 'string' && TOKEN_RE.test(data.token)) h = sha256(data.token);
      if (pl) { removePlayer(pl); pl = null; }
      if (h) await store.deleteSession(h);
      ack({ ok: true });
    } catch (e) { console.error('logout error:', e.message); ack({ ok: false, error: 'Ошибка сервера' }); }
  });

  socket.on('chat', (text, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Войдите в игру, чтобы писать в чат' });
    const now = Date.now();
    const clean = R.sanitizeChat(text);
    if (clean.error) return ack({ ok: false, error: clean.error });
    pl.chatTimes = pl.chatTimes.filter(t => now - t < CHAT_WINDOW_MS);
    const last = pl.chatTimes[pl.chatTimes.length - 1] || 0;
    if (now - last < CHAT_MIN_GAP_MS) return ack({ ok: false, error: 'Не так быстро! Подождите немного.' });
    if (pl.chatTimes.length >= CHAT_WINDOW_MAX) return ack({ ok: false, error: 'Слишком много сообщений. Подождите несколько секунд.' });
    if (clean.text.toLowerCase() === pl.lastChat && now - last < 15000) return ack({ ok: false, error: 'Не повторяйте одно и то же сообщение.' });
    pl.chatTimes.push(now);
    pl.lastChat = clean.text.toLowerCase();
    pushChat({ n: pl.acc.name, c: nameColorOf(pl.acc), t: clean.text }, true);
    ack({ ok: true, masked: clean.masked });
  });

  socket.on('input', m => {
    if (!pl || !isObj(m)) return;
    const s = Number(m.s), x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(s) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (pl.inputs.length >= 40) return;
    pl.inputs.push({ s, x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) });
  });

  socket.on('spong', v => {
    if (!pl || typeof v !== 'number') return;
    const d = Date.now() - v;
    if (d >= 0 && d < 10000) pl.rtt = pl.rtt * 0.7 + d * 0.3;
  });

  socket.on('buy', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    if (!has(G.ITEM_BY_ID, itemId)) return ack({ ok: false, error: 'Нет такого предмета' });
    const it = G.ITEM_BY_ID[itemId], a = pl.acc;
    if (a.owned.includes(it.id)) return ack({ ok: false, error: 'Уже куплено' });
    if (a.balance < it.price) return ack({ ok: false, error: `Не хватает сфер: нужно ${it.price}` });
    a.balance -= it.price;
    a.owned.push(it.id);
    a.equipped[it.cat] = it.id;
    markDirty(a); flushSoon();
    io.to('arena').emit('pmeta', playerMeta(pl));
    ack({ ok: true, profile: ownProfile(a) });
  });

  socket.on('equip', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    if (!has(G.ITEM_BY_ID, itemId) || !pl.acc.owned.includes(itemId)) return ack({ ok: false, error: 'Предмет не куплен' });
    const it = G.ITEM_BY_ID[itemId];
    pl.acc.equipped[it.cat] = it.id;
    markDirty(pl.acc);
    io.to('arena').emit('pmeta', playerMeta(pl));
    ack({ ok: true, profile: ownProfile(pl.acc) });
  });

  socket.on('upgrade', (key, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    if (!has(G.UPGRADES, key)) return ack({ ok: false, error: 'Нет такого улучшения' });
    const up = G.UPGRADES[key], a = pl.acc, lvl = a.upgrades[key] || 0;
    if (lvl >= up.max) return ack({ ok: false, error: 'Максимальный уровень' });
    const price = up.prices[lvl];
    if (a.balance < price) return ack({ ok: false, error: `Не хватает сфер: нужно ${price}` });
    a.balance -= price;
    a.upgrades[key] = lvl + 1;
    markDirty(a); flushSoon();
    ack({ ok: true, profile: ownProfile(a) });
  });

  socket.on('mg:start', (kind, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    ack(startMinigame(pl, kind));
  });
  socket.on('mg:reaction:click', () => {
    if (!pl || !pl.mg || pl.mg.kind !== 'reaction') return;
    const mg = pl.mg;
    if (mg.phase === 'wait') return finishMinigame(pl, { early: true });
    const rt = Math.max(80, Math.round(Date.now() - mg.goAt - Math.min(pl.rtt / 2, 150)));
    finishMinigame(pl, { rt });
  });
  socket.on('mg:rush:hit', (m, ack) => {
    ack = safeAck(ack);
    if (!pl || !pl.mg || pl.mg.kind !== 'rush' || !isObj(m)) return ack({ ok: false });
    const mg = pl.mg, t = mg.targets.get(Number(m.id));
    if (!t || t.hit || !t.spawnedAt) return ack({ ok: false });
    const age = Date.now() - t.spawnedAt;
    if (age > t.life + Math.min(pl.rtt, 400) + 150) return ack({ ok: false, late: true });
    const dx = Number(m.x) - t.x, dy = Number(m.y) - t.y;
    if (!(Math.hypot(dx, dy) <= t.r * 1.3 + 4)) return ack({ ok: false });
    t.hit = true;
    mg.score += t.v;
    if (t.v > 0) mg.hits++;
    ack({ ok: true, id: t.id, v: t.v, score: mg.score });
  });

  socket.on('disconnect', () => { removePlayer(pl); pl = null; });
});

// ---------------------------------------------------------------- main loop
function collectAround(pl, radius) {
  for (const o of orbs.values()) {
    const ot = G.ORB_TYPES[o.t];
    const rr = radius + ot.r;
    const dx = o.x - pl.x, dy = o.y - pl.y;
    if (dx * dx + dy * dy <= rr * rr) {
      orbs.delete(o.id);
      pendingDels.push([o.id, pl.id]);
      pl.gained += ot.value;
      pl.session += ot.value;
      pl.acc.balance += ot.value;
      pl.acc.total += ot.value;
    }
  }
}

function tick() {
  for (const pl of players.values()) {
    pl.budget = Math.min(pl.budget + 1, 6);
    while (pl.inputs.length > 12) pl.lastSeq = pl.inputs.shift().s; // keep latency bounded
    const speed = G.speedFor(pl.acc.upgrades.speed);
    const radius = G.pickupFor(pl.acc.upgrades.magnet);
    while (pl.budget >= 1 && pl.inputs.length) {
      const inp = pl.inputs.shift();
      pl.budget -= 1;
      G.applyInput(pl, inp.x, inp.y, speed);
      pl.lastSeq = inp.s;
      collectAround(pl, radius);
    }
    if (pl.gained > 0) { markDirty(pl.acc); pl.socket.emit('bal', { b: pl.acc.balance, t: pl.acc.total, s: pl.session }); pl.gained = 0; }
  }
  let budget = 12;
  while (orbs.size < MAX_ORBS && budget-- > 0) spawnOrb();
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100, pl.lastSeq]);
  io.to('arena').emit('s', { t: Date.now(), p, oa: pendingAdds, od: pendingDels });
  pendingAdds = []; pendingDels = [];
}

function everySecond() {
  const top = Array.from(players.values()).sort((a, b) => b.session - a.session || a.joinedAt - b.joinedAt).slice(0, 10)
    .map(pl => [pl.id, pl.acc.name, pl.session]);
  io.to('arena').emit('top', { online: players.size, top });
  const now = Date.now();
  for (const pl of players.values()) pl.socket.emit('sping', now);
}

// ---------------------------------------------------------------- startup / shutdown
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: saving and shutting down…`);
  setTimeout(() => { console.error('Forced exit after timeout'); process.exit(1); }, 9000).unref();
  try {
    server.close();
    for (const pl of Array.from(players.values())) removePlayer(pl, { silent: true });
    await flush(); // persist before sockets drop, so a player reconnecting to a new instance never loads stale data
    io.close();
    await flush();
    await store.close();
    console.log(`Saved. Bye.`);
  } catch (e) { console.error('Shutdown error:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.message));

(async () => {
  await store.init();
  console.log(`Storage: ${store.describe()}, ${await store.countAccounts()} accounts`);
  await store.purgeExpiredSessions(Date.now());
  setInterval(tick, G.TICK_MS);
  setInterval(everySecond, 1000);
  setInterval(flush, FLUSH_MS);
  setInterval(() => store.purgeExpiredSessions(Date.now()).catch(e => console.error('purge failed:', e.message)), 3600 * 1000);
  server.listen(PORT, () => console.log(`Orb Collecting Simulator on http://localhost:${PORT} (version ${VERSION})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
