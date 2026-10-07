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

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// catalog of commit f731c5a: these ids and prices must never change
const OLD_PRICES = { c_cyan: 0, c_coral: 150, c_lime: 150, c_violet: 400, c_pink: 700, c_gold: 2400, c_rainbow: 15000, s_circle: 0, s_square: 400, s_triangle: 800, s_hexagon: 1400, s_star: 4000,
  t_none: 0, t_sparks: 1000, t_neon: 2800, t_fire: 12000, n_white: 0, n_pink: 300, n_gold: 1800, n_rainbow: 9000, h_none: 0, h_cap: 500, h_tophat: 1500, h_halo: 3200, h_crown: 20000, x_legend_shard: null };
const NEW_ITEMS = () => G.ITEMS.filter(i => !has(OLD_PRICES, i.id) && !i.exclusive); // exclusives: «Лавка осколков» only

// ------------------------------------------------------------------ upgrades: pure rules (curves, caps, multiplier fractions, luck, migration)
function upgradeRules() {
  console.log('--- upgrades (rules)');
  const U = G.UPGRADES;
  ok(G.UPGRADE_KEYS.join(',') === 'magnet,speed,mult,luck,sense,skill', 'upgrades: magnet, speed, orb multiplier, luck, legendary sense, mini-game skill');
  const dim = ['magnet', 'speed', 'mult', 'luck'].filter(k => { const v = U[k].values, inc = v.slice(1).map((x, i) => x - v[i]); return inc.every(d => d > 0) && inc.every((d, i) => !i || d <= inc[i - 1]); });
  ok(dim.length === 4, `diminishing (or flat for the multiplier) returns per level: ${dim.join(', ')}`);
  const RATE = 80;
  ok(G.UPGRADE_KEYS.every(k => U[k].prices.length === U[k].max && U[k].values.length === U[k].max + 1 && U[k].prices.every((v, i) => !i || v > U[k].prices[i - 1])), 'one price per level, strictly increasing; one effect value per level');
  ok(G.UPGRADE_KEYS.every(k => U[k].prices[0] >= 300 && U[k].prices[0] <= 800), 'first levels are cheap (300–800): ' + G.UPGRADE_KEYS.map(k => U[k].prices[0]).join('/'));
  const lastMax = ['magnet', 'speed', 'mult', 'luck'].map(k => U[k].prices[U[k].max - 1]);
  ok(lastMax.every(p => p / RATE / 60 >= 2 && p / RATE / 60 <= 3.5), `max levels cost several hours of play: ${lastMax.map(p => (p / RATE / 60).toFixed(1) + ' h').join(' / ')}`);
  // caps
  ok(G.speedFor(99) === G.speedFor(U.speed.max) && G.speedFor(-4) === G.BASE_SPEED && G.speedFor('x') === G.BASE_SPEED && G.speedFor(U.speed.max) <= G.BASE_SPEED * 1.2,
    `speed capped: max ${G.speedFor(U.speed.max).toFixed(0)} px/s (base ${G.BASE_SPEED}, ≤ +20 %), out-of-range levels clamp`);
  ok(G.pickupFor(99) === G.pickupFor(U.magnet.max) && G.pickupFor(U.magnet.max) <= G.PLAYER_R * 3, `pickup radius capped at ${G.pickupFor(U.magnet.max)} px`);
  // multiplier with fractional carry: +5 % on 1-orb pickups must not be rounded away
  const sum = (n, v, ups, rnd) => { const st = { frac: 0 }; let t = 0; for (let i = 0; i < n; i++) t += G.orbReward(v, ups, st, rnd).value; return t; };
  ok(sum(20, 1, { mult: 1 }, () => 1) === 21 && sum(100, 1, { mult: 5 }, () => 1) === 125 && sum(19, 1, { mult: 1 }, () => 1) === 19 && sum(4, 5, { mult: 5 }, () => 1) === 25,
    'multiplier: 20×1 orb at +5 % → 21, 100×1 at +25 % → 125 (fractions carried, never lost)');
  const lucky = G.orbReward(5, { luck: 5 }, {}, () => 0), unlucky = G.orbReward(5, { luck: 5 }, {}, () => 0.5), noLuck = G.orbReward(5, {}, {}, () => 0);
  ok(lucky.value === 10 && lucky.lucky && unlucky.value === 5 && !unlucky.lucky && noLuck.value === 5, `luck: ${U.luck.values[U.luck.max]} % chance at max to count an orb twice (roll < chance → ×2); levels 3–5 add a ${U.luck.jackpot.slice(3).join('/')} % «находка»`);
  ok(sum(4, 1, { mult: 5, luck: 5 }, () => 0) === 10, 'luck and multiplier stack (2 per orb +25 % → 10 for 4 orbs)');
  ok(G.skillPrize(16, 3) === 18 && G.skillPrize(16, 0) === 16 && G.skillPrize(0, 3) === 0 && G.skillPrize(40, 99) === 46, 'mini-game skill: +5/10/15 % on prizes > 0, capped at level 3');
  // migration of stored upgrade levels (levels kept 1:1, unknown keys dropped, above-max clamped + refunded)
  const INV = require('../lib/inventory.js');
  const acc = { key: 'mig', name: 'Mig', passHash: 'x', balance: 100, total: 5, owned: [], equipped: {}, upgrades: { magnet: 7, speed: '2', bogus: 4, luck: -1 }, stats: {} };
  INV.migrateAccount(acc);
  ok(JSON.stringify(acc.upgrades) === JSON.stringify({ magnet: 5, speed: 2, mult: 0, luck: 0, sense: 0, skill: 0 }) && acc.balance === 100 + 2 * U.magnet.prices[4],
    `stored levels migrate: magnet 7→5 (+${2 * U.magnet.prices[4]} refunded), speed "2"→2, unknown dropped, new upgrades start at 0`);
  const acc2 = { key: 'mig2', name: 'Mig2', passHash: 'x', balance: 7, total: 5, owned: [], equipped: {}, upgrades: { magnet: 3, speed: 5 }, stats: {} };
  INV.migrateAccount(acc2);
  ok(acc2.upgrades.magnet === 3 && acc2.upgrades.speed === 5 && acc2.balance === 7, 'existing levels (magnet 3, speed 5) are kept on the new curves, no refund needed');
}

