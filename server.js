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
const DAILY = require('./lib/daily');
const CODES = require('./lib/codes');
const C = require('./public/content.js');
const createFeatures = require('./lib/features');
const { createTradeSystem } = require('./lib/trade');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const FLUSH_MS = 3000;
const BCRYPT_COST = 10;
const AUTH_MAX_FAILS = 5, AUTH_LOCK_MS = 60 * 1000;
const CHAT_HISTORY = 100, CHAT_MIN_GAP_MS = 1500, CHAT_WINDOW_MS = 10000, CHAT_WINDOW_MAX = 5;
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
const SPAWN = {
  cell: 300,                       // world (2 zones of 6000×6000) is split into 40 x 20 cells of 300 px
  base: 280, perPlayer: 60, min: 360, max: 1000, // zone-1 target = clamp(base + perPlayer * online, min, max) (4× the old area)
  zone2Share: Number(process.env.OCS_ZONE2_SHARE) || 1,  // zone 2 has the same orb count/density as zone 1, just better tier odds
  // orb tiers + weights: G.ORB_TYPES / G.POOL_WEIGHTS (common +1, uncommon +2, rare +5, epic +10, legendary +25, mythic +50; legendary/mythic are capped and announced)
  respawnMin: 3000, respawnMax: 9000, // a collected orb comes back 3-9 s later (somewhere else)
  fillSpread: 4000,                // extra orbs for newly joined players appear over ~4 s
  maxPerTick: 4,                   // at most 80 spawns per second
  orbGap: 70,                      // min distance between orbs
  playerClear: 220,                // never spawn closer than this to a player
  candidates: 6,                   // cells sampled per spawn; the emptiest one wins
  // legendary: a normal spawn-table tier (0.24 % per spawn in zone 1, 0.5 % in zone 2), no timer; ≤ 2 alive, 75 s life
};

const store = createStore();

// ---------------------------------------------------------------- accounts (live cache + debounced persistence)
const profiles = new Map(); // account key -> live account object (online, held by a lobby socket, or not yet flushed)
const holders = new Map();  // account key -> number of authenticated sockets (lobby or arena)
const dirty = new Set();
const codeTries = new Map(); // account key -> recent promo-code attempt timestamps (rate limit)
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
  const { pwResetMark, ...stats } = a.stats || {}; // internal marker stays server-side
  return { name: a.name, balance: a.balance, shards: (a.stats && a.stats.shards) || 0, codesUsed: new Set((a.codes || []).map(c => String(c).trim().toUpperCase())).size, total: a.total, equipped: a.equipped, upgrades: a.upgrades, stats, mustChangePw: !!(a.stats && a.stats.mustChangePw),
    inventory: a.inventory.slots.map(s => ({ id: s.id, q: s.q, src: s.src })), slots: G.INV_CAP, cap: G.INV_CAP, used: INV.unitsUsed(a), createdAt: a.createdAt };
}
async function loadAccount(key) {
  if (profiles.has(key)) return profiles.get(key);
  const acc = await store.getAccount(key); // returns a migrated account
  if (!acc) return null;
  if (profiles.has(key)) return profiles.get(key); // loaded concurrently
  profiles.set(key, acc);
  progressWipeV1(acc);
  codesWipeV1(acc);
  if (FX) FX.achReset(acc); // one-time achievement reset (stats.achResetV2)
  return acc;
}
// One-time progress wipe, explicitly confirmed by the owner for exactly these accounts (exact names, case-sensitive).
// Resets all game progress to a fresh account; keeps the account, name, password hash, creation date, admin status (name-based),
// ban / mute / warn flags, password-reset markers and used promo codes. A backup of the old progress (no hash / tokens) is logged first.
const WIPE_V1 = ['DragonzTV', 'Simbobeze_2', 'DragonzMobile'];
// One-time (owner-confirmed): clear the used promo codes of the same 3 accounts and give their activations back to the global counters.
function codesWipeV1(acc) {
  if (!acc || !WIPE_V1.includes(acc.name) || !acc.stats || acc.stats.wipeCodesV1) return false;
  const old = Array.isArray(acc.codes) ? acc.codes.slice() : [];
  console.log('[wipeCodesV1] backup ' + JSON.stringify({ name: acc.name, codes: old }));
  acc.codes = []; acc.stats.wipeCodesV1 = Date.now(); markDirty(acc);
  for (const c of new Set(old)) store.releaseCodeUse(c).catch(e => console.error('[wipeCodesV1] release failed:', e.message));
  console.log(`[wipeCodesV1] cleared ${old.length} used codes of ${acc.name}`);
  return true;
}
function progressWipeV1(acc) {
  if (!acc || !WIPE_V1.includes(acc.name) || (acc.stats && acc.stats.wipeV1)) return false;
  const { passHash, ...rest } = acc;
  console.log('[wipeV1] backup ' + JSON.stringify(rest));
  const old = acc.stats || {}, fresh = newAccount(acc.name, acc.passHash);
  const keep = {};
  for (const k of ['ban', 'muteUntil', 'warns', 'mustChangePw', 'pwResetMark']) if (old[k] !== undefined) keep[k] = old[k];
  acc.balance = 0; acc.total = 0; acc.inventory = fresh.inventory; acc.owned = fresh.owned; acc.equipped = fresh.equipped; acc.upgrades = fresh.upgrades;
  acc.stats = Object.assign(fresh.stats, keep, { shards: 0, shardMigrationV1: true, wipeV1: Date.now() });
  INV.migrateAccount(acc);
  markDirty(acc); lbCache.clear();
  console.log('[wipeV1] wiped progress of ' + acc.name);
  return true;
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
let FX = null; // lib/features.js: mini-events, achievements, daily quests, boss

function newPublicId() { let id; do { id = crypto.randomInt(1, 2 ** 31 - 1); } while (players.has(id)); return id; }

const NX = Math.ceil(G.WORLD.w / SPAWN.cell), NY = Math.ceil(G.WORLD.h / SPAWN.cell);
const cells = Array.from({ length: NX * NY }, () => new Set()); // orb ids per cell
const cellOf = (x, y) => Math.min(NY - 1, Math.floor(y / SPAWN.cell)) * NX + Math.min(NX - 1, Math.floor(x / SPAWN.cell));
let respawnQueue = [];      // { due, z } respawns for normal (pool) orbs, per zone
let legendaryAlive = 0; // legendary orbs on the field (stats only — no cap, chance only)
let mythicAlive = 0, evAlive = 0; // mythic orbs (pool, max 1), event orbs (rain / treasure, not part of the pool)
const targetOrbs = () => Math.max(SPAWN.min, Math.min(SPAWN.max, SPAWN.base + SPAWN.perPlayer * players.size));
const luckyOn = () => !!(ev && ev.kind === 'lucky' && ev.phase === 'active');
const targetZone = z => (z === 1 ? targetOrbs() : Math.round(targetOrbs() * SPAWN.zone2Share)) * (luckyOn() ? G.EVENTS.lucky.spawnMult : 1);
const zoneCount = { 1: 0, 2: 0 }; // normal (pool) orbs alive per zone
// one normal pool spawn: weighted tier roll; a mythic only while none is alive and someone is playing (else epic)
function rollPool(z = 1) {
  const w = z === 2 ? G.ZONE2_WEIGHTS : G.POOL_WEIGHTS, t = G.rollOrbType(discoOn() ? G.luckyWeights(luckyOn() ? G.luckyWeights(w) : w, DISCO.rareMult) : luckyOn() ? G.luckyWeights(w) : w); // «Волна удачи»: rare+ ×2
  if (t === 'l') return players.size === 0 || (ev && ev.kind !== 'lucky') ? 'e' : 'l'; // chance only; not while nobody can catch it (75 s life, announced); never during an arena event (except «Волна удачи»)
  if (t === 'x') return players.size === 0 || (ev && ev.kind !== 'lucky') ? 'a' : 'x';
  return t; // mythic: by chance only, no cap / timer
}

function spotIsFree(x, y) {
  if (inObstacle(x, y, 20)) return false;
  { const A = G.SPAWN_ALTAR; if (Math.hypot(x - A.x, y - A.y) < A.clearR) return false; } // no orbs on the ruined altar
  { const S = G.SHOP_PAD; if (Math.hypot(x - S.x, y - S.y) < S.r + 220) return false; } // hut footprint north of pad
  for (const pl of players.values()) { const dx = pl.x - x, dy = pl.y - y; if (dx * dx + dy * dy < SPAWN.playerClear ** 2) return false; }
  const cx = Math.floor(x / SPAWN.cell), cy = Math.floor(y / SPAWN.cell);
  for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    if (i < 0 || j < 0 || i >= NX || j >= NY) continue;
    for (const id of cells[j * NX + i]) { const o = orbs.get(id); const dx = o.x - x, dy = o.y - y; if (dx * dx + dy * dy < SPAWN.orbGap ** 2) return false; }
  }
  return true;
}
// best-of-k emptiest cell, then a few rejection-sampled points inside it (Poisson-disc-ish)
const ZCOLS = Math.round(G.ZONE_W / SPAWN.cell); // cell columns per zone
function pickSpot(z = 1) {
  const m = 40;
  for (let attempt = 0; attempt < 4; attempt++) {
    let best = -1, bestN = Infinity;
    for (let k = 0; k < SPAWN.candidates; k++) {
      const col = (z === 2 ? ZCOLS : 0) + Math.floor(Math.random() * ZCOLS), c = Math.floor(Math.random() * NY) * NX + col, n = cells[c].size + Math.random() * 0.5;
      if (n < bestN) { bestN = n; best = c; }
    }
    const x0 = (best % NX) * SPAWN.cell, y0 = Math.floor(best / NX) * SPAWN.cell;
    for (let t = 0; t < 8; t++) {
      const lo = z === 2 ? G.ZONE_W + 60 : m, hi = z === 2 ? G.WORLD.w - m : G.ZONE_W - 60;
      const x = Math.round(Math.max(lo, Math.min(hi, x0 + rand(15, SPAWN.cell - 15))));
      const y = Math.round(Math.max(m, Math.min(G.WORLD.h - m, y0 + rand(15, SPAWN.cell - 15))));
      if (spotIsFree(x, y)) return { x, y };
    }
  }
  return null; // world is crowded right now; try again next tick
}
// evKind: 'rain' | 'treasure' for event orbs (5th field = 1 so clients can animate them), undefined for pool orbs
function addOrb(t, pos, evKind) {
  const o = { id: nextOrbId++, x: pos.x, y: pos.y, t, cell: cellOf(pos.x, pos.y), z: G.zoneOf(pos.x) };
  if (!evKind) { o.pool = true; zoneCount[o.z]++; }
  if (t === 'l') { o.expires = Date.now() + G.ORB_TYPES.l.lifeMs; legendaryAlive++; }
  if (t === 'x') { o.expires = Date.now() + G.ORB_TYPES.x.lifeMs; }
  if (t === 'm') { o.expires = Date.now() + G.ORB_TYPES.m.lifeMs; mythicAlive++; }
  if (evKind) { o.ev = evKind; evAlive++; }
  orbs.set(o.id, o);
  cells[o.cell].add(o.id);
  pendingAdds.push(evKind ? [o.id, o.x, o.y, o.t, 1] : [o.id, o.x, o.y, o.t]);
  if (t === 'l' && !evKind && io) io.to('arena').emit('announce', { text: 'Появилась легендарная сфера (+25)! Её покажет компас «Чутьё легенды».', x: o.x, y: o.y });
  if (t === 'x' && !evKind && io) io.to('arena').emit('announce', { text: 'Появилась астральная сфера (+35 и 2 осколка)!', x: o.x, y: o.y });
  if (t === 'm' && !evKind && io) io.to('arena').emit('announce', { text: 'Появилась мифическая сфера (+50 и 3 осколка)! Её покажет компас «Чутьё легенды».', x: o.x, y: o.y });
  return o;
}
function removeOrb(o, byPlayerId) {
  orbs.delete(o.id);
  cells[o.cell].delete(o.id);
  if (o.t === 'l') legendaryAlive--;
  if (o.t === 'm') mythicAlive--;
  if (o.ev) evAlive--;
  if (o.pool) zoneCount[o.z]--;
  pendingDels.push([o.id, byPlayerId || 0]);
}
function spawnTick(now) {
  // per-zone targets; queue entries are { due, z }
  for (const z of [1, 2]) {
    const queued = respawnQueue.reduce((n, q) => n + (q.z === z ? 1 : 0), 0);
    for (let missing = targetZone(z) - zoneCount[z] - queued; missing > 0; missing--) respawnQueue.push({ due: now + rand(0, SPAWN.fillSpread), z });
  }
  let spawned = 0;
  const keep = [];
  for (const q of respawnQueue) {
    if (q.due > now || spawned >= SPAWN.maxPerTick * (luckyOn() ? 6 : 2)) { keep.push(q); continue; } // «Волна удачи» fills the ×2 field in a few seconds
    if (zoneCount[q.z] >= targetZone(q.z)) continue; // target shrank (players left): drop the respawn
    const pos = pickSpot(q.z);
    if (!pos) { keep.push({ due: now + 500, z: q.z }); continue; }
    addOrb(rollPool(q.z), pos);
    spawned++;
  }
  respawnQueue = keep;
  for (const o of orbs.values()) {
    if ((o.t === 'm' || o.t === 'l' || o.t === 'x') && !Number.isFinite(o.expires)) o.expires = now + G.ORB_TYPES[o.t].lifeMs; // timed tiers without a lifetime get one
    if (o.expires <= now) removeOrb(o, 0); // legendary / mythic lifetime
  }
}



// ---------------------------------------------------------------- weekend bonus (Sat + Sun Moscow time); OCS_WEEKEND=on|off forces it (tests)
const WK_FORCE = process.env.OCS_WEEKEND;
function weekendState(now = Date.now()) {
  if (WK_FORCE === 'off') return { on: false, left: 0 };
  if (WK_FORCE === 'on') return { on: true, left: Math.max(60000, G.weekendInfo(now).left || 86400000) };
  return G.weekendInfo(now);
}
const weekendOn = now => weekendState(now).on;
// ---------------------------------------------------------------- admin (exactly one account, checked server-side by the logged-in account name as stored)
const ADMIN_NAME = 'DragonzTV';
const isAdmin = acc => !!acc && acc.name === ADMIN_NAME;
const adminLog = (acc, action, detail) => { const d = detail ? JSON.stringify(detail).slice(0, 300) : ''; console.log(`[admin] ${acc ? acc.name : '?'}: ${action}${d ? ' ' + d : ''}`); adminLogBuf.push({ at: Date.now(), by: acc ? acc.name : '?', action, d }); while (adminLogBuf.length > 200) adminLogBuf.shift(); }; // no IPs / tokens
const DISCO = { orbMult: 1.5, luckMult: 1.5, rareMult: 1.5, defMin: 3, maxMin: 30 };
// admin expansion: action log (memory, last 200), custom event, weather / night, restart countdown, admin promo codes (DB)
const adminLogBuf = [];
let weather = '', night = false, restartAt = 0;
const adminCodes = new Map(); // CODE -> { code, rewards{orbs,shards,items[]}, maxUses, expiresAt, disabled, createdAt, by }
const findAdminCode = input => { const k = CODES.norm(input); const c = k && adminCodes.get(k); return c && !c.builtin && !c.disabled && !c.deleted ? c : null; };
// built-in codes (lib/codes.js) deleted from the panel: a { code, builtin: true, deleted: true } marker row in the admin-codes table
const findBuiltinCode = input => { const c = CODES.findCode(input); if (!c) return null; const m = adminCodes.get(CODES.norm(c.code)); return m && m.deleted ? null : c; };
// Stackable boosts (admin only): every start adds an instance; identical instances stack by MULTIPLYING (×2 + ×2 = ×4).
// Each instance has its own timer and can be stopped on its own from the panel.
let boosts = [], boostSeq = 0;
const boostsOn = (now = Date.now()) => boosts.filter(b => b.until > now);
const boostMult = (kind, key, now = Date.now()) => boostsOn(now).reduce((m, b) => (!kind || b.kind === kind) ? m * (b[key] || 1) : m, 1);
function addBoost(o) {
  const b = Object.assign({ id: ++boostSeq }, o); boosts.push(b);
  b.timer = setTimeout(() => { boosts = boosts.filter(x => x !== b); pushFx(); if (b.kind === 'custom') systemChat(`⭐ Событие «${b.name}» закончилось`); }, b.until - Date.now());
  if (b.kind === 'custom') systemChat(`⭐ Событие «${b.name}»: сферы ×${b.orb}, удача ×${b.luck}, скорость ×${b.spd}`); else systemChat(`✖️2 Сферы ×2 на ${Math.round((b.until - Date.now()) / 60000)} мин`);
  pushFx(); return b;
}
function stopBoosts(pred) { const out = boosts.filter(pred); for (const b of out) { clearTimeout(b.timer); if (b.kind === 'custom') systemChat(`⭐ Событие «${b.name}» закончилось`); } boosts = boosts.filter(b => !out.includes(b)); pushFx(); return out.length; }
function setCustomEv(o) { if (o) addBoost(Object.assign({ kind: 'custom' }, o)); else stopBoosts(b => b.kind === 'custom'); }
const customOn = (now = Date.now()) => boostsOn(now).some(b => b.kind === 'custom');
let discoUntil = 0, discoTimer = null;
const discoOn = (now = Date.now()) => discoUntil > now;
const x2On = (now = Date.now()) => boostsOn(now).some(b => b.kind === 'x2');
function fxState(now = Date.now()) { return { disco: Math.max(0, discoUntil - now), x2: boostsOn(now).filter(b => b.kind === 'x2').reduce((m, b) => Math.max(m, b.until - now), 0), x2m: boostMult('x2', 'orb', now), custom: customAgg(now), boosts: boostsOn(now).map(b => ({ id: b.id, kind: b.kind, name: b.name || 'Сферы ×2', left: b.until - now, orb: b.orb, luck: b.luck, spd: b.spd })), weather, night, restart: restartAt > now ? restartAt - now : 0 }; }
function customAgg(now) { const l = boostsOn(now).filter(b => b.kind === 'custom'); return l.length ? { name: l.map(b => b.name).join(' + '), left: Math.max(...l.map(b => b.until - now)), orb: boostMult('custom', 'orb', now), luck: boostMult('custom', 'luck', now), spd: boostMult('custom', 'spd', now), n: l.length } : null; }
function pushFx() { if (io) io.to('arena').emit('fx', fxState()); }
function setDisco(min) { // min > 0: start / restart; 0: end now
  clearTimeout(discoTimer);
  const was = discoOn();
  if (min > 0) { discoUntil = Date.now() + min * 60000; discoTimer = setTimeout(() => { discoUntil = 0; pushFx(); systemChat('🪩 Диско-ивент закончился'); }, min * 60000); systemChat(`🪩 Диско-ивент! Сферы ×1,5 и удача ×1,5 на ${min} мин`); }
  else { discoUntil = 0; if (was) systemChat('🪩 Диско-ивент закончился'); }
  pushFx();
}
function setX2(min) { if (min > 0) addBoost({ kind: 'x2', orb: 2, until: Date.now() + min * 60000 }); else stopBoosts(b => b.kind === 'x2'); }

