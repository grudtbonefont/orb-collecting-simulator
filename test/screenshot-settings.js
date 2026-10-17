// ⚙️ settings: per-category notification toggles + music (desktop + mobile).   node test/screenshot-settings.js  (own server :3135, hooks on)
const { chromium } = require('playwright-core'); const { io } = require('socket.io-client'); const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3135, sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-set-${process.pid}.json`);
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
  const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const { vp, errors } = await login('Viewer', { width: 1280, height: 720 });
  const s = io(URL, { transports: ['websocket'], forceNew: true }); const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  await new Promise(r => s.on('connect', r)); await call('auth', { mode: 'register', name: 'Helper' + Date.now() % 10000, password: PW, confirm: PW }); await call('play', null);
  const sb = await vp.locator('#setBtn').boundingBox(), hb = await vp.locator('#helpBtn').boundingBox();
  ok(sb && hb && !overlap(sb, hb) && Math.abs(sb.y - hb.y) < 2, 'desktop: ⚙️ next to «?», no overlap');
  await sleep(3500); await vp.click('#setBtn'); await sleep(300);
  const rows = await vp.evaluate(() => Array.from(document.querySelectorAll('#setCats .set-row')).map(r => r.querySelector('span').firstChild.textContent));
  ok(rows.length === 9 && rows.includes('Легендарные и мифические сферы') && rows.includes('Босс'), `${rows.length} notification categories: ${rows.join(', ')}`);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-settings.png') });
  await vp.click('#setCats input[data-cat=rare]'); await vp.click('#settings .close'); await sleep(200);
  const before = await vp.evaluate(() => document.querySelectorAll('#toasts .toast').length);
  await call('test:spawn', { types: ['l'], ring: 1, x: 3000, y: 3000 }); await sleep(500);
  const t1 = await vp.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map(t => t.textContent));
  ok(!t1.some(t => /легендарная/.test(t)), 'category «Легендарные и мифические сферы» off → no legendary toast');
  await vp.reload(); await sleep(1500);
  ok(await vp.evaluate(() => localStorage.getItem('ocs_toast_rare')) === '0', 'saved in localStorage');
  // music switch synced with 🔊/🔇
  const m0 = await vp.evaluate(() => window.OCSMusic().muted);
  await vp.click('#musicBtn').catch(() => {}); await sleep(200);
  const m1 = await vp.evaluate(() => window.OCSMusic().muted);
  ok(m1 !== m0 && await vp.evaluate(() => localStorage.getItem('ocs_music')) === (m1 ? '0' : '1'), '🔊/🔇 toggles the shared music setting');
  ok(!errors.length, 'no page errors (desktop) ' + errors.slice(0, 2).join('|'));
  const m = await login('Mobi', { width: 390, height: 844 }, true);
  await sleep(500);
  const boxes = {}; for (const id of ['setBtn', 'helpBtn', 'zoomIn', 'zoomOut', 'radar', 'chatBtn']) boxes[id] = await m.vp.locator('#' + id).boundingBox();
  const clash = Object.keys(boxes).filter(k => k !== 'setBtn' && boxes[k] && overlap(boxes.setBtn, boxes[k]));
  ok(boxes.setBtn && !clash.length && boxes.setBtn.x + boxes.setBtn.width <= 390, 'mobile: ⚙️ visible, no overlap ' + clash.join(','));
  await m.vp.tap('#setBtn'); await sleep(300);
  ok(await m.vp.isVisible('#settings .set-card') && await m.vp.evaluate(() => document.getElementById('setMusic').checked === !window.OCSMusic().muted), 'mobile: settings open; music switch matches 🔊/🔇');
  await m.vp.tap('#setMusic'); await sleep(200);
  ok(await m.vp.evaluate(() => window.OCSMusic().muted === !document.getElementById('setMusic').checked && document.getElementById('musicBtn').textContent === (window.OCSMusic().muted ? '🔇' : '🔊')), 'mobile: «Музыка» switch flips 🔊/🔇 too');
  await m.vp.screenshot({ path: path.join(ROOT, 'screenshot-settings-mobile.png') });
  ok(!m.errors.length, 'no page errors (mobile)');
  await browser.close(); s.close(); console.log(fails ? fails + ' FAIL' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
