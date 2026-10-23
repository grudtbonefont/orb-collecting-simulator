// Screenshots (zoomed out 0.5): full door wall ends, former path ground, former fence obstacle. Based on world border (corners + edges, both zones) and the door wall. node test/screenshot-walls.js (own server :3137, test hooks)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const G = require('../public/shared.js');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3141;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-rocks-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  const URL = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const vp = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = []; vp.on('pageerror', e => errors.push(e.message));
  await vp.addInitScript(() => localStorage.setItem('ocs_zoom', '1')); await vp.goto(URL); await sleep(400); await vp.click('.auth-tab[data-mode=register]');
  await vp.fill('#nick', 'Viewer'); await vp.fill('#pass', PW); await vp.fill('#pass2', PW); await vp.click('#authSubmit');
  await vp.waitForSelector('#profile:not(.hidden)'); await vp.click('#pfPlay'); await vp.waitForSelector('#hud:not(.hidden)');
  const s = io(URL, { transports: ['websocket'], forceNew: true }); const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  await new Promise(r => s.on('connect', r));
  await call('auth', { mode: 'register', name: 'Helper' + Date.now() % 10000, password: PW, confirm: PW });
  await call('test:stats', { name: 'Viewer', unlockedDoor2: true }); await sleep(500);
  const W = G.WORLD.w, H = G.WORLD.h, Z = G.ZONE_W;
  for (const [n, x, y] of [['screenshot-rocks', 3000, 3000], ['screenshot-stumps', Z + 3000, 3000]]) { await call('test:tp', { name: 'Viewer', x, y }); await call('test:obstacle', { clear: true });
    for (const [dx, dy] of [[-420, -60], [0, -230], [420, -40]]) await call('test:obstacle', { kind: 'rock', x: x + dx, y: y + dy, lifeMs: 60000 });
    if (n === 'screenshot-rocks') await call('test:obstacle', { kind: 'block', x: x + 30, y: y + 220, lifeMs: 60000 });
    await sleep(2200); await vp.screenshot({ path: path.join(ROOT, n + '.png') }); }
  ok(!errors.length, 'no page errors ' + errors.slice(0, 2).join('|'));
  await browser.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
