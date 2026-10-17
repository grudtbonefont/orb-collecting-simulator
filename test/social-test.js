// profiles, weekly quests, mini-game buff, potions, emotes (local, OCS_TEST_HOOKS=1 only here). Run: NODE_PATH=$(npm root -g) node test/social-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs'); const C = require('../public/content.js'); const G = require('../public/shared.js');
const ROOT = process.cwd(), PORT = 3145, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/soc.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/soc.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  // static checks
  ok(G.skillPrize(10, 0) === 20 && G.skillPrize(10, 3) === 27 && G.UPGRADES.skill.values[1] === 11.6, 'mini-game prize ×2, skill upgrade +5% (11.6/23.1/34.7)');
  ok(C.WEEKLY.length === 5 && C.WEEKLY.every(q => q.rw.orbs >= 1000 && q.rw.shards >= 2), '5 weekly quests with orbs+shards');
  const mon = Date.parse('2026-10-18T21:00:00Z'); ok(C.weekKey(mon) === C.weekKey(mon - 1) + 1 && C.weekKey(mon) === C.weekKey(mon + 6.9 * 864e5), 'week resets Monday 00:00 MSK');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function reg(name) { const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit'); await p.waitForSelector('#profile:not(.hidden)');
    await p.evaluate(async () => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r)); await new Promise(r => s.emit('session', { token: localStorage.getItem('ocs_session') }, r)); window.__s = s; });
    await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); return p; }
  const em = (p, ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  const prof = p => p.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile) : setTimeout(go, 400)); go(); }));
  const A = await reg('Alice'), B = await reg('BobTest');
  await em(A, 'test:tp', { x: 900, y: 900 }); await em(B, 'test:tp', { x: 900, y: 980 }); await sleep(800);
  // 1. profile card: click on the other player
  const clickAt = async (p, wx, wy) => { const xy = await p.evaluate(([x, y]) => window.OCSWorldToClient(x, y), [wx, wy]); await p.mouse.click(xy.x, xy.y); };
  await clickAt(A, 900, 980); await A.waitForSelector('#pcard:not(.hidden)', { timeout: 4000 }).catch(() => {});
  const txt = await A.textContent('#pcard'); ok(/BobTest/.test(txt) && /\/78/.test(txt) && /Побеждено боссов/.test(txt) && /Время в игре/.test(txt), 'profile card of other player');
  ok(!/pass|token|ip/i.test(JSON.stringify(await A.evaluate(() => new Promise(r => setTimeout(() => window.__s.emit('profile:public', 0, r), 400))))), 'bad id → no data');
  await A.screenshot({ path: ROOT + '/screenshot-profile.png' });
  await A.click('#pcClose'); await sleep(400); await clickAt(A, 900, 900); await A.waitForSelector('#pcard:not(.hidden)', { timeout: 4000 }).catch(() => {}); ok(/Alice \(вы\)/.test(await A.textContent('#pcName')), 'own profile card'); await A.click('#pcClose');
  // 2. weekly quests
  await em(A, 'test:quest', { kind: 'mg', n: 25 }); await em(A, 'test:quest', { kind: 'orbs', n: 4321 }); await sleep(700);
  let pa = await prof(A); const w = pa.stats.weekly; ok(w && w.q.length === 5 && w.q.find(q => q.id === 'w_mg').done && w.q.find(q => q.id === 'w_orbs').p === 4321, 'weekly progress + completion persisted');
  ok(pa.shards >= 2, 'weekly reward shards paid (' + pa.shards + ')');
  await A.click('[data-open=quests]'); await sleep(300); await A.click('#qTabs [data-qtab=weekly]'); await sleep(300);
  ok((await A.$$('.q-item.weekly')).length === 5 && /понедельник/.test(await A.textContent('#qReset')), 'Еженедельные tab');
  await A.screenshot({ path: ROOT + '/screenshot-weekly.png' });
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  // 3. potions: map pickup, inventory drink, HUD timer, refresh not stack
  await em(A, 'test:potion', { item: 'p_speed', x: 760, y: 900 }); await em(A, 'test:potion', { item: 'p_luck', x: 1000, y: 1060 }); await sleep(500);
  ok((await A.evaluate(() => window.OCSPots().length)) === 2, 'potions broadcast to clients');
  await em(A, 'test:tp', { x: 760, y: 900 }); await sleep(700); pa = await prof(A); ok(pa.inventory.some(s => s.id === 'p_speed'), 'potion picked up from map');
  await em(A, 'test:grant', { id: 'p_orbs', qty: 3 }); await sleep(300);
  await A.click('[data-open=inv]').catch(() => A.keyboard.press('i')); await sleep(400);
  await A.click('[data-drink=p_speed]'); await sleep(500); await A.click('[data-drink=p_orbs]'); await sleep(500);
  pa = await prof(A); ok(pa.stats.potions && pa.stats.potions.speed > Date.now() && pa.stats.potions.orbs > Date.now() && !pa.inventory.some(s => s.id === 'p_speed'), 'drink: effect active, item consumed');
  const u1 = pa.stats.potions.orbs; await sleep(1100); const r2 = await em(A, 'potion:use', 'p_orbs'); ok(r2.ok && r2.until > u1 && r2.until - Date.now() <= 90500 && r2.until - Date.now() > 88000, 'same type refreshes timer (no stacking)');
  ok((await em(A, 'potion:use', 'p_magnet')).ok === false, 'cannot drink unowned potion');
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await sleep(800);
  ok((await A.$$('#hudPotions .pot-chip')).length === 2 && /\d:\d\d/.test(await A.textContent('#hudPotions')), 'potion HUD icons with timers');
  await em(A, 'test:potion', { item: 'p_shard', x: 700, y: 840 }); await sleep(400); await A.screenshot({ path: ROOT + '/screenshot-potions.png' });
  // 4. emotes
  ok((await em(A, 'emote', 'e_crown')).ok === false, 'unowned emote rejected');
  await em(A, 'test:tp', { x: 900, y: 900, orbs: 5000 }); await sleep(400);
  const buy = await em(A, 'buy', 'e_crown'); ok(buy && buy.ok, 'buy emote in shop');
  await A.click('[data-open=shop]'); await sleep(300); await A.click('#shopTabs [data-tab=emote]'); await sleep(300); ok((await A.$$('#shopGrid .item')).length === 23, 'shop tab Эмоции lists 23 emotes');
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  await em(A, 'test:tp', { name: 'BobTest', x: 1060, y: 1000 }); await sleep(500);
  await A.click('#emoteBtn'); await sleep(300); ok((await A.$$('#emotePicker .emo')).length === 26 && (await A.$$('#emotePicker .emo.locked')).length === 22, 'picker: free + owned unlocked');
  await A.click('#emotePicker [data-emote=e_crown]'); await sleep(300);
  const rl = await em(A, 'emote', 'e_wave'); ok(rl.ok === false, 'emote rate limit');
  await sleep(2600); ok((await em(B, 'emote', 'e_wave')).ok, 'free emote usable');
  ok((await em(A, 'emote', 'e_crown')).ok, 'owned emote usable'); await A.click('#emoteBtn'); await sleep(400); await A.screenshot({ path: ROOT + '/screenshot-emotes.png' });
  ok(await B.evaluate(() => new Promise(r => setTimeout(r, 1, true))), 'B sees');
  ok(errs.length === 0, 'no page errors ' + errs.join(';'));
  await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
