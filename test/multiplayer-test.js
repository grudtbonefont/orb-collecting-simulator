// Headless end-to-end tests.
//   node test/multiplayer-test.js            -> spawns its own servers on port 3101: JSON-file mode, then PostgreSQL mode
//                                               (PostgreSQL only if TEST_DATABASE_URL is set; its ocs_* tables are dropped first!)
//   node test/multiplayer-test.js <url>      -> runs the auth/chat/gameplay suite against an already running server
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const G = require('../public/shared.js');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, passes = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (cond) passes++; else { failures++; process.exitCode = 1; } };
const rnd = () => crypto.randomInt(1000, 9999);
const PASS = 'correct-horse-9';

// every socket created by the tests, every token issued, every payload received (for the privacy audit)
const allSockets = [], issuedTokens = [], received = [];

function makeClient(url) {
  const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  allSockets.push(s);
  const c = { s, id: null, pos: null, orbs: new Map(), profile: null, seq: 0, metas: new Map(), chat: [], kicked: null, token: null };
  s.onAny((ev, ...args) => received.push(ev + ' ' + JSON.stringify(args)));
  s.on('s', st => {
    for (const [id, x, y] of st.p) if (id === c.id) c.pos = { x, y };
    for (const [id, x, y, t] of st.oa) c.orbs.set(id, { id, x, y, t });
    for (const [id] of st.od) c.orbs.delete(id);
  });
  s.on('bal', b => { if (c.profile) { c.profile.balance = b.b; c.profile.total = b.t; } });
  s.on('profile', p => { c.profile = p; });
  s.on('pjoin', p => c.metas.set(p.id, p));
  s.on('pmeta', p => c.metas.set(p.id, p));
  s.on('chat', m => c.chat.push(m));
  s.on('kicked', m => { c.kicked = m; });
  s.on('sping', v => s.emit('spong', v));
  c.ready = new Promise(r => s.on('connect', r));
  c.call = (ev, arg) => new Promise(res => { const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 10000); s.emit(ev, arg, r => { clearTimeout(t); res(r); }); });
  c.entered = r => {
    if (!r || !r.ok) return r;
    if (r.token) { c.token = r.token; issuedTokens.push(r.token); }
    c.id = r.you; c.profile = r.profile; c.joinChat = r.chat;
    for (const o of r.orbs) c.orbs.set(o[0], { id: o[0], x: o[1], y: o[2], t: o[3] });
    for (const p of r.players) { c.metas.set(p.id, p); if (p.id === r.you) c.pos = { x: p.x, y: p.y }; }
    return r;
  };
  c.register = async (name, password = PASS, confirm = password) => { await c.ready; return c.entered(await c.call('auth', { mode: 'register', name, password, confirm })); };
  c.login = async (name, password = PASS) => { await c.ready; return c.entered(await c.call('auth', { mode: 'login', name, password })); };
  c.resume = async token => { await c.ready; return c.entered(await c.call('resume', { token })); };
  c.emit = async (ev, arg) => { const r = await c.call(ev, arg); if (r && r.profile) c.profile = r.profile; return r; };
  c.farm = async (target, maxMs) => { // chase nearest (valuable) orb until balance >= target
    const t0 = Date.now();
    while (c.profile.balance < target && Date.now() - t0 < maxMs) {
      let best = null, bd = Infinity;
      for (const o of c.orbs.values()) { const d = Math.hypot(o.x - c.pos.x, o.y - c.pos.y) / G.ORB_TYPES[o.t].value ** 0.5; if (d < bd) { bd = d; best = o; } }
      let dx = 0, dy = 0;
      if (best) { dx = best.x - c.pos.x; dy = best.y - c.pos.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
      s.emit('input', { s: ++c.seq, x: dx, y: dy });
      await sleep(50);
    }
  };
  c.close = () => s.close();
  return c;
}
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); } return fn(); };

// ------------------------------------------------------------------ suites
async function authSuite(URL) {
  console.log('--- accounts / auth');
  const health = await (await fetch(URL + '/api/health')).json();
  ok(health.ok && health.orbs > 0, `server health ok (storage: ${health.storage})`);
  const page = await (await fetch(URL + '/')).text();
  ok(page.includes('Регистрация') && page.includes('Вход') && page.includes('id="chat"'), 'index serves login screen + chat markup');

  const v = makeClient(URL);
  const bad = ['ab', 'a'.repeat(21), '_abc', 'abc_', 'a_b_c', 'a__b', 'Иван', 'bad name', 'bad-name', 'x<script>', 'xXFuckXx', 'Admin', 'Blyat99'];
  const badRes = [];
  for (const n of bad) badRes.push(await v.call('auth', { mode: 'register', name: n, password: PASS, confirm: PASS }));
  ok(badRes.every(r => !r.ok && r.error), 'bad nicknames rejected: ' + badRes.map((r, i) => `${bad[i]} → «${r.error}»`).slice(0, 4).join('; ') + ' …');
  v.close();
  const v2 = makeClient(URL);
  const shortPw = await v2.call('auth', { mode: 'register', name: 'Good_' + rnd(), password: '12345', confirm: '12345' });
  const mismatch = await v2.call('auth', { mode: 'register', name: 'Good_' + rnd(), password: PASS, confirm: PASS + 'x' });
  const longPw = await v2.call('auth', { mode: 'register', name: 'Good_' + rnd(), password: 'x'.repeat(73), confirm: 'x'.repeat(73) });
  ok(!shortPw.ok && !mismatch.ok && !longPw.ok, `password rules enforced: «${shortPw.error}» / «${mismatch.error}» / «${longPw.error}»`);
  const typeJunk = await v2.call('auth', { mode: 'register', name: ['x'], password: { a: 1 } });
  const typeJunk2 = await v2.call('auth', 'garbage');
  ok(!typeJunk.ok && !typeJunk2.ok, 'malformed auth payloads rejected');
  v2.close();

  const nameA = 'Alpha_' + rnd(), nameB = 'Beta' + rnd();
  const A = makeClient(URL), B = makeClient(URL);
  const ra = await A.register(nameA), rb = await B.register(nameB);
  ok(ra.ok && rb.ok && typeof ra.token === 'string' && ra.token.length === 43, `good nicknames accepted (${nameA}, ${nameB}), session token issued`);
  ok(typeof ra.you === 'number' && ra.you !== A.s.id && !('passHash' in ra.profile) && !('key' in ra.profile), 'public id is a random number, profile has no hash/key');
  await sleep(300);
  ok(B.metas.has(A.id) && A.metas.has(B.id), 'players see each other');

  const D = makeClient(URL);
  const dup = await D.register(nameA.toUpperCase());
  ok(!dup.ok && /занят/.test(dup.error), 'duplicate nickname rejected case-insensitively: ' + dup.error);
  const wrong = await D.login(nameA, 'wrong-password');
  ok(!wrong.ok && /Неверный ник или пароль/.test(wrong.error), 'wrong password rejected: ' + wrong.error);
  const unknown = await D.login('Nobody_' + rnd(), PASS);
  ok(!unknown.ok && /^Неверный ник или пароль\./.test(unknown.error), 'unknown nickname gives the same generic error: ' + unknown.error);
  D.close();

  // case-insensitive login + one connection per account (kick)
  const A2 = makeClient(URL);
  const ra2 = await A2.login(nameA.toLowerCase());
  ok(ra2.ok && ra2.profile.name === nameA, 'login is case-insensitive and keeps display case');
  await waitFor(() => A.kicked);
  ok(!!A.kicked, 'previous connection of the same account is kicked: ' + A.kicked);
  A.close();

  // session resume / logout
  const R1 = makeClient(URL);
  const res1 = await R1.resume(ra.token);
  ok(res1.ok && res1.profile.name === nameA, 'session token resume works');
  const resBad = await makeClient(URL).resume('A'.repeat(43));
  ok(!resBad.ok && resBad.expired, 'unknown token rejected');
  const lo = await R1.call('logout', {});
  ok(lo.ok, 'logout ok');
  const R2 = makeClient(URL);
  const res2 = await R2.resume(ra.token);
  ok(!res2.ok && res2.expired, 'token invalid after logout: ' + res2.error);
  R1.close(); R2.close(); A2.close();

  // lockout per nickname (fresh socket each time, so only the nickname limiter applies)
  const nameL = 'Locky' + rnd();
  const L = makeClient(URL); await L.register(nameL); L.close();
  const tries = [];
  for (let i = 0; i < 5; i++) { const c = makeClient(URL); tries.push(await c.login(nameL, 'nope-' + i)); c.close(); }
  const lc = makeClient(URL);
  const afterLock = await lc.login(nameL, PASS);
  lc.close();
  ok(tries.slice(0, 4).every(r => /Неверный/.test(r.error)) && /Слишком много/.test(tries[4].error) && !afterLock.ok && /Слишком много/.test(afterLock.error),
    'nickname locked after 5 failed logins (correct password refused during lockout): ' + afterLock.error);
  // lockout per socket
  const S = makeClient(URL); const sr = [];
  for (let i = 0; i < 6; i++) sr.push(await S.login('Ghost' + rnd(), 'whatever'));
  const sock6 = await S.login(nameB, PASS);
  ok(/Слишком много/.test(sr[4].error) && !sock6.ok && /Слишком много/.test(sock6.error), 'socket locked after 5 failed attempts: ' + sock6.error);
  S.close();
  return { B, nameB };
}

