// achievements + quests visual v2 (targeted). Run: NODE_PATH=$PWD/node_modules:$(npm root -g) node test/achq-v2-test.js  (SHOTS=1 for screenshots)
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3149, URL = 'http://localhost:' + PORT, SHOTS = process.env.SHOTS === '1', sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/achq.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/achq.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function login(ctxOpt, nick) {
    const p = await (await b.newContext(ctxOpt)).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', nick); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)');
    await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); return p;
  }
  const P = await login({ viewport: { width: 1280, height: 800 } }, 'AchView');
  const em = (p, ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  await em(P, 'test:stats', { total: 1500, rareCaught: 40, epicCaught: 3, bestStreak: 3, questsDone: 4 }); await sleep(400);
  await P.evaluate(() => document.querySelector('[data-open=ach]').click()); await P.waitForSelector('#ach:not(.hidden)'); await sleep(300);
  ok(await P.$('#ach .modal-card.ach-v2'), 'ach v2 card');
  ok((await P.$$('#achTabs .ach-tab .ring')).length === 8, '8 category chips with rings');
  const cols = await P.$$eval('#achTabs .ach-tab', l => new Set(l.map(e => e.style.getPropertyValue('--c'))).size); ok(cols === 8, 'distinct accent colors: ' + cols);
  ok(/\d+\/\d+/.test(await P.textContent('#achTabs .ach-tab')), 'per-category X/Y');
  ok(await P.$('#achList .ach-cathead .big'), 'category header with big icon');
  ok((await P.$$('#achList .ach-item.v2.done')).length >= 0 && (await P.$$('#achList .medal.got')).length >= 2 && (await P.$$('#achList .medal.next')).length >= 1 && (await P.$$('#achList .medal.locked')).length >= 1, 'medals got/next/locked');
  ok((await P.$$('#achList .medal.bronze')).length && (await P.$$('#achList .medal.diamond')).length, 'bronze..diamond medals');
  ok((await P.$$('#achList .rw-chip.orb')).length && (await P.$$('#achList .rw-chip.shard')).length, 'reward chips');
  ok(await P.$('#achList .ach-item.active'), 'in-progress highlighted');
  const bg = await P.$eval('#achTrophy', e => getComputedStyle(e).backgroundImage); ok(/gradient/.test(bg), 'trophy gold banner');
  await P.click('#achTabs .ach-tab[data-cat=boss]'); await sleep(200); const ac = await P.$eval('#ach .modal-card', e => e.style.getPropertyValue('--ac')); ok(ac === '#ff4d6d', 'category switch changes accent ' + ac);
  await P.click('#achTabs .ach-tab[data-cat=orbs]'); await sleep(200);
  const r0 = await P.textContent('#achCount'); await em(P, 'test:stats', { total: 12000 }); await sleep(500); ok((await P.$$('#ach .cf')).length > 0, 'confetti burst on tier completion');
  if (SHOTS) { await sleep(1400); await P.screenshot({ path: ROOT + '/screenshot-ach-v2.png' }); }
  await P.keyboard.press('Escape'); await P.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  // quests
  await em(P, 'test:stats', { quests: [{ id: 'orbs300', rw: { orbs: 80 } }, { id: 'mg5', rw: { shards: 1 } }, { id: 'boss1', rw: { boost: 'orbs', min: 15 } }], streak: 4, streakDay: Math.floor((Date.now() + 3 * 3600e3) / 864e5) - 1 }); await sleep(300);
  await em(P, 'test:quest', { kind: 'orbs', n: 400 }); await em(P, 'test:quest', { kind: 'mg', n: 3 }); await sleep(500);
  ok(await P.$('#qTrack .qt-row .qt-bar') && await P.$('#qTrack .qt-row.done'), 'tracker refreshed (icons, bars, done)');
  await P.click('#questsBtn'); await P.waitForSelector('#quests:not(.hidden)'); await sleep(300);
  ok((await P.$$('#qList .q-item.v2 .q-ic')).length === 3, '3 quest cards with icons');
  ok((await P.$$('#qList .q-item.d1')).length && (await P.$$('#qList .q-item.d3')).length, 'colored difficulty');
  ok(/ВЫПОЛНЕНО/.test(await P.textContent('#qList .q-item.done')), 'completed stamp');
  ok(/\+ 🧪 зелье/.test(await P.textContent('#qList')), 'potion chip text');
  ok(/🔥/.test(await P.textContent('#qStreak')), 'streak flame');
  const t1 = await P.textContent('#qReset .qr-t'); await sleep(1200); const t2 = await P.textContent('#qReset .qr-t'); ok(/\d\d:\d\d:\d\d/.test(t1) && t1 !== t2, 'countdown ticks ' + t1 + ' → ' + t2);
  if (SHOTS) await P.screenshot({ path: ROOT + '/screenshot-quests-v2.png' });
  await P.click('#qTabs [data-qtab=weekly]'); await sleep(200);
  ok(await P.$('#quests .modal-card.q-wk') && (await P.$$('.q-item.weekly')).length === 5 && /понедельник/.test(await P.textContent('#qReset')), 'weekly premium tab');
  ok((await P.$$eval('#qList .ach-meta', l => l.filter(e => /🧪 зелье/.test(e.textContent)).length)) === 5, 'weekly potion chips');
  if (SHOTS) await P.screenshot({ path: ROOT + '/screenshot-quests-v2-weekly.png' });
  // mobile
  const M = await login({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'AchMob');
  await em(M, 'test:stats', { total: 1500, rareCaught: 40 }); await sleep(300);
  await M.evaluate(() => document.querySelector('[data-open=ach]').click()); await M.waitForSelector('#ach:not(.hidden)'); await sleep(400);
  const ov = await M.evaluate(() => { const c = document.querySelector('#ach .modal-card').getBoundingClientRect(); const tabs = document.querySelector('#achTabs').getBoundingClientRect(); return c.left >= -1 && c.right <= innerWidth + 1 && tabs.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth; });
  ok(ov, 'mobile ach fits screen');
  if (SHOTS) { await M.evaluate(() => { document.getElementById('toasts').textContent = ''; }); await sleep(200); await M.screenshot({ path: ROOT + '/screenshot-ach-v2-mobile.png' }); }
  await M.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await M.evaluate(() => document.getElementById('questsBtn').click()); await sleep(400);
  ok(await M.evaluate(() => { const c = document.querySelector('#quests .modal-card').getBoundingClientRect(); return c.right <= innerWidth + 1 && document.querySelectorAll('#qList .q-item.v2').length === 3; }), 'mobile quests fit');
  if (SHOTS) await M.screenshot({ path: '/tmp/quests-mobile.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
