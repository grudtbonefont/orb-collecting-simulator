// admin expansion + fun events (targeted). Run: NODE_PATH=$(npm root -g) node test/admin2-test.js   (SHOTS=1 → screenshot-admin.png)
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3143, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/adm2.json'); } catch (_) {}
  const logs = []; const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/adm2.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => logs.push(String(d))); proc.stderr.on('data', d => logs.push(String(d)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
  async function join(name, mob) {
    const ctx = await b.newContext(Object.assign({ viewport: mob ? { width: 390, height: 844 } : { width: 1280, height: 720 } }, mob ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600);
    await p.evaluate(async () => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r)); await new Promise(r => s.emit('session', { token: localStorage.getItem('ocs_session') }, r)); window.__s = s; });
    return p;
  }
  const A = await join('DragonzTV'), P = await join('Player2');
  const adm = (p, d) => p.evaluate(d => OCSAdm(d), d);
  const cmd = (t) => adm(A, { a: 'cmd', text: t });
  // non-admin rejected for every new action
  const acts = [['custom', { name: 'X', orb: 3 }], ['rain', { t: 'm', n: 50 }], ['invis', {}], ['troll', { name: 'DragonzTV', size: 3 }], ['info', { name: 'DragonzTV' }], ['warn', { name: 'DragonzTV', reason: 'x' }], ['gift', { what: 'orbs', n: 999 }], ['weather', { w: 'rain' }], ['night', {}], ['bosstimer', {}], ['restart', { sec: 30 }], ['codes', {}], ['code:create', { code: 'HACK1', orbs: 9999 }], ['code:toggle', { code: 'X' }], ['log', {}],
    ...['hunt', 'giant', 'chaos', 'lava', 'ghost', 'freeze', 'chest', 'poll', 'endpoll'].map(k => ['fun', { kind: k, o: { q: 'q', opts: ['a', 'b'] } }])];
  let allRej = true; for (const [a, d] of acts) { const r = await adm(P, Object.assign({ a, admin: true }, d)); if (!r || r.ok !== false || r.error !== 'Нет доступа') { allRej = false; console.log('  not rejected:', a, d.kind || '', JSON.stringify(r)); } }
  ok(allRej, `non-admin rejected for all ${acts.length} new actions`);
  for (const c of ['/rain m 50', '/invis', '/size DragonzTV 3', '/info DragonzTV', '/warn DragonzTV x', '/gift orbs 9', '/weather rain', '/night', '/code HACK2 999', '/hunt', '/giant', '/chaos', '/lava', '/ghost', '/freezeall', '/chest', '/poll a | b | c', '/event X 5']) {
    const r = await P.evaluate(t => new Promise(res => window.__s.emit('chat', t, res)), c); if (!r || r.ok) { allRej = false; console.log('  chat cmd not rejected', c); } }
  ok(allRej, 'non-admin chat commands rejected');
  // move P next to A for touch-based tests
  await cmd('/tphere Player2'); await sleep(400);
  // custom event
  let r = await adm(A, { a: 'custom', name: 'Супер час', orb: 2, luck: 1.5, spd: 1.3, min: 2 }); ok(r.ok, 'custom event start'); await sleep(700);
  ok(await P.evaluate(() => OCSFx().cev && !document.getElementById('cevChip').classList.contains('hidden') && /Супер час/.test(document.getElementById('cevChipName').textContent)), 'custom event chip with name+timer: ' + await P.textContent('#cevChipTime'));
  const sess = async () => { await sleep(600); return A.evaluate(() => Number(document.getElementById('hudSession').textContent.replace(/\D/g, ''))); };
  const grabUi = async () => { const s0 = await sess(); await adm(A, { a: 'orbs', t: 'l', n: 6, where: 'here' }); await sleep(1300); return (await sess()) - s0; };
  await A.click('#admBtn'); await A.waitForSelector('#admEvents .btn'); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  const gOn = await grabUi(); await adm(A, { a: 'custom', off: true }); await sleep(300); const gOff = await grabUi();
  ok(gOff > 0 && Math.abs(gOn / gOff - 2) < 0.15, `custom event orbs ×2 (off ${gOff}, on ${gOn})`); ok(!(await P.evaluate(() => OCSFx().cev)), 'custom event toggled off');
  // rain
  r = await adm(A, { a: 'rain', t: 'r', n: 40, sec: 2 }); await sleep(3000); ok(r.ok && /Дождь/.test(r.msg), 'orb rain: ' + r.msg);
  // invisibility
  await cmd('/invis'); await sleep(500);
  const pIds = await P.evaluate(() => window.OCSDebugSnap ? window.OCSDebugSnap() : null);
  ok(pIds && pIds.length === 1, 'invisible admin missing from others\' updates (P sees ' + JSON.stringify(pIds) + ')');
  const aIds = await A.evaluate(() => window.OCSDebugSnap ? window.OCSDebugSnap() : null); ok(aIds && aIds.length === 2, 'admin still gets own position');
  await cmd('/invis'); await sleep(500); ok((await P.evaluate(() => OCSDebugSnap())).length === 2, 'invis off → visible again');
  // troll size / skin
  r = await adm(A, { a: 'troll', name: 'Player2', size: 2.5, sec: 5 }); await sleep(400); ok(r.ok && await A.evaluate(() => OCSDebugPl('Player2').sz === 2.5), 'troll size seen by others');
  r = await adm(A, { a: 'troll', name: 'Player2', color: '#ff00aa', sec: 5 }); await sleep(400); ok(await A.evaluate(() => OCSDebugPl('Player2').eq.color === '#ff00aa'), 'troll skin');
  await sleep(5300); ok(await A.evaluate(() => { const p = OCSDebugPl('Player2'); return p.sz === 1 && p.eq.color !== '#ff00aa'; }), 'troll reverts after timer');
  // warn x3 → auto mute; info
  for (let i = 0; i < 3; i++) await cmd('/warn Player2 спам ' + i); await sleep(300);
  ok(await P.evaluate(() => !document.getElementById('annOverlay').classList.contains('hidden') && /Предупреждение/.test(document.getElementById('annTitle').textContent)), 'warning shown to player');
  const muted = await P.evaluate(() => new Promise(res => { const i = document.getElementById('chatInput'); i.value = 'привет всем'; document.getElementById('chatForm').requestSubmit(); setTimeout(() => res(document.getElementById('chatLog').textContent), 800); }));
  ok(/не можете писать/.test(muted), '3 warnings → auto-mute');
  r = await adm(A, { a: 'info', name: 'Player2' }); ok(r.ok && r.info.warns.length === 3 && r.info.mutedMin > 0 && typeof r.info.balance === 'number' && 'playMin' in r.info && 'shards' in r.info && 'items' in r.info, 'player info: ' + JSON.stringify(r.info).slice(0, 120));
  // promo codes
  r = await adm(A, { a: 'code:create', code: 'Party2026', orbs: 77, shards: 1, maxUses: 1, days: 2 }); ok(r.ok && r.codes.some(c => c.code === 'PARTY2026'), 'code created');
  let red = await P.evaluate(() => new Promise(res => window.__s.emit('code:redeem', 'party2026', res))); ok(red.ok && red.rewards.orbs === 77, 'new code redeemable');
  const old = await A.evaluate(() => new Promise(res => window.__s.emit('code:redeem', 'TREASURE', res))); ok(old.ok, 'hardcoded code still works');
  await adm(A, { a: 'code:create', code: 'OFFCODE', orbs: 5 }); r = await adm(A, { a: 'code:toggle', code: 'OFFCODE' }); ok(r.ok && r.codes.find(c => c.code === 'OFFCODE').disabled, 'code disabled');
  red = await P.evaluate(() => new Promise(res => window.__s.emit('code:redeem', 'OFFCODE', res))); ok(!red.ok, 'disabled code rejected');
  const saved = JSON.parse(fs.readFileSync('/tmp/adm2.json', 'utf8')); ok(saved.adminCodes && saved.adminCodes.PARTY2026, 'codes persisted in store');
  // weather / night / restart / bosstimer / gift
  await adm(A, { a: 'weather', w: 'snow' }); await adm(A, { a: 'night' }); await adm(A, { a: 'restart', sec: 30 }); await sleep(700);
  let fx = await P.evaluate(() => ({ w: document.getElementById('weatherFx').className, n: !document.getElementById('nightFx').classList.contains('hidden'), rb: document.getElementById('restartBar').textContent }));
  ok(/snow/.test(fx.w) && fx.n && /Перезапуск/.test(fx.rb), 'weather snow + night + restart countdown: ' + fx.rb);
  if (process.env.SHOTS === '1') { await A.click('#admBtn'); await A.click('.adm-tab[data-sec=fun]'); await sleep(300); await A.screenshot({ path: ROOT + '/screenshot-admin.png' }); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); }
  await adm(A, { a: 'weather', w: 'off' }); await adm(A, { a: 'night' }); await adm(A, { a: 'restart', sec: 0 }); await sleep(400);
  ok(await (await fetch(URL + '/api/health')).ok, 'server still up after restart countdown (no real restart)');
  r = await adm(A, { a: 'bosstimer' }); ok(r.ok, 'boss timer reset');
  const pb0 = (await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }))); r = await adm(A, { a: 'gift', what: 'orbs', n: 50 }); await sleep(900);
  const pb1 = (await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }))); ok(r.ok && pb1 - pb0 >= 50, `gift to all (+${pb1 - pb0})`);
  // fun: hunt — P touches admin
  await cmd('/tp Player2'); r = await adm(A, { a: 'fun', kind: 'hunt', o: { orbs: 123, min: 1 } }); await sleep(100); await cmd('/tphere Player2'); await sleep(800);
  ok(r.ok && await P.evaluate(() => /поймал/.test(document.getElementById('annText').textContent)) && !(await P.evaluate(() => OCSFun().fun.hunt)), 'hunt: player touching admin wins');
  // giant
  const gp0 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }));
  r = await adm(A, { a: 'fun', kind: 'giant', o: { total: 400, sec: 20 } }); await sleep(300); ok(r.ok && await P.evaluate(() => OCSFun().fun.giant && OCSFun().fun.giant.r === 70), 'giant orb spawned');
  await cmd('/tphere Player2'); await sleep(600); ok(await P.evaluate(() => OCSFun().fun.giant.n === 1), 'giant touched by player');
  await cmd('/giant'); await sleep(900); const gp1 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }));
  ok(!(await P.evaluate(() => OCSFun().fun.giant)) && gp1 - gp0 >= 400, `giant ends → reward split (+${gp1 - gp0})`);
  // chaos
  await adm(A, { a: 'fun', kind: 'chaos' }); await sleep(400); ok(await P.evaluate(() => OCSFun().mult === -1) && await A.evaluate(() => OCSFun().mult === 1), 'chaos inverts controls (not for admin)');
  await adm(A, { a: 'fun', kind: 'chaos' }); await sleep(300); ok(await P.evaluate(() => OCSFun().mult === 1), 'chaos off');
  // freeze map
  await adm(A, { a: 'fun', kind: 'freeze' }); await sleep(300); const pp0 = await P.evaluate(() => OCSDebugMe()); await P.keyboard.down('d'); await sleep(700); await P.keyboard.up('d'); await sleep(400); const pp1 = await P.evaluate(() => OCSDebugMe());
  ok(await P.evaluate(() => OCSFun().mult === 0) && Math.abs(pp1.x - pp0.x) < 2, 'freeze map: player cannot move');
  await adm(A, { a: 'fun', kind: 'freeze' }); await sleep(300);
  // lava: P far from islands loses ≤30
  const lb0 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); })); r = await adm(A, { a: 'fun', kind: 'lava', o: { sec: 30 } });
  await sleep(500); const isl = await P.evaluate(() => OCSFun().fun.lava.islands); ok(r.ok && isl.length >= 1, 'lava islands: ' + isl.length);
  await sleep(4000); const lb1 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); setTimeout(go, 800); }));
  ok(lb0 - lb1 >= 0 && lb0 - lb1 <= 30, `lava: gentle loss ${lb0 - lb1} (cap 30)`); ok(await P.evaluate(() => !document.getElementById('lavaFx').classList.contains('hidden')), 'lava overlay');
  await adm(A, { a: 'fun', kind: 'lava' });
  // ghost: P next to admin → caught, small loss, stunned
  const gb0 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); })); await adm(A, { a: 'fun', kind: 'ghost', o: { sec: 30 } }); await sleep(200); await cmd('/tphere Player2'); await sleep(1500);
  const gb1 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); setTimeout(go, 700); }));
  ok(await P.evaluate(() => /Призрак поймал/.test(document.getElementById('chatLog').textContent)) && gb0 - gb1 <= 40 && gb0 - gb1 >= 0, `ghost catch: −${gb0 - gb1} (cap 10/catch, 40 total)`);
  await adm(A, { a: 'fun', kind: 'ghost' });
  // chest
  await cmd('/tp Player2'); await sleep(300); for (let i = 0; i < 3; i++) { await A.keyboard.down('d'); await sleep(400); await A.keyboard.up('d'); } await sleep(300);
  const cb0 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }));
  r = await adm(A, { a: 'fun', kind: 'chest', o: { orbs: 222 } }); await sleep(300); ok(r.ok && await P.evaluate(() => !!OCSFun().fun.chest), 'chest placed');
  await cmd('/tphere Player2'); await sleep(800); const cb1 = await P.evaluate(() => new Promise(res => { const go = () => window.__s.emit('profile:get', null, x => x && x.profile ? res(x.profile.balance) : setTimeout(go, 400)); go(); }));
  ok(!(await P.evaluate(() => OCSFun().fun.chest)) && cb1 - cb0 >= 222, `chest found → prize (+${cb1 - cb0})`);
  // poll
  r = await cmd('/poll Лучший цвет? | Красный | Синий'); await sleep(500); ok(r.ok && await P.evaluate(() => OCSFun().pollShown), 'poll shown to players');
  await P.locator('#pollOpts .poll-opt').nth(1).click(); await sleep(500); ok(await A.evaluate(() => OCSFun().poll.counts[1] === 1), 'vote counted live');
  r = await cmd('/endpoll'); await sleep(400); ok(await P.evaluate(() => OCSFun().poll && OCSFun().poll.done), 'poll results shown');
  // log view
  r = await adm(A, { a: 'log' }); ok(r.ok && r.log.length > 20 && r.log.some(e => e.action === 'denied') && !JSON.stringify(r.log).match(/\d+\.\d+\.\d+\.\d+|ocs_session/), 'action log (' + r.log.length + ' entries, no IPs)');
  ok(errs.length === 0, 'no page errors ' + errs.join(';'));
  await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