async function chatSuite(URL, ctx) {
  console.log('--- chat');
  const nameC = 'Chatty' + rnd(), nameE = 'Echo_' + rnd();
  const anon = makeClient(URL); await anon.ready;
  const anonChat = await anon.call('chat', 'hello');
  ok(!anonChat.ok && /Войдите/.test(anonChat.error), 'must be logged in to chat: ' + anonChat.error);
  await sleep(300);
  ok(!received.some(r => r.startsWith('s ')) || anon.orbs.size === 0, 'not-logged-in socket receives no game state');
  anon.close();

  const C = makeClient(URL), E = makeClient(URL);
  await C.register(nameC); await E.register(nameE);
  let wallClear = 0; C.s.on('chat:clear', () => wallClear++); // the 15-min wall-clock clear may land mid-suite
  await sleep(200);
  const r1 = await C.call('chat', 'Привет всем! <b>жирный</b>');
  const got = await waitFor(() => E.chat.find(m => m.n === nameC && /Привет/.test(m.t)));
  ok(r1.ok && got && got.t === 'Привет всем! <b>жирный</b>' && got.c === '#ffffff', `chat delivered with name + color: ${got && JSON.stringify(got)}`);
  const r2 = await C.call('chat', 'второе сразу');
  ok(!r2.ok && /Не так быстро/.test(r2.error), 'rate limit: 2nd message within 1.5 s rejected: ' + r2.error);
  await sleep(1600);
  const r3 = await C.call('chat', 'мой ip 192.168.1.10, заходи на https://evil.example/x или evil.ru, почта a@b.com');
  const masked = await waitFor(() => E.chat.find(m => m.n === nameC && /мой ip/.test(m.t)));
  ok(r3.ok && masked && !/192\.168|evil|a@b/.test(masked.t) && /\*\*\*/.test(masked.t), 'URL / IP / e-mail masked: ' + (masked && masked.t));
  await sleep(1600);
  await C.call('chat', 'what the fuck, сука');
  const prof = await waitFor(() => E.chat.find(m => m.n === nameC && /what/.test(m.t)));
  ok(prof && !/fuck|сука/i.test(prof.t), 'profanity masked: ' + (prof && prof.t));
  await sleep(1600);
  await C.call('chat', 'аааааааааааааааа!!!!!!!!!!\u202Eспам');
  const spam = await waitFor(() => E.chat.find(m => m.n === nameC && /ааа/.test(m.t)));
  ok(spam && spam.t === 'ааа!!! спам', 'repeated characters collapsed, control/bidi chars stripped: ' + (spam && spam.t));
  // 5 per 10 s: four messages were accepted in the last ~5 s, the 5th is accepted, the 6th is refused
  await sleep(1600);
  const r5 = await C.call('chat', 'пятое');
  await sleep(1600);
  const r6 = await C.call('chat', 'шестое');
  ok(r5.ok && !r6.ok && /Слишком много/.test(r6.error), 'rate limit: max 5 messages per 10 s: ' + r6.error);
  const tooLong = await E.call('chat', 'x'.repeat(121));
  ok(!tooLong.ok, 'message over 120 chars rejected: ' + tooLong.error);
  const nonString = await E.call('chat', { t: 'x' });
  ok(!nonString.ok, 'non-string chat payload rejected');
  const sysMsg = C.chat.find(m => m.sys && m.t.includes(nameE));
  ok(!!sysMsg, 'system join message shown: ' + (sysMsg && sysMsg.t));
  const F = makeClient(URL);
  const rf = await F.register('Late' + rnd());
  ok(rf.ok && (rf.chat.some(m => m.n === nameC && /Привет/.test(m.t)) || wallClear > 0),
    `chat history sent on join (${rf.chat.length} messages${wallClear ? ', a scheduled clear happened mid-suite' : ''})`);
  F.close(); C.close(); E.close();
}

