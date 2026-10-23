// admin panel / commands / disco / ban (targeted). Run: NODE_PATH=$(npm root -g) node test/admin-test.js
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3141, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const SHOTS = process.env.SHOTS === '1';
(async () => {
  try { fs.unlinkSync('/tmp/adm.json'); } catch (_) {}
  const logs = []; const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/adm.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => logs.push(String(d))); proc.stderr.on('data', d => logs.push(String(d)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const r = await fetch(URL + '/audio/disco.m4a'); ok(r.status === 200 && r.headers.get('content-type').includes('audio'), 'disco.m4a 200');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
  async function join(name, mob, mode = 'register') {
    const ctx = await b.newContext(Object.assign({ viewport: mob ? { width: 390, height: 844 } : { width: 1280, height: 720 } }, mob ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    await ctx.addInitScript(() => { window.__A = new Set(); window.__max = 0; const P = HTMLMediaElement.prototype, op = P.play; P.play = function () { __A.add(this); return op.call(this); }; setInterval(() => { const n = [...__A].filter(x => !x.paused).length; if (n > __max) __max = n; }, 30); });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(URL); await sleep(300); if (mode === 'register') await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); if (mode === 'register') await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); return p;
  }
  const emit = (p, d) => p.evaluate(d => new Promise(res => window.__sock ? window.__sock.emit('adm', d, res) : res(null)), d);
  const A = await join('DragonzTV'), P = await join('Player1'), V = await join('Victim1');
  // expose sockets for raw emits (forged admin attempts)
  for (const p of [A, P]) await p.evaluate(() => { window.__sock = window.io ? null : null; });
  ok(await A.evaluate(() => OCSFx().btn), 'admin sees 🛡️ button'); ok(!(await P.evaluate(() => OCSFx().btn)), 'non-admin: no button');
  // non-admin: every action rejected by the server (raw socket from the page, forged flags)
  const actions = ['init', 'players', 'bans', 'event', 'mini', 'boss', 'orbs', 'obstacle', 'give', 'kick', 'ban', 'unban', 'cmd', 'disco'];
  const rej = await P.evaluate(async acts => { const s = io({ transports: ['websocket'] }); await new Promise(r => s.on('connect', r));
    const tok = localStorage.getItem('ocs_session'); await new Promise(r => s.emit('session', { token: tok }, r));
    const out = []; for (const a of acts) out.push(await new Promise(r => s.emit('adm', { a, kind: 'treasure', t: 'm', n: 5, name: 'Victim1', what: 'orbs', qty: 999, text: '/god', admin: true, isAdmin: true }, r)));
    const chat = await new Promise(r => s.emit('chat', '/disco', r)); s.close(); return { out, chat }; }, actions);
  ok(rej.out.slice(0, actions.length).every(x => x && x.ok === false && x.error === 'Нет доступа'), 'non-admin rejected for all ' + actions.length + ' actions');
  ok(rej.chat && !rej.chat.ok, 'non-admin /command in chat rejected');
  const vBal0 = await V.evaluate(() => document.getElementById('hudBal') ? 0 : 0);
  // admin panel UI
  await A.click('#admBtn'); await A.waitForSelector('#admin:not(.hidden)'); await A.waitForSelector('#admEvents .btn'); ok(await A.locator('#admEvents .btn').count() >= 3, 'panel: events listed');
  if (SHOTS) await A.screenshot({ path: ROOT + '/screenshot-admin.png' });
  await A.locator('#admEvents .btn').first().click(); await sleep(300); ok(/✔/.test(await A.textContent('#admMsg')), 'start event: ' + await A.textContent('#admMsg'));
  await A.locator('#admMinis .btn').first().click(); await sleep(300); ok(/✔/.test(await A.textContent('#admMsg')), 'start mini');
  await A.click('#admBoss'); await sleep(300); ok(/✔/.test(await A.textContent('#admMsg')), 'boss');
  await A.click('.adm-tab[data-sec=sp]'); await A.selectOption('#admRarity', 'l'); await A.fill('#admOrbN', '5'); await A.click('#admOrbGo'); await sleep(300); ok(/5 × Легенд/.test(await A.textContent('#admMsg')), 'spawn orbs: ' + await A.textContent('#admMsg'));
  await A.selectOption('#admObsKind', 'robot'); await A.click('#admObsGo'); await sleep(300); ok(/✔/.test(await A.textContent('#admMsg')), 'spawn robot: ' + await A.textContent('#admMsg'));
  await A.click('.adm-tab[data-sec=pl]'); await sleep(500); ok(await A.locator('#admPlayers .adm-pl').count() === 3, 'players listed');
  await A.selectOption('#admGivePl', 'Victim1'); await A.selectOption('#admGiveWhat', 'orbs'); await A.fill('#admGiveQty', '777'); await A.click('#admGiveGo'); await sleep(400);
  ok(/Выдано/.test(await A.textContent('#admMsg')), 'give orbs');
  await A.selectOption('#admGiveWhat', 'shards'); await A.fill('#admGiveQty', '3'); await A.click('#admGiveGo'); await sleep(300); ok(/Выдано/.test(await A.textContent('#admMsg')), 'give shards');
  await A.selectOption('#admGiveWhat', 'item'); const itemId = await A.evaluate(() => document.querySelector('#admGiveItem option:nth-child(3)').value); await A.selectOption('#admGiveItem', itemId); await A.fill('#admGiveQty', '1'); await A.click('#admGiveGo'); await sleep(300); ok(/Выдано/.test(await A.textContent('#admMsg')), 'give item ' + itemId);
  // commands typed in chat (never broadcast)
  await A.keyboard.press('Escape'); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
  const say = async t => { await A.fill('#chatInput', t); await A.press('#chatInput', 'Enter'); await sleep(1700); };
  await say('/announce Всем привет!'); ok(await P.evaluate(() => !document.getElementById('annOverlay').classList.contains('hidden') && document.getElementById('annText').textContent === 'Всем привет!'), '/announce shown full-screen to others');
  ok(!(await P.evaluate(() => document.getElementById('chatLog').textContent.includes('/announce'))), 'command not broadcast to chat');
  await say('/mute Player1 5'); const mr = await P.evaluate(() => new Promise(r => { const i = document.getElementById('chatInput'); i.value = 'hi there'; document.getElementById('chatForm').requestSubmit(); setTimeout(() => r(document.getElementById('chatLog').textContent), 800); }));
  ok(/не можете писать/.test(mr), '/mute blocks chat'); await say('/unmute Player1');
  await say('/freeze Player1'); const p0 = await P.evaluate(() => 1); await P.keyboard.down('d'); await sleep(700); await P.keyboard.up('d'); ok(await P.evaluate(() => OCSFx().selfFx.frozen), '/freeze applied to player'); await say('/unfreeze Player1');
  await say('/god'); ok(await A.evaluate(() => OCSFx().selfFx.god), '/god on'); await say('/speed 2'); ok(await A.evaluate(() => OCSFx().selfFx.spd === 2), '/speed 2');
  await say('/tphere Player1'); await say('/x2 1'); ok(await P.evaluate(() => OCSFx().x2), '/x2 active for others');
  await say('/clearchat'); ok(await P.evaluate(() => document.querySelectorAll('#chatLog .chat-msg:not(.notice)').length === 0), '/clearchat');
  // disco: on (button), multipliers via server log-free check, music + overlay, toggle off
  await A.click('#admBtn'); await A.click('.adm-tab[data-sec=disco]'); await A.fill('#admDiscoMin', '3'); await A.click('#admDiscoGo'); await sleep(1200);
  let s = await P.evaluate(() => ({ fx: OCSFx(), m: OCSMusic() })); ok(s.fx.disco && s.fx.overlay, 'disco overlay for others'); ok(s.m.disco && /disco\.m4a/.test(s.m.bgSrc) && !s.m.bgPaused && s.m.playing === 1, 'disco track playing (1 audio) ' + s.m.bgSrc);
  ok(!(await P.evaluate(() => document.getElementById('discoChip').classList.contains('hidden'))), 'disco chip with timer: ' + await P.textContent('#discoChipTime'));
  if (SHOTS) { await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await sleep(600); await A.screenshot({ path: ROOT + '/screenshot-disco.png' }); await A.click('#admBtn'); await A.click('.adm-tab[data-sec=disco]'); }
  ok(/Выключить/.test(await A.textContent('#admDiscoGo')), 'disco button shows toggle-off');
  await A.click('#admDiscoGo'); await sleep(1200); s = await P.evaluate(() => ({ fx: OCSFx(), m: OCSMusic() }));
  ok(!s.fx.disco && !s.fx.overlay && !s.m.disco && /bg\d\.m4a/.test(s.m.bgSrc) && !s.m.bgPaused, 'disco toggled off: overlay gone, bg playlist resumed ' + s.m.bgSrc);
  await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await say('/disco 1'); ok(await P.evaluate(() => OCSFx().disco), '/disco starts'); await say('/disco'); ok(!(await P.evaluate(() => OCSFx().disco)), '/disco again ends');
  ok((await P.evaluate(() => window.__max)) <= 1, 'never 2 audio playing at once');
  // disco multiplier: same 4 epic orbs collected with disco off vs on → gain ×1.5
  const bal = async () => { await sleep(500); return A.evaluate(() => Number(document.getElementById('hudSession').textContent.replace(/\D/g, ''))); }; // session score = orbs from collecting only (no quest / achievement payouts)
  const gain = async () => { const b0 = await bal(); await A.evaluate(() => new Promise(r => { document.getElementById('admin').classList.remove('hidden'); document.querySelector('.adm-tab[data-sec=sp]').click(); r(); }));
    await A.selectOption('#admRarity', 'l'); await A.fill('#admOrbN', '6'); await A.selectOption('#admOrbWhere', 'here'); await A.click('#admOrbGo'); await sleep(1500); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); return (await bal()) - b0; };
  await say('/x2 0'); const g0 = await gain(); await say('/disco 1'); const g1 = await gain(); await say('/disco');
  ok(g0 > 0 && Math.abs(g1 / g0 - 1.5) < 0.12, `disco orbs ×1.5 (off ${g0}, on ${g1})`);
  // music toggle off during disco = silent
  await say('/disco 1'); await P.evaluate(() => { const e = document.getElementById('setMusic'); e.checked = false; e.dispatchEvent(new Event('change')); }); await sleep(300); ok((await P.evaluate(() => OCSMusic().playing)) === 0, 'music toggle off silences disco'); await say('/disco');
  // ban: kicks, blocks login and session; unban restores
  await A.click('#admBtn'); await A.click('.adm-tab[data-sec=pl]'); await sleep(400); await A.fill('#admBanName', 'Victim1'); await A.click('#admBanGo'); await A.click('#admConfirmYes'); await sleep(800);
  ok(await V.evaluate(() => /заблокирован/.test(document.body.textContent)), 'banned player kicked'); ok(/Victim1/.test(await A.textContent('#admBans')), 'ban list shows Victim1');
  const ctx2 = await b.newContext(); const L = await ctx2.newPage(); await L.goto(URL); await sleep(300); await L.fill('#nick', 'Victim1'); await L.fill('#pass', 'demo-pass-123'); await L.click('#authSubmit'); await sleep(1200);
  ok(await L.evaluate(() => /заблокирован/.test(document.body.textContent)) && await L.evaluate(() => document.getElementById('hud').classList.contains('hidden')), 'banned cannot log in');
  await V.reload(); await sleep(1500); ok(await V.evaluate(() => document.getElementById('hud').classList.contains('hidden')), 'banned stored session cannot rejoin');
  await A.locator('#admBans .btn').first().click(); await sleep(800); ok(!/Victim1/.test(await A.textContent('#admBans')), 'unban');
  await L.fill('#nick', 'Victim1'); await L.fill('#pass', 'demo-pass-123'); await L.click('#authSubmit'); await L.waitForSelector('#profile:not(.hidden)', { timeout: 5000 }).then(() => ok(true, 'unbanned can log in'), () => ok(false, 'unbanned can log in'));
  // mobile admin panel
  await A.close(); const M = await join('DragonzTV', true, 'login'); await M.tap('#admBtn'); await M.waitForSelector('#admEvents .btn'); const bb = await M.locator('#admin .modal-card').boundingBox();
  ok(bb && bb.width <= 390 && bb.x >= 0, 'mobile panel fits ' + JSON.stringify(bb && { w: Math.round(bb.width) })); await M.tap('.adm-tab[data-sec=pl]'); await sleep(400); ok(await M.isVisible('#admGiveGo'), 'mobile players section usable');
  if (SHOTS) await M.screenshot({ path: ROOT + '/screenshot-admin-mobile.png' });
  const log = logs.join(''); ok(/\[admin\] DragonzTV: give/.test(log) && /\[admin\] Player1: denied/.test(log) && !/\d+\.\d+\.\d+\.\d+/.test(log.split('\n').filter(l => l.includes('[admin]')).join('\n')), 'admin actions logged server-side (no IPs)');
  ok(errs.length === 0, 'no page errors ' + errs.join(';'));
  await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