// ---------------------------------------------------------------- temporary obstacles + rotating lasers (numbers in G.OBSTACLES)
// OBSTACLES=0 turns them off (the test suite does, except the obstacle tests).
const OBS_ON = process.env.OBSTACLES !== '0', OB = G.OBSTACLES;
let obstacles = [], nextObsId = 1, obsDueAt = Date.now() + rand(OB.everyMinMs, OB.everyMaxMs), robotDueAt = Date.now() + rand(OB.robotEveryMinMs, OB.robotEveryMaxMs);
function obsReach(o) { return o.k === 'rect' ? Math.hypot(o.w, o.h) / 2 : o.k === 'laser' ? o.len : o.k === 'robot' ? OB.robotRange * 0.6 : o.r; }
function inObstacle(x, y, pad = 0) {
  for (const o of obstacles) {
    if (o.k === 'rect') { if (Math.abs(x - o.x) <= o.w / 2 + pad && Math.abs(y - o.y) <= o.h / 2 + pad) return true; }
    else if (Math.hypot(x - o.x, y - o.y) <= o.r + pad) return true;
  }
  return false;
}
// the public shape (times relative to now so clients don't need a synced clock)
function publicObstacles(now = Date.now()) {
  return obstacles.map(o => { const d = { id: o.id, k: o.k, x: o.x, y: o.y, life: o.expires - now };
    if (o.k === 'rect') { d.w = o.w; d.h = o.h; } else d.r = o.r;
    if (o.k === 'laser') { d.len = o.len; d.w = o.w; d.a = +G.laserAngle(o, now).toFixed(4); d.arm = Math.max(0, o.armAt - now); }
    return d; });
}
const pushObstacles = () => io && io.to('arena').emit('obs', publicObstacles());
// makes one obstacle (random kind / size unless forced); null if no free spot was found
function spawnObstacle(now, f = {}) {
  const robot = f.kind === 'robot'; // robots come only from their own timer (robotTimer), never instead of an obstacle
  const laser = !robot && (f.kind ? f.kind === 'laser' : Math.random() < OB.laserChance);
  let o;
  if (robot) o = { k: 'robot', r: OB.robotR, aim: null, nextShot: now + 1500, face: rand(0, Math.PI * 2) };
  else if (laser) o = { k: 'laser', r: OB.pylonR, len: Math.round(rand(OB.beamMin, OB.beamMax)), w: (Math.random() < 0.5 ? -1 : 1) * rand(OB.spinMin, OB.spinMax), a0: rand(0, Math.PI * 2), t0: now, armAt: now + OB.warnMs };
  else {
    const kind = f.kind || ['wall', 'block', 'rock'][Math.floor(Math.random() * 3)];
    if (kind === 'rock') o = { k: 'circle', r: Math.round(rand(112, 238)) };
    else if (kind === 'block') o = { k: 'rect', w: Math.round(rand(225, 425)), h: Math.round(rand(225, 425)) };
    else { const L = Math.round(rand(650, 1200)), T = Math.round(rand(85, 125)); o = Math.random() < 0.5 ? { k: 'rect', w: L, h: T } : { k: 'rect', w: T, h: L }; }
  }
  const reach = obsReach(o) + 30;
  let at = null;
  for (let i = 0; i < 40 && !at; i++) {
    const x = Number.isFinite(f.x) ? f.x : Math.round(rand(reach + 100, G.WORLD.w - reach - 100)), y = Number.isFinite(f.y) ? f.y : Math.round(rand(reach + 100, G.WORLD.h - reach - 100));
    const ok = Number.isFinite(f.x) || (G.doorDist(x) > OB.doorClear + reach &&
      Math.hypot(x - G.SPAWN_ALTAR.x, y - G.SPAWN_ALTAR.y) > G.SPAWN_ALTAR.clearR + reach &&
      Math.hypot(x - G.SHOP_PAD.x, y - G.SHOP_PAD.y) > G.SHOP_PAD.r + 220 + reach &&
      Array.from(players.values()).every(pl => Math.hypot(pl.x - x, pl.y - y) > OB.playerClear + reach) &&
      obstacles.every(b => Math.hypot(b.x - x, b.y - y) > obsReach(b) + reach + OB.gap));
    if (ok) at = { x, y };
  }
  if (!at) return null;
  Object.assign(o, { id: nextObsId++, x: at.x, y: at.y, expires: now + (f.lifeMs || rand(OB.lifeMinMs, OB.lifeMaxMs)) });
  obstacles.push(o);
  for (const b of Array.from(orbs.values())) if (b.pool && inObstacle(b.x, b.y, 12) && inObstacleOne(o, b.x, b.y, 12)) { // orbs under it move elsewhere
    removeOrb(b, 0); respawnQueue.push({ due: now + 300, z: b.z });
  }
  pushObstacles();
  return o;
}
function inObstacleOne(o, x, y, pad) { return o.k === 'rect' ? Math.abs(x - o.x) <= o.w / 2 + pad && Math.abs(y - o.y) <= o.h / 2 + pad : Math.hypot(x - o.x, y - o.y) <= o.r + pad; }
// a laser touch costs penaltyPct of the balance (capped), then invulnMs of immunity; up to dropMax of the lost orbs fall nearby
function laserHit(pl, o, now, src = 'laser') {
  pl.zapUntil = now + OB.invulnMs;
  const loss = src === 'boss' ? C.bossPenalty(pl.acc.balance) : src === 'robot' ? G.robotPenalty(pl.acc.balance) : G.laserPenalty(pl.acc.balance);
  FX.onZap(pl);
  if (!loss) return;
  if (TRADE) {
    const g2 = TRADE.mutationGuard(pl.acc, 'orbs', null, loss);
    if (g2) {
      // Prefer cancelling the trade over leaving offered orbs unreserved after a hit
      TRADE.onLeave(pl);
    }
  }
  pl.acc.balance -= loss; markDirty(pl.acc);
  const drops = Math.min(OB.dropMax, src !== 'laser' ? Math.ceil(loss / 2) : loss); // robot: about half of the loss drops
  for (let i = 0; i < drops; i++) {
    const a = rand(0, Math.PI * 2), d = rand(70, 160), x = Math.round(Math.max(30, Math.min(G.WORLD.w - 30, pl.x + Math.cos(a) * d))), y = Math.round(Math.max(30, Math.min(G.WORLD.h - 30, pl.y + Math.sin(a) * d)));
    if (G.zoneOf(x) !== G.zoneOf(pl.x) || inObstacle(x, y, 10)) continue;
    const b = addOrb('c', { x, y }, 'drop'); b.expires = now + OB.dropLifeMs;
  }
  pl.socket.emit('bal', { b: pl.acc.balance, t: pl.acc.total, s: pl.session });
  pl.socket.emit('zap', { loss, inv: OB.invulnMs, src });
}
// iron robots: pick the nearest player in range (same zone), aim for aimMs (telegraph), then fire a slow shot
let shots = [], nextShotId = 1;
function robotTick(now) {
  const dt = G.TICK_MS / 1000;
  for (const o of obstacles) {
    if (o.k !== 'robot') continue;
    if (o.aim) {
      const pl = players.get(o.aim.pid);
      if (pl) { o.aim.x = pl.x; o.aim.y = pl.y; o.face = Math.atan2(pl.y - o.y, pl.x - o.x); }
      if (now >= o.aim.fireAt) {
        const a = o.face, sx = o.x + Math.cos(a) * (o.r + 12), sy = o.y + Math.sin(a) * (o.r + 12);
        shots.push({ id: nextShotId++, x: sx, y: sy, vx: Math.cos(a) * OB.shotSpeed, vy: Math.sin(a) * OB.shotSpeed, dieAt: now + OB.shotLifeMs, z: G.zoneOf(o.x) });
        o.aim = null; o.nextShot = now + rand(OB.shotEveryMin, OB.shotEveryMax);
      }
    } else if (now >= o.nextShot) {
      let best = null, bd = OB.robotRange;
      for (const pl of players.values()) { const d = Math.hypot(pl.x - o.x, pl.y - o.y); if (d < bd && G.zoneOf(pl.x) === G.zoneOf(o.x)) { bd = d; best = pl; } }
      if (best) o.aim = { pid: best.id, x: best.x, y: best.y, fireAt: now + OB.aimMs }; else o.nextShot = now + 400;
    }
  }
  shots = shots.filter(b => {
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (now >= b.dieAt || b.x < 0 || b.y < 0 || b.x > G.WORLD.w || b.y > G.WORLD.h || G.zoneOf(b.x) !== b.z) return false;
    for (const o of obstacles) if (o.k !== 'robot' && inObstacleOne(o, b.x, b.y, 0)) return false; // walls / rocks / pylons block shots
    for (const pl of players.values()) {
      if (Math.hypot(pl.x - b.x, pl.y - b.y) > G.PLAYER_R + OB.shotR) continue;
      if (!(pl.zapUntil > now)) laserHit(pl, null, now, 'robot');
      return false;
    }
    return true;
  });
}
function obstacleTick(now) {
  let changed = false;
  if (obstacles.some(o => o.expires <= now)) { obstacles = obstacles.filter(o => o.expires > now); changed = true; }
  if (!obstacles.some(o => o.k === 'robot')) shots = [];
  if (changed) pushObstacles();
  if (OBS_ON && players.size && now >= obsDueAt) {
    obsDueAt = now + rand(OB.everyMinMs, OB.everyMaxMs);
    if (obstacles.filter(o => o.k !== 'robot').length < OB.maxAlive) spawnObstacle(now);
  }
  if (OBS_ON && players.size && now >= robotDueAt) { // separate rare roll for the iron robot
    robotDueAt = now + rand(OB.robotEveryMinMs, OB.robotEveryMaxMs);
    if (obstacles.filter(o => o.k === 'robot').length < OB.robotMax && Math.random() < OB.robotChance) spawnObstacle(now, { kind: 'robot' });
  }
  robotTick(now);
  for (const o of obstacles) {
    if (o.k !== 'laser' || now < o.armAt) continue;
    for (const pl of players.values()) if (!(pl.zapUntil > now) && G.laserHits(o, pl.x, pl.y, now, G.PLAYER_R)) laserHit(pl, o, now);
  }
}

