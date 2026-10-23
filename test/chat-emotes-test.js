// emotes in chat: picker in the chat input, owned-only, broadcast + big render, inline :name: tokens, server ownership/rate checks.
// Run: NODE_PATH=$PWD/node_modules node test/chat-emotes-test.js  → screenshot-chat-emotes.png
const { chromium, devices } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const ROOT = process.cwd(), PORT = 3151, URL = 'http://localhost:' + PORT, sleep = ms => new Promise(r => setTimeout(r, ms)); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
(async () => {
  try { fs.unlinkSync('/tmp/ocs-ce.json'); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/ocs-ce.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1' }), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); const errs = [];
  async function login(opt, nick) {
    const p = await (await b.newContext(opt)).newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick', nick); await p.fill('#pass', 'demo-pass-123'); await p.fill('#pass2', 'demo-pass-123'); await p.click('#authSubmit');
    await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(700); return p;
  }
  const em = (p, ev, d) => p.evaluate(([ev, d]) => window.OCSEmit(ev, d), [ev, d]);
  const A = await login({ viewport: { width: 1280, height: 720 } }, 'EmoA'), B = await login({ viewport: { width: 1280, height: 720 } }, 'EmoB');
  await A.click('#chatEmoBtn'); await sleep(200);
  ok(await A.isVisible('#chatEmotePicker'), 'picker opens from chat input');
  ok((await A.$$('#chatEmotePicker .emo')).length === 26 && (await A.$$('#chatEmotePicker .emo.locked')).length === 23, '26 emotes, 23 locked (greyed)');
  await A.click('#chatEmotePicker .emo.locked'); await sleep(300);
  ok(!(await B.$('#chatLog .emo-msg')), 'locked emote not sent');
  await A.click('#chatEmotePicker .emo[data-emote=e_wave]'); await sleep(500);
  ok(await B.$('#chatLog .emo-msg .emo-big') && (await B.textContent('#chatLog .emo-msg .t')) === '👋', 'other player sees big emote message');
  ok(await A.$('#chatLog .emo-msg') && !(await A.isVisible('#chatEmotePicker')), 'sender sees it, picker closes');
  const fs2 = await A.$eval('#chatLog .emo-msg .t', e => parseFloat(getComputedStyle(e).fontSize)); ok(fs2 >= 26, 'enlarged ' + fs2 + 'px');
  let r = await em(A, 'chat:emote', 'e_moai'); ok(r && !r.ok && /не куплена/.test(r.error), 'server rejects unowned emote');
  r = await em(A, 'chat:emote', 'e_smile'); ok(r && !r.ok && /быстро/.test(r.error), 'chat rate limit applies');
  await sleep(1600); r = await em(A, 'chat', 'всем :thumb: и :moai:'); await sleep(500);
  ok(r && r.ok && (await B.$$eval('#chatLog .chat-msg .t', l => l.map(e => e.textContent))).includes('всем 👍 и :moai:'), 'inline :token: only for owned emotes');
  await sleep(1600); await em(A, 'chat:emote', 'e_smile'); await sleep(500);
  await A.click('#chatEmoBtn'); await sleep(200);
  await A.screenshot({ path: 'screenshot-chat-emotes.png' });
  const M = await login(Object.assign({}, devices['iPhone 12']), 'EmoM');
  await M.click('#chatBtn'); await sleep(400); await M.click('#chatEmoBtn'); await sleep(300);
  const mb = await M.$eval('#chatEmotePicker', e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, W: innerWidth }; });
  ok(mb.l >= 0 && mb.r <= mb.W && mb.t >= 0, 'mobile picker fits ' + JSON.stringify(mb));
  await M.click('#chatEmotePicker .emo[data-emote=e_thumb]'); await sleep(500); ok(await A.$('#chatLog .emo-msg'), 'mobile send works');
  await M.screenshot({ path: '/tmp/ocs-chat-emotes-mobile.png' });
  ok(await A.isVisible('#emoteBtn'), 'radar emote button still there');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close(); proc.kill(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