// ------------------------------------------------------------------ orb tiers, compass, events, exclusives: pure rules
function tierEventRules() {
  console.log('--- orb tiers / compass / events / «Лавка осколков» (rules)');
  const T = G.ORB_TYPES, keys = ['c', 'u', 'r', 'e', 'l', 'm'];
  ok(keys.map(k => T[k].value).join(',') === '1,2,5,10,25,50' && keys.every((k, i) => !i || T[k].r > T[keys[i - 1]].r) && new Set(keys.map(k => T[k].color)).size === keys.length,
    'tiers common +1, uncommon +2, rare +5, epic +10, legendary +25, mythic +50 — each bigger than the last, distinct colours');
  ok(T.l.weight === 0 && T.t.weight === 0 && T.m.weight > 0 && T.m.shards === 3 && T.l.shards === 1 && T.m.maxAlive === 1, 'legendary stays timed, treasure only in events, mythic: random, max 1 alive, 3 shards');
  const ev = G.expectedOrbValue();
  ok(ev >= 1.35 && ev <= 1.5, `pool mean orb value ${ev.toFixed(3)} (old 1.4 → income stays ≈100/min)`);
  ok(G.expectedOrbValue(G.RAIN_WEIGHTS) > ev * 1.4, `«Сферный дождь» orbs are richer (mean ${G.expectedOrbValue(G.RAIN_WEIGHTS).toFixed(2)})`);
  let seed = 7; const prng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const N = 400000, cnt = {}; for (let i = 0; i < N; i++) { const t = G.rollOrbType(G.POOL_WEIGHTS, prng); cnt[t] = (cnt[t] || 0) + 1; }
  const tot = Object.values(G.POOL_WEIGHTS).reduce((a, b) => a + b, 0);
  const off = Object.keys(G.POOL_WEIGHTS).filter(k => Math.abs(cnt[k] / N - G.POOL_WEIGHTS[k] / tot) > Math.max(0.002, 0.08 * G.POOL_WEIGHTS[k] / tot) && k !== 'm');
  ok(!off.length && !cnt.l && !cnt.t && cnt.m > 0, 'roll distribution matches the weights: ' + Object.keys(cnt).map(k => `${k} ${(cnt[k] / N * 100).toFixed(2)}%`).join(', '));
  // luck: ×2 chance + «находка» (common/uncommon → epic +10) from level 3
  const seq = arr => { let i = 0; return () => arr[i++ % arr.length]; };
  ok(G.orbReward(1, { luck: 5 }, {}, seq([0, 0.5]), 'c').value === 10 && G.orbReward(1, { luck: 5 }, {}, seq([0, 0]), 'u').value === 20 && G.orbReward(5, { luck: 5 }, {}, seq([0, 0.5]), 'r').value === 10 &&
    G.orbReward(1, { luck: 2 }, {}, seq([0, 0.5]), 'c').value === 2 && G.jackpotChance(5) === 1 && G.jackpotChance(2) === 0,
    '«Удача»: find turns a common/uncommon orb into +10 (then ×2 may apply), never on rare+; only from level 3');
  const j = G.jackpotChance(5) / 100, pPool = G.POOL_WEIGHTS, ptot = Object.values(pPool).reduce((a, b) => a + b, 0);
  const cuShare = (pPool.c + pPool.u) / ptot, cuMean = (pPool.c * 1 + pPool.u * 2) / (pPool.c + pPool.u);
  const luckF = (ev + cuShare * j * (10 - cuMean)) / ev * (1 + G.upValue('luck', 5) / 100), analytic = luckF * (1 + G.upValue('mult', 5) / 100);
  ok(analytic >= 1.35 && analytic <= 1.55, `multiplier × luck (×2 + find) at max ≈ ×${analytic.toFixed(3)} per orb; movement upgrades add the rest of the +60–80 % target`);
  // compass
  const me = { x: 1000, y: 1000 }, list = [{ t: 'c', x: 1100, y: 1000 }, { t: 'l', x: 2500, y: 2500 }, { t: 'm', x: 100, y: 100 }, { t: 'e', x: 1400, y: 1000 }, { t: 'e', x: 1200, y: 1000 }, { t: 'e', x: 2900, y: 2900 }, { t: 't', x: 50, y: 2900 }];
  const evz = { zone: { x: 2000, y: 500, r: 230 }, runner: null };
  const kinds = l => G.compassTargets(l, list, me, evz).map(t => t.kind + (t.kind === 'e' ? '@' + t.x : '')).join(',');
  ok(kinds(0) === '' && kinds(1) === 'l,m' && G.compassTargets(1, list, me, evz).every(t => t.dist === null) && kinds(2) === 'l,m,e@1200' && G.compassTargets(2, list, me, null).every(t => t.dist > 0) && kinds(3) === 'l,m,event,e@1200,event',
    `«Чутьё легенды»: lvl1 ${kinds(1)} · lvl2 ${kinds(2)} (nearest epic in ${G.SENSE_EPIC_RANGE} px, distances) · lvl3 ${kinds(3)} (treasures, event zone)`);
  // «Радар»: only common/uncommon (+ faint rare) orbs within range; never epic/legendary/mythic/treasure (rain orbs flagged ev but c/u/r are fine)
  const rlist = list.concat([{ t: 'u', x: 1000, y: 1500 }, { t: 'r', x: 900, y: 1200 }, { t: 'c', x: 1000, y: 1000 + G.RADAR.range + 1 }, { t: 'c', x: 1300, y: 1100, ev: 1 }, { t: 'x', x: 1000, y: 1001 }]);
  const rb = G.radarBlips(rlist, me), rt = rb.map(b => b.t).join(',');
  ok(rt === 'c,u,r,c' && rb.every(b => b.d <= G.RADAR.range) && rb.find(b => b.t === 'r').a < 0.5 && !rb.some(b => ['e', 'l', 'm', 't'].includes(b.t)) && Object.keys(G.RADAR.tiers).join() === 'c,u,r',
    `«Радар» filter: ${rt} (epic/legendary/mythic/treasure and out-of-range orbs dropped, rare faint)`);
  // events: rewards are a bonus of a few minutes of farming, timings, schedule
  const RATE = 100, E = G.EVENTS, rewards = [].concat(E.koth.rewards, [E.koth.solo, E.koth.participation, E.runner.reward]);
  ok(G.EVENT_KEYS.join(',') === 'rain,koth,treasure,runner' && E.rain.durationMs === 45000 && rewards.every(r => r.orbs + r.shards * G.SHARD_EXCHANGE.orbs <= 4 * RATE && r.shards <= 2) &&
    E.treasure.reward.orbs * E.treasure.maxCount <= 4 * RATE * 1.5, `4 events; every reward (orbs + shards at the exchange rate) ≤ 4 min of farming (top: ${E.koth.rewards[0].orbs} ◉ + ${E.koth.rewards[0].shards} 💎)`);
  const S = G.EVENT_SCHEDULE;
  ok(S.minMs === 360000 && S.maxMs === 600000 && S.announceMs >= 20000 && S.announceMs <= 30000, 'schedule: an event every 6–10 min of online time, announced 25 s ahead');
  // exclusives
  const X = G.ITEMS.filter(i => i.exclusive);
  ok(X.length >= 6 && X.length <= 10 && new Set(X.map(i => i.cat)).size >= 4 && X.every(i => i.price == null && i.shardPrice > 0 && !i.sources.includes('shop') && i.sources.includes('shard_shop')),
    `${X.length} exclusives in ${new Set(X.map(i => i.cat)).size} categories, shard prices ${X.map(i => i.shardPrice).join('/')}, no orb price, never sold in the orb shop`);
  ok(Math.max(...X.map(i => i.shardPrice)) >= 250 && Math.min(...X.map(i => i.shardPrice)) >= 30 && G.SHARD_EXCHANGE.orbs >= 25 && G.SHARD_EXCHANGE.orbs <= 60,
    `top exclusive ${Math.max(...X.map(i => i.shardPrice))} shards (≈10+ h at 15–35 shards/h); exchange 1 💎 = ${G.SHARD_EXCHANGE.orbs} ◉`);
}

// tiers in the arena: uncommon / epic / mythic values, mythic shards (needs hooks)
async function tiersSuite(URL) {
  console.log('--- orb tiers (arena)');
  const A = makeClient(URL); await A.register('Tier' + rnd());
  const items = [], ann = [];
  A.s.on('item', d => items.push(d)); A.s.on('announce', d => ann.push(d));
  const before = new Set(A.orbs.keys());
  const r = await A.emit('test:spawn', { types: ['u', 'e', 'm'], ring: 90 });
  await sleep(200);
  const mine = Array.from(A.orbs.values()).filter(o => !before.has(o.id) && ['u', 'e', 'm'].includes(o.t) && Math.hypot(o.x - A.pos.x, o.y - A.pos.y) < 190); // natural spawns keep 200 px away
  const types = new Map(Array.from(A.orbs.values()).map(o => [o.id, o.t]));
  let raw = 0; const got = new Set();
  const onS = st => { for (const [id, , , t] of st.oa) types.set(id, t); for (const [id, by] of st.od) if (by === A.id) { raw += G.ORB_TYPES[types.get(id)].value; got.add(id); } };
  A.s.on('s', onS);
  const b0 = A.profile.balance;
  for (const o of mine) {
    const t0 = Date.now();
    while (A.orbs.has(o.id) && Date.now() - t0 < 4000) { const dx = o.x - A.pos.x, dy = o.y - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); await sleep(50); }
  }
  await sleep(400); A.s.off('s', onS);
  ok(r.ok && mine.length === 3 && mine.every(o => got.has(o.id)) && A.profile.balance - b0 === raw && raw >= 62, `collected uncommon + epic + mythic: +${A.profile.balance - b0} (= ${raw} orb value, no upgrades)`);
  ok(items.some(d => d.id === G.SHARD_ID && d.qty === 3 && d.source === 'arena') && ann.some(a => /мифическая/.test(a.text)), 'mythic orb: announced, catching it grants 3 shards (source "arena")');
  A.close();
}

