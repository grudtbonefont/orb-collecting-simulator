// Screenshots: orbs of all rarities + themed obstacles in zone 1 and 2, normal zoom and phone min zoom.
//   node test/screenshot-orbs.js -> own server on :3111 (test hooks on, random obstacles off)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3111;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-orb-shot-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1', OCS_WEEKEND: 'on' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  const URL = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const vp = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = []; vp.on('pageerror', e => errors.push(e.message)); vp.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await vp.goto(URL); await sleep(500);
  await vp.click('.auth-tab[data-mode=register]');
  await vp.fill('#nick', 'Viewer'); await vp.fill('#pass', PW); await vp.fill('#pass2', PW);
  await vp.click('#authSubmit');
  await vp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  await vp.click('#pfPlay');
  await vp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  await new Promise(r => s.on('connect', r));
  ok((await call('auth', { mode: 'register', name: 'Helper' + Date.now() % 10000, password: PW, confirm: PW })).ok, 'helper bot registered');
  await call('test:tp', { x: 300, y: 300 });
  await call('test:stats', { name: 'Viewer', unlockedDoor2: true });
  await vp.reload(); await sleep(800); await vp.click('.auth-tab[data-mode=login]').catch(() => {});
  if (await vp.isVisible('#nick')) { await vp.fill('#nick', 'Viewer'); await vp.fill('#pass', PW); await vp.click('#authSubmit'); }
  await vp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 }); await vp.click('#pfPlay'); await vp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 }); await sleep(800);
  ok(await vp.evaluate(() => window.OCSZone().open), 'door 2 open for viewer');
  const T = ['c', 'c', 'u', 'u', 'r', 'e', 'l', 'm', 't', 'c', 'u', 'r'];
  let scene = async (cx, cy) => {
    ok((await call('test:tp', { name: 'Viewer', x: cx, y: cy })).ok, `viewer at ${cx},${cy}`); await sleep(600);
    ({ x: cx, y: cy } = await vp.evaluate(() => window.OCSZone())); cx = Math.round(cx); cy = Math.round(cy);
    for (const [kind, x, y] of [['wall', cx - 470, cy - 230], ['block', cx + 470, cy + 150], ['block', cx - 480, cy + 200], ['wall', cx + 300, cy - 300]]) { await call('test:obstacle', { kind, x, y, lifeMs: 120000 }); await sleep(30); }
    for (const ring of [200, 300]) { ok((await vp.evaluate(d => window.OCSEmit('test:spawn', d), { types: T, ring, noExpiry: true })).ok, 'orbs spawned'); await sleep(30); }
    await sleep(1500);
    console.log('vis', await vp.evaluate(() => JSON.stringify(window.OCSZone())));
  };
  await scene(8600, 3000); await vp.screenshot({ path: path.join(ROOT, 'screenshot-orbs-zone2.png') });
  await scene(2000, 2000); await vp.screenshot({ path: path.join(ROOT, 'screenshot-orbs-zone1.png') });
  const mp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
  mp.on('pageerror', e => errors.push(e.message));
  await mp.goto(URL); await sleep(500); await mp.click('.auth-tab[data-mode=login]').catch(() => {});
  await mp.fill('#nick', 'Viewer'); await mp.fill('#pass', PW); await mp.click('#authSubmit');
  await mp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 }); await mp.click('#pfPlay'); await mp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await sleep(800); await call('test:tp', { name: 'Viewer', x: 8600, y: 3000 });
  for (let i = 0; i < 20; i++) await mp.evaluate(() => document.getElementById('zoomOut').click());
  await sleep(2000); await mp.screenshot({ path: path.join(ROOT, 'screenshot-orbs-phone-minzoom.png') });
  ok(!errors.length, 'no page errors ' + errors.slice(0, 3).join(' | '));
  await browser.close(); s.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
