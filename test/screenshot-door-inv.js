// Screenshots: wall-door along the whole zone border + inventory sort selector (desktop + mobile).
//   node test/screenshot-door-inv.js   -> own server on :3134 (test hooks on)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const G = require('../public/shared.js');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3134;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-doorinv-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  const URL = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  async function login(name, viewport, mobile) {
    const vp = await (await browser.newContext(Object.assign({ viewport }, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}))).newPage();
    const errors = []; vp.on('pageerror', e => errors.push(e.message));
    await vp.goto(URL); await sleep(400); await vp.click('.auth-tab[data-mode=register]');
    await vp.fill('#nick', name); await vp.fill('#pass', PW); await vp.fill('#pass2', PW); await vp.click('#authSubmit');
    await vp.waitForSelector('#profile:not(.hidden)'); await vp.click('#pfPlay'); await vp.waitForSelector('#hud:not(.hidden)');
    return { vp, errors };
  }
  const { vp, errors } = await login('Viewer', { width: 1280, height: 720 });
  const s = io(URL, { transports: ['websocket'], forceNew: true }); const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  await new Promise(r => s.on('connect', r));
  await call('auth', { mode: 'register', name: 'Helper' + Date.now() % 10000, password: PW, confirm: PW });
  // wall-door: far from the middle of the border (y=1200), locked → the unlock button shows here too
  await call('test:tp', { name: 'Viewer', x: G.ZONE_W - 260, y: 1200 }); await sleep(5000);
  const btn = await vp.evaluate(() => !document.getElementById('doorBtn').classList.contains('hidden'));
  ok(btn, 'locked: unlock prompt shown next to the wall far from the old door spot (y=1200)');
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-door-wall.png') });
  await call('test:stats', { name: 'Viewer', unlockedDoor2: true }); await sleep(800);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-door-wall-open.png') });
  // inventory sort
  for (const [id, q] of [['c_coral', 3], ['c_gold', 1], ['t_sparks', 1], ['h_cap', 2], ['c_rainbow', 1], ['n_pink', 5], ['c_void', 1]]) await call('test:grant', { name: 'Viewer', id, qty: q, source: 'event' });
  await sleep(600);
  await vp.keyboard.press('KeyI'); await sleep(400);
  const names = () => vp.evaluate(() => Array.from(document.querySelectorAll('#invGrid .inv-item .name')).map(e => e.textContent));
  await vp.selectOption('#invSort', 'price_desc'); await sleep(200);
  const pd = await names();
  await vp.selectOption('#invSort', 'qty'); await sleep(200);
  const qd = await names();
  await vp.selectOption('#invSort', 'name'); await sleep(200);
  const nd = await names();
  ok(pd[0] === 'Радужный' && qd[0] === G.ITEM_BY_ID.n_pink.name && nd.join() === nd.slice().sort((a, b) => a.localeCompare(b, 'ru')).join(), `sort works: price ↓ first «${pd[0]}», quantity first «${qd[0]}», names A→Я`);
  await vp.selectOption('#invSort', 'price_desc'); await sleep(200);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-inventory-sort.png') });
  await vp.reload(); await sleep(800);
  ok(await vp.evaluate(() => localStorage.getItem('ocs_inv_sort')) === 'price_desc', 'choice persisted in localStorage');
  ok(!errors.length, 'no page errors (desktop) ' + errors.slice(0, 2).join('|'));
  const m = await login('Mobi', { width: 390, height: 844 }, true);
  await m.vp.click('[data-open=inv]'); await sleep(400);
  const box = await m.vp.locator('#invSort').boundingBox();
  ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 28, `mobile: sort selector fits (${Math.round(box.width)}×${Math.round(box.height)})`);
  await m.vp.screenshot({ path: path.join(ROOT, 'screenshot-inventory-sort-mobile.png') });
  ok(!m.errors.length, 'no page errors (mobile)');
  await browser.close(); s.close();
  console.log(fails ? fails + ' FAIL' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
