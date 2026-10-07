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
const INV = require('./lib/inventory');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const FLUSH_MS = 3000;
const BCRYPT_COST = 10;
const AUTH_MAX_FAILS = 5, AUTH_LOCK_MS = 60 * 1000;
const CHAT_HISTORY = 50, CHAT_MIN_GAP_MS = 1500, CHAT_WINDOW_MS = 10000, CHAT_WINDOW_MAX = 5;
const CHAT_CLEAR_MS = Math.max(1000, parseInt(process.env.CHAT_CLEAR_MS, 10) || 15 * 60 * 1000); // fixed wall-clock cycle
const TEST_HOOKS = process.env.OCS_TEST_HOOKS === '1'; // test-only socket events (grant items / orbs); never set in production
const VERSION = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev';
const has = (obj, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeAck = ack => (typeof ack === 'function' ? ack : () => {});
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- orb spawning (all numbers documented in README)
const legendEvery = parseInt(process.env.LEGENDARY_EVERY_MS, 10) || 0; // test override
const SPAWN = {
  cell: 300,                       // world is split into 10 x 10 cells of 300 px
  base: 70, perPlayer: 30, min: 90, max: 320, // target orbs = clamp(base + perPlayer * online, min, max)
  rareChance: 0.10,                // common 90 % (+1), rare 10 % (+5)
  respawnMin: 3000, respawnMax: 9000, // a collected orb comes back 3-9 s later (somewhere else)
  fillSpread: 4000,                // extra orbs for newly joined players appear over ~4 s
  maxPerTick: 4,                   // at most 80 spawns per second
  orbGap: 70,                      // min distance between orbs
  playerClear: 220,                // never spawn closer than this to a player
  candidates: 6,                   // cells sampled per spawn; the emptiest one wins
  legendFirst: legendEvery || 60000, legendMin: legendEvery || 90000, legendMax: legendEvery || 150000, // timed event
  legendLife: 75000, legendMaxAlive: 1,
};

const store = createStore();

// ---------------------------------------------------------------- accounts (live cache + debounced persistence)
const profiles = new Map(); // account key -> live account object (online, held by a lobby socket, or not yet flushed)
const holders = new Map();  // account key -> number of authenticated sockets (lobby or arena)
const dirty = new Set();
const mgCooldowns = new Map(); // account key -> { kind: until }
function markDirty(acc) { dirty.add(acc.key); }
function hold(key, d) { const n = (holders.get(key) || 0) + d; if (n > 0) holders.set(key, n); else holders.delete(key); }
function newAccount(name, passHash) {
  const now = Date.now();
  const a = {
    key: name.toLowerCase(), name, passHash, balance: 0, total: 0, inventory: INV.emptyInventory(),
    owned: G.DEFAULT_OWNED.slice(), equipped: Object.assign({}, G.DEFAULT_EQUIPPED),
    upgrades: { magnet: 0, speed: 0 }, stats: { minigames: 0, bestReaction: null, bestRush: 0, sessions: 0, playMs: 0 },
    createdAt: now, lastSeen: now,
  };
  INV.migrateAccount(a);
  return a;
}
// Only what the owner may see about their own account (never the hash/key).
function ownProfile(a) {
  return { name: a.name, balance: a.balance, total: a.total, equipped: a.equipped, upgrades: a.upgrades, stats: a.stats,
    inventory: a.inventory.slots.map(s => ({ id: s.id, q: s.q, src: s.src })), slots: G.INV_SLOTS, createdAt: a.createdAt };
}
async function loadAccount(key) {
  if (profiles.has(key)) return profiles.get(key);
  const acc = await store.getAccount(key); // returns a migrated account
  if (!acc) return null;
  if (profiles.has(key)) return profiles.get(key); // loaded concurrently
  profiles.set(key, acc);
  return acc;
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
    for (const k of keys) if (!holders.has(k) && !byKey.has(k) && !dirty.has(k)) profiles.delete(k); // evict unused, clean accounts
  });
  return flushing;
}
let flushSoonTimer = null;
function flushSoon() { if (!flushSoonTimer) flushSoonTimer = setTimeout(() => { flushSoonTimer = null; flush(); }, 250); }

