'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const G = require('./public/shared.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'players.json');
const MAX_ORBS = 380;

// ---------------------------------------------------------------- persistence
let db = { players: {} };
let dirty = false;
function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!db.players) db.players = {};
    }
  } catch (e) { console.error('Failed to load DB, starting fresh:', e.message); db = { players: {} }; }
  console.log(`Loaded ${Object.keys(db.players).length} players`);
}
function saveDb(force) {
  if (!dirty && !force) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
    dirty = false;
  } catch (e) { console.error('Save failed:', e.message); }
}
function markDirty() { dirty = true; }
loadDb();
setInterval(saveDb, 3000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveDb(true); process.exit(0); });

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function newProfile(name, tokenHash) {
  return {
    name, tokenHash, balance: 0, total: 0,
    owned: G.DEFAULT_OWNED.slice(), equipped: Object.assign({}, G.DEFAULT_EQUIPPED),
    upgrades: { magnet: 0, speed: 0 }, stats: { minigames: 0, bestReaction: null, bestRush: 0 },
    createdAt: Date.now(), lastSeen: Date.now(),
  };
}
function publicProfile(p) {
  return { name: p.name, balance: p.balance, total: p.total, owned: p.owned, equipped: p.equipped, upgrades: p.upgrades, stats: p.stats };
}

// ---------------------------------------------------------------- game state
const players = new Map();  // id -> player
const byKey = new Map();    // lowercased name -> player
const orbs = new Map();     // id -> {id,x,y,t}
let nextOrbId = 1, nextPlayerId = 1;
let pendingAdds = [], pendingDels = [];

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
  if (t === 'l') io && io.emit('announce', { text: 'Появилась легендарная сфера (+25)!', x: o.x, y: o.y });
  return o;
}

function playerMeta(pl) { return { id: pl.id, name: pl.profile.name, eq: pl.profile.equipped, x: pl.x, y: pl.y }; }
function emitProfile(pl) { pl.socket.emit('profile', publicProfile(pl.profile)); }

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

function leaderboard(limit, name) {
  const list = Object.values(db.players).filter(p => p.total > 0 || byKey.has(p.name.toLowerCase()))
    .sort((a, b) => b.total - a.total || a.createdAt - b.createdAt);
  const map = (p, i) => ({ rank: i + 1, name: p.name, total: p.total, color: G.ITEM_BY_ID[p.equipped.color]?.value || '#3ee0ff', online: byKey.has(p.name.toLowerCase()) });
  let me = null;
  if (name) {
    const idx = list.findIndex(p => p.name.toLowerCase() === String(name).toLowerCase());
    if (idx >= 0) me = map(list[idx], idx);
  }
  return { updatedAt: new Date().toISOString(), totalPlayers: list.length, players: list.slice(0, limit).map(map), me };
}
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  res.json(leaderboard(limit, req.query.name));
});
app.get('/api/health', (req, res) => res.json({ ok: true, online: players.size, orbs: orbs.size, uptimeSec: Math.round(process.uptime()) }));
app.get('/api/shop', (req, res) => res.json({ items: G.ITEMS, upgrades: G.UPGRADES, minigames: G.MINIGAMES }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 20000 });

for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
pendingAdds = [];

const NAME_RE = /^[\p{L}\p{N}_\- ]{2,16}$/u;
const TOKEN_RE = /^[A-Za-z0-9-]{16,64}$/;
const safeAck = ack => (typeof ack === 'function' ? ack : () => {});