// ------------------------------------------------------------------ profile screen
async function profileSuite(URL) {
  console.log('--- profile');
  const nobody = makeClient(URL); await nobody.ready;
  const pg0 = await nobody.call('profile:get', null);
  const play0 = await nobody.call('play', null);
  ok(!pg0.ok && !play0.ok && play0.expired, 'profile / play need a login: ' + pg0.error);
  nobody.close();

  const name = 'Prof_' + rnd();
  const L = makeClient(URL); await L.ready;
  const r = await L.call('auth', { mode: 'register', name, password: PASS, confirm: PASS, enter: false });
  if (r && r.token) issuedTokens.push(r.token);
  ok(r.ok && r.token && r.profile && r.you === undefined && !r.orbs, 'auth with enter:false returns token + profile but does not enter the arena');
  const p = r.profile || {};
  const want = ['name', 'balance', 'total', 'equipped', 'upgrades', 'stats', 'inventory', 'slots', 'createdAt', 'rank', 'playMs', 'items', 'slotsUsed', 'inArena'];
  ok(want.every(k => k in p) && p.name === name && p.slots === G.INV_SLOTS && p.rank === null && p.items === 0 && Math.abs(p.createdAt - Date.now()) < 60000,
    `profile summary has ${want.length} fields (rank ${p.rank}, slots ${p.slots}, created ${new Date(p.createdAt).toISOString()})`);
  ok(!['passHash', 'key', 'token', 'sessionHash', 'owned', 'lastSeen'].some(k => k in p), 'profile summary has no hash / key / token / internal fields');
  await sleep(400);
  ok(!received.some(x => x.startsWith('s ')) || L.orbs.size === 0, 'lobby (profile screen) socket gets no arena state');
  const pl = await L.call('play', null);
  L.entered(pl);
  ok(pl.ok && typeof pl.you === 'number' && pl.orbs.length > 0 && !('chatNextClear' in pl), 'Играть → enters the arena (no chat-clear schedule sent)');
  const pl2 = await L.call('play', null);
  ok(!pl2.ok, 'second play refused: ' + pl2.error);
  await L.farm(5, 30000);
  await sleep(700);
  const pgr = await L.call('profile:get', null);
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${name}`)).json();
  ok(pgr.ok && pgr.profile.total === L.profile.total && pgr.profile.rank === lb.me.rank && pgr.profile.stats.sessions === 1 && pgr.profile.inArena && pgr.profile.playMs > 0,
    `in-game profile: total ${pgr.profile.total}, rank #${pgr.profile.rank} (= leaderboard), sessions ${pgr.profile.stats.sessions}, play ${pgr.profile.playMs} ms`);
  const fast = await L.call('profile:get', null);
  ok(!fast.ok, 'profile:get is throttled');
  L.close();
  await sleep(300);
  // fresh page load with the saved token: 'session' shows the profile, play time + session count persisted
  const S = makeClient(URL); await S.ready;
  const ss = await S.call('session', { token: r.token });
  ok(ss.ok && ss.profile.name === name && ss.profile.stats.sessions === 1 && ss.profile.playMs >= pgr.profile.playMs && !ss.profile.inArena && ss.you === undefined,
    `saved session → profile screen (play time ${ss.profile.playMs} ms, sessions ${ss.profile.stats.sessions})`);
  const bad = await makeClient(URL).call('session', { token: 'B'.repeat(43) });
  ok(!bad.ok && bad.expired, 'unknown token on profile screen → back to login');
  S.close();
}

// ------------------------------------------------------------------ shop + inventory (needs OCS_TEST_HOOKS=1)
function priceSanity() {
  console.log('--- economy');
  const sold = G.ITEMS.filter(i => i.price > 0);
  const byR = r => sold.filter(i => i.rarity === r).map(i => i.price);
  const RATE = 80; // measured orbs/min of a greedy bot without upgrades (see README)
  ok(Math.max(...byR('common')) <= 600 && Math.min(...byR('common')) >= 100, `common items ${Math.min(...byR('common'))}–${Math.max(...byR('common'))} (≈${(Math.min(...byR('common')) / RATE).toFixed(1)}–${(Math.max(...byR('common')) / RATE).toFixed(1)} min)`);
  ok(Math.min(...byR('epic')) >= 15 * RATE * 0.8 && Math.max(...byR('epic')) <= 60 * RATE, `epic items ${Math.min(...byR('epic'))}–${Math.max(...byR('epic'))} (≈${Math.round(Math.min(...byR('epic')) / RATE)}–${Math.round(Math.max(...byR('epic')) / RATE)} min)`);
  ok(Math.min(...byR('legendary')) >= 100 * RATE, `legendary items ${Math.min(...byR('legendary'))}–${Math.max(...byR('legendary'))} (≈${(Math.min(...byR('legendary')) / RATE / 60).toFixed(1)}–${(Math.max(...byR('legendary')) / RATE / 60).toFixed(1)} h)`);
  const rank = { common: 0, rare: 1, epic: 2, legendary: 3 };
  ok(G.CATEGORIES.every(c => { const l = sold.filter(i => i.cat === c.key).sort((x, y) => x.price - y.price); return l.every((it, i) => !i || rank[it.rarity] >= rank[l[i - 1].rarity]); }), 'within each category price never decreases with rarity');
  ok(Object.values(G.UPGRADES).every(u => u.prices.every((v, i) => !i || v > u.prices[i - 1])), 'upgrade prices strictly increase per level');
  // mini-games must earn less per minute than farming
  const rush = G.MINIGAMES.rush, re = G.MINIGAMES.reaction;
  const rushPerMin = (G.rushPrize(1e9) - rush.fee) / ((rush.duration + rush.cooldownMs) / 60000);
  const reactPerMin = (G.REACTION_PRIZES[0][1] - re.fee) / ((2500 + re.cooldownMs) / 60000);
  ok(rushPerMin < RATE * 0.5 && reactPerMin < RATE * 0.5, `perfect play nets at most ${rushPerMin.toFixed(0)} (rush) / ${reactPerMin.toFixed(0)} (reaction) orbs/min, farming ≈${RATE}`);
  ok(G.rushPrize(20) === 15 && G.rushPrize(100) === rush.maxPrize && G.rushPrize(-5) === 0, `rush payout 75% capped at ${rush.maxPrize}`);
}

