// UI check + screenshots for temporary obstacles, rotating lasers and «Волна удачи».
//   node test/screenshot-obstacles.js   -> starts its own server on :3109 (test hooks on, random obstacles off)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3109;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-obs-shot-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
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
  const C = { x: 2000, y: 2000 };
  ok((await call('test:tp', { name: 'Viewer', x: C.x, y: C.y, orbs: 1500 })).ok, 'viewer moved to the test spot');
  await sleep(500);
  const spawns = [['wall', C.x - 420, C.y - 120], ['block', C.x + 380, C.y + 170], ['rock', C.x - 250, C.y + 220], ['laser', C.x + 120, C.y - 150], ['laser', C.x + 520, C.y - 240]];
  const made = [];
  for (const [kind, x, y] of spawns) { const r = await call('test:obstacle', { kind, x, y, lifeMs: 60000 }); made.push(r.ok); }
  ok(made.every(Boolean), 'wall, block, rock and two lasers spawned around the viewer');
  await sleep(1200);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-obstacles-warning.png') });
  await sleep(2600); // lasers arm after the 3 s warning
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-obstacles.png') });
  await call('test:obstacle', { clear: true });
  await call('test:obstacle', { kind: 'rock', x: C.x - 250, y: C.y + 220, lifeMs: 60000 }); await sleep(4500); // let the toasts fade
  const r = await call('test:event', { kind: 'lucky', announceMs: 100, durationMs: 30000 });
  ok(r.ok, 'lucky wave forced');
  await vp.waitForSelector('#evChip:not(.hidden)', { timeout: 5000 });
  await sleep(5500); // toasts fade
  const box = await vp.locator('#evChipBtn').boundingBox();
  ok(box && box.width <= 56 && box.height <= 56 && !(await vp.isVisible('#evBanner')) && !(await vp.isVisible('#evHud')) && !(await vp.isVisible('#evChipPop')), `event shown as a small square chip (${box && Math.round(box.width)}×${box && Math.round(box.height)}), popup closed`);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-event-lucky.png') });
  await vp.hover('#evChipBtn'); await sleep(300);
  const hud = await vp.evaluate(() => document.getElementById('evChipName').textContent + ' | ' + document.getElementById('evChipTime').textContent + ' | ' + document.getElementById('evChipInfo').textContent);
  ok(await vp.isVisible('#evChipPop') && /Волна удачи/.test(hud) && /×2/.test(hud) && /^.*\| 0:\d\d \|/.test(hud), 'hover opens the info popup: ' + hud);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-event-icons.png') });
  await vp.mouse.move(400, 400); await sleep(200);
  ok(!(await vp.isVisible('#evChipPop')), 'popup closes when the mouse leaves');
  // phone: tap opens, tap elsewhere closes, joystick area untouched
  const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); mp.on('pageerror', e => errors.push(e.message));
  await mp.goto(URL); await sleep(400);
  await mp.fill('#nick', 'Viewer'); await mp.fill('#pass', PW); await mp.tap('#authSubmit');
  await mp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 }); await mp.tap('#pfPlay');
  await mp.waitForSelector('#evChip:not(.hidden)', { timeout: 10000 }); await sleep(800);
  await mp.tap('#evChipBtn'); await sleep(200);
  const openM = await mp.isVisible('#evChipPop');
  await mp.screenshot({ path: path.join(ROOT, 'screenshot-event-icons-mobile.png') });
  await mp.tap('#evChipBtn'); await sleep(200); const closedAgain = !(await mp.isVisible('#evChipPop'));
  await mp.tap('#evChipBtn'); await sleep(200); await mp.touchscreen.tap(80, 600); await sleep(200);
  const mb = await mp.locator('#evChipBtn').boundingBox();
  ok(openM && closedAgain && !(await mp.isVisible('#evChipPop')) && mb.x > 300 && mb.width <= 50, 'phone: tap opens the popup, tap again / tap elsewhere closes it; chip sits at the right edge, away from the joystick');
  await mctx.close();
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  s.close(); await browser.close(); proc.kill('SIGTERM'); fs.rmSync(file, { force: true });
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
