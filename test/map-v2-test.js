// Map visuals v2: themed ground (no grid), zone 1/2, themed obstacles, phone min zoom 0.25; no page errors + FPS sanity. SHOTS=1 → screenshots.
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3155, URL = 'http://localhost:' + PORT, SHOTS = process.env.SHOTS === '1', sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const fps = p => p.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(tick); }));
(async () => {
  try { fs.unlinkSync('/tmp/mapv2.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/mapv2.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const join = async (ctxOpts, tag) => {
    const p = await (await br.newContext(ctxOpts)).newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', tag + Date.now() % 100000); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#pfPlay', { state: 'visible' }); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); return { p, errs };
  };
  const tp = (p, x, y) => p.evaluate(([x, y]) => window.OCSEmit('test:tp', { x, y }), [x, y]);
  const obs = (p, kind, x, y, extra) => p.evaluate(a => window.OCSEmit('test:obstacle', a), Object.assign({ kind, x, y, lifeMs: 120000 }, extra || {}));
  try {
    const { p, errs } = await join({ viewport: { width: 1366, height: 820 } }, 'mapd');
    await p.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
    // zone 1
    await tp(p, 2400, 2600); await sleep(1500);
    const s1 = await p.evaluate(() => window.OCSMapStats()); ok(s1.chunks > 0 && s1.cache > 0, `zone 1 ground chunks cached (${JSON.stringify(s1)})`);
    const f1 = await fps(p); ok(f1 > 20, `desktop FPS sanity zone 1 (${f1.toFixed(1)})`);
    if (SHOTS) await p.screenshot({ path: 'screenshot-map-zone1.png' });
    // zone 2
    await tp(p, 8400, 3200); await sleep(1500);
    await sleep(2500); const f2 = await fps(p); ok(f2 > 20, `desktop FPS sanity zone 2 (${f2.toFixed(1)})`);
    if (SHOTS) await p.screenshot({ path: 'screenshot-map-zone2.png' });
    // obstacles in both zones near the wall (themes side by side)
    await tp(p, 5800, 3000); await sleep(400);
    for (const [k, x, y, e] of [['block', 4700, 2600], ['rock', 5150, 3350], ['laser', 5450, 2550, { a0: 0.4, armNow: true }], ['robot', 4650, 3250], ['wall', 5650, 3400],
      ['block', 7250, 2650], ['rock', 6850, 3350], ['laser', 6550, 2550, { a0: 2.6, armNow: true }], ['robot', 7350, 3300], ['wall', 6350, 3400]]) ok((await obs(p, k, x, y, e)).ok, `spawn ${k} @${x}`);
    await tp(p, 6000, 3000); for (let i = 0; i < 8; i++) await p.evaluate(() => document.getElementById('zoomOut').click()); await sleep(1500);
    const big = await p.evaluate(() => [window.G ? 1 : 1, (window.OCSShared || {}).OBSTACLES]); void big;
    if (SHOTS) await p.screenshot({ path: 'screenshot-obstacles.png' });
    ok(errs.length === 0, 'desktop: no page errors ' + errs.join(' | '));
    // phone, min zoom
    const m = await join({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'mapm');
    await m.p.evaluate(() => document.querySelectorAll('.modal').forEach(x => x.classList.add('hidden')));
    await tp(m.p, 5600, 3000); await sleep(500);
    for (let i = 0; i < 20; i++) await m.p.evaluate(() => document.getElementById('zoomOut').click());
    await sleep(2500);
    const z = await m.p.evaluate(() => window.OCSZoom()); ok(z <= 0.26, `phone min zoom reached (${z})`);
    const sm = await m.p.evaluate(() => window.OCSMapStats()); ok(sm.res <= 0.25, `phone low-res chunks at min zoom (${JSON.stringify(sm)})`);
    const fm = await fps(m.p); ok(fm > 15, `phone FPS sanity at zoom 0.25 (${fm.toFixed(1)})`);
    if (SHOTS) await m.p.screenshot({ path: 'screenshot-map-mobile.png' });
    ok(m.errs.length === 0, 'phone: no page errors ' + m.errs.join(' | '));
  } catch (e) { ok(false, 'exception ' + e.message); }
  await br.close(); proc.kill(); console.log(f ? `${f} FAIL` : 'ALL PASS'); process.exit(f ? 1 : 0);
})();
