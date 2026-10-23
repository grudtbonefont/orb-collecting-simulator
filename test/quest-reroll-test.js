// paid quest reroll (daily 15 / weekly 105 shards). Run: NODE_PATH=$(npm root -g) node test/quest-reroll-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path'); const C = require('../public/content.js');
const ROOT = process.cwd(), PORT = 3158, URL = 'http://localhost:' + PORT, DF = '/tmp/ocs-qrr.json', sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const SH = 'x_legend_shard', PW = 'demo-pass-123';
const start = () => spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: DF, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) return; } catch (_) {} await sleep(200); } };
(async () => {
  try { fs.unlinkSync(DF); } catch (_) {}
  let proc = start(); await up();
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  let p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const login = async (mode) => { await p.goto(URL); await sleep(400); if (await p.isVisible('#hud:not(.hidden)')) return; await p.click(`.auth-tab[data-mode=${mode}]`); await p.fill('#nick', 'Reroller'); await p.fill('#pass', PW); if (mode === 'register') await p.fill('#pass2', PW); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(700); };
  await login('register');
  const em = (ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  const prof = async () => (await em('test:grant', { id: 'nope', qty: 1 })).profile;
  let pr = await prof(); ok(pr.shards === 0, 'starts with 0 shards');
  // not enough shards → error toast (client), server refuses too
  await p.click('[data-open=quests]'); await sleep(300);
  ok(/Сбросить за 15/.test(await p.textContent('#qRerollBtn')) && (await p.$eval('#qRerollBtn .cur-shard', e => { const r = e.getBoundingClientRect(), b = e.parentElement.getBoundingClientRect(), cs = getComputedStyle(e); return r.width >= 8 && r.height >= 10 && r.top >= b.top && r.bottom <= b.bottom && (cs.backgroundImage !== 'none' || cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none'); })), 'daily button «Сбросить за 15 [shard icon]», icon visible inside the button');
  await p.evaluate(() => { document.getElementById('toasts').textContent = ''; }); await p.tap('#qRerollBtn'); await sleep(300);
  ok(/Не хватает осколков/.test(await p.textContent('#toasts')) && await p.isHidden('#qRrDlg'), 'not enough shards → error toast, no dialog');
  const srv = await em('quest:reroll', 'daily'); ok(!srv.ok && srv.code === 'shards', 'server refuses without shards');
  // complete all daily quests → bonus claimed, streak 1
  const d0 = pr.stats.daily; for (const q of d0.q) await em('test:quest', { kind: C.QUEST_BY_ID[q.id].kind, n: 99999 }); await sleep(600);
  pr = await prof(); const doneBefore = pr.stats.questsDone, streak = pr.stats.streak;
  ok(pr.stats.daily.bonus === true && streak === 1, `daily done, bonus claimed, streak ${streak}`);
  pr = await prof(); await em('test:grant', { id: SH, qty: 20 }); await sleep(300); pr = await prof(); const s0 = pr.shards, ids0 = pr.stats.daily.q.map(q => q.id);
  await p.evaluate(() => window.OCSEmit && 0); await p.click('#qTabs [data-qtab=weekly]'); await p.click('#qTabs [data-qtab=daily]'); await sleep(200);
  await p.tap('#qRerollBtn'); await sleep(300); ok(await p.isVisible('#qRrDlg'), 'confirm dialog opens');
  const bx = await p.$eval('.q-rr-card', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  ok(bx.l >= 0 && bx.r <= 390 && bx.t >= 0 && bx.b <= 844, 'dialog fits the phone screen');
  await p.evaluate(() => { document.getElementById('toasts').textContent = ''; }); await p.screenshot({ path: path.join(ROOT, 'screenshot-quest-reroll.png') });
  await p.tap('#qRrNo'); await sleep(200); pr = await prof(); ok(pr.shards === s0 && await p.isHidden('#qRrDlg'), 'cancel: nothing charged');
  await p.tap('#qRerollBtn'); await sleep(200); await p.tap('#qRrYes'); await sleep(700);
  pr = await prof(); const d1 = pr.stats.daily, ids1 = d1.q.map(q => q.id);
  ok(pr.shards === s0 - 15, `daily reroll charged 15 (${s0} → ${pr.shards})`);
  ok(ids1.length === 3 && ids1.filter(i => ids0.includes(i)).length < 3, `fresh daily set (${ids0} → ${ids1})`);
  ok(d1.q.every(q => q.p === 0 && !q.done), 'progress + done flags reset');
  ok(d1.bonus === true && pr.stats.streak === streak && pr.stats.questsDone === doneBefore, 'bonus stays claimed, streak + questsDone untouched');
  ok(/Задания обновлены/.test(await p.textContent('#toasts')) && ids1.every(i => (p, true)), 'success toast');
  // complete the new set: rewards per quest, but no second all-done bonus / streak step
  await p.evaluate(() => { document.getElementById('toasts').textContent = ''; });
  for (const q of d1.q) await em('test:quest', { kind: C.QUEST_BY_ID[q.id].kind, n: 99999 }); await sleep(600);
  pr = await prof(); ok(pr.stats.streak === streak && pr.stats.questsDone === doneBefore + 3 && !/Бонус за все/.test(await p.textContent('#toasts')), 'new set completable; no second daily bonus / streak');
  // weekly
  await p.click('#qTabs [data-qtab=weekly]'); await sleep(200);
  ok(/Сбросить за 105/.test(await p.textContent('#qRerollBtn')) && (await p.$eval('#qRerollBtn .cur-shard', e => { const r = e.getBoundingClientRect(), b = e.parentElement.getBoundingClientRect(), cs = getComputedStyle(e); return r.width >= 8 && r.height >= 10 && r.top >= b.top && r.bottom <= b.bottom && (cs.backgroundImage !== 'none' || cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none'); })), 'weekly button «Сбросить за 105 [shard icon]»');
  await em('test:quest', { kind: 'orbs', n: 50 }); await sleep(300); pr = await prof(); if (pr.shards < 105) await em('test:grant', { id: SH, qty: 105 - pr.shards });
  pr = await prof(); const sw = pr.shards, w0 = pr.stats.weekly.q.map(q => q.id);
  await p.tap('#qRerollBtn'); await sleep(200); await p.tap('#qRrYes'); await sleep(700);
  pr = await prof(); const w1 = pr.stats.weekly.q.map(q => q.id);
  ok(pr.shards === sw - 105 && w1.length === 5 && w1.filter(i => w0.includes(i)).length <= 2 && pr.stats.weekly.q.every(q => q.p === 0 && !q.done), `weekly reroll −105, fresh set (${w1})`);
  ok((await p.$$('#qList .q-item')).length === 5 && /0\/5/.test(await p.textContent('#qStreak')), 'weekly list shows the new 5');
  await sleep(1500); proc.kill(); await sleep(800);
  // persistence across a server restart
  proc = start(); await up(); await p.close(); p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage(); p.on('pageerror', e => errs.push(e.message)); await login('login');
  pr = await prof(); ok(JSON.stringify(pr.stats.weekly.q.map(q => q.id)) === JSON.stringify(w1) && JSON.stringify(pr.stats.daily.q.map(q => q.id)) === JSON.stringify(ids1) && pr.shards === sw - 105, 'rerolled sets persisted');
  pr = await prof(); const r0 = await em('quest:reroll', 'weekly'); ok(pr.shards < 105 && !r0.ok && r0.code === 'shards' && (await prof()).shards === pr.shards, 'weekly reroll refused when short, nothing charged');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
