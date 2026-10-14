// Browser test for the menu music: element + sources, autoplay blocked → starts on first interaction, fades out in the arena, mute persists.
//   node test/music-test.js   -> starts its own server on :3111
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), PORT = 3111, PW = 'demo-pass-123', URL = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));
(async () => {
  const file = path.join(os.tmpdir(), `ocs-music-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0' }), stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) {} });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await sleep(200); }
  for (const f of ['menu.m4a', 'menu.mp3']) { const r = await fetch(`${URL}/audio/${f}`); ok(r.ok && Number(r.headers.get('content-length')) > 500000, `/audio/${f} served (${r.headers.get('content-type')}, ${r.headers.get('content-length')} bytes)`); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL); await sleep(1200);
  const m0 = await page.evaluate(() => window.OCSMusic());
  const srcs = await page.$$eval('#menuMusic source', l => l.map(s => s.getAttribute('src') + ' ' + s.type));
  ok(await page.$('#menuMusic') && srcs.join() === '/audio/menu.m4a audio/mp4,/audio/menu.mp3 audio/mpeg' && await page.evaluate(() => document.getElementById('menuMusic').loop), 'audio element (loop) with m4a + mp3 sources');
  ok(m0.paused === true && await page.isVisible('#musicBtn') && (await page.textContent('#musicBtn')) === '🔊', 'autoplay blocked: silent until the first interaction, 🔊 button visible');
  await page.click('.auth-tab[data-mode=register]'); await sleep(800);
  const m1 = await page.evaluate(() => window.OCSMusic());
  ok(m1.paused === false && Math.abs(m1.volume - 0.5) < 0.01 && /menu\.(m4a|mp3)$/.test(m1.src), `music starts on the first click (volume ${m1.volume}, ${m1.src.split('/').pop()})`);
  await page.fill('#nick', 'Music' + Date.now() % 100000); await page.fill('#pass', PW); await page.fill('#pass2', PW); await page.click('#authSubmit');
  await page.waitForSelector('#profile:not(.hidden)', { timeout: 10000 }); await sleep(300);
  ok((await page.evaluate(() => window.OCSMusic())).paused === false, 'still playing on the lobby screen after registration');
  await page.click('#pfPlay'); await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 }); await sleep(300);
  const mid = await page.evaluate(() => window.OCSMusic()); await sleep(1500);
  const m2 = await page.evaluate(() => window.OCSMusic());
  ok(mid.volume < 0.5 && m2.paused === true && !(await page.isVisible('#musicBtn')), `fades out on entering the arena (volume ${mid.volume.toFixed(2)} → paused), toggle hidden`);
  await page.keyboard.press('KeyW'); await sleep(300);
  ok((await page.evaluate(() => window.OCSMusic())).paused === true, 'interaction in the arena does not restart the music');
  // mute persists across reloads
  const p2 = await ctx.newPage(); await p2.goto(URL); await sleep(800);
  await p2.evaluate(() => { localStorage.removeItem('ocs_session'); }); await p2.reload(); await sleep(800);
  await p2.click('#musicBtn'); await sleep(200);
  ok((await p2.textContent('#musicBtn')) === '🔇' && (await p2.evaluate(() => window.OCSMusic())).paused === true && await p2.evaluate(() => localStorage.getItem('ocs_music')) === '0', 'first tap on the toggle (also the first interaction) mutes: 🔇, silent, saved');
  await p2.reload(); await sleep(800); await p2.mouse.click(640, 360); await sleep(500);
  const m3 = await p2.evaluate(() => window.OCSMusic());
  ok(m3.muted && m3.paused && (await p2.textContent('#musicBtn')) === '🔇', 'mute survives a reload: interaction does not start the music');
  await p2.click('#musicBtn'); await sleep(500);
  ok((await p2.evaluate(() => window.OCSMusic())).paused === false && (await p2.textContent('#musicBtn')) === '🔊', 'unmute → music plays again');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); proc.kill('SIGTERM');
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