// arena events forced via the test hook (scheduler off on this server)
async function eventSuite(URL) {
  console.log('--- arena events (rules + rewards)');
  const A = makeClient(URL), B = makeClient(URL), C = makeClient(URL);
  await A.register('EvA' + rnd()); await B.register('EvB' + rnd()); await C.register('EvC' + rnd());
  const log = { A: [], B: [], C: [] };
  for (const [k, c] of [['A', A], ['B', B], ['C', C]]) for (const e of ['ev:announce', 'ev:start', 'ev:end', 'ev:koth', 'ev:treasure']) c.s.on(e, d => log[k].push([e, d, Date.now()]));
  const evOrbs = new Set(), rn = [];
  A.s.on('s', st => { for (const a of st.oa) if (a[4]) evOrbs.add(a[0]); if (st.rn) rn.push(st.rn); });
  const last = (k, e) => { const l = log[k].filter(x => x[0] === e); return l.length ? l[l.length - 1][1] : null; };
  const waitEv = (k, e, n, ms) => waitFor(() => log[k].filter(x => x[0] === e).length >= n, ms);
  const shards = c => c.profile.inventory.filter(x => x.id === G.SHARD_ID).reduce((n, x) => n + x.q, 0);
  // rain
  let r = await A.emit('test:event', { kind: 'rain', announceMs: 300, durationMs: 4000 });
  ok(r.ok && r.event.kind === 'rain' && r.event.phase === 'announce' && await waitEv('B', 'ev:announce', 1, 1000), 'event announced to every player (ev:announce)');
  await waitEv('A', 'ev:start', 1, 2000);
  const h = await (await fetch(URL + '/api/health')).json();
  await A.farm(A.profile.balance + 400, 3600);
  await waitEv('A', 'ev:end', 1, 3000); await sleep(200);
  const rainOrbs = Array.from(evOrbs);
  const endA = last('A', 'ev:end');
  ok(h.event === 'rain:active' && rainOrbs.length >= G.EVENTS.rain.extraBase, `«Сферный дождь»: ${rainOrbs.length} extra orbs fell (health: ${h.event})`);
  ok(endA && endA.kind === 'rain' && endA.you && endA.you.score > 0 && endA.results[0].reward === null && rainOrbs.every(id => !A.orbs.has(id)), `rain results: A collected ${endA && endA.you && endA.you.score} worth of rain orbs (paid on pickup), leftovers removed at the end`);
  // king of the hill: A + C walk to a common spot during the announcement, B stays out
  await A.emit('test:upgrades', { speed: 5 }); await C.emit('test:upgrades', { speed: 5 });
  const mid = { x: Math.round((A.pos.x + C.pos.x) / 2), y: Math.round((A.pos.y + C.pos.y) / 2) };
  const bFar = Math.hypot(B.pos.x - mid.x, B.pos.y - mid.y) > G.EVENTS.koth.radius + 60;
  const a0 = { A: A.profile.balance, C: C.profile.balance, sA: shards(A), sC: shards(C) };
  r = await A.emit('test:event', { kind: 'koth', announceMs: 9500, durationMs: 13000, x: mid.x, y: mid.y });
  ok(r.ok && r.event.zone && r.event.zone.x === mid.x && r.event.zone.r === G.EVENTS.koth.radius, 'king of the hill: zone announced with the countdown (public position + radius)');
  const walk = c => setInterval(() => { const dx = mid.x - c.pos.x, dy = mid.y - c.pos.y, l = Math.hypot(dx, dy); c.s.emit('input', { s: ++c.seq, x: l > 20 ? dx / l : 0, y: l > 20 ? dy / l : 0 }); }, 50);
  const wa = walk(A), wc = walk(C);
  await waitEv('A', 'ev:end', 2, 30000);
  clearInterval(wa); clearInterval(wc); await sleep(400);
  const kA = log.A.filter(x => x[0] === 'ev:koth').map(x => x[1]), kB = log.B.filter(x => x[0] === 'ev:koth').map(x => x[1]);
  const ke = last('A', 'ev:end'), kc = last('C', 'ev:end'), kb = last('B', 'ev:end');
  const rw = G.EVENTS.koth.rewards;
  ok(kA.some(k => k.inside) && (!bFar || kB.every(k => !k.inside)) && kA.every(k => JSON.stringify(Object.keys(k)) === '["you","inside","top"]'), `ev:koth updates: A inside the zone${bFar ? ', B outside' : ''}; only own score + public top 3`);
  const placeOk = ke && ke.you && kc && kc.you && [ke.you.place, kc.you.place].sort().join() === '1,2' && ke.you.score >= 10 && kc.you.score >= 10;
  const first = placeOk ? (ke.you.place === 1 ? A : C) : null, second = first === A ? C : A;
  ok(placeOk && JSON.stringify((first === A ? ke : kc).you.reward) === JSON.stringify(rw[0]) && JSON.stringify((first === A ? kc : ke).you.reward) === JSON.stringify(rw[1]),
    `koth rewards by score: 1st ${rw[0].orbs} ◉ + ${rw[0].shards} 💎, 2nd ${rw[1].orbs} ◉ + ${rw[1].shards} 💎 (scores ${ke && ke.you && ke.you.score}/${kc && kc.you && kc.you.score})`);
  const paidOk = placeOk && first.profile.balance - (first === A ? a0.A : a0.C) >= rw[0].orbs && second.profile.balance - (second === A ? a0.A : a0.C) >= rw[1].orbs && // ≥: stray orbs picked up on the way
    shards(first) - (first === A ? a0.sA : a0.sC) === rw[0].shards && shards(second) - (second === A ? a0.sA : a0.sC) === rw[1].shards &&
    first.profile.inventory.some(x => x.id === G.SHARD_ID && x.src === 'event');
  ok(paidOk, 'koth rewards paid server-side: orbs to the balance, shards via grantItem (source "event")');
  ok(kb && kb.you === null && kb.results.length >= 2 && kb.results.every(x => JSON.stringify(Object.keys(x)) === '["name","score","reward"]'), 'B (outside) gets the public results (name/score/reward only) and no reward');
  // treasure: one next to A, one far away; A grabs the near one
  const sA0 = shards(A), bA0 = A.profile.balance;
  r = await A.emit('test:event', { kind: 'treasure', announceMs: 200, durationMs: 5000, count: 2, at: [[A.pos.x + 70, A.pos.y], [A.pos.x > 1500 ? 150 : 2850, A.pos.y > 1500 ? 150 : 2850]] });
  await waitEv('A', 'ev:start', 3, 2000); await sleep(150);
  const tr = Array.from(A.orbs.values()).filter(o => o.t === 't');
  const near = tr.find(o => Math.abs(o.x - A.pos.x - 70) < 2);
  for (let i = 0; i < 40 && near && A.orbs.has(near.id); i++) { A.s.emit('input', { s: ++A.seq, x: 1, y: 0 }); await sleep(50); }
  await waitEv('B', 'ev:treasure', 1, 2000);
  const tmsg = last('B', 'ev:treasure');
  await waitEv('A', 'ev:end', 3, 7000); await sleep(300);
  const te = last('A', 'ev:end');
  ok(tr.length === 2 && tmsg && tmsg.name === A.profile.name && tmsg.left === 1 && JSON.stringify(Object.keys(tmsg)) === '["name","left"]', 'treasure grabbed by A: everyone told who found it and how many are left');
  ok(te && te.you && te.you.score === 1 && te.remaining === 1 && te.total === 2 && shards(A) - sA0 === 1 && A.profile.balance - bA0 >= G.EVENTS.treasure.reward.orbs && !A.orbs.has(tr.find(o => o !== near).id),
    `treasure reward ${G.EVENTS.treasure.reward.orbs} ◉ + 1 💎 (fixed), unfound treasure removed at the end`);
  // random treasure spots are far from players
  r = await A.emit('test:event', { kind: 'treasure', announceMs: 100, durationMs: 8000, count: 3 });
  await waitEv('A', 'ev:start', 4, 2000); await sleep(200);
  const spots = Array.from(A.orbs.values()).filter(o => o.t === 't');
  const pls = [A.pos, B.pos, C.pos], minD = Math.min(...spots.map(o => Math.min(...pls.map(p => Math.hypot(p.x - o.x, p.y - o.y)))));
  ok(spots.length === 3 && minD >= 600, `treasures spawn far from every player (closest ${Math.round(minD)} px)`);
  // runner (slowed down by the hook so the bot can catch it)
  const sA1 = shards(A), bA1 = A.profile.balance; rn.length = 0;
  r = await A.emit('test:event', { kind: 'runner', announceMs: 200, durationMs: 12000, x: A.pos.x > 1500 ? A.pos.x - 260 : A.pos.x + 260, y: A.pos.y, speed: 50 });
  const cancelled = await waitFor(() => log.A.some(x => x[0] === 'ev:end' && x[1].cancelled && x[1].kind === 'treasure'), 1000); await sleep(250);
  ok(cancelled && Array.from(A.orbs.values()).every(o => o.t !== 't'), 'forcing a new event cancels the running one (its treasures vanish)');
  await waitEv('A', 'ev:start', 5, 2000);
  const t0 = Date.now();
  while (!log.A.some(x => x[0] === 'ev:end' && x[1].kind === 'runner') && Date.now() - t0 < 11000) {
    const p = rn[rn.length - 1]; if (p) { const dx = p[0] - A.pos.x, dy = p[1] - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); }
    await sleep(50);
  }
  await sleep(300);
  const re = last('A', 'ev:end'), rb = last('B', 'ev:end');
  ok(rn.length > 10 && re && re.kind === 'runner' && re.outcome === 'caught' && re.results[0].name === A.profile.name && JSON.stringify(re.you.reward) === JSON.stringify(G.EVENTS.runner.reward) &&
    shards(A) - sA1 === G.EVENTS.runner.reward.shards && A.profile.balance - bA1 >= G.EVENTS.runner.reward.orbs, `«Сфера-беглец»: A caught it (+${G.EVENTS.runner.reward.orbs} ◉ + ${G.EVENTS.runner.reward.shards} 💎), position streamed while active`);
  ok(rb && rb.kind === 'runner' && rb.you === null && rb.outcome === 'caught', 'others learn the runner was caught');
  const st = A.profile.stats;
  ok(st.eventsPlayed >= 4 && st.eventWins >= 2, `event stats counted (played ${st.eventsPlayed}, won ${st.eventWins})`);
  const allEv = received.filter(x => /^ev:/.test(x)).join('\n');
  ok(!/"id"|"pid"|token|hash|"ip"/i.test(allEv), 'event payloads carry nicknames and scores only (no ids, tokens or private data)');
  A.close(); B.close(); C.close();
}

