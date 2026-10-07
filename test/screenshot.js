// Headless Chrome UI check + screenshots (login, desktop chat, mobile chat closed/open).
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

async function startOwnServer() {
  const file = path.join(os.tmpdir(), 'ocs-demo-' + process.pid + '.json');
  execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), file], { stdio: 'inherit' });
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: '3102', DATA_FILE: file, DATABASE_URL: '' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:3102/api/health')).ok) break; } catch (_) { /* wait */ } await sleep(200); }
  return { url: 'http://localhost:3102', stop: () => { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } };
}

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
  const own = process.argv[2] ? null : await startOwnServer();
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
  await desk.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  ok(await desk.isVisible('#chat') && !(await desk.isVisible('#chatBtn')), 'desktop: chat panel visible, mobile chat button hidden');
  const token = await desk.evaluate(() => localStorage.getItem('ocs_session'));
  ok(/^[A-Za-z0-9_-]{43}$/.test(token || ''), 'session token stored in localStorage');

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
  await desk.keyboard.press('Escape');

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
  await mob.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
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

  // second tab with the same session kicks the first; «Играть» in the first tab takes the session back
  const tab2 = await deskCtx.newPage();
  watch(tab2);
  await tab2.goto(URL);
  await tab2.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await desk.waitForSelector('#resumeBox:not(.hidden)', { timeout: 5000 });
  ok(/другой вкладки/.test(await desk.textContent('#joinError')), 'first tab kicked with a message: ' + await desk.textContent('#joinError'));
  await desk.click('#resumeBtn');
  await desk.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await tab2.waitForSelector('#start:not(.hidden)', { timeout: 5000 });
  ok(true, '«Играть» reconnects the kicked tab and the other tab is kicked instead');
  await tab2.close();

  // logout
  await desk.click('#logoutBtn');
  await sleep(500);
  ok(await desk.isVisible('#authBox') && !(await desk.evaluate(() => localStorage.getItem('ocs_session'))), 'Выйти returns to the login screen and clears the token');
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const rr = await new Promise(r => s.emit('resume', { token }, r));
  ok(!rr.ok, 'logged-out token can no longer be used');
  s.close();

  const cspErrors = errors.filter(e => /Content Security Policy|Refused to/i.test(e));
  ok(cspErrors.length === 0, 'no CSP violations');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  for (const b of bots) b.close();
  await browser.close();
  if (own) own.stop();
  console.log(fails ? `${fails} UI checks failed` : 'all UI checks passed');
  setTimeout(() => process.exit(), 300);
})().catch(e => { console.error(e); process.exit(1); });
