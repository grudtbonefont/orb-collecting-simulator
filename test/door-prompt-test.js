// zone-2 door prompt on a phone: walk to the wall → prompt, not enough orbs → message, ✕ → hidden until you walk away, buy → unlocked.
// Run: NODE_PATH=$PWD/node_modules node test/door-prompt-test.js  → screenshot-door-prompt-mobile.png
const { chromium, devices } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const G = require('../public/shared.js');
const ROOT = process.cwd(), PORT = 3157, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/ocs-door.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/ocs-door.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function run(opt, nick, shot) {
    const p = await (await b.newContext(opt)).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', nick); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600);
    const em = (ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
    const tp = async x => { await em('test:tp', { x, y: G.ZONE_H / 2 }); await sleep(900); };
    await tp(G.ZONE_W - 300); ok(!(await p.isVisible('#doorPrompt')), nick + ': no prompt far from the wall');
    await tp(G.ZONE_W - 30);
    ok(await p.isVisible('#doorPrompt') && /Купить новую локацию/.test(await p.textContent('#doorPrompt')), nick + ': prompt at the wall');
    const r = await p.evaluate(() => { const q = id => document.getElementById(id).getBoundingClientRect(); const d = q('doorPrompt'), bb = q('doorBtn'), bar = document.querySelector('.menu-buttons').getBoundingClientRect(); const hit = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2); return { d: [d.left, d.top, d.right, d.bottom], W: innerWidth, H: innerHeight, overBar: d.bottom > bar.top, h: bb.height, hit: hit && hit.id }; });
    ok(r.d[0] >= 0 && r.d[2] <= r.W && r.d[1] >= 0 && !r.overBar && r.h >= 44 && r.hit === 'doorBtn', nick + ': fits, above bottom bar, big tappable, on top ' + JSON.stringify(r));
    ok(await p.$eval('#doorBtn', e => e.disabled) && /Не хватает 3\s?750 сфер/.test(await p.textContent('#doorMiss')), nick + ': not enough orbs → missing amount');
    if (shot) { await sleep(3500); await p.screenshot({ path: shot }); }
    await p.click('#doorClose'); await sleep(300); ok(!(await p.isVisible('#doorPrompt')), nick + ': ✕ hides');
    await sleep(800); ok(!(await p.isVisible('#doorPrompt')), nick + ': no spam while still near');
    await em('test:orbs', G.DOOR_COST + 10); await tp(G.ZONE_W - 400);
    await sleep(15200); await tp(G.ZONE_W - 25);
    ok(await p.isVisible('#doorPrompt') && !(await p.$eval('#doorBtn', e => e.disabled)) && !(await p.isVisible('#doorMiss')), nick + ': re-approach → prompt, buy enabled');
    if (opt.hasTouch) await p.tap('#doorBtn'); else await p.click('#doorBtn'); await sleep(800);
    const z = await p.evaluate(() => window.OCSZone()); ok(z.open && !(await p.isVisible('#doorPrompt')), nick + ': bought → zone 2 unlocked, prompt gone');
    await tp(G.ZONE_W + 120); ok((await p.evaluate(() => window.OCSZone())).zone === 2, nick + ': can walk into zone 2');
  }
  await run(Object.assign({}, devices['iPhone 12']), 'DoorMob', ROOT + '/screenshot-door-prompt-mobile.png');
  await run({ viewport: { width: 1280, height: 720 } }, 'DoorDesk', null);
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close(); proc.kill(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