// ---------------------------------------------------------------- timed arena events (scheduler + rules; numbers in G.EVENTS)
// EVENT_EVERY_MS: unset = random 2–6 min of online time, 0 = scheduler off (test hooks only), N = fixed gap.
// EVENT_ANNOUNCE_MS (default 25 s countdown) and EVENT_DURATION_MS (override every duration) are for tests.
// Since the «Волна удачи» update events are ON by default again (random 2–6 min, only G.AUTO_EVENT_KEYS); EVENTS_ENABLED=0 turns them off.
const EV_EVERY = process.env.EVENT_EVERY_MS !== undefined && process.env.EVENT_EVERY_MS !== '' ? envInt('EVENT_EVERY_MS', 0) : process.env.EVENTS_ENABLED === '0' ? 0 : -1;
const EV_ANNOUNCE = envInt('EVENT_ANNOUNCE_MS', G.EVENT_SCHEDULE.announceMs);
const EV_DURATION = envInt('EVENT_DURATION_MS', 0);
let ev = null, evClock = 0, lastEvKind = null;
const nextEventGap = () => (EV_EVERY > 0 ? EV_EVERY : rand(G.EVENT_SCHEDULE.minMs, G.EVENT_SCHEDULE.maxMs));
let evGap = nextEventGap();
const clampW = v => Math.max(60, Math.min(G.ZONE_W - 60, Math.round(Number(v))));
// What clients may know about the running event: kind, phase, times (relative), zone / runner / treasures left. No ids.
function publicEvent(now = Date.now()) {
  if (!ev) return null;
  const d = { kind: ev.kind, phase: ev.phase, in: Math.max(0, Math.round(ev.startAt - now)), left: Math.max(0, Math.round(ev.endAt - now)), dur: ev.dur };
  if (ev.zone) d.zone = ev.zone;
  if (ev.kind === 'treasure' && ev.phase === 'active') { d.remaining = ev.treasureLeft; d.total = ev.treasureTotal; }
  if (ev.runners) { d.runners = ev.runners.filter(r => !r.caught).map(r => [r.id, Math.round(r.x), Math.round(r.y)]); d.caught = ev.runners.length - d.runners.length; d.total = ev.runners.length; }
  return d;
}
// far from every player (and from the other spots already chosen): best of 80 random candidates
function farSpot(margin, avoid = []) {
  let best = null, bestD = -1;
  for (let i = 0; i < 80; i++) {
    const x = rand(margin, G.ZONE_W - margin), y = rand(margin, G.ZONE_H - margin);
    let d = Infinity;
    for (const pl of players.values()) d = Math.min(d, Math.hypot(pl.x - x, pl.y - y));
    for (const a of avoid) d = Math.min(d, Math.hypot(a.x - x, a.y - y) * 1.5);
    if (d > bestD) { bestD = d; best = { x: Math.round(x), y: Math.round(y) }; }
  }
  return best;
}
// a random spot anywhere on the map (either zone), away from the zone wall, obstacles and the other picks
function randomSpot(margin, avoid = [], minDist = 0) {
  let p = null;
  for (let i = 0; i < 60; i++) {
    const x = Math.round(rand(margin, G.WORLD.w - margin)), y = Math.round(rand(margin, G.WORLD.h - margin));
    if (Math.abs(x - G.ZONE_W) < margin + 40 || inObstacle(x, y, 40)) continue;
    p = { x, y };
    if (avoid.every(a => Math.hypot(a.x - x, a.y - y) >= minDist)) return p;
  }
  return p || { x: Math.round(rand(margin, G.ZONE_W - margin)), y: Math.round(rand(margin, G.WORLD.h - margin)) };
}
const clampWorld = (v, hi) => Math.max(60, Math.min(hi - 60, Math.round(Number(v))));
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
    const z = Number.isFinite(opts.x) ? { x: clampW(opts.x), y: clampW(opts.y) } : { x: Math.round(rand(550, G.ZONE_W - 550)), y: Math.round(rand(550, G.ZONE_H - 550)) };
    ev.zone = { x: z.x, y: z.y, r: def.radius };
  }
  io.to('arena').emit('ev:announce', publicEvent(now));
  systemChat(`Скоро событие «${def.name}»!`);
  console.log(`event announced: ${kind}`);
}
function startEvent(now) {
  const def = G.EVENTS[ev.kind], o = ev.opts;
  ev.phase = 'active';
  if (ev.kind === 'rain') { ev.rainTarget = Math.min(def.extraMax, def.extraBase + def.extraPerPlayer * players.size); ev.rainAlive = 0; }
  else if (ev.kind === 'treasure') { // 5 treasures at random places all over the map
    const n = o.count || def.count, placed = [];
    for (let i = 0; i < n; i++) {
      const at = Array.isArray(o.at) && Array.isArray(o.at[i]) ? { x: clampWorld(o.at[i][0], G.WORLD.w), y: clampWorld(o.at[i][1], G.WORLD.h) } : randomSpot(120, placed, def.minDist);
      placed.push(at); addOrb('t', at, 'treasure');
    }
    ev.treasureLeft = ev.treasureTotal = n;
  } else if (ev.kind === 'runner') { // 3 runaway orbs at random places; each one stays inside its own zone
    const n = o.count || def.count, placed = [];
    for (let i = 0; i < n; i++) {
      const at = i === 0 && Number.isFinite(o.x) ? { x: clampWorld(o.x, G.WORLD.w), y: clampWorld(o.y, G.WORLD.h) } : runnerSpot(placed);
      placed.push(at);
      ev.runners = ev.runners || [];
      ev.runners.push({ id: i + 1, x: at.x, y: at.y, z: G.zoneOf(at.x), h: rand(0, Math.PI * 2), speed: Number.isFinite(o.speed) ? o.speed : def.speed, caught: null, tireAt: Date.now() + rand(2000, def.tireEveryMs), restUntil: 0 });
    }
  }
  io.to('arena').emit('ev:start', publicEvent(now));
}
function catchRunner(R, pl) {
  const def = G.EVENTS.runner, sc = evScore(pl); sc.score++; sc.reward = addReward(sc.reward, def.reward); R.caught = pl.acc.name;
  payReward(pl, def.reward); FX.onRunner(pl);
  io.to('arena').emit('ev:runner', { name: pl.acc.name, left: ev.runners.filter(r => !r.caught).length });
  if (ev.runners.every(r => r.caught)) ev.endAt = Date.now();
}
// client claim «I touched runner id at my position x,y»: validated against the server position of the player
// (anti-cheat: within what latency can explain) and the runner's recent positions (touch radius + touchPad)
function runnerTouch(pl, m) {
  const def = G.EVENTS.runner;
  if (!ev || ev.kind !== 'runner' || ev.phase !== 'active' || !ev.runners || !m || typeof m !== 'object') return;
  const id = Number(m.id), x = Number(m.x), y = Number(m.y);
  if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const R = ev.runners.find(r => r.id === id && !r.caught); if (!R) return;
  const lagPx = G.speedFor(pl.acc.upgrades.speed) * Math.min(0.5, (pl.rtt || 0) / 1000 + 0.15) + 40;
  if (Math.hypot(x - pl.x, y - pl.y) > lagPx) return; // claimed spot too far from where the server has the player
  if (G.zoneOf(x) !== R.z && G.zoneOf(pl.x) !== R.z) return;
  const lim = G.PLAYER_R + def.r + def.touchPad, pts = (R.hist || []).concat([{ x: R.x, y: R.y }]);
  if (pts.some(h => Math.hypot(x - h.x, y - h.y) <= lim)) catchRunner(R, pl);
}
// a Раннер starts 900–1600 px from a random online player, in that player's zone (so nobody gets runners behind a locked door)
function runnerSpot(avoid) {
  const def = G.EVENTS.runner, list = Array.from(players.values());
  for (let i = 0; i < 40 && list.length; i++) {
    const pl = list[Math.floor(Math.random() * list.length)], a = rand(0, Math.PI * 2), d = rand(def.spawnNear[0], def.spawnNear[1]);
    const z = G.zoneOf(pl.x), X0 = z === 2 ? G.ZONE_W : 0, x = Math.round(pl.x + Math.cos(a) * d), y = Math.round(pl.y + Math.sin(a) * d);
    if (x < X0 + 200 || x > X0 + G.ZONE_W - 200 || y < 200 || y > G.WORLD.h - 200 || inObstacle(x, y, 60)) continue;
    if (avoid.some(p => Math.hypot(p.x - x, p.y - y) < 500)) continue;
    return { x, y };
  }
  return randomSpot(200, avoid, 1200);
}
function moveRunner(R, dt) {
  const def = G.EVENTS.runner, s = dt / 1000, X0 = R.z === 2 ? G.ZONE_W : 0, W = G.ZONE_W, H = G.ZONE_H;
  let near = null, nd = def.fleeRange;
  for (const pl of players.values()) { const d = Math.hypot(pl.x - R.x, pl.y - R.y); if (d < nd) { nd = d; near = pl; } }
  let dx, dy, sp;
  if (near) { // flee from the nearest player with a slight zig-zag
    dx = (R.x - near.x) / (nd || 1); dy = (R.y - near.y) / (nd || 1);
    const w = Math.sin(Date.now() / 380) * 0.55; [dx, dy] = [dx - dy * w, dy + dx * w]; sp = R.speed;
    const now = Date.now(); // it tires: every ~5 s it slows to 35 % for 1.5 s
    if (now >= R.tireAt) { R.restUntil = now + def.restMs; R.tireAt = now + def.restMs + def.tireEveryMs; }
    if (now < R.restUntil) sp *= def.restSpeed;
  } else { R.h += (Math.random() - 0.5) * 0.5; dx = Math.cos(R.h); dy = Math.sin(R.h); sp = def.wander; }
  const m = 170; // walls push it back, so it can be cornered
  const rx = R.x - X0;
  if (rx < m) dx += (m - rx) / m * 1.4; if (rx > W - m) dx -= (rx - (W - m)) / m * 1.4;
  if (R.y < m) dy += (m - R.y) / m * 1.4; if (R.y > H - m) dy -= (R.y - (H - m)) / m * 1.4;
  const l = Math.hypot(dx, dy) || 1;
  R.x = Math.max(X0 + 40, Math.min(X0 + W - 40, R.x + dx / l * sp * s)); R.y = Math.max(40, Math.min(H - 40, R.y + dy / l * sp * s));
  G.resolveObstacles(R, obstacles); // can't hide inside walls / rocks
  R.x = Math.max(X0 + 40, Math.min(X0 + W - 40, R.x)); R.y = Math.max(40, Math.min(H - 40, R.y));
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
    if (evClock >= evGap && !FX.bossBusy()) { // legendaries on the field don't hold events back; the boss does
      const kinds = G.AUTO_EVENT_KEYS.filter(k => k !== lastEvKind);
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
  } else if (ev.kind === 'runner') {
    for (const R of ev.runners) {
      if (R.caught) continue;
      moveRunner(R, dt);
      R.hist = (R.hist || []).filter(h => now - h.t <= def.historyMs); R.hist.push({ t: now, x: R.x, y: R.y });
      for (const pl of players.values()) { // lag-compensated: closest of the runner's recent positions (what the client was looking at)
        const lim = G.pickupFor(pl.acc.upgrades.magnet) + def.r + def.catchPad;
        if (R.hist.some(h => Math.hypot(pl.x - h.x, pl.y - h.y) <= lim)) { catchRunner(R, pl); break; }
      }
    }
    if (ev.runners.every(r => r.caught)) ev.endAt = now;
  }
  if (now >= ev.endAt) endEvent(now);
}
// results: top 5 (public names + scores + rewards), and every online player gets their own line
function endEvent(now, reason) {
  const e = ev, def = G.EVENTS[e.kind];
  ev = null; evClock = 0; evGap = nextEventGap(); lastEvKind = e.kind;
  for (const o of Array.from(orbs.values())) if (o.ev === 'rain' || o.ev === 'treasure') removeOrb(o, 0); // leftover rain / treasure orbs vanish
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
    const st = x.pl.acc.stats; st.eventsPlayed = (st.eventsPlayed || 0) + 1; FX.onEventPlayed(x.pl);
    if (i === 0 || ((e.kind === 'treasure' || e.kind === 'runner') && x.score > 0)) st.eventWins = (st.eventWins || 0) + 1;
    if (e.kind === 'lucky') st.luckyPlayed = (st.luckyPlayed || 0) + 1;
    markDirty(x.pl.acc); emitProfile(x.pl); // stats changed
  });
  const row = x => ({ name: x.pl.acc.name, score: Math.floor(x.score), reward: x.reward || null });
  const results = list.slice(0, 5).map(row);
  const caught = e.runners ? e.runners.filter(r => r.caught).length : 0;
  const extra = e.kind === 'runner' ? { outcome: caught === e.runners.length ? 'caught' : caught ? 'partial' : 'escaped', caught, total: e.runners.length } : e.kind === 'treasure' ? { remaining: e.treasureLeft, total: e.treasureTotal } : {};
  for (const pl of players.values()) {
    const mine = e.scores.get(pl.id);
    pl.socket.emit('ev:end', Object.assign({ kind: e.kind, results, you: mine && mine.score > 0 ? { score: Math.floor(mine.score), place: mine.place, reward: mine.reward || null } : null }, extra));
  }
  flushSoon();
  console.log(`event ${e.kind} ended: ${list.length} participants`);
}

// Public data about a player: public id, nickname, cosmetics, position. Nothing else.
function playerMeta(pl) { const tr = pl.troll && pl.troll.until > Date.now() ? pl.troll : null; return { id: pl.id, name: pl.acc.name, eq: tr && tr.color ? Object.assign({}, pl.acc.equipped, { color: tr.color }) : pl.acc.equipped, x: pl.x, y: pl.y, sz: tr && tr.size ? tr.size : 1 }; }
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

// ---------------------------------------------------------------- chat (in memory only: rolling last CHAT_HISTORY messages, gone after a restart)
let chatHistory = [];
let chatSeq = 0;
function pushChat(msg, keep) {
  msg.id = ++chatSeq; msg.ts = Date.now();
  if (keep) { chatHistory.push(msg); while (chatHistory.length > CHAT_HISTORY) chatHistory.shift(); }
  io.to('arena').emit('chat', msg);
}
function systemChat(text) { pushChat({ sys: true, t: text }, false); }

// ---------------------------------------------------------------- one-shot admin password reset
// PW_RESET_USER=<nick> + PW_RESET_HASH=<bcrypt hash>: on boot the account's password hash is replaced ONCE (a fingerprint
// of the hash is stored in stats.pwResetMark, so later boots with the same env do nothing). Progress is untouched; the
// player is asked to set a new password (profile → «Сменить пароль»). Neither the hash nor the user's IP is logged.
async function applyPasswordReset() {
  const user = String(process.env.PW_RESET_USER || '').trim().toLowerCase(), hash = String(process.env.PW_RESET_HASH || '').trim();
  if (!user || !hash) return;
  if (!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash)) { console.warn('password reset: PW_RESET_HASH is not a bcrypt hash, ignored'); return; }
  try {
    const acc = await store.getAccount(user);
    if (!acc) { console.warn('password reset: account not found'); return; }
    const mark = sha256('pwreset:' + hash).slice(0, 16);
    if (acc.stats && acc.stats.pwResetMark === mark) { console.log('password reset: already applied, skipped'); return; }
    if (!(await store.setPassHash(acc.key, hash))) { console.warn('password reset: not applied'); return; }
    acc.passHash = hash; acc.stats = Object.assign({}, acc.stats, { pwResetMark: mark, mustChangePw: true });
    await store.saveAccounts([acc]);
    profiles.delete(acc.key);
    console.log('password reset: applied for 1 account');
  } catch (e) { console.error('password reset failed:', e.message); }
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
app.get('/api/health', (req, res) => res.json({ ok: true, perf: req.query.perf === '1' ? (perf.at = 0, perfReport()) : perfReport(), online: players.size, orbs: orbs.size, targetOrbs: targetOrbs(), event: ev ? ev.kind + ':' + ev.phase : null, eventsEnabled: EV_EVERY !== 0, weekend: weekendState().on, obstacles: obstacles.length, mini: FX.miniNow() ? FX.miniNow().kind : null, boss: FX.bossNow() ? FX.bossNow().phase : null, world: G.WORLD,
  storage: store.mode, version: VERSION, uptimeSec: Math.round(process.uptime()) }));
app.get('/api/shop', (req, res) => res.json({ items: G.ITEMS, upgrades: G.UPGRADES, minigames: G.MINIGAMES, orbs: G.ORB_TYPES, events: G.EVENTS, shardExchange: G.SHARD_EXCHANGE }));
try { const td = require('./lib/temp-dump'); td.mountDumpRoute(app, () => store try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); }try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); } store.pool); td.mountRestoreRoute(app, () => store try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); }try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); } store.pool); } catch (e) { console.error('temp-dump mount failed:', e try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); }try { require('./lib/temp-dump').mountDumpRoute(app, () => store && store.pool); } catch (e) { console.error('temp-dump mount failed:', e && e.message); } e.message); }
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => { console.error('http error:', err && err.message); res.status(500).type('text').send('Server error'); }); // eslint-disable-line no-unused-vars

const server = http.createServer(app);
io = new Server(server, { maxHttpBufferSize: 10 * 1024, pingInterval: 10000, pingTimeout: 20000, serveClient: true });
FX = createFeatures({ io: () => io, players, orbs, addOrb, removeOrb, pickSpot, inObstacle, payReward, markDirty, emitProfile, systemChat, flushSoon,
  penalize: (pl, now, src) => laserHit(pl, null, now, src), mainEventBusy: () => !!ev, testHooks: TEST_HOOKS,
  nearLaser: (pl, now) => obstacles.some(o => o.k === 'laser' && G.laserHits(o, pl.x, pl.y, now, 150)) }); // «По краю»: within 150 px of an armed beam

let TRADE = null;
function initTrade() {
  TRADE = createTradeSystem({
    store, profiles, byKey, players, markDirty, flush, flushSoon, emitProfile, accountChanged, systemChat,
  });
}

