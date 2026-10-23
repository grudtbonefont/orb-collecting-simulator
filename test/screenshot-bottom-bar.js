// Screenshots (zoomed out 0.5): full door wall ends, former path ground, former fence obstacle. Based on world border (corners + edges, both zones) and the door wall. node test/screenshot-walls.js (own server :3137, test hooks)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const G = require('../public/shared.js');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3143;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-bar-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  const URL = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  for (const [n, opt] of [['screenshot-bottom-bar', { viewport: { width: 1280, height: 720 } }], ['screenshot-bottom-bar-mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const vp = await (await browser.newContext(opt)).newPage(); vp.on('pageerror', e => errors.push(e.message));
    await vp.goto(URL); await sleep(400); await vp.click('.auth-tab[data-mode=register]'); const nick = 'Bar' + (Date.now() % 100000);
    await vp.fill('#nick', nick); await vp.fill('#pass', PW); await vp.fill('#pass2', PW); await vp.click('#authSubmit');
    await vp.waitForSelector('#profile:not(.hidden)'); await vp.click('#pfPlay'); await vp.waitForSelector('#hud:not(.hidden)'); await sleep(1500);
    const bx = await vp.locator('.menu-buttons').boundingBox(), vw = opt.viewport.width;
    ok(bx.x >= 0 && bx.x + bx.width <= vw, n + ' bar fits ' + JSON.stringify(bx));
    const sizes = await vp.evaluate(() => Array.from(document.querySelectorAll('.menu-buttons .btn')).map(b => [b.offsetWidth, b.offsetHeight]));
    ok(sizes.every(([w, h]) => w >= 40 && h >= 40), n + ' touch sizes ' + JSON.stringify(sizes));
    await vp.hover('.menu-buttons [data-open=inv]').catch(() => {});
    const pad = 16, x = Math.max(0, bx.x - pad), y = Math.max(0, bx.y - pad);
    await vp.screenshot({ path: path.join(ROOT, n + '.png'), clip: { x, y, width: Math.min(vw - x, bx.width + pad * 2), height: bx.height + pad * 2 } });
    await vp.screenshot({ path: path.join(os.tmpdir(), 'ocs-' + n + '-full.png') });
    await vp.click('.menu-buttons [data-open=shop]'); await sleep(300); ok(await vp.evaluate(() => !!document.querySelector('.modal:not(.hidden)')), n + ' shop opens');
  }
  ok(!errors.length, 'no page errors ' + errors.slice(0, 2).join('|'));
  await browser.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
