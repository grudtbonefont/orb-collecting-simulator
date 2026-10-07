// Headless Chrome UI check + screenshots (login, profile, inventory, shop, desktop chat, mobile chat closed/open).
//   node test/screenshot.js          -> seeds demo accounts into a temp file and starts its own server on :3102
//   node test/screenshot.js <url>    -> uses a running server (demo accounts must exist there)
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const { spawn, execFileSync } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { fails++; process.exitCode = 1; } };
const PW = 'demo-pass-123';
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));

async function startOwnServer(port, env = {}, seed = true) {
  try { await fetch(`http://localhost:${port}/api/health`); throw new Error(`port ${port} is already in use`); } catch (e) { if (/in use/.test(e.message)) throw e; }
  const file = path.join(os.tmpdir(), `ocs-demo-${process.pid}-${port}.json`);
  if (seed) execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), file], { stdio: 'inherit' });
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATA_FILE: file, DATABASE_URL: '' }, env), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch (_) { /* wait */ } await sleep(200); }
  return { url: `http://localhost:${port}`, stop: () => { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } };
}
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, name) });

function bot(url, name) {
  const s = io(url, { transports: ['websocket'], forceNew: true });
  const b = { s, name, id: null, pos: null, seq: 0, ids: new Map(), positions: new Map() };
  s.on('s', st => { for (const [id, x, y] of st.p) { b.positions.set(id, { x, y }); if (id === b.id) b.pos = { x, y }; } });
  s.on('pjoin', p => b.ids.set(p.name, p.id));
  s.on('sping', v => s.emit('spong', v));
  b.login = () => new Promise(res => s.emit('auth', { mode: 'login', name, password: PW }, r => {
    if (r && r.ok) { b.id = r.you; for (const p of r.players) { b.ids.set(p.name, p.id); if (p.id === r.you) b.pos = { x: p.x, y: p.y }; } }
    res(r);
  }));
  b.say = text => new Promise(res => s.emit('chat', text, res));
  b.follow = (getTarget, i) => { b.timer = setInterval(() => {
    const t = getTarget(); if (!b.pos || !t) return;
    const ang = Date.now() / 900 + i * 2.1;
    const tx = t.x + Math.cos(ang) * (120 + i * 40), ty = t.y + Math.sin(ang) * (90 + i * 30);
    let dx = tx - b.pos.x, dy = ty - b.pos.y; const l = Math.hypot(dx, dy);
    if (l < 6) { dx = dy = 0; } else { dx /= l; dy /= l; }
    s.emit('input', { s: ++b.seq, x: dx, y: dy });
  }, 50); };
  b.close = () => { clearInterval(b.timer); s.close(); };
  return b;
}

