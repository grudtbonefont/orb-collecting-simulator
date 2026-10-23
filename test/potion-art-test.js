// Potion sprites: 5 SVG sprites load + rasterize, used on map / inventory / active chips; no page errors. SHOTS=1 → screenshot-potions3.png
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3153, URL = 'http://localhost:' + PORT, SHOTS = process.env.SHOTS === '1', sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/pa.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/pa.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const p = await (await br.newContext({ viewport: { width: 1366, height: 900 } })).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', 'pot' + Date.now() % 100000); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#pfPlay', { state: 'visible' }); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(800);
    ok((await p.evaluate(() => window.OCSPotSprites().sort().join())) === 'luck,magnet,orbs,shard,speed', '5 potion sprites rasterized');
    const kinds = ['p_speed', 'p_orbs', 'p_luck', 'p_magnet', 'p_shard'];
    await p.evaluate(ks => { const me = window.OCSMe ? window.OCSMe() : null; ks.forEach((id, i) => window.OCSEmit('test:grant', { id, qty: 2 })); }, kinds);
    await sleep(400);
    await p.evaluate(() => { const b = document.querySelector('[data-open="inv"]'); b && b.click(); }); await sleep(500);
    const invImgs = await p.evaluate(() => [...document.querySelectorAll('#invGrid img[data-icon^="p_"]')].map(i => i.naturalWidth));
    ok(invImgs.length >= 5 && invImgs.every(w => w > 0), `inventory shows potion icons (${invImgs.length})`);
    await p.evaluate(() => { const d = document.querySelector('#invGrid [data-drink]'); d && d.click(); }); await sleep(800);
    ok(await p.evaluate(() => !!document.querySelector('#hudPotions .pot-chip img')), 'active potion chip uses icon');
    await p.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
    // spawn the 5 potions on the map in a row below the player
    const pos = await p.evaluate(() => { const c = window.OCSCam ? window.OCSCam() : null; return c; });
    await p.evaluate(ks => { const me = window.OCSMe() || null; ks.forEach((item, i) => window.OCSEmit('test:potion', me ? { item, x: me.x - 240 + i * 120, y: me.y + 110 } : { item })); }, kinds);
    await sleep(1200);
    const n = await p.evaluate(() => window.OCSPots().length); ok(n >= 5, `5 potions on the map (${n})`);
    if (SHOTS) {
      await p.evaluate(() => {
        const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:99;background:linear-gradient(160deg,#241e5a,#10142e);border:1px solid #6a5cff;border-radius:22px;padding:14px 18px;display:flex;gap:10px;box-shadow:0 10px 40px #0008';
        for (const k of ['speed', 'orbs', 'luck', 'magnet', 'shard']) { const c = document.createElement('canvas'); c.width = c.height = 400; c.style.width = c.style.height = '200px'; const g = c.getContext('2d'); g.scale(2, 2); window.OCSBottle(g, k, 100, 96, 2.6, 0, true); box.appendChild(c); }
        document.body.appendChild(box);
      });
      await sleep(300); await p.screenshot({ path: 'screenshot-potions3.png' });
    }
    ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  } catch (e) { ok(false, 'exception ' + e.message); }
  await br.close(); proc.kill(); console.log(f ? `${f} FAIL` : 'ALL PASS'); process.exit(f ? 1 : 0);
})();