// «Лавка осколков»: exclusives for shards only (needs hooks)
async function pushSuite(URL) {
  console.log('--- player pushing');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('PushA' + rnd()); await B.register('PushB' + rnd());
  const D = G.PLAYER_R * 2, dist = () => Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y);
  // pure rule: overlapping circles end up exactly touching, inside the world
  const pr = [{ x: 500, y: 500 }, { x: 500, y: 500 }, { x: 20, y: 20 }, { x: 30, y: 25 }]; G.separatePlayers(pr); G.separatePlayers(pr);
  ok(Math.hypot(pr[0].x - pr[1].x, pr[0].y - pr[1].y) >= D - 0.01 && Math.hypot(pr[2].x - pr[3].x, pr[2].y - pr[3].y) >= D - 0.5 && pr.every(p => p.x >= G.PLAYER_R && p.y >= G.PLAYER_R), 'separatePlayers: stacked / cornered players are pushed apart, never out of bounds');
  await A.emit('test:tp', { x: 1500, y: 2700 }); await B.emit('test:tp', { x: 1500, y: 2700 });
  await sleep(300);
  ok(dist() >= D - 0.5 && dist() < D + 15, `two players on the same spot get separated (distance ${dist().toFixed(1)}, min ${D})`);
  await A.emit('test:tp', { x: 1000, y: 2700 }); await B.emit('test:tp', { x: 1060, y: 2700 }); await sleep(200);
  const b0 = { ...B.pos };
  let minD = 1e9;
  for (let i = 0; i < 30; i++) { A.s.emit('input', { s: ++A.seq, x: 1, y: 0 }); await sleep(50); minD = Math.min(minD, dist()); }
  await sleep(200);
  const pushed = B.pos.x - b0.x, maxIdeal = G.speedFor(0) * 1.5 + 40;
  ok(pushed > 120 && pushed < maxIdeal && minD > D - 13 && Math.abs(B.pos.y - b0.y) < 5, `a walking player shoves a standing one: B moved ${pushed.toFixed(0)} px in 1.5 s (A walks ≤ ${(G.speedFor(0) * 1.5).toFixed(0)}), never overlapping much (min ${minD.toFixed(1)})`);
  // against the world edge: B stays in bounds, A can't walk through
  await B.emit('test:tp', { x: G.WORLD.w - G.PLAYER_R, y: 2000 }); await A.emit('test:tp', { x: G.WORLD.w - 100, y: 2000 }); await sleep(200);
  for (let i = 0; i < 20; i++) { A.s.emit('input', { s: ++A.seq, x: 1, y: 0 }); await sleep(50); }
  await sleep(200);
  ok(B.pos.x <= G.WORLD.w - G.PLAYER_R && A.pos.x < B.pos.x && dist() >= D - 1, `pinned at the wall: B stays in the world (x ${B.pos.x}), A stops against B (gap ${dist().toFixed(1)})`);
  A.close(); B.close();
}