(async () => {
  const own = process.argv[2] ? null : await startOwnServer(3102);
  const URL = process.argv[2] || own.url;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  const watch = page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); };

  // ---------------- desktop: login screen
  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const desk = await deskCtx.newPage();
  watch(desk);
  await desk.goto(URL);
  await sleep(900);
  await desk.screenshot({ path: path.join(ROOT, 'screenshot-login.png') });
  await desk.click('.auth-tab[data-mode=register]');
  await desk.fill('#nick', 'bad__name');
  await sleep(200);
  ok(/только один знак _/.test(await desk.textContent('#joinError')), 'register form validates nickname live: ' + await desk.textContent('#joinError'));
  await desk.fill('#nick', 'Demo'); await desk.fill('#pass', 'demo-pass-123'); await desk.fill('#pass2', 'other-pass');
  await desk.click('#authSubmit');
  ok(/не совпадают/.test(await desk.textContent('#joinError')), 'confirm mismatch shown: ' + await desk.textContent('#joinError'));
  await desk.screenshot({ path: path.join(ROOT, 'screenshot-register.png') });
  await desk.click('.auth-tab[data-mode=login]');
  await desk.fill('#nick', 'Demo'); await desk.fill('#pass', 'wrong-pass');
  await desk.click('#authSubmit'); await sleep(600);
  ok(/Неверный ник или пароль/.test(await desk.textContent('#joinError')), 'wrong password message shown');
  await desk.fill('#pass', PW);
  await desk.click('#authSubmit');
  // ---------------- profile screen (after login, before the arena)
  await desk.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  ok(!(await desk.isVisible('#hud')), 'login opens the profile screen, not the arena');
  const token = await desk.evaluate(() => localStorage.getItem('ocs_session'));
  ok(/^[A-Za-z0-9_-]{43}$/.test(token || ''), 'session token stored in localStorage');
  const pf = await desk.evaluate(() => Object.fromEntries(['pfName', 'pfRank', 'pfBalance', 'pfTotal', 'pfTime', 'pfSessions', 'pfItems', 'pfReaction', 'pfRush', 'pfSince'].map(id => [id, document.getElementById(id).textContent])));
  ok(pf.pfName === 'Demo' && pf.pfRank === '#1' && /2\s?450/.test(pf.pfBalance) && /48\s?210/.test(pf.pfTotal) && /11 ч 25 мин/.test(pf.pfTime) && pf.pfSessions === '27'
    && /^17 · 15\/100$/.test(pf.pfItems) && pf.pfReaction === '231 мс' && /34/.test(pf.pfRush) && /создан/.test(pf.pfSince), 'profile shows rank, balance, total, play time, sessions, items, best results: ' + JSON.stringify(pf));
  const avatarPixels = await desk.evaluate(() => { const c = document.getElementById('pfAvatar'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  ok(avatarPixels > 2000, `equipped look preview is drawn (${avatarPixels} px)`);
  for (const id of ['pfPlay', 'pfInv', 'pfLogout']) ok(await desk.isVisible('#' + id), `profile button #${id} visible`);
  await shot(desk, 'screenshot-profile.png');
  await desk.click('#pfInv');
  await sleep(300);
  ok(await desk.isVisible('#inv') && /Занято 15\/100/.test(await desk.textContent('#invCount')), 'Инвентарь opens from the profile: ' + await desk.textContent('#invCount'));
  await desk.keyboard.press('Escape');
  await sleep(150);
  ok(!(await desk.isVisible('#inv')) && await desk.isVisible('#profile'), 'closing the inventory returns to the profile');
  await desk.click('#pfPlay');
  await desk.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  ok(!(await desk.isVisible('#profile')), 'Играть enters the arena');
  ok(await desk.isVisible('#chat') && !(await desk.isVisible('#chatBtn')), 'desktop: chat panel visible, mobile chat button hidden');
  ok(/следующая очистка в \d\d:\d\d/.test(await desk.textContent('#chatLog')), 'chat shows when it is cleared next');

  // bots
  const bots = ['Kometa', 'StarGazer', 'Nova_7'].map(n => bot(URL, n));
  for (const b of bots) await b.login();
  const demoPos = () => { const b = bots[0]; const id = b.ids.get('Demo'); return id && b.positions.get(id); };
  bots.forEach((b, i) => b.follow(demoPos, i));
  await sleep(500);
  await bots[0].say('Привет! Кто со мной за легендарной сферой?');
  await sleep(300);
  await bots[1].say('Я на севере карты, тут куча редких 🔮');
  await sleep(300);
  await bots[2].say('Заходите на www.example.com и мой ip 10.0.0.12');
  // move a bit
  for (const [k, ms] of [['KeyD', 1200], ['KeyS', 700], ['KeyA', 600]]) { await desk.keyboard.down(k); await sleep(ms); await desk.keyboard.up(k); }
  await sleep(500);

  // typing must not move the player or trigger hotkeys
  await desk.keyboard.press('Enter');
  ok(await desk.evaluate(() => document.activeElement.id === 'chatInput'), 'Enter focuses chat input');
  const before = demoPos();
  await desk.keyboard.down('KeyD'); await sleep(900); await desk.keyboard.up('KeyD');
  await desk.keyboard.type('bml wasd');
  await sleep(400);
  const after = demoPos();
  const moved = before && after ? Math.hypot(after.x - before.x, after.y - before.y) : -1;
  ok(moved >= 0 && moved < 1, `typing in chat does not move the player (moved ${moved.toFixed(1)}px)`);
  ok(!(await desk.isVisible('#shop')) && !(await desk.isVisible('#games')) && !(await desk.isVisible('#lb')), 'hotkeys B/M/L ignored while typing');
  await desk.fill('#chatInput', 'Всем привет! Иду к вам 🚀');
  await desk.keyboard.press('Enter');
  await sleep(500);
  ok(await desk.evaluate(() => document.activeElement.id !== 'chatInput'), 'Enter sends and returns focus to the game');
  const lastMine = await desk.evaluate(() => Array.from(document.querySelectorAll('#chatLog .chat-msg')).map(e => e.textContent).pop());
  ok(/Demo: Всем привет/.test(lastMine), 'own message appears in chat: ' + lastMine);
  ok(await desk.evaluate(() => !document.querySelector('#chatLog b')), 'HTML in messages is not rendered (textContent only)');
  await bots[0].say('<b>не жирный</b> текст');
  await sleep(300);
  ok(await desk.evaluate(() => !document.querySelector('#chatLog b') && /<b>не жирный<\/b>/.test(document.querySelector('#chatLog').textContent)), 'HTML from other players shown as plain text');
  await desk.keyboard.press('KeyT');
  await desk.keyboard.type('пишу ответ…');
  await sleep(300);
  await desk.screenshot({ path: path.join(ROOT, 'screenshot-chat-desktop.png') });
  await desk.keyboard.press('Escape');
  ok(await desk.evaluate(() => document.activeElement.id !== 'chatInput'), 'Esc leaves the chat input');
  await desk.keyboard.press('KeyB'); await sleep(300);
  ok(await desk.isVisible('#shop'), 'hotkey B works again after leaving chat');
  // ---------------- shop: only sells; bought items land in the inventory
  await sleep(300);
  const shopState = await desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item')).map(e => [e.querySelector('.name').textContent, e.querySelector('button').textContent, e.querySelector('button').disabled]));
  ok(shopState.length === 6 && !shopState.some(([n]) => n === 'Бирюзовый') && shopState.filter(x => /В инвентаре/.test(x[1])).length === 4 && shopState.some(x => /Купить · 2\s?400/.test(x[1]) && !x[2]),
    'shop lists only paid items with prices; owned ones say «В инвентаре»: ' + shopState.map(x => x[0] + '=' + x[1]).join(', '));
  await shot(desk, 'screenshot-shop.png');
  const hudBal = () => desk.evaluate(() => Number(document.querySelector('#hudBalance').textContent.replace(/\s/g, '')));
  const violetBtn = desk.locator('#shopGrid .item', { hasText: 'Фиолетовый' }).locator('button');
  const balBefore = await hudBal();
  await violetBtn.click();
  await sleep(500);
  ok(/В инвентаре/.test(await violetBtn.textContent()) && /Куплено: Фиолетовый/.test(await desk.textContent('#toasts')), 'purchase confirmed, item marked «В инвентаре»');
  const balAfter = await hudBal();
  ok(balAfter <= balBefore - 400 + 30 && balAfter >= balBefore - 400, `balance reduced by 400 (${balBefore} → ${balAfter}; the player may pick up a few orbs meanwhile)`);
  await desk.keyboard.press('Escape');
  // ---------------- inventory (hotkey I)
  await desk.keyboard.press('KeyI'); await sleep(400);
  ok(await desk.isVisible('#inv') && /Занято 16\/100/.test(await desk.textContent('#invCount')), 'hotkey I opens the inventory with the new item: ' + await desk.textContent('#invCount'));
  const shardQty = await desk.evaluate(() => { const e = document.querySelector('#invGrid [data-item=x_legend_shard] .qty'); return e && e.textContent; });
  ok(shardQty === '×3', 'stackable item shows its quantity: ' + shardQty);
  const violet = desk.locator('#invGrid [data-item=c_violet] button');
  ok(/Надеть/.test(await violet.textContent()), 'new item can be equipped from the inventory');
  await violet.click(); await sleep(500);
  const demoId = bots[0].ids.get('Demo');
  ok(/Снять/.test(await violet.textContent()), 'button switches to «Снять» after equipping');
  await desk.evaluate(() => { document.querySelector('#inv .modal-card').scrollTop = 0; });
  await sleep(3400); // let the toasts fade
  await shot(desk, 'screenshot-inventory.png');
  await desk.click('#invTabs .tab[data-tab=hat]'); await sleep(200);
  ok(await desk.evaluate(() => Array.from(document.querySelectorAll('#invGrid .item')).every(e => ['h_cap', 'h_tophat', 'h_crown'].includes(e.dataset.item))), 'category tabs filter the inventory');
  await desk.click('#invTabs .tab[data-tab=all]'); await sleep(200);
  await desk.locator('#invGrid [data-item=c_violet] button').click(); await sleep(400);
  ok(/Надеть/.test(await desk.locator('#invGrid [data-item=c_violet] button').textContent()), 'unequip from the inventory');
  await desk.locator('#invGrid [data-item=c_rainbow] button').click(); await sleep(300);
  await desk.keyboard.press('Escape');
  // ---------------- in-game profile (hotkey P / name button)
  await desk.keyboard.press('KeyP'); await sleep(900);
  ok(await desk.isVisible('#profile') && await desk.isVisible('#profileClose') && /Продолжить/.test(await desk.textContent('#pfPlay')), 'hotkey P opens the profile in game');
  const pfBal = Number((await desk.textContent('#pfBalance')).replace(/[^0-9]/g, ''));
  ok(Math.abs(pfBal - await hudBal()) <= 30 && /^18 · 16\/100$/.test(await desk.textContent('#pfItems')), `in-game profile is up to date: balance ${pfBal}, items ${await desk.textContent('#pfItems')}`);
  await desk.click('#pfPlay'); await sleep(200);
  ok(!(await desk.isVisible('#profile')) && await desk.isVisible('#hud'), 'Продолжить returns to the game');
  await desk.click('#hudName'); await sleep(300);
  ok(await desk.isVisible('#profile'), 'name button in the HUD opens the profile');
  await desk.keyboard.press('Escape'); await sleep(150);
  ok(!(await desk.isVisible('#profile')), 'Esc closes the in-game profile');

  // ---------------- mobile
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const mob = await ctx.newPage();
  watch(mob);
  await mob.goto(URL);
  await sleep(700);
  await mob.screenshot({ path: path.join(ROOT, 'screenshot-login-mobile.png') });
  await mob.fill('#nick', 'Mobile_Max'); await mob.fill('#pass', PW);
  await mob.tap('#authSubmit');
  await mob.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  await sleep(500);
  const pcard = await mob.locator('.profile-card').boundingBox(), pbtn = await mob.locator('#pfPlay').boundingBox();
  ok(pcard && pcard.width <= 390 && pbtn && pbtn.y + pbtn.height <= 844 && pbtn.height >= 40, `mobile profile fits the screen, «Играть» reachable (card ${pcard && Math.round(pcard.width)}px, button bottom ${pbtn && Math.round(pbtn.y + pbtn.height)})`);
  await shot(mob, 'screenshot-profile-mobile.png');
  await mob.tap('#pfPlay');
  await mob.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  const mb = await mob.locator('.menu-buttons').boundingBox();
  ok(mb && mb.x >= 0 && mb.x + mb.width <= 390, `mobile menu (4 buttons) fits the screen width (${mb && Math.round(mb.width)}px)`);
  ok(await mob.isVisible('#chatBtn') && !(await mob.isVisible('#chat')), 'mobile: chat collapsed to a button');
  await sleep(1700);
  await bots[0].say('Mobile_Max, давай к нам на север!');
  await sleep(400);
  await bots[1].say('Кто купил радужный ник? 🌈');
  await sleep(600);
  ok((await mob.textContent('#chatBadge')) === '2' && await mob.isVisible('#chatBadge'), 'unread badge counts new messages: ' + await mob.textContent('#chatBadge'));
  ok(await mob.isVisible('#chatToast'), 'latest message shown as a toast at the top');
  const tb = await mob.locator('#chatToast').boundingBox();
  ok(tb && tb.y < 60, `toast sits at the top (y=${tb && Math.round(tb.y)}), not in the centre`);
  await mob.screenshot({ path: path.join(ROOT, 'screenshot-chat-mobile.png') });
  // touch movement works with chat closed (hold finger right of the player)
  const mid = { x: 195, y: 422 };
  const id = bots[0].ids.get('Mobile_Max');
  const p0 = bots[0].positions.get(id);
  const cdp = await ctx.newCDPSession(mob);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid.x + 150, y: mid.y }] });
  await sleep(900);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  const p1 = bots[0].positions.get(id);
  ok(p0 && p1 && p1.x - p0.x > 40, `touch movement works with chat closed (moved ${p0 && p1 ? Math.round(p1.x - p0.x) : '?'}px)`);
  await mob.tap('#chatBtn');
  await sleep(300);
  const box = await mob.locator('#chat').boundingBox();
  ok(await mob.isVisible('#chat') && box && box.width >= 389 && box.height >= 800, `chat sheet opens full-screen (${box && Math.round(box.width)}x${box && Math.round(box.height)})`);
  ok(!(await mob.isVisible('#chatBadge')), 'badge cleared when chat opened');
  await mob.tap('#chatInput');
  await mob.keyboard.type('Иду!');
  await mob.tap('.chat-send');
  await sleep(500);
  ok(/Mobile_Max: Иду!/.test(await mob.textContent('#chatLog')), 'mobile: message sent from the sheet');
  await mob.fill('#chatInput', 'Где вы? 👀');
  await mob.screenshot({ path: path.join(ROOT, 'screenshot-chat-mobile-open.png') });
  await mob.tap('#chatClose');
  await sleep(200);
  ok(!(await mob.isVisible('#chat')) && await mob.isVisible('#chatBtn'), 'close button returns to the game');
  // simulate on-screen keyboard: shrink the viewport while the sheet is open, input must stay visible
  await mob.tap('#chatBtn'); await mob.tap('#chatInput');
  await mob.setViewportSize({ width: 390, height: 500 });
  await sleep(400);
  const ib = await mob.locator('#chatInput').boundingBox();
  ok(ib && ib.y + ib.height <= 500, `input stays visible when the keyboard shrinks the viewport (input bottom ${ib && Math.round(ib.y + ib.height)} ≤ 500)`);
  await mob.setViewportSize({ width: 390, height: 844 });
  await mob.tap('#chatClose');
  // mobile inventory
  await mob.tap('.menu-buttons [data-open=inv]');
  await sleep(600);
  const ig = await mob.locator('#inv .modal-card').boundingBox();
  const cols = await mob.evaluate(() => getComputedStyle(document.getElementById('invGrid')).gridTemplateColumns.split(' ').length);
  ok(await mob.isVisible('#inv') && ig && ig.width <= 390 && cols >= 3, `mobile inventory: bottom sheet ${ig && Math.round(ig.width)}px wide, ${cols}-column grid`);
  await shot(mob, 'screenshot-inventory-mobile.png');
  await mob.tap('#inv .close');

  // opening the site with a saved session shows the profile first; «Играть» there kicks the other tab
  const tab2 = await deskCtx.newPage();
  watch(tab2);
  await tab2.goto(URL);
  await tab2.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  await sleep(500);
  ok(!(await tab2.isVisible('#hud')) && await desk.isVisible('#hud'), 'page load with a valid session → profile screen (the game in the other tab keeps running)');
  await tab2.click('#pfPlay');
  await tab2.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await desk.waitForSelector('#resumeBox:not(.hidden)', { timeout: 5000 });
  ok(/другой вкладки/.test(await desk.textContent('#resumeText')), 'first tab kicked with a message: ' + await desk.textContent('#resumeText'));
  await desk.click('#resumeBtn');
  await desk.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
  await desk.click('#pfPlay');
  await desk.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await tab2.waitForSelector('#start:not(.hidden)', { timeout: 5000 });
  ok(true, 'kicked tab → «Продолжить» → profile → «Играть» takes the session back');
  await tab2.close();

  // logout
  await desk.click('#logoutBtn');
  await sleep(500);
  ok(await desk.isVisible('#authBox') && !(await desk.evaluate(() => localStorage.getItem('ocs_session'))), 'Выйти returns to the login screen and clears the token');
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const rr = await new Promise(r => s.emit('resume', { token }, r));
  ok(!rr.ok, 'logged-out token can no longer be used');
  s.close();

  // chat auto-clear in the UI (separate server with a 4 s cycle)
  const cyc = process.argv[2] ? null : await startOwnServer(3105, { CHAT_CLEAR_MS: '4000' }, false);
  if (cyc) {
    const cp = await deskCtx.newPage();
    watch(cp);
    await cp.goto(cyc.url); await sleep(500);
    await cp.click('.auth-tab[data-mode=register]');
    await cp.fill('#nick', 'Clear_Test'); await cp.fill('#pass', PW); await cp.fill('#pass2', PW);
    await cp.click('#authSubmit');
    await cp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
    await cp.click('#pfPlay');
    await cp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
    await cp.fill('#chatInput', 'это сообщение исчезнет'); await cp.keyboard.press('Enter');
    await cp.waitForFunction(() => /Чат очищен/.test(document.getElementById('chatLog').textContent), null, { timeout: 9000 });
    const log = await cp.textContent('#chatLog');
    ok(!/исчезнет/.test(log) && /Чат очищен · следующая очистка в \d\d:\d\d/.test(log), 'chat clears itself and shows «Чат очищен» + next clear time: ' + log);
    await cp.close();
    cyc.stop();
  }

  const cspErrors = errors.filter(e => /Content Security Policy|Refused to/i.test(e));
  ok(cspErrors.length === 0, 'no CSP violations');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  for (const b of bots) b.close();
  await browser.close();
  if (own) own.stop();
  console.log(fails ? `${fails} UI checks failed` : 'all UI checks passed');
  setTimeout(() => process.exit(), 300);
})().catch(e => { console.error(e); process.exit(1); });