// ---------------------------------------------------------------- game state
const players = new Map();  // public id -> player
const byKey = new Map();    // account key -> player
const orbs = new Map();     // id -> {id,x,y,t,cell,expires?}
let nextOrbId = 1;
let pendingAdds = [], pendingDels = [];
let io = null;

function newPublicId() { let id; do { id = crypto.randomInt(1, 2 ** 31 - 1); } while (players.has(id)); return id; }

const NX = Math.ceil(G.WORLD.w / SPAWN.cell), NY = Math.ceil(G.WORLD.h / SPAWN.cell);
const cells = Array.from({ length: NX * NY }, () => new Set()); // orb ids per cell
const cellOf = (x, y) => Math.min(NY - 1, Math.floor(y / SPAWN.cell)) * NX + Math.min(NX - 1, Math.floor(x / SPAWN.cell));
let respawnQueue = [];      // due timestamps for normal orbs
let legendaryAlive = 0, nextLegendAt = Date.now() + SPAWN.legendFirst;
const targetOrbs = () => Math.max(SPAWN.min, Math.min(SPAWN.max, SPAWN.base + SPAWN.perPlayer * players.size));

function spotIsFree(x, y) {
  for (const pl of players.values()) { const dx = pl.x - x, dy = pl.y - y; if (dx * dx + dy * dy < SPAWN.playerClear ** 2) return false; }
  const cx = Math.floor(x / SPAWN.cell), cy = Math.floor(y / SPAWN.cell);
  for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    if (i < 0 || j < 0 || i >= NX || j >= NY) continue;
    for (const id of cells[j * NX + i]) { const o = orbs.get(id); const dx = o.x - x, dy = o.y - y; if (dx * dx + dy * dy < SPAWN.orbGap ** 2) return false; }
  }
  return true;
}
// best-of-k emptiest cell, then a few rejection-sampled points inside it (Poisson-disc-ish)
function pickSpot() {
  const m = 40;
  for (let attempt = 0; attempt < 4; attempt++) {
    let best = -1, bestN = Infinity;
    for (let k = 0; k < SPAWN.candidates; k++) {
      const c = Math.floor(Math.random() * cells.length), n = cells[c].size + Math.random() * 0.5;
      if (n < bestN) { bestN = n; best = c; }
    }
    const x0 = (best % NX) * SPAWN.cell, y0 = Math.floor(best / NX) * SPAWN.cell;
    for (let t = 0; t < 8; t++) {
      const x = Math.round(Math.max(m, Math.min(G.WORLD.w - m, x0 + rand(15, SPAWN.cell - 15))));
      const y = Math.round(Math.max(m, Math.min(G.WORLD.h - m, y0 + rand(15, SPAWN.cell - 15))));
      if (spotIsFree(x, y)) return { x, y };
    }
  }
  return null; // world is crowded right now; try again next tick
}
function addOrb(t, pos) {
  const o = { id: nextOrbId++, x: pos.x, y: pos.y, t, cell: cellOf(pos.x, pos.y) };
  if (t === 'l') { o.expires = Date.now() + SPAWN.legendLife; legendaryAlive++; }
  orbs.set(o.id, o);
  cells[o.cell].add(o.id);
  pendingAdds.push([o.id, o.x, o.y, o.t]);
  return o;
}
function removeOrb(o, byPlayerId) {
  orbs.delete(o.id);
  cells[o.cell].delete(o.id);
  if (o.t === 'l') legendaryAlive--;
  pendingDels.push([o.id, byPlayerId || 0]);
}
function spawnTick(now) {
  const target = targetOrbs();
  const normal = orbs.size - legendaryAlive;
  for (let missing = target - normal - respawnQueue.length; missing > 0; missing--) respawnQueue.push(now + rand(0, SPAWN.fillSpread));
  let spawned = 0;
  const keep = [];
  for (const due of respawnQueue) {
    if (due > now || spawned >= SPAWN.maxPerTick) { keep.push(due); continue; }
    if (orbs.size - legendaryAlive >= target) continue; // target shrank (players left): drop the respawn
    const pos = pickSpot();
    if (!pos) { keep.push(now + 500); continue; }
    addOrb(Math.random() < SPAWN.rareChance ? 'r' : 'c', pos);
    spawned++;
  }
  respawnQueue = keep;
  // legendary: a timed event with cooldown, only while someone is playing
  for (const o of orbs.values()) if (o.t === 'l' && o.expires <= now) removeOrb(o, 0);
  if (now >= nextLegendAt) {
    if (players.size > 0 && legendaryAlive < SPAWN.legendMaxAlive) {
      const pos = pickSpot();
      if (pos) {
        addOrb('l', pos);
        io.to('arena').emit('announce', { text: 'Появилась легендарная сфера (+25)! Ищите на мини-карте.', x: pos.x, y: pos.y });
        nextLegendAt = now + rand(SPAWN.legendMin, SPAWN.legendMax);
      }
    } else nextLegendAt = now + 5000;
  }
}
// initial fill for an empty arena
for (let i = 0; i < SPAWN.min; i++) { const p = pickSpot(); if (p) addOrb(Math.random() < SPAWN.rareChance ? 'r' : 'c', p); }
pendingAdds = []; pendingDels = [];

