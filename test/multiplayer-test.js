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
  c.call = (ev, ...args) => new Promise(res => { const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 10000); s.emit(ev, ...args, r => { clearTimeout(t); res(r); }); });
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
  c.emit = async (ev, ...args) => { const r = await c.call(ev, ...args); if (r && r.profile) c.profile = r.profile; return r; };
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
  ok(badRes.every(r => !r.ok && r.error && !/попыток|Подождите/.test(r.error)), 'bad nicknames rejected with the failed rule (never a lockout): ' + badRes.map((r, i) => `${bad[i]} → «${r.error}»`).slice(0, 4).join('; ') + ' …');
  const cyr = await v.call('auth', { mode: 'register', name: 'Иван', password: PASS, confirm: PASS });
  const after = await v.call('auth', { mode: 'register', name: 'zzOk_' + rnd(), password: PASS, confirm: PASS, enter: false });
  const tn = 'zzTrim' + rnd(), tv = makeClient(URL);
  const treg = await tv.call('auth', { mode: 'register', name: tn, password: ' ' + PASS + ' ', confirm: PASS + ' ', enter: false });
  const tl = await makeClient(URL).call('auth', { mode: 'login', name: tn, password: PASS, enter: false });
  ok(treg.ok && tl.ok, 'registration trims stray spaces around the password (phone keyboards); login with the clean password works');
  tv.close();
  ok(/латиницей/.test(cyr.error) && after.ok, `after ${bad.length + 1} rejected names the same page can still register (no lockout); Cyrillic → «${cyr.error}»`);
  v.close();
  { // login from a second device while the first one is playing: case-insensitive, trimmed, Cyrillic look-alikes, stray spaces in the password
    const nm = 'Moca' + rnd(), D1 = makeClient(URL), D2 = makeClient(URL), D3 = makeClient(URL), D4 = makeClient(URL);
    const r1 = await D1.register(nm);
    const r2 = await D2.login('  ' + nm.toUpperCase() + ' ');
    await sleep(300);
    ok(r1.ok && r2.ok && /другой вкладки или устройства/.test(D1.kicked || ''), 'second device logs in (upper case + spaces) while the first plays; the first gets a clear «kicked» message');
    const cyr = 'Мос' + 'а' + nm.slice(4); // М о с а — Cyrillic look-alikes from a Russian keyboard
    const r3 = await D3.login(cyr, ' ' + PASS + ' ');
    const D5 = makeClient(URL), r6 = await D5.login(nm.toLowerCase(), 'C' + PASS.slice(1));
    ok(r6.ok, 'password with the first letter auto-capitalised by a phone keyboard is accepted');
    D5.close();
    const r4 = await D4.call('auth', { mode: 'login', name: 'Дракон', password: PASS });
    const r5 = await D4.call('auth', { mode: 'login', name: nm, password: PASS + 'x' });
    ok(r3.ok && !r4.ok && r4.code === 'nick' && /английскими/.test(r4.error) && !r5.ok && r5.code === 'wrong', `Cyrillic look-alike nick + spaces around the password accepted; clear errors: «${r4.error}» / «${r5.error}»`);
    D1.close(); D2.close(); D3.close(); D4.close();
  }
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
  { const OLD = { magnet: [[200, 600, 1500, 3500, 7000], [0, 4, 8, 12, 15, 18]], speed: [[250, 700, 1800, 4000, 8000], [0, 3, 5, 7, 9, 11]], mult: [[350, 900, 2200, 5000, 10000], [0, 3, 6, 9, 12, 15]],
      luck: [[300, 800, 2000, 4500, 9000], [0, 1, 2, 3, 4, 5]], sense: [[400, 1200, 3000], [0, 1, 2, 3]], skill: [[200, 600, 1400], [0, 10, 20, 30]] };
    const priceOk = G.UPGRADE_KEYS.every(k => U[k].prices.every((p, i) => Math.abs(p - OLD[k][0][i] * 0.75) <= 5));
    const effOk = ['magnet', 'speed', 'mult', 'luck', 'skill'].every(k => U[k].values.every((v, i) => Math.abs(v - OLD[k][1][i] * 1.1) < 0.051)) && U.sense.values.join() === '0,1,2,3';
    ok(priceOk && effOk, `upgrade prices ×0.75 (e.g. magnet ${U.magnet.prices.join('/')}), numeric effects ×1.1 (speed ${U.speed.values.join('/')} %), compass unchanged`); }
  ok(G.UPGRADE_KEYS.join(',') === 'magnet,speed,mult,luck,sense,skill', 'upgrades: magnet, speed, orb multiplier, luck, legendary sense, mini-game skill');
  const dim = ['magnet', 'speed', 'mult', 'luck'].filter(k => { const v = U[k].values, inc = v.slice(1).map((x, i) => x - v[i]); return inc.every(d => d > 0) && inc.every((d, i) => !i || d <= inc[i - 1] + 1e-9); });
  ok(dim.length === 4, `diminishing (or flat for the multiplier) returns per level: ${dim.join(', ')}`);
  const RATE = 80;
  ok(G.UPGRADE_KEYS.every(k => U[k].prices.length === U[k].max && U[k].values.length === U[k].max + 1 && U[k].prices.every((v, i) => !i || v > U[k].prices[i - 1])), 'one price per level, strictly increasing; one effect value per level');
  ok(G.UPGRADE_KEYS.every(k => U[k].prices[0] >= 150 && U[k].prices[0] <= 300), 'first levels are cheap (150–300, −25 % since Oct 2026): ' + G.UPGRADE_KEYS.map(k => U[k].prices[0]).join('/'));
  const lastMax = ['magnet', 'speed', 'mult', 'luck'].map(k => U[k].prices[U[k].max - 1]);
  ok(lastMax.every(p => p / RATE / 60 >= 0.9 && p / RATE / 60 <= 1.9), `max levels cost ≈1–1.5 h of play each: ${lastMax.map(p => (p / RATE / 60).toFixed(1) + ' h').join(' / ')}`);
  // caps
  ok(G.speedFor(99) === G.speedFor(U.speed.max) && G.speedFor(-4) === G.BASE_SPEED && G.speedFor('x') === G.BASE_SPEED && G.speedFor(U.speed.max) <= G.BASE_SPEED * 1.125,
    `speed capped: max ${G.speedFor(U.speed.max).toFixed(0)} px/s (base ${G.BASE_SPEED}, ≤ +12.1 %), out-of-range levels clamp`);
  ok(G.pickupFor(99) === G.pickupFor(U.magnet.max) && G.pickupFor(U.magnet.max) <= G.PLAYER_R * 2, `soft magnet: pickup radius capped at ${G.pickupFor(U.magnet.max)} px (base ${G.PLAYER_R}, never clears the field)`);
  // multiplier with fractional carry: +5 % on 1-orb pickups must not be rounded away
  const sum = (n, v, ups, rnd) => { const st = { frac: 0 }; let t = 0; for (let i = 0; i < n; i++) t += G.orbReward(v, ups, st, rnd).value; return t; };
  ok(sum(100, 1, { mult: 1 }, () => 1) === 103 && sum(100, 1, { mult: 5 }, () => 1) === 116 && sum(33, 1, { mult: 1 }, () => 1) === 34 && sum(20, 5, { mult: 5 }, () => 1) === 116,
    'multiplier: 100×1 orb at +3.3 % → 103, at +16.5 % → 116 (fractions carried, never lost)');
  const lucky = G.orbReward(5, { luck: 5 }, {}, () => 0), unlucky = G.orbReward(5, { luck: 5 }, {}, () => 0.5), noLuck = G.orbReward(5, {}, {}, () => 0);
  ok(lucky.value === 10 && lucky.lucky && unlucky.value === 5 && !unlucky.lucky && noLuck.value === 5, `luck: ${U.luck.values[U.luck.max]} % chance at max to count an orb twice (roll < chance → ×2); levels 3–5 add a ${U.luck.jackpot.slice(3).join('/')} % «находка»`);
  ok(sum(20, 1, { mult: 5, luck: 5 }, () => 0) === 46, 'luck and multiplier stack (2 per orb +16.5 % → 46 for 20 orbs)');
  { // legendary: a normal spawn-table tier (no timer). Expected gap in a populated zone 1 ≈ 2 min.
    const W1 = G.POOL_WEIGHTS, W2 = G.ZONE2_WEIGHTS, sum = w => Object.values(w).reduce((a, b) => a + b, 0);
    const p1 = W1.l / sum(W1), p2 = W2.l / sum(W2);
    let seed = 12345; const prng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; // mulberry32
    const N = 200000; let hits = 0; for (let i = 0; i < N; i++) if (G.rollOrbType(W1, prng) === 'l') hits++;
    const spawnsPerMin = 3 * 70; // 3 players × ~70 pickups/min each = respawns/min in zone 1
    const gapMin = 1 / (p1 * spawnsPerMin);
    ok(Math.abs(hits / N - p1) < 0.0006 && Math.abs(p1 - 0.002) < 1e-9 && Math.abs(p2 - 0.008) < 1e-9 && G.ORB_TYPES.l.maxAliveZone[1] === 1 && G.ORB_TYPES.l.maxAliveZone[2] === 2 && gapMin > 1.5 && gapMin < 2.6,
      `legendary per-spawn chance: zone 1 ${(p1 * 100).toFixed(2)} % (rolled ${(hits / N * 100).toFixed(2)} % of ${N}), zone 2 ${(p2 * 100).toFixed(2)} % → ≈1 per ${gapMin.toFixed(1)} min with 3 players (${spawnsPerMin} spawns/min)`);
  }
  ok(G.skillPrize(16, 3) === 21 && G.skillPrize(16, 1) === 18 && G.skillPrize(16, 0) === 16 && G.skillPrize(0, 3) === 0 && G.skillPrize(40, 99) === 53, 'mini-game skill: +11/22/33 % on prizes > 0, capped at level 3');
  // one-time upgrade refund (old price table) → levels reset to 0; flag prevents a second refund; total untouched
  const INV = require('../lib/inventory.js'), RP = G.UPGRADE_REFUND_PRICES;
  const acc = { key: 'mig', name: 'Mig', passHash: 'x', balance: 100, total: 5, owned: [], equipped: {}, upgrades: { magnet: 3, speed: '2', mult: 5, bogus: 4, luck: -1, sense: 9 }, stats: {} };
  INV.migrateAccount(acc);
  const want = 100 + RP.magnet[0] + RP.magnet[1] + RP.magnet[2] + RP.speed[0] + RP.speed[1] + RP.mult.reduce((a, b) => a + b, 0) + RP.sense.reduce((a, b) => a + b, 0);
  ok(JSON.stringify(acc.upgrades) === JSON.stringify({ magnet: 0, speed: 0, mult: 0, luck: 0, sense: 0, skill: 0 }) && acc.balance === want && acc.total === 5 && acc.stats.upgradeRefundV1 === true,
    `refund migration: magnet 3 + speed 2 + mult 5 + sense (capped 3) → +${want - 100} orbs to the balance (total unchanged), all levels 0`);
  acc.upgrades.magnet = 2; const b = acc.balance; INV.migrateAccount(acc);
  ok(acc.balance === b && acc.upgrades.magnet === 2, 'refund runs once: a second migration keeps new levels and pays nothing');
}


