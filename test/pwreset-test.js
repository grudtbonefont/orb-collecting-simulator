// One-shot admin password reset (PW_RESET_USER / PW_RESET_HASH) + «Сменить пароль» (pw:change). JSON-file store.
//   node test/pwreset-test.js
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PORT = 3113, URL = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const file = path.join(os.tmpdir(), `ocs-pwr-${process.pid}.json`);
let logs = '';
async function start(env = {}) {
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1', PW_RESET_USER: '', PW_RESET_HASH: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => logs += d); proc.stderr.on('data', d => logs += d);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(150); }
  return { stop: () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); }) };
}
function client() {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  return { s, call, ready: new Promise(r => s.on('connect', r)) };
}
async function login(name, password) { const c = client(); await c.ready; const r = await c.call('auth', { mode: 'login', name, password, enter: false }); return { c, r }; }
(async () => {
  const NAME = 'Resetme' + Date.now() % 10000, OLD = 'old-pass-123', TMP = 'Tmp4x9Qa2z', NEW = 'brand-new-456';
  let srv = await start();
  const a = client(); await a.ready;
  const reg = await a.call('auth', { mode: 'register', name: NAME, password: OLD, confirm: OLD });
  await a.call('test:orbs', 4321); await sleep(400); a.s.close(); await sleep(300); await srv.stop();
  const HASH = bcrypt.hashSync(TMP, 10);
  srv = await start({ PW_RESET_USER: NAME.toUpperCase(), PW_RESET_HASH: HASH });
  let L = await login(NAME, TMP), Lold = await login(NAME, OLD);
  ok(reg.ok && L.r.ok && !Lold.r.ok, 'after the reset boot the temp password works and the old one does not');
  ok(L.r.profile && L.r.profile.balance === 4321 && L.r.profile.mustChangePw === true && !('pwResetMark' in L.r.profile.stats), `progress kept (balance ${L.r.profile && L.r.profile.balance}), profile asks for a new password, marker not exposed`);
  const bad = await L.c.call('pw:change', { old: 'wrong-one-1', new: NEW }), weak = await L.c.call('pw:change', { old: TMP, new: '1' });
  const good = await L.c.call('pw:change', { old: TMP, new: NEW });
  ok(!bad.ok && !weak.ok && good.ok && good.profile.mustChangePw === false, `«Сменить пароль»: wrong current refused («${bad.error}»), weak refused, correct → changed`);
  L.c.s.close(); Lold.c.s.close(); await sleep(300); await srv.stop();
  srv = await start({ PW_RESET_USER: NAME, PW_RESET_HASH: HASH }); // same env again: must not re-apply
  const Lnew = await login(NAME, NEW), Ltmp = await login(NAME, TMP);
  ok(Lnew.r.ok && !Ltmp.r.ok && Lnew.r.profile.balance === 4321 && Lnew.r.profile.mustChangePw === false, 'a later boot with the same env does not re-apply (new password still valid)');
  Lnew.c.s.close(); Ltmp.c.s.close(); await srv.stop();
  srv = await start({ PW_RESET_USER: NAME, PW_RESET_HASH: 'not-a-hash' }); await srv.stop();
  ok(/password reset: applied for 1 account/.test(logs) && /already applied, skipped/.test(logs) && /not a bcrypt hash, ignored/.test(logs) && !logs.includes(HASH) && !logs.includes(TMP), 'logs: applied once, skipped later, bad hash ignored; no hash / password in logs');
  fs.rmSync(file, { force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
