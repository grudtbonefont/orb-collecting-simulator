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
const SG = require('../public/shared.js');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));

async function startOwnServer(port, env = {}, seed = true) {
  try { await fetch(`http://localhost:${port}/api/health`); throw new Error(`port ${port} is already in use`); } catch (e) { if (/in use/.test(e.message)) throw e; }
  const file = path.join(os.tmpdir(), `ocs-demo-${process.pid}-${port}.json`);
  if (seed) execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js'), file], { stdio: 'inherit' });
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), DATA_FILE: file, DATABASE_URL: '', EVENT_EVERY_MS: '0' }, env), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch (_) { /* wait */ } await sleep(200); }
  process.on('exit', () => { try { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } catch (_) { /* already gone */ } }); // also on crash
  return { url: `http://localhost:${port}`, stop: () => { proc.kill('SIGTERM'); fs.rmSync(file, { force: true }); } };
}
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, name) });
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return fn(); };

function bot(url, name) {
  const s = io(url, { transports: ['websocket'], forceNew: true });
  const b = { s, name, id: null, pos: null, seq: 0, ids: new Map(), positions: new Map(), metas: new Map() };
  s.on('pmeta', p => b.metas.set(p.id, p));
  s.on('s', st => { for (const [id, x, y] of st.p) { b.positions.set(id, { x, y }); if (id === b.id) b.pos = { x, y }; } });
  s.on('pjoin', p => b.ids.set(p.name, p.id));
  s.on('sping', v => s.emit('spong', v));
  b.login = () => new Promise(res => s.emit('auth', { mode: 'login', name, password: PW }, r => {
    if (r && r.ok) { b.id = r.you; for (const p of r.players) { b.ids.set(p.name, p.id); b.metas.set(p.id, p); if (p.id === r.you) b.pos = { x: p.x, y: p.y }; } }
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

  // ---------------- item icons: every catalog item, distinct, non-empty, data-driven fallback
  const galCtx = await browser.newContext({ viewport: { width: 1840, height: 1240 } });
  const gal = await galCtx.newPage();
  watch(gal);
  await gal.goto(URL); await sleep(500);
  const icons = await gal.evaluate(async () => {
    const load = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    const opaque = async src => {
      const im = await load(src); if (!im) return -1;
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n / (c.width * c.height);
    };
    const out = [];
    for (const it of G.ITEMS) { const url = window.OCSIcons.url(it.id); out.push({ id: it.id, url, cover: await opaque(url), again: window.OCSIcons.url(it.id) === url }); }
    const ups = [];
    for (const k of G.UPGRADE_KEYS) { const url = window.OCSIcons.url('u_' + k); ups.push({ id: 'u_' + k, url, cover: await opaque(url) }); }
    // future items: picked up by type/params; unknown art or ids → fallback gem
    G.ITEM_BY_ID.h_future = { id: 'h_future', type: 'cosmetic', cat: 'hat', value: 'crown', rarity: 'legendary', name: 'Будущая корона' };
    G.ITEM_BY_ID.x_future = { id: 'x_future', type: 'collectible', cat: 'misc', art: 'shard', rarity: 'epic', name: 'Будущий осколок' };
    G.ITEM_BY_ID.x_odd = { id: 'x_odd', type: 'collectible', cat: 'misc', art: 'no-such-art', rarity: 'rare', icon: '★', name: 'Странный' };
    const fut = { hat: window.OCSIcons.url('h_future') === window.OCSIcons.url('h_crown'), shard: window.OCSIcons.url('x_future') === window.OCSIcons.url('x_legend_shard'),
      odd: await opaque(window.OCSIcons.url('x_odd')), unknown: await opaque(window.OCSIcons.url('zz_unknown')) };
    delete G.ITEM_BY_ID.h_future; delete G.ITEM_BY_ID.x_future; delete G.ITEM_BY_ID.x_odd;
    return { out, ups, fut, unknownUrl: window.OCSIcons.url('zz_unknown') };
  });
  const ITEMS = require('../public/shared.js').ITEMS;
  ok(icons.out.length === ITEMS.length && icons.out.every(x => /^data:image\/png;base64,/.test(x.url) && x.cover > 0.04),
    `every catalog item (${icons.out.length}) renders a non-empty PNG icon (min coverage ${Math.min(...icons.out.map(x => x.cover)).toFixed(2)})`);
  ok(new Set(icons.out.map(x => x.url)).size === ITEMS.length && !icons.out.some(x => x.url === icons.unknownUrl), `all ${ITEMS.length} item icons are distinct (data URLs differ per item)`);
  ok(icons.ups.length === SG.UPGRADE_KEYS.length && icons.ups.every(x => x.cover > 0.04) && new Set(icons.ups.map(x => x.url).concat(icons.out.map(x => x.url))).size === ITEMS.length + icons.ups.length,
    `every upgrade (${icons.ups.length}) has its own non-empty icon, distinct from all item icons`);
  ok(icons.out.every(x => x.again), 'icons are cached (same data URL on the second request)');
  ok(icons.fut.hat && icons.fut.shard && icons.fut.odd > 0.04 && icons.fut.unknown > 0.04, 'future items get icons from their type/params; unknown art / ids get a fallback icon');
  await gal.evaluate(require('./icon-gallery.js'));
  await sleep(300);
  const galH = await gal.evaluate(() => document.getElementById('iconGallery').scrollHeight);
  ok(galH <= 1240, `icon gallery (all items grouped by category + upgrades) fits one screenshot (${galH}px)`);
  await shot(gal, 'screenshot-icons-all.png');
  await galCtx.close();

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
    && /^17 \/ 450$/.test(pf.pfItems) && pf.pfReaction === '231 мс' && /34/.test(pf.pfRush) && /создан/.test(pf.pfSince), 'profile shows rank, balance, total, play time, sessions, items, best results: ' + JSON.stringify(pf));
  const avatarPixels = await desk.evaluate(() => { const c = document.getElementById('pfAvatar'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  ok(avatarPixels > 2000, `equipped look preview is drawn (${avatarPixels} px)`);
  for (const id of ['pfPlay', 'pfInv', 'pfLogout']) ok(await desk.isVisible('#' + id), `profile button #${id} visible`);
  const pfEq = await desk.evaluate(() => Array.from(document.querySelectorAll('#pfEq img')).map(i => i.dataset.icon + ':' + (i.complete && i.naturalWidth > 0)));
  ok(pfEq.join(',') === 'c_rainbow:true,s_star:true,t_fire:true,n_gold:true,h_crown:true', 'profile shows icons of the 5 equipped items: ' + pfEq.join(','));
  await shot(desk, 'screenshot-profile.png');
  await desk.click('#pfInv');
  await sleep(300);
  ok(await desk.isVisible('#inv') && /^17 \/ 450$/.test(await desk.textContent('#invCount')), 'Инвентарь opens from the profile: ' + await desk.textContent('#invCount'));
  await desk.keyboard.press('Escape');
  await sleep(150);
  ok(!(await desk.isVisible('#inv')) && await desk.isVisible('#profile'), 'closing the inventory returns to the profile');
  await desk.click('#pfPlay');
  await desk.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  ok(!(await desk.isVisible('#profile')), 'Играть enters the arena');
  ok(await desk.isVisible('#chat') && !(await desk.isVisible('#chatBtn')), 'desktop: chat panel visible, mobile chat button hidden');
  { // camera zoom: mouse wheel on the arena, saved in localStorage
    const z0 = await desk.evaluate(() => window.OCSZoom());
    await desk.mouse.move(640, 300); await desk.mouse.wheel(0, -300); await sleep(150);
    const z1 = await desk.evaluate(() => [window.OCSZoom(), localStorage.getItem('ocs_zoom')]);
    await desk.mouse.wheel(0, 300); await sleep(150);
    const z2 = await desk.evaluate(() => window.OCSZoom());
    ok(z0 === 1 && z1[0] > 1.3 && z1[0] <= 1.5 && z1[1] === String(z1[0]) && z2 < z1[0], `desktop: wheel zooms in/out (1 → ${z1[0]} → ${z2}), stored in localStorage`);
  }
  ok(!/очищ|очистк/i.test(await desk.textContent('#chatLog')), 'chat shows no clear schedule');

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
  const shopState = await desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item')).map(e => [e.querySelector('.name').textContent, e.querySelector('.buy-btn').textContent, e.querySelector('.buy-btn').disabled, (e.querySelector('.owned-n') || {}).textContent || '']));
  const paidColors = SG.ITEMS.filter(i => i.cat === 'color' && i.price > 0).length;
  ok(shopState.length === paidColors && !shopState.some(([n]) => n === 'Бирюзовый') && shopState.filter(x => /В инвентаре/.test(x[3])).length === 4 && shopState.some(x => /Купить · 2\s?400/.test(x[1]) && !x[2]),
    `shop lists only paid items (${shopState.length} colours) with prices; owned ones say «В инвентаре: N» and can be bought again`);
  const shopPrices = await desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item[data-item]')).map(e => G.ITEM_BY_ID[e.dataset.item].price));
  ok(shopPrices.every((p, i) => !i || p >= shopPrices[i - 1]), 'default sort: cheapest first');
  const shopIcons = await desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item[data-item]')).map(e => { const i = e.querySelector('.ico img'); return !!i && i.dataset.icon === e.dataset.item && i.complete && i.naturalWidth > 0; }));
  ok(shopIcons.length === paidColors && shopIcons.every(Boolean), 'every shop card shows its own item icon');
  await shot(desk, 'screenshot-shop.png');
  const shopIds = () => desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item[data-item]')).map(e => e.dataset.item));
  await desk.click('#shopRarity [data-rarity=legendary]'); await sleep(150);
  const leg = await shopIds();
  ok(leg.length === SG.ITEMS.filter(i => i.cat === 'color' && i.rarity === 'legendary' && !i.exclusive).length && leg.every(id => SG.ITEM_BY_ID[id].rarity === 'legendary'), 'rarity filter: only legendary colours — ' + leg.join(', '));
  await desk.click('#shopRarity [data-rarity=all]');
  await desk.selectOption('#shopSort', 'price-desc'); await sleep(150);
  const desc = await shopIds();
  ok(SG.ITEM_BY_ID[desc[0]].price === Math.max(...SG.ITEMS.filter(i => i.cat === 'color').map(i => i.price)), 'sort «Сначала дорогие»: most expensive first (' + desc[0] + ')');
  await desk.selectOption('#shopSort', 'rarity'); await sleep(150);
  const RR = { common: 0, rare: 1, epic: 2, legendary: 3 }, byR = (await shopIds()).map(id => RR[SG.ITEM_BY_ID[id].rarity]);
  ok(byR.every((r, i) => !i || r >= byR[i - 1]), 'sort «По редкости»: common → legendary');
  await desk.check('#shopHideOwned'); await sleep(150);
  ok((await shopIds()).length === paidColors - 4, '«Скрыть купленные» hides the 4 owned colours');
  await desk.click('#shopTabs .tab[data-tab=hat]'); await sleep(150);
  ok(await desk.evaluate(() => document.querySelectorAll('#shopGrid .item[data-item]').length) === SG.ITEMS.filter(i => i.cat === 'hat' && i.price > 0).length - 3 && await desk.isVisible('#shopTools'), 'filters stay active across category tabs (hats minus the 3 owned)');
  await desk.uncheck('#shopHideOwned'); await desk.selectOption('#shopSort', 'price-asc');
  await desk.click('#shopTabs .tab[data-tab=upgrades]'); await sleep(200);
  const ups = await desk.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .up-card')).map(e => ({ k: e.dataset.up, name: e.querySelector('.name').textContent, eff: e.querySelector('.up-eff').textContent, btn: e.querySelector('button').textContent, icon: (e.querySelector('.ico img') || {}).dataset && e.querySelector('.ico img').dataset.icon })));
  const mag = ups.find(u => u.k === 'magnet') || {};
  ok(ups.length === SG.UPGRADE_KEYS.length && ups.every(u => u.icon === 'u_' + u.k) && !(await desk.isVisible('#shopTools')), `upgrades tab: ${ups.length} cards with their own icons (filters hidden)`);
  ok(/ур\. 2\/5/.test(mag.name) && mag.eff.includes('Сейчас: ' + SG.upgradeText('magnet', 2)) && mag.eff.includes('→ ' + SG.upgradeText('magnet', 3)) && new RegExp('Улучшить · ' + SG.UPGRADES.magnet.prices[2].toLocaleString('ru-RU').replace(/\s/g, '\\s')).test(mag.btn),
    `upgrade card shows level, current → next effect and cost: ${mag.name} | ${mag.eff} | ${mag.btn}`);
  await shot(desk, 'screenshot-shop-upgrades.png');
  await desk.click('#shopTabs .tab[data-tab=color]'); await sleep(150);
  const hudBal = () => desk.evaluate(() => Number(document.querySelector('#hudBalance').textContent.replace(/\s/g, '')));
  const violetCard = desk.locator('#shopGrid .item', { hasText: 'Фиолетовый' }), violetBtn = violetCard.locator('.buy-btn');
  const balBefore = await hudBal();
  await violetBtn.click();
  await sleep(500);
  ok(/В инвентаре: 1/.test(await violetCard.locator('.owned-n').textContent()) && /Куплено: Фиолетовый/.test(await desk.textContent('#toasts')), 'purchase confirmed, item marked «В инвентаре: 1»');
  // quantity selector: + / + → ×3 with the total price; − back to 1 (no purchase)
  const lime = desk.locator('#shopGrid .item', { hasText: 'Лаймовый' });
  await lime.locator('.q-plus').click(); await lime.locator('.q-plus').click(); await sleep(100);
  const limeTxt = await lime.locator('.buy-btn').textContent();
  ok(/×3/.test(limeTxt) && /450/.test(limeTxt.replace(/\s/g, '')) && await lime.locator('.q-in').inputValue() === '3', 'quantity selector: + + → «Купить ×3 · 450» (total price)');
  await shot(desk, 'screenshot-shop-qty.png');
  await lime.locator('.q-minus').click(); await lime.locator('.q-minus').click();
  const balAfter = await hudBal();
  ok(balAfter <= balBefore - 400 + 30 && balAfter >= balBefore - 400, `balance reduced by 400 (${balBefore} → ${balAfter}; the player may pick up a few orbs meanwhile)`);
  await desk.keyboard.press('Escape');
  // ---------------- inventory (hotkey I)
  await desk.keyboard.press('KeyI'); await sleep(400);
  ok(await desk.isVisible('#inv') && /^18 \/ 450$/.test(await desk.textContent('#invCount')), 'hotkey I opens the inventory with the new item: ' + await desk.textContent('#invCount'));
  await shot(desk, 'screenshot-inventory-450.png');
  const shardQty = await desk.evaluate(() => { const e = document.querySelector('#invGrid [data-item=x_legend_shard] .qty'); return e && e.textContent; });
  ok(shardQty === '×3', 'stackable item shows its quantity: ' + shardQty);
  const invIcons = await desk.evaluate(() => Array.from(document.querySelectorAll('#invGrid .inv-item')).map(e => { const i = e.querySelector('.ico img'); return [e.dataset.item, !!i && i.dataset.icon === e.dataset.item && i.complete && i.naturalWidth > 0, i && i.src]; }));
  ok(invIcons.length === 16 && invIcons.every(x => x[1]) && new Set(invIcons.map(x => x[2])).size === 16, 'every inventory card shows its own, distinct icon');
  const frame = await desk.evaluate(() => { const e = document.querySelector('#invGrid [data-item=c_rainbow] .ico'); const cs = getComputedStyle(e); return [cs.getPropertyValue('--rc').trim(), cs.borderTopColor, cs.backgroundImage.slice(0, 15)]; });
  ok(frame[0] === '#ffcc33' && /radial-gradient/.test(frame[2]), 'icon has a rarity-coloured frame/glow (legendary = gold): ' + frame.join(' | '));
  const violet = desk.locator('#invGrid [data-item=c_violet] button.btn');
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
  await desk.locator('#invGrid [data-item=c_violet] button.btn').click(); await sleep(400);
  ok(/Надеть/.test(await desk.locator('#invGrid [data-item=c_violet] button.btn').textContent()), 'unequip from the inventory');
  await desk.locator('#invGrid [data-item=c_rainbow] button.btn').click(); await sleep(300);
  await desk.keyboard.press('Escape');
  // ---------------- in-game profile (hotkey P / name button)
  await desk.keyboard.press('KeyP'); await sleep(900);
  ok(await desk.isVisible('#profile') && await desk.isVisible('#profileClose') && /Продолжить/.test(await desk.textContent('#pfPlay')), 'hotkey P opens the profile in game');
  const pfBal = Number((await desk.textContent('#pfBalance')).replace(/[^0-9]/g, ''));
  ok(Math.abs(pfBal - await hudBal()) <= 30 && /^18 \/ 450$/.test(await desk.textContent('#pfItems')), `in-game profile is up to date: balance ${pfBal}, items ${await desk.textContent('#pfItems')}`);
  await desk.click('#pfPlay'); await sleep(200);
  ok(!(await desk.isVisible('#profile')) && await desk.isVisible('#hud'), 'Продолжить returns to the game');
  await desk.click('#hudName'); await sleep(300);
  ok(await desk.isVisible('#profile'), 'name button in the HUD opens the profile');
  await desk.keyboard.press('Escape'); await sleep(150);
  ok(!(await desk.isVisible('#profile')), 'Esc closes the in-game profile');
  // ---------------- trash
  await desk.keyboard.press('KeyI'); await sleep(400);
  ok(await desk.isVisible('#invTrash') && await desk.locator('#invGrid .trash-btn').count() === 16, 'every inventory card has a 🗑 button, desktop shows a trash zone');
  await desk.locator('#invGrid [data-item=x_legend_shard] .trash-btn').click(); await sleep(300);
  ok(await desk.isVisible('#trashDlg') && /Удалить навсегда/.test(await desk.textContent('#trashTitle')) && /нельзя отменить/.test(await desk.textContent('#trashDlg')) && await desk.isVisible('#trashQtyBox'),
    'stack → confirm dialog with «Удалить навсегда? Это нельзя отменить» and a quantity picker');
  await desk.click('#trashPlus'); await desk.click('#trashPlus'); await desk.click('#trashPlus');
  ok(await desk.inputValue('#trashQty') === '3' && /Удалить 3 шт/.test(await desk.textContent('#trashOk')), 'quantity is capped at the stack size (3)');
  await desk.click('#trashMinus');
  ok(await desk.inputValue('#trashQty') === '2', '− lowers the quantity');
  ok(await desk.evaluate(() => { const i = document.querySelector('#trashIco img'); return !!i && i.dataset.icon === 'x_legend_shard' && i.naturalWidth > 0; }), 'confirm dialog shows the item icon');
  await shot(desk, 'screenshot-trash-confirm.png');
  await desk.click('#trashOk'); await sleep(500);
  ok(!(await desk.isVisible('#trashDlg')) && await desk.textContent('#invGrid [data-item=x_legend_shard] .qty') === '×1', 'partial stack deleted (×3 → ×1)');
  await desk.locator('#invGrid [data-item=x_legend_shard] .trash-btn').click(); await sleep(200);
  ok(!(await desk.isVisible('#trashQtyBox')), 'no quantity picker for a single item');
  await desk.click('#trashOk'); await sleep(500);
  ok(await desk.locator('#invGrid [data-item=x_legend_shard]').count() === 0 && /^15 \/ 450$/.test(await desk.textContent('#invCount')), 'last unit deleted → counter 15 / 450');
  // drag & drop onto the trash zone, then cancel
  await desk.dragAndDrop('#invGrid [data-item=c_coral]', '#invTrash'); await sleep(300);
  ok(await desk.isVisible('#trashDlg') && /Коралловый/.test(await desk.textContent('#trashName')), 'dragging an item onto the trash zone opens the confirmation');
  await desk.click('#trashCancel'); await sleep(200);
  ok(!(await desk.isVisible('#trashDlg')) && await desk.locator('#invGrid [data-item=c_coral]').count() === 1, 'Отмена keeps the item');
  await desk.locator('#invGrid [data-item=c_coral] .trash-btn').click(); await sleep(200);
  await desk.keyboard.press('Escape'); await sleep(200);
  ok(!(await desk.isVisible('#trashDlg')) && await desk.isVisible('#inv'), 'Esc closes only the dialog');
  await desk.locator('#invGrid [data-item=c_coral] .trash-btn').click(); await sleep(200);
  await desk.click('#trashOk'); await sleep(500);
  ok(await desk.locator('#invGrid [data-item=c_coral]').count() === 0, 'unique item deleted');
  // equipped item
  await desk.locator('#invGrid [data-item=c_rainbow] .trash-btn').click(); await sleep(200);
  ok(await desk.isVisible('#trashEquipped'), 'confirmation warns that the equipped item will be taken off');
  await desk.click('#trashOk'); await sleep(600);
  ok(bots[0].metas.get(demoId) && bots[0].metas.get(demoId).eq.color === 'c_cyan', 'deleting the equipped color reverts to the free default (others see it)');
  await desk.keyboard.press('Escape');
  await desk.keyboard.press('KeyB'); await sleep(400);
  ok(/Купить · 150/.test(await desk.locator('#shopGrid .item', { hasText: 'Коралловый' }).locator('.buy-btn').textContent()), 'deleted item can be bought again in the shop');
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
  { // camera zoom on phones: zoomed out by default, pinch with two fingers, +/− buttons that don't overlap the HUD
    const z0 = await mob.evaluate(() => window.OCSZoom());
    const boxes = await mob.evaluate(() => ['.zoom-btns', '#radar', '#chatBtn', '.menu-buttons', '#helpBtn'].map(q => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    ok(z0 === 0.75 && boxes.slice(1).every(b => !hit(boxes[0], b)) && boxes[0][2] <= 390, `mobile: default zoom ${z0} (sees more), zoom buttons don't overlap radar/chat/menu/help`);
    const pinch = await mob.evaluate(async () => {
      const cv = document.getElementById('game'), ev = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 11 }));
      ev('pointerdown', 11, 150, 400); ev('pointerdown', 12, 240, 400);
      for (let i = 1; i <= 5; i++) { ev('pointermove', 12, 240 + i * 12, 400); await new Promise(r => setTimeout(r, 30)); }
      const zin = window.OCSZoom();
      for (let i = 1; i <= 8; i++) { ev('pointermove', 12, 300 - i * 15, 400); await new Promise(r => setTimeout(r, 30)); }
      const zout = window.OCSZoom();
      ev('pointerup', 12, 180, 400); ev('pointerup', 11, 150, 400);
      return [zin, zout];
    });
    ok(pinch[0] > 0.75 && pinch[1] < pinch[0] && pinch[1] >= 0.5, `mobile: two-finger pinch zooms (${pinch.map(z => z.toFixed(2)).join(' → ')})`);
    await mob.tap('#zoomIn'); await mob.tap('#zoomIn');
    const zUp = await mob.evaluate(() => window.OCSZoom());
    for (let i = 0; i < 6 && !(await mob.isDisabled('#zoomOut')); i++) await mob.tap('#zoomOut');
    const zb = await mob.evaluate(() => [window.OCSZoom(), document.getElementById('zoomOut').disabled]);
    ok(zUp > 0.6 && zb[0] === 0.5 && zb[1], 'mobile: «+» / «−» buttons work; «−» zooms out to the 0.5× limit (button disabled there)');
    await sleep(300);
    await shot(mob, 'screenshot-zoom-mobile.png');
  }
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
  ok(!(await mob.isVisible('#invTrash')) && await mob.locator('#invGrid .trash-btn').count() === 5, 'mobile: 🗑 button on every card (no drag zone)');
  const mfit = await mob.evaluate(() => Array.from(document.querySelectorAll('#invGrid .inv-item')).map(card => {
    const c = card.getBoundingClientRect(), i = card.querySelector('.ico').getBoundingClientRect(), t = card.querySelector('.trash-btn').getBoundingClientRect(), n = card.querySelector('.name').getBoundingClientRect();
    return i.left >= c.left && i.right <= c.right && i.width >= 64 && i.bottom <= n.top + 1 && card.scrollWidth <= card.clientWidth + 1 && t.right <= i.left + 24;
  }));
  ok(mfit.length === 5 && mfit.every(Boolean), 'mobile: icons fit inside the cards, above the name, no overflow');
  await shot(mob, 'screenshot-inventory-mobile.png');
  await mob.tap('#invGrid [data-item=s_square] .trash-btn'); await sleep(300);
  const dlg = await mob.locator('#trashDlg .confirm-card').boundingBox();
  ok(dlg && dlg.width <= 390 && dlg.y >= 0 && dlg.y + dlg.height <= 844, `mobile confirm dialog fits the screen (${dlg && Math.round(dlg.width)}×${dlg && Math.round(dlg.height)})`);
  await mob.tap('#trashOk'); await sleep(500);
  ok(await mob.locator('#invGrid [data-item=s_square]').count() === 0 && /^\d+ \/ 450$/.test(await mob.textContent('#invCount')), 'mobile: item deleted via the 🗑 button');
  await mob.tap('#inv .close');
  // mobile shop: 3-column grid, filters fit, nothing overflows sideways
  await sleep(3200); // let the «Удалено» toast fade before the shop screenshot
  await mob.tap('.menu-buttons [data-open=shop]'); await sleep(500);
  const ms = await mob.evaluate(() => {
    const card = document.querySelector('#shop .modal-card'), grid = document.getElementById('shopGrid'), tools = document.getElementById('shopTools').getBoundingClientRect();
    const items = Array.from(grid.querySelectorAll('.item')).map(e => e.getBoundingClientRect());
    return { cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length, w: card.getBoundingClientRect().width, over: card.scrollWidth - card.clientWidth,
      toolsRight: tools.right, itemsIn: items.every(r => r.left >= 0 && r.right <= 390), n: items.length };
  });
  ok(ms.cols >= 3 && ms.w <= 390 && ms.over <= 1 && ms.toolsRight <= 390 && ms.itemsIn && ms.n > 10, `mobile shop: ${ms.cols}-column grid, ${ms.n} cards, filters fit (right edge ${Math.round(ms.toolsRight)}px), no sideways overflow`);
  await mob.tap('#shopRarity [data-rarity=epic]'); await sleep(200);
  ok(await mob.evaluate(() => Array.from(document.querySelectorAll('#shopGrid .item[data-item]')).every(e => G.ITEM_BY_ID[e.dataset.item].rarity === 'epic')), 'mobile: rarity filter works by tap');
  await mob.tap('#shopRarity [data-rarity=all]'); await sleep(200);
  await shot(mob, 'screenshot-shop-mobile.png');
  await mob.tap('#shop .close');

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

  // ---------------- arena with the new cosmetics: 7 bots wear every new item (2 rounds), then a showcase screenshot
  const arena = process.argv[2] ? null : await startOwnServer(3106, { OCS_TEST_HOOKS: '1' }, false);
  if (arena) {
    const vctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const vp = await vctx.newPage();
    watch(vp);
    await vp.goto(arena.url); await sleep(500);
    await vp.click('.auth-tab[data-mode=register]');
    await vp.fill('#nick', 'Viewer'); await vp.fill('#pass', PW); await vp.fill('#pass2', PW);
    await vp.click('#authSubmit');
    await vp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
    await vp.click('#pfPlay');
    await vp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
    const names = ['Lava_Lord', 'Aurora', 'GearHead', 'Sunny', 'Mint', 'Crimson', 'Leafy'];
    const NEWI = SG.ITEMS.filter(i => i.type === 'cosmetic' && !['c_cyan', 'c_coral', 'c_lime', 'c_violet', 'c_pink', 'c_gold', 'c_rainbow', 's_circle', 's_square', 's_triangle', 's_hexagon', 's_star',
      't_none', 't_sparks', 't_neon', 't_fire', 'n_white', 'n_pink', 'n_gold', 'n_rainbow', 'h_none', 'h_cap', 'h_tophat', 'h_halo', 'h_crown'].includes(i.id));
    const byCat = Object.fromEntries(SG.CATEGORIES.map(c => [c.key, NEWI.filter(i => i.cat === c.key).map(i => i.id)]));
    const abots = names.map(n => bot(arena.url, n));
    const call = (b, ev, arg) => new Promise(res => b.s.emit(ev, arg, res));
    for (const b of abots) {
      const r = await new Promise(res => b.s.emit('auth', { mode: 'register', name: b.name, password: PW, confirm: PW }, res));
      b.id = r.you; for (const p of r.players) { b.ids.set(p.name, p.id); if (p.id === r.you) b.pos = { x: p.x, y: p.y }; }
      for (const id of NEWI.map(i => i.id)) await call(b, 'test:grant', { id, qty: 1, source: 'event' });
    }
    const viewerPos = () => { const id = abots[0].ids.get('Viewer'); return id && abots[0].positions.get(id); };
    let botMode = 'circle';
    abots.forEach((b, i) => { b.timer = setInterval(() => {
      const t = viewerPos(); if (!b.pos || !t) return;
      const ang = Date.now() / 1500 + i * (Math.PI * 2 / abots.length), rad = 150 + (i % 3) * 55;
      let tx = t.x + Math.cos(ang) * rad * 1.5, ty = t.y + Math.sin(ang) * rad * 0.85;
      if (botMode === 'away') { const a2 = i * (Math.PI * 2 / abots.length); tx = t.x + Math.cos(a2) * 1100; ty = t.y + Math.sin(a2) * 900; }
      let dx = tx - b.pos.x, dy = ty - b.pos.y; const l = Math.hypot(dx, dy);
      if (l < 6) { dx = dy = 0; } else { dx /= l; dy /= l; }
      b.s.emit('input', { s: ++b.seq, x: dx, y: dy });
    }, 50); });
    const near = async () => { for (let i = 0; i < 300; i++) { const v = viewerPos(); if (v && abots.every(b => b.pos && Math.hypot(b.pos.x - v.x, b.pos.y - v.y) < 520)) return true; await sleep(100); } return false; };
    ok(await near(), 'arena: 7 bots gathered around the viewer');
    const worn = new Set(), errBefore = errors.length;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < abots.length; i++) for (const c of SG.CATEGORIES) {
        const l = byCat[c.key], id = l[(i + round * abots.length) % l.length];
        const r = await call(abots[i], 'inv:equip', id); if (r && r.ok) worn.add(id);
      }
      await sleep(1600); // several frames with these looks (trails need movement)
    }
    ok(worn.size === NEWI.length, `arena: all ${NEWI.length} new cosmetics worn by players on screen (${worn.size})`);
    ok(errors.length === errBefore, 'arena renders every new cosmetic without errors' + (errors.length > errBefore ? ': ' + errors.slice(errBefore).join(' | ') : ''));
    const showcase = [
      ['c_lava', 's_blob', 't_galaxy', 'n_glitch', 'h_wizard'], ['c_aurora', 's_heart', 't_hearts', 'n_ocean', 'h_bunny'], ['c_galaxy', 's_gear', 't_lightning', 'n_neon', 'h_viking'],
      ['c_sunset', 's_flower', 't_rainbow', 'n_fire', 'h_party'], ['c_mint', 's_drop', 't_bubbles', 'n_ice', 'h_cat'], ['c_crimson', 's_cross', 't_stars', 'n_red', 'h_horns'],
      ['c_orange', 's_diamond', 't_leaves', 'n_green', 'h_propeller'],
    ];
    for (let i = 0; i < abots.length; i++) for (const id of showcase[i]) await call(abots[i], 'inv:equip', id);
    await sleep(2500);
    const seen = await waitFor(() => { const m = abots[1].metas.get(abots[0].id); return m && m.eq.hat === 'h_wizard' && m; });
    ok(!!seen, 'other players see the new look (pmeta): ' + (seen && JSON.stringify(seen.eq)));
    const px = await vp.evaluate(() => { const c = document.getElementById('game'); return c ? c.width * c.height : 0; });
    ok(px > 0, 'arena canvas is drawing');
    await shot(vp, 'screenshot-arena-cosmetics.png');
    // exclusives from «Лавка осколков» on arena players
    const exShow = [['c_void', 's_crystal', 't_crystal', 'n_shard', 'h_shard_crown'], ['c_prism', 's_blob', 't_comet', 'n_shard', 'h_satellites'], ['c_prism', 's_crystal', 't_comet', 'n_glitch', 'h_shard_crown'],
      ['c_void', 's_star', 't_crystal', 'n_rainbow', 'h_satellites']];
    const exErr = errors.length;
    for (let i = 0; i < exShow.length; i++) for (const id of exShow[i]) await call(abots[i], 'inv:equip', id);
    await sleep(2500);
    ok(errors.length === exErr, 'exclusive cosmetics render in the arena without errors');
    await shot(vp, 'screenshot-arena-exclusives.png');

    // ---------------- timed arena events: announce banner → king-of-the-hill zone + HUD → results
    const v0 = viewerPos();
    let r = await call(abots[0], 'test:event', { kind: 'koth', announceMs: 6000, durationMs: 13000, x: v0.x + 40, y: v0.y + 20 });
    ok(r && r.ok && r.event.phase === 'announce', 'test hook announces «Царь горы»');
    await vp.waitForSelector('#evBanner:not(.hidden)', { timeout: 3000 });
    await sleep(1200);
    const ban = await vp.evaluate(() => ({ name: document.getElementById('evBName').textContent, count: document.getElementById('evBCount').textContent, desc: document.getElementById('evBDesc').textContent,
      box: document.getElementById('evBanner').getBoundingClientRect().toJSON() }));
    ok(/Царь горы/.test(ban.name) && /через [1-6] с/.test(ban.count) && ban.desc.length > 20, `announce banner with countdown: «${ban.name}» ${ban.count}`);
    ok(ban.box.top < 120 && ban.box.left > 200 && ban.box.right < 1080, 'desktop banner sits top-centre between the HUD panels');
    await shot(vp, 'screenshot-event-banner.png');
    await vp.waitForSelector('#evHud:not(.hidden)', { timeout: 8000 });
    ok(!(await vp.isVisible('#evBanner')), 'banner turns into the event HUD when the event starts');
    await sleep(3500);
    const hud = await vp.evaluate(() => ({ time: document.getElementById('evHTime').textContent, info: document.getElementById('evHInfo').textContent, bar: parseFloat(document.getElementById('evHBar').style.width) }));
    ok(/^0:\d\d$/.test(hud.time) && /Вы в зоне/.test(hud.info) && /очки: [1-9]/.test(hud.info) && hud.bar > 20 && hud.bar < 95, `event HUD: timer ${hud.time}, progress ${Math.round(hud.bar)}%, «${hud.info}»`);
    await shot(vp, 'screenshot-event-koth.png');
    await vp.waitForSelector('#evResult:not(.hidden)', { timeout: 15000 });
    await sleep(400);
    const res = await vp.textContent('#evResult');
    ok(/итоги/.test(res) && /Вы: 1-е место/.test(res) && /награда \+\d+/.test(res) && (await vp.$$('#evResult .cur-orb')).length > 0 && /Viewer/.test(res), 'results card: place, score and reward — ' + res.replace(/\s+/g, ' ').slice(0, 140));
    ok(!(await vp.isVisible('#evHud')), 'event HUD hidden after the end');
    await shot(vp, 'screenshot-event-results.png');
    await vp.click('#evResult .close');
    ok(!(await vp.isVisible('#evResult')), 'results card can be closed');

    // ---------------- orb tiers: one of each around the viewer (bots step aside) + the «?» legend
    botMode = 'away';
    for (let i = 0; i < 80; i++) { const v = viewerPos(); if (abots.every(b => b.pos && Math.hypot(b.pos.x - v.x, b.pos.y - v.y) > 700)) break; await sleep(100); }
    const v1 = viewerPos();
    r = await call(abots[0], 'test:spawn', { types: ['c', 'u', 'r', 'e', 'l', 'm', 't'], ring: 150, x: v1.x, y: v1.y });
    ok(r && r.ok && r.n === 7, 'test hook spawns one orb of each tier');
    await vp.click('#helpBtn'); await sleep(3400); // let the «мифическая сфера» toast fade
    const legend = await vp.evaluate(() => Array.from(document.querySelectorAll('#orbHelpList .oh-row')).map(e => e.dataset.orb + ':' + e.querySelector('b').textContent));
    ok(legend.join(' ') === 'c:+1 u:+2 r:+5 e:+10 l:+25 m:+50 t:+50', 'orb legend popover lists every tier with its value: ' + legend.join(' '));
    await shot(vp, 'screenshot-orb-rarities.png');
    await vp.click('#orbHelpClose');
    // ---------------- trails by rarity: the arena renderer on a test canvas (common → legendary → exclusives)
    const nTrails = await vp.evaluate(() => { const cv = document.createElement('canvas'); cv.id = 'trailDemo'; cv.width = innerWidth; cv.height = innerHeight;
      cv.style.cssText = 'position:fixed;inset:0;z-index:999'; document.body.appendChild(cv); return window.OCSTrailShowcase(cv); });
    await sleep(1200);
    ok(nTrails >= 14, `trail showcase renders all ${nTrails} trails (rarity FX layer: glow / sparkles / particles / bursts / exclusive effects)`);
    await shot(vp, 'screenshot-trails-epic.png');
    await vp.evaluate(() => document.getElementById('trailDemo').remove());
    // ---------------- «Радар»: the same ring of every tier is next to the viewer; only c/u/r may show up
    await sleep(3100); await vp.waitForFunction(() => window.OCSRadar && window.OCSRadar().tiers.length > 0, null, { timeout: 5000 });
    await sleep(900); // mid-pulse: wave out, blips lit
    const rad = await vp.evaluate(() => window.OCSRadar());
    ok(rad.tiers.length > 0 && rad.tiers.every(t => ['c', 'u', 'r'].includes(t)) && ['c', 'u', 'r'].every(t => rad.tiers.includes(t)),
      `radar shows only common/uncommon/rare blips (${rad.tiers.length}) + ${rad.players} player(s); epic/legendary/mythic/treasure hidden`);
    await shot(vp, 'screenshot-radar.png');
    await vp.click('#radarToggle');
    const rc = await vp.evaluate(() => ({ c: window.OCSRadar().collapsed, h: document.getElementById('minimap').offsetHeight }));
    await vp.click('#radarToggle');
    ok(rc.c && rc.h === 0 && !(await vp.evaluate(() => window.OCSRadar().collapsed)), 'radar collapses and expands with its button');
    botMode = 'circle';

    // ---------------- «Лавка осколков»: an account with shards (granted via the test hook), two exclusives bought over the socket
    const fan = bot(arena.url, 'Shard_Fan');
    r = await new Promise(res => fan.s.emit('auth', { mode: 'register', name: 'Shard_Fan', password: PW, confirm: PW }, res));
    await call(fan, 'test:grant', { id: SG.SHARD_ID, qty: 200, source: 'event' });
    const b1 = await call(fan, 'shard:buy', 'c_void'), b2 = await call(fan, 'shard:buy', 'n_shard');
    ok(b1 && b1.ok && b2 && b2.ok, 'socket purchases in «Лавка осколков» (40 + 50 shards)');
    fan.close(); await sleep(300);
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const sp = await sctx.newPage();
    watch(sp);
    await sp.goto(arena.url); await sleep(400);
    await sp.fill('#nick', 'Shard_Fan'); await sp.fill('#pass', PW); await sp.click('#authSubmit');
    await sp.waitForSelector('#profile:not(.hidden)', { timeout: 10000 });
    await sp.click('#pfPlay');
    await sp.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
    await sp.keyboard.press('KeyB'); await sleep(300);
    ok(await sp.evaluate(() => !Array.from(document.querySelectorAll('#shopGrid .item[data-item]')).some(e => G.ITEM_BY_ID[e.dataset.item].exclusive)), 'exclusives are not listed in the orb shop');
    await sp.click('#shopTabs .tab[data-tab=shards]'); await sleep(300);
    const ss = await sp.evaluate(() => ({ have: document.getElementById('shardCount').textContent,
      cards: Array.from(document.querySelectorAll('#shopGrid .ex-item')).map(e => ({ id: e.dataset.item, badge: !!e.querySelector('.ex-badge'), btn: e.querySelector('.buy-btn').textContent, dis: e.querySelector('.buy-btn').disabled, own: (e.querySelector('.owned-n') || {}).textContent || '' })) }));
    const EXC = SG.ITEMS.filter(i => i.exclusive);
    ok(/^110\s*$/.test(ss.have), 'shard count shown: ' + ss.have.trim());
    ok(ss.cards.length === EXC.length && ss.cards.every(c => c.badge) && ss.cards.every((c, i) => !i || SG.ITEM_BY_ID[c.id].shardPrice >= SG.ITEM_BY_ID[ss.cards[i - 1].id].shardPrice),
      `${ss.cards.length} exclusive cards with the «Эксклюзив» badge, cheapest first`);
    const cardOf = id => ss.cards.find(c => c.id === id) || {};
    ok(/В инвентаре: 1/.test(cardOf('c_void').own) && /В инвентаре: 1/.test(cardOf('n_shard').own) && !cardOf('t_comet').dis && cardOf('h_shard_crown').dis && /300/.test(cardOf('h_shard_crown').btn),
      'owned → «В инвентаре», affordable → enabled, too expensive → disabled with the shard price');
    await shot(sp, 'screenshot-shard-shop.png');
    // currency icons: gold shard SVG on shard prices, glowing CSS orb on orb amounts (no emoji left)
    const ic = await sp.evaluate(() => {
      const cs = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const sh = cs('#shopGrid .ex-item .shard-buy .cur-shard, #shopGrid .ex-item button .cur-shard'), orb = cs('#shardExBtn .cur-orb'), hud = cs('.balance .cur-orb'), pill = cs('#shop .pill .cur-orb, .modal .pill .cur-orb');
      return { shard: sh && sh.backgroundImage, orb: orb && orb.backgroundImage, glow: orb && orb.boxShadow, hud: !!hud, pill: !!pill,
        buyShards: document.querySelectorAll('#shopGrid .ex-item button .cur-shard').length, have: !!document.querySelector('#shardCount .cur-shard'),
        emoji: /[💎◉]/u.test(document.getElementById('shop').textContent) };
    });
    ok(ic.shard && /ffd23f/i.test(ic.shard) && ic.orb && /radial-gradient/.test(ic.orb) && /rgba\(62, 224, 255/.test(ic.glow) && ic.hud && ic.pill && ic.have && ic.buyShards >= 6 && !ic.emoji,
      `currency icons: gold shard on ${ic.buyShards} shard prices + count, glowing orb on exchange / balance pill / HUD, no 💎/◉ emoji in the shop`);
    await shot(sp, 'screenshot-shop-icons.png');
    await sp.locator('#shopGrid [data-item=t_comet] .buy-btn').click(); await sleep(600);
    ok(/^40\s*$/.test(await sp.textContent('#shardCount')) && /В инвентаре: 1/.test(await sp.textContent('#shopGrid [data-item=t_comet] .owned-n')), 'buying in the UI spends shards (110 → 40)');
    const balBeforeEx = Number((await sp.textContent('#hudBalance')).replace(/\s/g, ''));
    await sp.fill('#shardExQty', '2'); await sp.click('#shardExBtn'); await sleep(600);
    const balAfterEx = Number((await sp.textContent('#hudBalance')).replace(/\s/g, ''));
    ok(/^38\s*$/.test(await sp.textContent('#shardCount')) && balAfterEx - balBeforeEx >= 2 * SG.SHARD_EXCHANGE.orbs && balAfterEx - balBeforeEx < 2 * SG.SHARD_EXCHANGE.orbs + 30, `exchange in the UI: 2 💎 → +${balAfterEx - balBeforeEx} ◉`);
    await sp.keyboard.press('Escape'); await sp.keyboard.press('KeyI'); await sleep(400);
    ok(await sp.evaluate(() => ['c_void', 'n_shard', 't_comet'].every(id => { const e = document.querySelector(`#invGrid [data-item=${id}]`); return e && e.querySelector('.ex-badge') && /Лавка осколков/.test(e.textContent); })),
      'inventory: exclusives carry the badge and the source «Лавка осколков»');
    // ---------------- mini-games menu: 6 games, fees with the orb icon; one round of «Угадай чашу» in the UI
    await sp.keyboard.press('Escape'); await sleep(200); await sp.keyboard.press('KeyM'); await sleep(400);
    const gm = await sp.evaluate(() => Array.from(document.querySelectorAll('#gamesList [data-game]')).map(b => ({ k: b.dataset.game, icon: !!b.querySelector('.cur-orb'), dis: b.disabled })));
    ok(gm.map(g => g.k).join() === 'reaction,rush,memory,shell,throw,chain' && gm.every(g => g.icon && !g.dis), 'mini-games window lists all 6 games, fees shown with the orb icon: ' + gm.map(g => g.k).join(', '));
    await shot(sp, 'screenshot-minigames-6.png');
    await sp.click('#gamesList [data-game=shell]'); await sleep(1900);
    ok(await sp.isVisible('#mg2Canvas') && /Следите|Запомните/.test(await sp.textContent('#mg2Info')), '«Угадай чашу» runs in the shared game canvas: ' + await sp.textContent('#mg2Info'));
    await shot(sp, 'screenshot-minigame-shell.png');
    await sp.waitForFunction(() => /Где сфера/.test(document.getElementById('mg2Info').textContent), null, { timeout: 8000 });
    const cb = await sp.locator('#mg2Canvas').boundingBox();
    await sp.mouse.click(cb.x + cb.width * 300 / 600, cb.y + cb.height * 260 / 400);
    await sp.waitForSelector('#mgResult:not(.hidden)', { timeout: 6000 });
    const mr = await sp.textContent('#mgResult');
    ok(/Угадай чашу: (Угадали|Мимо)/.test(mr) && /Взнос 10/.test(mr), 'cup picked by tap → server result shown: ' + mr.replace(/\s+/g, ' ').slice(0, 80));
    await sctx.close();

    for (const b of abots) b.close();
    await vctx.close();
    arena.stop();
  }

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
    await cp.waitForFunction(() => /исчезнет/.test(document.getElementById('chatLog').textContent), null, { timeout: 3000 });
    await cp.waitForFunction(() => !/исчезнет/.test(document.getElementById('chatLog').textContent), null, { timeout: 9000 });
    await sleep(300);
    const n = await cp.evaluate(() => document.querySelectorAll('#chatLog .chat-msg').length);
    ok(n === 0, `chat silently becomes empty on the periodic clear (${n} lines, no «очищен» notice)`);
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