async function shopInventorySuite(URL) {
  console.log('--- shop + inventory');
  const shop = await (await fetch(URL + '/api/shop')).json();
  ok(shop.items.find(i => i.id === 'c_coral').price === G.ITEM_BY_ID.c_coral.price && shop.minigames.rush.maxPrize === G.MINIGAMES.rush.maxPrize, '/api/shop serves the same price list as the client');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('Shopper' + rnd()); await B.register('Watcher' + rnd());
  let foreignProfiles = 0;
  B.s.on('profile', p => { if (p.name !== B.profile.name) foreignProfiles++; });
  await sleep(300);
  // real collection still works
  await A.farm(3, 30000);
  ok(A.profile.balance >= 3, `A collected orbs (${A.profile.balance})`);
  const poor = await B.emit('buy', 'c_coral');
  ok(!poor.ok && /Не хватает/.test(poor.error), 'cannot buy without enough orbs: ' + poor.error);
  await A.emit('test:orbs', 100000);
  const bal0 = A.profile.balance;
  const b1 = await A.emit('buy', 'c_coral');
  const slot = b1.profile && b1.profile.inventory.find(x => x.id === 'c_coral');
  ok(b1.ok && b1.profile.balance === bal0 - G.ITEM_BY_ID.c_coral.price && slot && slot.q === 1 && slot.src === 'shop', `buy c_coral: −${G.ITEM_BY_ID.c_coral.price}, item in inventory with source "shop"`);
  ok(b1.profile.equipped.color === 'c_cyan', 'buying does not auto-equip (shop only sells)');
  const b2 = await A.emit('buy', 'c_coral');
  ok(!b2.ok && b2.code === 'owned', 'cosmetics are unique: second purchase refused: ' + b2.error);
  const free = await A.emit('buy', 'c_cyan'), shard = await A.emit('buy', 'x_legend_shard'), proto = await A.emit('buy', '__proto__');
  ok(!free.ok && !shard.ok && !proto.ok, 'free/base items, non-shop items and junk ids cannot be bought');
  const e1 = await A.emit('inv:equip', 'c_coral');
  ok(e1.ok && e1.profile.equipped.color === 'c_coral', 'equip from inventory');
  await sleep(200);
  ok(B.metas.get(A.id) && B.metas.get(A.id).eq.color === 'c_coral', 'other players see the equipped item');
  const e2 = await A.emit('inv:equip', 'h_crown'), e3 = await A.emit('inv:equip', 'x_legend_shard'), e4 = await A.emit('inv:equip', { id: 'c_coral' });
  ok(!e2.ok && !e3.ok && !e4.ok, `cannot equip unowned / non-cosmetic / malformed: «${e2.error}» «${e3.error}»`);
  const e5 = await A.emit('equip', 'c_cyan');
  ok(e5.ok && e5.profile.equipped.color === 'c_cyan', 'base (free) items are always equippable');
  await A.emit('inv:equip', 'c_coral');
  const u1 = await A.emit('inv:unequip', 'color'), u2 = await A.emit('inv:unequip', 'nope');
  ok(u1.ok && u1.profile.equipped.color === 'c_cyan' && u1.profile.inventory.some(x => x.id === 'c_coral') && !u2.ok, 'unequip returns to the default look, item stays in inventory');
  // stacking
  const g1 = await A.emit('test:grant', { id: 'x_legend_shard', qty: 150, source: 'event' });
  const st = A.profile.inventory.filter(x => x.id === 'x_legend_shard').map(x => x.q);
  ok(g1.ok && st.join(',') === '99,51', `stackable items: 150 shards → slots [${st}] (max ${G.ITEM_BY_ID.x_legend_shard.maxStack} per slot)`);
  await A.emit('test:grant', { id: 'x_legend_shard', qty: 48, source: 'event' });
  const st2 = A.profile.inventory.filter(x => x.id === 'x_legend_shard').map(x => x.q);
  ok(st2.join(',') === '99,99', `partial stack topped up first → [${st2}]`);
  // fill up to 100 slots
  const used = A.profile.inventory.length, freeSlots = G.INV_SLOTS - used;
  const g2 = await A.emit('test:grant', { id: 'x_legend_shard', qty: freeSlots * 99, source: 'event' });
  ok(g2.ok && A.profile.inventory.length === G.INV_SLOTS, `inventory filled to ${A.profile.inventory.length}/${G.INV_SLOTS} slots`);
  const g3 = await A.emit('test:grant', { id: 'x_legend_shard', qty: 1, source: 'event' });
  ok(!g3.ok && g3.code === 'full', 'grant refused when full: ' + g3.error);
  const balF = A.profile.balance;
  const bf = await A.emit('buy', 'c_lime');
  ok(!bf.ok && bf.code === 'full' && /Инвентарь полон/.test(bf.error) && A.profile.balance === balF, 'buying with a full inventory refused, no orbs taken: ' + bf.error);
  const lastShard = A.profile.inventory.length - 1;
  const tf = await A.emit('inv:trash', { id: 'x_legend_shard', qty: 99, slot: lastShard });
  const bf2 = await A.emit('buy', 'c_lime');
  ok(tf.ok && tf.profile.inventory.length === G.INV_SLOTS - 1 && bf2.ok && A.profile.inventory.length === G.INV_SLOTS, 'trashing a stack frees a slot; the purchase then succeeds');
  const g4 = await A.emit('test:grant', { id: 'c_coral', qty: 1, source: 'nope' }), g5 = await A.emit('test:grant', { id: 'x_legend_shard', qty: -3 });
  ok(!g4.ok && !g5.ok, 'grantItem validates source and quantity');
  // upgrades
  const up = await A.emit('upgrade', 'magnet');
  ok(up.ok && up.profile.upgrades.magnet === 1, `magnet upgrade lvl 1 for ${G.UPGRADES.magnet.prices[0]}`);
  ok(foreignProfiles === 0, 'players never receive another player\'s profile');
  A.close(); B.close();
}

async function trashSuite(URL) {
  console.log('--- inventory trash');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('Trash' + rnd()); await B.register('Look' + rnd());
  await sleep(200);
  await A.emit('test:orbs', 50000);
  const nobody = makeClient(URL); await nobody.ready;
  ok(!(await nobody.call('inv:trash', { id: 'c_coral', qty: 1 })).ok, 'trash needs a login');
  nobody.close();
  // unique item: deleted, no refund, can be bought again
  await A.emit('buy', 'c_coral');
  const bal = A.profile.balance;
  const t1 = await A.emit('inv:trash', { id: 'c_coral', qty: 1 });
  ok(t1.ok && !t1.profile.inventory.some(x => x.id === 'c_coral') && t1.profile.balance === bal && t1.left === 0, 'unique item trashed, no refund');
  const rb = await A.emit('buy', 'c_coral');
  ok(rb.ok && rb.profile.balance === bal - G.ITEM_BY_ID.c_coral.price && rb.profile.inventory.some(x => x.id === 'c_coral'), 'trashed shop item can be bought again');
  // equipped item: reverts to the free default, others see it
  await A.emit('buy', 'h_tophat'); await A.emit('inv:equip', 'h_tophat');
  await sleep(200);
  ok(B.metas.get(A.id).eq.hat === 'h_tophat', 'B sees the equipped hat');
  const t2 = await A.emit('inv:trash', { id: 'h_tophat', qty: 1 });
  await sleep(250);
  ok(t2.ok && t2.unequipped && t2.profile.equipped.hat === G.DEFAULT_EQUIPPED.hat && B.metas.get(A.id).eq.hat === G.DEFAULT_EQUIPPED.hat, 'trashing an equipped item unequips it (back to the default) for everyone');
  const eqGone = await A.emit('inv:equip', 'h_tophat');
  ok(!eqGone.ok, 'trashed item can no longer be equipped');
  // stacks
  await A.emit('test:grant', { id: 'x_legend_shard', qty: 150, source: 'event' });
  const idx = () => A.profile.inventory.map((x, i) => [x, i]).filter(([x]) => x.id === 'x_legend_shard');
  const [[, i99], [, i51]] = idx();
  const t3 = await A.emit('inv:trash', { id: 'x_legend_shard', qty: 11, slot: i51 });
  ok(t3.ok && idx().map(([x]) => x.q).join(',') === '99,40' && t3.left === 139, `partial stack trash: 51 → 40 (left ${t3.left})`);
  const slotsBefore = A.profile.inventory.length;
  const t4 = await A.emit('inv:trash', { id: 'x_legend_shard', qty: 99, slot: i99 });
  ok(t4.ok && idx().map(([x]) => x.q).join(',') === '40' && A.profile.inventory.length === slotsBefore - 1, 'whole stack trashed → slot freed');
  const t5 = await A.emit('inv:trash', { id: 'x_legend_shard', qty: 5 });
  ok(t5.ok && t5.left === 35, 'trash by item id (no slot) takes from the stacks');
  // invalid requests
  const bad = [
    ['default item', { id: 'c_cyan', qty: 1 }], ['unowned', { id: 'h_crown', qty: 1 }], ['unknown id', { id: 'zz_nope', qty: 1 }], ['__proto__', { id: '__proto__', qty: 1 }],
    ['qty 0', { id: 'x_legend_shard', qty: 0 }], ['qty -1', { id: 'x_legend_shard', qty: -1 }], ['qty 1.5', { id: 'x_legend_shard', qty: 1.5 }], ['qty "3"', { id: 'x_legend_shard', qty: '3' }],
    ['more than owned', { id: 'x_legend_shard', qty: 36 }], ['more than in slot', { id: 'x_legend_shard', qty: 41, slot: idx()[0][1] }],
    ['wrong slot', { id: 'x_legend_shard', qty: 1, slot: 0 }], ['slot out of range', { id: 'x_legend_shard', qty: 1, slot: 999 }],
    ['qty 2 of a unique', { id: 'c_coral', qty: 2 }], ['not an object', 'c_coral'],
  ];
  const res = [];
  await sleep(5100);
  for (const [label, d] of bad) { res.push([label, await A.emit('inv:trash', d)]); await sleep(750); } // stay under the rate limit
  ok(res.every(([, r]) => !r.ok) && A.profile.inventory.some(x => x.id === 'c_coral') && idx().map(([x]) => x.q).join(',') === '35',
    'refused, nothing removed: ' + res.map(([l, r]) => `${l} → «${r.error}»`).join('; '));
  ok(/Базовые/.test(res[0][1].error), 'default (free) items cannot be deleted: ' + res[0][1].error);
  // rate limit
  await sleep(5100);
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(A.emit('inv:trash', { id: 'x_legend_shard', qty: 1 }));
  const br = await Promise.all(burst);
  ok(br.filter(r => r.ok).length === 8 && br.filter(r => r.code === 'rate').length === 2, `rate-limited: 8 deletions per 5 s (${br.filter(r => r.code === 'rate').length} refused)`);
  A.close(); B.close();
}