// ---------------------------------------------------------------- auth helpers
// Cyrillic letters that look like Latin ones (typed on a Russian phone keyboard)
const HOMO = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b', 'н': 'h', 'і': 'i', 'І': 'I', 'ј': 'j', 'Ј': 'J' };
// password variants tried only after a miss, to rescue phone-keyboard edits: trimmed spaces and an auto-capitalised
// (or auto-lowercased) first letter. Stored hashes are never changed; one login attempt still counts as one failure.
function pwVariants(pw) {
  const flip = x => (x ? (x[0] === x[0].toLowerCase() ? x[0].toUpperCase() : x[0].toLowerCase()) + x.slice(1) : x), t = pw.trim();
  return new Set([t, flip(pw), flip(t)].filter(v => v && v !== pw));
}
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
  if (TRADE) TRADE.onLeave(pl);
  FX.onLeave(pl);
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
  prize = G.skillPrize(prize, pl.acc.upgrades.skill); // «Мастер мини-игр»: +11.6/23.1/34.7 % on top of the ×2 mini-game buff, flawless rotation of all games stays below farming
  if (prize !== basePrize) result.bonus = prize - basePrize;
  result.prize = prize;
  pl.acc.balance += prize;
  pl.acc.total += prize;
  s.minigames = (s.minigames || 0) + 1;
  if (!info.aborted && prize > 0) s.mgWins = (s.mgWins || 0) + 1;
  markDirty(pl.acc);
  if (!info.aborted) { FX.onMinigame(pl); pl.socket.emit('mg:result', result); emitProfile(pl); }
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
    const A = G.SPAWN_ALTAR, jitter = () => (Math.random() - 0.5) * A.platformR * 0.7;
    const spawn = { x: A.x + jitter(), y: A.y + jitter() }; // ruined altar, centre of zone 1
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
    FX.onJoin(pl);
    console.log(`join: ${acc.name}, online ${players.size}`);
    return {
      you: pl.id, profile: ownProfile(acc), world: G.WORLD,
      orbs: Array.from(orbs.values(), o => [o.id, o.x, o.y, o.t]),
      players: Array.from(players.values(), playerMeta),
      chat: chatHistory,
      event: publicEvent(),
      obstacles: publicObstacles(),
      weekend: weekendState().left,
      fx: fxState(), pots: publicPots(), fun: funPublic(), poll: pollPublic(), admin: isAdmin(acc),
      ...FX.joinState(),
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
      let password = typeof data.password === 'string' ? data.password : '';
      if (data.mode === 'register') { password = password.trim(); if (typeof data.confirm === 'string') data.confirm = data.confirm.trim(); } // stray spaces from phone keyboards
      let acc;
      if (data.mode === 'register') {
        const nErr = R.nicknameError(name);
        if (nErr) { return ack({ ok: false, error: nErr, field: 'name' }); }
        const pErr = R.passwordError(password);
        if (pErr) { return ack({ ok: false, error: pErr, field: 'password' }); }
        if (data.confirm !== undefined && data.confirm !== password) { return ack({ ok: false, error: 'Пароли не совпадают — введите пароль ещё раз во втором поле', field: 'confirm', code: 'confirm' }); }
        if (registrations >= 5) return ack({ ok: false, error: 'Слишком много регистраций с этой страницы. Обновите страницу и попробуйте снова.', code: 'reg_limit' });
        const key = name.toLowerCase();
        if (profiles.has(key) || await store.getAccount(key)) { return ack({ ok: false, error: 'Этот ник уже занят. Выберите другой.', field: 'name' }); }
        const hash = await bcrypt.hash(password, BCRYPT_COST);
        acc = newAccount(name, hash);
        if (!(await store.createAccount(acc))) { return ack({ ok: false, error: 'Этот ник уже занят. Выберите другой.', field: 'name' }); }
        registrations++;
        profiles.set(acc.key, acc);
        console.log(`register: ${acc.name}`);
      } else {
        // phone keyboards: Cyrillic look-alike letters (Russian layout) are mapped to Latin; the key is case-insensitive
        const lname = name.replace(/[\u0400-\u04FF]/g, c => HOMO[c] || c);
        if (/[^\x21-\x7E]/.test(lname)) return ack({ ok: false, error: 'Ник пишется английскими буквами (A–Z), цифрами и знаком _. Проверьте раскладку клавиатуры.', field: 'name', code: 'nick' });
        const key = lname.toLowerCase();
        const nameLeft = lockLeft(nameFails.get(key), now);
        if (nameLeft) { failSock(now); return ack({ ok: false, error: lockMsg(nameLeft), retryIn: nameLeft, code: 'locked' }); }
        const valid = /^[A-Za-z0-9_]{3,20}$/.test(lname);
        const found = valid && password ? (profiles.get(key) || await store.getAccount(key)) : null; // cached only on success
        const pw = password.slice(0, 200);
        let okPw = await bcrypt.compare(pw, found ? found.passHash : DUMMY_HASH);
        // mobile keyboards / autofill: stray spaces around the password, other Unicode normalisation (ё, й). Only tried on a miss.
        if (!okPw && found) for (const v of pwVariants(pw)) if (v && v !== pw && await bcrypt.compare(v, found.passHash)) { okPw = true; break; }
        if (!found || !okPw) {
          const se = failSock(now);
          const ne = valid ? addFail(nameFails, key, now) : null;
          const left = Math.max(lockLeft(se, now), lockLeft(ne, now));
          if (left) return ack({ ok: false, error: lockMsg(left), retryIn: left, code: 'locked' });
          const remaining = AUTH_MAX_FAILS - Math.max(se.n, ne ? ne.n : 0);
          return ack({ ok: false, error: 'Неверный ник или пароль.' + (remaining <= 2 ? ` Осталось попыток: ${remaining}.` : ''), code: 'wrong' });
        }
        nameFails.delete(key); sockFails.delete('s');
        { const live = profiles.get(key) || found; if (live.stats && live.stats.ban) return ack({ ok: false, error: 'Аккаунт заблокирован администратором.', code: 'banned' }); }
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
    if (acc.stats && acc.stats.ban) return { error: { ok: false, expired: true, error: 'Аккаунт заблокирован администратором.', code: 'banned' } };
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
    if (acct.acc.stats.ban) return ack({ ok: false, expired: true, error: 'Аккаунт заблокирован администратором.', code: 'banned' });
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
    if (typeof text === 'string' && text.trim().startsWith('/')) { // commands: admin only, never broadcast
      if (!isAdmin(pl.acc)) { adminLog(pl.acc, 'denied command'); return ack({ ok: false, error: 'Команды доступны только администратору.' }); }
      return runCommand(text.trim()).then(r => ack(Object.assign({ cmd: true }, r)), () => ack({ ok: false, error: 'Ошибка команды' }));
    }
    if (pl.acc.stats.muteUntil > now) return ack({ ok: false, error: `Вы не можете писать в чат ещё ${Math.ceil((pl.acc.stats.muteUntil - now) / 60000)} мин.` });
    const clean = R.sanitizeChat(text);
    if (clean.error) return ack({ ok: false, error: clean.error });
    // inline emote tokens :name: (e.g. :fire:, :100:) → the emoji, only for emotes the player owns
    const txt = clean.text.replace(/:([a-z0-9]{2,12}):/gi, (m0, k) => { const d = INV.itemDef('e_' + k.toLowerCase()); return d && d.type === 'emote' && (d.free || INV.hasItem(pl.acc, d.id)) ? d.value : m0; });
    const gate = chatGate(pl, now, txt.toLowerCase()); if (gate) return ack({ ok: false, error: gate });
    pushChat({ n: pl.acc.name, c: nameColorOf(pl.acc), t: txt }, true);
    ack({ ok: true, masked: clean.masked });
  });
  function chatGate(pl, now, key) { // shared chat rate limits (text + emote messages)
    pl.chatTimes = pl.chatTimes.filter(t => now - t < CHAT_WINDOW_MS);
    const last = pl.chatTimes[pl.chatTimes.length - 1] || 0;
    if (now - last < CHAT_MIN_GAP_MS) return 'Не так быстро! Подождите немного.';
    if (pl.chatTimes.length >= CHAT_WINDOW_MAX) return 'Слишком много сообщений. Подождите несколько секунд.';
    if (key === pl.lastChat && now - last < 15000) return 'Не повторяйте одно и то же сообщение.';
    pl.chatTimes.push(now); pl.lastChat = key; return null;
  }
  // ---- emote as a chat message (owned emotes only, chat mute + rate limits); also shows the head bubble when the emote gap allows
  socket.on('chat:emote', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Войдите в игру, чтобы писать в чат' });
    const now = Date.now();
    if (pl.acc.stats.muteUntil > now) return ack({ ok: false, error: `Вы не можете писать в чат ещё ${Math.ceil((pl.acc.stats.muteUntil - now) / 60000)} мин.` });
    const def = INV.itemDef(itemId); if (!def || def.type !== 'emote') return ack({ ok: false, error: 'Нет такой эмоции' });
    if (!def.free && !INV.hasItem(pl.acc, def.id)) return ack({ ok: false, error: 'Эта эмоция не куплена' });
    const gate = chatGate(pl, now, 'emote:' + def.id); if (gate) return ack({ ok: false, error: gate });
    pushChat({ n: pl.acc.name, c: nameColorOf(pl.acc), t: def.value, em: def.id }, true);
    if (now - (pl.emoteAt || 0) >= G.EMOTE_GAP_MS) { pl.emoteAt = now; if (!pl.invis) io.to('arena').emit('emote', { id: pl.id, e: def.id }); else pl.socket.emit('emote', { id: pl.id, e: def.id }); }
    ack({ ok: true });
  });

  socket.on('input', m => {
    if (!pl || !isObj(m)) return;
    const s = Number(m.s), x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(s) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (pl.inputs.length >= 60) { perf.dropped++; return; }
    pl.inputs.push({ s, x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) });
  });

  socket.on('ev:touch', m => { if (pl) runnerTouch(pl, m); });

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
    { const g2 = TRADE && TRADE.mutationGuard(a, 'orbs', null, cost); if (g2) return ack(g2); }
    const g = INV.grantItem(a, def.id, q, 'shop'); // all-or-nothing (space checked inside)
    if (!g.ok) return ack({ ok: false, error: g.error, code: g.code });
    a.stats.buys = (a.stats.buys || 0) + 1;
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
    { const g2 = TRADE && TRADE.mutationGuard(a, 'item', d.id, d.qty); if (g2) return ack(g2); }
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
    { const g2 = TRADE && TRADE.mutationGuard(a, 'shards', null, cost); if (g2) return ack(g2); }
    // all-or-nothing: spend the shards, grant the item; if the item does not fit, the shards are put back exactly as they were
    const snap = { inv: JSON.stringify(a.inventory), owned: a.owned.slice(), eq: Object.assign({}, a.equipped), shards: a.stats.shards };
    const r = INV.removeItem(a, G.SHARD_ID, cost, 'shard_shop');
    const g = r.ok ? INV.grantItem(a, def.id, q, 'shard_shop') : r;
    if (!g.ok) { a.inventory = JSON.parse(snap.inv); a.owned = snap.owned; a.equipped = snap.eq; a.stats.shards = snap.shards; return ack({ ok: false, error: g.error, code: g.code }); }
    accountChanged(a);
    try { await flush(); } catch (_) { /* stays dirty, retried by the periodic flush */ }
    a.stats.buys = (a.stats.buys || 0) + 1;
    ack({ ok: true, spent: cost, qty: q, profile: ownProfile(a) });
  });
  // ---- paid quest reroll: shards removed atomically, then a fresh set (FX.rerollQuests)
  socket.on('quest:reroll', async (which, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (which !== 'daily' && which !== 'weekly') return ack({ ok: false, error: 'Неизвестный тип заданий' });
    if (!shardRateOk(Date.now())) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    const a = acct.acc, cost = C.REROLL_COST[which], have = INV.countItem(a, G.SHARD_ID);
    if (have < cost) return ack({ ok: false, error: `Не хватает осколков: нужно ${cost}, у вас ${have}`, code: 'shards' });
    { const g2 = TRADE && TRADE.mutationGuard(a, 'shards', null, cost); if (g2) return ack(g2); }
    const r = INV.removeItem(a, G.SHARD_ID, cost, 'quest_reroll');
    if (!r.ok) return ack({ ok: false, error: r.error || 'Не удалось списать осколки', code: 'shards' });
    FX.rerollQuests(a, which);
    accountChanged(a);
    try { await flush(); } catch (_) { /* retried by the periodic flush */ }
    if (pl) pl.questDirty = true;
    ack({ ok: true, spent: cost, profile: ownProfile(a) });
  });
  // ---- daily rewards calendar (lib/daily.js): one claim per Moscow day, 14-day cycle; ≥ 1.5 s between attempts per socket
  let calLast = 0;
  socket.on('daily:get', ack => { ack = safeAck(ack); if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' }); ack({ ok: true, state: DAILY.calState(acct.acc) }); });
  socket.on('daily:claim', async ack => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const now = Date.now();
    if (now - calLast < 1500) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    calLast = now;
    const a = acct.acc;
    if (a._calBusy) return ack({ ok: false, error: 'Подождите…', code: 'busy' });
    a._calBusy = true;
    try {
      const r = DAILY.claimDaily(a, now);
      if (!r.ok) return ack(r);
      accountChanged(a);
      try { await flush(); } catch (_) { /* retried by the periodic flush */ }
      if (pl) pl.socket.emit('bal', { b: a.balance, t: a.total, s: pl.session });
      ack({ ok: true, reward: r.reward, state: r.state, profile: ownProfile(a) });
    } finally { a._calBusy = false; }
  });
  socket.on('daily:skip', async ack => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const now = Date.now();
    if (now - calLast < 1500) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    calLast = now;
    const a = acct.acc;
    if (a._calBusy) return ack({ ok: false, error: 'Подождите…', code: 'busy' });
    a._calBusy = true;
    try {
      const r = DAILY.skipDaily(a, now);
      if (!r.ok) return ack(r);
      accountChanged(a);
      try { await flush(); } catch (_) { /* retried by the periodic flush */ }
      if (pl) pl.socket.emit('bal', { b: a.balance, t: a.total, s: pl.session });
      ack({ ok: true, reward: r.reward, state: r.state, profile: ownProfile(a) });
    } finally { a._calBusy = false; }
  });
  // ---- promo codes (lib/codes.js): once per account, global maxUses, atomic, 5 attempts / minute / account
  socket.on('code:redeem', async (input, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const a = acct.acc, now = Date.now();
    const tries = (codeTries.get(a.key) || []).filter(t => now - t < 60000);
    if (tries.length >= 5) { codeTries.set(a.key, tries); return ack({ ok: false, error: 'Слишком много попыток. Подождите минуту.', code: 'rate' }); }
    tries.push(now); codeTries.set(a.key, tries);
    if (a._redeeming) return ack({ ok: false, error: 'Подождите…', code: 'busy' });
    const c = findBuiltinCode(input) || findAdminCode(input), NOPE = { ok: false, error: 'Код не найден или уже использован', code: 'invalid' };
    if (!c) return ack(NOPE);
    const key = CODES.norm(c.code);
    if (a.codes.includes(key)) return ack(NOPE);
    if (c.expiresAt && c.expiresAt <= now || CODES.isExpired(c, now)) return ack({ ok: false, error: 'Срок действия кода истёк', code: 'expired' });
    const rw = c.rewards || {}, grants = (rw.items || []).map(x => ({ id: x.id, qty: x.qty || 1 }));
    if (rw.shards > 0) grants.push({ id: G.SHARD_ID, qty: rw.shards });
    const units = grants.reduce((n, x) => n + (x.id === G.SHARD_ID ? 0 : x.qty), 0); // shards are a currency, not inventory units
    if (units > G.INV_CAP - INV.unitsUsed(a)) return ack({ ok: false, error: `Награда не помещается в инвентарь (${INV.unitsUsed(a)} / ${G.INV_CAP}, нужно ещё ${units}). Освободите место.`, code: 'full' });
    a._redeeming = true;
    try {
      if (!(await store.takeCodeUse(key, c.maxUses == null ? null : c.maxUses))) return ack(NOPE);
      if (a.codes.includes(key)) { store.releaseCodeUse(key).catch(() => {}); return ack(NOPE); }
      const snap = { inv: JSON.stringify(a.inventory), owned: a.owned.slice() };
      for (const g of grants) {
        const r = INV.grantItem(a, g.id, g.qty, 'code');
        if (!r.ok) { a.inventory = JSON.parse(snap.inv); a.owned = snap.owned; store.releaseCodeUse(key).catch(() => {}); return ack({ ok: false, error: r.error, code: r.code || 'full' }); }
      }
      a.balance += rw.orbs > 0 ? rw.orbs : 0; // balance only, the all-time total stays «orbs earned»
      a.codes.push(key);
      accountChanged(a);
      try { await flush(); } catch (_) { /* retried later */ }
      ack({ ok: true, rewards: { orbs: rw.orbs || 0, shards: rw.shards || 0, items: (rw.items || []).map(x => ({ id: x.id, qty: x.qty || 1 })) }, profile: ownProfile(a) });
    } catch (e) { console.error('code:redeem failed:', e.message); ack({ ok: false, error: 'Ошибка сервера, попробуйте позже' }); }
    finally { a._redeeming = false; }
  });
  // ---- zone-2 door: one-time orb payment, persisted in stats.unlockedDoor2 (balance only; the all-time total is untouched)
  socket.on('door:unlock', async (data, ack) => {
    if (typeof data === 'function') { ack = data; data = null; }
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const a = acct.acc;
    if (a.stats.unlockedDoor2 === true) return ack({ ok: false, error: 'Дверь уже открыта', code: 'owned' });
    if (a.balance < G.DOOR_COST) return ack({ ok: false, error: `Нужно ${G.DOOR_COST} сфер, у вас ${a.balance}`, code: 'funds' });
    { const g2 = TRADE && TRADE.mutationGuard(a, 'orbs', null, G.DOOR_COST); if (g2) return ack(g2); }
    a.balance -= G.DOOR_COST;
    a.stats.unlockedDoor2 = true;
    accountChanged(a);
    try { await flush(); } catch (_) { /* retried later */ }
    console.log(`door: ${a.name} unlocked zone 2`);
    ack({ ok: true, profile: ownProfile(a) });
  });
  socket.on('shard:exchange', async (qty, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!Number.isInteger(qty) || qty < 1 || qty > G.SHARD_EXCHANGE.maxPerTrade) return ack({ ok: false, error: `Можно обменять от 1 до ${G.SHARD_EXCHANGE.maxPerTrade} осколков за раз`, code: 'qty' });
    if (!shardRateOk(Date.now())) return ack({ ok: false, error: 'Не так быстро! Подождите пару секунд.', code: 'rate' });
    const a = acct.acc;
    { const g2 = TRADE && TRADE.mutationGuard(a, 'shards', null, qty); if (g2) return ack(g2); }
    const r = INV.removeItem(a, G.SHARD_ID, qty, 'shard_shop');
    if (!r.ok) return ack({ ok: false, error: r.error, code: r.code });
    const got = qty * G.SHARD_EXCHANGE.orbs;
    a.balance += got; // a conversion: balance only, the all-time total (leaderboard) stays «orbs earned»
    accountChanged(a);
    try { await flush(); } catch (_) { /* retried later */ }
    ack({ ok: true, orbs: got, profile: ownProfile(a) });
  });


  // ---- player-to-player trade (server-authoritative; see lib/trade.js)
  socket.on('trade:request', (toPid, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); ack(TRADE.request(pl, toPid)); });
  socket.on('trade:respond', (d, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); const tradeId = d && d.tradeId, accept = !!(d && d.accept); ack(TRADE.respond(pl, tradeId, accept)); });
  socket.on('trade:offer', (d, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); ack(TRADE.setOffer(pl, d && d.tradeId, d && d.offer)); });
  socket.on('trade:ready', (d, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); ack(TRADE.setReady(pl, d && d.tradeId, !!(d && d.ready))); });
  socket.on('trade:confirm', (d, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); ack(TRADE.setConfirm(pl, d && d.tradeId, !!(d && d.confirm))); });
  socket.on('trade:cancel', (d, ack) => { ack = safeAck(ack); if (!acct || !pl) return ack({ ok: false, error: 'Сначала войдите в игру' }); if (!TRADE) return ack({ ok: false, error: 'Обмен недоступен' }); ack(TRADE.cancel(pl, d && d.tradeId)); });

  socket.on('upgrade', (key, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    if (!has(G.UPGRADES, key)) return ack({ ok: false, error: 'Нет такого улучшения' });
    const up = G.UPGRADES[key], a = acct.acc, lvl = G.upLevel(key, a.upgrades[key]);
    if (lvl >= up.max) return ack({ ok: false, error: 'Максимальный уровень' });
    const price = up.prices[lvl];
    if (a.balance < price) return ack({ ok: false, error: `Не хватает сфер: нужно ${price}` });
    { const g2 = TRADE && TRADE.mutationGuard(a, 'orbs', null, price); if (g2) return ack(g2); }
    a.balance -= price;
    a.upgrades[key] = lvl + 1;
    accountChanged(a);
    ack({ ok: true, profile: ownProfile(a) });
  });

  // ---------------------------------------------------------------- admin panel + chat commands (DragonzTV only; checked on every call)
  const findOnline = name => (typeof name === 'string' && name.trim() ? byKey.get(name.trim().toLowerCase()) : null);
  const adminList = () => Array.from(players.values(), q => ({ name: q.acc.name, balance: q.acc.balance, muted: q.acc.stats.muteUntil > Date.now(), frozen: !!q.frozen, admin: isAdmin(q.acc) }));
  async function bannedList() {
    const m = new Map();
    for (const b of await store.listBanned()) m.set(b.key, b);
    for (const a of profiles.values()) { if (a.stats && a.stats.ban) m.set(a.key, { key: a.key, name: a.name, at: a.stats.ban.at }); else m.delete(a.key); }
    return Array.from(m.values());
  }
  const selfState = q => q.socket.emit('adm:self', { spd: q.spd || 1, frozen: !!q.frozen, god: !!q.god, invis: !!q.invis });
  const placeNear = (x, y, ring) => { const a = Math.random() * Math.PI * 2, d = ring * Math.sqrt(Math.random()); return { x: Math.max(40, Math.min(G.WORLD.w - 40, Math.round(x + Math.cos(a) * d))), y: Math.max(40, Math.min(G.WORLD.h - 40, Math.round(y + Math.sin(a) * d))) }; };
  const minutes = (v, def, max) => { const n = v === undefined || v === '' ? def : Number(v); return Number.isFinite(n) && n > 0 ? Math.min(max, n) : null; };
  function adminRain(t, n, sec) {
    if (!has(G.ORB_TYPES, t) || t === 't') return { ok: false, error: 'Редкость: c u r e l m' };
    n = Math.max(1, Math.min(300, Math.floor(n))); sec = Math.max(1, Math.min(60, sec));
    let done = 0; const per = Math.ceil(n / (sec * 4));
    const iv = setInterval(() => { for (let i = 0; i < per && done < n; i++, done++) { const o = addOrb(t, randomSpot(80), 'admin'); o.expires = Date.now() + 120000; } if (done >= n) clearInterval(iv); }, 250);
    systemChat(`🌧️ Дождь из сфер «${G.ORB_TYPES[t].name}»!`);
    return { ok: true, msg: `Дождь: ${n} × ${G.ORB_TYPES[t].name} за ${sec} с` };
  }
  function troll(q, o, sec) {
    sec = Math.max(5, Math.min(600, Number(sec) || 60));
    const prev = q.troll && q.troll.until > Date.now() ? q.troll : {};
    q.troll = Object.assign({}, prev, o, { until: Date.now() + sec * 1000 });
    clearTimeout(q.trollTimer); q.trollTimer = setTimeout(() => { q.troll = null; if (players.get(q.id) === q) io.to('arena').emit('pmeta', playerMeta(q)); }, sec * 1000);
    io.to('arena').emit('pmeta', playerMeta(q));
    return { ok: true, msg: `${q.acc.name}: ${o.size ? 'размер ×' + o.size : 'скин ' + o.color} на ${sec} с` };
  }
  async function playerInfo(name) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : ''; if (!/^[a-z0-9_]{3,20}$/.test(key)) return { ok: false, error: 'Ник?' };
    const t = await loadAccount(key); if (!t) return { ok: false, error: 'Аккаунт не найден' };
    const q = byKey.get(key), st = t.stats || {}, now = Date.now();
    return { ok: true, info: { name: t.name, online: !!q, balance: t.balance, total: t.total, shards: st.shards || 0, items: t.inventory.slots.reduce((n, s) => n + s.q, 0), slots: t.inventory.slots.length,
      playMin: Math.round(((st.playMs || 0) + (q ? now - q.joinedAt : 0)) / 60000), warns: (st.warns || []).map(w => ({ at: w.at, r: w.r })), banned: !!st.ban, mutedMin: st.muteUntil > now ? Math.ceil((st.muteUntil - now) / 60000) : 0, createdAt: t.createdAt } };
  }
  const infoLine = i => `${i.name}${i.online ? ' (онлайн)' : ''}: ${i.balance} сфер, ${i.shards} оск., предметов ${i.items}, ${i.playMin} мин в игре, предупр. ${i.warns.length}${i.banned ? ', БАН' : ''}${i.mutedMin ? ', мут ' + i.mutedMin + ' мин' : ''}`;
  function warnPlayer(q, reason) {
    const st = q.acc.stats; st.warns = (st.warns || []).concat([{ at: Date.now(), r: reason }]).slice(-50);
    const n = st.warns.length; let extra = '';
    if (n % 3 === 0) { st.muteUntil = Date.now() + 10 * 60000; extra = ' Это 3-е предупреждение: чат отключён на 10 мин.'; }
    markDirty(q.acc); flushSoon();
    q.socket.emit('adm:warn', { r: reason, n, muted: n % 3 === 0 });
    return { ok: true, msg: `${q.acc.name}: предупреждение ${n}${n % 3 === 0 ? ' → мут 10 мин' : ''}` };
  }
  function giftAll(what, n) {
    let k = 0;
    for (const q of players.values()) {
      if (what === 'orbs') { q.acc.balance += n; q.socket.emit('bal', { b: q.acc.balance, t: q.acc.total, s: q.session }); }
      else { const r = INV.grantItem(q.acc, G.SHARD_ID, Math.min(n, 999), 'admin'); if (!r.ok) continue; q.socket.emit('item', { id: G.SHARD_ID, qty: Math.min(n, 999), source: 'admin' }); }
      accountChanged(q.acc); k++;
    }
    io.to('arena').emit('adm:announce', { t: `🎁 Подарок всем: +${n} ${what === 'orbs' ? 'сфер' : 'осколков'}!`, by: acct.acc.name });
    return { ok: true, msg: `Подарок выдан ${k} игрокам` };
  }
  function startCustom(o) {
    const name = String(o.name || '').replace(/[<>]/g, '').trim().slice(0, 30), num = (v, lo, hi, def) => { const x = v === undefined || v === '' ? def : Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def; };
    if (!name) return { ok: false, error: 'Название?' };
    const c = R.sanitizeChat(name); if (c.error) return { ok: false, error: 'Название: ' + c.error };
    const ev2 = { name: c.text, orb: num(o.orb, 0.1, 5, 1), luck: num(o.luck, 0.1, 5, 1), spd: num(o.spd, 0.3, 3, 1), until: Date.now() + num(o.min, 0.5, 120, 5) * 60000 };
    setCustomEv(ev2); return { ok: true, msg: `Событие «${ev2.name}» запущено` };
  }
  async function codeList() { // active codes only: built-in (not deleted) + panel codes (not deleted)
    const out = [];
    for (const c of CODES.CODES) { const k = CODES.norm(c.code), m = adminCodes.get(k); if (m && m.deleted) continue; out.push({ code: k, rewards: c.rewards, maxUses: c.maxUses, expiresAt: c.expiresAt ? Date.parse(c.expiresAt) : null, builtin: true, createdAt: 0, uses: await store.codeUses(k) }); }
    const own = []; for (const c of adminCodes.values()) if (!c.builtin && !c.deleted) own.push(Object.assign({}, c, { uses: await store.codeUses(c.code) }));
    return own.sort((x, y) => y.createdAt - x.createdAt).concat(out);
  }
  async function deleteCode(code) { // the code stops working; players keep what they already redeemed (nothing else is touched)
    const k = CODES.norm(code), m = adminCodes.get(k);
    if (CODES.findCode(k)) { if (m && m.deleted) return { ok: false, error: 'Уже удалён' }; const c = { code: k, builtin: true, deleted: true, deletedAt: Date.now(), by: acct.acc.name }; await store.saveAdminCode(c); adminCodes.set(k, c); }
    else { if (!m || m.deleted) return { ok: false, error: 'Код не найден' }; m.deleted = true; m.deletedAt = Date.now(); await store.saveAdminCode(m); }
    return { ok: true, msg: `Код ${k} удалён`, codes: await codeList() };
  }
  async function createCode(o) {
    const code = CODES.norm(o.code); if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { ok: false, error: 'Код: 3–32 символа A–Z 0–9 _ -' };
    if (CODES.findCode(code) || adminCodes.has(code)) return { ok: false, error: 'Такой код уже есть (или был удалён)' };
    const int = (v, hi) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x > 0 ? Math.min(hi, x) : 0; };
    const rewards = {}; if (int(o.orbs, 1e6)) rewards.orbs = int(o.orbs, 1e6); if (int(o.shards, 999)) rewards.shards = int(o.shards, 999);
    if (o.item && has(G.ITEM_BY_ID, o.item) && o.item !== G.SHARD_ID) rewards.items = [{ id: o.item, qty: int(o.itemQty, 99) || 1 }];
    if (!Object.keys(rewards).length) return { ok: false, error: 'Нужна награда' };
    const c = { code, rewards, maxUses: int(o.maxUses, 1e6) || null, expiresAt: Number(o.days) > 0 ? Date.now() + Math.min(365, Number(o.days)) * 86400000 : null, disabled: false, createdAt: Date.now(), by: acct.acc.name };
    await store.saveAdminCode(c); adminCodes.set(code, c);
    return { ok: true, msg: `Код ${code} создан`, codes: await codeList() };
  }
  async function disableCode(code) {
    const c = adminCodes.get(CODES.norm(code)); if (!c || c.builtin || c.deleted) return { ok: false, error: 'Код не найден (встроенные коды отключаются только в lib/codes.js)' };
    c.disabled = !c.disabled; await store.saveAdminCode(c);
    return { ok: true, msg: `${c.code} ${c.disabled ? 'отключён' : 'включён'}`, codes: await codeList() };
  }
  function funStart(kind, o) {
    const now = Date.now(), int = (v, lo, hi, def) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= lo ? Math.min(hi, x) : def; };
    const prize = () => ({ orbs: int(o.orbs, 0, 100000, 100), shards: int(o.shards, 0, 99, 0) });
    const toggleOff = (k, msg) => { fun[k] = k === 'chaos' ? 0 : k === 'freeze' ? false : null; pushFun(); return { ok: true, msg, off: true }; };
    switch (kind) {
      case 'hunt': { if (fun.hunt) return toggleOff('hunt', 'Охота отменена'); if (!pl) return { ok: false, error: 'Войдите в игру' }; if (pl.invis) { pl.invis = false; selfState(pl); }
        fun.hunt = { prize: prize(), until: now + int(o.min, 1, 30, 3) * 60000 }; io.to('arena').emit('adm:announce', { t: `🏃 Охота на админа! Первый, кто коснётся ${pl.acc.name}, получит ${prizeText(fun.hunt.prize)}` }); pushFun(); return { ok: true, msg: 'Охота началась' }; }
      case 'giant': { if (fun.giant) { endGiant(); return { ok: true, msg: 'Гигантская сфера завершена', off: true }; } const at = pl ? { x: Math.round(pl.x), y: Math.round(pl.y) } : randomSpot(200);
        fun.giant = { x: Math.max(100, Math.min(G.WORLD.w - 100, at.x)), y: Math.max(100, Math.min(G.WORLD.h - 100, at.y)), total: int(o.total, 1, 100000, 500), until: now + int(o.sec, 10, 300, 45) * 1000, touched: new Set() };
        systemChat(`🟣 Гигантская сфера! Коснитесь её — ${fun.giant.total} сфер делятся между всеми`); pushFun(); return { ok: true, msg: 'Гигантская сфера создана' }; }
      case 'chaos': { if (fun.chaos > now) return toggleOff('chaos', 'Хаос выключен'); fun.chaos = now + int(o.sec, 10, 300, 60) * 1000; setTimeout(pushFun, fun.chaos - now + 50); systemChat('🌀 Режим хаоса: управление инвертировано!'); pushFun(); return { ok: true, msg: 'Хаос включён' }; }
      case 'lava': { if (fun.lava) return toggleOff('lava', 'Лава выключена');
        const islands = []; for (const q of players.values()) if (!isAdmin(q.acc) && islands.length < 12) { const a = Math.random() * 6.283, d = 250 + Math.random() * 250; islands.push({ x: Math.round(Math.max(150, Math.min(G.WORLD.w - 150, q.x + Math.cos(a) * d))), y: Math.round(Math.max(150, Math.min(G.WORLD.h - 150, q.y + Math.sin(a) * d))), r: 160 }); }
        if (pl) for (let i = 0; i < 3; i++) islands.push({ x: Math.round(Math.max(150, Math.min(G.WORLD.w - 150, pl.x + (i - 1) * 700))), y: Math.round(Math.max(150, Math.min(G.WORLD.h - 150, pl.y + 500))), r: 160 });
        fun.lava = { islands, until: now + int(o.sec, 10, 300, 45) * 1000, lost: new Map() }; io.to('arena').emit('adm:announce', { t: '🌋 Пол — это лава! Бегите на безопасные островки (вне их теряются сферы, максимум 30)' }); pushFun(); return { ok: true, msg: `Лава: ${islands.length} островков` }; }
      case 'ghost': { if (fun.ghost) return toggleOff('ghost', 'Призрак выключен'); if (!pl) return { ok: false, error: 'Войдите в игру' }; if (pl.invis) { pl.invis = false; selfState(pl); }
        fun.ghost = { id: pl.id, until: now + int(o.sec, 10, 600, 90) * 1000 }; for (const q of players.values()) q.ghostLost = 0; io.to('arena').emit('adm:announce', { t: `👻 ${pl.acc.name} стал призраком! Убегайте — пойманные теряют немного сфер и оглушаются на 2 с` }); pushFun(); return { ok: true, msg: 'Вы призрак' }; }
      case 'freeze': fun.freeze = !fun.freeze; systemChat(fun.freeze ? '🧊 Карта заморожена администратором' : '🧊 Карта разморожена'); pushFun(); return { ok: true, msg: fun.freeze ? 'Все заморожены' : 'Разморожено' };
      case 'chest': { if (fun.chest) return toggleOff('chest', 'Сундук убран'); if (!pl) return { ok: false, error: 'Войдите в игру' };
        fun.chest = { x: Math.round(pl.x), y: Math.round(pl.y), prize: prize(), until: now + int(o.min, 1, 60, 10) * 60000 }; systemChat('🎁 Где-то на карте спрятан бонусный сундук! Кто найдёт первым?'); pushFun(); return { ok: true, msg: 'Сундук поставлен на вашем месте' }; }
      case 'poll': { if (!o.q || !o.opts || o.opts.length < 2) return { ok: false, error: '/poll Вопрос | вариант 1 | вариант 2' };
        const clean = t => { const c = R.sanitizeChat(String(t).slice(0, 80)); return c.error ? null : c.text; }, q = clean(o.q), opts = o.opts.slice(0, 6).map(clean);
        if (!q || opts.some(x => !x)) return { ok: false, error: 'Недопустимый текст' };
        fun.poll = { id: ++pollSeq, q, opts, votes: new Map(), until: now + int(o.sec, 10, 600, 60) * 1000 }; pushPoll(); return { ok: true, msg: 'Опрос запущен' }; }
      case 'endpoll': { if (!fun.poll) return { ok: false, error: 'Нет опроса' }; const r = pollPublic(); fun.poll = null; io.to('arena').emit('poll', Object.assign(r, { done: true })); return { ok: true, msg: 'Опрос завершён' }; }
    }
    return { ok: false, error: '?' };
  }
  async function runCommand(text) {
    const [rawCmd, ...args] = text.slice(1).split(/\s+/), cmd = (rawCmd || '').toLowerCase(), a = acct.acc;
    adminLog(a, 'command /' + cmd, args.length ? { args: args.slice(0, 3) } : null);
    const need = () => { const q = findOnline(args[0]); return q || null; };
    switch (cmd) {
      case 'announce': { const t = R.sanitizeChat(args.join(' ')); if (t.error || !t.text) return { ok: false, error: 'Текст объявления?' }; io.to('arena').emit('adm:announce', { t: t.text, by: a.name }); return { ok: true, msg: 'Объявление отправлено' }; }
      case 'tp': case 'tphere': {
        const q = need(); if (!q || !pl) return { ok: false, error: 'Игрок не в сети' };
        const [from, to] = cmd === 'tp' ? [pl, q] : [q, pl];
        from.x = to.x + 40; from.y = to.y; from.inputs.length = 0; return { ok: true, msg: cmd === 'tp' ? `Телепорт к ${q.acc.name}` : `${q.acc.name} перенесён к вам` };
      }
      case 'x2': { const m = args[0] === '0' ? 0 : minutes(args[0], 5, 120); if (m === null) return { ok: false, error: '/x2 <минуты>' }; setX2(m); return { ok: true, msg: m ? `Сферы ×2 на ${m} мин` : '×2 выключен' }; }
      case 'mute': { const q = need(), m = minutes(args[1], 10, 1440); if (!q || m === null) return { ok: false, error: '/mute <игрок> <минуты>' }; q.acc.stats.muteUntil = Date.now() + m * 60000; markDirty(q.acc); q.socket.emit('chat', { notice: true, t: `Администратор запретил вам писать в чат на ${m} мин.` }); return { ok: true, msg: `${q.acc.name} в муте ${m} мин` }; }
      case 'unmute': { const q = need(); if (!q) return { ok: false, error: 'Игрок не в сети' }; delete q.acc.stats.muteUntil; markDirty(q.acc); return { ok: true, msg: `${q.acc.name} размучен` }; }
      case 'clearchat': chatHistory = []; io.to('arena').emit('chat:clear'); return { ok: true, msg: 'Чат очищен' };
      case 'freeze': case 'unfreeze': { const q = need(); if (!q) return { ok: false, error: 'Игрок не в сети' }; q.frozen = cmd === 'freeze'; q.inputs.length = 0; selfState(q); return { ok: true, msg: `${q.acc.name} ${q.frozen ? 'заморожен' : 'разморожен'}` }; }
      case 'god': { if (!pl) return { ok: false, error: 'Войдите в игру' }; pl.god = !pl.god; pl.zapUntil = pl.god ? Infinity : 0; selfState(pl); return { ok: true, msg: pl.god ? 'Неуязвимость включена' : 'Неуязвимость выключена' }; }
      case 'speed': { const v = Number(args[0]); if (!pl || !Number.isFinite(v) || v <= 0 || v > 5) return { ok: false, error: '/speed <0.1–5>' }; pl.spd = v; selfState(pl); return { ok: true, msg: `Скорость ×${v}` }; }
      case 'disco': { if (discoOn()) { setDisco(0); return { ok: true, msg: 'Диско выключено', disco: false }; } const m = minutes(args[0], DISCO.defMin, DISCO.maxMin); if (m === null) return { ok: false, error: '/disco [минуты]' }; setDisco(m); return { ok: true, msg: `Диско на ${m} мин`, disco: true }; }
      case 'rain': { const t = (args[0] || 'r').toLowerCase(), n = Number(args[1]) || 60, sec = Number(args[2]) || 10; return adminRain(t, n, sec); }
      case 'invis': { if (!pl) return { ok: false, error: 'Войдите в игру' }; pl.invis = !pl.invis; selfState(pl); if (!pl.invis) io.to('arena').emit('pmeta', playerMeta(pl)); return { ok: true, msg: pl.invis ? 'Невидимость включена' : 'Невидимость выключена' }; }
      case 'size': { const q = need(), v = Number(args[1]), sec = Number(args[2]) || 60; if (!q || !(v >= 0.3 && v <= 3)) return { ok: false, error: '/size <ник> <0.3–3> [сек]' }; return troll(q, { size: v }, sec); }
      case 'skin': { const q = need(), c = args[1] || ''; if (!q || !/^#[0-9a-fA-F]{6}$/.test(c)) return { ok: false, error: '/skin <ник> <#rrggbb> [сек]' }; return troll(q, { color: c }, Number(args[2]) || 60); }
      case 'info': { const r = await playerInfo(args[0]); return r.ok ? { ok: true, msg: infoLine(r.info), info: r.info } : r; }
      case 'warn': { const q = need(), reason = args.slice(1).join(' ').slice(0, 120); if (!q || !reason) return { ok: false, error: '/warn <ник> <причина>' }; return warnPlayer(q, reason); }
      case 'gift': { const what = (args[0] || '').toLowerCase(), n = Math.floor(Number(args[1])); if (!['orbs', 'shards'].includes(what) || !(n >= 1 && n <= 100000)) return { ok: false, error: '/gift <orbs|shards> <кол-во>' }; return giftAll(what, n); }
      case 'weather': { const w = (args[0] || '').toLowerCase(); if (!['rain', 'snow', 'off', 'none', ''].includes(w)) return { ok: false, error: '/weather <rain|snow|off>' }; weather = w === 'rain' || w === 'snow' ? w : ''; pushFx(); return { ok: true, msg: weather ? 'Погода: ' + (weather === 'rain' ? 'дождь' : 'снег') : 'Погода выключена' }; }
      case 'night': night = !night; pushFx(); return { ok: true, msg: night ? 'Ночь включена' : 'Ночь выключена' };
      case 'event': { if (args[0] === 'off' || !args.length) { setCustomEv(null); return { ok: true, msg: 'Своё событие выключено' }; } const [name, orb, luck, spd, min] = args; return startCustom({ name, orb, luck, spd, min }); }
      case 'bosstimer': { const g = FX.resetBossTimer(); return { ok: true, msg: `Таймер босса сброшен (следующий через ~${Math.round(g / 60000)} мин)` }; }
      case 'restart': { const sec = args[0] === 'off' ? 0 : Math.max(10, Math.min(600, Number(args[0]) || 60)); restartAt = sec ? Date.now() + sec * 1000 : 0; pushFx(); if (sec) { io.to('arena').emit('adm:announce', { t: `Перезапуск сервера через ${sec} с`, by: a.name }); systemChat(`⚠️ Перезапуск сервера через ${sec} с`); } return { ok: true, msg: sec ? `Отсчёт перезапуска ${sec} с (только отображение)` : 'Отсчёт отменён' }; }
      case 'code': { // /code <CODE> <orbs> [shards] [maxUses] [days]  ·  /code off <CODE>  ·  /code list
        if (args[0] === 'list') { const l = await codeList(); return { ok: true, msg: l.map(c => `${c.code}${c.disabled ? ' (выкл)' : ''} ${c.uses}/${c.maxUses || '∞'}`).join(', ') || 'Нет кодов', codes: l }; }
        if (args[0] === 'off') return disableCode(args[1]);
        if (args[0] === 'del') return deleteCode(args[1]);
        return createCode({ code: args[0], orbs: args[1], shards: args[2], maxUses: args[3], days: args[4] });
      }
      case 'hunt': return funStart('hunt', { orbs: args[0], shards: args[1], min: args[2] });
      case 'giant': return funStart('giant', { total: args[0], sec: args[1] });
      case 'chaos': return funStart('chaos', { sec: args[0] });
      case 'lava': return funStart('lava', { sec: args[0] });
      case 'ghost': return funStart('ghost', { sec: args[0] });
      case 'freezeall': return funStart('freeze', {});
      case 'chest': return funStart('chest', { orbs: args[0], shards: args[1], min: args[2] });
      case 'poll': { const parts = args.join(' ').split('|').map(x => x.trim()).filter(Boolean); return funStart('poll', { q: parts[0], opts: parts.slice(1) }); }
      case 'endpoll': return funStart('endpoll', {});
      default: return { ok: false, error: 'Неизвестная команда' };
    }
  }
  // ---- potions: drink one from the inventory. Same kind while active ADDS its full duration to the remaining time
  // (strength never stacks), capped at G.POTION_CAP_MS remaining; at the cap the potion is not consumed.
  socket.on('potion:use', (itemId, ack) => {
    ack = safeAck(ack);
    if (!acct) return ack({ ok: false, error: 'Сначала войдите в аккаунт' });
    const def = INV.itemDef(itemId); if (!def || def.type !== 'potion' || !has(G.POTIONS, def.potion)) return ack({ ok: false, error: 'Это не зелье' });
    if (!INV.hasItem(acct.acc, def.id)) return ack({ ok: false, error: 'Нет такого зелья' });
    { const g2 = TRADE && TRADE.mutationGuard(acct.acc, 'item', def.id, 1); if (g2) return ack(g2); }
    const st = acct.acc.stats; st.potions = st.potions || {}; const now = Date.now();
    for (const k of Object.keys(st.potions)) if (!(st.potions[k] > now)) delete st.potions[k];
    const cur = Math.max(now, st.potions[def.potion] || 0), cap = now + G.POTION_CAP_MS;
    if (cur >= cap - 1000) return ack({ ok: false, error: `Максимум ${Math.round(G.POTION_CAP_MS / 60000)} мин действия этого зелья`, code: 'cap' });
    const r = INV.removeItem(acct.acc, def.id, 1, 'use'); if (!r || !r.ok) return ack({ ok: false, error: (r && r.error) || 'Не получилось' });
    const until = Math.min(cur + G.POTIONS[def.potion].sec * 1000, cap);
    st.potions[def.potion] = until;
    st.potionsUsed = (st.potionsUsed || 0) + 1;
    accountChanged(acct.acc); if (pl) FX.checkAch(acct.acc, pl); ack({ ok: true, profile: ownProfile(acct.acc), until, added: until - cur, stacked: cur > now });
  });
  // ---- emotes (free ones for everyone, others must be owned); shown to everyone for G.EMOTE_MS, rate-limited
  socket.on('emote', (itemId, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false, error: 'Войдите в игру' });
    const def = INV.itemDef(itemId); if (!def || def.type !== 'emote') return ack({ ok: false, error: 'Нет такой эмоции' });
    if (!def.free && !INV.hasItem(pl.acc, def.id)) return ack({ ok: false, error: 'Эта эмоция не куплена' });
    const now = Date.now(); if (now - (pl.emoteAt || 0) < G.EMOTE_GAP_MS) return ack({ ok: false, error: 'Не так часто!' });
    pl.emoteAt = now; if (!pl.invis) io.to('arena').emit('emote', { id: pl.id, e: def.id }); else pl.socket.emit('emote', { id: pl.id, e: def.id });
    ack({ ok: true });
  });
  // ---- public profile card of an online player (only public / leaderboard-level data)
  socket.on('profile:public', (id, ack) => {
    ack = safeAck(ack);
    if (!pl) return ack({ ok: false });
    const q = players.get(id); if (!q || (q.invis && q !== pl)) return ack({ ok: false, error: 'Игрок не найден' });
    const now = Date.now(); if (now - (pl.cardAt || 0) < 300) return ack({ ok: false, error: 'Подождите…' }); pl.cardAt = now;
    const a = q.acc, st = a.stats || {};
    ack({ ok: true, card: { id: q.id, name: a.name, me: q === pl, total: a.total, balance: a.balance, shards: st.shards || 0, ach: C.ACH.filter(x => st.ach && st.ach[x.id]).length, achMax: C.ACH.length,
      trophy: INV.hasItem(a, 'h_trophy'), equipped: a.equipped, playMin: Math.round(((st.playMs || 0) + (now - q.joinedAt)) / 60000), bossKills: st.bossKills || 0, mgWins: st.mgWins || 0,
      eventWins: st.eventWins || 0, questsDone: st.questsDone || 0, bestStreak: st.bestStreak || 0, createdAt: a.createdAt, admin: isAdmin(a) } });
  });
  socket.on('poll:vote', (d, ack) => {
    ack = safeAck(ack);
    if (!pl || !fun.poll || !isObj(d) || d.id !== fun.poll.id || !Number.isInteger(d.i) || d.i < 0 || d.i >= fun.poll.opts.length) return ack({ ok: false });
    fun.poll.votes.set(pl.acc.key, d.i); pushPoll(); ack({ ok: true });
  });
  socket.on('adm', async (d, ack) => {
    ack = safeAck(ack);
    const a = acct && acct.acc;
    if (!isAdmin(a)) { adminLog(a, 'denied', { a: isObj(d) ? String(d.a).slice(0, 20) : null }); return ack({ ok: false, error: 'Нет доступа' }); }
    if (!isObj(d) || typeof d.a !== 'string') return ack({ ok: false, error: 'Неверный запрос' });
    try {
      const now = Date.now(), here = pl || { x: G.ZONE_W / 2, y: G.ZONE_H / 2 };
      if (!['init', 'players', 'bans', 'cmd', 'log', 'codes', 'info'].includes(d.a)) adminLog(a, d.a, Object.assign({}, d, { a: undefined }));
      switch (d.a) {
        case 'init': return ack({ ok: true, events: G.EVENT_KEYS.map(k => ({ k, name: G.EVENTS[k].name })), minis: C.MINI_KEYS.map(k => ({ k, name: C.MINI[k].name, icon: C.MINI[k].icon })),
          rarities: Object.keys(G.ORB_TYPES).filter(t => t !== 't').map(t => ({ k: t, name: G.ORB_TYPES[t].name })), items: G.ITEMS.map(it => ({ id: it.id, name: it.name })),
          players: adminList(), bans: await bannedList(), fx: fxState() });
        case 'players': return ack({ ok: true, players: adminList() });
        case 'bans': return ack({ ok: true, bans: await bannedList() });
        case 'event': {
          if (!has(G.EVENTS, d.kind)) return ack({ ok: false, error: 'Нет такого ивента' });
          if (ev) endEvent(now, 'admin'); announceEvent(d.kind, { announceMs: 5000 }); return ack({ ok: true, msg: `Ивент «${G.EVENTS[d.kind].name}» через 5 с` });
        }
        case 'mini': if (!C.MINI_KEYS.includes(d.kind)) return ack({ ok: false, error: 'Нет такого мини-ивента' }); if (FX.miniNow()) FX.endMini('forced'); FX.startMini(d.kind, {}); return ack({ ok: true, msg: `Мини-ивент «${C.MINI[d.kind].name}»` });
        case 'stop': { // stop a running main event / mini-event / boss (Активно strip)
          if (d.kind === 'event') { if (!ev) return ack({ ok: false, error: 'Нет ивента' }); endEvent(now, 'admin'); return ack({ ok: true, msg: 'Ивент остановлен' }); }
          if (d.kind === 'mini') { if (!FX.miniNow()) return ack({ ok: false, error: 'Нет мини-ивента' }); FX.endMini('forced'); return ack({ ok: true, msg: 'Мини-ивент остановлен' }); }
          if (d.kind === 'boss') { if (!FX.bossNow()) return ack({ ok: false, error: 'Нет босса' }); FX.endBoss(false); return ack({ ok: true, msg: 'Босс убран' }); }
          return ack({ ok: false, error: '?' });
        }
        case 'boss': if (FX.bossNow()) FX.endBoss(false); FX.announceBoss({}); return ack({ ok: true, msg: 'Босс вызван' });
        case 'orbs': {
          if (!has(G.ORB_TYPES, d.t) || d.t === 't') return ack({ ok: false, error: 'Редкость?' });
          const n = Math.max(1, Math.min(100, Math.floor(Number(d.n) || 1)));
          for (let i = 0; i < n; i++) { const p = d.where === 'random' ? randomSpot(80) : d.where === 'here' ? { x: Math.round(here.x), y: Math.round(here.y) } : placeNear(here.x, here.y, 260); const o = addOrb(d.t, p, 'admin'); o.expires = now + 120000; }
          return ack({ ok: true, msg: `+${n} × ${G.ORB_TYPES[d.t].name}` });
        }
        case 'obstacle': {
          const kind = ['wall', 'block', 'rock', 'laser', 'robot'].includes(d.kind) ? d.kind : undefined;
          const p = d.where === 'random' ? {} : placeNear(here.x, here.y, 450);
          const o = spawnObstacle(now, { kind, x: p.x, y: p.y }); return ack(o ? { ok: true, msg: 'Препятствие создано' } : { ok: false, error: 'Не удалось (нет места или лимит)' });
        }
        case 'give': {
          const q = findOnline(d.name); if (!q) return ack({ ok: false, error: 'Игрок не в сети' });
          const n = Math.floor(Number(d.qty) || 0); if (n < 1 || n > 1e6) return ack({ ok: false, error: 'Количество 1–1000000' });
          if (d.what === 'orbs') { q.acc.balance += n; q.acc.total += n; q.socket.emit('bal', { b: q.acc.balance, t: q.acc.total, s: q.session }); }
          else {
            const id = d.what === 'shards' ? G.SHARD_ID : d.item; if (!has(G.ITEM_BY_ID, id)) return ack({ ok: false, error: 'Нет такого предмета' });
            const r = INV.grantItem(q.acc, id, Math.min(n, 999), 'admin'); if (!r.ok) return ack({ ok: false, error: r.error || 'Не выдано' });
            q.socket.emit('item', { id, qty: Math.min(n, 999), source: 'admin' });
          }
          accountChanged(q.acc); return ack({ ok: true, msg: `Выдано ${q.acc.name}` });
        }
        case 'kick': {
          const q = findOnline(d.name); if (!q) return ack({ ok: false, error: 'Игрок не в сети' }); if (isAdmin(q.acc)) return ack({ ok: false, error: 'Нельзя' });
          q.socket.emit('kicked', 'Вас выгнал администратор.'); removePlayer(q); q.socket.disconnect(true); return ack({ ok: true, msg: `${q.acc.name} выгнан`, players: adminList() });
        }
        case 'ban': case 'unban': {
          const key = typeof d.name === 'string' ? d.name.trim().toLowerCase() : ''; if (!/^[a-z0-9_]{3,20}$/.test(key)) return ack({ ok: false, error: 'Ник?' });
          const t = await loadAccount(key); if (!t) return ack({ ok: false, error: 'Аккаунт не найден' }); if (isAdmin(t)) return ack({ ok: false, error: 'Нельзя' });
          if (d.a === 'ban') {
            t.stats.ban = { at: now, by: a.name }; markDirty(t); await flush();
            const q = byKey.get(key); if (q) { q.socket.emit('kicked', 'Ваш аккаунт заблокирован администратором.'); removePlayer(q); q.socket.disconnect(true); }
          } else { delete t.stats.ban; markDirty(t); await flush(); }
          return ack({ ok: true, msg: `${t.name} ${d.a === 'ban' ? 'забанен' : 'разбанен'}`, bans: await bannedList(), players: adminList() });
        }
        case 'cmd': { if (typeof d.text !== 'string' || !d.text.trim().startsWith('/')) return ack({ ok: false, error: 'Команда начинается с /' }); return ack(await runCommand(d.text.trim().slice(0, 200))); }
        case 'disco': return ack(await runCommand('/disco' + (Number(d.min) > 0 ? ' ' + Number(d.min) : '')));
        case 'rain': return ack(adminRain(String(d.t), Number(d.n) || 60, Number(d.sec) || 10));
        case 'invis': return ack(await runCommand('/invis'));
        case 'troll': { const q = findOnline(d.name); if (!q) return ack({ ok: false, error: 'Игрок не в сети' }); const o = {}; if (Number(d.size) >= 0.3 && Number(d.size) <= 3 && Number(d.size) !== 1) o.size = Number(d.size); if (/^#[0-9a-fA-F]{6}$/.test(d.color || '')) o.color = d.color; if (!Object.keys(o).length) return ack({ ok: false, error: 'Размер 0.3–3 или цвет' }); return ack(troll(q, o, d.sec)); }
        case 'info': return ack(await playerInfo(d.name));
        case 'warn': { const q = findOnline(d.name), r = typeof d.reason === 'string' ? d.reason.trim().slice(0, 120) : ''; if (!q || !r) return ack({ ok: false, error: 'Игрок не в сети / причина?' }); return ack(warnPlayer(q, r)); }
        case 'gift': { const n = Math.floor(Number(d.n)); if (!['orbs', 'shards'].includes(d.what) || !(n >= 1 && n <= 100000)) return ack({ ok: false, error: 'Количество?' }); return ack(giftAll(d.what, n)); }
        case 'weather': return ack(await runCommand('/weather ' + (['rain', 'snow'].includes(d.w) ? d.w : 'off')));
        case 'night': return ack(await runCommand('/night'));
        case 'custom': if (d.off) { setCustomEv(null); return ack({ ok: true, msg: 'Своё событие выключено' }); } return ack(startCustom(d));
        case 'x2': { const m = Math.floor(Number(d.min)); if (!(m >= 1 && m <= 120)) return ack({ ok: false, error: 'Минуты 1–120' }); setX2(m); return ack({ ok: true, msg: `+ Сферы ×2 на ${m} мин (×${boostMult('x2', 'orb')} сейчас)` }); }
        case 'boost:stop': { const id = Number(d.id); const n = stopBoosts(b => b.id === id); return ack(n ? { ok: true, msg: 'Остановлено' } : { ok: false, error: 'Уже закончилось' }); }
        case 'bosstimer': return ack(await runCommand('/bosstimer'));
        case 'restart': return ack(await runCommand('/restart ' + (Number(d.sec) > 0 ? Number(d.sec) : 'off')));
        case 'codes': return ack({ ok: true, codes: await codeList() });
        case 'code:create': return ack(await createCode(d));
        case 'code:toggle': return ack(await disableCode(d.code));
        case 'code:delete': return ack(await deleteCode(d.code));
        case 'log': return ack({ ok: true, log: adminLogBuf.slice(-200).reverse() });
        case 'fun': { if (!['hunt', 'giant', 'chaos', 'lava', 'ghost', 'freeze', 'chest', 'poll', 'endpoll'].includes(d.kind)) return ack({ ok: false, error: '?' }); return ack(funStart(d.kind, isObj(d.o) ? Object.assign({}, d.o, { opts: Array.isArray(d.o.opts) ? d.o.opts.map(String) : undefined }) : {})); }
        default: return ack({ ok: false, error: 'Неизвестное действие' });
      }
    } catch (e) { console.error('admin error:', e.message); ack({ ok: false, error: 'Ошибка сервера' }); }
  });

  if (TEST_HOOKS) {
    socket.on('test:grant', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      const other = typeof d.name === 'string' ? byKey.get(d.name.toLowerCase()) : null, acc = other ? other.acc : acct.acc; // {name}: another online player (UI screenshots)
      const r = INV.grantItem(acc, d.id, d.qty, d.source || 'admin');
      if (r.ok) { accountChanged(acc); if (other) other.socket.emit('profile', ownProfile(acc)); }
      ack(Object.assign(r, { profile: ownProfile(acc) }));
    });
    socket.on('test:potion', (d, ack) => { ack = safeAck(ack); if (!pl || !isObj(d) || !G.ITEM_BY_ID[d.item] || G.ITEM_BY_ID[d.item].type !== 'potion') return ack({ ok: false }); ack({ ok: true, pot: addMapPotion(d.item, Number(d.x) || pl.x, Number(d.y) || pl.y) }); });
    socket.on('test:quest', (d, ack) => { ack = safeAck(ack); if (!pl || !isObj(d) || typeof d.kind !== 'string' || !(d.n > 0)) return ack({ ok: false }); FX.questAdd(pl, d.kind, d.n); ack({ ok: true, weekly: pl.acc.stats.weekly }); });
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
    // fill the chat history with n player-like messages (rolling-limit tests)
    socket.on('test:chatfill', (n, ack) => {
      ack = safeAck(ack);
      if (!acct || !Number.isInteger(n) || n < 1 || n > 500) return ack({ ok: false });
      for (let i = 0; i < n; i++) pushChat({ n: acct.acc.name, c: '#ffffff', t: 'fill ' + i }, true);
      ack({ ok: true, size: chatHistory.length });
    });
    // spawn an obstacle now: {kind: 'wall'|'block'|'rock'|'laser', x, y, lifeMs} (tests / screenshots)
    socket.on('test:obstacle', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      if (d.clear) { obstacles = []; shots = []; pushObstacles(); return ack({ ok: true }); }
      const n = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
      const o = spawnObstacle(Date.now(), { kind: ['wall', 'block', 'rock', 'laser', 'robot'].includes(d.kind) ? d.kind : undefined, x: n(d.x), y: n(d.y), lifeMs: n(d.lifeMs) });
      if (o && o.k === 'laser' && n(d.a0) !== undefined) { o.a0 = n(d.a0); o.w = n(d.w) || 0; o.t0 = Date.now(); if (d.armNow) o.armAt = Date.now(); pushObstacles(); } // fixed beam (hitbox tests)
      ack({ ok: !!o, obstacles: publicObstacles() });
    });
    // spawn one orb of each requested tier in a ring around the caller or {x,y} (screenshots / rarity tests)
    socket.on('test:tp', (d, ack) => { // move own player to a point (tests only)
      ack = safeAck(ack);
      const q = isObj(d) && typeof d.name === 'string' ? byKey.get(d.name.toLowerCase()) : pl; // {name}: move another online player (UI screenshots)
      if (!q || !isObj(d) || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return ack({ ok: false });
      q.x = Math.min(G.WORLD.w - G.PLAYER_R, Math.max(G.PLAYER_R, d.x)); q.y = Math.min(G.WORLD.h - G.PLAYER_R, Math.max(G.PLAYER_R, d.y)); q.inputs.length = 0; q.kx = q.ky = 0;
      if (typeof d.orbs === 'number' && d.orbs > 0 && d.orbs <= 1e6) { q.acc.balance += Math.floor(d.orbs); accountChanged(q.acc); }
      ack({ ok: true });
    });
    socket.on('test:spawn', (d, ack) => {
      ack = safeAck(ack);
      if (!pl || !isObj(d) || !Array.isArray(d.types)) return ack({ ok: false });
      const ring = Number(d.ring) || 150, list = d.types.filter(t => has(G.ORB_TYPES, t)).slice(0, 20);
      const cx = Number.isFinite(d.x) ? d.x : pl.x, cy = Number.isFinite(d.y) ? d.y : pl.y; // centre: the caller, or a given point
      list.forEach((t, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / list.length; const o = addOrb(t, { x: clampWorld(cx + Math.cos(a) * ring * 1.6, G.WORLD.w), y: clampWorld(cy + Math.sin(a) * ring, G.WORLD.h) });
        if (o && d.noExpiry) delete o.expires; else if (o && Number(d.lifeMs) > 0) o.expires = Date.now() + Number(d.lifeMs); }); // test: old orb without a lifetime / short life
      ack({ ok: true, n: list.length });
    });
    // content update hooks: force a mini-event / boss, patch numeric stats (achievement / quest tests), set today's quests
    socket.on('test:mini', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      if (d.end) { FX.endMini('forced'); return ack({ ok: true }); }
      if (!has(C.MINI, d.kind) || !C.MINI_KEYS.includes(d.kind)) return ack({ ok: false });
      FX.startMini(d.kind, { x: Number(d.x), y: Number(d.y), durationMs: Number(d.durationMs) || 0 });
      ack({ ok: true, mini: FX.publicMini() });
    });
    socket.on('test:boss', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      if (d.end) { FX.endBoss(false); return ack({ ok: true }); }
      if (FX.bossNow()) FX.endBoss(false);
      FX.announceBoss({ announceMs: Number.isFinite(d.announceMs) ? d.announceMs : undefined, lifeMs: Number(d.lifeMs) || 0, hp: Number(d.hp) || 0, x: Number.isFinite(d.x) ? d.x : undefined, y: Number.isFinite(d.y) ? d.y : undefined });
      ack({ ok: true, boss: FX.publicBoss() });
    });
    socket.on('test:stats', (d, ack) => {
      ack = safeAck(ack);
      if (!acct || !isObj(d)) return ack({ ok: false });
      const other = typeof d.name === 'string' ? byKey.get(d.name.toLowerCase()) : null; // {name}: patch another online player (UI screenshots)
      if (typeof d.name === 'string' && !other) return ack({ ok: false });
      const acct2 = other ? { acc: other.acc } : acct; d = Object.assign({}, d); delete d.name;
      const st = acct2.acc.stats;
      for (const [k, v] of Object.entries(d)) if (!['total', 'dayShift', 'playMsAdd', 'resetAch', 'achSet'].includes(k) && /^[a-zA-Z0-9]{1,30}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || v === null)) { if (v === null) delete st[k]; else st[k] = v; }
      if (d.resetAch) st.ach = {};
      if (Array.isArray(d.achSet)) { st.ach = st.ach || {}; for (const id of d.achSet.slice(0, 40)) if (typeof id === 'string' && /^[a-z0-9_]{1,30}$/.test(id)) st.ach[id] = Date.now(); } // seed old (pre-tier) achievements
      if (Array.isArray(d.quests)) { st.daily = { day: C.dayKey(), q: d.quests.filter(q => isObj(q) && has(C.QUEST_BY_ID, q.id)).slice(0, 3).map(q => ({ id: q.id, p: 0, done: false, rw: isObj(q.rw) ? q.rw : { orbs: 10 } })), bonus: false }; }
      if (Number.isFinite(d.dayShift) && st.daily) st.daily.day += d.dayShift;
      if (Number.isFinite(d.playMsAdd)) st.playMs = (st.playMs || 0) + d.playMsAdd;
      if (Number.isFinite(d.total)) acct2.acc.total = d.total;
      const pl2 = byKey.get(acct2.acc.key);
      if (pl2) FX.checkAch(acct2.acc, pl2);
      accountChanged(acct2.acc, { looks: true });
      if (other) other.socket.emit('profile', ownProfile(acct2.acc));
      ack({ ok: true, profile: ownProfile(acct2.acc) });
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

  // change own password: requires the current one; clears the «set a new password» flag
  socket.on('pw:change', async (d, ack) => {
    ack = safeAck(ack);
    if (!acct || !isObj(d) || typeof d.old !== 'string' || typeof d.new !== 'string') return ack({ ok: false, error: 'Ошибка запроса' });
    const now = Date.now(), left = lockLeft(sockFails.get('s'), now);
    if (left) return ack({ ok: false, error: lockMsg(left) });
    if (!takeGlobalAuth(now)) return ack({ ok: false, error: 'Сервер перегружен, попробуйте через несколько секунд.' });
    const acc = acct.acc;
    try {
      if (!(await bcrypt.compare(d.old.slice(0, 200), acc.passHash))) { failSock(now); return ack({ ok: false, error: 'Текущий пароль неверный' }); }
      const pe = R.passwordError(d.new); if (pe) return ack({ ok: false, error: pe });
      const hash = await bcrypt.hash(d.new, BCRYPT_COST);
      if (!(await store.setPassHash(acc.key, hash))) return ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' });
      acc.passHash = hash;
      if (acc.stats.mustChangePw) { delete acc.stats.mustChangePw; markDirty(acc); flushSoon(); }
      ack({ ok: true, profile: ownProfile(acc) });
    } catch (e) { console.error('pw change error:', e.message); ack({ ok: false, error: 'Ошибка сервера, попробуйте ещё раз' }); }
  });

  socket.on('disconnect', () => { removePlayer(pl); pl = null; release(); });
});