function removePlayer(pl) {
  if (!pl || !players.has(pl.id)) return;
  if (pl.mg) finishMinigame(pl, { aborted: true });
  players.delete(pl.id);
  if (byKey.get(pl.key) === pl) byKey.delete(pl.key);
  pl.profile.lastSeen = Date.now();
  markDirty();
  io.emit('pleave', pl.id);
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
  if (mg.kind === 'reaction') {
    if (info.early) { result.message = 'Слишком рано! Взнос сгорел.'; }
    else if (info.timeout) { result.message = 'Время вышло — вы не нажали.'; }
    else if (info.rt != null) {
      result.rt = info.rt;
      for (const [ms, p] of G.REACTION_PRIZES) if (info.rt < ms) { prize = p; break; }
      result.message = `Время реакции: ${info.rt} мс`;
      const s = pl.profile.stats;
      if (s.bestReaction == null || info.rt < s.bestReaction) s.bestReaction = info.rt;
    }
  } else if (mg.kind === 'rush') {
    prize = Math.max(0, mg.score);
    result.score = mg.score; result.hits = mg.hits;
    result.message = `Очки: ${mg.score} (попаданий: ${mg.hits})`;
    if (mg.score > (pl.profile.stats.bestRush || 0)) pl.profile.stats.bestRush = mg.score;
  }
  if (info.aborted && mg.kind === 'reaction') prize = 0;
  result.prize = prize;
  pl.profile.balance += prize;
  pl.profile.total += prize;
  pl.profile.stats.minigames = (pl.profile.stats.minigames || 0) + 1;
  markDirty();
  if (!info.aborted) { pl.socket.emit('mg:result', result); emitProfile(pl); }
}

function startMinigame(pl, kind) {
  const def = G.MINIGAMES[kind];
  if (!def) return { ok: false, error: 'Неизвестная мини-игра' };
  if (pl.mg) return { ok: false, error: 'Мини-игра уже идёт' };
  if (Date.now() < (pl.mgCooldownUntil || 0)) return { ok: false, error: 'Подождите секунду…' };
  if (pl.profile.balance < def.fee) return { ok: false, error: `Нужно ${def.fee} сфер для входа` };
  pl.profile.balance -= def.fee;
  markDirty();
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

  socket.on('join', (data, ack) => {
    ack = safeAck(ack);
    if (pl) return ack({ ok: false, error: 'Вы уже в игре' });
    const name = String((data && data.name) || '').trim().replace(/\s+/g, ' ');
    const token = String((data && data.token) || '');
    if (!NAME_RE.test(name)) return ack({ ok: false, error: 'Ник: 2–16 символов (буквы, цифры, _ - пробел)' });
    if (!TOKEN_RE.test(token)) return ack({ ok: false, error: 'Неверный токен, обновите страницу' });
    const key = name.toLowerCase();
    const th = hashToken(token);
    let prof = db.players[key];
    if (!prof) { prof = db.players[key] = newProfile(name, th); markDirty(); }
    else if (prof.tokenHash !== th) return ack({ ok: false, error: 'Этот ник уже занят другим игроком. Выберите другой.' });

    const existing = byKey.get(key);
    if (existing) {
      existing.socket.emit('kicked', 'Вы вошли в игру с другой вкладки или устройства.');
      removePlayer(existing);
      existing.socket.disconnect(true);
    }
    pl = {
      id: nextPlayerId++, key, socket, profile: prof,
      x: 200 + Math.random() * (G.WORLD.w - 400), y: 200 + Math.random() * (G.WORLD.h - 400),
      inputs: [], budget: 2, lastSeq: 0, session: 0, gained: 0, rtt: 100, mg: null, joinedAt: Date.now(),
    };
    prof.lastSeen = Date.now();
    players.set(pl.id, pl);
    byKey.set(key, pl);
    ack({
      ok: true, you: pl.id, profile: publicProfile(prof), world: G.WORLD,
      orbs: Array.from(orbs.values(), o => [o.id, o.x, o.y, o.t]),
      players: Array.from(players.values(), playerMeta),
    });
    socket.broadcast.emit('pjoin', playerMeta(pl));
    console.log(`join: ${name} (#${pl.id}), online ${players.size}`);
  });

  socket.on('input', m => {
    if (!pl || !m) return;
    const s = Number(m.s), x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(s) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (pl.inputs.length >= 40) return;
    pl.inputs.push({ s, x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) });
  });

  socket.on('spong', v => {
    if (!pl) return;
    const now = Date.now(), d = now - Number(v);
    if (d >= 0 && d < 10000) pl.rtt = pl.rtt * 0.7 + d * 0.3;
  });

  socket.on('buy', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    const it = G.ITEM_BY_ID[itemId];
    const p = pl.profile;
    if (!it) return ack({ ok: false, error: 'Нет такого предмета' });
    if (p.owned.includes(it.id)) return ack({ ok: false, error: 'Уже куплено' });
    if (p.balance < it.price) return ack({ ok: false, error: `Не хватает сфер: нужно ${it.price}` });
    p.balance -= it.price;
    p.owned.push(it.id);
    p.equipped[it.cat] = it.id;
    markDirty();
    io.emit('pmeta', playerMeta(pl));
    ack({ ok: true, profile: publicProfile(p) });
  });

  socket.on('equip', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    const it = G.ITEM_BY_ID[itemId];
    if (!it || !pl.profile.owned.includes(it.id)) return ack({ ok: false, error: 'Предмет не куплен' });
    pl.profile.equipped[it.cat] = it.id;
    markDirty();
    io.emit('pmeta', playerMeta(pl));
    ack({ ok: true, profile: publicProfile(pl.profile) });
  });

  socket.on('upgrade', (key, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Сначала войдите в игру' });
    const up = G.UPGRADES[key];
    if (!up) return ack({ ok: false, error: 'Нет такого улучшения' });
    const p = pl.profile, lvl = p.upgrades[key] || 0;
    if (lvl >= up.max) return ack({ ok: false, error: 'Максимальный уровень' });
    const price = up.prices[lvl];
    if (p.balance < price) return ack({ ok: false, error: `Не хватает сфер: нужно ${price}` });
    p.balance -= price;
    p.upgrades[key] = lvl + 1;
    markDirty();
    ack({ ok: true, profile: publicProfile(p) });
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
    if (!pl || !pl.mg || pl.mg.kind !== 'rush' || !m) return ack({ ok: false });
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
      pl.profile.balance += ot.value;
      pl.profile.total += ot.value;
    }
  }
}

