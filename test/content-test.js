// Content update tests: shard currency + migration, achievements + titles, daily quests, mini-events, boss.
//   node test/content-test.js            (own servers on :3131 / :3132, test hooks on)
'use strict';
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const G = require('../public/shared.js'), C = require('../public/content.js');
const ROOT = path.join(__dirname, '..'), PASS = 'test-pass-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passes = 0, failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else { failures++; process.exitCode = 1; } };
const rnd = () => crypto.randomInt(1000, 9999);
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); } return fn(); };
const ONLY = (process.env.CT_ONLY || '').split(',').filter(Boolean), want = k => !ONLY.length || ONLY.includes(k);

async function startServer(port, env) {
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATABASE_URL: '', OCS_TEST_HOOKS: '1', OBSTACLES: '0', OCS_WEEKEND: 'off', EVENTS_ENABLED: '0' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch (_) { /* wait */ } await sleep(150); }
  return { url: `http://localhost:${port}`, log: () => log, stop: () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); }) };
}
function client(url) {
  const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c = { s, id: null, pos: null, orbs: new Map(), profile: null, seq: 0, got: [], metas: new Map(), chat: [] };
  s.onAny((ev, d) => c.got.push([ev, d, Date.now()]));
  s.on('s', st => { for (const [id, x, y] of st.p) if (id === c.id) c.pos = { x, y }; for (const [id, x, y, t, e] of st.oa) c.orbs.set(id, { id, x, y, t, e }); for (const [id] of st.od) c.orbs.delete(id); c.bs = st.bs || null; });
  s.on('bal', b => { if (c.profile) { c.profile.balance = b.b; c.profile.total = b.t; } });
  s.on('profile', p => { c.profile = p; });
  s.on('pjoin', p => c.metas.set(p.id, p)); s.on('pmeta', p => c.metas.set(p.id, p)); s.on('chat', m => c.chat.push(m));
  s.on('sping', v => s.emit('spong', v));
  c.ready = new Promise(r => s.on('connect', r));
  c.call = (ev, ...a) => new Promise(res => { const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 10000); s.emit(ev, ...a, r => { clearTimeout(t); res(r); }); });
  c.emit = async (ev, ...a) => { const r = await c.call(ev, ...a); if (r && r.profile) c.profile = r.profile; return r; };
  c.enter = r => { if (r && r.ok && r.you) { c.id = r.you; c.profile = r.profile; c.join = r; for (const o of r.orbs) c.orbs.set(o[0], { id: o[0], x: o[1], y: o[2], t: o[3] }); for (const p of r.players) { c.metas.set(p.id, p); if (p.id === r.you) c.pos = { x: p.x, y: p.y }; } } return r; };
  c.register = async (name, enter = true) => { await c.ready; return c.enter(await c.call('auth', { mode: 'register', name, password: PASS, confirm: PASS, enter })); };
  c.login = async name => { await c.ready; return c.enter(await c.call('auth', { mode: 'login', name, password: PASS })); };
  c.moveTo = async (x, y, ms = 8000, stop = 6) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!c.pos) { await sleep(50); continue; } const dx = x - c.pos.x, dy = y - c.pos.y, l = Math.hypot(dx, dy); if (l < stop) return true; s.emit('input', { s: ++c.seq, x: dx / l, y: dy / l }); await sleep(50); } return false; };
  c.hold = async (x, y, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (c.pos) { const dx = x - c.pos.x, dy = y - c.pos.y, l = Math.hypot(dx, dy) || 1; s.emit('input', { s: ++c.seq, x: dx / l, y: dy / l }); } await sleep(50); } };
  c.events = ev => c.got.filter(g => g[0] === ev).map(g => g[1]);
  c.close = () => s.close();
  return c;
}