async function minigameSuite(URL) {
  console.log('--- mini-games');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('Gamer' + rnd()); await B.register('Player' + rnd());
  await A.emit('test:orbs', 500); await B.emit('test:orbs', 500);
  const balR = A.profile.balance;
  const res = new Promise(r => A.s.once('mg:result', r));
  A.s.once('mg:reaction:go', () => setTimeout(() => A.s.emit('mg:reaction:click'), 150));
  ok((await A.emit('mg:start', 'reaction')).ok, 'reaction mini-game started');
  const rr = await res; await sleep(200);
  const expected = (G.REACTION_PRIZES.find(([ms]) => rr.rt < ms) || [0, 0])[1];
  ok(rr.prize === expected && A.profile.balance === balR - G.MINIGAMES.reaction.fee + rr.prize, `reaction: ${rr.message}, prize ${rr.prize} (fee ${G.MINIGAMES.reaction.fee})`);
  const again = await A.emit('mg:start', 'reaction');
  ok(!again.ok && /снова будет доступна/.test(again.error), 'mini-game cooldown: ' + again.error);
  const balB = B.profile.balance; let hits = 0;
  B.s.on('mg:rush:spawn', async tg => { if (tg.type === 'b') return; await sleep(120); const h = await B.emit('mg:rush:hit', { id: tg.id, x: tg.x + 3, y: tg.y - 3 }); if (h.ok) hits++; });
  const resB = new Promise(r => B.s.once('mg:result', r));
  ok((await B.emit('mg:start', 'rush')).ok, 'orb rush started');
  ok(!(await B.emit('mg:rush:hit', { id: 1, x: -500, y: -500 })).ok, 'rush rejects hit at wrong position');
  const rB = await resB; await sleep(200);
  ok(hits > 10 && rB.prize === G.rushPrize(rB.score) && rB.prize <= G.MINIGAMES.rush.maxPrize && B.profile.balance === balB - G.MINIGAMES.rush.fee + rB.prize,
    `orb rush: score ${rB.score} → prize ${rB.prize} (fee ${G.MINIGAMES.rush.fee}, cap ${G.MINIGAMES.rush.maxPrize})`);
  await sleep(700);
  const pg = await B.call('profile:get', null);
  ok(pg.ok && pg.profile.stats.bestRush === rB.score && pg.profile.stats.minigames === 1, `best mini-game results stored (best rush ${pg.profile.stats.bestRush})`);
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${encodeURIComponent(A.profile.name)}`)).json();
  ok(lb.players.every((p, i, arr) => i === 0 || arr[i - 1].total >= p.total) && lb.me, `leaderboard sorted by all-time total; A rank #${lb.me && lb.me.rank}`);
  A.close(); B.close();
}