async function shardShopSuite(URL) {
  console.log('--- «Лавка осколков»');
  const S = makeClient(URL), W = makeClient(URL);
  await S.register('Shards' + rnd()); await W.register('Look' + rnd());
  const shards = () => S.profile.inventory.filter(x => x.id === G.SHARD_ID).reduce((n, x) => n + x.q, 0);
  let r = await S.emit('shard:buy', 'c_void');
  ok(!r.ok && r.code === 'shards' && /нужно 40, у вас 0/.test(r.error), 'not enough shards → refused: ' + r.error);
  await S.emit('test:orbs', 100000);
  const bal = S.profile.balance;
  r = await S.emit('buy', 'c_void');
  ok(!r.ok && r.code === 'exclusive' && S.profile.balance === bal && !S.profile.inventory.some(x => x.id === 'c_void'), 'exclusives cannot be bought with orbs: ' + r.error);
  await S.emit('test:grant', { id: G.SHARD_ID, qty: 45, source: 'event' });
  r = await S.emit('shard:buy', 'c_void');
  const slot = S.profile.inventory.find(x => x.id === 'c_void');
  ok(r.ok && r.spent === 40 && shards() === 5 && slot && slot.src === 'shard_shop' && S.profile.balance === bal, 'bought «Пустота» for exactly 40 shards (5 left, orbs untouched, source "shard_shop")');
  const dup = await S.emit('shard:buy', 'c_void'), plain = await S.emit('shard:buy', 'c_coral'), proto = await S.emit('shard:buy', '__proto__');
  ok(!dup.ok && dup.code === 'owned' && !plain.ok && !proto.ok && shards() === 5, 'owned / non-exclusive / bogus ids refused, no shards taken');
  await S.emit('inv:equip', 'c_void');
  ok(!!(await waitFor(() => { const m = W.metas.get(S.id); return m && m.eq.color === 'c_void'; })), 'exclusive can be worn; other players see it');
  const bad = await Promise.all([0, 100, 2.5, '3', null].map(q => S.emit('shard:exchange', q)));
  const tooMany = await S.emit('shard:exchange', 6);
  const tot = S.profile.total, b2 = S.profile.balance;
  const ex = await S.emit('shard:exchange', 2);
  ok(bad.every(x => !x.ok) && !tooMany.ok && ex.ok && shards() === 3 && S.profile.balance === b2 + 2 * G.SHARD_EXCHANGE.orbs && S.profile.total === tot,
    `exchange: invalid amounts refused, 2 💎 → +${2 * G.SHARD_EXCHANGE.orbs} ◉ (balance only, all-time total unchanged)`);
  await sleep(5100); // shard actions are rate-limited (8 per 5 s)
  // full inventory: buying fails all-or-nothing, the shards stay
  const free = G.INV_SLOTS - S.profile.inventory.length, top = S.profile.inventory.filter(x => x.id === G.SHARD_ID).pop();
  await S.emit('test:grant', { id: G.SHARD_ID, qty: (99 - top.q) + 99 * free, source: 'event' });
  const have = shards();
  r = await S.emit('shard:buy', 'n_shard');
  ok(S.profile.inventory.length === G.INV_SLOTS && !r.ok && r.code === 'full' && shards() === have && !S.profile.inventory.some(x => x.id === 'n_shard'), `inventory full → purchase refused, all ${have} shards kept (all-or-nothing)`);
  const shop = await (await fetch(URL + '/api/shop')).json();
  ok(shop.shardExchange.orbs === G.SHARD_EXCHANGE.orbs && shop.items.filter(i => i.exclusive).length === G.ITEMS.filter(i => i.exclusive).length && shop.events.koth.name === 'Царь горы', '/api/shop lists exclusives, events and the exchange rate');
  S.close(); W.close();
}