// ---------------------------------------------------------------- main loop
// initial fill for an empty arena
for (const z of [1, 2]) for (let i = 0, n = targetZone(z); i < n; i++) { const p = pickSpot(z); if (p) addOrb(rollPool(z), p); }
pendingAdds = []; pendingDels = [];
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
        payReward(pl, def.reward); FX.onTreasure(pl);
        io.to('arena').emit('ev:treasure', { name: pl.acc.name, left: ev.treasureLeft });
        if (!ev.treasureLeft) ev.endAt = now;
      }
      continue;
    }
    const rw = G.orbReward(ot.value, pl.acc.upgrades, pl, Math.random, o.t);
    if (weekendOn(now)) { const f = (pl.wkFrac || 0) + rw.value * (G.WEEKEND.mult - 1), whole = Math.floor(f + 1e-9); pl.wkFrac = f - whole; rw.value += whole; } // «Выходные»: ×1.5 (fraction carried) // «находка», luck ×2, multiplier (fraction in pl.frac) — server-side only
    if (C.boostMult(pl.acc.stats, 'orbs', now) > 1) { const f = (pl.bFrac || 0) + rw.value * (C.BOOSTS.orbs.mult - 1), whole = Math.floor(f + 1e-9); pl.bFrac = f - whole; rw.value += whole; } // quest boost «Сферы ×1.5»
    const lm = (discoOn(now) ? DISCO.luckMult : 1) * boostMult('custom', 'luck', now) * G.potionMult(pl.acc.stats, 'luck', now);
    if (lm > 1 && !rw.lucky) { const p = G.upValue('luck', pl.acc.upgrades.luck) / 100, extra = p > 0 && p < 1 ? Math.min(1, p * (lm - 1) / (1 - p)) : 0; if (extra > 0 && Math.random() < extra) { rw.value *= 2; rw.lucky = true; } } // disco: luck chance ×1.5
    { const xm = (discoOn(now) ? DISCO.orbMult : 1) * boostMult(null, 'orb', now) * G.potionMult(pl.acc.stats, 'orbs', now); if (xm > 1) { const f = (pl.xFrac || 0) + rw.value * (xm - 1), whole = Math.floor(f + 1e-9); pl.xFrac = f - whole; rw.value += whole; } } // disco ×1.5, admin /x2 ×2 (stack multiplicatively with weekend / boosts)
    // Combo (server-only): validated pickups within COMBO.windowMs raise the counter; multiplier capped at COMBO.maxMult.
    { const cb = pl.combo || (pl.combo = { n: 0, last: 0, mult: 1, tier: 1 });
      if (now - cb.last > G.COMBO.windowMs) cb.n = 0;
      cb.n++; cb.last = now; cb.mult = G.comboMult(cb.n);
      let tier = 1; for (const t of G.COMBO.tiers) if (cb.n >= t.n) tier = t.n;
      const popped = tier > cb.tier; cb.tier = tier;
      if (cb.mult > 1) { const f = (pl.cFrac || 0) + rw.value * (cb.mult - 1), whole = Math.floor(f + 1e-9); pl.cFrac = f - whole; rw.value += whole; }
      pl.socket.emit('combo', { n: cb.n, mult: cb.mult, left: G.COMBO.windowMs, pop: popped });
    }
    FX.onCollect(pl, o, rw.value);
    if (G.ORB_RANK[o.t] >= G.ORB_RANK.r && G.potionOn(pl.acc.stats, 'shard', now) && Math.random() < G.POTIONS.shard.chance) { const g = INV.grantItem(pl.acc, G.SHARD_ID, 1, 'arena'); if (g.ok) { pl.socket.emit('item', { id: G.SHARD_ID, qty: 1, source: 'arena' }); emitProfile(pl); } } // «Зелье осколков»
    if (rw.lucky) pl.lucky++;
    if (rw.jackpot) pl.jackpots++;
    pl.gained += rw.value;
    pl.session += rw.value;
    pl.acc.balance += rw.value;
    pl.acc.total += rw.value;
    if (o.ev === 'rain' && ev && ev.kind === 'rain') { ev.rainAlive--; evScore(pl).score += rw.value; }
    if (luckyOn()) evScore(pl).score += rw.value; // «Волна удачи»: orbs collected during the wave
    if (ot.shards && (o.t === 'l' || o.t === 'x' || o.t === 'm')) { // legendary 1, astral 2, mythic 3 shards
      const g = INV.grantItem(pl.acc, G.SHARD_ID, ot.shards, 'arena');
      pl.socket.emit('item', g.ok ? { id: G.SHARD_ID, qty: ot.shards, source: 'arena' } : { error: g.error });
      if (g.ok) emitProfile(pl);
      if (o.t === 'm' || o.t === 'l' || o.t === 'x') {
        if (o.t === 'm') systemChat(`${pl.acc.name} поймал(а) мифическую сферу!`);
        respawnQueue.push({ due: now + rand(SPAWN.respawnMin, SPAWN.respawnMax), z: o.z });
      }
    } else if (o.pool) respawnQueue.push({ due: now + rand(SPAWN.respawnMin, SPAWN.respawnMax), z: o.z });
  }
}