// Public data about a player: public id, nickname, cosmetics, position. Nothing else.
function playerMeta(pl) { return { id: pl.id, name: pl.acc.name, eq: pl.acc.equipped, x: pl.x, y: pl.y }; }
function emitProfile(pl) { pl.socket.emit('profile', ownProfile(pl.acc)); }
// after an account change made from any socket: refresh the arena player of that account (if any)
function accountChanged(acc, opts = {}) {
  markDirty(acc); flushSoon();
  const pl = byKey.get(acc.key);
  if (!pl) return;
  if (opts.looks) io.to('arena').emit('pmeta', playerMeta(pl));
  if (opts.notifyArena !== false) emitProfile(pl);
}
function nameColorOf(acc) { const it = G.ITEM_BY_ID[acc.equipped.nameColor]; return it ? it.value : '#ffffff'; }

// ---------------------------------------------------------------- chat (history wiped on a fixed 15-minute cycle)
let chatHistory = [];
let chatSeq = 0;
const nextChatClear = (now = Date.now()) => Math.floor(now / CHAT_CLEAR_MS) * CHAT_CLEAR_MS + CHAT_CLEAR_MS;
let chatClearAt = nextChatClear();
function pushChat(msg, keep) {
  msg.id = ++chatSeq; msg.ts = Date.now();
  if (keep) { chatHistory.push(msg); while (chatHistory.length > CHAT_HISTORY) chatHistory.shift(); }
  io.to('arena').emit('chat', msg);
}
function systemChat(text) { pushChat({ sys: true, t: text }, false); }
function scheduleChatClear() {
  setTimeout(() => {
    chatHistory = [];
    chatClearAt = nextChatClear(Date.now() + 50);
    io.to('arena').emit('chat:clear', { next: chatClearAt });
    scheduleChatClear();
  }, Math.max(10, chatClearAt - Date.now()));
}

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
app.get('/api/health', (req, res) => res.json({ ok: true, online: players.size, orbs: orbs.size, targetOrbs: targetOrbs(), storage: store.mode, version: VERSION, uptimeSec: Math.round(process.uptime()) }));
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
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of nameFails) if (e.until < now && now - e.last > 15 * 60 * 1000) nameFails.delete(k);
  for (const [k, cd] of mgCooldowns) if (Object.values(cd).every(t => t < now)) mgCooldowns.delete(k);
}, 60000).unref();
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
  const now = Date.now();
  pl.acc.lastSeen = now;
  pl.acc.stats.playMs = (pl.acc.stats.playMs || 0) + Math.max(0, now - pl.joinedAt);
  markDirty(pl.acc);
  flushSoon();
  io.to('arena').emit('pleave', pl.id);
  if (!opts.silent) systemChat(`${pl.acc.name} покинул(а) арену`);
}

// Profile screen data: own profile + rank from persisted data + play time.
async function profileSummary(acc) {
  if (dirty.has(acc.key)) await flush();
  const rank = await store.rankOf(acc.key);
  const pl = byKey.get(acc.key);
  return Object.assign(ownProfile(acc), {
    rank, inArena: !!pl, playMs: (acc.stats.playMs || 0) + (pl ? Date.now() - pl.joinedAt : 0),
    items: acc.inventory.slots.reduce((n, s) => n + s.q, 0), slotsUsed: acc.inventory.slots.length,
  });
}

