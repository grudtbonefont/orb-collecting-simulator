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
const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v >= 0 ? v : def; };

// ---------------------------------------------------------------- orb spawning (all numbers documented in README)
const legendEvery = parseInt(process.env.LEGENDARY_EVERY_MS, 10) || 0; // test override
const SPAWN = {
  cell: 300,                       // world is split into 10 x 10 cells of 300 px
  base: 70, perPlayer: 30, min: 90, max: 320, // target orbs = clamp(base + perPlayer * online, min, max)
  // orb tiers + weights: G.ORB_TYPES / G.POOL_WEIGHTS (common +1, uncommon +2, rare +5, epic +10, mythic +50; legendary +25 is timed)
  respawnMin: 3000, respawnMax: 9000, // a collected orb comes back 3-9 s later (somewhere else)
  fillSpread: 4000,                // extra orbs for newly joined players appear over ~4 s
  maxPerTick: 4,                   // at most 80 spawns per second
  orbGap: 70,                      // min distance between orbs
  playerClear: 220,                // never spawn closer than this to a player
  candidates: 6,                   // cells sampled per spawn; the emptiest one wins
  legendFirst: legendEvery || 60000, legendMin: legendEvery || 90000, legendMax: legendEvery || 150000, // timed event
  legendLife: 75000, legendMaxAlive: 1,
  legendWarnMs: 15000,             // «Чутьё легенды» lvl 3: heads-up (no position) this long before a legendary appears
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
    upgrades: Object.fromEntries(G.UPGRADE_KEYS.map(k => [k, 0])), stats: { minigames: 0, bestReaction: null, bestRush: 0, sessions: 0, playMs: 0 },
    createdAt: now, lastSeen: now,
  };
  INV.migrateAccount(a);
  return a;
}
// Only what the owner may see about their own account (never the hash/key).
function ownProfile(a) {
  return { name: a.name, balance: a.balance, total: a.total, equipped: a.equipped, upgrades: a.upgrades, stats: a.stats,
    inventory: a.inventory.slots.map(s => ({ id: s.id, q: s.q, src: s.src })), slots: G.INV_CAP, cap: G.INV_CAP, used: INV.unitsUsed(a), createdAt: a.createdAt };
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
let legendaryAlive = 0, nextLegendAt = Date.now() + SPAWN.legendFirst, legendWarnedFor = 0;
let mythicAlive = 0, evAlive = 0; // mythic orbs (pool, max 1), event orbs (rain / treasure, not part of the pool)
const targetOrbs = () => Math.max(SPAWN.min, Math.min(SPAWN.max, SPAWN.base + SPAWN.perPlayer * players.size));
// one normal pool spawn: weighted tier roll; a mythic only while none is alive and someone is playing (else epic)
function rollPool() {
  const t = G.rollOrbType(G.POOL_WEIGHTS);
  return t === 'm' && (mythicAlive >= G.ORB_TYPES.m.maxAlive || players.size === 0) ? 'e' : t;
}

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
// evKind: 'rain' | 'treasure' for event orbs (5th field = 1 so clients can animate them), undefined for pool orbs
function addOrb(t, pos, evKind) {
  const o = { id: nextOrbId++, x: pos.x, y: pos.y, t, cell: cellOf(pos.x, pos.y) };
  if (t === 'l') { o.expires = Date.now() + SPAWN.legendLife; legendaryAlive++; }
  if (t === 'm') { o.expires = Date.now() + G.ORB_TYPES.m.lifeMs; mythicAlive++; }
  if (evKind) { o.ev = evKind; evAlive++; }
  orbs.set(o.id, o);
  cells[o.cell].add(o.id);
  pendingAdds.push(evKind ? [o.id, o.x, o.y, o.t, 1] : [o.id, o.x, o.y, o.t]);
  if (t === 'm' && !evKind && io) io.to('arena').emit('announce', { text: 'Появилась мифическая сфера (+50 и 3 осколка)! Её покажет компас «Чутьё легенды».', x: o.x, y: o.y });
  return o;
}
function removeOrb(o, byPlayerId) {
  orbs.delete(o.id);
  cells[o.cell].delete(o.id);
  if (o.t === 'l') legendaryAlive--;
  if (o.t === 'm') mythicAlive--;
  if (o.ev) evAlive--;
  pendingDels.push([o.id, byPlayerId || 0]);
}
function spawnTick(now) {
  const target = targetOrbs();
  const normal = orbs.size - legendaryAlive - evAlive;
  for (let missing = target - normal - respawnQueue.length; missing > 0; missing--) respawnQueue.push(now + rand(0, SPAWN.fillSpread));
  let spawned = 0;
  const keep = [];
  for (const due of respawnQueue) {
    if (due > now || spawned >= SPAWN.maxPerTick) { keep.push(due); continue; }
    if (orbs.size - legendaryAlive - evAlive >= target) continue; // target shrank (players left): drop the respawn
    const pos = pickSpot();
    if (!pos) { keep.push(now + 500); continue; }
    addOrb(rollPool(), pos);
    spawned++;
  }
  respawnQueue = keep;
  // legendary: a timed event with cooldown, only while someone is playing
  for (const o of orbs.values()) if (o.expires <= now) { removeOrb(o, 0); if (o.t === 'm') respawnQueue.push(now + rand(SPAWN.respawnMin, SPAWN.respawnMax)); }
  if (ev) nextLegendAt = Math.max(nextLegendAt, ev.endAt + EV_LEGEND_GAP); // never during an arena event
  if (now >= nextLegendAt - SPAWN.legendWarnMs && legendWarnedFor !== nextLegendAt && legendaryAlive < SPAWN.legendMaxAlive && players.size > 0) {
    legendWarnedFor = nextLegendAt;
    const inMs = Math.max(0, Math.round(nextLegendAt - now));
    for (const pl of players.values()) if (G.upLevel('sense', pl.acc.upgrades.sense) >= 3) pl.socket.emit('legend:soon', { in: inMs });
  }
  if (now >= nextLegendAt) {
    if (players.size > 0 && legendaryAlive < SPAWN.legendMaxAlive) {
      const pos = pickSpot();
      if (pos) {
        addOrb('l', pos);
        io.to('arena').emit('announce', { text: 'Появилась легендарная сфера (+25)! Её покажет компас «Чутьё легенды».', x: pos.x, y: pos.y });
        nextLegendAt = now + rand(SPAWN.legendMin, SPAWN.legendMax);
      }
    } else nextLegendAt = now + 5000;
  }
}
// initial fill for an empty arena
for (let i = 0; i < SPAWN.min; i++) { const p = pickSpot(); if (p) addOrb(rollPool(), p); }
pendingAdds = []; pendingDels = [];



// ---------------------------------------------------------------- timed arena events (scheduler + rules; numbers in G.EVENTS)
// EVENT_EVERY_MS: unset = random 6–10 min of online time, 0 = scheduler off (test hooks only), N = fixed gap.
// EVENT_ANNOUNCE_MS (default 25 s countdown) and EVENT_DURATION_MS (override every duration) are for tests.
const EV_EVERY = process.env.EVENT_EVERY_MS === undefined || process.env.EVENT_EVERY_MS === '' ? -1 : envInt('EVENT_EVERY_MS', 0);
const EV_ANNOUNCE = envInt('EVENT_ANNOUNCE_MS', G.EVENT_SCHEDULE.announceMs);
const EV_DURATION = envInt('EVENT_DURATION_MS', 0);
const EV_LEGEND_GAP = 20000; // the legendary orb waits at least this long after an event
let ev = null, evClock = 0, lastEvKind = null;
const nextEventGap = () => (EV_EVERY > 0 ? EV_EVERY : rand(G.EVENT_SCHEDULE.minMs, G.EVENT_SCHEDULE.maxMs));
let evGap = nextEventGap();
const clampW = v => Math.max(60, Math.min(G.WORLD.w - 60, Math.round(Number(v))));
// What clients may know about the running event: kind, phase, times (relative), zone / runner / treasures left. No ids.
function publicEvent(now = Date.now()) {
  if (!ev) return null;
  const d = { kind: ev.kind, phase: ev.phase, in: Math.max(0, Math.round(ev.startAt - now)), left: Math.max(0, Math.round(ev.endAt - now)), dur: ev.dur };
  if (ev.zone) d.zone = ev.zone;
  if (ev.kind === 'treasure' && ev.phase === 'active') { d.remaining = ev.treasureLeft; d.total = ev.treasureTotal; }
  if (ev.runner) d.runner = { x: Math.round(ev.runner.x), y: Math.round(ev.runner.y) };
  return d;
}
// far from every player (and from the other spots already chosen): best of 80 random candidates
function farSpot(margin, avoid = []) {
  let best = null, bestD = -1;
  for (let i = 0; i < 80; i++) {
    const x = rand(margin, G.WORLD.w - margin), y = rand(margin, G.WORLD.h - margin);
    let d = Infinity;
    for (const pl of players.values()) d = Math.min(d, Math.hypot(pl.x - x, pl.y - y));
    for (const a of avoid) d = Math.min(d, Math.hypot(a.x - x, a.y - y) * 1.5);
    if (d > bestD) { bestD = d; best = { x: Math.round(x), y: Math.round(y) }; }
  }
  return best;
}
function evScore(pl) { let s = ev.scores.get(pl.id); if (!s) { s = { pl, score: 0, reward: null }; ev.scores.set(pl.id, s); } return s; }
const addReward = (a, b) => ({ orbs: ((a && a.orbs) || 0) + b.orbs, shards: ((a && a.shards) || 0) + b.shards });
// pays an event reward: orbs (balance + all-time total) and shards via grantItem(source 'event');
// shards that don't fit (inventory full) are paid out at the shop exchange rate instead
function payReward(pl, r) {
  const acc = pl.acc;
  if (r.orbs) { acc.balance += r.orbs; acc.total += r.orbs; }
  if (r.shards) {
    const g = INV.grantItem(acc, G.SHARD_ID, r.shards, 'event');
    if (g.ok) pl.socket.emit('item', { id: G.SHARD_ID, qty: r.shards, source: 'event' });
    else { const comp = r.shards * G.SHARD_EXCHANGE.orbs; acc.balance += comp; pl.socket.emit('item', { error: `${g.error} Вместо осколков: +${comp} сфер.` }); }
  }
  markDirty(acc); emitProfile(pl);
}
function announceEvent(kind, opts = {}) {
  const now = Date.now(), def = G.EVENTS[kind];
  const ann = Number.isFinite(opts.announceMs) ? opts.announceMs : EV_ANNOUNCE;
  const dur = opts.durationMs || EV_DURATION || def.durationMs;
  ev = { kind, phase: 'announce', startAt: now + ann, endAt: now + ann + dur, dur, scores: new Map(), opts, lastPush: 0 };
  if (kind === 'koth') {
    const z = Number.isFinite(opts.x) ? { x: clampW(opts.x), y: clampW(opts.y) } : { x: Math.round(rand(550, G.WORLD.w - 550)), y: Math.round(rand(550, G.WORLD.h - 550)) };
    ev.zone = { x: z.x, y: z.y, r: def.radius };
  }
  nextLegendAt = Math.max(nextLegendAt, ev.endAt + EV_LEGEND_GAP);
  io.to('arena').emit('ev:announce', publicEvent(now));
  systemChat(`Скоро событие «${def.name}»!`);
  console.log(`event announced: ${kind}`);
}
function startEvent(now) {
  const def = G.EVENTS[ev.kind], o = ev.opts;
  ev.phase = 'active';
  if (ev.kind === 'rain') { ev.rainTarget = Math.min(def.extraMax, def.extraBase + def.extraPerPlayer * players.size); ev.rainAlive = 0; }
  else if (ev.kind === 'treasure') {
    const n = o.count || Math.min(def.maxCount, def.count + Math.floor(players.size / def.perPlayers)), placed = [];
    for (let i = 0; i < n; i++) {
      const at = Array.isArray(o.at) && Array.isArray(o.at[i]) ? { x: clampW(o.at[i][0]), y: clampW(o.at[i][1]) } : farSpot(120, placed);
      placed.push(at); addOrb('t', at, 'treasure');
    }
    ev.treasureLeft = ev.treasureTotal = n;
  } else if (ev.kind === 'runner') {
    const at = Number.isFinite(o.x) ? { x: clampW(o.x), y: clampW(o.y) } : farSpot(200);
    ev.runner = { x: at.x, y: at.y, h: rand(0, Math.PI * 2), speed: Number.isFinite(o.speed) ? o.speed : def.speed };
  }
  io.to('arena').emit('ev:start', publicEvent(now));
}
function moveRunner(dt) {
  const R = ev.runner, def = G.EVENTS.runner, s = dt / 1000, W = G.WORLD.w, H = G.WORLD.h;
  let near = null, nd = def.fleeRange;
  for (const pl of players.values()) { const d = Math.hypot(pl.x - R.x, pl.y - R.y); if (d < nd) { nd = d; near = pl; } }
  let dx, dy, sp;
  if (near) { // flee from the nearest player with a slight zig-zag
    dx = (R.x - near.x) / (nd || 1); dy = (R.y - near.y) / (nd || 1);
    const w = Math.sin(Date.now() / 380) * 0.55; [dx, dy] = [dx - dy * w, dy + dx * w]; sp = R.speed;
  } else { R.h += (Math.random() - 0.5) * 0.5; dx = Math.cos(R.h); dy = Math.sin(R.h); sp = def.wander; }
  const m = 170; // walls push it back, so it can be cornered
  if (R.x < m) dx += (m - R.x) / m * 1.4; if (R.x > W - m) dx -= (R.x - (W - m)) / m * 1.4;
  if (R.y < m) dy += (m - R.y) / m * 1.4; if (R.y > H - m) dy -= (R.y - (H - m)) / m * 1.4;
  const l = Math.hypot(dx, dy) || 1;
  R.x = Math.max(40, Math.min(W - 40, R.x + dx / l * sp * s)); R.y = Math.max(40, Math.min(H - 40, R.y + dy / l * sp * s));
  if (!near) R.h = Math.atan2(dy, dx);
}
function pushKoth() {
  const top = Array.from(ev.scores.values()).filter(x => players.get(x.pl.id) === x.pl).sort((a, b) => b.score - a.score).slice(0, 3).map(x => [x.pl.acc.name, Math.floor(x.score)]);
  for (const pl of players.values()) { const sc = ev.scores.get(pl.id); pl.socket.emit('ev:koth', { you: sc ? Math.floor(sc.score) : 0, inside: !!pl.evInside, top }); }
}
function eventTick(now, dt) {
  if (!ev) {
    if (EV_EVERY === 0 || !players.size) return; // the clock only runs while someone is online
    evClock += dt;
    // never next to the legendary orb: not while one is alive or about to appear (heads-up already sent)
    if (evClock >= evGap && legendaryAlive === 0 && now < nextLegendAt - SPAWN.legendWarnMs - 1000) {
      const kinds = G.EVENT_KEYS.filter(k => k !== lastEvKind);
      announceEvent(kinds[Math.floor(Math.random() * kinds.length)]);
    }
    return;
  }
  if (!players.size) { endEvent(now, 'empty'); return; }
  if (ev.phase === 'announce') { if (now < ev.startAt) return; startEvent(now); }
  const def = G.EVENTS[ev.kind];
  if (ev.kind === 'rain') {
    for (let n = 0; n < def.perTick && ev.rainAlive < ev.rainTarget; n++) {
      const p = pickSpot(); if (!p) break;
      addOrb(G.rollOrbType(G.RAIN_WEIGHTS), p, 'rain'); ev.rainAlive++;
    }
  } else if (ev.kind === 'koth') {
    const z = ev.zone;
    for (const pl of players.values()) {
      pl.evInside = Math.hypot(pl.x - z.x, pl.y - z.y) <= z.r;
      if (pl.evInside) evScore(pl).score += dt / 1000 * def.pointsPerSec;
    }
    if (now - ev.lastPush >= 500) { ev.lastPush = now; pushKoth(); }
  } else if (ev.kind === 'runner' && !ev.caught) {
    moveRunner(dt);
    for (const pl of players.values()) {
      if (Math.hypot(pl.x - ev.runner.x, pl.y - ev.runner.y) > G.pickupFor(pl.acc.upgrades.magnet) + def.r) continue;
      const sc = evScore(pl); sc.score = 1; sc.reward = def.reward; ev.caught = pl.acc.name;
      payReward(pl, def.reward);
      ev.endAt = now; break;
    }
  }
  if (now >= ev.endAt) endEvent(now);
}
// results: top 5 (public names + scores + rewards), and every online player gets their own line
function endEvent(now, reason) {
  const e = ev, def = G.EVENTS[e.kind];
  ev = null; evClock = 0; evGap = nextEventGap(); lastEvKind = e.kind;
  for (const o of Array.from(orbs.values())) if (o.ev) removeOrb(o, 0); // leftover rain / treasure orbs vanish
  for (const pl of players.values()) pl.evInside = false;
  if (reason) { io.to('arena').emit('ev:end', { kind: e.kind, cancelled: true, results: [] }); console.log(`event ${e.kind} cancelled (${reason})`); return; }
  const list = Array.from(e.scores.values()).filter(x => players.get(x.pl.id) === x.pl && x.score > 0).sort((a, b) => b.score - a.score);
  if (e.kind === 'koth') {
    const q = list.filter(x => x.score >= def.minScore);
    if (q.length === 1) q[0].reward = def.solo;
    else q.forEach((x, i) => { x.reward = def.rewards[i] || def.participation; });
    for (const x of q) payReward(x.pl, x.reward);
  }
  list.forEach((x, i) => {
    x.place = i + 1;
    const st = x.pl.acc.stats; st.eventsPlayed = (st.eventsPlayed || 0) + 1;
    if (i === 0 || (e.kind === 'treasure' && x.score > 0)) st.eventWins = (st.eventWins || 0) + 1;
    markDirty(x.pl.acc); emitProfile(x.pl); // stats changed
  });
  const row = x => ({ name: x.pl.acc.name, score: Math.floor(x.score), reward: x.reward || null });
  const results = list.slice(0, 5).map(row);
  const extra = e.kind === 'runner' ? { outcome: e.caught ? 'caught' : 'escaped' } : e.kind === 'treasure' ? { remaining: e.treasureLeft, total: e.treasureTotal } : {};
  for (const pl of players.values()) {
    const mine = e.scores.get(pl.id);
    pl.socket.emit('ev:end', Object.assign({ kind: e.kind, results, you: mine && mine.score > 0 ? { score: Math.floor(mine.score), place: mine.place, reward: mine.reward || null } : null }, extra));
  }
  flushSoon();
  console.log(`event ${e.kind} ended: ${list.length} participants`);
}

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
    io.to('arena').emit('chat:clear'); // silent: clients just empty the log (the schedule is not shown to players)
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
app.get('/api/health', (req, res) => res.json({ ok: true, online: players.size, orbs: orbs.size, targetOrbs: targetOrbs(), event: ev ? ev.kind + ':' + ev.phase : null,
  storage: store.mode, version: VERSION, uptimeSec: Math.round(process.uptime()) }));
app.get('/api/shop', (req, res) => res.json({ items: G.ITEMS, upgrades: G.UPGRADES, minigames: G.MINIGAMES, orbs: G.ORB_TYPES, events: G.EVENTS, shardExchange: G.SHARD_EXCHANGE }));
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
  } else if (mg.kind === 'memory') {
    result.rounds = mg.done;
    prize = G.memoryPrize(mg.done);
    result.message = info.timeout ? `Время вышло. Пройдено раундов: ${mg.done}` : mg.done >= def.maxRounds ? `Идеально! Все ${def.maxRounds} раундов` : `Ошибка. Пройдено раундов: ${mg.done}`;
    if (mg.done > (s.bestMemory || 0)) s.bestMemory = mg.done;
  } else if (mg.kind === 'shell') {
    result.cup = mg.final; result.pick = info.pick == null ? null : info.pick; // the hidden cup is revealed only now
    if (info.pick === mg.final) { prize = def.prize; result.message = 'Угадали! Сфера была здесь.'; }
    else result.message = info.timeout ? 'Время вышло — чаша не выбрана.' : 'Мимо! Сфера была под другой чашей.';
  } else if (mg.kind === 'throw') {
    const total = mg.pts.reduce((a, b) => a + b, 0);
    result.points = mg.pts; result.total = total;
    prize = G.throwPrize(total);
    result.message = `Очки за броски: ${mg.pts.join(' + ') || 0} = ${total}`;
  } else if (mg.kind === 'chain') {
    if (info.ms != null) { result.ms = info.ms; prize = G.chainPrize(info.ms); result.message = `Цепочка собрана за ${(info.ms / 1000).toFixed(2)} с`; if (!s.bestChain || info.ms < s.bestChain) s.bestChain = info.ms; }
    else result.message = `Время вышло: собрано ${mg.next - 1} из ${def.n}`;
  }
  if (info.cheat) { prize = 0; result.message = 'Результат отклонён сервером (неправдоподобно быстро).'; }
  if (info.aborted && mg.kind !== 'rush') prize = 0;
  const basePrize = prize;
  prize = G.skillPrize(prize, pl.acc.upgrades.skill); // «Мастер мини-игр»: +5/10/15 %, perfect play stays below half of farming
  if (prize !== basePrize) result.bonus = prize - basePrize;
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
  } else if (kind === 'memory') {
    mg.seq = Array.from({ length: def.maxRounds }, () => crypto.randomInt(def.colors)); mg.round = 0; mg.done = 0;
    setTimeout(() => memoryRound(pl, mg), 50);
  } else if (kind === 'shell') {
    mg.start = crypto.randomInt(def.cups);
    mg.swaps = [];
    for (let i = 0; i < def.swaps; i++) {
      const a = crypto.randomInt(def.cups), b = (a + 1 + crypto.randomInt(def.cups - 1)) % def.cups;
      mg.swaps.push([a, b, Math.round(def.swapMsFrom + (def.swapMsTo - def.swapMsFrom) * i / (def.swaps - 1))]);
    }
    mg.final = G.shellFinal(mg.start, mg.swaps);
    mg.pickFrom = Date.now() + G.shellShuffleMs(mg.swaps) - 150;
    setTimeout(() => { if (pl.mg === mg) pl.socket.emit('mg:shell:setup', { start: mg.start, swaps: mg.swaps, showMs: def.showMs }); }, 0);
    mg.timers.push(setTimeout(() => { if (pl.mg === mg) finishMinigame(pl, { timeout: true }); }, G.shellShuffleMs(mg.swaps) + def.pickTimeoutMs));
  } else if (kind === 'throw') {
    mg.pts = []; mg.i = -1;
    setTimeout(() => throwNext(pl, mg), 50);
  } else if (kind === 'chain') {
    const orbsList = [];
    while (orbsList.length < def.n) {
      const x = 50 + crypto.randomInt(def.w - 100), y = 50 + crypto.randomInt(def.h - 100);
      if (orbsList.every(o => Math.hypot(o.x - x, o.y - y) > def.r * 2 + 18) || orbsList.length && Math.random() < 0.002) orbsList.push({ n: orbsList.length + 1, x, y, r: def.r });
    }
    mg.orbs = orbsList; mg.next = 1; mg.lastTap = 0; mg.goAt = Date.now() + def.countdownMs;
    setTimeout(() => { if (pl.mg === mg) pl.socket.emit('mg:chain:setup', { orbs: orbsList, startIn: def.countdownMs, limitMs: def.limitMs }); }, 0);
    mg.timers.push(setTimeout(() => { if (pl.mg === mg) finishMinigame(pl, { timeout: true }); }, def.countdownMs + def.limitMs));
  }
  return { ok: true, kind, duration: def.duration };
}
// «Память»: show the next round (only the part of the sequence played so far), wait for the attempt
function memoryRound(pl, mg) {
  if (pl.mg !== mg) return;
  const def = G.MINIGAMES.memory;
  mg.round++; mg.roundAt = Date.now();
  pl.socket.emit('mg:memory:show', { round: mg.round, seq: mg.seq.slice(0, mg.round), onMs: def.onMs, gapMs: def.gapMs, leadMs: def.leadMs });
  clearTimeout(mg.roundTimer);
  mg.roundTimer = setTimeout(() => { if (pl.mg === mg) finishMinigame(pl, { timeout: true }); }, G.memoryShowMs(mg.round) + def.inputBaseMs + mg.round * def.inputMsPerStep);
  mg.timers.push(mg.roundTimer);
}
// «Точный бросок»: the server picks target, speed and phase; the marker position is a pure function of time
function throwNext(pl, mg) {
  if (pl.mg !== mg) return;
  const def = G.MINIGAMES.throw;
  mg.i++;
  if (mg.i >= def.throws) return finishMinigame(pl, {});
  mg.cur = { i: mg.i, target: Math.round((0.15 + Math.random() * 0.7) * 1000) / 1000, period: Math.round(def.periodMin + Math.random() * (def.periodMax - def.periodMin)), phase: Math.round(Math.random() * 1000) / 1000, at: Date.now(), done: false };
  pl.socket.emit('mg:throw:start', { i: mg.cur.i, of: def.throws, target: mg.cur.target, period: mg.cur.period, phase: mg.cur.phase });
  const cur = mg.cur;
  mg.timers.push(setTimeout(() => { if (pl.mg === mg && !cur.done) { cur.done = true; mg.pts.push(0); pl.socket.emit('mg:throw:stopped', { i: cur.i, pos: null, pts: 0 }); mg.timers.push(setTimeout(() => throwNext(pl, mg), def.gapMs)); } }, def.throwTimeoutMs));
}
// Actions for the menu games added later (memory / shell / throw / chain). Everything is checked against server state & time.
function minigameAct(pl, d) {
  const mg = pl.mg, now = Date.now();
  if (!mg || !isObj(d) || (mg.acts = (mg.acts || 0) + 1) > 300) return { ok: false };
  const def = G.MINIGAMES[mg.kind];
  if (mg.kind === 'memory') {
    if (d.round !== mg.round || !Array.isArray(d.input) || d.input.length > mg.round || mg.answered === mg.round) return { ok: false };
    mg.answered = mg.round;
    const elapsed = now - mg.roundAt, need = G.memoryShowMs(mg.round) - 100 + d.input.length * def.minInputMs;
    const right = d.input.length === mg.round && d.input.every((c, i) => c === mg.seq[i]);
    if (right && elapsed < need) { finishMinigame(pl, { cheat: true }); return { ok: false, cheat: true }; }
    if (!right) { finishMinigame(pl, {}); return { ok: true, right: false }; }
    mg.done = mg.round;
    if (mg.round >= def.maxRounds) { finishMinigame(pl, {}); return { ok: true, right: true }; }
    clearTimeout(mg.roundTimer);
    mg.timers.push(setTimeout(() => memoryRound(pl, mg), def.pauseMs));
    return { ok: true, right: true };
  }
  if (mg.kind === 'shell') {
    const cup = d.cup;
    if (!Number.isInteger(cup) || cup < 0 || cup >= def.cups) return { ok: false };
    if (now < mg.pickFrom) { finishMinigame(pl, { cheat: true }); return { ok: false, cheat: true }; } // picked before the shuffle ended
    finishMinigame(pl, { pick: cup });
    return { ok: true };
  }
  if (mg.kind === 'throw') {
    const cur = mg.cur;
    if (!cur || cur.done || d.i !== cur.i) return { ok: false };
    const t = now - cur.at - Math.min(Math.max(pl.rtt || 0, 0), 300); // the client saw the marker ~1 RTT later
    if (t < def.minStopMs) return { ok: false, early: true };
    cur.done = true;
    const pos = G.throwPos(t, cur.period, cur.phase), pts = G.throwPoints(Math.abs(pos - cur.target));
    mg.pts.push(pts);
    mg.timers.push(setTimeout(() => throwNext(pl, mg), def.gapMs));
    return { ok: true, i: cur.i, pos: Math.round(pos * 1000) / 1000, pts };
  }
  if (mg.kind === 'chain') {
    const o = mg.orbs[mg.next - 1];
    if (now < mg.goAt - 100 || d.n !== mg.next || !o) return { ok: false };
    if (mg.lastTap && now - mg.lastTap < def.minTapGapMs) return { ok: false, fast: true };
    if (!(Math.hypot(Number(d.x) - o.x, Number(d.y) - o.y) <= o.r * 1.3 + 4)) return { ok: false };
    mg.lastTap = now; mg.next++;
    if (mg.next > def.n) { finishMinigame(pl, { ms: Math.max(0, now - mg.goAt) }); return { ok: true, n: o.n, done: true }; }
    return { ok: true, n: o.n };
  }
  return { ok: false };
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
      inputs: [], budget: 2, lastSeq: 0, session: 0, gained: 0, lucky: 0, jackpots: 0, frac: 0, evInside: false, rtt: 100, mg: null, joinedAt: Date.now(), chatTimes: [], lastChat: '',
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
      chat: chatHistory,
      event: publicEvent(),
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
  // buy(itemId, [qty 1..99], ack) — qty optional (old clients send 1)
  const qtyArg = (q, ack) => (typeof q === 'function' ? [1, q] : [q === undefined ? 1 : q, ack]);
  const badQty = q => typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > G.BUY_MAX_QTY;
  socket.on('buy', (itemId, q, ack) => {
    [q, ack] = qtyArg(q, ack);
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (badQty(q)) return ack({ ok: false, error: `Количество: от 1 до ${G.BUY_MAX_QTY}`, code: 'qty' });
    const def = INV.itemDef(itemId);
    if (def && def.exclusive) return ack({ ok: false, error: 'Эксклюзив — только за осколки в «Лавке осколков»', code: 'exclusive' });
    if (!def || !def.sources.includes('shop') || !(def.price > 0)) return ack({ ok: false, error: 'Этот предмет не продаётся' });
    const a = acct.acc;
    if (!def.stackable && (q > 1 || INV.hasItem(a, def.id))) return ack({ ok: false, error: 'Уже есть в инвентаре', code: 'owned' });
    const cost = def.price * q;
    if (a.balance < cost) return ack({ ok: false, error: `Не хватает сфер: нужно ${cost}`, code: 'funds' });
    const g = INV.grantItem(a, def.id, q, 'shop'); // all-or-nothing (space checked inside)
    if (!g.ok) return ack({ ok: false, error: g.error, code: g.code });
    a.balance -= cost;
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

  // ---- trash: delete items for good (no refund). payload { id, qty, slot? }
  let trashTimes = [];
  socket.on('inv:trash', async (d, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const now = Date.now();
    trashTimes = trashTimes.filter(t => now - t < 5000);
    if (trashTimes.length >= 8) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    trashTimes.push(now);
    if (!isObj(d) || typeof d.id !== 'string') return ack({ ok: false, error: 'Неверный запрос' });
    const a = acct.acc;
    const r = INV.removeItem(a, d.id, d.qty, 'trash', d.slot);
    if (!r.ok) return ack({ ok: false, error: r.error, code: r.code });
    accountChanged(a, { looks: r.unequipped });
    try { await flush(); } catch (_) { /* stays dirty, retried by the periodic flush */ }
    ack({ ok: true, item: r.item, qty: r.qty, left: r.left, unequipped: r.unequipped, profile: ownProfile(a) });
  });


  // ---- «Лавка осколков»: exclusives for legendary shards + shards → orbs. Shards are consumed with removeItem(…, 'shard_shop').
  let shardTimes = [];
  const shardRateOk = now => { shardTimes = shardTimes.filter(t => now - t < 5000); if (shardTimes.length >= 8) return false; shardTimes.push(now); return true; };
  socket.on('shard:buy', async (itemId, q, ack) => {
    [q, ack] = qtyArg(q, ack);
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (badQty(q)) return ack({ ok: false, error: `Количество: от 1 до ${G.BUY_MAX_QTY}`, code: 'qty' });
    if (!shardRateOk(Date.now())) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    const def = INV.itemDef(itemId);
    if (!def || !def.exclusive || !(def.shardPrice > 0)) return ack({ ok: false, error: 'Этого нет в «Лавке осколков»' });
    const a = acct.acc;
    const have = INV.countItem(a, G.SHARD_ID), cost = def.shardPrice * q;
    if (have < cost) return ack({ ok: false, error: `Не хватает осколков: нужно ${cost}, у вас ${have}`, code: 'shards' });
    // all-or-nothing: spend the shards, grant the item; if the item does not fit, the shards are put back exactly as they were
    const snap = { inv: JSON.stringify(a.inventory), owned: a.owned.slice(), eq: Object.assign({}, a.equipped) };
    const r = INV.removeItem(a, G.SHARD_ID, cost, 'shard_shop');
    const g = r.ok ? INV.grantItem(a, def.id, q, 'shard_shop') : r;
    if (!g.ok) { a.inventory = JSON.parse(snap.inv); a.owned = snap.owned; a.equipped = snap.eq; return ack({ ok: false, error: g.error, code: g.code }); }
    accountChanged(a);
    try { await flush(); } catch (_) { /* stays dirty, retried by the periodic flush */ }
    ack({ ok: true, spent: cost, qty: q, profile: ownProfile(a) });
  });
  socket.on('shard:exchange', async (qty, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!Number.isInteger(qty) || qty < 1 || qty > G.SHARD_EXCHANGE.maxPerTrade) return ack({ ok: false, error: `Можно обменять от 1 до ${G.SHARD_EXCHANGE.maxPerTrade} осколков за раз`, code: 'qty' });
    if (!shardRateOk(Date.now())) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    const a = acct.acc;
    const r = INV.removeItem(a, G.SHARD_ID, qty, 'shard_shop');
    if (!r.ok) return ack({ ok: false, error: r.error, code: r.code });
    const got = qty * G.SHARD_EXCHANGE.orbs;
    a.balance += got; // a conversion: balance only, the all-time total (leaderboard) stays «orbs earned»
    accountChanged(a);
    try { await flush(); } catch (_) { /* retried later */ }
    ack({ ok: true, orbs: got, profile: ownProfile(a) });
  });

  socket.on('upgrade', (key, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!has(G.UPGRADES, key)) return ack({ ok: false, error: 'Нет такого улучшения' });
    const up = G.UPGRADES[key], a = acct.acc, lvl = G.upLevel(key, a.upgrades[key]);
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
    socket.on('test:upgrades', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      for (const k of G.UPGRADE_KEYS) if (has(d, k)) acct.acc.upgrades[k] = G.upLevel(k, d[k]);
      accountChanged(acct.acc);
      ack({ ok: true, profile: ownProfile(acct.acc) });
    });
    // force an arena event now (any running one is cancelled); optional zone / runner start, speed, treasure spots, timings
    socket.on('test:event', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d) || !has(G.EVENTS, d.kind)) return ack({ ok: false });
      if (ev) endEvent(Date.now(), 'forced');
      const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
      announceEvent(d.kind, { announceMs: num(d.announceMs), durationMs: num(d.durationMs), x: num(d.x), y: num(d.y), speed: num(d.speed), count: num(d.count), at: Array.isArray(d.at) ? d.at.slice(0, 6) : undefined });
      ack({ ok: true, event: publicEvent() });
    });
    // spawn one orb of each requested tier in a ring around the caller or {x,y} (screenshots / rarity tests)
    socket.on('test:tp', (d, ack) => { // move own player to a point (tests only)
      ack = safeAck(ack);
      if (!pl || !isObj(d) || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return ack({ ok: false });
      pl.x = Math.min(G.WORLD.w - G.PLAYER_R, Math.max(G.PLAYER_R, d.x)); pl.y = Math.min(G.WORLD.h - G.PLAYER_R, Math.max(G.PLAYER_R, d.y)); pl.inputs.length = 0; pl.kx = pl.ky = 0;
      ack({ ok: true });
    });
    socket.on('test:spawn', (d, ack) => {
      ack = safeAck(ack);
      if (!pl || !isObj(d) || !Array.isArray(d.types)) return ack({ ok: false });
      const ring = Number(d.ring) || 150, list = d.types.filter(t => has(G.ORB_TYPES, t)).slice(0, 20);
      const cx = Number.isFinite(d.x) ? d.x : pl.x, cy = Number.isFinite(d.y) ? d.y : pl.y; // centre: the caller, or a given point
      list.forEach((t, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / list.length; addOrb(t, { x: clampW(cx + Math.cos(a) * ring * 1.6), y: clampW(cy + Math.sin(a) * ring) }); });
      ack({ ok: true, n: list.length });
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
  socket.on('mg:act', (d, ack) => {
    ack = safeAck(ack);
    if (!pl || !pl.mg || !['memory', 'shell', 'throw', 'chain'].includes(pl.mg.kind)) return ack({ ok: false });
    ack(minigameAct(pl, d));
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
    if (o.t === 't') { // event treasure: fixed reward (not multiplied), first come first served
      if (ev && ev.kind === 'treasure' && ev.phase === 'active') {
        const def = G.EVENTS.treasure, sc = evScore(pl);
        sc.score++; sc.reward = addReward(sc.reward, def.reward); ev.treasureLeft--;
        payReward(pl, def.reward);
        io.to('arena').emit('ev:treasure', { name: pl.acc.name, left: ev.treasureLeft });
        if (!ev.treasureLeft) ev.endAt = now;
      }
      continue;
    }
    const rw = G.orbReward(ot.value, pl.acc.upgrades, pl, Math.random, o.t); // «находка», luck ×2, multiplier (fraction in pl.frac) — server-side only
    if (rw.lucky) pl.lucky++;
    if (rw.jackpot) pl.jackpots++;
    pl.gained += rw.value;
    pl.session += rw.value;
    pl.acc.balance += rw.value;
    pl.acc.total += rw.value;
    if (o.ev === 'rain' && ev && ev.kind === 'rain') { ev.rainAlive--; evScore(pl).score += rw.value; }
    if (ot.shards && (o.t === 'l' || o.t === 'm')) { // legendary 1, mythic 3 shards
      const g = INV.grantItem(pl.acc, G.SHARD_ID, ot.shards, 'arena');
      pl.socket.emit('item', g.ok ? { id: G.SHARD_ID, qty: ot.shards, source: 'arena' } : { error: g.error });
      if (g.ok) emitProfile(pl);
      if (o.t === 'm') { systemChat(`${pl.acc.name} поймал(а) мифическую сферу!`); respawnQueue.push(now + rand(SPAWN.respawnMin, SPAWN.respawnMax)); }
    } else if (!o.ev) respawnQueue.push(now + rand(SPAWN.respawnMin, SPAWN.respawnMax));
  }
}

let lastTickAt = Date.now();
function tick() {
  const now = Date.now(), dt = Math.min(250, now - lastTickAt);
  lastTickAt = now;
  for (const pl of players.values()) {
    pl.x0 = pl.x; pl.y0 = pl.y;
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
    if (pl.gained > 0) {
      markDirty(pl.acc);
      const msg = { b: pl.acc.balance, t: pl.acc.total, s: pl.session };
      if (pl.lucky) msg.l = pl.lucky; // «Удача» triggered this tick (client shows ×2)
      if (pl.jackpots) msg.j = pl.jackpots; // «Удача» find: a common/uncommon orb counted as epic
      pl.socket.emit('bal', msg); pl.gained = 0; pl.lucky = 0; pl.jackpots = 0;
    }
  }
  if (players.size > 1) { // players push each other apart (G.separatePlayers)
    const list = [];
    for (const pl of players.values()) { pl.mx = pl.x - pl.x0; pl.my = pl.y - pl.y0; pl.lvl = pl.acc.upgrades.speed || 0; list.push(pl); }
    G.separatePlayers(list);
  }
  spawnTick(now);
  eventTick(now, dt);
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100, pl.lastSeq]);
  const st = { t: now, p, oa: pendingAdds, od: pendingDels };
  if (ev && ev.runner && ev.phase === 'active') st.rn = [Math.round(ev.runner.x), Math.round(ev.runner.y)]; // «Сфера-беглец» position
  io.to('arena').emit('s', st);
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