let lastTickAt = Date.now();
// ---------------------------------------------------------------- admin fun events (all penalties small and capped)
const FUN = { touch: G.PLAYER_R * 2 + 6, lavaLoss: 2, lavaCap: 30, ghostLoss: 10, ghostCap: 40, ghostStunMs: 2000, ghostCdMs: 5000, giantR: 70 };
const fun = { hunt: null, giant: null, chaos: 0, lava: null, ghost: null, freeze: false, chest: null, poll: null };
let pollSeq = 0;
const adminPl = () => { for (const q of players.values()) if (isAdmin(q.acc)) return q; return null; };
function funPublic(now = Date.now()) {
  const left = u => Math.max(0, u - now);
  return {
    hunt: fun.hunt && fun.hunt.until > now ? { left: left(fun.hunt.until), prize: fun.hunt.prize } : null,
    giant: fun.giant ? { x: fun.giant.x, y: fun.giant.y, r: FUN.giantR, left: left(fun.giant.until), n: fun.giant.touched.size, total: fun.giant.total } : null,
    chaos: fun.chaos > now ? left(fun.chaos) : 0,
    lava: fun.lava && fun.lava.until > now ? { islands: fun.lava.islands, left: left(fun.lava.until) } : null,
    ghost: fun.ghost ? fun.ghost.id : null, freeze: fun.freeze,
    chest: fun.chest ? { x: fun.chest.x, y: fun.chest.y, left: left(fun.chest.until) } : null,
  };
}
function pushFun() { if (io) io.to('arena').emit('fun', funPublic()); }
function payPrize(q, prize, src) {
  if (prize.orbs > 0) { q.acc.balance += prize.orbs; q.socket.emit('bal', { b: q.acc.balance, t: q.acc.total, s: q.session }); }
  if (prize.shards > 0) { const r = INV.grantItem(q.acc, G.SHARD_ID, prize.shards, 'admin'); if (r.ok) q.socket.emit('item', { id: G.SHARD_ID, qty: prize.shards, source: 'admin' }); }
  accountChanged(q.acc);
}
const prizeText = p => [p.orbs ? p.orbs + ' сфер' : '', p.shards ? p.shards + ' оск.' : ''].filter(Boolean).join(' + ') || 'слава';
function funSpeed(pl, now) { // non-admin movement multiplier from fun events
  if (isAdmin(pl.acc)) return 1;
  if (fun.freeze || pl.stunUntil > now) return 0;
  return fun.chaos > now ? -1 : 1; // chaos: controls inverted
}
function endGiant() {
  const g = fun.giant; if (!g) return; fun.giant = null;
  const list = Array.from(g.touched).map(k => byKey.get(k)).filter(Boolean);
  if (list.length) { const each = Math.max(1, Math.floor(g.total / list.length)); for (const q of list) payPrize(q, { orbs: each }); systemChat(`🟣 Гигантская сфера: ${list.length} игрок(ов) получили по ${each} сфер`); }
  else systemChat('🟣 Гигантская сфера исчезла — никто её не коснулся');
  pushFun();
}
function funTick(now) {
  let changed = false;
  const A = adminPl();
  if (fun.hunt) {
    if (fun.hunt.until <= now || !A) { fun.hunt = null; systemChat('🏃 Охота на админа закончилась — никто не поймал'); changed = true; }
    else for (const q of players.values()) if (q !== A && Math.hypot(q.x - A.x, q.y - A.y) <= FUN.touch) { payPrize(q, fun.hunt.prize); io.to('arena').emit('adm:announce', { t: `🏆 ${q.acc.name} поймал(а) админа! Приз: ${prizeText(fun.hunt.prize)}` }); fun.hunt = null; changed = true; break; }
  }
  if (fun.giant) {
    for (const q of players.values()) if (!isAdmin(q.acc) && Math.hypot(q.x - fun.giant.x, q.y - fun.giant.y) <= FUN.giantR + G.PLAYER_R) { if (!fun.giant.touched.has(q.acc.key)) { fun.giant.touched.add(q.acc.key); changed = true; } }
    if (fun.giant.until <= now) endGiant();
  }
  if (fun.chest) {
    if (fun.chest.until <= now) { fun.chest = null; systemChat('🎁 Бонусный сундук исчез'); changed = true; }
    else for (const q of players.values()) if (!isAdmin(q.acc) && Math.hypot(q.x - fun.chest.x, q.y - fun.chest.y) <= 40 + G.PLAYER_R) { payPrize(q, fun.chest.prize); io.to('arena').emit('adm:announce', { t: `🎁 ${q.acc.name} нашёл(ла) бонусный сундук! ${prizeText(fun.chest.prize)}` }); fun.chest = null; changed = true; break; }
  }
  if (fun.ghost) {
    const G2 = players.get(fun.ghost.id);
    if (!G2 || fun.ghost.until <= now) { fun.ghost = null; systemChat('👻 Призрак-админ исчез'); changed = true; }
    else for (const q of players.values()) {
      if (q === G2 || q.ghostCd > now || Math.hypot(q.x - G2.x, q.y - G2.y) > FUN.touch) continue;
      q.ghostCd = now + FUN.ghostCdMs; q.stunUntil = now + FUN.ghostStunMs; q.ghostLost = q.ghostLost || 0;
      const loss = Math.min(FUN.ghostLoss, q.acc.balance, Math.max(0, FUN.ghostCap - q.ghostLost)); q.ghostLost += loss;
      if (loss) { q.acc.balance -= loss; markDirty(q.acc); q.socket.emit('bal', { b: q.acc.balance, t: q.acc.total, s: q.session }); }
      q.socket.emit('chat', { notice: true, t: `👻 Призрак поймал вас! −${loss} сфер, оглушение 2 с` });
    }
  }
  if (fun.lava && fun.lava.until <= now) { fun.lava = null; systemChat('🌋 Пол больше не лава'); changed = true; }
  if (changed) pushFun();
}
function lavaSecond(now) { // once per second: players outside every island lose a little (capped per event)
  if (!fun.lava) return;
  for (const q of players.values()) {
    if (isAdmin(q.acc) || fun.lava.islands.some(i => Math.hypot(q.x - i.x, q.y - i.y) <= i.r)) continue;
    const lost = fun.lava.lost.get(q.acc.key) || 0, loss = Math.min(FUN.lavaLoss, q.acc.balance, FUN.lavaCap - lost);
    if (loss <= 0) continue;
    fun.lava.lost.set(q.acc.key, lost + loss); q.acc.balance -= loss; markDirty(q.acc); q.socket.emit('bal', { b: q.acc.balance, t: q.acc.total, s: q.session });
  }
}
function pollPublic() { const p = fun.poll; if (!p) return null; const c = p.opts.map(() => 0); for (const v of p.votes.values()) c[v]++; return { id: p.id, q: p.q, opts: p.opts, counts: c, left: Math.max(0, p.until - Date.now()) }; }
function pushPoll() { if (io) io.to('arena').emit('poll', pollPublic()); }
// ---------------------------------------------------------------- potions on the map (rare pickups) + emotes
let mapPots = [], nextPotId = 1, potDueAt = Date.now() + rand(G.POTION_MAP.everyMinMs, G.POTION_MAP.everyMaxMs);
const publicPots = () => mapPots.map(p => [p.id, p.x, p.y, p.item]);
function pushPots() { if (io) io.to('arena').emit('pots', publicPots()); }
function potionSecond(now) {
  const before = mapPots.length; mapPots = mapPots.filter(p => p.exp > now);
  if (players.size && now >= potDueAt && mapPots.length < G.POTION_MAP.maxAlive) {
    potDueAt = now + rand(G.POTION_MAP.everyMinMs, G.POTION_MAP.everyMaxMs);
    const w = G.POTION_MAP.weights, tot = Object.values(w).reduce((a, b) => a + b, 0); let r = Math.random() * tot, item = 'p_speed';
    for (const [k, v] of Object.entries(w)) { if ((r -= v) < 0) { item = k; break; } }
    const at = randomSpot(120); mapPots.push({ id: nextPotId++, x: at.x, y: at.y, item, exp: now + G.POTION_MAP.lifeMs });
  }
  if (mapPots.length !== before || mapPots.some(p => p.exp - now > G.POTION_MAP.lifeMs - 1000)) pushPots();
}
function addMapPotion(item, x, y) { const p = { id: nextPotId++, x: Math.round(x), y: Math.round(y), item, exp: Date.now() + G.POTION_MAP.lifeMs }; mapPots.push(p); pushPots(); return p; }
function potionPickup(pl) {
  for (let i = 0; i < mapPots.length; i++) {
    const p = mapPots[i]; if (Math.hypot(pl.x - p.x, pl.y - p.y) > G.PLAYER_R + G.POTION_MAP.r + 6) continue;
    const r = INV.grantItem(pl.acc, p.item, 1, 'arena');
    if (!r.ok) { if (!pl.potFullAt || Date.now() - pl.potFullAt > 5000) { pl.potFullAt = Date.now(); pl.socket.emit('item', { error: 'Зелье не поместилось — инвентарь полон.' }); } continue; }
    mapPots.splice(i, 1); pushPots(); pl.socket.emit('item', { id: p.item, qty: 1, source: 'arena' }); accountChanged(pl.acc); return;
  }
}
// tick cost / loop lag / dropped inputs (exposed in /api/health as perf; reset each report window of 60 s)
const perf = { n: 0, sum: 0, max: 0, lagMax: 0, dropped: 0, at: Date.now(), last: null };
function perfReport() { const now = Date.now(); if (now - perf.at < 60000 && perf.last) return perf.last;
  perf.last = { tickAvgMs: perf.n ? +(perf.sum / perf.n).toFixed(3) : 0, tickMaxMs: +perf.max.toFixed(2), lagMaxMs: perf.lagMax, inputsDropped: perf.dropped, ticks: perf.n };
  if (now - perf.at >= 60000) Object.assign(perf, { n: 0, sum: 0, max: 0, lagMax: 0, dropped: 0, at: now }); return perf.last; }