// ---------------------------------------------------------------- mini-games
function finishMinigame(pl, info) {
  const mg = pl.mg;
  if (!mg) return;
  for (const t of mg.timers) clearTimeout(t);
  pl.mg = null;
  const def = G.MINIGAMES[mg.kind];
  const cd = mgCooldowns.get(pl.acc.key) || {};
  cd[mg.kind] = Date.now() + def.cooldownMs;
  mgCooldowns.set(pl.acc.key, cd);
  let prize = 0;
  const result = { kind: mg.kind, fee: def.fee, cooldownMs: def.cooldownMs };
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
    prize = G.rushPrize(mg.score);
    result.score = mg.score; result.hits = mg.hits;
    result.message = `Очки: ${mg.score} (попаданий: ${mg.hits}) → выплата ${Math.round(def.payoutRate * 100)}% от очков, максимум ${def.maxPrize}`;
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
  const until = (mgCooldowns.get(pl.acc.key) || {})[kind] || 0;
  if (Date.now() < until) return { ok: false, error: `«${def.name}» снова будет доступна через ${Math.ceil((until - Date.now()) / 1000)} с`, cooldown: until - Date.now() };
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
  let pl = null;    // arena player (when playing)
  let acct = null;  // authenticated account {acc, sessionHash} (lobby / profile / inventory / shop)
  let authBusy = false, registrations = 0, lastProfileReq = 0;
  const sockFails = new Map();
  // generic flood guard: >120 events in 2 s disconnects the socket
  let evWindow = Date.now(), evCount = 0;
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - evWindow > 2000) { evWindow = now; evCount = 0; }
    if (++evCount > 120) { socket.disconnect(true); return; }
    next();
  });

  function authenticate(acc, sessionHash) {
    if (acct && acct.acc.key !== acc.key) release();
    if (!acct) hold(acc.key, +1);
    acct = { acc, sessionHash };
  }
  function release() {
    if (!acct) return;
    const k = acct.acc.key;
    hold(k, -1);
    acct = null;
    if (!holders.has(k) && !byKey.has(k) && !dirty.has(k)) profiles.delete(k);
  }

  function enterGame(acc, sessionHash) {
    const existing = byKey.get(acc.key);
    if (existing) {
      existing.socket.emit('kicked', 'Вы вошли в игру с другой вкладки или устройства.');
      removePlayer(existing, { silent: true });
      existing.socket.disconnect(true);
    }
    const spawn = { x: 200 + Math.random() * (G.WORLD.w - 400), y: 200 + Math.random() * (G.WORLD.h - 400) };
    pl = {
      id: newPublicId(), acc, socket, sessionHash, x: spawn.x, y: spawn.y,
      inputs: [], budget: 2, lastSeq: 0, session: 0, gained: 0, rtt: 100, mg: null, joinedAt: Date.now(), chatTimes: [], lastChat: '',
    };
    acc.lastSeen = Date.now();
    acc.stats.sessions = (acc.stats.sessions || 0) + 1;
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
      chat: chatHistory, chatNextClear: chatClearAt,
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

  // login / register. By default also enters the arena; {enter:false} only authenticates (profile screen).
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
        else { profiles.set(key, found); acc = found; }
      }
      const token = await newSession(acc.key);
      if (!socket.connected) return;
      if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
      authenticate(acc, sha256(token));
      if (data.enter === false) return ack({ ok: true, token, profile: await profileSummary(acc) });
      ack(Object.assign({ ok: true, token }, enterGame(acc, acct.sessionHash)));
    } catch (e) {
      console.error('auth error:', e.message);
      ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' });
    } finally { authBusy = false; }
  });

  // validates a stored session token; returns the account or an error object
  async function checkSession(data) {
    const now = Date.now();
    const left = lockLeft(sockFails.get('s'), now);
    if (left) return { error: { ok: false, error: lockMsg(left), retryIn: left } };
    const token = isObj(data) && typeof data.token === 'string' ? data.token : '';
    const expired = { error: { ok: false, expired: true, error: 'Сессия истекла. Войдите снова.' } };
    if (!TOKEN_RE.test(token)) { failSock(now); return expired; }
    const h = sha256(token);
    const sess = await store.getSession(h);
    if (!sess) { failSock(now); return expired; }
    if (sess.expiresAt <= now) { await store.deleteSession(h); return expired; }
    const acc = await loadAccount(sess.key);
    if (!acc) { await store.deleteSession(h); return expired; }
    await store.touchSession(h, now + SESSION_TTL_MS); // sliding expiry
    return { acc, h };
  }
  async function withAuthLock(ack, fn) {
    ack = safeAck(ack);
    if (pl) return ack({ ok: false, error: 'Вы уже вошли в игру' });
    if (authBusy) return ack({ ok: false, error: 'Подождите…' });
    authBusy = true;
    try { await fn(ack); } catch (e) { console.error('session error:', e.message); ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' }); }
    finally { authBusy = false; }
  }
  // stored token -> profile screen (does not enter the arena)
  socket.on('session', (data, ack) => withAuthLock(ack, async ack => {
    const r = await checkSession(data);
    if (r.error) return ack(r.error);
    if (!socket.connected) return;
    authenticate(r.acc, r.h);
    ack({ ok: true, profile: await profileSummary(r.acc) });
  }));
  // stored token -> straight into the arena (used on reconnect)
  socket.on('resume', (data, ack) => withAuthLock(ack, async ack => {
    const r = await checkSession(data);
    if (r.error) return ack(r.error);
    if (!socket.connected || pl) return;
    authenticate(r.acc, r.h);
    ack(Object.assign({ ok: true }, enterGame(r.acc, r.h)));
  }));
  // authenticated (profile screen) -> arena
  socket.on('play', (_, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, expired: true, error: 'Сначала войдите в аккаунт' });
    if (pl) return ack({ ok: false, error: 'Вы уже в игре' });
    ack(Object.assign({ ok: true }, enterGame(acct.acc, acct.sessionHash)));
  });

  socket.on('logout', async (data, ack) => {
    ack = safeAck(ack);
    try {
      let h = acct ? acct.sessionHash : null;
      if (!h && isObj(data) && typeof data.token === 'string' && TOKEN_RE.test(data.token)) h = sha256(data.token);
      if (pl) { removePlayer(pl); pl = null; }
      release();
      if (h) await store.deleteSession(h);
      ack({ ok: true });
    } catch (e) { console.error('logout error:', e.message); ack({ ok: false, error: 'Ошибка сервера' }); }
  });

  socket.on('profile:get', async (_, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const now = Date.now();
    if (now - lastProfileReq < 700) return ack({ ok: false, error: 'Подождите…' });
    lastProfileReq = now;
    try { ack({ ok: true, profile: await profileSummary(acct.acc) }); }
    catch (e) { console.error('profile error:', e.message); ack({ ok: false, error: 'Ошибка сервера' }); }
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

  // ---- shop: only sells; purchases go to the inventory via grantItem
  socket.on('buy', (itemId, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const def = INV.itemDef(itemId);
    if (!def || !def.sources.includes('shop') || !(def.price > 0)) return ack({ ok: false, error: 'Этот предмет не продаётся' });
    const a = acct.acc;
    if (!def.stackable && INV.hasItem(a, def.id)) return ack({ ok: false, error: 'Уже есть в инвентаре', code: 'owned' });
    if (a.balance < def.price) return ack({ ok: false, error: `Не хватает сфер: нужно ${def.price}` });
    const g = INV.grantItem(a, def.id, 1, 'shop');
    if (!g.ok) return ack({ ok: false, error: g.error, code: g.code });
    a.balance -= def.price;
    accountChanged(a);
    ack({ ok: true, profile: ownProfile(a) });
  });

  // ---- inventory: equip / unequip (ownership checked server-side)
  function equip(itemId, ack) {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const def = INV.itemDef(itemId);
    if (!def || def.type !== 'cosmetic') return ack({ ok: false, error: 'Этот предмет нельзя надеть' });
    if (!INV.hasItem(acct.acc, def.id)) return ack({ ok: false, error: 'Этого предмета нет в инвентаре' });
    acct.acc.equipped[def.cat] = def.id;
    accountChanged(acct.acc, { looks: true });
    ack({ ok: true, profile: ownProfile(acct.acc) });
  }
  socket.on('inv:equip', equip);
  socket.on('equip', equip); // old name, kept for compatibility
  socket.on('inv:unequip', (cat, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!has(G.DEFAULT_EQUIPPED, cat)) return ack({ ok: false, error: 'Неверная категория' });
    acct.acc.equipped[cat] = G.DEFAULT_EQUIPPED[cat];
    accountChanged(acct.acc, { looks: true });
    ack({ ok: true, profile: ownProfile(acct.acc) });
  });

  socket.on('upgrade', (key, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!has(G.UPGRADES, key)) return ack({ ok: false, error: 'Нет такого улучшения' });
    const up = G.UPGRADES[key], a = acct.acc, lvl = a.upgrades[key] || 0;
    if (lvl >= up.max) return ack({ ok: false, error: 'Максимальный уровень' });
    const price = up.prices[lvl];
    if (a.balance < price) return ack({ ok: false, error: `Не хватает сфер: нужно ${price}` });
    a.balance -= price;
    a.upgrades[key] = lvl + 1;
    accountChanged(a);
    ack({ ok: true, profile: ownProfile(a) });
  });

  if (TEST_HOOKS) {
    socket.on('test:grant', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      const r = INV.grantItem(acct.acc, d.id, d.qty, d.source || 'admin');
      if (r.ok) accountChanged(acct.acc);
      ack(Object.assign(r, { profile: ownProfile(acct.acc) }));
    });
    socket.on('test:orbs', (n, ack) => {
      ack = safeAck(ack);
      if (!acct || !Number.isInteger(n) || n < 0 || n > 1e6) return ack({ ok: false });
      acct.acc.balance += n;
      accountChanged(acct.acc);
      ack({ ok: true, profile: ownProfile(acct.acc) });
    });
  }

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

  socket.on('disconnect', () => { removePlayer(pl); pl = null; release(); });
});

