// every completed daily / weekly quest also gives 1 random potion (pending if the inventory is full). Run: NODE_PATH=$(npm root -g) node test/quest-potion-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const C = require('../public/content.js');
const ROOT = process.cwd(), PORT = 3148, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/qp.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/qp.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  ok(/🧪 зелье/.test(C.rewardText({ orbs: 5, potion: 1 })) && /Зелье/.test(C.rewardText({ potion: 'p_luck' })), 'reward label / notification text');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', 'QuestPot'); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)');
  await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600);
  const em = (ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  const pots = pr => pr.inventory.filter(s => /^p_/.test(s.id)).reduce((n, s) => n + s.q, 0);
  let pr = (await em('test:grant', { id: 'p_luck', qty: 1 })).profile; const p0 = pots(pr);
  // daily quest
  let w = (await em('test:quest', { kind: 'mg', n: 0.0001 })); // ensure state
  await p.evaluate(() => { document.getElementById('toasts').textContent = ''; });
  await em('test:quest', { kind: 'mg', n: 25 }); await sleep(700); // completes daily mg quests (if any) + weekly «25 мини-игр»
  pr = (await em('test:grant', { id: 'p_luck', qty: 1 })).profile;
  const doneD = pr.stats.daily.q.filter(q => q.done).length, doneW = pr.stats.weekly.q.filter(q => q.done).length;
  ok(doneW === 1 && pots(pr) - p0 - 1 === doneD + doneW, `1 potion per completed quest (daily ${doneD}, weekly ${doneW})`);
  ok(/🧪 «Зелье/.test(await p.textContent('#toasts')), 'notification names the potion');
  await p.click('[data-open=quests]'); await sleep(300); ok(/\+ 🧪 зелье/.test(await p.textContent('#qList')), 'daily labels show + 🧪 зелье');
  await p.click('#qTabs [data-qtab=weekly]'); await sleep(200); ok((await p.$$eval('#qList .ach-meta', l => l.filter(e => /🧪 зелье/.test(e.textContent)).length)) === 5, 'weekly labels show + 🧪 зелье');
  await p.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  // full inventory → pending, delivered when room appears
  for (let i = 0; i < 40; i++) { const r = await em('test:grant', { id: 'p_magnet', qty: 20 }); if (!r.ok) break; }
  for (let i = 0; i < 20; i++) { const r = await em('test:grant', { id: 'p_magnet', qty: 1 }); if (!r.ok) break; }
  await em('test:quest', { kind: 'event', n: 5 }); await sleep(700);
  pr = (await em('test:grant', { id: 'x', qty: 1 })).profile;
  ok(Array.isArray(pr.stats.pendingPotions) && pr.stats.pendingPotions.length >= 1, 'full inventory → potion pending (' + JSON.stringify(pr.stats.pendingPotions) + ')');
  ok(/ждёт места/.test(await p.textContent('#toasts')), 'notification: waits for room');
  const tr = await em('inv:trash', { id: 'p_magnet', qty: 20 }); ok(tr.ok, 'free room');
  await sleep(6500); pr = (await em('test:grant', { id: 'x', qty: 1 })).profile;
  ok(!pr.stats.pendingPotions, 'pending potion delivered later');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