function tick() {
  const t0 = process.hrtime.bigint();
  try { tickInner(); } finally { const ms = Number(process.hrtime.bigint() - t0) / 1e6; perf.n++; perf.sum += ms; if (ms > perf.max) perf.max = ms; }
}
function tickInner() {
  const now = Date.now(), dt = Math.min(250, now - lastTickAt);
  perf.lagMax = Math.max(perf.lagMax, now - lastTickAt - G.TICK_MS);
  lastTickAt = now;
  for (const pl of players.values()) {
    pl.x0 = pl.x; pl.y0 = pl.y;
    // movement budget grows with real elapsed time (not per tick), so a burst of inputs delayed by the network or a late tick
    // is replayed instead of thrown away (dropped inputs = the client's prediction snaps back). Average speed stays capped.
    pl.budget = Math.min(pl.budget + dt / G.TICK_MS, 40);
    while (pl.inputs.length > 40) { pl.lastSeq = pl.inputs.shift().s; perf.dropped++; } // > 2 s behind: drop the oldest // keep latency bounded
    const speed = G.speedFor(pl.acc.upgrades.speed) * C.boostMult(pl.acc.stats, 'speed', now) * (pl.frozen ? 0 : pl.spd || 1) * boostMult('custom', 'spd', now) * funSpeed(pl, now) * G.potionMult(pl.acc.stats, 'speed', now);
    const solid = FX.solids();
    const radius = G.pickupFor(pl.acc.upgrades.magnet) * G.potionMult(pl.acc.stats, 'magnet', now);
    for (let steps = 0; pl.budget >= 1 && pl.inputs.length && steps < 12; steps++) { // ≤ 12 steps a tick: a backlog drains over a few ticks
      const inp = pl.inputs.shift();
      pl.budget -= 1;
      const px = pl.x;
      G.applyInput(pl, inp.x, inp.y, speed);
      G.zoneGate(pl, px, pl.acc.stats.unlockedDoor2 === true);
      G.resolveObstacles(pl, obstacles); if (solid.length) G.resolveObstacles(pl, solid);
      pl.lastSeq = inp.s;
      collectAround(pl, radius, now);
      if (mapPots.length) potionPickup(pl);
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
    for (const pl of players.values()) { if (pl.invis) continue; pl.mx = pl.x - pl.x0; pl.my = pl.y - pl.y0; pl.lvl = pl.acc.upgrades.speed || 0; list.push(pl); }
    G.separatePlayers(list);
    for (const pl of list) { G.zoneGate(pl, pl.x0, pl.acc.stats.unlockedDoor2 === true); G.resolveObstacles(pl, obstacles); } // pushes never carry anyone through a wall
  }
  funTick(now);
  spawnTick(now);
  eventTick(now, dt);
  obstacleTick(now);
  FX.tick(now, dt);
  const p = [];
  for (const pl of players.values()) p.push([pl.id, Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100, pl.lastSeq]);
  const st = { t: now, p, oa: pendingAdds, od: pendingDels };
  if (ev && ev.runners && ev.phase === 'active') st.rn = ev.runners.filter(r => !r.caught).map(r => [r.id, Math.round(r.x), Math.round(r.y)]); // «Раннеры» positions
  const rb = obstacles.filter(o => o.k === 'robot');
  if (rb.length) st.rb = rb.map(o => [o.id, +o.face.toFixed(3), o.aim ? 1 : 0, o.aim ? Math.round(o.aim.x) : 0, o.aim ? Math.round(o.aim.y) : 0]); // robots: facing, aiming (telegraph)
  const bp = FX.state(st);
  if (shots.length || bp.length) st.pj = shots.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]).concat(bp);
  const hidden = Array.from(players.values()).filter(q => q.invis);
  if (!hidden.length) io.to('arena').emit('s', st);
  else { // invisible admin: only they get their own position; everyone else gets the list without them
    const ids = new Set(hidden.map(q => q.id)), st2 = Object.assign({}, st, { p: p.filter(r => !ids.has(r[0])) });
    io.to('arena').except(hidden.map(q => q.socket.id)).emit('s', st2);
    for (const q of hidden) q.socket.emit('s', Object.assign({}, st2, { p: st2.p.concat([p.find(r => r[0] === q.id)]) }));
  }
  pendingAdds = []; pendingDels = [];
}

