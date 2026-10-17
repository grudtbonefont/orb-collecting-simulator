'use strict';
// Server side of the content update: mini-events, tiered achievements, daily quests, boss. Server-authoritative;
// per-account progress lives in acc.stats (additive JSON fields only):
//   stats.ach {id: unlockedAt}, stats.title, stats.daily {day, q:[{id,p,done,rw}], bonus}, stats.streak, stats.streakDay, stats.bestStreak,
//   stats.boosts {orbs|speed: until}, counters legendaryCaught, mythicCaught, runnersCaught, treasures, bossDmg, bossKills, zaps, chests, portals, questsDone
const G = require('../public/shared.js');
const C = require('../public/content.js');
const INV = require('./inventory');
const rand = (a, b) => a + Math.random() * (b - a);
const envNum = (n, d) => { const v = process.env[n]; if (v === undefined || v === '') return d; const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };

module.exports = function createFeatures(ctx) {
  // ctx: { io(), players, orbs, addOrb, removeOrb, pickSpot, inObstacle, payReward, markDirty, emitProfile, systemChat, flushSoon, penalize, mainEventBusy, testHooks }
  const off = ctx.testHooks ? 0 : -1; // test servers: off unless the env asks for them
  const MINI_EVERY = envNum('MINI_EVERY_MS', off), MINI_DUR = envNum('MINI_DURATION_MS', 0), ROOM_MS = envNum('MINI_ROOM_MS', C.MINI.portal.roomMs) || C.MINI.portal.roomMs;
  const BOSS_EVERY = envNum('BOSS_EVERY_MS', off), BOSS_ANN = envNum('BOSS_ANNOUNCE_MS', C.BOSS.announceMs), BOSS_LIFE = envNum('BOSS_LIFE_MS', C.BOSS.lifeMs);
  const io = () => ctx.io();
  const online = () => Array.from(ctx.players.values());
  const inArena = pl => !G.inBonusRoom(pl);

  // ------------------------------------------------------------ rewards (orbs = earned: balance + all-time total)
  function grant(acc, rw, source, pl) {
    const out = {};
    if (rw.orbs) { acc.balance += rw.orbs; acc.total += rw.orbs; out.orbs = rw.orbs; }
    if (rw.shards) out.shards = INV.addShards(acc, rw.shards);
    if (rw.boost && C.BOOSTS[rw.boost]) {
      const b = acc.stats.boosts = Object.assign({}, acc.stats.boosts), now = Date.now();
      b[rw.boost] = Math.max(now, b[rw.boost] || 0) + (rw.min || 5) * 60000; out.boost = rw.boost; out.min = rw.min;
    }
    if (rw.item) {
      const g = INV.grantItem(acc, rw.item, 1, source);
      if (g.ok) out.item = rw.item; else { out.shards = (out.shards || 0) + INV.addShards(acc, 2); } // already owned / no room → 2 shards instead
    }
    ctx.markDirty(acc);
    if (pl) { pl.socket.emit('bal', { b: acc.balance, t: acc.total, s: pl.session }); ctx.emitProfile(pl); }
    return out;
  }
  const bump = (acc, k, n = 1) => { acc.stats[k] = (acc.stats[k] || 0) + n; ctx.markDirty(acc); };

  // ------------------------------------------------------------ achievements
  function achProfile(acc, pl) { return { total: acc.total, stats: acc.stats, codesUsed: (acc.codes || []).length, items: C.itemsOwned(acc.inventory && acc.inventory.slots), liveMs: pl ? Date.now() - pl.joinedAt : 0 }; }
  // one-time switch to tiered chains: each old achievement (already paid) marks the tier it covers as paid and only the difference is paid now
  function migrateAchV2(acc, now) {
    const st = acc.stats; if (st.achV2) return { orbs: 0, shards: 0 };
    const credit = {};
    for (const id of Object.keys(st.ach)) { const t = C.oldTier(id); if (!t) continue; const c = credit[t.id] || (credit[t.id] = { orbs: 0, shards: 0 }), o = C.OLD_ACH[id][2]; c.orbs += o.orbs || 0; c.shards += o.shards || 0; }
    const diff = { orbs: 0, shards: 0 };
    for (const [tid, c] of Object.entries(credit)) {
      if (st.ach[tid]) continue;
      const rw = C.ACH_BY_ID[tid].reward; st.ach[tid] = now;
      diff.orbs += Math.max(0, rw.orbs - c.orbs); diff.shards += Math.max(0, rw.shards - c.shards);
    }
    st.achV2 = true; ctx.markDirty(acc); // old ids and stats.title stay stored, unused
    return diff;
  }
  // one-time achievement reset for every account (owner-confirmed, Oct 2026): paid tiers cleared, achievement-only counters zeroed,
  // chains on shared stats (total orbs, minigames, quests/streak, playtime, legendary/mythic, door, items, codes) measure from a baseline.
  // Balances, inventory, upgrades, door, quests are untouched; nothing completes right after the reset.
  const ACH_ONLY = ['rareCaught', 'epicCaught', 'goldRains', 'luckyPlayed', 'mgWins', 'buys', 'distM', 'nearLaserSec', 'runnersCaught', 'treasures', 'bossKills', 'bossDmg', 'zaps', 'chests', 'portals'];
  function achReset(acc) {
    const st = acc.stats || (acc.stats = {}); if (st.achResetV2) return false;
    st.ach = {}; st.achV2 = true; // old→new migration must not run (no re-marking, no re-paying)
    for (const k of ACH_ONLY) delete st[k];
    const p = achProfile(acc, null), base = {};
    for (const ch of C.CHAINS) { const v = Math.max(0, Math.floor(Number(ch.stat(p)) || 0)); if (v) base[ch.id] = v; }
    st.achBase = base; st.achResetV2 = Date.now(); ctx.markDirty(acc);
    return true;
  }
  function checkAch(acc, pl) {
    achReset(acc);
    const st = acc.stats; st.ach = st.ach && typeof st.ach === 'object' ? st.ach : {};
    const now = Date.now(), p = achProfile(acc, pl), got = [], sum = { orbs: 0, shards: 0 };
    const mig = migrateAchV2(acc, now);
    if (mig.orbs || mig.shards) { const r = grant(acc, mig, 'achievement', null); sum.orbs += r.orbs || 0; sum.shards += r.shards || 0; got.push(null); }
    for (const a of C.ACH) {
      if (st.ach[a.id] || C.achValue(a, p) < a.goal) continue;
      st.ach[a.id] = now; got.push(a);
      const r = grant(acc, a.reward, 'achievement', null); sum.orbs += r.orbs || 0; sum.shards += r.shards || 0;
    }
    if (got.length) {
      ctx.markDirty(acc);
      if (pl) {
        const ids = got.filter(Boolean).map(a => a.id);
        if (ids.length <= 3 && got.every(Boolean)) for (const a of got) pl.socket.emit('ach', { id: a.id, reward: a.reward });
        else pl.socket.emit('ach', { ids, reward: sum }); // backfill: one summary toast
        pl.socket.emit('bal', { b: acc.balance, t: acc.total, s: pl.session }); ctx.emitProfile(pl);
      }
      ctx.flushSoon();
    }
    return got.filter(Boolean).map(a => a.id);
  }

  // ------------------------------------------------------------ daily quests
  function ensureDaily(acc, now = Date.now()) {
    const st = acc.stats, day = C.dayKey(now);
    if (st.daily && st.daily.day === day && Array.isArray(st.daily.q)) return st.daily;
    const owned = new Set(acc.inventory.slots.map(s => s.id));
    st.daily = { day, q: C.rollQuests(Math.random, { door: st.unlockedDoor2 === true, owned }), bonus: false };
    if (st.streakDay != null && st.streakDay < day - 1) st.streak = 0; // missed a day: the streak is gone
    ctx.markDirty(acc);
    return st.daily;
  }
  function questAdd(pl, kind, n = 1) {
    if (!pl || !(n > 0)) return;
    const acc = pl.acc, d = ensureDaily(acc), st = acc.stats;
    let changed = false;
    for (const q of d.q) {
      const def = C.QUEST_BY_ID[q.id];
      if (!def || q.done || def.kind !== kind) continue;
      q.p = Math.min(def.goal, q.p + n); changed = true;
      if (q.p >= def.goal) {
        q.done = true; bump(acc, 'questsDone');
        const r = grant(acc, q.rw, 'quest', null);
        pl.socket.emit('quest', { id: q.id, reward: r }); pl.questNow = true;
      }
    }
    if (!changed) return;
    if (!d.bonus && d.q.every(q => q.done)) {
      d.bonus = true;
      st.streak = st.streakDay === d.day - 1 ? (st.streak || 0) + 1 : st.streakDay === d.day ? (st.streak || 1) : 1;
      st.streakDay = d.day; st.bestStreak = Math.max(st.bestStreak || 0, st.streak);
      const r = grant(acc, C.allDoneBonus(st.streak), 'quest', null);
      pl.socket.emit('quest', { all: true, streak: st.streak, reward: r });
      pl.questNow = true;
    }
    ctx.markDirty(acc);
    pl.questDirty = true;
  }
  function pushQuests(pl, now) {
    if (!pl.questDirty || (!pl.questNow && now - (pl.questSentAt || 0) < 400)) return;
    pl.questDirty = false; pl.questNow = false; pl.questSentAt = now;
    ctx.emitProfile(pl);
  }

  // ------------------------------------------------------------ hooks from the game
  function onCollect(pl, o, value) {
    const acc = pl.acc;
    questAdd(pl, 'orbs', value);
    if (G.ORB_RANK[o.t] >= G.ORB_RANK.r) questAdd(pl, 'rare', 1);
    if (G.ORB_RANK[o.t] >= G.ORB_RANK.r) bump(acc, 'rareCaught');
    if (G.ORB_RANK[o.t] >= G.ORB_RANK.e) bump(acc, 'epicCaught');
    if (o.ev === 'gold' && mini && mini.goldSeen && !mini.goldSeen.has(acc.key)) { mini.goldSeen.add(acc.key); bump(acc, 'goldRains'); }
    if (o.t === 'l') bump(acc, 'legendaryCaught');
    if (o.t === 'm') bump(acc, 'mythicCaught');
    if (o.ev === 'gold') questAdd(pl, 'gold', 1);
    if (o.ev === 'bonus' && mini && mini.room) mini.room.alive--;
    else if (o.ev === 'bonus' && roomLeft) roomLeft.alive--;
  }
  const onRunner = pl => { bump(pl.acc, 'runnersCaught'); questAdd(pl, 'runner'); };
  const onTreasure = pl => { bump(pl.acc, 'treasures'); };
  const onEventPlayed = pl => questAdd(pl, 'event');
  const onMinigame = pl => questAdd(pl, 'mg');
  const onZap = pl => bump(pl.acc, 'zaps');
  function onJoin(pl) { ensureDaily(pl.acc); checkAch(pl.acc, pl); pl.playAcc = 0; }
  function everySecond(now) {
    for (const pl of online()) {
      pl.playAcc = (pl.playAcc || 0) + 1000;
      if (pl.playAcc >= 60000) { pl.playAcc -= 60000; questAdd(pl, 'play', 1); }
      if (G.zoneOf(pl.x) === 2 && inArena(pl)) questAdd(pl, 'zone2', 1);
      if (pl.lastPos) { const d = Math.hypot(pl.x - pl.lastPos.x, pl.y - pl.lastPos.y); if (d < 800) { pl.distFrac = (pl.distFrac || 0) + d / 10; const m = Math.floor(pl.distFrac); if (m) { pl.distFrac -= m; bump(pl.acc, 'distM', m); } } } // metres = px / 10 (teleports skipped)
      pl.lastPos = { x: pl.x, y: pl.y };
      if (inArena(pl) && ctx.nearLaser && !(pl.zapUntil > now) && ctx.nearLaser(pl, now)) bump(pl.acc, 'nearLaserSec');
      if (C.dayKey(now) !== (pl.acc.stats.daily && pl.acc.stats.daily.day)) { ensureDaily(pl.acc, now); ctx.emitProfile(pl); }
      checkAch(pl.acc, pl);
    }
  }

  // ------------------------------------------------------------ mini-events
  let mini = null, miniDue = Date.now() + (MINI_EVERY > 0 ? MINI_EVERY : rand(C.MINI.everyMinMs, C.MINI.everyMaxMs)), lastMini = null, roomLeft = null;
  const nextMiniGap = () => (MINI_EVERY > 0 ? MINI_EVERY : rand(C.MINI.everyMinMs, C.MINI.everyMaxMs));
  // 500–1400 px from a random player in the arena, in that player's zone, off obstacles
  function nearSpot(margin = 200) {
    const list = online().filter(inArena);
    for (let i = 0; i < 60 && list.length; i++) {
      const pl = list[Math.floor(Math.random() * list.length)], a = rand(0, Math.PI * 2), d = rand(500, 1400);
      const z = G.zoneOf(pl.x), X0 = z === 2 ? G.ZONE_W : 0, x = Math.round(pl.x + Math.cos(a) * d), y = Math.round(pl.y + Math.sin(a) * d);
      if (x < X0 + margin || x > X0 + G.ZONE_W - margin || y < margin || y > G.WORLD.h - margin || ctx.inObstacle(x, y, 80)) continue;
      return { x, y };
    }
    return { x: Math.round(rand(margin, G.ZONE_W - margin)), y: Math.round(rand(margin, G.ZONE_H - margin)) };
  }
  function publicMini(now = Date.now()) {
    if (!mini) return null;
    const d = { kind: mini.kind, x: mini.x, y: mini.y, left: Math.max(0, Math.round(mini.endAt - now)), dur: mini.dur };
    if (mini.kind === 'chest') { d.prog = Math.round(mini.prog); d.need = mini.need; d.near = mini.near; }
    if (mini.kind === 'goldrain') d.r = C.MINI.goldrain.radius;
    return d;
  }
  const pushMini = () => io().to('arena').emit('mini', publicMini());
  function startMini(kind, o = {}) {
    if (mini) endMini('forced');
    const def = C.MINI[kind], now = Date.now(), at = Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: Math.round(o.x), y: Math.round(o.y) } : nearSpot();
    const dur = o.durationMs || MINI_DUR || def.durationMs;
    mini = { kind, x: at.x, y: at.y, startAt: now, endAt: now + dur, dur, lastPush: 0 };
    if (kind === 'goldrain') {
      mini.goldSeen = new Set();
      for (let i = 0; i < def.count; i++) {
        const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * def.radius, x = Math.round(at.x + Math.cos(a) * r), y = Math.round(at.y + Math.sin(a) * r);
        if (x < 40 || y < 40 || x > G.WORLD.w - 40 || y > G.WORLD.h - 40 || G.zoneOf(x) !== G.zoneOf(at.x) || ctx.inObstacle(x, y, 14)) continue;
        ctx.addOrb(G.rollOrbType(def.weights), { x, y }, 'gold');
      }
    } else if (kind === 'chest') { mini.prog = 0; mini.near = 0; mini.need = online().length <= 1 ? def.soloMs : def.duoMs; }
    else if (kind === 'portal') { mini.used = new Set(); mini.room = roomLeft || { alive: 0 }; roomLeft = null; }
    lastMini = kind;
    io().to('arena').emit('mini:start', publicMini(now));
    ctx.systemChat(`${def.icon} Мини-событие «${def.name}»!`);
  }
  function endMini(reason, extra) {
    const m = mini; if (!m) return;
    mini = null; miniDue = Date.now() + nextMiniGap();
    if (m.kind === 'goldrain') for (const o of Array.from(ctx.orbs.values())) if (o.ev === 'gold') ctx.removeOrb(o, 0);
    if (m.kind === 'portal') roomLeft = m.room; // players still inside keep their 30 s
    io().to('arena').emit('mini:end', Object.assign({ kind: m.kind, reason: reason || 'time' }, extra || {}));
  }
  function openChest() {
    const def = C.MINI.chest, near = online().filter(pl => inArena(pl) && Math.hypot(pl.x - mini.x, pl.y - mini.y) <= def.openR);
    const n = Math.max(1, near.length), orbsEach = Math.max(def.minOrbs, Math.round(def.pool.orbs / n)), names = [];
    near.forEach((pl, i) => {
      const rw = { orbs: orbsEach, shards: i < def.pool.shards ? Math.max(1, Math.floor(def.pool.shards / Math.min(n, def.pool.shards))) : 0 };
      bump(pl.acc, 'chests'); questAdd(pl, 'chest'); ctx.payReward(pl, rw); names.push(pl.acc.name);
      pl.socket.emit('mini:reward', { kind: 'chest', reward: rw });
    });
    ctx.systemChat(`🧰 Сундук открыт: ${names.join(', ')}`);
    endMini('opened', { names });
  }
  function enterRoom(pl, now) {
    const R = G.BONUS_ROOM;
    pl.roomBack = { x: pl.x, y: pl.y }; pl.roomUntil = now + ROOM_MS;
    pl.x = R.x + R.w / 2 + rand(-120, 120); pl.y = R.y + R.h / 2 + rand(-80, 80); pl.inputs.length = 0; pl.kx = pl.ky = 0;
    bump(pl.acc, 'portals'); questAdd(pl, 'portal'); ctx.emitProfile(pl);
    pl.socket.emit('room', { left: ROOM_MS });
  }
  function leaveRoom(pl) {
    const b = pl.roomBack || { x: 300, y: 300 };
    pl.x = b.x; pl.y = b.y; pl.roomBack = null; pl.roomUntil = 0; pl.inputs.length = 0; pl.kx = pl.ky = 0;
    pl.socket.emit('room', { left: 0 });
  }
  function roomTick(now, dt) {
    const inside = online().filter(pl => pl.roomUntil);
    for (const pl of inside) if (now >= pl.roomUntil) leaveRoom(pl);
    const room = (mini && mini.room) || roomLeft, still = inside.filter(pl => pl.roomUntil);
    if (!room) return;
    if (!still.length && !(mini && mini.kind === 'portal')) { // nobody left and the portal is gone: clean up
      for (const o of Array.from(ctx.orbs.values())) if (o.ev === 'bonus') ctx.removeOrb(o, 0);
      roomLeft = null; return;
    }
    if (!still.length) return;
    const def = C.MINI.portal, R = G.BONUS_ROOM;
    room.budget = Math.min(room.alive ? def.refillPerSec : def.roomOrbs, (room.budget || 0) + def.refillPerSec * dt / 1000 + (room.alive ? 0 : def.roomOrbs));
    while (room.alive < def.roomOrbs && room.budget >= 1) {
      room.budget -= 1; room.alive++;
      ctx.addOrb(G.rollOrbType(def.weights), { x: Math.round(rand(R.x + 40, R.x + R.w - 40)), y: Math.round(rand(R.y + 40, R.y + R.h - 40)) }, 'bonus');
    }
  }
  function miniTick(now, dt) {
    roomTick(now, dt);
    if (!mini) {
      if (MINI_EVERY === 0 || !ctx.players.size || now < miniDue) return;
      const kinds = C.MINI_KEYS.filter(k => k !== lastMini);
      startMini(kinds[Math.floor(Math.random() * kinds.length)]);
      return;
    }
    if (!ctx.players.size) { endMini('empty'); return; }
    if (mini.kind === 'chest') {
      const def = C.MINI.chest, near = online().filter(pl => inArena(pl) && Math.hypot(pl.x - mini.x, pl.y - mini.y) <= def.openR).length;
      mini.need = online().length <= 1 ? def.soloMs : def.duoMs;
      const okNow = online().length <= 1 ? near >= 1 : near >= 2, prev = mini.prog;
      mini.near = near;
      mini.prog = okNow ? mini.prog + dt : Math.max(0, mini.prog - dt * 2);
      if (mini.prog >= mini.need) { openChest(); return; }
      if ((mini.prog !== prev || near !== mini.lastNear) && now - mini.lastPush >= 250) { mini.lastPush = now; mini.lastNear = near; pushMini(); }
    } else if (mini.kind === 'portal') {
      const def = C.MINI.portal;
      for (const pl of online()) if (inArena(pl) && !mini.used.has(pl.acc.key) && Math.hypot(pl.x - mini.x, pl.y - mini.y) <= def.r + G.PLAYER_R) { mini.used.add(pl.acc.key); enterRoom(pl, now); }
    }
    if (mini && now >= mini.endAt) endMini('time');
  }

  // ------------------------------------------------------------ boss
  let boss = null, bossClock = 0, bossGap = BOSS_EVERY > 0 ? BOSS_EVERY : rand(C.BOSS.everyMinMs, C.BOSS.everyMaxMs), bossShots = [], nextBossShotId = 1e6;
  const nextBossGap = () => (BOSS_EVERY > 0 ? BOSS_EVERY : rand(C.BOSS.everyMinMs, C.BOSS.everyMaxMs));
  function publicBoss(now = Date.now()) {
    if (!boss) return null;
    return { phase: boss.phase, x: Math.round(boss.x), y: Math.round(boss.y), hp: Math.max(0, Math.round(boss.hp)), max: boss.max, in: Math.max(0, Math.round(boss.startAt - now)), left: Math.max(0, Math.round(boss.endAt - now)), dur: boss.life, r: C.BOSS.r };
  }
  function announceBoss(o = {}) {
    const now = Date.now(), ann = Number.isFinite(o.announceMs) ? o.announceMs : BOSS_ANN, life = o.lifeMs || BOSS_LIFE;
    const x = Number.isFinite(o.x) ? o.x : Math.round(rand(900, G.ZONE_W - 900)), y = Number.isFinite(o.y) ? o.y : Math.round(rand(900, G.ZONE_H - 900));
    boss = { phase: 'announce', x, y, h: rand(0, 6.28), startAt: now + ann, endAt: now + ann + life, life, hp: 1, max: 1, fixedHp: o.hp, dmg: new Map(), lastHit: new Map(), rings: [], nextRing: 0, nextShot: 0 };
    io().to('arena').emit('boss', publicBoss(now));
    ctx.systemChat(`${C.BOSS.icon} Через ${Math.round(ann / 1000)} с в 1-й зоне появится босс «${C.BOSS.name}»!`);
  }
  function startBoss(now) {
    boss.phase = 'active'; boss.max = boss.hp = boss.fixedHp || C.bossHp(ctx.players.size);
    boss.nextRing = now + rand(C.BOSS.ringEveryMinMs, C.BOSS.ringEveryMaxMs) / 2; boss.nextShot = now + 1500;
    io().to('arena').emit('boss', publicBoss(now));
  }
  function endBoss(killed) {
    const b = boss; boss = null; bossShots = []; bossClock = 0; bossGap = nextBossGap();
    const list = Array.from(b.dmg.values()).filter(x => x.dmg > 0 && ctx.players.get(x.pl.id) === x.pl).sort((p, q) => q.dmg - p.dmg);
    const total = list.reduce((n, x) => n + x.dmg, 0);
    if (killed) list.forEach((x, i) => { x.reward = C.bossReward(x.dmg / Math.max(1, total), i === 0); bump(x.pl.acc, 'bossKills'); ctx.payReward(x.pl, x.reward); });
    const results = list.slice(0, 5).map(x => ({ name: x.pl.acc.name, dmg: x.dmg, reward: x.reward || null }));
    for (const pl of online()) {
      const mine = b.dmg.get(pl.id);
      pl.socket.emit('boss:end', { killed: !!killed, results, total, you: mine && mine.dmg > 0 ? { dmg: mine.dmg, share: Math.round(mine.dmg / Math.max(1, total) * 100), reward: mine.reward || null, place: list.indexOf(mine) + 1 } : null });
    }
    ctx.systemChat(killed ? `${C.BOSS.icon} Босс повержен! Лучший урон: ${list[0] ? list[0].pl.acc.name : '—'}` : `${C.BOSS.icon} Босс ушёл…`);
    ctx.flushSoon();
  }
  const bossTargets = () => online().filter(pl => inArena(pl) && G.zoneOf(pl.x) === 1);
  function bossTick(now, dt) {
    if (!boss) {
      if (BOSS_EVERY === 0 || !ctx.players.size) return;
      bossClock += dt;
      if (bossClock >= bossGap && !ctx.mainEventBusy()) announceBoss();
      return;
    }
    if (!ctx.players.size) { boss = null; bossShots = []; bossClock = 0; return; }
    if (boss.phase === 'announce') { if (now < boss.startAt) return; startBoss(now); }
    const B = C.BOSS, s = dt / 1000, tg = bossTargets();
    // move: towards the nearest player within 900 px, otherwise wander
    let near = null, nd = 900; for (const pl of tg) { const d = Math.hypot(pl.x - boss.x, pl.y - boss.y); if (d < nd) { nd = d; near = pl; } }
    if (near && nd > B.r + G.PLAYER_R + 30) boss.h = Math.atan2(near.y - boss.y, near.x - boss.x); else boss.h += (Math.random() - 0.5) * 0.3;
    boss.x = Math.max(B.r + 80, Math.min(G.ZONE_W - B.r - 80, boss.x + Math.cos(boss.h) * B.speed * s));
    boss.y = Math.max(B.r + 80, Math.min(G.ZONE_H - B.r - 80, boss.y + Math.sin(boss.h) * B.speed * s));
    // bump damage (per-player cooldown)
    for (const pl of tg) {
      if (Math.hypot(pl.x - boss.x, pl.y - boss.y) > G.PLAYER_R + B.r + B.hitPad) continue;
      if (now - (boss.lastHit.get(pl.id) || 0) < B.hitCooldownMs) continue;
      boss.lastHit.set(pl.id, now);
      let e = boss.dmg.get(pl.id); if (!e) { e = { pl, dmg: 0 }; boss.dmg.set(pl.id, e); }
      e.dmg += B.hitDmg; boss.hp -= B.hitDmg; bump(pl.acc, 'bossDmg', B.hitDmg); questAdd(pl, 'boss', 1);
      pl.socket.emit('boss:hit', { dmg: B.hitDmg, hp: Math.max(0, boss.hp) });
      if (boss.hp <= 0) { endBoss(true); return; }
    }
    // shockwave rings
    if (now >= boss.nextRing) {
      boss.nextRing = now + rand(B.ringEveryMinMs, B.ringEveryMaxMs);
      const ring = { x: boss.x, y: boss.y, at: now + B.ringWarnMs, hit: new Set() };
      boss.rings.push(ring);
      io().to('arena').emit('boss:ring', { x: Math.round(ring.x), y: Math.round(ring.y), warn: B.ringWarnMs, speed: B.ringSpeed, max: B.ringMax, w: B.ringW });
    }
    boss.rings = boss.rings.filter(r => {
      if (now < r.at) return true;
      const rr = (now - r.at) / 1000 * B.ringSpeed; if (rr > B.ringMax) return false;
      for (const pl of tg) if (!r.hit.has(pl.id) && Math.abs(Math.hypot(pl.x - r.x, pl.y - r.y) - rr) <= B.ringW / 2 + G.PLAYER_R) { r.hit.add(pl.id); if (!(pl.zapUntil > now)) ctx.penalize(pl, now, 'boss'); }
      return true;
    });
    // shots at a random player in range
    if (now >= boss.nextShot) {
      boss.nextShot = now + B.shotEveryMs;
      const inR = tg.filter(pl => Math.hypot(pl.x - boss.x, pl.y - boss.y) <= B.shotRange);
      if (inR.length) { const pl = inR[Math.floor(Math.random() * inR.length)], a = Math.atan2(pl.y - boss.y, pl.x - boss.x);
        bossShots.push({ id: nextBossShotId++, x: boss.x + Math.cos(a) * (B.r + 10), y: boss.y + Math.sin(a) * (B.r + 10), vx: Math.cos(a) * B.shotSpeed, vy: Math.sin(a) * B.shotSpeed, dieAt: now + 3000 }); }
    }
    bossShots = bossShots.filter(b => {
      b.x += b.vx * s; b.y += b.vy * s;
      if (now >= b.dieAt || b.x < 0 || b.y < 0 || b.x > G.ZONE_W || b.y > G.WORLD.h) return false;
      for (const pl of tg) { if (Math.hypot(pl.x - b.x, pl.y - b.y) > G.PLAYER_R + G.OBSTACLES.shotR) continue; if (!(pl.zapUntil > now)) ctx.penalize(pl, now, 'boss'); return false; }
      return true;
    });
    if (boss && now >= boss.endAt) endBoss(false);
  }
  const solids = () => (boss && boss.phase === 'active' ? [{ k: 'circle', x: boss.x, y: boss.y, r: C.BOSS.r }] : []);

  function tick(now, dt) {
    miniTick(now, dt);
    bossTick(now, dt);
    for (const pl of ctx.players.values()) pushQuests(pl, now);
  }
  function state(st) {
    if (boss && boss.phase === 'active') st.bs = [Math.round(boss.x), Math.round(boss.y), Math.max(0, Math.round(boss.hp)), boss.max];
    return bossShots.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]);
  }
  function onLeave(pl) { if (pl.roomUntil) { pl.roomUntil = 0; } }
  const joinState = () => ({ mini: publicMini(), boss: publicBoss() });

  return { grant, checkAch, achReset, ensureDaily, questAdd, onCollect, onRunner, onTreasure, onEventPlayed, onMinigame, onZap, onJoin, onLeave, everySecond, tick, state, solids, joinState,
    startMini, endMini, announceBoss, resetBossTimer: () => { bossClock = 0; bossGap = nextBossGap(); return bossGap; }, endBoss: k => boss && endBoss(k), bossBusy: () => !!boss, miniNow: () => mini, bossNow: () => boss, publicBoss, publicMini };
};
