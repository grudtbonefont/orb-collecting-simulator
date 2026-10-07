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
  ok(rf.ok && rf.chat.some(m => m.n === nameC && /Привет/.test(m.t)), `chat history sent on join (${rf.chat.length} messages)`);
  F.close(); C.close(); E.close();
}

async function gameplaySuite(URL) {
  console.log('--- gameplay');
  const A = makeClient(URL), B = makeClient(URL);
  await A.register('Gamer' + rnd()); await B.register('Player' + rnd());
  await sleep(300);
  const p0 = { ...A.pos };
  for (let i = 0; i < 100; i++) A.s.emit('input', { s: ++A.seq, x: 5, y: 0 });
  await sleep(1000);
  const moved = Math.hypot(A.pos.x - p0.x, A.pos.y - p0.y);
  const maxLegit = G.speedFor(0) * 1.0 + G.speedFor(0) * G.STEP_DT * 8;
  ok(moved > 50 && moved <= maxLegit, `input flood is rate-limited: moved ${moved.toFixed(0)}px in 1s (cap ≈${maxLegit.toFixed(0)})`);
  await sleep(1000);
  await A.farm(60, 90000);
  ok(A.profile.balance >= 60, `A farmed balance to ${A.profile.balance}`);
  const r1 = await A.emit('buy', 'c_coral');
  ok(r1.ok && r1.profile.equipped.color === 'c_coral', 'A bought and auto-equipped c_coral (25)');
  await sleep(200);
  ok(B.metas.get(A.id) && B.metas.get(A.id).eq.color === 'c_coral', 'B sees A\'s new color');
  ok(!(await A.emit('buy', 'c_coral')).ok, 'cannot buy same item twice');
  ok(!(await A.emit('buy', 'c_rainbow')).ok, 'cannot buy unaffordable item');
  ok(!(await A.emit('buy', '__proto__')).ok && !(await A.emit('upgrade', '__proto__')).ok && !(await A.emit('mg:start', 'constructor')).ok, 'prototype-key payloads rejected (no crash)');
  const r4 = await A.emit('equip', 'c_cyan');
  ok(r4.ok && r4.profile.equipped.color === 'c_cyan', 'equip owned default item');
  ok(!(await A.emit('equip', 'h_crown')).ok, 'cannot equip unowned item');
  await A.farm(40, 60000);
  const r6 = await A.emit('upgrade', 'magnet');
  ok(r6.ok && r6.profile.upgrades.magnet === 1, 'magnet upgrade lvl 1 purchased');
  await A.farm(10, 30000);
  const balR = A.profile.balance;
  const res = new Promise(r => A.s.once('mg:result', r));
  A.s.once('mg:reaction:go', () => setTimeout(() => A.s.emit('mg:reaction:click'), 150));
  ok((await A.emit('mg:start', 'reaction')).ok, 'reaction mini-game started');
  const rr = await res; await sleep(200);
  ok(rr.prize >= 0 && A.profile.balance === balR - 10 + rr.prize, `reaction result: ${rr.message}, prize ${rr.prize}`);
  await B.farm(15, 60000);
  const balB = B.profile.balance; let hits = 0;
  B.s.on('mg:rush:spawn', async tg => { if (tg.type === 'b') return; await sleep(120); const h = await B.emit('mg:rush:hit', { id: tg.id, x: tg.x + 3, y: tg.y - 3 }); if (h.ok) hits++; });
  const resB = new Promise(r => B.s.once('mg:result', r));
  ok((await B.emit('mg:start', 'rush')).ok, 'orb rush started');
  ok(!(await B.emit('mg:rush:hit', { id: 1, x: -500, y: -500 })).ok, 'rush rejects hit at wrong position');
  const rB = await resB; await sleep(200);
  ok(rB.prize > 15 && hits > 10 && B.profile.balance === balB - 15 + rB.prize, `orb rush: ${rB.message}, prize ${rB.prize}`);
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=100&name=${encodeURIComponent(A.profile.name)}`)).json();
  const names = lb.players.map(p => p.name);
  ok(names.includes(A.profile.name) && names.includes(B.profile.name), 'leaderboard contains both players');
  ok(lb.players.every((p, i, arr) => i === 0 || arr[i - 1].total >= p.total) && lb.me && lb.me.total === A.profile.total, `leaderboard sorted by all-time total; A rank #${lb.me && lb.me.rank}`);
  A.close(); B.close();
}

// farm, buy, restart server, verify everything came back
async function persistencePhase1(URL) {
  const name = 'Keeper' + rnd();
  const P = makeClient(URL);
  await P.register(name);
  await P.farm(70, 90000);
  const b1 = await P.emit('buy', 'c_coral');
  const u1 = await P.emit('upgrade', 'magnet');
  ok(b1.ok && u1.ok, `persistence: ${name} farmed ${P.profile.total}, bought c_coral + magnet`);
  await sleep(100);
  const snap = JSON.parse(JSON.stringify(P.profile));
  const token = P.token;
  return { name, snap, token, P };
}
async function persistencePhase2(URL, st) {
  const P = makeClient(URL);
  const r = await P.login(st.name);
  const same = r.ok && r.profile.balance === st.snap.balance && r.profile.total === st.snap.total && r.profile.owned.includes('c_coral')
    && r.profile.equipped.color === 'c_coral' && r.profile.upgrades.magnet === 1;
  ok(same, `data survived restart: balance ${r.profile && r.profile.balance}/${st.snap.balance}, total ${r.profile && r.profile.total}/${st.snap.total}, color ${r.profile && r.profile.equipped.color}, magnet ${r.profile && r.profile.upgrades.magnet}`);
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
function startServer(port, env) {
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
  let srv = await startServer(port, env);
  console.log('server: ' + srv.logs.trim().split('\n')[0]);
  await authSuite(srv.url);
  await chatSuite(srv.url);
  if (opts.gameplay) await gameplaySuite(srv.url);
  await leaderboardAudit(srv.url);
  const st = await persistencePhase1(srv.url);
  const code = await srv.stop(); // SIGTERM while the player is still online -> must flush
  st.P.close();
  ok(code === 0 && /Saved/.test(srv.logs), `server flushed and exited cleanly on SIGTERM (exit ${code})`);
  let logs = srv.logs;
  srv = await startServer(port, env);
  await persistencePhase2(srv.url, st);
  await srv.stop();
  logs += srv.logs;
  privacyAudit(logs);
}

(async () => {
  const url = process.argv[2];
  if (url) {
    await authSuite(url);
    await chatSuite(url);
    await gameplaySuite(url);
    await leaderboardAudit(url);
    privacyAudit(null);
  } else {
    const tmp = path.join(os.tmpdir(), `ocs-test-${process.pid}.json`);
    await runMode('JSON file mode', { DATA_FILE: tmp }, { gameplay: true });
    fs.rmSync(tmp, { force: true });
    if (process.env.TEST_DATABASE_URL) {
      const { Client } = require('pg');
      const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await db.connect(); await db.query('DROP TABLE IF EXISTS ocs_sessions; DROP TABLE IF EXISTS ocs_accounts;'); await db.end();
      await runMode('PostgreSQL mode', { DATABASE_URL: process.env.TEST_DATABASE_URL }, { gameplay: false });
    } else console.log('\n(PostgreSQL mode skipped: set TEST_DATABASE_URL to run it)');
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  for (const s of allSockets) s.close();
  setTimeout(() => process.exit(), 300);
})().catch(e => { console.error(e); process.exit(1); });