function everySecond() {
  const top = Array.from(players.values()).sort((a, b) => b.session - a.session || a.joinedAt - b.joinedAt).slice(0, 10)
    .map(pl => [pl.id, pl.acc.name, pl.session]);
  io.to('arena').emit('top', { online: players.size, top, wk: weekendState().left }); // wk: ms until Monday 00:00 MSK (0 = no weekend bonus)
  const now = Date.now();
  for (const pl of players.values()) pl.socket.emit('sping', now);
  FX.everySecond(now);
  lavaSecond(now);
  potionSecond(now);
  if (fun.poll && fun.poll.until <= now) { const r = pollPublic(); fun.poll = null; io.to('arena').emit('poll', Object.assign(r, { done: true })); }
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
  initTrade();
  try { for (const c of await store.listAdminCodes()) adminCodes.set(c.code, c); } catch (e) { console.error('admin codes load failed:', e.message); }
  try { // one summary line of active panel codes (code text + reward + limits only) for ops
    const act = []; for (const c of adminCodes.values()) if (!c.builtin && !c.deleted && !c.disabled) act.push({ code: c.code, rewards: c.rewards, maxUses: c.maxUses, used: await store.codeUses(c.code), expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null });
    const off = [...adminCodes.values()].filter(c => c.deleted || c.disabled).map(c => c.code);
    console.log('OCS_ACTIVE_PANEL_CODES ' + JSON.stringify({ active: act, removedOrDisabled: off }));
  } catch (e) { console.error('codes summary failed:', e.message); }
  console.log(`Storage: ${store.describe()}, ${await store.countAccounts()} accounts`);
  if (TEST_HOOKS) console.warn('WARNING: OCS_TEST_HOOKS=1 — test-only socket events are enabled');
  await store.purgeExpiredSessions(Date.now());
  await applyPasswordReset();
  for (const n of WIPE_V1) { try { await loadAccount(n.toLowerCase()); } catch (e) { console.error('[wipeV1] load failed:', e.message); } }
  await flush();
  setInterval(tick, G.TICK_MS);
  setInterval(everySecond, 1000);
  setInterval(flush, FLUSH_MS);
  setInterval(() => store.purgeExpiredSessions(Date.now()).catch(e => console.error('purge failed:', e.message)), 3600 * 1000);
  server.listen(PORT, () => console.log(`Orb Collecting Simulator on http://localhost:${PORT} (version ${VERSION})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
