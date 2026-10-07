// Takes screenshots with headless Chrome: node test/screenshot.js [url]
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const crypto = require('crypto');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  if (process.env.DEMO_TOKEN) await page.addInitScript(t => localStorage.setItem('ics_token', t), process.env.DEMO_TOKEN);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await sleep(800);
  await page.screenshot({ path: 'screenshot-start.png' });
  await page.fill('#nick', 'Демо');
  await page.click('button[type=submit]');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  // bots that hang around the demo player
  let target = null, demoId = null;
  const bots = ['Комета', 'Звездочёт', 'Nova'].map((name, i) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    const b = { s, seq: 0, pos: null, id: null };
    s.on('s', st => { for (const [id, x, y] of st.p) { if (id === b.id) b.pos = { x, y }; } });
    s.emit('join', { name, token: process.env.DEMO_TOKEN ? 'demo-bot-token-' + i + '-xxxxxxxx' : crypto.randomUUID() }, r => { b.id = r.you; b.pos = r.players.find(p => p.id === r.you); });
    b.timer = setInterval(() => {
      if (!b.pos || !target) return;
      const ang = Date.now() / 900 + i * 2.1;
      const tx = target.x + Math.cos(ang) * (110 + i * 40), ty = target.y + Math.sin(ang) * (90 + i * 30);
      let dx = tx - b.pos.x, dy = ty - b.pos.y; const l = Math.hypot(dx, dy);
      if (l < 6) { dx = dy = 0; } else { dx /= l; dy /= l; }
      s.emit('input', { s: ++b.seq, x: dx, y: dy });
    }, 50);
    return b;
  });
  const spy = io(URL, { transports: ['websocket'], forceNew: true });
  spy.on('s', st => { for (const [id, x, y] of st.p) if (id === demoId) target = { x, y }; });
  spy.on('pjoin', p => { if (p.name === 'Демо') demoId = p.id; });
  // spy only listens (not joined), it receives broadcasts; find demo id via top list
  spy.on('top', t => { const d = t.top.find(x => x[1] === 'Демо'); if (d) demoId = d[0]; });
  // move around
  const moves = [['KeyD', 2500], ['KeyS', 1200], ['KeyA', 1500], ['KeyW', 900], ['KeyD', 1800]];
  for (const [k, ms] of moves) { await page.keyboard.down(k); await sleep(ms); await page.keyboard.up(k); }
  await sleep(4000);
  await page.keyboard.down('KeyD'); await sleep(600); await page.keyboard.up('KeyD');
  await page.screenshot({ path: 'screenshot.png' });
  await page.keyboard.press('KeyB'); await sleep(600);
  await page.screenshot({ path: 'screenshot-shop.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyM'); await sleep(400);
  await page.screenshot({ path: 'screenshot-minigames.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyL'); await sleep(800);
  await page.screenshot({ path: 'screenshot-leaderboard.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyM'); await sleep(300);
  await page.click('[data-game=rush]'); await sleep(5000);
  await page.screenshot({ path: 'screenshot-rush.png' });
  await sleep(17000);
  await page.screenshot({ path: 'screenshot-rush-result.png' });
  await page.click('#mgBack'); await sleep(300);
  await page.click('[data-game=reaction]'); await sleep(300);
  await page.screenshot({ path: 'screenshot-reaction.png' });
  await sleep(5000);
  console.log('page errors:', errors.length ? errors : 'none');
  for (const b of bots) { clearInterval(b.timer); b.s.close(); }
  spy.close();
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