async function shardSuite(url) {
  console.log('--- shards are a currency');
  const A = client(url); await A.register('Shd' + rnd());
  ok(A.profile.shards === 0 && !A.profile.inventory.some(s => s.id === G.SHARD_ID), 'new account: shard balance 0, no shard items');
  let r = await A.emit('test:grant', { id: G.SHARD_ID, qty: 7, source: 'event' });
  ok(r.ok && A.profile.shards === 7 && !A.profile.inventory.some(s => s.id === G.SHARD_ID) && A.profile.used === 0, `granting shards adds to the balance (${A.profile.shards}), inventory stays empty`);
  r = await A.emit('shard:exchange', 3);
  ok(r.ok && A.profile.shards === 4 && r.orbs === 3 * G.SHARD_EXCHANGE.orbs, `exchange spends from the balance: 7 → ${A.profile.shards}, +${r.orbs} orbs`);
  const ex = G.ITEMS.find(i => i.exclusive && i.shardPrice > 0);
  r = await A.emit('shard:buy', ex.id, 1);
  ok(!r.ok && r.code === 'shards' && A.profile.shards === 4, `not enough shards for «${ex.name}» (${ex.shardPrice}) → refused, balance unchanged`);
  await A.emit('test:grant', { id: G.SHARD_ID, qty: ex.shardPrice, source: 'admin' });
  r = await A.emit('shard:buy', ex.id, 1);
  ok(r.ok && A.profile.shards === 4 && A.profile.inventory.some(s => s.id === ex.id), `shard shop buys «${ex.name}» from the balance (back to ${A.profile.shards})`);
  r = await A.emit('code:redeem', 'SHARDY');
  ok(r.ok && A.profile.shards === 6, `promo code shards go to the balance (${A.profile.shards})`);
  await A.emit('test:spawn', { types: ['l'], ring: 1, x: A.pos.x + 30, y: A.pos.y });
  await A.hold(A.pos.x + 30, A.pos.y, 900);
  ok(A.profile.shards === 8 && A.events('ach').some(a => a.id === 'legend'), `legendary orb shard (+1) and «Легенда» achievement (+1) go to the balance (${A.profile.shards})`);
  A.close();
}
async function migrationSuite() {
  console.log('--- shard migration (one-time, nothing lost)');
  const file = path.join(os.tmpdir(), `ocs-ct-mig-${process.pid}.json`), now = Date.now(), hash = bcrypt.hashSync(PASS, 4);
  const rec = (name, slots, stats) => ({ key: name.toLowerCase(), name, passHash: hash, balance: 10, total: 10, inventory: { v: 1, slots }, owned: [], equipped: {}, upgrades: {}, stats: Object.assign({ upgradeRefundV1: true }, stats), createdAt: now, lastSeen: now, codes: [] });
  const data = { version: 2, sessions: {}, accounts: {
    oldshard: rec('OldShard', [{ id: G.SHARD_ID, q: 99, src: 'arena', at: now }, { id: 'c_lime', q: 1, src: 'shop', at: now }, { id: G.SHARD_ID, q: 13, src: 'event', at: now }], {}),
    mixed: rec('Mixed', [{ id: G.SHARD_ID, q: 5, src: 'event', at: now }], { shards: 4 }),
    done: rec('Done', [], { shards: 9, shardMigrationV1: true }) } };
  fs.writeFileSync(file, JSON.stringify(data));
  let srv = await startServer(3132, { DATA_FILE: file });
  const A = client(srv.url); await A.login('OldShard');
  ok(A.profile && A.profile.shards === 112 && !A.profile.inventory.some(s => s.id === G.SHARD_ID) && A.profile.inventory.some(s => s.id === 'c_lime') && A.profile.stats.shardMigrationV1 === true, `99 + 13 shard items → balance ${A.profile && A.profile.shards}, removed from the inventory, other items kept`);
  const B = client(srv.url); await B.login('Mixed');
  ok(B.profile && B.profile.shards === 9, `partly-balance account unified: 4 + 5 = ${B.profile && B.profile.shards}`);
  const D = client(srv.url); await D.login('Done');
  ok(D.profile && D.profile.shards === 9, 'already-migrated account untouched');
  const sp = await A.emit('shard:exchange', 12);
  ok(sp.ok && A.profile.shards === 100, `migrated shards can be spent (112 − 12 = ${A.profile.shards})`);
  A.close(); B.close(); D.close(); await sleep(300); await srv.stop();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).accounts.oldshard;
  ok(disk.stats.shards === 100 && disk.stats.shardMigrationV1 && !disk.inventory.slots.some(s => s.id === G.SHARD_ID), 'persisted: balance 100, flag set, no shard items on disk');
  srv = await startServer(3132, { DATA_FILE: file }); const A2 = client(srv.url); await A2.login('OldShard');
  ok(A2.profile && A2.profile.shards === 100, 'restart: migration not applied twice');
  A2.close(); await srv.stop(); fs.rmSync(file, { force: true });
}
async function achSuite(url) {
  console.log('--- achievements + titles');
  ok(C.ACH.length >= 15 && C.ACH.length <= 20 && C.ACH.filter(a => a.title).length >= 10 && new Set(C.ACH.map(a => a.id)).size === C.ACH.length, `${C.ACH.length} achievements, ${C.ACH.filter(a => a.title).length} with a title`);
  const name = 'Ach' + rnd(), A = client(url); await A.register(name, false); // lobby only
  await A.emit('test:stats', { minigames: 30, unlockedDoor2: true });
  ok(!(A.profile.stats.ach && A.profile.stats.ach.games), 'lobby: nothing unlocked until the arena');
  const b0 = A.profile.balance; A.enter(await A.call('play', null));
  await waitFor(() => A.events('ach').length >= 2, 3000);
  const ids = A.events('ach').map(a => a.id);
  ok(ids.includes('games') && ids.includes('zone2') && A.profile.stats.ach.games && A.profile.balance >= b0 + 200, `backfill on join from existing stats: ${ids.join(', ')} (+${A.profile.balance - b0} orbs)`);
  await A.emit('test:stats', { total: 150 }); await waitFor(() => A.events('ach').some(a => a.id === 'first100'), 2000);
  ok(A.events('ach').some(a => a.id === 'first100' && a.reward.orbs === 20), 'unlock while playing: «Первые шаги» +20 orbs, toast event');
  const n = A.events('ach').length; await A.emit('test:stats', { minigames: 31 }); await sleep(1300);
  ok(A.events('ach').length === n, 'each achievement is paid once');
  const B = client(url); await B.register('Obs' + rnd());
  let r = await A.emit('title:set', 'magnate');
  ok(!r.ok, 'an unearned title is refused');
  r = await A.emit('title:set', 'games');
  await waitFor(() => { const m = B.metas.get(A.id); return m && m.ti; }, 2000);
  ok(r.ok && r.profile.title === 'Игрок' && B.metas.get(A.id).ti === 'Игрок', 'title «Игрок» set: in own profile and in the public player data');
  await A.call('chat', 'привет'); await waitFor(() => B.chat.some(m => m.n === name), 2000);
  ok(B.chat.some(m => m.n === name && m.ti === 'Игрок'), 'chat messages carry the title');
  r = await A.emit('title:set', null); ok(r.ok && !r.profile.title, 'title can be cleared');
  A.close(); B.close();
}
async function questSuite(url) {
  console.log('--- daily quests');
  const A = client(url); await A.register('Qst' + rnd());
  const d = A.profile.stats.daily;
  ok(d && d.day === C.dayKey() && d.q.length === 3 && new Set(d.q.map(q => C.QUEST_BY_ID[q.id].kind)).size === 3, `3 quests for today: ${d && d.q.map(q => q.id + ' → ' + C.rewardText(q.rw)).join(' | ')}`);
  const kinds = new Set(); for (let i = 0; i < 300; i++) for (const q of C.rollQuests(Math.random, { door: true })) kinds.add(Object.keys(q.rw)[0] === 'min' ? 'boost' : Object.keys(q.rw).find(k => k !== 'min'));
  ok(['orbs', 'shards', 'boost', 'item'].every(k => kinds.has(k)), `varied rewards: ${Array.from(kinds).join(', ')}`);
  const resetH = C.resetIn(Date.parse('2026-10-16T20:59:00Z')) / 60000;
  ok(Math.abs(resetH - 1) < 1e-9 && C.dayKey(Date.parse('2026-10-16T20:59:59Z')) + 1 === C.dayKey(Date.parse('2026-10-16T21:00:00Z')), 'reset at 00:00 Moscow time (21:00 UTC)');
  await A.emit('test:stats', { quests: [{ id: 'orbs300', rw: { boost: 'orbs', min: 5 } }, { id: 'mg2', rw: { shards: 1 } }, { id: 'rare10', rw: { item: 'c_coral' } }], streak: 3, streakDay: C.dayKey() - 1 });
  // mini-games: 2 quick reaction games (clicked early = finished)
  const sh0 = A.profile.shards;
  await A.emit('test:tp', { x: A.pos.x, y: A.pos.y, orbs: 500 });
  for (let i = 0; i < 2; i++) { const s = await A.call('mg:start', i ? 'shell' : 'reaction'); if (s.ok && !i) A.s.emit('mg:reaction:click'); await sleep(400); }
  // shell may still be running: pick a cup after the shuffle
  await sleep(G.MINIGAMES.shell.swaps * 400 + 2500); await A.call('mg:act', { cup: 0 }); await sleep(500);
  ok(A.profile.stats.daily.q.find(q => q.id === 'mg2').done && A.profile.shards === sh0 + 1, `«Сыграйте 2 мини-игры» done → +1 shard (${sh0} → ${A.profile.shards})`);
  // rare orbs
  for (let i = 0; i < 10; i++) { await A.emit('test:spawn', { types: ['r'], ring: 1, x: A.pos.x + 40, y: A.pos.y }); await A.hold(A.pos.x + 40, A.pos.y, 350); }
  await waitFor(() => A.profile.stats.daily.q.find(q => q.id === 'rare10').done, 2000);
  ok(A.profile.stats.daily.q.find(q => q.id === 'rare10').done && A.profile.inventory.some(s => s.id === 'c_coral'), '«10 редких сфер» done → cosmetic «Коралловый» granted via grantItem');
  // orbs: spawn epics until 300 value; with the ×1.5 boost not yet active
  let guard = 0;
  while (!A.profile.stats.daily.q.find(q => q.id === 'orbs300').done && guard++ < 40) { await A.emit('test:spawn', { types: ['e', 'e', 'e'], ring: 40, x: A.pos.x, y: A.pos.y }); await A.hold(A.pos.x + 1, A.pos.y, 450); }
  await sleep(500);
  const st = A.profile.stats, qa = A.events('quest').find(q => q.all);
  ok(st.daily.q.every(q => q.done) && st.boosts && st.boosts.orbs > Date.now() + 4 * 60000, '«300 сфер» done → boost «Сферы ×1.5» for 5 min');
  ok(qa && qa.streak === 4 && qa.reward.orbs === C.allDoneBonus(4).orbs && qa.reward.shards === 1 && st.streak === 4 && st.bestStreak === 4, `all 3 done → bonus ${qa && qa.reward.orbs} orbs + 1 shard, streak 3 → ${st.streak}`);
  // boost effect: an epic orb (+10) now gives 15
  await A.emit('test:tp', { x: 4000, y: 4000 }); await sleep(400);
  const b0 = A.profile.balance; await A.emit('test:spawn', { types: ['e'], ring: 1, x: A.pos.x + 40, y: A.pos.y }); await A.hold(A.pos.x + 40, A.pos.y, 700);
  ok(A.profile.balance - b0 === 15, `boost active: epic orb +${A.profile.balance - b0} (10 × 1.5)`);
  // new day → new quests, streak kept if yesterday was complete
  await A.emit('test:stats', { dayShift: -1 }); await sleep(1300);
  ok(A.profile.stats.daily.day === C.dayKey() && A.profile.stats.daily.q.every(q => !q.done) && A.profile.stats.streak === 4, 'next day: 3 fresh quests, streak kept');
  await A.emit('test:stats', { streakDay: C.dayKey() - 3, dayShift: -1 }); await sleep(1300);
  ok(A.profile.stats.streak === 0, 'a missed day resets the streak');
  A.close();
}
async function miniSuite(url) {
  console.log('--- mini-events');
  const A = client(url); await A.register('Mini' + rnd());
  await A.emit('test:tp', { x: 2000, y: 2000 }); await sleep(200);
  let r = await A.emit('test:mini', { kind: 'goldrain', x: 2600, y: 2000, durationMs: 3000 });
  await sleep(300);
  const gold = Array.from(A.orbs.values()).filter(o => o.e && Math.hypot(o.x - 2600, o.y - 2000) <= C.MINI.goldrain.radius + 2);
  const val = gold.reduce((n, o) => n + G.ORB_TYPES[o.t].value, 0);
  ok(r.ok && r.mini.kind === 'goldrain' && gold.length >= 18 && gold.every(o => 'ure'.includes(o.t)) && val >= 60 && val <= 160, `«Золотой дождь»: ${gold.length} valuable orbs worth ${val} in one spot (≈ ${Math.round(val / 100 * 60)} s of farming)`);
  await sleep(3200);
  ok(gold.every(o => !A.orbs.has(o.id)) && A.events('mini:end').length === 1, 'leftovers vanish when it ends');
  // chest solo (8 s)
  const b0 = A.profile.balance, s0 = A.profile.shards, t0 = Date.now();
  await A.emit('test:mini', { kind: 'chest', x: 2050, y: 2000, durationMs: 20000 });
  await waitFor(() => A.events('mini:reward').length, 12000);
  const solo = Date.now() - t0;
  ok(A.events('mini:reward').length === 1 && solo >= 7800 && A.events('mini:reward')[0].reward.orbs === 100 && A.events('mini:reward')[0].reward.shards === 2 && A.profile.balance - b0 >= 100 && A.profile.shards - s0 >= 2 && A.profile.stats.chests === 1, `solo chest opened after ${(solo / 1000).toFixed(1)} s: +${A.profile.balance - b0} orbs, +${A.profile.shards - s0} shards`);
  // chest duo (3 s, split)
  const B = client(url); await B.register('Mini' + rnd()); await B.emit('test:tp', { x: 2100, y: 2050 });
  const a1 = A.profile.balance, t1 = Date.now();
  await A.emit('test:mini', { kind: 'chest', x: 2050, y: 2020, durationMs: 20000 });
  await sleep(1500);
  ok(A.events('mini').some(m => m && m.kind === 'chest' && m.near === 2 && m.need === C.MINI.chest.duoMs), 'two players near: progress shown (2 near, need 3 s)');
  await waitFor(() => B.events('mini:reward').length, 8000);
  const duo = Date.now() - t1, ra = A.events('mini:reward')[1], rb = B.events('mini:reward')[0];
  ok(ra && rb && duo < 5000 && ra.reward.orbs === 50 && rb.reward.orbs === 50 && ra.reward.shards === 1 && rb.reward.shards === 1, `duo chest opened after ${(duo / 1000).toFixed(1)} s, split: ${ra && ra.reward.orbs}+${rb && rb.reward.orbs} orbs, 1+1 shards`);
  B.close(); await sleep(300);
  // portal
  const home = { x: A.pos.x, y: A.pos.y };
  await A.emit('test:mini', { kind: 'portal', x: home.x + 80, y: home.y, durationMs: 8000 });
  for (let i = 0; i < 60 && !(A.pos.y > G.WORLD.h); i++) { A.s.emit('input', { s: ++A.seq, x: 1, y: 0 }); await sleep(50); }
  await sleep(400);
  const roomOrbs = Array.from(A.orbs.values()).filter(o => o.y > G.WORLD.h).length;
  ok(A.pos.y > G.WORLD.h && A.events('room').length === 1 && roomOrbs >= 30, `portal → bonus room (y ${Math.round(A.pos.y)}), ${roomOrbs} orbs inside`);
  const rb0 = A.profile.balance;
  const R = G.BONUS_ROOM; let k = 0;
  while (A.pos.y > G.WORLD.h && k++ < 80) { let best = null, bd = 1e9; for (const o of A.orbs.values()) if (o.y > G.WORLD.h) { const d = Math.hypot(o.x - A.pos.x, o.y - A.pos.y); if (d < bd) { bd = d; best = o; } } if (best) { const dx = best.x - A.pos.x, dy = best.y - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); } await sleep(50); }
  ok(A.pos.y <= G.WORLD.h && Math.hypot(A.pos.x - (home.x + 80), A.pos.y - home.y) < 120 && A.profile.balance > rb0 && A.profile.stats.portals === 1, `after the room time you are back where you entered (+${A.profile.balance - rb0} orbs inside), stayed within ${R.w}×${R.h}`);
  await waitFor(() => !Array.from(A.orbs.values()).some(o => o.y > G.WORLD.h), 9000);
  ok(!Array.from(A.orbs.values()).some(o => o.y > G.WORLD.h), 'room orbs cleaned up after the portal closes');
  A.close();
}
async function bossSuite(url) {
  console.log('--- boss');
  const A = client(url); await A.register('Boss' + rnd());
  await A.emit('test:tp', { x: 2000, y: 2000, orbs: 1000 }); await sleep(200);
  ok(C.bossHp(1) === 550 && C.bossHp(4) === 1300 && C.bossHp(100) === C.BOSS.hpMax, `HP scales with players: 1 → ${C.bossHp(1)}, 4 → ${C.bossHp(4)}, cap ${C.BOSS.hpMax}`);
  await A.emit('test:boss', { announceMs: 400, x: 2300, y: 2000, lifeMs: 30000 });
  const ann = A.events('boss')[0];
  await waitFor(() => A.bs, 2000);
  ok(ann && ann.phase === 'announce' && A.bs && A.bs[3] === C.bossHp(1), `announced first, then active with ${A.bs && A.bs[3]} HP (1 player)`);
  await A.emit('test:boss', { end: true }); await sleep(200);
  await A.emit('test:boss', { announceMs: 100, x: 2300, y: 2000, lifeMs: 30000, hp: 50 }); await waitFor(() => A.bs, 2000);
  const e0 = A.events('boss:end').length, t0 = Date.now(); while (A.events('boss:end').length === e0 && Date.now() - t0 < 12000) { if (A.bs) { const dx = A.bs[0] - A.pos.x, dy = A.bs[1] - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); } await sleep(50); }
  const hits = A.events('boss:hit').map(g => g), times = A.got.filter(g => g[0] === 'boss:hit').map(g => g[2]);
  const gaps = times.slice(1).map((t, i) => t - times[i]), end = A.events('boss:end')[e0];
  ok(hits.length === 5 && gaps.every(g => g >= C.BOSS.hitCooldownMs - 60), `bumping deals ${C.BOSS.hitDmg} per hit with a cooldown (gaps ${gaps.join('/')} ms)`);
  const want = C.bossReward(1, true);
  ok(end && end.killed && end.you && end.you.reward.orbs === want.orbs && end.you.reward.shards === want.shards && A.profile.stats.bossKills === 1 && A.profile.stats.bossDmg === 50, `killed: solo top damage → ${end && end.you.reward.orbs} orbs + ${end && end.you.reward.shards} shards`);
  // attacks: ring takes 3 % (cap 60) with shared immunity
  await A.emit('test:tp', { x: 2000, y: 2000 }); await sleep(200);
  const bal0 = A.profile.balance, z0 = A.events('zap').length, r0 = A.events('boss:ring').length;
  await A.emit('test:boss', { announceMs: 0, x: 2350, y: 2000, lifeMs: 12000, hp: 5000 });
  await waitFor(() => A.events('zap').slice(z0).some(z => z.src === 'boss') && A.events('boss:ring').length > r0, 11000);
  const z = A.events('zap').slice(z0).find(z => z.src === 'boss');
  ok(z && Math.abs(z.loss - C.bossPenalty(bal0)) <= 2 && z.loss <= C.BOSS.cap && A.events('boss:ring').length >= 1, `boss attack (rings ${A.events('boss:ring').length}, shots) takes ${z && z.loss} of ${bal0} (3 %, cap ${C.BOSS.cap})`);
  await waitFor(() => A.events('boss:end').length >= e0 + 2, 13000);
  const end2 = A.events('boss:end')[e0 + 1];
  ok(end2 && end2.killed === false, 'not killed in time → it leaves');
  A.close();
}
async function schedulerSuite() {
  console.log('--- schedulers (env overrides)');
  const file = path.join(os.tmpdir(), `ocs-ct-sch-${process.pid}.json`);
  const srv = await startServer(3132, { DATA_FILE: file, MINI_EVERY_MS: '1500', MINI_DURATION_MS: '2000', BOSS_EVERY_MS: '2500', BOSS_ANNOUNCE_MS: '500', BOSS_LIFE_MS: '4000', EVENT_EVERY_MS: '1000', EVENT_ANNOUNCE_MS: '300', EVENT_DURATION_MS: '1500' });
  const A = client(srv.url); await A.register('Sch' + rnd());
  await waitFor(() => A.events('mini:start').length >= 2, 9000);
  ok(A.events('mini:start').length >= 2 && A.events('mini:start').every((m, i, l) => !i || m.kind !== l[i - 1].kind), `mini-events run on their own timer: ${A.events('mini:start').map(m => m.kind).join(' → ')}`);
  await waitFor(() => A.events('boss:end').length >= 1, 15000);
  const bt = A.got.filter(g => g[0] === 'boss' && g[1] && g[1].phase === 'announce').map(g => g[2])[0], be = A.got.find(g => g[0] === 'boss:end');
  const during = A.got.filter(g => g[0] === 'ev:announce' && bt && g[2] > bt && be && g[2] < be[2]);
  ok(bt && be && during.length === 0, `boss came on its timer; no arena event announced while it was there`);
  A.close(); await srv.stop(); fs.rmSync(file, { force: true });
}