// ---------------------------------------------------------------- main loop
function collectAround(pl, radius, now) {
  const r2max = (radius + 14) ** 2 * 4;
  for (const o of orbs.values()) {
    const dx = o.x - pl.x, dy = o.y - pl.y, d2 = dx * dx + dy * dy;
    if (d2 > r2max) continue;
    const ot = G.ORB_TYPES[o.t];
    if (d2 > (radius + ot.r) ** 2) continue;
    removeOrb(o, pl.id);
    pl.gained += ot.value;
    pl.session += ot.value;
    pl.acc.balance += ot.value;
    pl.acc.total += ot.value;
    if (o.t === 'l') {
      const g = INV.grantItem(pl.acc, 'x_legend_shard', 1, 'arena'); // example of a non-shop item source
      pl.socket.emit('item', g.ok ? { id: 'x_legend_shard', qty: 1, source: 'arena' } : { error: g.error });
      if (g.ok) emitProfile(pl);
    } else respawnQueue.push(now + rand(SPAWN.respawnMin, SPAWN.respawnMax));
  }
}

function tick() {
  const now = Date.now();
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
      collectAround(pl, radius, now);
    }
    if (pl.gained > 0) { markDirty(pl.acc); pl.socket.emit('bal', { b: pl.acc.balance, t: pl.acc.total, s: pl.session }); pl.gained = 0; }
  }
  spawnTick(now);
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100, pl.lastSeq]);
  io.to('arena').emit('s', { t: now, p, oa: pendingAdds, od: pendingDels });
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
  if (TEST_HOOKS) console.warn('WARNING: OCS_TEST_HOOKS=1 — test-only socket events are enabled');
  await store.purgeExpiredSessions(Date.now());
  setInterval(tick, G.TICK_MS);
  setInterval(everySecond, 1000);
  setInterval(flush, FLUSH_MS);
  setInterval(() => store.purgeExpiredSessions(Date.now()).catch(e => console.error('purge failed:', e.message)), 3600 * 1000);
  scheduleChatClear();
  server.listen(PORT, () => console.log(`Orb Collecting Simulator on http://localhost:${PORT} (version ${VERSION})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