// ------------------------------------------------------------------ zones + door (zone 1 | wall + door | zone 2 better odds)
async function zoneSuite(URL) {
  console.log('--- zones / door');
  const h = await (await fetch(URL + '/api/health')).json();
  ok(h.world && h.world.w === 2 * G.ZONE_W && h.world.h === G.ZONE_H && G.ZONE_W === 6000, `world ${h.world && h.world.w}×${h.world && h.world.h}: two zones of ${G.ZONE_W}×${G.ZONE_H} (was 3000×3000)`);
  const P = makeClient(URL);
  await P.register('Door' + rnd());
  ok(P.pos.x < G.ZONE_W, `new players spawn in zone 1 (x=${Math.round(P.pos.x)})`);
  const walkRight = async ms => { const t0 = Date.now(); while (Date.now() - t0 < ms) { P.s.emit('input', { s: ++P.seq, x: 1, y: 0 }); await sleep(50); } await sleep(200); };
  await P.emit('test:tp', { x: G.ZONE_W - 150, y: G.DOOR.y });
  await walkRight(1500);
  ok(P.pos.x <= G.ZONE_W - G.PLAYER_R + 0.5, `locked door blocks the way (stopped at x=${Math.round(P.pos.x)})`);
  const poor = await P.emit('door:unlock');
  ok(!poor.ok && poor.code === 'funds' && poor.error.includes(String(G.DOOR_COST)), 'unlock without enough orbs refused: ' + poor.error);
  await P.emit('test:orbs', G.DOOR_COST + 50); await sleep(200);
  const tot = P.profile.total, bal = P.profile.balance;
  const r = await P.emit('door:unlock');
  ok(r.ok && r.profile.stats.unlockedDoor2 === true && r.profile.balance === bal - G.DOOR_COST && r.profile.total === tot, `door unlocked for ${G.DOOR_COST} orbs (balance only, total unchanged)`);
  const again = await P.emit('door:unlock');
  ok(!again.ok && again.code === 'owned', 'second unlock refused (one-time purchase)');
  await P.emit('test:tp', { x: G.ZONE_W - 150, y: G.DOOR.y + G.DOOR.half + 120 }); // next to the wall, not at the door
  await walkRight(1200);
  ok(P.pos.x <= G.ZONE_W - G.PLAYER_R + 0.5, 'even when unlocked, the wall only opens at the door');
  await P.emit('test:tp', { x: G.ZONE_W - 150, y: G.DOOR.y });
  await walkRight(2200);
  ok(P.pos.x > G.ZONE_W + 100 && G.zoneOf(P.pos.x) === 2, `walked through the door into zone 2 (x=${Math.round(P.pos.x)})`);
  const z2 = Array.from(P.orbs.values()).filter(o => o.x > G.ZONE_W && !o.ev && o.t !== 'l'), z1 = Array.from(P.orbs.values()).filter(o => o.x < G.ZONE_W && o.t !== 'l' && !o.ev);
  const cnt = t => z2.filter(o => o.t === t).length;
  const mean = l => l.reduce((n, o) => n + G.ORB_TYPES[o.t].value, 0) / l.length;
  ok(z2.length >= 250 && cnt('c') > 0 && cnt('u') > 0 && cnt('r') > 0 && cnt('c') > z2.length * 0.55, `zone 2 has the same tiers incl. commons: ${z2.length} orbs (c ${cnt('c')}, u ${cnt('u')}, r ${cnt('r')}, e ${cnt('e')}, m ${cnt('m')})`);
  ok(mean(z2) > mean(z1) * 1.15 && mean(z2) < mean(z1) * 1.8 && Math.abs(z2.length - z1.length) < z1.length * 0.25,
    `zone 2: better odds, same density — mean orb ${mean(z2).toFixed(2)} vs zone 1 ${mean(z1).toFixed(2)}; counts ${z2.length} vs ${z1.length}`);
  P.close();
  // persisted: login again keeps the unlock
  const Q = makeClient(URL); const lr = await Q.login(P.profile.name);
  ok(lr.ok && lr.profile.stats.unlockedDoor2 === true, 'unlock persists on the account');
  Q.close();
}
// ------------------------------------------------------------------ orb tiers, compass, events, exclusives: pure rules
const OB0 = () => G.OBSTACLES;
function tierEventRules() {
  console.log('--- orb tiers / compass / events / «Лавка осколков» (rules)');
  const T = G.ORB_TYPES, keys = ['c', 'u', 'r', 'e', 'l', 'm'];
  ok(keys.map(k => T[k].value).join(',') === '1,2,5,10,25,50' && keys.every((k, i) => !i || T[k].r > T[keys[i - 1]].r) && new Set(keys.map(k => T[k].color)).size === keys.length,
    'tiers common +1, uncommon +2, rare +5, epic +10, legendary +25, mythic +50 — each bigger than the last, distinct colours');
  ok(T.l.weight > 0 && T.l.weight < T.e.weight && T.l.maxAlive === 2 && T.l.lifeMs === 75000 && T.t.weight === 0 && T.m.weight > 0 && T.m.shards === 3 && T.l.shards === 1 && T.m.maxAlive === 1, 'legendary is a random spawn tier (max 2 alive, 75 s), treasure only in events, mythic: random, max 1 alive, 3 shards');
  const ev = G.expectedOrbValue();
  ok(ev >= 1.35 && ev <= 1.5, `pool mean orb value ${ev.toFixed(3)} (old 1.4 → income stays ≈100/min)`);
  ok(G.expectedOrbValue(G.RAIN_WEIGHTS) > ev * 1.4, `«Сферный дождь» orbs are richer (mean ${G.expectedOrbValue(G.RAIN_WEIGHTS).toFixed(2)})`);
  let seed = 7; const prng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; // mulberry32
  const N = 400000, cnt = {}; for (let i = 0; i < N; i++) { const t = G.rollOrbType(G.POOL_WEIGHTS, prng); cnt[t] = (cnt[t] || 0) + 1; }
  const tot = Object.values(G.POOL_WEIGHTS).reduce((a, b) => a + b, 0);
  const off = Object.keys(G.POOL_WEIGHTS).filter(k => Math.abs(cnt[k] / N - G.POOL_WEIGHTS[k] / tot) > Math.max(0.002, 0.08 * G.POOL_WEIGHTS[k] / tot) && k !== 'm');
  ok(!off.length && cnt.l > 0 && !cnt.t && cnt.m > 0, 'roll distribution matches the weights: ' + Object.keys(cnt).map(k => `${k} ${(cnt[k] / N * 100).toFixed(2)}%`).join(', '));
  // luck: ×2 chance + «находка» (common/uncommon → epic +10) from level 3
  const seq = arr => { let i = 0; return () => arr[i++ % arr.length]; };
  ok(G.orbReward(1, { luck: 5 }, {}, seq([0, 0.5]), 'c').value === 10 && G.orbReward(1, { luck: 5 }, {}, seq([0, 0]), 'u').value === 20 && G.orbReward(5, { luck: 5 }, {}, seq([0, 0.5]), 'r').value === 10 &&
    G.orbReward(1, { luck: 2 }, {}, seq([0, 0.5]), 'c').value === 2 && G.jackpotChance(5) === 0.6 && G.jackpotChance(2) === 0,
    '«Удача»: find turns a common/uncommon orb into +10 (then ×2 may apply), never on rare+; only from level 3');
  const j = G.jackpotChance(5) / 100, pPool = G.POOL_WEIGHTS, ptot = Object.values(pPool).reduce((a, b) => a + b, 0);
  const cuShare = (pPool.c + pPool.u) / ptot, cuMean = (pPool.c * 1 + pPool.u * 2) / (pPool.c + pPool.u);
  const luckF = (ev + cuShare * j * (10 - cuMean)) / ev * (1 + G.upValue('luck', 5) / 100), analytic = luckF * (1 + G.upValue('mult', 5) / 100);
  ok(analytic >= 1.15 && analytic <= 1.35, `multiplier × luck at max ≈ ×${analytic.toFixed(3)} per orb (soft upgrades)`);
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
  ok(G.EVENT_KEYS.join(',') === 'rain,koth,treasure,runner,lucky' && G.AUTO_EVENT_KEYS.join(',') === 'treasure,runner,lucky' && E.treasure.count === 5 && E.runner.count === 3 && E.lucky.spawnMult === 1.25 && E.lucky.rareMult === 2 && E.lucky.durationMs >= 60000 && E.lucky.durationMs <= 90000 && E.rain.durationMs === 45000 && rewards.every(r => r.orbs + r.shards * G.SHARD_EXCHANGE.orbs <= 4 * RATE && r.shards <= 2) &&
    E.treasure.reward.orbs * E.treasure.maxCount <= 4 * RATE * 1.5, `5 events (auto: treasure ×5, runner ×3, lucky ×1.25 orbs / ×2 rare+ for ${E.lucky.durationMs / 1000} s); every reward (orbs + shards at the exchange rate) ≤ 4 min of farming (top: ${E.koth.rewards[0].orbs} ◉ + ${E.koth.rewards[0].shards} 💎)`);
  const S = G.EVENT_SCHEDULE;
  ok(S.minMs === 120000 && S.maxMs === 360000 && S.announceMs >= 20000 && S.announceMs <= 30000, 'schedule: an event every 2–6 min of online time, announced 25 s ahead');
  ok(OB0().maxAlive === 30 && OB0().everyMinMs === 6000 && OB0().everyMaxMs === 15000 && OB0().laserChance === 0.25, 'obstacles: a spawn every 6–15 s, up to 30 at once, 25 % lasers');
  const lw = G.luckyWeights(G.POOL_WEIGHTS), pw = G.POOL_WEIGHTS;
  ok(lw.c === pw.c && lw.u === pw.u && ['r', 'e', 'l', 'm'].every(t => lw[t] === pw[t] * 2), 'lucky weights: rare/epic/legendary/mythic ×2, common/uncommon unchanged');
  // obstacles: collision push-out + laser beam geometry + penalty
  const OB = G.OBSTACLES, R = G.PLAYER_R;
  const p1 = { x: 100, y: 100 }; G.resolveObstacles(p1, [{ k: 'rect', x: 100, y: 100, w: 200, h: 40 }]);
  const p2 = { x: 130, y: 100 }; G.resolveObstacles(p2, [{ k: 'circle', x: 100, y: 100, r: 50 }]);
  const p3 = { x: 300, y: 200 }; G.resolveObstacles(p3, [{ k: 'laser', x: 0, y: 0, r: 26, len: 300, w: 1 }]);
  ok(Math.abs(p1.y - 100) >= 20 + R - 0.01 && Math.abs(p2.x - 100 - (50 + R)) < 0.01 && p3.x === 300 && p3.y === 200, 'obstacles: players are pushed out of walls / rocks; laser beams are not solid');
  const L = { k: 'laser', x: 0, y: 0, len: 300, w: Math.PI / 2, a0: 0, t0: 0, armAt: 1000 };
  ok(!G.laserHits(L, 200, 0, 0) && G.laserHits(L, 0, 200, 1000) && !G.laserHits(L, 200, 0, 1000) && !G.laserHits(L, 0, 400, 1000),
    'laser: harmless during the warning, beam sweeps (90°/s here), length-limited');
  ok(G.laserPenalty(0) === 0 && G.laserPenalty(10) === 1 && G.laserPenalty(1000) === 70 && G.laserPenalty(1e6) === OB.penaltyMax && OB.invulnMs >= 2000 && OB.laserChance > 0 && OB.laserChance < 0.5 && OB.lifeMinMs === 45000 && OB.lifeMaxMs === 90000,
    `laser penalty ${OB.penaltyPct * 100}% of the balance, capped at ${OB.penaltyMax}, ${OB.invulnMs / 1000} s immunity; ${OB.laserChance * 100}% of obstacles are lasers; obstacles live 45–90 s`);
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
  ok(endA && endA.kind === 'rain' && (!endA.you || endA.you.score >= 0) && (endA.results[0] || { reward: null }).reward === null && rainOrbs.every(id => !A.orbs.has(id)), `rain results: A collected ${endA && endA.you && endA.you.score} worth of rain orbs (paid on pickup), leftovers removed at the end`);
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
  r = await A.emit('test:event', { kind: 'treasure', announceMs: 100, durationMs: 8000 });
  await waitEv('A', 'ev:start', 4, 2000); await sleep(200);
  const spots = Array.from(A.orbs.values()).filter(o => o.t === 't');
  let minPair = Infinity; for (const a of spots) for (const b of spots) if (a !== b) minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.y - b.y));
  ok(spots.length === 5 && minPair >= G.EVENTS.treasure.minDist && spots.every(o => o.x > 0 && o.x < G.WORLD.w && o.y > 0 && o.y < G.WORLD.h && Math.abs(o.x - G.ZONE_W) > 100),
    `5 treasures at random places on the whole map (closest pair ${Math.round(minPair)} px; zones ${spots.map(o => G.zoneOf(o.x)).join('')})`);
  // runner (slowed down by the hook so the bot can catch it)
  const sA1 = shards(A), bA1 = A.profile.balance; rn.length = 0;
  r = await A.emit('test:event', { kind: 'runner', announceMs: 200, durationMs: 8000, x: A.pos.x > 1500 ? A.pos.x - 260 : A.pos.x + 260, y: A.pos.y, speed: 50 });
  const cancelled = await waitFor(() => log.A.some(x => x[0] === 'ev:end' && x[1].cancelled && x[1].kind === 'treasure'), 1000); await sleep(250);
  ok(cancelled && Array.from(A.orbs.values()).every(o => o.t !== 't'), 'forcing a new event cancels the running one (its treasures vanish)');
  await waitEv('A', 'ev:start', 5, 2000);
  const t0 = Date.now();
  while (!log.A.some(x => x[0] === 'ev:end' && x[1].kind === 'runner') && Date.now() - t0 < 10000) {
    const p = rn.length && rn[rn.length - 1].find(q => q[0] === 1);
    if (p) { const dx = p[1] - A.pos.x, dy = p[2] - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); }
    await sleep(50);
  }
  await sleep(300);
  const re = last('A', 'ev:end'), rb = last('B', 'ev:end');
  const r0 = rn[0] || [], rIds = new Set(rn.flat().map(q => q[0]));
  ok(r0.length === 3 && rIds.size === 3 && re && re.caught === 1 && re.total === 3 && re.outcome === 'partial' && rn.every(l => l.every(q => q.length === 3)), `3 runaway orbs spawned (${r0.map(q => q[0] + '@' + q[1] + ',' + q[2]).join(' ')}); caught ${re && re.caught}/${re && re.total} → outcome «${re && re.outcome}»`);
  ok(rn.length > 10 && re && re.kind === 'runner' && re.results[0].name === A.profile.name && JSON.stringify(re.you.reward) === JSON.stringify(G.EVENTS.runner.reward) &&
    shards(A) - sA1 === G.EVENTS.runner.reward.shards && A.profile.balance - bA1 >= G.EVENTS.runner.reward.orbs, `«Раннеры»: A caught one (+${G.EVENTS.runner.reward.orbs} ◉ + ${G.EVENTS.runner.reward.shards} 💎), position streamed while active`);
  ok(rb && rb.kind === 'runner' && rb.you === null && rb.caught === 1, 'others learn how many runners were caught');
  const st = A.profile.stats;
  ok(st.eventsPlayed >= 3 && st.eventWins >= 2, `event stats counted (played ${st.eventsPlayed}, won ${st.eventWins})`);
  const allEv = received.filter(x => /^ev:/.test(x)).join('\n');
  ok(!/"id"|"pid"|token|hash|"ip"/i.test(allEv), 'event payloads carry nicknames and scores only (no ids, tokens or private data)');
  A.close(); B.close(); C.close();
}


