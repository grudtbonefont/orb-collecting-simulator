// stackable boosts + promo-code deletion. Run: NODE_PATH=$(npm root -g) node test/admin-stack-codes-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3147, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/ocs-stk.json'); } catch (_) {}
  const logs = []; const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/ocs-stk.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => logs.push(String(d))); proc.stderr.on('data', d => logs.push(String(d)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
  async function join(name, mob) {
    const ctx = await b.newContext(Object.assign({ viewport: mob ? { width: 390, height: 844 } : { width: 1280, height: 720 } }, mob ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600);
    await p.evaluate(async () => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r)); await new Promise(r => s.emit('session', { token: localStorage.getItem('ocs_session') }, r)); window.__s = s; });
    return p;
  }
  const A = await join('DragonzTV'), P = await join('Player2');
  const adm = (p, d) => p.evaluate(d => OCSAdm(d), d);
  const redeem = (p, c) => p.evaluate(c => new Promise(res => window.__s.emit('code:redeem', c, res)), c);
  let allRej = true; for (const [a, d] of [['x2', { min: 5 }], ['boost:stop', { id: 1 }], ['code:delete', { code: 'TREASURE' }], ['custom', { name: 'X', orb: 3 }]]) { const r = await adm(P, Object.assign({ a }, d)); if (!r || r.error !== 'Нет доступа') allRej = false; }
  ok(allRej, 'non-admin rejected for x2 / boost:stop / code:delete / custom');
  // stacking
  await adm(A, { a: 'cmd', text: '/tphere Player2' });
  const sess = async () => { await sleep(600); return A.evaluate(() => Number(document.getElementById('hudSession').textContent.replace(/\D/g, ''))); };
  const grab = async () => { const s0 = await sess(); await adm(A, { a: 'orbs', t: 'l', n: 6, where: 'here' }); await sleep(1300); return (await sess()) - s0; };
  await A.evaluate(() => { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); document.getElementById('admBtn').click(); }); await A.waitForSelector('#admEvents .btn'); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  const g1 = await grab();
  let r1 = await adm(A, { a: 'x2', min: 5 }), r2 = await adm(A, { a: 'x2', min: 5 }); ok(r1.ok && r2.ok && /×4/.test(r2.msg), 'two x2 started: ' + r2.msg);
  await sleep(500); const fx = (await adm(A, { a: 'init' })).fx;
  ok(fx.boosts.filter(b => b.kind === 'x2').length === 2 && fx.x2m === 4, 'fx lists 2 x2 instances, mult 4');
  const g4 = await grab(); ok(g1 > 0 && Math.abs(g4 / g1 - 4) < 0.3, `x2+x2 = x4 orbs (base ${g1}, stacked ${g4})`);
  await A.evaluate(() => document.getElementById('admin').classList.remove('hidden')); await sleep(1200);
  const strip = await A.evaluate(() => (document.getElementById('admActiveList').textContent.match(/Сферы ×2/g) || []).length); ok(strip === 2, 'panel shows 2 x2 instances: ' + strip);
  r1 = await adm(A, { a: 'boost:stop', id: fx.boosts[0].id }); const g2 = await grab(); ok(r1.ok && Math.abs(g2 / g1 - 2) < 0.2, `stop one → x2 (${g2})`);
  await adm(A, { a: 'custom', name: 'A', orb: 2, min: 2 }); await adm(A, { a: 'custom', name: 'B', orb: 1.5, min: 2 });
  const gc = await grab(); ok(Math.abs(gc / g1 - 6) < 0.4, `x2 * custom 2 * custom 1.5 = x6 (${gc})`);
  await adm(A, { a: 'cmd', text: '/x2 0' }); await adm(A, { a: 'custom', off: true }); const g0 = await grab(); ok(Math.abs(g0 / g1 - 1) < 0.15, 'all stopped → x1');
  // code deletion
  let r = await adm(A, { a: 'codes' }); ok(r.codes.some(c => c.code === 'TREASURE' && c.builtin), 'built-in codes listed');
  ok((await redeem(P, 'TREASURE')).ok, 'P redeems TREASURE before delete');
  const balP = await P.evaluate(() => Number(document.getElementById('hudBal') ? 1 : 1));
  r = await adm(A, { a: 'code:delete', code: 'treasure' }); ok(r.ok && !r.codes.some(c => c.code === 'TREASURE'), 'built-in deleted & hidden');
  ok(!(await redeem(A, 'TREASURE')).ok, 'deleted built-in no longer redeemable');
  await adm(A, { a: 'code:create', code: 'PANELX', orbs: 9 }); r = await adm(A, { a: 'code:delete', code: 'PANELX' }); ok(r.ok && !r.codes.some(c => c.code === 'PANELX'), 'panel code deleted');
  ok(!(await redeem(P, 'PANELX')).ok, 'deleted panel code rejected');
  ok(!(await adm(A, { a: 'code:create', code: 'TREASURE', orbs: 1 })).ok, 'cannot recreate deleted built-in');
  // persisted across restart + player keeps reward
  await sleep(800); proc.kill(); await new Promise(r => proc.on('exit', r));
  const data = JSON.parse(fs.readFileSync('/tmp/ocs-stk.json', 'utf8'));
  const acc = Object.values(data.accounts || {}).find(a => a.name === 'Player2');
  ok(data.adminCodes.TREASURE && data.adminCodes.TREASURE.deleted && acc && acc.codes.includes('TREASURE'), 'deletion persisted; player keeps redeemed code record');
  const p2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/ocs-stk.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const C2 = await join('Player3'); ok(!(await redeem(C2, 'TREASURE')).ok && (await redeem(C2, 'SHARDY')).ok, 'after restart: deleted stays deleted, others work');
  ok(!errs.length, 'no page errors ' + errs.join('; '));
  await b.close(); p2.kill();
  console.log(f ? f + ' FAIL' : 'ALL PASS'); process.exit(f ? 1 : 0);
})();
