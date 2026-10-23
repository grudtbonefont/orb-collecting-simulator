// potions: same kind stacks DURATION (not strength), capped at 60 min; other kinds independent; persists; HUD + toast. Run: NODE_PATH=$PWD/node_modules node test/potion-stack-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const G = require('../public/shared.js');
const ROOT = process.cwd(), PORT = 3153, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/ocs-ps.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/ocs-ps.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } }); let p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', 'PotStack'); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
  await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600);
  const em = (ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  ok(G.POTION_CAP_MS === 3600000, 'cap 60 min');
  await em('test:grant', { id: 'p_speed', qty: 70 }); await em('test:grant', { id: 'p_luck', qty: 1 }); await sleep(300);
  const r1 = await em('potion:use', 'p_speed'), r2 = await em('potion:use', 'p_speed'), r3 = await em('potion:use', 'p_speed');
  ok(r1.ok && !r1.stacked && r2.stacked && r3.stacked && Math.abs(r3.until - r1.until - 120000) < 30, '3 drinks → 1:00 + 1:00 + 1:00');
  ok(G.potionMult({ potions: { speed: r3.until } }, 'speed') === G.POTIONS.speed.mult, 'strength not stacked (×' + G.POTIONS.speed.mult + ')');
  const l = await em('potion:use', 'p_luck'); ok(l.ok && !l.stacked && l.until - Date.now() <= 90500, 'other kind independent');
  let last; for (let i = 0; i < 60; i++) { const r = await em('potion:use', 'p_speed'); if (!r.ok) { last = r; break; } }
  ok(last && last.code === 'cap', 'refused at cap: ' + (last && last.error));
  await p.reload(); await sleep(400); await p.click('#pfPlay').catch(() => {}); await p.waitForSelector('#hud:not(.hidden)'); await sleep(1200);
  const txt = await p.textContent('#hudPotions'); ok(/(59|60):\d\d/.test(txt), 'persisted after reconnect, HUD shows ~60:00 → ' + txt.trim());
  await em('test:grant', { id: 'p_luck', qty: 1 }); await sleep(200);
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await p.screenshot({ path: '/tmp/ocs-potion-stack.png' });
  await b.close(); proc.kill(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