// automatic scheduler (short timers on a dedicated server)
async function schedulerSuite() {
  console.log('\n===== event scheduler (short timers) =====');
  const tmp = path.join(os.tmpdir(), `ocs-sched-${process.pid}.json`);
  const srv = await startServer(3107, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1', EVENT_EVERY_MS: '2000', EVENT_ANNOUNCE_MS: '1000', EVENT_DURATION_MS: '2500', LEGENDARY_EVERY_MS: '60000' });
  await sleep(3000);
  const h0 = await (await fetch(srv.url + '/api/health')).json();
  ok(h0.event === null, 'no event while nobody is online (the clock only runs with players)');
  const P = makeClient(srv.url);
  const evs = [], legends = [];
  for (const e of ['ev:announce', 'ev:start', 'ev:end']) P.s.on(e, d => evs.push({ e, kind: d.kind, at: Date.now(), d }));
  P.s.on('s', st => { for (const a of st.oa) if (a[3] === 'l') legends.push(Date.now()); });
  await P.register('Sched' + rnd());
  await P.emit('test:spawn', { types: ['l'], ring: 100 }); // a legendary orb is alive → no event may start
  await sleep(3500);
  ok(evs.length === 0, 'no event is announced while a legendary orb is on the field');
  const lo = Array.from(P.orbs.values()).find(o => o.t === 'l');
  for (let i = 0; i < 60 && lo && P.orbs.has(lo.id); i++) { const dx = lo.x - P.pos.x, dy = lo.y - P.pos.y, l = Math.hypot(dx, dy) || 1; P.s.emit('input', { s: ++P.seq, x: dx / l, y: dy / l }); await sleep(50); }
  await waitFor(() => evs.filter(x => x.e === 'ev:end').length >= 3, 22000);
  const seq = evs.map(x => x.e.slice(3)[0]).join('');
  const kinds = evs.filter(x => x.e === 'ev:announce').map(x => x.kind);
  const firstAnn = evs[0] && evs[0].d;
  ok(/^(ase){3}/.test(seq) && kinds.every((k, i) => !i || k !== kinds[i - 1]), `scheduler runs events back to back: ${kinds.join(' → ')} (announce → start → end, never the same kind twice in a row)`);
  ok(firstAnn && firstAnn.in >= 900 && firstAnn.in <= 1000 && firstAnn.dur === 2500, `announcement comes ${firstAnn && firstAnn.in} ms ahead; durations from EVENT_DURATION_MS`);
  ok(legends.length === 0 || legends.every(t => !evs.some((x, i) => x.e === 'ev:announce' && t >= x.at && t <= ((evs.slice(i).find(y => y.e === 'ev:end') || {}).at || Infinity))), 'no legendary orb spawns during an event');
  P.close();
  await sleep(1500);
  const h1 = await (await fetch(srv.url + '/api/health')).json();
  await sleep(2500);
  const h2 = await (await fetch(srv.url + '/api/health')).json();
  ok(h1.event === null && h2.event === null && h2.online === 0, 'the running event is cancelled when everyone leaves, and no new one starts');
  await srv.stop(); fs.rmSync(tmp, { force: true });
  return srv.logs;
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
  const skillMax = G.UPGRADES.skill.max; // worst case: «Мастер мини-игр» maxed
  const rushPerMin = (G.skillPrize(G.rushPrize(1e9), skillMax) - rush.fee) / ((rush.duration + rush.cooldownMs) / 60000);
  const reactPerMin = (G.skillPrize(G.REACTION_PRIZES[0][1], skillMax) - re.fee) / ((2500 + re.cooldownMs) / 60000);
  ok(rushPerMin < RATE * 0.5 && reactPerMin < RATE * 0.5, `perfect play with maxed «Мастер мини-игр» nets at most ${rushPerMin.toFixed(0)} (rush) / ${reactPerMin.toFixed(0)} (reaction) orbs/min, farming ≈${RATE}`);
  const TIERS = { common: [150, 500], rare: [400, 1500], epic: [1800, 4000], legendary: [9000, 20000] };
  const outOfTier = sold.filter(i => i.price < TIERS[i.rarity][0] || i.price > TIERS[i.rarity][1]);
  ok(!outOfTier.length, `every shop item priced inside its tier (common 150–500, rare 400–1500, epic 1800–4000, legendary 9000–20000)${outOfTier.length ? ': ' + outOfTier.map(i => i.id).join(',') : ''}`);
  const old = OLD_PRICES, changed = Object.keys(old).filter(id => !G.ITEM_BY_ID[id] || G.ITEM_BY_ID[id].price !== old[id]);
  ok(!changed.length, `existing items (${Object.keys(old).length}) keep their ids and prices${changed.length ? ': ' + changed.join(',') : ''}`);
  const NEW = G.ITEMS.filter(i => !has(old, i.id) && !i.exclusive);
  const perCat = G.CATEGORIES.map(c => [c.key, NEW.filter(i => i.cat === c.key)]);
  ok(perCat.every(([, l]) => l.length >= 6 && l.length <= 10) && perCat.every(([, l]) => new Set(l.map(i => i.rarity)).size >= 3),
    'new cosmetics: ' + perCat.map(([k, l]) => `${k} +${l.length}`).join(', ') + ' (6–10 per category, ≥3 rarities each)');
  ok(G.ITEMS.every(i => i.type !== 'cosmetic' || typeof i.value === 'string') && new Set(G.ITEMS.map(i => i.id)).size === G.ITEMS.length, 'item ids unique, every cosmetic has a visual value');
  const paintVals = G.ITEMS.filter(i => (i.cat === 'color' || i.cat === 'nameColor') && !/^#[0-9a-f]{6}$/i.test(i.value) && i.value !== 'rainbow').map(i => i.value);
  ok(paintVals.every(v => has(G.PAINTS, v)), `multi-colour values all defined in G.PAINTS (${paintVals.join(', ')})`);
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

async function newGamesSuite(URL) {
  console.log('--- menu mini-games: Память / Угадай чашу / Точный бросок / Цепочка');
  const M = G.MINIGAMES, maxSkill = G.UPGRADES.skill.max, FARM = 100;
  // economy: even flawless back-to-back play with «Мастер мини-игр» maxed earns < half of farming (≈ 100/min)
  const rates = ['reaction', 'rush', 'memory', 'shell', 'throw', 'chain'].map(k => {
    const mx = k === 'reaction' ? G.REACTION_PRIZES[0][1] : M[k].maxPrize;
    return [k, (G.skillPrize(mx, maxSkill) - M[k].fee) / (G.minigameMinMs(k) + M[k].cooldownMs) * 60000];
  });
  ok(rates.every(([, r]) => r < FARM / 2), 'flawless play incl. cooldowns + «Мастер мини-игр» 3 stays < 50/min: ' + rates.map(([k, r]) => `${k} ${r.toFixed(0)}`).join(', '));
  ok(M.shell.prize / M.shell.cups < M.shell.fee && G.memoryPrize(M.memory.freeRounds) === 0 && G.memoryPrize(99) === M.memory.maxPrize && G.throwPrize(999) === M.throw.maxPrize &&
    G.throwPoints(0) > G.throwPoints(0.03) && G.throwPoints(0.03) > G.throwPoints(0.05) && G.throwPoints(0.2) === 0 && G.chainPrize(1000) === M.chain.maxPrize && G.chainPrize(99999) === 0,
    `payout tables: blind shell guess EV ${(M.shell.prize / 3).toFixed(1)} < fee ${M.shell.fee}; memory ≤ ${M.memory.maxPrize}, throw ≤ ${M.throw.maxPrize} (closer = more), chain ≤ ${M.chain.maxPrize}`);
  const cl = []; const mk = async n => { const c = makeClient(URL); await c.register(n + rnd()); await c.emit('test:orbs', 500); cl.push(c); return c; };
  const once = (c, ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); c.s.once(ev, d => { clearTimeout(t); res(d); }); });
  // «Память»
  const A = await mk('Mem'), B = await mk('Mem');
  let bal = A.profile.balance, show = once(A, 'mg:memory:show'), result = once(A, 'mg:result', 20000);
  ok((await A.emit('mg:start', 'memory')).ok, 'memory started');
  let sh = await show; await sleep(G.memoryShowMs(1) + 200);
  show = once(A, 'mg:memory:show');
  let r = await A.emit('mg:act', { round: 1, input: sh.seq });
  sh = await show;
  ok(r.ok && r.right && sh.round === 2 && sh.seq.length === 2, 'memory: round 1 repeated → round 2 shows a sequence of 2 (only the part played so far)');
  r = await A.emit('mg:act', { round: 2, input: sh.seq }); // instantly, before the sequence could even be shown
  let res = await result; await sleep(150);
  ok(r.cheat && res.prize === 0 && /отклонён/.test(res.message) && A.profile.balance === bal - M.memory.fee, 'memory: answer faster than the sequence is shown → rejected, prize 0');
  r = await A.emit('mg:start', 'memory');
  ok(!r.ok && r.cooldown > 0, 'memory cooldown: ' + r.error);
  bal = B.profile.balance; result = once(B, 'mg:result', 30000); show = once(B, 'mg:memory:show');
  await B.emit('mg:start', 'memory');
  for (let round = 1; round <= 4; round++) {
    sh = await show; await sleep(G.memoryShowMs(round) + round * 150);
    if (round === 1) ok(!(await B.emit('mg:act', { round: 2, input: sh.seq })).ok && !(await B.emit('mg:act', { round: 1, input: [0, 1, 2, 3, 0] })).ok, 'memory: wrong round / over-long input refused');
    if (round < 4) show = once(B, 'mg:memory:show');
    const input = round < 4 ? sh.seq : sh.seq.map((c, i) => (i === round - 1 ? (c + 1) % 4 : c));
    r = await B.emit('mg:act', { round, input });
  }
  res = await result; await sleep(150);
  ok(res.rounds === 3 && res.prize === G.memoryPrize(3) && B.profile.balance === bal - M.memory.fee + res.prize, `memory: 3 rounds then a mistake → ${res.prize} (= ${M.memory.perRound} × (3 − ${M.memory.freeRounds}))`);
  // «Угадай чашу»
  const C = await mk('Cup'), D = await mk('Cup');
  let setup = once(C, 'mg:shell:setup'); result = once(C, 'mg:result');
  await C.emit('mg:start', 'shell'); let su = await setup;
  ok(su.swaps.length === M.shell.swaps && su.swaps.every(([a, b]) => a !== b && a >= 0 && b < 3) && !('final' in su) && !('cup' in su), 'shell: setup has the start + visible swaps only (no hidden cup field)');
  r = await C.emit('mg:act', { cup: 0 }); res = await result;
  ok(r.cheat && res.prize === 0 && Number.isInteger(res.cup), 'shell: picking before the shuffle ends → rejected, prize 0');
  bal = D.profile.balance; setup = once(D, 'mg:shell:setup'); result = once(D, 'mg:result', 15000);
  await D.emit('mg:start', 'shell'); su = await setup;
  const fin = G.shellFinal(su.start, su.swaps);
  await sleep(G.shellShuffleMs(su.swaps) + 100);
  ok(!(await D.emit('mg:act', { cup: 7 })).ok, 'shell: invalid cup refused');
  await D.emit('mg:act', { cup: fin }); res = await result; await sleep(150);
  ok(res.cup === fin && res.pick === fin && res.prize === M.shell.prize && D.profile.balance === bal - M.shell.fee + M.shell.prize, `shell: following the swaps finds the orb (revealed cup ${res.cup} = animation result) → +${res.prize}`);
  // «Точный бросок»
  const E = await mk('Throw');
  bal = E.profile.balance; result = once(E, 'mg:result', 30000);
  const got = [];
  E.s.on('mg:throw:start', async d => {
    const early = await E.emit('mg:act', { i: d.i, pts: 10, pos: d.target });
    // aim: wait until the marker is near the target (server time, RTT-compensated server-side)
    let t = 400; while (Math.abs(G.throwPos(t, d.period, d.phase) - d.target) > 0.01 && t < 4000) t += 5;
    await sleep(t);
    const st = await E.emit('mg:act', { i: d.i, pts: 10 }); const dup = await E.emit('mg:act', { i: d.i });
    got.push({ d, early, st, dup });
  });
  await E.emit('mg:start', 'throw'); res = await result; await sleep(150);
  ok(got.length === 3 && got.every(g => g.early.early && !g.early.ok && g.st.ok && !g.dup.ok && g.st.pts === G.throwPoints(Math.abs(g.st.pos - g.d.target))),
    'throw: stop < 250 ms refused, double stop refused, points computed by the server from time (claimed pts ignored): ' + got.map(g => g.st.pts).join('/'));
  ok(res.total === got.reduce((n, g) => n + g.st.pts, 0) && res.prize === G.throwPrize(res.total) && res.prize <= M.throw.maxPrize && E.profile.balance === bal - M.throw.fee + res.prize,
    `throw: 3 throws → ${res.total} points → prize ${res.prize} (cap ${M.throw.maxPrize})`);
  // «Цепочка»
  const F = await mk('Chain');
  bal = F.profile.balance; setup = once(F, 'mg:chain:setup'); result = once(F, 'mg:result', 20000);
  await F.emit('mg:start', 'chain'); su = await setup;
  const o = su.orbs;
  const pre = await F.emit('mg:act', { n: 1, x: o[0].x, y: o[0].y });
  await sleep(su.startIn + 50);
  const order = await F.emit('mg:act', { n: 2, x: o[1].x, y: o[1].y }), far = await F.emit('mg:act', { n: 1, x: o[0].x + 200, y: o[0].y });
  const t1 = await F.emit('mg:act', { n: 1, x: o[0].x, y: o[0].y }), fast = await F.emit('mg:act', { n: 2, x: o[1].x, y: o[1].y });
  ok(o.length === M.chain.n && !pre.ok && !order.ok && !far.ok && t1.ok && fast.fast, 'chain: taps before the start, out of order, off the orb or faster than 120 ms apart are refused');
  for (let n = 2; n <= M.chain.n; n++) { await sleep(M.chain.minTapGapMs + 15); r = await F.emit('mg:act', { n, x: o[n - 1].x + 5, y: o[n - 1].y - 5 }); }
  res = await result; await sleep(150);
  ok(r.done && res.ms > 0 && res.prize === G.chainPrize(res.ms) && F.profile.balance === bal - M.chain.fee + res.prize, `chain: 1…${M.chain.n} in ${res.ms} ms → +${res.prize}`);
  r = await F.emit('mg:start', 'chain');
  ok(!r.ok && r.cooldown > 0, 'chain cooldown: ' + r.error);
  for (const c of cl) c.close();
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

// upgrades in the arena: purchases, caps, multiplier (exact, server-side), luck consistency, speed, mini-game skill
async function upgradeSuite(URL) {
  console.log('--- upgrades (arena, server-authoritative)');
  const A = makeClient(URL), W = makeClient(URL);
  await A.register('Upgr' + rnd()); await W.register('Watch' + rnd());
  await A.emit('test:orbs', 200000);
  const bal0 = A.profile.balance;
  let spent = 0, okAll = true;
  for (const k of G.UPGRADE_KEYS) for (let l = 0; l < G.UPGRADES[k].max; l++) { const r = await A.emit('upgrade', k); okAll = okAll && r.ok && r.profile.upgrades[k] === l + 1; spent += G.UPGRADES[k].prices[l]; }
  const over = await A.emit('upgrade', 'mult');
  ok(okAll && A.profile.balance === bal0 - spent && !over.ok && /Максимальный/.test(over.error), `all 6 upgrades bought level by level to max for ${spent} (exact price table), level above max refused`);
  ok(!(await A.emit('upgrade', 'hasOwnProperty')).ok && !(await A.emit('upgrade', { k: 1 })).ok, 'unknown / non-string upgrade keys rejected');
  const pub = JSON.stringify(Array.from(W.metas.values()));
  ok(!/upgrades|"mult"|"luck"/.test(pub), 'other players never see upgrade levels');
  // multiplier: exact server-side accounting (luck off) — every collected orb counts value × 1.25 with carried fractions
  await A.emit('test:upgrades', { mult: 5, luck: 0, magnet: 0, speed: 0 });
  const types = new Map(Array.from(A.orbs.values()).map(o => [o.id, o.t]));
  let raw = 0, counted = 0;
  const onState = st => { for (const [id, , , t] of st.oa) types.set(id, t); for (const [id, by] of st.od) if (by === A.id) { raw += G.ORB_TYPES[types.get(id)].value; counted++; } };
  A.s.on('s', onState);
  const start = A.profile.balance;
  await A.farm(start + 80, 40000); await sleep(400); // orb tiers: +80 ≈ 10+ pickups
  A.s.off('s', onState);
  const gained = A.profile.balance - start, expect = raw + Math.floor(raw * 0.25 + 1e-9);
  ok(counted >= 6 && Math.abs(gained - expect) <= 1, `«Множитель сфер» max: ${counted} orbs worth ${raw} → +${gained} (expected ${expect}, fractions carried)`);
  // luck: only ever adds (×2 per lucky orb), reported via bal.l
  await A.emit('test:upgrades', { mult: 0, luck: 5 });
  let luckyEv = 0, jackEv = 0, raw2 = 0; const onBal = b => { luckyEv += b.l || 0; jackEv += b.j || 0; };
  const onState2 = st => { for (const [id, , , t] of st.oa) types.set(id, t); for (const [id, by] of st.od) if (by === A.id) raw2 += G.ORB_TYPES[types.get(id)].value; };
  A.s.on('bal', onBal); A.s.on('s', onState2);
  const s2 = A.profile.balance;
  await A.farm(s2 + 40, 40000); await sleep(400);
  A.s.off('bal', onBal); A.s.off('s', onState2);
  const g2 = A.profile.balance - s2;
  ok(g2 >= raw2 && g2 <= 2 * (raw2 + 9 * jackEv) && (luckyEv + jackEv > 0) === (g2 > raw2), `«Удача» max: ${raw2} orb value → +${g2} (${luckyEv} lucky ×2, ${jackEv} «находка» pickups; never less than the base)`);
  // speed: exactly 10 inputs move exactly 10 × speed × step; stored levels above the max are clamped
  const capped = await A.emit('test:upgrades', { speed: 99 });
  ok(capped.ok && capped.profile.upgrades.speed === G.UPGRADES.speed.max, 'a level above the max is clamped to the max');
  const B = makeClient(URL); await B.register('Base' + rnd());
  await A.emit('test:tp', { x: 700, y: 400 }); await B.emit('test:tp', { x: 2300, y: 2600 }); // away from everyone (players push each other)
  await sleep(300);
  const moveTen = async c => { const p0 = { ...c.pos }; const dir = p0.x > G.WORLD.w / 2 ? -1 : 1; for (let i = 0; i < 10; i++) c.s.emit('input', { s: ++c.seq, x: dir, y: 0 }); await sleep(900); return Math.hypot(c.pos.x - p0.x, c.pos.y - p0.y); };
  const [dA, dB] = await Promise.all([moveTen(A), moveTen(B)]);
  ok(Math.abs(dA - 10 * G.speedFor(5) * G.STEP_DT) < 1 && Math.abs(dB - 10 * G.speedFor(0) * G.STEP_DT) < 1,
    `speed upgrade applied server-side and capped: 10 inputs → ${dA.toFixed(1)} px (max level) vs ${dB.toFixed(1)} px (base)`);
  // mini-game skill: reaction prize × 1.3
  await A.emit('test:upgrades', { skill: 3 });
  const res = new Promise(r => A.s.once('mg:result', r));
  A.s.once('mg:reaction:go', () => setTimeout(() => A.s.emit('mg:reaction:click'), 120));
  await A.emit('mg:start', 'reaction');
  const rr = await res;
  const base = (G.REACTION_PRIZES.find(([ms]) => rr.rt < ms) || [0, 0])[1];
  ok(rr.prize === G.skillPrize(base, 3) && (base === 0 || rr.bonus === rr.prize - base), `«Мастер мини-игр» lvl 3: reaction prize ${base} → ${rr.prize}`);
  A.close(); W.close(); B.close();
}

// income with every upgrade maxed vs none: N fresh servers per group, one greedy bot each (test/measure-earn-rate.js), run in parallel
// with the other suites. The README target is +60–80 %; single short runs are noisy, so the check uses a wider band.
async function incomeSuite() {
  const N = 3, SEC = Number(process.env.OCS_INCOME_SEC) || 75;
  const runOne = async (port, maxed) => {
    const tmp = path.join(os.tmpdir(), `ocs-income-${process.pid}-${port}.json`);
    const srv = await startServer(port, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    const out = await new Promise(res => {
      const p = spawn(process.execPath, [path.join(__dirname, 'measure-earn-rate.js'), '1', String(SEC), srv.url], { env: Object.assign({}, process.env, maxed ? { UPGRADES: 'max' } : { UPGRADES: '' }) });
      let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; }); p.on('exit', () => res(o));
    });
    await srv.stop(); fs.rmSync(tmp, { force: true });
    const m = /avg (\d+)/.exec(out); return m ? Number(m[1]) : NaN;
  };
  const all = await Promise.all(Array.from({ length: 2 * N }, (_, i) => runOne(3130 + i, i >= N)));
  return { none: all.slice(0, N), max: all.slice(N) };
}
function incomeReport(r) {
  console.log('--- income: all upgrades maxed vs none');
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const ratio = avg(r.max) / avg(r.none);
  ok(avg(r.none) >= 80 && avg(r.none) <= 125, `income without upgrades ≈ ${Math.round(avg(r.none))} orbs/min (target ≈100)`);
  ok(r.none.concat(r.max).every(Number.isFinite) && ratio >= 1.35 && ratio <= 2.1,
    `income ×${ratio.toFixed(2)} with everything maxed (none ${r.none.join('/')} → max ${r.max.join('/')} orbs/min; target +60–80 %, band 1.35–2.1 for run-to-run noise)`);
}

// every new cosmetic: buy → equip (others see it) → trash
async function newItemsSuite(URL) {
  console.log('--- new cosmetics: buy / equip / trash');
  const N = makeClient(URL), W = makeClient(URL);
  await N.register('Shopper' + rnd()); await W.register('Viewer' + rnd());
  const list = NEW_ITEMS();
  const total = list.reduce((n, i) => n + i.price, 0);
  await N.emit('test:orbs', total + 10);
  const bad = [];
  for (const it of list) {
    const b = await N.emit('buy', it.id);
    if (!b.ok || !b.profile.inventory.some(x => x.id === it.id && x.src === 'shop')) { bad.push('buy:' + it.id); continue; }
    const e = await N.emit('inv:equip', it.id);
    if (!e.ok || e.profile.equipped[it.cat] !== it.id) bad.push('equip:' + it.id);
  }
  ok(!bad.length && N.profile.balance === 10, `all ${list.length} new items bought (total ${total}) and equipped${bad.length ? ' — failed: ' + bad.join(', ') : ''}`);
  const meta = await waitFor(() => { const m = W.metas.get(N.id); return m && m.eq.hat === list.filter(i => i.cat === 'hat').pop().id && m; });
  ok(!!meta, 'other players receive the new look (last equipped of each category): ' + (meta && JSON.stringify(meta.eq)));
  const dup = await N.emit('buy', list[0].id);
  ok(!dup.ok && dup.code === 'owned', 'buying an owned new item is refused');
  const tbad = [];
  for (let i = 0; i < list.length; i++) {
    if (i && i % 8 === 0) await sleep(5100); // trash is rate-limited to 8 per 5 s
    const r = await N.emit('inv:trash', { id: list[i].id, qty: 1 });
    if (!r.ok) tbad.push(list[i].id + ':' + r.error);
  }
  ok(!tbad.length && N.profile.inventory.length === 0 && JSON.stringify(N.profile.equipped) === JSON.stringify(G.DEFAULT_EQUIPPED),
    `all ${list.length} new items trashed (equipped ones reverted to the free defaults)${tbad.length ? ' — failed: ' + tbad.join(', ') : ''}`);
  N.close(); W.close();
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
  const share = k => types.filter(t => t === k).length / types.length;
  ok(share('c') > 0.7 && share('c') < 0.92 && share('u') > 0.05 && share('u') < 0.2 && share('r') > 0.01 && share('r') < 0.1 && types.every(t => has(G.POOL_WEIGHTS, t)),
    `tier shares of ${types.length} spawned orbs: ${['c', 'u', 'r', 'e', 'm'].map(k => k + ' ' + (share(k) * 100).toFixed(1) + '%').join(', ')} (weights ${Object.entries(G.POOL_WEIGHTS).map(([k, w]) => k + ' ' + w).join(', ')})`);
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
  const S3 = makeClient(URL), S0 = makeClient(URL);
  await S3.register('Sense' + rnd()); await S0.register('NoSense' + rnd());
  await S3.emit('test:upgrades', { sense: 3 });
  const warn3 = [], warn0 = [];
  S3.s.on('legend:soon', d => warn3.push(d)); S0.s.on('legend:soon', d => warn0.push(d));
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
  await waitFor(() => warn3.length, 4000);
  ok(warn3.length >= 1 && warn0.length === 0 && warn3.every(w => JSON.stringify(Object.keys(w)) === '["in"]' && w.in >= 0 && w.in <= 15000),
    `«Чутьё легенды» lvl 3 gets a heads-up before a legendary appears (${warn3.length}×, ${warn3[0] && warn3[0].in} ms ahead, no position), players without it get none`);
  A.close(); S3.close(); S0.close();
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
  ok(pr.stats.minigames === 7 && pr.stats.bestReaction === 212 && pr.stats.bestRush === 31 && pr.stats.sessions === 1 && pr.stats.eventsPlayed === 0 && pr.stats.eventWins === 0 && pr.createdAt === L.acc.createdAt, 'stats + creation date kept, new counters added (sessions, eventsPlayed, eventWins)');
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
    const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATABASE_URL: '', DATA_FILE: '', EVENT_EVERY_MS: '0' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (opts.full) { await chatSuite(srv.url); await gameplaySuite(srv.url); await minigameSuite(srv.url); await newGamesSuite(srv.url); await upgradeSuite(srv.url); await newItemsSuite(srv.url); await tiersSuite(srv.url); await eventSuite(srv.url); await pushSuite(srv.url); }
  await shardShopSuite(srv.url);
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
  } else if (process.env.OCS_TEST_ONLY === 'events') {
    tierEventRules();
    const tmp = path.join(os.tmpdir(), `ocs-ev-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await tiersSuite(srv.url); await eventSuite(srv.url); await pushSuite(srv.url); await shardShopSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
    privacyAudit(await schedulerSuite());
  } else if (process.env.OCS_TEST_ONLY === 'games') {
    const tmp = path.join(os.tmpdir(), `ocs-mg-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await minigameSuite(srv.url); await newGamesSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
  } else if (process.env.OCS_TEST_ONLY === 'upgrades') {
    upgradeRules();
    const tmp = path.join(os.tmpdir(), `ocs-up-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await upgradeSuite(srv.url); await newItemsSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
  } else {
    priceSanity();
    upgradeRules();
    tierEventRules();
    const income = process.env.OCS_TEST_INCOME === '0' ? null : incomeSuite();
    let logs = '';
    const tmp = path.join(os.tmpdir(), `ocs-test-${process.pid}.json`);
    const L1 = legacyAccount();
    seedLegacyJson(tmp, L1);
    logs += await runMode('JSON file mode', { DATA_FILE: tmp }, { full: true, legacy: L1 });
    fs.rmSync(tmp, { force: true });
    logs += await runCycleMode();
    logs += await schedulerSuite();
    if (process.env.TEST_DATABASE_URL) {
      const L2 = legacyAccount();
      await seedLegacyPg(process.env.TEST_DATABASE_URL, L2); // old (7c2dacd) schema + data, the new server must migrate it
      logs += await runMode('PostgreSQL mode', { DATABASE_URL: process.env.TEST_DATABASE_URL }, { full: false, legacy: L2 });
    } else console.log('\n(PostgreSQL mode skipped: set TEST_DATABASE_URL to run it)');
    if (income) incomeReport(await income);
    privacyAudit(logs);
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  for (const s of allSockets) s.close();
  setTimeout(() => process.exit(), 300);
})().catch(e => { console.error(e); process.exit(1); });
