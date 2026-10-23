// «Кубок» for all achievements (local, OCS_TEST_HOOKS=1 only here). Run: NODE_PATH=$(npm root -g) node test/trophy-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const C = require('../public/content.js'); const G = require('../public/shared.js');
const ROOT = process.cwd(), PORT = 3144, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/tr.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/tr.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const def = G.ITEM_BY_ID.h_trophy; ok(def && def.cat === 'hat' && def.price == null && !def.exclusive, 'Кубок: hat, not in shop / shard shop');
  const shop = await (await fetch(URL + '/api/shop')).json(); ok(!shop.items.some(i => i.id === 'h_trophy' && (i.price > 0 || i.shardPrice > 0)), 'no price in shop api');
  const ids = C.ACH.map(a => a.id); const N = ids.length; ok(N === 79, 'total tiers ' + N);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function reg(name, play = true) { const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)');
    await p.evaluate(async () => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r)); await new Promise(r => s.emit('session', { token: localStorage.getItem('ocs_session') }, r)); window.__s = s; });
    if (play) { await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); } return p; }
  const st1 = (p, d) => p.evaluate(d => new Promise(r => window.__s.emit('test:stats', d, r)), d);
  const st = async (p, d) => { const l = d.achSet; for (let i = 0; i < l.length; i += 40) await st1(p, { achSet: l.slice(i, i + 40) }); }; // hook takes ≤ 40 ids per call
  const prof = p => p.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile) : setTimeout(go, 400)); go(); }));
  // A: completes the last tier while playing → awarded live
  const A = await reg('TrophyA');
  await st(A, { achSet: ids.slice(0, -1) }); await sleep(400); let pa = await prof(A); ok(!pa.inventory.some(s => s.id === 'h_trophy'), `${N - 1}/${N}: no trophy yet`);
  await A.click('[data-open=ach]'); await sleep(300); ok(new RegExp(`${N - 1} / ${N}`).test(await A.textContent('#achTrophyTxt')) && /Все достижения → Кубок/.test(await A.textContent('#achTrophy')), 'achievements UI: final reward line 77 / 78');
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await A.evaluate(() => { document.getElementById('toasts').textContent = ''; });
  await st(A, { achSet: ids }); await sleep(600); pa = await prof(A);
  ok(pa.inventory.filter(s => s.id === 'h_trophy').length === 1 && pa.stats.trophyAt, `${N}/${N}: trophy granted to inventory`);
  ok(/Кубок/.test(await A.textContent('#toasts')), 'notification on award');
  await st(A, { achSet: ids }); await sleep(400); pa = await prof(A); ok(pa.inventory.filter(s => s.id === 'h_trophy').reduce((n, s) => n + s.q, 0) === 1, 'granted only once');
  const eq = await A.evaluate(() => new Promise(r => window.__s.emit('inv:equip', 'h_trophy', r))); await sleep(400); ok(eq && eq.ok, 'equippable as hat: ' + JSON.stringify(eq).slice(0, 80));
  const buy = await A.evaluate(() => new Promise(r => window.__s.emit('buy', 'h_trophy', 1, r))); ok(buy && !buy.ok, 'cannot be bought');
  const sb = await A.evaluate(() => new Promise(r => window.__s.emit('shard:buy', 'h_trophy', 1, r))); ok(sb && !sb.ok, 'not in shard shop');
  await A.click('[data-open=ach]'); await sleep(300); ok(/Получено/.test(await A.textContent('#achTrophyTxt')), 'UI shows received');
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await sleep(800);
  await A.evaluate(() => { const c = document.querySelector('canvas'); }); await A.screenshot({ path: ROOT + '/screenshot-trophy.png', clip: { x: 440, y: 160, width: 400, height: 400 } });
  // existing account that already had all tiers before this update: strip the trophy in the store, restart, log in → awarded on join
  await b.close(); proc.kill(); await sleep(1500);
  const data = JSON.parse(fs.readFileSync('/tmp/tr.json', 'utf8')), acc = data.accounts.trophya;
  acc.inventory.slots = acc.inventory.slots.filter(x => x.id !== 'h_trophy'); delete acc.stats.trophyAt; if (acc.equipped.hat === 'h_trophy') acc.equipped.hat = 'h_none';
  fs.writeFileSync('/tmp/tr.json', JSON.stringify(data));
  const proc2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/tr.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b2 = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const L = await (await b2.newContext()).newPage();
  await L.goto(URL); await sleep(300); await L.fill('#nick', 'TrophyA'); await L.fill('#pass', 'demo-pass-123'); await L.click('#authSubmit'); await L.waitForSelector('#profile:not(.hidden)'); await L.click('#pfPlay'); await L.waitForSelector('#hud:not(.hidden)'); await sleep(1000);
  const d2 = await (async () => { await L.evaluate(async () => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r)); await new Promise(r => s.emit('session', { token: localStorage.getItem('ocs_session') }, r)); window.__s = s; }); return prof(L); })();
  ok(d2.inventory.some(x => x.id === 'h_trophy') && /Кубок/.test(await L.textContent('#toasts')), 'already-complete account: awarded on login');
  await b2.close(); proc2.kill();
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