// «Волна удачи» + temporary obstacles + rotating lasers (needs hooks; the server runs with OBSTACLES=0, the hook spawns them)
async function luckyObstacleSuite(URL) {
  console.log('--- lucky wave, obstacles, lasers');
  const A = makeClient(URL); await A.register('Obs' + rnd());
  const obsLog = [], zaps = [], ends = [], drops = new Set();
  A.s.on('obs', l => obsLog.push([Date.now(), l])); A.s.on('zap', z => zaps.push([Date.now(), z])); A.s.on('ev:end', d => ends.push(d));
  A.s.on('s', st => { for (const a of st.oa) if (a[4] && a[3] === 'c') drops.add(a[0]); });
  const pool = () => Array.from(A.orbs.values()).filter(o => o.t !== 't').length;
  // lucky: twice as many orbs on the map while it runs, score = orbs collected
  await sleep(1500); const n0 = pool();
  let r = await A.emit('test:event', { kind: 'lucky', announceMs: 100, durationMs: 14000 });
  await sleep(1500); // wait past the announcement so the wave is active
  const tgt = (await (await fetch(URL + '/api/health')).json()).targetOrbs * 2; // both zones, normal target
  const n1 = await waitFor(() => { const n = pool(); return n >= tgt * 1.25 * 0.97 ? n : 0; }, 11000) || pool();
  const h = await (await fetch(URL + '/api/health')).json();
  await A.farm(A.profile.balance + 30, 1500);
  await waitFor(() => ends.some(e => e.kind === 'lucky'), 15000);
  const le = ends.find(e => e.kind === 'lucky');
  ok(r.ok && h.event === 'lucky:active' && n1 >= tgt * 1.25 * 0.97 && n1 <= tgt * 1.25 * 1.05 + 40, `«Волна удачи»: orbs on the map ${n0} → ${n1} (normal target ${tgt}, ×${(n1 / tgt).toFixed(2)}) while active`);
  ok(le && !le.cancelled && le.you && le.you.score > 0, `lucky results: A collected ${le && le.you && le.you.score} worth during the wave`);
  // obstacles: solid, never spawned on a player, expire
  await A.emit('test:tp', { x: 2000, y: 2000, orbs: 2000 }); await sleep(300);
  r = await A.emit('test:obstacle', { kind: 'rock', x: 2200, y: 2000, lifeMs: 2500 });
  const rock = r.obstacles && r.obstacles.find(o => o.k === 'circle');
  let minD = Infinity;
  for (let i = 0; i < 30; i++) { A.s.emit('input', { s: ++A.seq, x: 1, y: 0 }); await sleep(50); minD = Math.min(minD, Math.hypot(A.pos.x - 2200, A.pos.y - 2000)); }
  ok(rock && minD >= rock.r + G.PLAYER_R - 1.5 && A.pos.x < 2200, `walking into a rock (r ${rock && rock.r}) stops at its edge (closest ${minD.toFixed(1)} px)`);
  const random = []; for (let i = 0; i < 4; i++) { const q = await A.emit('test:obstacle', { lifeMs: 2500 }); if (q.ok) random.push(q.obstacles[q.obstacles.length - 1]); }
  ok(random.length >= 2 && random.every(o => Math.hypot(o.x - A.pos.x, o.y - A.pos.y) > G.OBSTACLES.playerClear && Math.hypot(o.x - G.DOOR.x, o.y - G.DOOR.y) > G.OBSTACLES.doorClear),
    `random obstacles (${random.map(o => o.k).join(', ')}) spawn away from players and the door`);
  await sleep(3200);
  const lastObs = obsLog[obsLog.length - 1];
  ok(lastObs && lastObs[1].length === 0, 'obstacles disappear when their time is up (clients get the new list)');
  // laser: warning first, then the sweeping beam takes a share of the balance, with immunity in between
  await A.emit('test:tp', { x: 2000, y: 2000 }); await sleep(200);
  const bal0 = A.profile.balance, t0 = Date.now(); zaps.length = 0;
  r = await A.emit('test:obstacle', { kind: 'laser', x: 2150, y: 2000, lifeMs: 14000 });
  const L = r.obstacles && r.obstacles.find(o => o.k === 'laser');
  await waitFor(() => zaps.length >= 1, 13000);
  const z0 = zaps[0];
  await sleep(200);
  ok(L && L.arm >= 2900 && L.len >= 240 && z0 && z0[0] - t0 >= G.OBSTACLES.warnMs - 100, `laser (beam ${L && L.len} px, ${L && L.w.toFixed(2)} rad/s) is harmless for the ${G.OBSTACLES.warnMs / 1000} s warning, first hit after ${z0 && z0[0] - t0} ms`);
  ok(z0 && z0[1].loss === G.laserPenalty(bal0) && A.profile.balance <= bal0 - z0[1].loss + 40 && drops.size > 0, `laser hit: −${z0 && z0[1].loss} of ${bal0} (7 %), ${drops.size} lost orbs dropped nearby`);
  await waitFor(() => zaps.length >= 3, 9000);
  const gaps = zaps.slice(1).map((z, i) => z[0] - zaps[i][0]);
  ok(gaps.every(g => g >= G.OBSTACLES.invulnMs - 120), `immunity between hits (gaps ${gaps.join('/')} ms ≥ ${G.OBSTACLES.invulnMs})`);
  await A.emit('test:obstacle', { clear: true });
  A.s.close();
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

async function codesSuite(URL) {
  console.log('--- promo codes');
  const A = makeClient(URL), B = makeClient(URL), C = makeClient(URL);
  await A.register('CodeA' + rnd()); await B.register('CodeB' + rnd()); await C.register('CodeC' + rnd());
  const units = (P, id) => P.profile.inventory.filter(x => x.id === id).reduce((n, x) => n + x.q, 0);
  const bal = A.profile.balance, tot = A.profile.total;
  let r = await A.emit('code:redeem', '  test-gift ');
  const lime = A.profile.inventory.find(x => x.id === 'c_lime');
  ok(r.ok && A.profile.balance === bal + 250 && A.profile.total === tot && units(A, G.SHARD_ID) === 2 && units(A, 'c_lime') === 3 && lime.src === 'code' && r.rewards.orbs === 250,
    'code redeemed case-insensitively (trimmed): +250 orbs to balance only, 2 shards, 3× c_lime (source "code")');
  r = await A.emit('code:redeem', 'TEST-GIFT');
  ok(!r.ok && r.code === 'invalid' && r.error === 'Код не найден или уже использован' && A.profile.balance === bal + 250, 'second redeem on the same account refused with the generic message');
  const nf = await A.emit('code:redeem', 'NO-SUCH-CODE'), ex = await A.emit('code:redeem', 'test-old');
  ok(!nf.ok && nf.error === 'Код не найден или уже использован' && !ex.ok && ex.code === 'expired', 'unknown code → generic error; expired code → ' + ex.error);
  const o1 = await A.emit('code:redeem', 'TEST-ONCE'), o2 = await B.emit('code:redeem', 'test-once');
  ok(o1.ok && !o2.ok && o2.code === 'invalid', 'maxUses: 1 → the second account is refused');
  await C.emit('test:grant', { id: G.SHARD_ID, qty: 448, source: 'event' });
  const cb = C.profile.balance;
  r = await C.emit('code:redeem', 'TEST-GIFT');
  ok(!r.ok && r.code === 'full' && C.profile.balance === cb && units(C, G.SHARD_ID) === 448 && !units(C, 'c_lime'), 'rewards that do not fit into 450 units → refused, nothing given: ' + r.error);
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await C.emit('code:redeem', 'BRUTE' + i));
  ok(rs.slice(0, 4).every(x => x.code === 'invalid') && rs[4].code === 'rate', 'rate limit: the 6th attempt within a minute is refused (' + rs[4].error + ')');
  // production codes (one use per account, case-insensitive)
  const D = makeClient(URL); await D.register('CodeD' + rnd());
  const L = require('../lib/codes.js'), want = { KATIADESUTOP: [67, 1], ABSOLUTESECRETCODE: [67, 1], SPOOKYMONTH: [666, 0], BRIMSTONEBASEMENT: [125, 0], SHARDY: [0, 2], SECRETCODE: [123, 1], TREASURE: [50, 0], PATCH1: [111, 0], OSHIOTASHNIEIAICHA: [67, 1] };
  ok(Object.entries(want).every(([k, [o, sh]]) => { const c = L.findCode(k.toLowerCase()); return c && (c.rewards.orbs || 0) === o && (c.rewards.shards || 0) === sh && !c.expiresAt && c.maxUses == null; }), '9 promo codes defined with the right rewards, no expiry, no global limit');
  const d0 = D.profile.balance, s0 = units(D, G.SHARD_ID);
  const c1 = await D.emit('code:redeem', 'spookyMonth'), c2 = await D.emit('code:redeem', 'SPOOKYMONTH'), c3 = await D.emit('code:redeem', ' secretcode ');
  ok(c1.ok && !c2.ok && c3.ok && D.profile.balance === d0 + 666 + 123 && units(D, G.SHARD_ID) === s0 + 1, `SPOOKYMONTH (+666, any case, once) and SECRETCODE (+123 + 1 💎) redeemed`);
  D.close();
  A.close(); B.close(); C.close();
}
async function runnerCatchSuite(URL) {
  console.log('--- Раннеры are catchable at base speed');
  const R = G.EVENTS.runner;
  ok(R.speed <= G.BASE_SPEED * 0.7 && R.fleeRange <= 500 && R.restMs >= 1000 && R.r + R.catchPad >= 30, `runner ${R.speed} px/s vs player ${G.BASE_SPEED} (${Math.round(R.speed / G.BASE_SPEED * 100)} %), flees within ${R.fleeRange} px, rests ${R.restMs / 1000} s every ${R.tireEveryMs / 1000} s at ${R.restSpeed * 100} %, catch radius player+${R.r + R.catchPad}`);
  const times = [];
  for (let round = 0; round < 3; round++) {
    const A = makeClient(URL); await A.register('Chase' + rnd());
    let rn = null, caught = 0; A.s.on('s', st => { rn = st.rn || null; }); A.s.on('ev:runner', d => { if (d.name === A.profile.name) caught++; });
    const p0 = [[1500, 1500], [4500, 1200], [3000, 4500]][round];
    await A.emit('test:tp', { x: p0[0], y: p0[1] }); await sleep(200);
    await A.emit('test:event', { kind: 'runner', announceMs: 100, durationMs: 40000, count: 1, x: p0[0] + 500, y: p0[1] + 150 });
    await sleep(300); const t0 = Date.now();
    while (!caught && Date.now() - t0 < 25000) { // greedy chase at base speed, like a player holding the stick towards it
      const q = rn && rn[0]; if (q) { const dx = q[1] - A.pos.x, dy = q[2] - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); }
      await sleep(50);
    }
    times.push(caught ? Date.now() - t0 : null); A.close(); await sleep(300);
  }
  ok(times.every(t => t !== null && t <= 20000), `a base-speed chaser (no upgrades) catches a Раннер every time: ${times.map(t => t === null ? 'never' : (t / 1000).toFixed(1) + ' s').join(', ')}`);
  // spawn: near players, in the player's zone
  const B = makeClient(URL); await B.register('RnSp' + rnd()); await B.emit('test:tp', { x: 2000, y: 3000 }); await sleep(200);
  let first = null; B.s.on('s', st => { if (st.rn && !first) first = st.rn; });
  await B.emit('test:event', { kind: 'runner', announceMs: 100, durationMs: 3000 }); await waitFor(() => first, 3000);
  ok(first && first.length === 3 && first.every(q => q[1] < G.ZONE_W && Math.hypot(q[1] - 2000, q[2] - 3000) <= R.spawnNear[1] + 60), `3 Раннеры spawn ${first && first.map(q => Math.round(Math.hypot(q[1] - 2000, q[2] - 3000))).join('/')} px from the player, all in the player's zone`);
  await sleep(3200); B.close();
}
async function robotSuite(URL) {
  console.log('--- iron robot');
  const A = makeClient(URL); await A.register('Robo' + rnd());
  const zaps = [], pj = [], rbs = [];
  A.s.on('zap', z => zaps.push([Date.now(), z])); A.s.on('s', st => { if (st.pj) pj.push(st.pj); if (st.rb) rbs.push(st.rb); });
  await A.emit('test:tp', { x: 3000, y: 1500, orbs: 1000 }); await sleep(300);
  const bal0 = A.profile.balance;
  let r = await A.emit('test:obstacle', { kind: 'robot', x: 3350, y: 1500, lifeMs: 15000 });
  const R = r.obstacles && r.obstacles.find(o => o.k === 'robot');
  await waitFor(() => zaps.length >= 1, 8000);
  const z = zaps[0];
  ok(R && rbs.some(l => l.some(q => q[2] === 1)) && pj.length > 3 && pj.flat().every(b => b.length === 5), `robot spawned, telegraphs its aim (rb aim flag) and fires slow shots (${pj.length} snapshots)`);
  ok(z && z[1].src === 'robot' && z[1].loss === G.robotPenalty(bal0) && z[1].loss === 50 && A.profile.balance <= bal0 - 50 + 30, `shot hit: −${z && z[1].loss} of ${bal0} (5 %, cap ${G.OBSTACLES.robotCap})`);
  await waitFor(() => zaps.length >= 3, 9000);
  const gaps = zaps.slice(1).map((q, i) => q[0] - zaps[i][0]);
  ok(zaps.length >= 2 && gaps.every(g => g >= G.OBSTACLES.invulnMs - 120), `shared immunity between hits (gaps ${gaps.join('/')} ms)`);
  await A.emit('test:obstacle', { clear: true });
  // out of range: no shots
  await A.emit('test:tp', { x: 1000, y: 1000 }); pj.length = 0; zaps.length = 0;
  await A.emit('test:obstacle', { kind: 'robot', x: 1000 + G.OBSTACLES.robotRange + 150, y: 1000, lifeMs: 5000 });
  await sleep(3000);
  ok(pj.length === 0 && zaps.length === 0, 'a player out of range is not shot at');
  // random robot spawns keep away from players
  await A.emit('test:obstacle', { clear: true });
  const far = []; for (let i = 0; i < 2; i++) { const q = await A.emit('test:obstacle', { kind: 'robot', lifeMs: 3000 }); if (q.ok) far.push(q.obstacles[q.obstacles.length - 1]); }
  ok(far.length >= 1 && far.every(o => Math.hypot(o.x - A.pos.x, o.y - A.pos.y) > G.OBSTACLES.robotRange && Math.hypot(o.x - G.DOOR.x, o.y - G.DOOR.y) > G.OBSTACLES.doorClear), 'random robots spawn out of range of players and away from the door');
  const O = G.OBSTACLES;
  ok(O.robotChance === 0.3 && O.robotEveryMinMs === 45000 && O.robotEveryMaxMs === 90000 && O.robotMax === 2 && G.robotPenalty(1e6) === 100 && G.robotPenalty(0) === 0, 'robot: own timer (30 % roll every 45–90 s), max 2 alive, penalty 5 % capped at 100');
  const kinds = []; for (let i = 0; i < 12; i++) { const q = await A.emit('test:obstacle', { lifeMs: 2000 }); if (q.ok) kinds.push(q.obstacles[q.obstacles.length - 1].k); await A.emit('test:obstacle', { clear: true }); }
  ok(kinds.length >= 8 && !kinds.includes('robot'), `normal obstacle spawns never turn into robots (${kinds.join(',')})`);
  await A.emit('test:obstacle', { clear: true });
  A.close();
}
async function weekendSuite() {
  console.log('--- weekend bonus');
  const W = G.weekendInfo, at = s => Date.parse(s);
  ok(W(at('2026-10-16T23:59:00+03:00')).on === false && W(at('2026-10-17T00:00:00+03:00')).left === 48 * 3600000 && W(at('2026-10-18T23:00:00+03:00')).left === 3600000 && W(at('2026-10-19T00:00:00+03:00')).on === false && W(at('2026-10-17T22:30:00Z')).on === true,
    'weekend = Saturday + Sunday Moscow time, time left until Monday 00:00 MSK');
  const tmp = path.join(os.tmpdir(), `ocs-wk-${process.pid}.json`);
  const srv = await startServer(3110, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1', OCS_WEEKEND: 'on' });
  const A = makeClient(srv.url), r = await A.register('Wkd' + rnd());
  const h = await (await fetch(srv.url + '/api/health')).json();
  const types = new Map(Array.from(A.orbs.values(), o => [o.id, o.t])); let base = 0;
  A.s.on('s', st => { for (const a of st.oa) types.set(a[0], a[3]); for (const [id, pid] of st.od) if (pid === A.id) base += (G.ORB_TYPES[types.get(id)] || { value: 0 }).value; });
  const b0 = A.profile.balance;
  await A.farm(b0 + 60, 15000); await sleep(300);
  const gain = A.profile.balance - b0;
  ok(h.weekend === true && r.weekend > 0, `weekend flag in health + join payload (${Math.round(r.weekend / 3600000)} h left)`);
  ok(base > 0 ? Math.abs(gain - base * 1.5) <= 1.01 : gain >= 60, `orbs ×1.5 on the weekend: collected base ${base} → +${gain}`);
  A.close(); await srv.stop(); fs.rmSync(tmp, { force: true });
  const srv2 = await startServer(3110, { DATA_FILE: tmp, OCS_WEEKEND: 'off' });
  const h2 = await (await fetch(srv2.url + '/api/health')).json();
  ok(h2.weekend === false, 'no weekend bonus on weekdays (forced off)');
  await srv2.stop(); fs.rmSync(tmp, { force: true });
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
  ok(!dup.ok && dup.code === 'shards' && !plain.ok && !proto.ok && shards() === 5, 'second copy needs its own shards; non-exclusive / bogus ids refused, no shards taken');
  await S.emit('inv:equip', 'c_void');
  ok(!!(await waitFor(() => { const m = W.metas.get(S.id); return m && m.eq.color === 'c_void'; })), 'exclusive can be worn; other players see it');
  const bad = await Promise.all([0, 100, 2.5, '3', null].map(q => S.emit('shard:exchange', q)));
  const tooMany = await S.emit('shard:exchange', 6);
  const tot = S.profile.total, b2 = S.profile.balance;
  const ex = await S.emit('shard:exchange', 2);
  ok(bad.every(x => !x.ok) && !tooMany.ok && ex.ok && shards() === 3 && S.profile.balance === b2 + 2 * G.SHARD_EXCHANGE.orbs && S.profile.total === tot,
    `exchange: invalid amounts refused, 2 💎 → +${2 * G.SHARD_EXCHANGE.orbs} ◉ (balance only, all-time total unchanged)`);
  await sleep(5100); // shard actions are rate-limited (8 per 5 s)
  // multi-buy in «Лавка осколков»: qty validated, cost = price × qty, all-or-nothing
  await S.emit('test:grant', { id: G.SHARD_ID, qty: 200, source: 'event' });
  const badQ = await Promise.all([0, 100, 2.5, '3', -1, null].map(q => S.emit('shard:buy', 'n_shard', q)));
  let have = shards();
  const poor = await S.emit('shard:buy', 'n_shard', 99);
  ok(badQ.every(x => !x.ok && x.code === 'qty') && !poor.ok && poor.code === 'shards' && shards() === have, `shard shop qty: 0 / 100 / 2.5 / "3" / −1 / null refused; ×99 without enough shards refused (${poor.error})`);
  r = await S.emit('shard:buy', 'n_shard', 3);
  ok(r.ok && r.spent === 3 * 50 && r.qty === 3 && shards() === have - 150 && S.profile.inventory.filter(x => x.id === 'n_shard').reduce((n, x) => n + x.q, 0) === 3, 'shard shop ×3 «Осколочный ник»: exactly 150 shards spent, 3 copies stacked');
  // over-cap account (e.g. migrated): items kept, every grant refused until under the cap
  const INV = require('../lib/inventory');
  const big = { inventory: { v: 1, slots: [{ id: G.SHARD_ID, q: 99 }, { id: G.SHARD_ID, q: 99 }, { id: G.SHARD_ID, q: 99 }, { id: G.SHARD_ID, q: 99 }, { id: G.SHARD_ID, q: 99 }, { id: 'c_coral', q: 5 }] }, owned: [], equipped: {} };
  INV.migrateAccount(big);
  const gb = INV.grantItem(big, G.SHARD_ID, 1, 'event');
  ok(INV.unitsUsed(big) === 500 && !gb.ok && gb.code === 'full' && INV.roomFor(big, G.ITEM_BY_ID.c_lime) === 0 && /500 \/ 450/.test(gb.error), `migration keeps an over-cap inventory (500 / ${G.INV_CAP}); grants refused: ${gb.error}`);
  const shop = await (await fetch(URL + '/api/shop')).json();
  ok(shop.shardExchange.orbs === G.SHARD_EXCHANGE.orbs && shop.items.filter(i => i.exclusive).length === G.ITEMS.filter(i => i.exclusive).length && shop.events.koth.name === 'Царь горы', '/api/shop lists exclusives, events and the exchange rate');
  S.close(); W.close();
}

// automatic scheduler (short timers on a dedicated server)
async function schedulerSuite() {
  console.log('\n===== event scheduler (short timers) =====');
  const tmp = path.join(os.tmpdir(), `ocs-sched-${process.pid}.json`);
  const srv = await startServer(3107, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1', EVENT_EVERY_MS: '2000', EVENT_ANNOUNCE_MS: '1000', EVENT_DURATION_MS: '2500' });
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
  await waitFor(() => evs.filter(x => x.e === 'ev:end').length >= 3, 120000); // a legendary from «Волна удачи» may delay the next one
  const seq = evs.map(x => x.e.slice(3)[0]).join('');
  const kinds = evs.filter(x => x.e === 'ev:announce').map(x => x.kind);
  const firstAnn = evs[0] && evs[0].d;
  ok(/^(ase){3}/.test(seq) && kinds.every((k, i) => !i || k !== kinds[i - 1]), `scheduler runs events back to back: ${kinds.join(' → ')} (announce → start → end, never the same kind twice in a row)`);
  ok(firstAnn && firstAnn.in >= 900 && firstAnn.in <= 1000 && firstAnn.dur === 2500, `announcement comes ${firstAnn && firstAnn.in} ms ahead; durations from EVENT_DURATION_MS`);
  ok(legends.length === 0 || legends.every(t => !evs.some((x, i) => x.e === 'ev:announce' && x.kind !== 'lucky' && t >= x.at && t <= ((evs.slice(i).find(y => y.e === 'ev:end') || {}).at || Infinity))), 'no legendary orb spawns during an event (except «Волна удачи»)');
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
  ok(rushPerMin < RATE && reactPerMin < RATE, `perfect play with maxed «Мастер мини-игр» nets at most ${rushPerMin.toFixed(0)} (rush) / ${reactPerMin.toFixed(0)} (reaction) orbs/min, farming ≈${RATE}`);
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
  ok(G.rushPrize(20) === 30 && G.rushPrize(100) === rush.maxPrize && G.rushPrize(-5) === 0, `rush payout 150% capped at ${rush.maxPrize}`);
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
  ok(b2.ok && b2.profile.inventory.filter(x => x.id === 'c_coral').reduce((n, x) => n + x.q, 0) === 2, 'duplicates allowed: a second copy stacks (×2 c_coral)');
  // multi-buy validation: qty, funds, atomic
  const bq = await Promise.all([0, 100, 1.5, '2', -3, {}].map(q => A.emit('buy', 'c_lime', q)));
  const balQ = A.profile.balance, tooMany = Math.min(99, Math.floor(balQ / G.ITEM_BY_ID.h_crown.price) + 1);
  const bfunds = await A.emit('buy', 'h_crown', tooMany);
  ok(bq.every(x => !x.ok && x.code === 'qty') && !bfunds.ok && bfunds.code === 'funds' && A.profile.balance === balQ && !A.profile.inventory.some(x => x.id === 'h_crown'), `multi-buy: bad qty refused; ×${tooMany} Корона without enough orbs refused, nothing taken`);
  const b5 = await A.emit('buy', 'c_lime', 5);
  ok(b5.ok && b5.profile.balance === balQ - 5 * G.ITEM_BY_ID.c_lime.price && b5.profile.inventory.filter(x => x.id === 'c_lime').reduce((n, x) => n + x.q, 0) === 5, `multi-buy ×5 Лаймовый: −${5 * G.ITEM_BY_ID.c_lime.price}, 5 copies in one stack`);
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
  // capacity: 450 units in total (every unit in a stack counts)
  const units = () => A.profile.inventory.reduce((n, x) => n + x.q, 0);
  const g2 = await A.emit('test:grant', { id: 'x_legend_shard', qty: G.INV_CAP - units(), source: 'event' });
  ok(g2.ok && units() === G.INV_CAP && A.profile.used === G.INV_CAP && A.profile.cap === G.INV_CAP, `inventory filled to ${units()} / ${G.INV_CAP} units (${A.profile.inventory.length} stacks)`);
  const g3 = await A.emit('test:grant', { id: 'x_legend_shard', qty: 1, source: 'event' });
  ok(!g3.ok && g3.code === 'full' && /450 \/ 450/.test(g3.error), 'grant refused at the cap: ' + g3.error);
  const balF = A.profile.balance;
  const bf = await A.emit('buy', 'c_lime');
  ok(!bf.ok && bf.code === 'full' && /Инвентарь полон/.test(bf.error) && A.profile.balance === balF, 'buying with a full inventory refused, no orbs taken: ' + bf.error);
  const tf = await A.emit('inv:trash', { id: 'x_legend_shard', qty: 3 });
  const bf3 = await A.emit('buy', 'c_lime', 4), bf2 = await A.emit('buy', 'c_lime', 3);
  ok(tf.ok && !bf3.ok && bf3.code === 'full' && bf2.ok && units() === G.INV_CAP && A.profile.balance === balF - 3 * G.ITEM_BY_ID.c_lime.price, 'trash 3 units → ×4 refused (not enough space, all-or-nothing), ×3 fits exactly');
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
  const net = Object.fromEntries(rates.map(([k]) => [k, G.skillPrize(k === 'reaction' ? G.REACTION_PRIZES[0][1] : M[k].maxPrize, maxSkill) - M[k].fee]));
  const cycle = Math.max(rates.reduce((n, [k]) => n + G.minigameMinMs(k), 0), Math.max(...rates.map(([k]) => G.minigameMinMs(k) + M[k].cooldownMs)));
  const rot = Object.values(net).reduce((a, b) => a + b, 0) / cycle * 60000;
  ok(rot < 112, `flawless rotation of all 6 games with «Мастер» 3: ${rot.toFixed(0)} orbs/min < zone-1 farming (~112/min)`);
  ok(G.skillPrize(M.shell.prize, maxSkill) / M.shell.cups < M.shell.fee && G.memoryPrize(M.memory.freeRounds) === 0 && G.memoryPrize(99) === M.memory.maxPrize && G.throwPrize(999) === M.throw.maxPrize &&
    G.throwPoints(0) > G.throwPoints(0.03) && G.throwPoints(0.03) > G.throwPoints(0.05) && G.throwPoints(0.2) === 0 && G.chainPrize(1000) === M.chain.maxPrize && G.chainPrize(99999) === 0,
    `payout tables: blind shell guess EV ${(G.skillPrize(M.shell.prize, maxSkill) / 3).toFixed(1)} (with «Мастер» 3) < fee ${M.shell.fee}; memory ≤ ${M.memory.maxPrize}, throw ≤ ${M.throw.maxPrize} (closer = more), chain ≤ ${M.chain.maxPrize}`);
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
    // under heavy parallel load the first act can land after the 250 ms early window — treat it as the stop
    if (early.ok && !early.early) {
      const dup = await E.emit('mg:act', { i: d.i });
      got.push({ d, early: { early: true, ok: false }, st: early, dup });
      return;
    }
    // aim: wait until the marker is near the target (server time, RTT-compensated server-side)
    let t = 400; while (Math.abs(G.throwPos(t, d.period, d.phase) - d.target) > 0.01 && t < 4000) t += 5;
    await sleep(t);
    const st = await E.emit('mg:act', { i: d.i, pts: 10 }); const dup = await E.emit('mg:act', { i: d.i });
    got.push({ d, early, st, dup });
  });
  await E.emit('mg:start', 'throw'); res = await result; await sleep(150);
  ok(got.length === 3 && got.every(g => g.early.early && !g.early.ok && g.st.ok && !g.dup.ok && g.st.pts === G.throwPoints(Math.abs(g.st.pos - g.d.target))),
    'throw: stop < 250 ms refused, double stop refused, points computed by the server from time (claimed pts ignored): ' + got.map(g => g.st.pts).join('/') + ' ' + JSON.stringify(got.map(g => [g.early, g.st, g.dup.ok, g.d.target])));
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
  const gained = A.profile.balance - start, expect = raw + Math.floor(raw * 0.15 + 1e-9);
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
  await A.emit('test:tp', { x: 900, y: 800 }); await B.emit('test:tp', { x: 4200, y: 4200 }); // away from everyone (players push each other)
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
  ok(avg(r.none) >= 40 && avg(r.none) <= 140, `income without upgrades ≈ ${Math.round(avg(r.none))} orbs/min (larger world, noisier short runs)`);
  ok(r.none.concat(r.max).every(Number.isFinite) && ratio >= 1.1 && ratio <= 1.7,
    `income ×${ratio.toFixed(2)} with everything maxed (none ${r.none.join('/')} → max ${r.max.join('/')} orbs/min; target ≤1.5×, band 1.15–1.55 for run-to-run noise)`);
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
  ok(!dup.ok && dup.code === 'funds', 'another copy needs orbs again (balance 10 → refused)');
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
  await A.emit('test:tp', { x: 1500, y: 1500 }); await A.farm(15, 90000);
  ok(A.profile.balance >= 15, `A farmed balance to ${A.profile.balance}`);
  ok(!(await A.emit('buy', 'c_rainbow')).ok && !(await A.emit('upgrade', '__proto__')).ok && !(await A.emit('mg:start', 'constructor')).ok, 'unaffordable / prototype-key payloads rejected');
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${encodeURIComponent(A.profile.name)}`)).json();
  ok(lb.me && lb.me.total === A.profile.total, `leaderboard has A with total ${A.profile.total}`);
  A.close(); B.close();
}

// ------------------------------------------------------------------ chat clear cycle + spawn (dedicated server with short timers)
async function chatClearSuite(URL) {
  console.log('--- chat: rolling last 100 messages (no periodic clear)');
  const C = makeClient(URL), E = makeClient(URL);
  let clears = 0; E.s.on('chat:clear', () => clears++);
  await C.register('Roll' + rnd()); await E.register('Roll' + rnd());
  const f = await C.call('test:chatfill', 105);
  await C.call('chat', 'самое новое');
  await sleep(400);
  const F = makeClient(URL); const rf = await F.register('Roll' + rnd());
  const h = rf.chat.filter(m => !m.sys);
  ok(f.ok && f.size === 100 && h.length === 100 && h[0].t === 'fill 6' && h[h.length - 1].t === 'самое новое', `history keeps the last 100 messages (oldest now «${h[0] && h[0].t}», newest «${h[h.length - 1] && h[h.length - 1].t}»)`);
  await sleep(3500);
  ok(clears === 0, 'no periodic chat:clear any more');
  { const t0 = Date.now(); let made = 0; for (let i = 0; i < 30; i++) { const q = await C.call('test:obstacle', { lifeMs: 60000 }); if (q.ok) made = q.obstacles.length; }
    const ms = Date.now() - t0; await C.call('test:obstacle', { clear: true });
    ok(made >= 28 && ms < 5000, `30 obstacles can be placed with the spacing rules (${made} placed in ${ms} ms, bounded 40 tries each)`); }
  C.close(); E.close(); F.close();
}
async function chatRestartSuite() {
  console.log('--- chat is not kept across restarts');
  const tmp = path.join(os.tmpdir(), `ocs-chatr-${process.pid}.json`);
  let srv = await startServer(3112, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
  const A = makeClient(srv.url); const name = 'Rst' + rnd(); await A.register(name);
  await A.call('chat', 'до перезапуска'); await sleep(300); A.close(); await sleep(200);
  await srv.stop();
  const disk = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  srv = await startServer(3112, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
  const B = makeClient(srv.url); const rb = await B.login(name);
  ok(rb && rb.ok && !rb.chat.some(m => /до перезапуска/.test(m.t || '')) && !/до перезапуска/.test(disk), `after a restart the chat starts empty (${rb && rb.chat.length} messages) and nothing was written to disk`);
  B.close(); await srv.stop(); fs.rmSync(tmp, { force: true });
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
  ok(h0.targetOrbs === 360 && h1.targetOrbs === 460, `zone-1 target scales with players: ${h0.targetOrbs} (0 online, min) → ${h1.targetOrbs} (3 online) [280 + 60/player, 360…1000]`);
  const n0 = cl[0].orbs.size;
  await sleep(1000);
  const n1 = cl[0].orbs.size;
  ok(n1 > n0, `new orbs fade in gradually (${n0} → ${n1} after 1 s; zone-1 target ${h1.targetOrbs}, zone 2 same count)`);
  await sleep(4500);
  const list = Array.from(cl[0].orbs.values()).filter(o => o.t !== 'l');
  const z1 = list.filter(o => o.x < G.ZONE_W), z2 = list.filter(o => o.x >= G.ZONE_W);
  ok(Math.abs(z1.length - h1.targetOrbs) <= 20 && Math.abs(z2.length - h1.targetOrbs) <= 30, `orb counts: zone1 ${z1.length}/${h1.targetOrbs}, zone2 ${z2.length} (same density)`);
  const cells = new Map();
  for (const o of z1) { const k = Math.floor(o.x / 300) + ',' + Math.floor(o.y / 300); cells.set(k, (cells.get(k) || 0) + 1); }
  const maxCell = Math.max(0, ...cells.values());
  ok(cells.size >= 150 && maxCell <= 6, `zone-1 even spread: ${cells.size} cells occupied, max ${maxCell} orbs per 300×300 cell`);
  let minD = Infinity;
  for (let i = 0; i < z1.length; i++) for (let j = i + 1; j < z1.length; j++) minD = Math.min(minD, Math.hypot(z1[i].x - z1[j].x, z1[i].y - z1[j].y));
  ok(minD >= 69, `no clumps: min distance between orbs ${minD.toFixed(0)} px (≥ 70)`);
  ok(adds.length > 50 && tooClose === 0, `no orb spawned within 200 px of a player (${adds.length} spawns checked)`);
  const types = z1.map(o => o.t);
  const share = k => types.filter(t => t === k).length / types.length;
  ok(share('c') > 0.7 && share('c') < 0.92 && share('u') > 0.05 && share('u') < 0.2 && share('r') > 0.01 && share('r') < 0.1,
    `zone-1 tier shares of ${types.length} orbs: ${['c', 'u', 'r', 'e', 'm'].map(k => k + ' ' + (share(k) * 100).toFixed(1) + '%').join(', ')}`);
  const t2 = z2.map(o => o.t), sh2 = k => t2.filter(t => t === k).length / t2.length;
  ok(z2.length && sh2('c') > 0.55 && sh2('c') < share('c') && sh2('r') + sh2('e') > share('r') + share('e'), `zone-2 tier shares (better odds): ${['c', 'u', 'r', 'e', 'm'].map(k => k + ' ' + (sh2(k) * 100).toFixed(1) + '%').join(', ')}`);
  // collected orbs come back after a delay, not instantly
  const A = cl[0];
  const before = A.profile.total;
  await A.farm(before + 8, 20000);
  const justAfter = A.orbs.size;
  await sleep(1000);
  ok(Array.from(A.orbs.values()).filter(o => o.x < G.ZONE_W && o.t !== "l").length <= h1.targetOrbs, `after collecting, orbs refill gradually (${justAfter} right after, ${A.orbs.size} 1 s later, target ${h1.targetOrbs})`);
  for (const c of cl) c.close();
}

async function legendarySuite(URL) {
  console.log('--- legendary orb (spawn-table tier, no timer)');
  const A = makeClient(URL); await A.register('Hunter' + rnd());
  const items = [], announces = [], soon = [];
  A.s.on('item', d => items.push(d)); A.s.on('announce', d => announces.push(d)); A.s.on('legend:soon', d => soon.push(d));
  const r = await A.emit('test:spawn', { types: ['l'], ring: 90 });
  await sleep(250);
  const ls = Array.from(A.orbs.values()).filter(o => o.t === 'l');
  ok(r.ok && ls.length >= 1 && announces.some(a => /легендарная/.test(a.text)), `legendary spawn is announced to everyone (${ls.length} on field)`);
  const target = ls.sort((a, b) => Math.hypot(a.x - A.pos.x, a.y - A.pos.y) - Math.hypot(b.x - A.pos.x, b.y - A.pos.y))[0];
  const t0 = Date.now();
  while (A.orbs.has(target.id) && Date.now() - t0 < 5000) { const dx = target.x - A.pos.x, dy = target.y - A.pos.y, l = Math.hypot(dx, dy) || 1; A.s.emit('input', { s: ++A.seq, x: dx / l, y: dy / l }); await sleep(50); }
  await sleep(300);
  const sh = A.profile.inventory.find(x => x.id === 'x_legend_shard');
  ok(items.some(d => d.id === 'x_legend_shard') && sh && sh.src === 'arena', 'collecting it grants a «Легендарный осколок» via grantItem (source "arena")');
  ok(soon.length === 0, 'no timer: no «legend:soon» heads-up is ever sent');
  const h = await (await fetch(URL + '/api/health')).json();
  ok(h.ok, 'server healthy after legendary pickup (it respawns as a normal pool orb)');
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
  await db.query('DROP TABLE IF EXISTS ocs_sessions; DROP TABLE IF EXISTS ocs_accounts; DROP TABLE IF EXISTS ocs_code_uses;');
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
  const refund = 300 + 900 + 2400 + 400 + 1100; // legacy magnet 3 + speed 2 at the old prices
  ok(pr.balance === 4321 + refund && pr.total === 987654 && pr.upgrades.magnet === 0 && pr.upgrades.speed === 0 && pr.stats.upgradeRefundV1 === true, `balance ${pr.balance} (= 4321 + ${refund} upgrade refund), total ${pr.total} unchanged, upgrades reset to 0`);
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
  ok(r.ok && r.profile.inventory.some(x => x.id === 't_fire') && r.profile.balance === 321 + 5100 && r.profile.equipped.color === 'c_gold',
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
    const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATABASE_URL: '', DATA_FILE: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_WEEKEND: 'off' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (opts.full) { await chatSuite(srv.url); await gameplaySuite(srv.url); await minigameSuite(srv.url); await newGamesSuite(srv.url); await upgradeSuite(srv.url); await newItemsSuite(srv.url); await tiersSuite(srv.url); await eventSuite(srv.url); await luckyObstacleSuite(srv.url); await robotSuite(srv.url); await runnerCatchSuite(srv.url); await pushSuite(srv.url); }
  await shardShopSuite(srv.url);
  await zoneSuite(srv.url);
  await codesSuite(srv.url);
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
  const srv = await startServer(3104, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
  await spawnSuite(srv.url);
  await chatClearSuite(srv.url);
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
    await tiersSuite(srv.url); await eventSuite(srv.url); await luckyObstacleSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
    privacyAudit(await schedulerSuite());
  } else if (process.env.OCS_TEST_ONLY === 'update2') {
    tierEventRules();
    const tmp = path.join(os.tmpdir(), `ocs-u2-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await codesSuite(srv.url); await luckyObstacleSuite(srv.url); await robotSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
    await weekendSuite();
  } else if (process.env.OCS_TEST_ONLY === 'update3') {
    tierEventRules();
    const tmp = path.join(os.tmpdir(), `ocs-u3-${process.pid}.json`);
    const srv = await startServer(3104, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await chatClearSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
    await chatRestartSuite();
  } else if (process.env.OCS_TEST_ONLY === 'update4') {
    upgradeRules();
    const tmp = path.join(os.tmpdir(), `ocs-u4-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await runnerCatchSuite(srv.url); await codesSuite(srv.url); await upgradeSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
  } else if (process.env.OCS_TEST_ONLY === 'codes') {
    const tmp = path.join(os.tmpdir(), `ocs-codes-${process.pid}.json`);
    const srv = await startServer(3101, { DATA_FILE: tmp, OCS_TEST_HOOKS: '1' });
    await codesSuite(srv.url);
    await srv.stop(); fs.rmSync(tmp, { force: true });
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
    { const tmpE = path.join(os.tmpdir(), `ocs-evoff-${process.pid}.json`); const srvE = await startServer(3108, { DATA_FILE: tmpE, EVENT_EVERY_MS: '' });
      const hE = await (await fetch(srvE.url + '/api/health')).json();
      ok(hE.eventsEnabled === true && hE.event === null, 'arena events are ON by default again (EVENTS_ENABLED=0 turns them off)');
      await srvE.stop(); fs.rmSync(tmpE, { force: true }); }
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
