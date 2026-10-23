// emote button placement (desktop + mobile, no overlaps) + expanded emote list. Run: NODE_PATH=$(npm root -g) node test/emote-btn-test.js
const { chromium, devices } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const G = require('../public/shared.js');
const ROOT = process.cwd(), PORT = 3147, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/eb.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/eb.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const E = G.ITEMS.filter(i => i.type === 'emote'), shopE = E.filter(i => !i.free);
  ok(E.length === 26 && E.filter(i => i.free).length === 3 && shopE.every(i => i.price >= 25 && i.price <= 670 && i.sources.includes('shop')), `26 emotes (3 free), prices 25–670`);
  ok(['🙏', '🤣', '🥺', '🤡', '🗿', '🫠', '🤯', '😳', '👍', '💯', '🤔', '😏', '👀', '🫡', '🥶'].every(e => E.some(i => i.value === e)), 'new social emotes present');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function run(ctxOpts, name, shot) {
    const p = await (await b.newContext(ctxOpts)).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)');
    await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(900);
    await p.evaluate(() => { document.getElementById('doorBtn').classList.remove('hidden'); document.getElementById('admBtn').classList.remove('hidden'); }); // worst case: door prompt visible too
    if (!(await p.isVisible('#admBtn'))) ok(false, name + ': admin button visible');
    const r = await p.evaluate(() => {
      const box = el => { const e = typeof el === 'string' ? document.querySelector(el) : el; if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { l: b.left, t: b.top, r: b.right, b: b.bottom, n: el } : null; };
      const me = box('#emoteBtn'), sels = ['#radar', '.zoom-btns', '#setBtn', '#helpBtn', '#admBtn', '#doorBtn', '#qTrack', '#chat', '#chatBtn', '.menu-buttons', '#hud .stats', '#hud .top', '#bossBar'];
      const hits = sels.map(box).filter(Boolean).filter(o => !(o.r <= me.l - 4 || o.l >= me.r + 4 || o.b <= me.t - 4 || o.t >= me.b + 4)).map(o => o.n);
      return { me, hits, W: innerWidth, H: innerHeight };
    });
    ok(r.me && r.me.r - r.me.l <= 34, `${name}: small button (${Math.round(r.me.r - r.me.l)}px) at right ${Math.round(r.W - r.me.r)} / bottom ${Math.round(r.H - r.me.b)}`);
    ok(!r.hits.length, `${name}: no overlap/crowding (±4px) ${r.hits.join(',')}`);
    ok(r.me.l > r.W * 0.55, `${name}: outside the joystick zone`);
    await p.evaluate(() => document.getElementById('doorBtn').classList.add('hidden'));
    await p.screenshot({ path: ROOT + '/' + shot.replace('.png', '-closed.png') }).catch(() => {});
    await p.click('#emoteBtn'); await sleep(300);
    const pk = await p.evaluate(() => { const e = document.getElementById('emotePicker'), b = e.getBoundingClientRect(); return { n: e.querySelectorAll('.emo').length, inView: b.top >= 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, scroll: e.scrollHeight > e.clientHeight ? 'scroll' : 'fits' }; });
    ok(pk.n === 26 && pk.inView, `${name}: picker shows 26 emotes inside the viewport (${pk.scroll})`);
    await p.screenshot({ path: ROOT + '/' + shot });
    await p.click('#emotePicker [data-emote=e_thumb]'); await sleep(300); ok(await p.isHidden('#emotePicker'), `${name}: free 👍 sent, picker closes`);
    fs.unlinkSync(ROOT + '/' + shot.replace('.png', '-closed.png'));
  }
  await run({ viewport: { width: 1280, height: 720 } }, 'DragonzTV', 'screenshot-emote-btn-desktop.png');
  await run(Object.assign({}, devices['iPhone 13'], { defaultBrowserType: undefined }), 'MobileUser', 'screenshot-emote-btn-mobile.png');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