// light gameplay checks that work against any server (no test hooks)
async function gameplaySuite(URL) {
  console.log('--- gameplay');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('Runner' + rnd()); await B.register('Player' + rnd());
  await sleep(300);
  const p0 = { ...A.pos };
  for (let i = 0; i < 100; i++) A.s.emit('input', { s: ++A.seq, x: 5, y: 0 });
  await sleep(1000);
  const moved = Math.hypot(A.pos.x - p0.x, A.pos.y - p0.y);
  const maxLegit = G.speedFor(0) * 1.0 + G.speedFor(0) * G.STEP_DT * 8;
  ok(moved > 50 && moved <= maxLegit, `input flood is rate-limited: moved ${moved.toFixed(0)}px in 1s (cap ≈${maxLegit.toFixed(0)})`);
  await A.farm(15, 60000);
  ok(A.profile.balance >= 15, `A farmed balance to ${A.profile.balance}`);
  ok(!(await A.emit('buy', 'c_rainbow')).ok && !(await A.emit('upgrade', '__proto__')).ok && !(await A.emit('mg:start', 'constructor')).ok, 'unaffordable / prototype-key payloads rejected');
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${encodeURIComponent(A.profile.name)}`)).json();
  ok(lb.me && lb.me.total === A.profile.total, `leaderboard has A with total ${A.profile.total}`);
  A.close(); B.close();
}

// ------------------------------------------------------------------ chat clear cycle + spawn (dedicated server with short timers)
async function chatClearSuite(URL, period) {
  console.log('--- chat clear cycle (silent)');
  const C = makeClient(URL), E = makeClient(URL);
  const clears = [];
  E.s.on('chat:clear', (...args) => clears.push({ at: Date.now(), args }));
  const rc = await C.register('Clr' + rnd()); await E.register('Clr' + rnd());
  ok(rc.ok && !('chatNextClear' in rc), 'join payload carries no clear schedule');
  await C.call('chat', 'сообщение до стирания');
  await waitFor(() => clears.length >= 2, period * 2 + 2000);
  const gap = clears.length >= 2 ? clears[1].at - clears[0].at : -1;
  ok(clears.length >= 2 && Math.abs(gap - period) < 400 && clears.every(c => c.args.length === 0), `chat:clear still fires on a fixed ${period} ms cycle (gap ${gap} ms) with no payload`);
  const sysAfter = E.chat.filter(m => m.ts >= clears[0].at);
  ok(!E.chat.some(m => /очищ|очист|cleared/i.test(m.t || '')) && sysAfter.length === 0, 'no system message announces the clear');
  const F = makeClient(URL);
  const rf = await F.register('Clr' + rnd());
  ok(rf.ok && !rf.chat.some(m => /до стирания/.test(m.t)), `history wiped by the clear (new player sees ${rf.chat.length} old messages)`);
  C.close(); E.close(); F.close();
}

async function spawnSuite(URL) {
  console.log('--- orb spawning');
  const h0 = await (await fetch(URL + '/api/health')).json();
  const cl = [];
  for (let i = 0; i < 3; i++) { const c = makeClient(URL); await c.register('Spawn' + rnd()); cl.push(c); }
  const adds = []; let tooClose = 0;
  cl[0].s.on('s', st => {
    for (const [id, x, y, t] of st.oa) {
      adds.push(t);
      for (const [, px, py] of st.p) if (Math.hypot(px - x, py - y) < 200) tooClose++;
    }
  });
  const h1 = await (await fetch(URL + '/api/health')).json();
  ok(h0.targetOrbs === 90 && h1.targetOrbs === 160, `target orbs scale with players: ${h0.targetOrbs} (0 online, min) → ${h1.targetOrbs} (3 online) [70 + 30/player, 90…320]`);
  const n0 = cl[0].orbs.size;
  await sleep(1000);
  const n1 = cl[0].orbs.size;
  ok(n1 > n0 && n1 < h1.targetOrbs, `new orbs fade in gradually (${n0} → ${n1} after 1 s, target ${h1.targetOrbs})`);
  await sleep(4500);
  const list = Array.from(cl[0].orbs.values()).filter(o => o.t !== 'l');
  ok(Math.abs(list.length - h1.targetOrbs) <= 8, `orb count reaches the target (${list.length}/${h1.targetOrbs})`);
  const cells = new Map();
  for (const o of list) { const k = Math.floor(o.x / 300) + ',' + Math.floor(o.y / 300); cells.set(k, (cells.get(k) || 0) + 1); }
  const maxCell = Math.max(...cells.values());
  ok(cells.size >= 75 && maxCell <= 5, `even spread: ${cells.size}/100 cells occupied, max ${maxCell} orbs per 300×300 cell`);
  let minD = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) minD = Math.min(minD, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y));
  ok(minD >= 69, `no clumps: min distance between orbs ${minD.toFixed(0)} px (≥ 70)`);
  ok(adds.length > 50 && tooClose === 0, `no orb spawned within 200 px of a player (${adds.length} spawns checked)`);
  const types = adds.filter(t => t !== 'l').concat(list.map(o => o.t));
  const rare = types.filter(t => t === 'r').length / types.length;
  ok(rare > 0.03 && rare < 0.2, `rare orb share ${(rare * 100).toFixed(1)}% of ${types.length} orbs (configured 10%)`);
  // collected orbs come back after a delay, not instantly
  const A = cl[0];
  const before = A.profile.total;
  await A.farm(before + 8, 20000);
  const justAfter = A.orbs.size;
  await sleep(1000);
  ok(A.orbs.size <= h1.targetOrbs, `after collecting, orbs refill gradually (${justAfter} right after, ${A.orbs.size} 1 s later, target ${h1.targetOrbs})`);
  for (const c of cl) c.close();
}

async function legendarySuite(URL) {
  console.log('--- legendary event');
  const A = makeClient(URL); await A.register('Hunter' + rnd());
  const atJoin = Array.from(A.orbs.values()).filter(o => o.t === 'l').length;
  const items = [], announces = [];
  A.s.on('item', d => items.push(d));
  A.s.on('announce', d => announces.push(d));
  const t0 = Date.now(); let maxAlive = 0;
  while (!items.length && Date.now() - t0 < 40000) {
    const ls = Array.from(A.orbs.values()).filter(o => o.t === 'l');
    maxAlive = Math.max(maxAlive, ls.length);
    let dx = 0, dy = 0;
    if (ls.length) { dx = ls[0].x - A.pos.x; dy = ls[0].y - A.pos.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
    A.s.emit('input', { s: ++A.seq, x: dx, y: dy });
    await sleep(50);
  }
  await sleep(300); // well inside the 2.5 s test cycle, so the next spawn cannot be mistaken for a leftover
  const sh = A.profile.inventory.find(x => x.id === 'x_legend_shard');
  const after = Array.from(A.orbs.values()).filter(o => o.t === 'l').length;
  ok((announces.length >= 1 || atJoin === 1) && maxAlive <= 1 && after === 0, `legendary orb is a timed event (on field at join: ${atJoin}, announced ${announces.length}×, max ${maxAlive} alive, none 0.3 s after pickup — cooldown)`);
  ok(items.length === 1 && items[0].id === 'x_legend_shard' && sh && sh.src === 'arena', 'collecting it grants a «Легендарный осколок» via grantItem (source "arena")');
  A.close();
}

// ------------------------------------------------------------------ migration of accounts saved by the previous version (7c2dacd)
const LEGACY_OWNED = ['c_cyan', 's_circle', 't_none', 'n_white', 'h_none', 'c_coral', 'c_gold', 's_star', 't_sparks', 'h_crown', 'n_rainbow', 'zz_removed_item'];
function legacyAccount() {
  const bcrypt = require('bcryptjs');
  const name = 'Veteran' + rnd(), now = Date.now();
  const token = crypto.randomBytes(32).toString('base64url');
  issuedTokens.push(token);
  return {
    token, tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    acc: { key: name.toLowerCase(), name, passHash: bcrypt.hashSync(PASS, 4), balance: 4321, total: 987654, owned: LEGACY_OWNED.slice(),
      equipped: { color: 'c_gold', shape: 's_star', trail: 't_sparks', nameColor: 'n_rainbow', hat: 'h_crown' },
      upgrades: { magnet: 3, speed: 2 }, stats: { minigames: 7, bestReaction: 212, bestRush: 31 }, createdAt: now - 20 * 86400000, lastSeen: now - 3600000 },
  };
}
const OLD_PG_SCHEMA = `
CREATE TABLE ocs_accounts (key TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL DEFAULT 0,
  owned JSONB NOT NULL, equipped JSONB NOT NULL, upgrades JSONB NOT NULL, stats JSONB NOT NULL, created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL);
CREATE INDEX ocs_accounts_rank_idx ON ocs_accounts (total DESC, created_at ASC);
CREATE TABLE ocs_sessions (token_hash TEXT PRIMARY KEY, account_key TEXT NOT NULL REFERENCES ocs_accounts(key) ON DELETE CASCADE, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL);`;
async function seedLegacyPg(dbUrl, L) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: dbUrl }); await db.connect();
  await db.query('DROP TABLE IF EXISTS ocs_sessions; DROP TABLE IF EXISTS ocs_accounts;');
  await db.query(OLD_PG_SCHEMA);
  const a = L.acc;
  await db.query('INSERT INTO ocs_accounts (key,name,pass_hash,balance,total,owned,equipped,upgrades,stats,created_at,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [a.key, a.name, a.passHash, a.balance, a.total, JSON.stringify(a.owned), JSON.stringify(a.equipped), JSON.stringify(a.upgrades), JSON.stringify(a.stats), a.createdAt, a.lastSeen]);
  await db.query('INSERT INTO ocs_sessions VALUES ($1,$2,$3,$4)', [L.tokenHash, a.key, Date.now(), Date.now() + 86400000]);
  await db.end();
}
function seedLegacyJson(file, L) {
  fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: { [L.acc.key]: L.acc }, sessions: { [L.tokenHash]: { key: L.acc.key, createdAt: Date.now(), expiresAt: Date.now() + 86400000 } } }));
}
async function migrationSuite(URL, L, label) {
  console.log('--- migration of old-format account (' + label + ')');
  const S = makeClient(URL); await S.ready;
  const ss = await S.call('session', { token: L.token });
  ok(ss.ok && ss.profile.name === L.acc.name, 'old session token still valid after migration');
  S.close(); await sleep(200);
  const P = makeClient(URL);
  const r = await P.login(L.acc.name);
  const pr = r.profile || {};
  const inv = (pr.inventory || []).map(x => x.id).sort();
  const expectInv = ['c_coral', 'c_gold', 'h_crown', 'n_rainbow', 's_star', 't_sparks'];
  ok(r.ok, 'old password still works');
  ok(pr.balance === 4321 && pr.total === 987654 && pr.upgrades.magnet === 3 && pr.upgrades.speed === 2, `balance ${pr.balance}, total ${pr.total}, upgrades magnet ${pr.upgrades && pr.upgrades.magnet}/speed ${pr.upgrades && pr.upgrades.speed} kept`);
  ok(JSON.stringify(inv) === JSON.stringify(expectInv) && pr.inventory.every(x => x.src === 'legacy' && x.q === 1), `owned cosmetics moved to inventory (${inv.join(', ')}; unknown ids dropped, free items implicit)`);
  ok(JSON.stringify(pr.equipped) === JSON.stringify(L.acc.equipped), 'equipped look unchanged');
  ok(pr.stats.minigames === 7 && pr.stats.bestReaction === 212 && pr.stats.bestRush === 31 && pr.stats.sessions === 1 && pr.createdAt === L.acc.createdAt, 'stats + creation date kept, new counters added');
  const e = await P.emit('inv:equip', 'c_coral');
  ok(e.ok && e.profile.equipped.color === 'c_coral', 'migrated item can be equipped from the inventory');
  await P.emit('inv:equip', 'c_gold');
  P.close();
}
// simulates the previous build (still running during a zero-downtime deploy) writing `owned` after the migration
async function legacyWriteAfterMigration(env, L) {
  if (env.DATABASE_URL) {
    const { Client } = require('pg');
    const db = new Client({ connectionString: env.DATABASE_URL }); await db.connect();
    const col = await db.query("SELECT inventory, owned FROM ocs_accounts WHERE key = $1", [L.acc.key]);
    ok(col.rows[0].inventory && col.rows[0].inventory.slots.length === 6 && col.rows[0].owned.includes('h_crown'), 'Postgres: inventory JSONB column filled, legacy owned column kept in sync');
    await db.query("UPDATE ocs_accounts SET owned = owned || '[\"t_fire\"]'::jsonb, balance = balance - 4000 WHERE key = $1", [L.acc.key]);
    await db.end();
  } else {
    const d = JSON.parse(fs.readFileSync(env.DATA_FILE, 'utf8'));
    const a = d.accounts[L.acc.key];
    ok(a.inventory && a.inventory.slots.length === 6 && a.owned.includes('h_crown') && a.passHash === L.acc.passHash, 'JSON file: inventory saved, legacy owned list kept, password hash unchanged');
    a.owned.push('t_fire'); a.balance -= 4000;
    fs.writeFileSync(env.DATA_FILE, JSON.stringify(d));
  }
}
async function legacyReconcileCheck(URL, L) {
  const P = makeClient(URL);
  const r = await P.login(L.acc.name);
  ok(r.ok && r.profile.inventory.some(x => x.id === 't_fire') && r.profile.balance === 321 && r.profile.equipped.color === 'c_gold',
    `item bought by the old build after migration is reconciled into the inventory (t_fire), balance ${r.profile.balance}`);
  P.close();
}

// farm, buy, restart server, verify everything came back
async function persistencePhase1(URL, hooks) {
  const name = 'Keeper' + rnd();
  const P = makeClient(URL);
  await P.register(name);
  await P.farm(5, 30000);
  if (hooks) await P.emit('test:orbs', 5000);
  const b1 = await P.emit('buy', 'c_coral');
  const q1 = await P.emit('inv:equip', 'c_coral');
  const u1 = await P.emit('upgrade', 'magnet');
  if (hooks) await P.emit('test:grant', { id: 'x_legend_shard', qty: 120, source: 'event' });
  await P.emit('buy', 's_square'); await P.emit('inv:equip', 's_square');
  const shardSum = p => (p.inventory || []).filter(x => x.id === 'x_legend_shard').reduce((n, x) => n + x.q, 0);
  const shardsLeft = shardSum(P.profile) - (hooks ? 30 : 0); // farming may have picked up a legendary orb too
  const tr1 = await P.emit('inv:trash', { id: 's_square', qty: 1 });
  const tr2 = hooks ? await P.emit('inv:trash', { id: 'x_legend_shard', qty: 30 }) : { ok: true };
  ok(tr1.ok && tr2.ok && P.profile.equipped.shape === 's_circle', 'persistence: trashed an equipped unique item and 30 of 120 shards');
  ok(b1.ok && q1.ok && u1.ok, `persistence: ${name} has ${P.profile.total} total, bought + equipped c_coral, magnet 1, ${P.profile.inventory.length} inventory slots`);
  await sleep(100);
  const snap = JSON.parse(JSON.stringify(P.profile));
  return { name, snap, token: P.token, P, shardsLeft };
}
async function persistencePhase2(URL, st) {
  const P = makeClient(URL);
  const r = await P.login(st.name);
  const pr = r.profile || {};
  const invSig = p => JSON.stringify((p.inventory || []).map(x => [x.id, x.q, x.src]));
  const same = r.ok && pr.balance === st.snap.balance && pr.total === st.snap.total && invSig(pr) === invSig(st.snap)
    && pr.equipped.color === 'c_coral' && pr.upgrades.magnet === 1;
  ok(r.ok && !pr.inventory.some(x => x.id === 's_square') && pr.equipped.shape === 's_circle' && pr.inventory.filter(x => x.id === 'x_legend_shard').reduce((n, x) => n + x.q, 0) === st.shardsLeft,
    `trash survived restart (deleted item not resurrected from the legacy owned list, ${st.shardsLeft} shards left)`);
  ok(same, `data survived restart: balance ${pr.balance}/${st.snap.balance}, total ${pr.total}/${st.snap.total}, inventory ${invSig(pr) === invSig(st.snap) ? 'same' : 'DIFFERENT'}, color ${pr.equipped && pr.equipped.color}`);
  P.close();
  const Q = makeClient(URL);
  const rq = await Q.resume(st.token);
  ok(rq.ok && rq.profile.name === st.name, 'session token still valid after restart');
  Q.close();
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${st.name}`)).json();
  ok(lb.me && lb.me.total === st.snap.total, `leaderboard reads persisted all-time total after restart (rank #${lb.me && lb.me.rank})`);
}

