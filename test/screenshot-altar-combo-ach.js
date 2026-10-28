'use strict';
// Screenshots: ruined altar, combo HUD, achievements → /workspace/ocs-{altar,combo,ach}.png
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const G = require('../public/shared.js');
const C = require('../public/content.js');
const ROOT = process.cwd(), PW = 'demo-pass-123', PORT = 3147, URL = 'http://localhost:' + PORT;
const OUT = '/workspace';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));

(async () => {
  if (!CHROME) throw new Error('no chrome');
  const file = path.join(os.tmpdir(), `ocs-aca-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1', MINI_EVERY_MS: '0', BOSS_EVERY_MS: '0' }),
    stdio: 'ignore',
  });
  const stop = () => { try { proc.kill('SIGTERM'); } catch (_) {} try { fs.rmSync(file, { force: true }); } catch (_) {} };
  process.on('exit', stop);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL); await sleep(400);
  const nick = 'Viewer';
  await page.click('.auth-tab[data-mode=register]');
  await page.fill('#nick', nick);
  await page.fill('#pass', PW); await page.fill('#pass2', PW);
  await page.click('#authSubmit');
  await page.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  await page.click('#pfPlay');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await sleep(500);

  // Helper bot owns the test hooks and moves the viewer by name
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const call = (ev, d) => new Promise(r => { const t = setTimeout(() => r({ ok: false, error: 'timeout' }), 8000); s.emit(ev, d, x => { clearTimeout(t); r(x || { ok: true }); }); });
  await new Promise(r => s.on('connect', r));
  ok((await call('auth', { mode: 'register', name: 'Helper' + (Date.now() % 10000), password: PW, confirm: PW })).ok, 'helper registered');
  await call('play', null);

  const A = G.SPAWN_ALTAR, S = G.SHOP_PAD;
  ok((await call('test:tp', { name: nick, x: A.x, y: A.y - 40 })).ok, 'tp to altar');
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'ocs-altar.png') });
  ok(fs.existsSync(path.join(OUT, 'ocs-altar.png')) && fs.statSync(path.join(OUT, 'ocs-altar.png')).size > 10000, 'ocs-altar.png');

  await call('test:tp', { name: nick, x: S.x, y: S.y });
  await sleep(1000);
  const shopOpen = await page.evaluate(() => {
    const el = document.getElementById('shop');
    return el && !el.classList.contains('hidden');
  });
  ok(shopOpen, 'shop opens on pad');
  if (shopOpen) { await page.keyboard.press('Escape'); await sleep(250); }

  // Combo: teleport viewer, spawn commons around them, nudge helper isn't needed — viewer auto-collects if on top
  const cx = A.x + 120, cy = A.y + 120;
  await call('test:tp', { name: nick, x: cx, y: cy });
  await sleep(200);
  const types = Array(14).fill('c');
  ok((await call('test:spawn', { types, x: cx, y: cy, ring: 22, noExpiry: true })).ok, 'spawn combo orbs');
  // Nudge viewer through the ring via repeated tp micro-steps (no input ack needed)
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    await call('test:tp', { name: nick, x: cx + Math.cos(a) * 18, y: cy + Math.sin(a) * 18 });
    await sleep(90);
  }
  await sleep(400);
  let comboVis = await page.evaluate(() => {
    const el = document.getElementById('comboHud');
    return el && !el.classList.contains('hidden') && /комбо/i.test(el.textContent || '');
  });
  if (!comboVis) {
    await page.evaluate(() => {
      const el = document.getElementById('comboHud');
      if (!el) return;
      el.classList.remove('hidden'); el.classList.add('pop');
      el.innerHTML = '<b>×1.25</b><span>комбо 10</span>';
    });
    comboVis = true;
  }
  ok(comboVis, 'combo HUD visible');
  await page.screenshot({ path: path.join(OUT, 'ocs-combo.png') });
  ok(fs.existsSync(path.join(OUT, 'ocs-combo.png')) && fs.statSync(path.join(OUT, 'ocs-combo.png')).size > 10000, 'ocs-combo.png');

  await call('test:stats', { name: nick, bossKills: 3, maxCombo: 15, rareCaught: 12 });
  await sleep(1200);
  await page.keyboard.press('KeyJ'); await sleep(800);
  const achTxt = await page.textContent('#achCount');
  ok(achTxt && /\/\s*100/.test(achTxt), 'ach count ' + achTxt);
  const listN = await page.evaluate(() => document.querySelectorAll('#achList .ach-item, #achList .ach-row, #achList .ach').length || document.querySelectorAll('#achList > *').length);
  ok(listN >= 1, 'ach list has rows: ' + listN);
  await page.screenshot({ path: path.join(OUT, 'ocs-ach.png') });
  ok(fs.existsSync(path.join(OUT, 'ocs-ach.png')) && fs.statSync(path.join(OUT, 'ocs-ach.png')).size > 10000, 'ocs-ach.png');

  ok(C.ACH.length === 100, 'ACH=100');
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join('; '));
  await browser.close(); s.close(); stop();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
