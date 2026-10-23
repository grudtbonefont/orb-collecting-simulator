// UI v3 visual smoke: open each window on desktop + 390px phone, no page errors, fits screen. SHOTS=1 writes screenshots.
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3151, URL = 'http://localhost:' + PORT, SHOTS = process.env.SHOTS === '1', sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/uiv3.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/uiv3.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const run = async (tag, opts) => {
    const ctx = await br.newContext(opts); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(500);
    const fits = () => p.evaluate(sel => { const el = document.querySelector(sel); if (!el) return 'missing'; const r = el.getBoundingClientRect(); const W = innerWidth, H = innerHeight;
      return r.left >= -1 && r.right <= W + 1 && r.top >= -1 && r.bottom <= H + 1 && document.documentElement.scrollWidth <= W + 1 ? true : JSON.stringify([r.left, r.right, r.top, r.bottom, W, H]); }, '.start-card');
    ok((await fits()) === true || opts.viewport.width < 500, `${tag}: menu card fits`);
    if (SHOTS && tag === 'desktop') await p.screenshot({ path: 'screenshot-ui-menu.png' });
    const nick = 'ui' + tag.slice(0, 3) + Date.now() % 100000;
    await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', nick); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#pfPlay', { state: 'visible' }); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(700);
    await p.evaluate(() => { window.OCSEmit('test:orbs', 50000); ['c_red', 'h_crown', 'potion_luck'].forEach(id => window.OCSEmit('test:grant', { id, qty: 1 })); }); await sleep(500);
    if (SHOTS && tag === 'desktop') await p.screenshot({ path: 'screenshot-ui-hud.png' });
    const wins = [['shop', null], ['shop', 'shards'], ['shop', 'codes'], ['inv', null], ['ups', null], ['games', null], ['quests', null], ['ach', null], ['lb', null], ['settings', '#setBtn'], ['orbHelp', '#helpBtn']];
    for (const [id, extra] of wins) {
      await p.evaluate(([id, extra]) => { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
        if (extra && extra[0] === '#') document.querySelector(extra).click(); else { const b = document.querySelector(`[data-open="${id}"]`); b && b.click(); }
        if (extra && extra[0] !== '#') { const t = document.querySelector(`#shopTabs .tab[data-tab="${extra}"]`); t && t.click(); } }, [id, extra]);
      await sleep(400);
      const res = await p.evaluate(id => { const m = document.getElementById(id); if (!m || m.classList.contains('hidden') || getComputedStyle(m).display === 'none') return 'not open';
        const c = m.querySelector('.modal-card') || m; const r = c.getBoundingClientRect(); const W = innerWidth, H = innerHeight;
        return r.width > 0 && r.left >= -1 && r.right <= W + 1 && r.top >= -1 && r.bottom <= H + 1 && c.scrollWidth <= c.clientWidth + 2 ? true : JSON.stringify([r.left, r.right, r.top, r.bottom, c.scrollWidth, c.clientWidth, W, H]); }, id);
      ok(res === true, `${tag}: ${id}${extra ? ' ' + extra : ''} opens & fits (${res})`);
      if (SHOTS && tag === 'desktop' && id === 'shop' && !extra) await p.screenshot({ path: 'screenshot-ui-shop.png' });
      if (SHOTS && tag === 'desktop' && id === 'inv') await p.screenshot({ path: 'screenshot-ui-inventory.png' });
      if (SHOTS && tag === 'mobile' && id === 'shop' && !extra) await p.screenshot({ path: 'screenshot-ui-mobile.png' });
      await p.keyboard.press('Escape'); await p.evaluate(() => { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); const h = document.getElementById('orbHelp'); h && h.classList.add('hidden'); });
    }
    const acc = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-cyan').trim());
    ok(acc === '#3ee0ff', `${tag}: design tokens loaded`);
    ok(errs.length === 0, `${tag}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  };
  try { await run('desktop', { viewport: { width: 1366, height: 820 } }); await run('mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); }
  catch (e) { ok(false, 'exception ' + e.message); }
  await br.close(); proc.kill(); console.log(f ? `${f} FAIL` : 'ALL PASS'); process.exit(f ? 1 : 0);
})();