function privacyAudit(serverLogs) {
  console.log('--- privacy audit');
  const blob = received.join('\n');
  const ids = allSockets.map(s => s.id).filter(Boolean);
  const leakedIds = ids.filter(id => blob.includes(id));
  ok(received.length > 100 && leakedIds.length === 0, `no socket ids in ${received.length} received broadcast/event payloads`);
  const leakedTokens = issuedTokens.filter(t => blob.includes(t) || blob.includes(crypto.createHash('sha256').update(t).digest('hex')));
  ok(leakedTokens.length === 0, 'no session tokens / token hashes in any broadcast');
  ok(received.filter(r => r.startsWith('chat:clear')).every(r => r === 'chat:clear []') && !/chatNextClear|очищ|очистк/i.test(blob), 'clients never receive the chat-clear schedule or a «cleared» notice');
  ok(!/\$2[aby]\$/.test(blob) && !/passHash|pass_hash|sessionHash|"ip"|address|127\.0\.0\.1|::ffff|"::1"/i.test(blob), 'no password hashes, IP addresses or private fields in broadcasts');
  if (serverLogs != null) {
    ok(!/127\.0\.0\.1|::ffff|::1\b/.test(serverLogs) && !issuedTokens.some(t => serverLogs.includes(t)) && !serverLogs.includes(PASS), 'server log contains no IPs, tokens or passwords');
  }
}
async function leaderboardAudit(URL) {
  const raw = await (await fetch(URL + '/api/leaderboard?limit=100')).text();
  const lb = JSON.parse(raw);
  const allowed = ['rank', 'name', 'total', 'color', 'online'];
  ok(lb.players.every(p => Object.keys(p).every(k => allowed.includes(k))) && !/\$2[aby]\$|token|hash|ip/i.test(raw.replace(/"name":"[^"]*"/g, '')), '/api/leaderboard exposes only rank/name/total/color/online');
}

// ------------------------------------------------------------------ server process helpers
async function startServer(port, env) {
  try { await fetch(`http://localhost:${port}/api/health`); throw new Error(`port ${port} is already in use by another server`); }
  catch (e) { if (/already in use/.test(e.message)) throw e; } // connection refused = port free
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATABASE_URL: '', DATA_FILE: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    const srv = { proc, logs: '', url: `http://localhost:${port}` };
    proc.stdout.on('data', d => { srv.logs += d; });
    proc.stderr.on('data', d => { srv.logs += d; });
    srv.exited = new Promise(r => proc.on('exit', code => r(code)));
    srv.stop = async () => { proc.kill('SIGTERM'); return srv.exited; };
    const t0 = Date.now();
    (async function poll() {
      while (Date.now() - t0 < 30000) {
        try { const r = await fetch(srv.url + '/api/health'); if (r.ok) return resolve(srv); } catch (_) { /* not up yet */ }
        if (proc.exitCode != null) return reject(new Error('server exited: ' + srv.logs));
        await sleep(200);
      }
      reject(new Error('server did not start: ' + srv.logs));
    })();
  });
}

