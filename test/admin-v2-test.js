// admin panel v2 UX (targeted). Run: NODE_PATH=$PWD/node_modules:$(npm root -g) node test/admin-v2-test.js   (SHOTS=1 for screenshots)
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3147, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const SHOTS = process.env.SHOTS === '1';
(async () => {
  try { fs.unlinkSync('/tmp/admv2.json'); } catch (_) {}
  const logs = []; const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/admv2.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => logs.push(String(d))); proc.stderr.on('data', d => logs.push(String(d)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const shop = await (await fetch(URL + '/api/shop')).json(); const byId = Object.fromEntries(shop.items.map(i => [i.id, i]));
  ok(byId.c_coral && byId.c_coral.price === 50 && byId.c_lava.price === 9999 && byId.h_crown.price === 2500, 'server shop api serves new prices');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  let ctxA;
  async function join(name, mob, mode = 'register', ctx) {
    ctx = ctx || await b.newContext(Object.assign({ viewport: mob ? { width: 390, height: 844 } : { width: 1366, height: 800 } }, mob ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message));
    await p.goto(URL); await sleep(300); if (mode === 'register') await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', name); await p.fill('#pass', 'demo-pass-123'); if (mode === 'register') await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); p._ctx = ctx; return p;
  }
  const A = await join('DragonzTV'), P = await join('Player1'), V = await join('Victim1'), W = await join('Wanda7');
  // non-admin: backquote does nothing; server still rejects the new 'stop' action and others
  await P.keyboard.press('Backquote'); await sleep(300); ok(await P.evaluate(() => document.getElementById('admin').classList.contains('hidden')), 'non-admin: ` does not open panel');
  const rej = await P.evaluate(async () => { const out = []; for (const a of ['init', 'stop', 'players', 'ban', 'gift', 'cmd']) out.push(await OCSAdm({ a, kind: 'event', name: 'Victim1', what: 'orbs', n: 5, text: '/god', admin: true })); return out; });
  ok(rej.every(x => x && !x.ok && x.error === 'Нет доступа'), 'non-admin rejected (incl. new stop action)');
  // open with backquote
  await A.keyboard.press('Backquote'); await A.waitForSelector('#admin:not(.hidden)'); await A.waitForSelector('#admEvents .btn'); ok(true, 'admin: ` opens panel');
  ok(await A.locator('.adm-tab').evaluateAll(ts => ts.every(t => /^\S+\s/.test(t.textContent) && /\p{Extended_Pictographic}/u.test(t.textContent))), 'tabs have icons');
  ok(await A.locator('#admin .adm-grp').count() > 15, 'groups built: ' + await A.locator('#admin .adm-grp').count());
  // search
  await A.fill('#admSearch', 'лава'); await sleep(200);
  const sr = await A.evaluate(() => ({ vis: Array.from(document.querySelectorAll('#admin .adm-sec')).filter(s => !s.classList.contains('hidden')).map(s => s.dataset.sec), lava: !!document.getElementById('admLavaGo').offsetParent, orb: !!document.getElementById('admOrbGo').offsetParent }));
  ok(sr.vis.includes('fun') && sr.lava && !sr.orb, 'search "лава" shows lava, hides spawn ' + JSON.stringify(sr));
  await A.fill('#admSearch', 'zzzqqq'); await sleep(100); ok(await A.isVisible('#admNoRes'), 'search: no results message');
  await A.fill('#admSearch', '/tphere'); await sleep(100); ok(await A.evaluate(() => !!document.getElementById('admCmd').offsetParent), 'search finds command help');
  await A.fill('#admSearch', ''); await sleep(100); ok(await A.evaluate(() => !!document.getElementById('admEvents').offsetParent && !document.getElementById('admLavaGo').offsetParent), 'search cleared: back to tab');
  // collapsible group
  const g = A.locator('#admin .adm-sec[data-sec=ev] .adm-grp-h').first(); await g.click(); await sleep(100); ok(!(await A.isVisible('#admEvents')), 'group collapses'); await g.click(); ok(await A.isVisible('#admEvents'), 'group expands');
  // player picker autocomplete
  await A.click('#admPick'); await A.fill('#admPick', 'vic'); await sleep(200); const acTxt = await A.textContent('#admPickList'); ok(/Victim1/.test(acTxt) && !/Player1/.test(acTxt), 'picker autocomplete filters: ' + acTxt);
  await A.locator('#admPickList .adm-ac-i', { hasText: 'Victim1' }).click(); await sleep(200);
  let ui = await A.evaluate(() => OCSAdmUI()); ok(ui.sel === 'Victim1' && await A.isVisible('#admPickActs'), 'player picked → action bar');
  ok(await A.evaluate(() => document.getElementById('admGivePl').value === 'Victim1' && document.getElementById('admPl2').value === 'Victim1' && document.getElementById('admBanName').value === 'Victim1'), 'picked player synced into give/info/ban fields');
  await A.locator('#admPickActs .btn', { hasText: 'Заморозить' }).click(); await sleep(600); ok(await V.evaluate(() => OCSFx().selfFx.frozen), 'picker action: freeze works'); ok(/Разморозить/.test(await A.textContent('#admPickActs')), 'action bar reflects frozen state');
  await A.locator('#admPickActs .btn', { hasText: 'Разморозить' }).click(); await sleep(600); ok(!(await V.evaluate(() => OCSFx().selfFx.frozen)), 'unfreeze');
  // click a player in the online list
  await A.click('.adm-tab[data-sec=pl]'); await sleep(500); await A.locator('#admPlayers .adm-pl[data-name="Wanda7"] b').click(); await sleep(200); ok((await A.evaluate(() => OCSAdmUI().sel)) === 'Wanda7', 'click online-list row selects player');
  await A.locator('#admPickActs .btn', { hasText: 'Инфо' }).click(); await sleep(500); ok(/Wanda7/.test(await A.textContent('#admInfo') + await A.textContent('#admMsg')), 'info for picked player');
  await A.selectOption('#admGiveWhat', 'orbs'); await A.fill('#admGiveQty', '55'); await A.click('#admGiveGo'); await sleep(400); ok(/Выдано/.test(await A.textContent('#admMsg')), 'give to picked player works');
  // destructive confirm (custom dialog) — ban: cancel then accept
  await A.locator('#admPickActs .btn', { hasText: 'Бан' }).click(); ok(await A.isVisible('#admConfirm'), 'ban asks confirm'); await A.click('#admConfirmNo'); await sleep(300); ok(!(await W.evaluate(() => /заблокирован/.test(document.body.textContent))), 'cancel → not banned');
  await A.click('#admInfoGo'); await sleep(200); ok(!(await A.isVisible('#admConfirm')), 'non-destructive action: no confirm');
  await A.click('.adm-tab[data-sec=srv]'); await A.fill('#admGiftN', '5'); await A.click('#admGiftGo'); ok(await A.isVisible('#admConfirm'), 'gift-all asks confirm'); await A.click('#admConfirmYes'); await sleep(400); ok(/✔/.test(await A.textContent('#admMsg')), 'gift-all after confirm: ' + await A.textContent('#admMsg'));
  // Активно strip + stop buttons
  await A.click('[data-w="snow"]'); await A.click('#admNight'); await A.click('.adm-tab[data-sec=ev]'); await A.locator('#admEvents .btn').first().click(); await A.click('#admBoss'); await sleep(1300);
  ui = await A.evaluate(() => OCSAdmUI()); ok(ui.active.some(x => /Снег/.test(x)) && ui.active.some(x => /Ночь/.test(x)) && ui.active.some(x => /Босс/.test(x)) && ui.active.length >= 4, 'Активно strip: ' + ui.active.join(', '));
  if (SHOTS) { await A.click('#admPick'); await A.fill('#admPick', ''); await A.locator('#admPlayers .adm-pl[data-name="Victim1"] b').count(); await A.evaluate(() => document.getElementById('admPick').blur()); await A.fill('#admSearch', ''); await sleep(700); }
  for (const re of [/Снег/, /Ночь/, /Босс/]) { await A.locator('#admActiveList .adm-act', { hasText: re }).locator('.adm-stop').click(); await sleep(700); }
  ui = await A.evaluate(() => OCSAdmUI()); ok(!ui.active.some(x => /Снег|Ночь|Босс/.test(x)), 'stop buttons end effects; left: ' + ui.active.join(', '));
  const evLeft = ui.active.length; if (evLeft) { await A.locator('#admActiveList .adm-stop').first().click(); await sleep(800); } ok((await A.evaluate(() => OCSAdmUI().active.length)) < evLeft || !evLeft, 'stop main event');
  // recent / favourites row
  ui = await A.evaluate(() => OCSAdmUI()); ok(ui.fav.length >= 3, 'recent row: ' + ui.fav.join(' | '));
  await A.locator('#admFav .adm-chip-star').first().click(); ok(await A.locator('#admFav .adm-chip.fav').count() === 1, 'pin to favourites');
  // command autocomplete
  await A.click('.adm-tab[data-sec=cmd]'); await A.click('#admCmd'); await A.fill('#admCmd', '/tph'); await sleep(150); ok(/\/tphere/.test(await A.textContent('#admCmdAc')), 'cmd autocomplete suggests /tphere');
  await A.press('#admCmd', 'Tab'); ok((await A.inputValue('#admCmd')) === '/tphere ', 'Tab completes command'); await sleep(100);
  const hint = await A.textContent('#admCmdAc'); ok(/<ник>/.test(hint) && /Victim1|Wanda7|Player1/.test(hint), 'usage hint + nick suggestions: ' + hint.slice(0, 80));
  await A.type('#admCmd', 'Pla'); await A.press('#admCmd', 'Tab'); ok((await A.inputValue('#admCmd')) === '/tphere Player1 ', 'Tab completes nick');
  await A.press('#admCmd', 'Enter'); await sleep(500); ok(/✔/.test(await A.textContent('#admMsg')), 'command runs: ' + await A.textContent('#admMsg'));
  // drag + remembered position/size, last tab
  await A.click('.adm-tab[data-sec=fun]'); const hb = await A.locator('#admHead h2').boundingBox();
  await A.mouse.move(hb.x + 20, hb.y + 10); await A.mouse.down(); await A.mouse.move(hb.x - 150, hb.y + 60, { steps: 6 }); await A.mouse.up(); await sleep(300);
  const pos1 = await A.locator('#admin .adm-card').boundingBox(); ok(await A.evaluate(() => OCSAdmUI().placed), 'panel dragged ' + Math.round(pos1.x) + ',' + Math.round(pos1.y));
  await A.keyboard.press('Escape'); await A.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'))); await A.mouse.click(5, 400);
  await A.keyboard.press('Backquote'); await A.waitForSelector('#admin:not(.hidden)'); await sleep(300);
  const pos2 = await A.locator('#admin .adm-card').boundingBox(); ok(Math.abs(pos1.x - pos2.x) < 3 && Math.abs(pos1.y - pos2.y) < 3, 'position remembered after reopen');
  ok((await A.evaluate(() => OCSAdmUI().tab)) === 'fun', 'last tab remembered');
  await A.reload(); await A.waitForSelector('#profile:not(.hidden)'); await A.click('#pfPlay'); await A.waitForSelector('#hud:not(.hidden)'); await sleep(600); await A.click('#admBtn'); await A.waitForSelector('#admin:not(.hidden)'); await sleep(600);
  const pos3 = await A.locator('#admin .adm-card').boundingBox(); ok(Math.abs(pos1.x - pos3.x) < 3 && (await A.evaluate(() => OCSAdmUI().tab)) === 'fun' && (await A.locator('#admFav .adm-chip.fav').count()) === 1, 'position/tab/favourites persist across reload');
  await A.click('#admReset'); await sleep(200); ok(!(await A.evaluate(() => OCSAdmUI().placed)), 'reset geometry');
  if (SHOTS) { await A.click('.adm-tab[data-sec=pl]'); await A.click('#admPick'); await A.fill('#admPick', 'Victim1'); await A.press('#admPick', 'Enter'); await A.evaluate(() => { document.activeElement.blur(); }); await A.evaluate(() => { document.querySelector('[data-w="rain"]').click(); document.getElementById('admNight').click(); }); await sleep(900); await A.screenshot({ path: ROOT + '/screenshot-admin-v2.png' }); await A.evaluate(() => { document.querySelector('[data-w="off"]').click(); document.getElementById('admNight').click(); }); }
  // existing features still work through the panel
  await A.click('.adm-tab[data-sec=sp]'); await A.selectOption('#admRarity', 'l'); await A.fill('#admOrbN', '3'); await A.click('#admOrbGo'); await sleep(300); ok(/3 × Легенд/.test(await A.textContent('#admMsg')), 'spawn orbs still works');
  await A.click('.adm-tab[data-sec=pl]'); await A.fill('#admBanName', 'Victim1'); await A.click('#admBanGo'); ok(await A.isVisible('#admConfirm'), 'ban-by-name asks confirm'); await A.click('#admConfirmYes'); await sleep(800);
  ok(await V.evaluate(() => /заблокирован/.test(document.body.textContent)), 'ban after confirm works'); ok(/Victim1/.test(await A.textContent('#admBans')), 'ban list'); await A.locator('#admBans .btn').first().click(); await sleep(600); ok(!/Victim1/.test(await A.textContent('#admBans')), 'unban');
  // mobile: fullscreen sheet
  const M = await join('DragonzTV', true, 'login'); await M.tap('#admBtn'); await M.waitForSelector('#admEvents .btn'); await sleep(300); const bb = await M.locator('#admin .adm-card').boundingBox();
  ok(bb && Math.round(bb.width) === 390 && bb.height >= 840 && bb.x === 0, 'mobile fullscreen sheet ' + JSON.stringify(bb && { w: Math.round(bb.width), h: Math.round(bb.height) }));
  await M.tap('#admPick'); await M.fill('#admPick', 'pla'); await sleep(200); await M.locator('#admPickList .adm-ac-i', { hasText: 'Player1' }).tap(); await sleep(200); ok(await M.isVisible('#admPickActs'), 'mobile: picker works');
  if (SHOTS) { await M.evaluate(() => document.activeElement.blur()); await M.tap('.adm-tab[data-sec=pl]'); await sleep(500); await M.screenshot({ path: ROOT + '/screenshot-admin-v2-mobile.png' }); }
  const log = logs.join(''); ok(/\[admin\] DragonzTV: stop/.test(log) && /\[admin\] Player1: denied/.test(log) && !/\d+\.\d+\.\d+\.\d+/.test(log.split('\n').filter(l => l.includes('[admin]')).join('\n')), 'admin actions logged (no IPs)');
  ok(!errs.length, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await b.close(); proc.kill(); console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