setInterval(() => {
  for (const pl of players.values()) {
    pl.budget = Math.min(pl.budget + 1, 6);
    // drop backlog if a client queue grows too large (keeps latency bounded)
    while (pl.inputs.length > 12) pl.lastSeq = pl.inputs.shift().s;
    const speed = G.speedFor(pl.profile.upgrades.speed);
    const radius = G.pickupFor(pl.profile.upgrades.magnet);
    while (pl.budget >= 1 && pl.inputs.length) {
      const inp = pl.inputs.shift();
      pl.budget -= 1;
      G.applyInput(pl, inp.x, inp.y, speed);
      pl.lastSeq = inp.s;
      collectAround(pl, radius);
    }
    if (pl.gained > 0) { markDirty(); pl.socket.emit('bal', { b: pl.profile.balance, t: pl.profile.total, s: pl.session }); pl.gained = 0; }
  }
  let budget = 12;
  while (orbs.size < MAX_ORBS && budget-- > 0) spawnOrb();
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100, pl.lastSeq]);
  io.emit('s', { t: Date.now(), p, oa: pendingAdds, od: pendingDels });
  pendingAdds = []; pendingDels = [];
}, G.TICK_MS);

setInterval(() => {
  const top = Array.from(players.values()).sort((a, b) => b.session - a.session || a.joinedAt - b.joinedAt).slice(0, 10)
    .map(pl => [pl.id, pl.profile.name, pl.session]);
  io.emit('top', { online: players.size, top });
  const now = Date.now();
  for (const pl of players.values()) pl.socket.emit('sping', now);
}, 1000);

server.listen(PORT, () => console.log(`Orb Collecting Simulator on http://localhost:${PORT}`));