async function runMode(label, env, opts) {
  console.log(`\n===== ${label} =====`);
  const port = 3101;
  env = Object.assign({ OCS_TEST_HOOKS: '1' }, env);
  let srv = await startServer(port, env);
  console.log('server: ' + srv.logs.trim().split('\n').slice(0, 3).join(' | '));
  if (opts.legacy) await migrationSuite(srv.url, opts.legacy, label);
  await authSuite(srv.url);
  await profileSuite(srv.url);
  if (opts.full) { await chatSuite(srv.url); await gameplaySuite(srv.url); await minigameSuite(srv.url); }
  await shopInventorySuite(srv.url);
  await trashSuite(srv.url);
  await leaderboardAudit(srv.url);
  const st = await persistencePhase1(srv.url, true);
  const code = await srv.stop(); // SIGTERM while the player is still online -> must flush
  st.P.close();
  ok(code === 0 && /Saved/.test(srv.logs), `server flushed and exited cleanly on SIGTERM (exit ${code})`);
  if (opts.legacy) await legacyWriteAfterMigration(env, opts.legacy);
  let logs = srv.logs;
  srv = await startServer(port, env);
  await persistencePhase2(srv.url, st);
  if (opts.legacy) await legacyReconcileCheck(srv.url, opts.legacy);
  await srv.stop();
  logs += srv.logs;
  return logs;
}

async function runCycleMode() {
  console.log('\n===== chat cycle / spawn / legendary (short timers) =====');
  const tmp = path.join(os.tmpdir(), `ocs-cycle-${process.pid}.json`);
  const srv = await startServer(3104, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1', CHAT_CLEAR_MS: '3000', LEGENDARY_EVERY_MS: '2500' });
  await spawnSuite(srv.url);
  await chatClearSuite(srv.url, 3000);
  await legendarySuite(srv.url);
  await srv.stop();
  fs.rmSync(tmp, { force: true });
  return srv.logs;
}

(async () => {
  const url = process.argv[2];
  if (url) {
    await authSuite(url);
    await chatSuite(url);
    await gameplaySuite(url);
    await leaderboardAudit(url);
    privacyAudit(null);
  } else if (process.env.OCS_TEST_ONLY === 'cycle') {
    privacyAudit(await runCycleMode());
  } else {
    priceSanity();
    let logs = '';
    const tmp = path.join(os.tmpdir(), `ocs-test-${process.pid}.json`);
    const L1 = legacyAccount();
    seedLegacyJson(tmp, L1);
    logs += await runMode('JSON file mode', { DATA_FILE: tmp }, { full: true, legacy: L1 });
    fs.rmSync(tmp, { force: true });
    logs += await runCycleMode();
    if (process.env.TEST_DATABASE_URL) {
      const L2 = legacyAccount();
      await seedLegacyPg(process.env.TEST_DATABASE_URL, L2); // old (7c2dacd) schema + data, the new server must migrate it
      logs += await runMode('PostgreSQL mode', { DATABASE_URL: process.env.TEST_DATABASE_URL }, { full: false, legacy: L2 });
    } else console.log('\n(PostgreSQL mode skipped: set TEST_DATABASE_URL to run it)');
    privacyAudit(logs);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  for (const s of allSockets) s.close();
  setTimeout(() => process.exit(), 300);
})().catch(e => { console.error(e); process.exit(1); });
