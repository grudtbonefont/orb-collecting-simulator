// UI check + screenshots for the content update: boss, achievements, daily quests, mini-events (desktop + mobile).
//   node test/screenshot-content.js   -> own server on :3133 (test hooks on; scheduled mini-events/boss off)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PW = 'demo-pass-123', PORT = 3133;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-content-shot-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  const URL = `http://localhost:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  async function login(name, viewport, mobile) {
    const ctxo = await browser.newContext(Object.assign({ viewport }, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    const vp = await ctxo.newPage();
    const errors = []; vp.on('pageerror', e => errors.push(e.message)); vp.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await vp.goto(URL); await sleep(500);
    await vp.click('.auth-tab[data-mode=register]');
    await vp.fill('#nick', name); await vp.fill('#pass', PW); await vp.fill('#pass2', PW);
    await vp.click('#authSubmit');
    await vp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
    await vp.click('#pfPlay');
    await vp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
    return { vp, errors };
  }
  const { vp, errors } = await login('Viewer', { width: 1280, height: 720 });
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const call = (ev, d) => new Promise(r => s.emit(ev, d, r));
  await new Promise(r => s.on('connect', r));
  ok((await call('auth', { mode: 'register', name: 'Helper' + Date.now() % 10000, password: PW, confirm: PW })).ok, 'helper bot registered');
  await call('play', null);
  const P = { x: 2000, y: 2000 };
  await call('test:tp', { name: 'Viewer', x: P.x, y: P.y });
  await call('test:tp', { x: P.x - 120, y: P.y + 60 });
  // progress so the panels have content: some achievements unlocked, a title, quests in progress
  ok((await call('test:stats', { name: 'Viewer', total: 12000, rareCaught: 340, epicCaught: 40, bossKills: 4, bossDmg: 900, runnersCaught: 3, treasures: 3, minigames: 9, zaps: 12, chests: 2, legendaryCaught: 1,
    quests: [{ id: C_q(1), rw: { boost: 'orbs', min: 5 } }, { id: C_q(2), rw: { shards: 1 } }, { id: C_q(3), rw: { item: 'c_coral' } }] })).ok, 'viewer stats + quests seeded');
  await sleep(800);
  await sleep(4500); // let toasts fade
  const hud = await vp.evaluate(() => ({ shards: document.getElementById('hudShards').textContent, q: document.getElementById('qTrack').textContent }));
  ok(Number(hud.shards) >= 1 && /Задания 0\/3/.test(hud.q), `HUD shows shard balance (${hud.shards}) and quest tracker`);
  // ---- mini-event: golden rain (+ chest elsewhere for the radar)
  ok((await call('test:mini', { kind: 'goldrain', x: P.x + 330, y: P.y - 40, durationMs: 60000 })).ok, 'golden rain forced');
  await vp.waitForSelector('#miniChip:not(.hidden)', { timeout: 5000 }); await sleep(4500);
  const mbox = await vp.locator('#miniChipBtn').boundingBox();
  ok(mbox && mbox.width <= 56 && mbox.height <= 56, `mini-event shown as a small square chip (${mbox && Math.round(mbox.width)}×${mbox && Math.round(mbox.height)})`);
  await vp.hover('#miniChipBtn'); await sleep(300);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-minievent.png') });
  ok(/Золотой дождь/.test(await vp.textContent('#miniChipName')), 'mini chip popup names «Золотой дождь»');
  await call('test:mini', { end: true });
  ok((await call('test:mini', { kind: 'chest', x: P.x + 260, y: P.y + 30, durationMs: 60000 })).ok, 'chest forced');
  await sleep(1500);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-minievent-chest.png') });
  await call('test:mini', { end: true });
  ok((await call('test:mini', { kind: 'portal', x: P.x + 260, y: P.y + 30, durationMs: 60000 })).ok, 'portal forced');
  await sleep(1200);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-minievent-portal.png') });
  await call('test:mini', { end: true });
  // ---- boss
  ok((await call('test:boss', { announceMs: 1500, lifeMs: 120000, hp: 900, x: P.x + 420, y: P.y - 60 })).ok, 'boss announced');
  await sleep(500);
  ok(!(await vp.isHidden('#bossChip')) && /через/.test(await vp.textContent('#bossChipTime')), 'boss chip shows the countdown');
  await sleep(2500);
  // a few bumps from the helper so the HP bar moves
  for (let i = 0; i < 25; i++) { s.emit('input', { x: 1, y: -0.1, seq: i }); await sleep(80); }
  s.emit('input', { x: 0, y: 0, seq: 99 });
  await sleep(4000);
  const bb = await vp.evaluate(() => ({ vis: !document.getElementById('bossBar').classList.contains('hidden'), hp: document.getElementById('bossHpText').textContent }));
  ok(bb.vis && /HP/.test(bb.hp), 'boss HP bar shown: ' + bb.hp);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-boss.png') });
  await call('test:boss', { end: true }); await sleep(800);
  ok(!(await vp.isHidden('#evResult')), 'boss result panel shown');
  await vp.click('#evResult .close').catch(() => {});
  // ---- panels
  await sleep(4000); await vp.keyboard.press('KeyJ'); await sleep(500);
  const ach = await vp.evaluate(() => ({ tabs: document.querySelectorAll('#achTabs .ach-tab').length, n: document.querySelectorAll('#achList .ach-item').length, cnt: document.getElementById('achCount').textContent, t0: document.querySelector('#achList .ach-item b').textContent }));
  ok(ach.tabs === 8 && ach.n === 5 && /Собиратель III/.test(ach.t0), `achievements: 8 category tabs, «Сбор сфер» shows ${ach.n} chains (first: ${ach.t0}), ${ach.cnt} tiers`);
  await vp.click('#achTabs [data-cat=boss]'); await sleep(200);
  const bt = await vp.evaluate(() => Array.from(document.querySelectorAll('#achList .ach-item')).map(e => e.querySelector('b').textContent + ' | ' + e.querySelector('.ach-desc').textContent + ' | ' + e.querySelector('.ach-meta').textContent));
  ok(bt.length === 2 && /Победитель босса II/.test(bt[0]) && /Победитель босса III/.test(bt[0]) && /награда: \+\d+ сфер, \+\d+ оск/.test(bt[0]), 'tap «Босс» tab: current tier, next tier, progress and its reward: ' + bt[0]);
  await vp.click('#achTabs [data-cat=orbs]'); await sleep(200);
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-achievements.png') });
  await vp.keyboard.press('Escape'); await sleep(200);
  await vp.keyboard.press('KeyQ'); await sleep(500);
  const qs = await vp.evaluate(() => ({ n: document.querySelectorAll('#qList .q-item').length, txt: document.getElementById('qList').textContent, b: document.getElementById('qBonus').textContent }));
  ok(qs.n === 3 && /буст|Сферы ×1.5/.test(qs.txt) && /оск/.test(qs.txt) && /предмет/.test(qs.txt), 'quests panel: 3 quests with varied rewards');
  await vp.screenshot({ path: path.join(ROOT, 'screenshot-quests.png') });
  await vp.keyboard.press('Escape');
  const dl = await vp.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const bs = Array.from(document.querySelectorAll('.menu-buttons .btn')).map(b => b.getBoundingClientRect()); const ch = r('.chat'), rd = r('#radar');
    return { first: bs[0].left, last: bs[bs.length - 1].right, chat: ch.right, chatTop: ch.top, menuTop: bs[0].top, radar: rd.left }; });
  ok(dl.first > dl.chat && dl.last < dl.radar, `desktop: 7 menu buttons clear of chat and radar (${Math.round(dl.first)}–${Math.round(dl.last)}, chat→${Math.round(dl.chat)}, radar ${Math.round(dl.radar)})`);
  ok(errors.length === 0, 'no page errors (desktop): ' + errors.slice(0, 3).join(' | '));
  // ---- mobile layout: 7 menu buttons fit, no overlap with joystick zone / chips
  const m = await login('Mobi', { width: 390, height: 844 }, true);
  await call('test:boss', { announceMs: 300, lifeMs: 60000, hp: 900, x: 2600, y: 2000 });
  await call('test:mini', { kind: 'chest', x: 2300, y: 2100, durationMs: 60000 });
  await sleep(1500);
  const lay = await m.vp.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
    const btns = Array.from(document.querySelectorAll('.menu-buttons .btn')).filter(b => b.offsetParent).map(r);
    let overlap = false; for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) { const a = btns[i], b = btns[j]; if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlap = true; }
    const fit = btns.every(b => b.l >= 0 && b.r <= innerWidth);
    const qq = document.getElementById('qTrack').getBoundingClientRect(), bb = document.getElementById('bossBar').getBoundingClientRect(); if (bb.top < qq.bottom - 1) overlap = true;
    const q = r(document.getElementById('qTrack')), boss = r(document.getElementById('bossBar'));
    return { n: btns.length, overlap, fit, q, boss, w: innerWidth };
  });
  ok(lay.n >= 7 && !lay.overlap && lay.fit, `mobile: ${lay.n} menu buttons fit ${lay.w}px without overlap`);
  ok(lay.q.b < 400 && lay.boss.t >= lay.q.t - 200, 'mobile: quest tracker at the top-left under stats (joystick area stays free)');
  await m.vp.screenshot({ path: path.join(ROOT, 'screenshot-mobile-content.png') });
  await sleep(5000); await m.vp.click('#achBtn'); await sleep(400); await m.vp.click('#achTabs [data-cat=events]'); await sleep(300);
  const ma = await m.vp.evaluate(() => { const t = Array.from(document.querySelectorAll('#achTabs .ach-tab')).map(b => b.getBoundingClientRect()); return { n: t.length, fit: t.every(r => r.left >= 0 && r.right <= innerWidth && r.width >= 40), cards: document.querySelectorAll('#achList .ach-item').length, active: document.querySelector('#achTabs .active').dataset.cat }; });
  ok(ma.n === 8 && ma.fit && ma.cards === 4 && ma.active === 'events', `mobile: 8 category tabs fit the screen, tap «Эвенты» → ${ma.cards} chains`);
  await m.vp.evaluate(() => { document.getElementById('toasts').textContent = ''; }); // clear join/boss toasts for a clean shot
  await m.vp.screenshot({ path: path.join(ROOT, 'screenshot-achievements-mobile.png') });
  ok(m.errors.length === 0, 'no page errors (mobile): ' + m.errors.slice(0, 3).join(' | '));
  await browser.close(); s.close();
  console.log(fails ? `${fails} FAIL` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
function C_q(d) { const C = require('../public/content.js'); return C.QUESTS.filter(q => q.diff === d && q.kind !== 'zone2')[0].id; }