async function hitboxSuite(url) {
  console.log('--- laser / shot / ring hitbox = the ball only (not the name label)');
  const A = client(url); await A.register('Hit' + rnd());
  const P = { x: 2000, y: 2000 }, R = G.PLAYER_R;
  await A.emit('test:obstacle', { clear: true });
  await A.emit('test:tp', { x: P.x + 150, y: P.y - (R + 12) }); await sleep(150); // beam runs 32 px above the centre: through the nickname/title label, above the ball
  await A.emit('test:orbs', 500);
  let r = await A.emit('test:obstacle', { kind: 'laser', x: P.x, y: P.y, lifeMs: 20000, a0: 0, w: 0, armNow: true });
  const z0 = A.events('zap').length; await sleep(1200);
  ok(r.ok && A.events('zap').length === z0, 'static beam through the label area (32 px above the centre) → no hit');
  await A.emit('test:tp', { x: P.x + 150, y: P.y - (R + 1) }); await sleep(800);
  ok(A.events('zap').length === z0, `beam 1 px outside the ${R} px ball → no hit (no padding)`);
  await A.emit('test:tp', { x: P.x + 150, y: P.y - (R - 4) }); await sleep(800);
  ok(A.events('zap').length === z0 + 1, 'beam crossing the ball (16 px from the centre) → hit');
  await A.emit('test:obstacle', { clear: true });
  const F = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'features.js'), 'utf8'), S = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  ok(/laserHits\(o, pl\.x, pl\.y, now, G\.PLAYER_R\)/.test(S) && /G\.PLAYER_R \+ OB\.shotR\)/.test(S) && /G\.PLAYER_R \+ G\.OBSTACLES\.shotR\)/.test(F) && /B\.ringW \/ 2 \+ G\.PLAYER_R\)/.test(F),
    'robot shot, boss shot and boss ring all test against the ball radius (+ projectile / ring half-width only)');
  ok(G.laserHits({ k: 'laser', x: 0, y: 0, len: 300, w: 0, a0: 0, t0: 0, armAt: 0 }, 150, -R, 1, R) && !G.laserHits({ k: 'laser', x: 0, y: 0, len: 300, w: 0, a0: 0, t0: 0, armAt: 0 }, 150, -R - 0.5, 1, R) && !G.laserHits({ k: 'laser', x: 0, y: 0, len: 300, w: 0, a0: 0, t0: 0, armAt: 0 }, 300 + R + 1, 0, 1, R),
    'segment-to-circle distance: tangent hits, 0.5 px off misses, past the beam end misses');
}

(async () => {
  const file = path.join(os.tmpdir(), `ocs-ct-${process.pid}.json`);
  const srv = await startServer(3131, { DATA_FILE: file, MINI_ROOM_MS: '3000' });
  try {
    if (want('hitbox')) await hitboxSuite(srv.url);
    if (want('shards')) await shardSuite(srv.url);
    if (want('ach')) await achSuite(srv.url);
    if (want('quests')) await questSuite(srv.url);
    if (want('mini')) await miniSuite(srv.url);
    if (want('boss')) await bossSuite(srv.url);
  } catch (e) { ok(false, 'crash: ' + e.stack); }
  const log = srv.log(); await srv.stop(); fs.rmSync(file, { force: true });
  if (/TypeError|ReferenceError|Unhandled/.test(log)) ok(false, 'server errors: ' + log.split('\n').filter(l => /Error|Unhandled/.test(l)).slice(0, 5).join(' | '));
  if (want('migration')) await migrationSuite();
  if (want('sched')) await schedulerSuite();
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
