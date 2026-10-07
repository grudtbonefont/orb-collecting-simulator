// Headless multiplayer check: node test/multiplayer-test.js [url]
const { io } = require('socket.io-client');
const crypto = require('crypto');
const G = require('../public/shared.js');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const suffix = Math.random().toString(36).slice(2, 6);

function makeBot(name, token = crypto.randomUUID()) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const bot = { s, name, token, id: null, pos: null, orbs: new Map(), profile: null, seq: 0, metas: new Map(), events: [] };
  s.on('s', st => {
    for (const [id, x, y] of st.p) if (id === bot.id) bot.pos = { x, y };
    for (const [id, x, y, t] of st.oa) bot.orbs.set(id, { id, x, y, t });
    for (const [id] of st.od) bot.orbs.delete(id);
  });
  s.on('bal', b => { if (bot.profile) { bot.profile.balance = b.b; bot.profile.total = b.t; } });
  s.on('profile', p => { bot.profile = p; });
  s.on('pjoin', p => bot.metas.set(p.id, p));
  s.on('pmeta', p => { bot.metas.set(p.id, p); bot.events.push(['pmeta', p]); });
  s.on('sping', v => s.emit('spong', v));
  bot.join = () => new Promise(res => s.emit('join', { name, token: bot.token }, r => {
    if (r.ok) { bot.id = r.you; bot.profile = r.profile; for (const o of r.orbs) bot.orbs.set(o[0], { id: o[0], x: o[1], y: o[2], t: o[3] }); for (const p of r.players) { bot.metas.set(p.id, p); if (p.id === r.you) bot.pos = { x: p.x, y: p.y }; } }
    res(r);
  }));
  bot.emit = (ev, arg) => new Promise(res => s.emit(ev, arg, r => { if (r && r.profile) bot.profile = r.profile; res(r); }));
  // chase nearest orb (prefer valuable) until balance >= target
  bot.farm = async (target, maxMs) => {
    const t0 = Date.now();
    while (bot.profile.balance < target && Date.now() - t0 < maxMs) {
      let best = null, bd = Infinity;
      for (const o of bot.orbs.values()) { const d = Math.hypot(o.x - bot.pos.x, o.y - bot.pos.y) / G.ORB_TYPES[o.t].value ** 0.5; if (d < bd) { bd = d; best = o; } }
      let dx = 0, dy = 0;
      if (best) { dx = best.x - bot.pos.x; dy = best.y - bot.pos.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
      s.emit('input', { s: ++bot.seq, x: dx, y: dy });
      await sleep(50);
    }
  };
  return bot;
}

(async () => {
  const health = await (await fetch(URL + '/api/health')).json();
  ok(health.ok && health.orbs > 0, `server health ok (${JSON.stringify(health)})`);
  const page = await (await fetch(URL + '/')).text();
  ok(page.includes('Orb Collecting Simulator') && page.includes('Магазин'), 'index page served with Russian UI');

  const A = makeBot('Тест_А_' + suffix), B = makeBot('TestB_' + suffix);
  const ra = await A.join(), rb = await B.join();
  ok(ra.ok && rb.ok, 'two players joined');
  await sleep(300);
  ok(B.metas.has(A.id) && A.metas.has(B.id), 'players see each other');

  // impostor with same name but different token is rejected
  const C = makeBot(A.name);
  const rc = await C.join();
  ok(!rc.ok && /занят/.test(rc.error), 'same nickname with wrong token rejected: ' + rc.error);
  C.s.close();

  // movement + server authority: flood inputs, check speed cap
  const p0 = { ...A.pos };
  for (let i = 0; i < 200; i++) A.s.emit('input', { s: ++A.seq, x: 5, y: 0 });
  await sleep(1000);
  const moved = Math.hypot(A.pos.x - p0.x, A.pos.y - p0.y);
  const maxLegit = G.speedFor(0) * 1.0 + G.speedFor(0) * G.STEP_DT * 8;
  ok(moved > 50 && moved <= maxLegit, `input flood is rate-limited: moved ${moved.toFixed(0)}px in 1s (cap ≈${maxLegit.toFixed(0)})`);
  await sleep(1000);

  // collect orbs
  const before = A.profile.total;
  await A.farm(before + 1, 20000);
  ok(A.profile.total > before, `A collected orbs (total ${A.profile.total})`);
  await A.farm(60, 90000);
  ok(A.profile.balance >= 60, `A farmed balance to ${A.profile.balance}`);

  // shop: buy + equip, B sees cosmetics
  const r1 = await A.emit('buy', 'c_coral');
  ok(r1.ok && r1.profile.equipped.color === 'c_coral', 'A bought and auto-equipped c_coral (25)');
  await sleep(200);
  ok(B.metas.get(A.id) && B.metas.get(A.id).eq.color === 'c_coral', 'B sees A\'s new color');
  const r2 = await A.emit('buy', 'c_coral');
  ok(!r2.ok, 'cannot buy same item twice: ' + r2.error);
  const r3 = await A.emit('buy', 'c_rainbow');
  ok(!r3.ok, 'cannot buy unaffordable item: ' + r3.error);
  const r4 = await A.emit('equip', 'c_cyan');
  ok(r4.ok && r4.profile.equipped.color === 'c_cyan', 'equip owned default item');
  const r5 = await A.emit('equip', 'h_crown');
  ok(!r5.ok, 'cannot equip unowned item');
  await A.farm(40, 60000);
  const r6 = await A.emit('upgrade', 'magnet');
  ok(r6.ok && r6.profile.upgrades.magnet === 1, `magnet upgrade lvl 1 purchased (balance now ${r6.profile && r6.profile.balance})`);
  const r7 = await A.emit('upgrade', 'speed');
  ok(!r7.ok || r7.profile.upgrades.speed === 1, 'speed upgrade handled: ' + (r7.ok ? 'bought' : r7.error));

  // mini-game: reaction
  await A.farm(10, 30000);
  const balR = A.profile.balance;
  const res = new Promise(r => A.s.once('mg:result', r));
  A.s.once('mg:reaction:go', () => setTimeout(() => A.s.emit('mg:reaction:click'), 150));
  const st = await A.emit('mg:start', 'reaction');
  ok(st.ok, 'reaction mini-game started (fee 10)');
  const rr = await res;
  await sleep(200);
  ok(rr.prize >= 0 && A.profile.balance === balR - 10 + rr.prize, `reaction result: ${rr.message}, prize ${rr.prize}, balance ${balR} -> ${A.profile.balance}`);

  // early click
  await sleep(1700);
  await A.farm(10, 30000);
  const res2 = new Promise(r => A.s.once('mg:result', r));
  await A.emit('mg:start', 'reaction');
  A.s.emit('mg:reaction:click');
  const rr2 = await res2;
  ok(rr2.prize === 0 && /рано/.test(rr2.message), 'early click loses fee: ' + rr2.message);

  // mini-game: rush with B (B farms 15 first)
  await B.farm(15, 60000);
  ok(B.profile.balance >= 15, `B farmed ${B.profile.balance}`);
  const balB = B.profile.balance;
  let hits = 0;
  B.s.on('mg:rush:spawn', async tg => {
    if (tg.type === 'b') return;
    await sleep(120);
    const h = await B.emit('mg:rush:hit', { id: tg.id, x: tg.x + 3, y: tg.y - 3 });
    if (h.ok) hits++;
  });
  const bad = B.emit('mg:rush:hit', { id: 999, x: 0, y: 0 });
  const resB = new Promise(r => B.s.once('mg:result', r));
  const stB = await B.emit('mg:start', 'rush');
  ok(stB.ok, 'orb rush started (fee 15)');
  const fake = await B.emit('mg:rush:hit', { id: 1, x: -500, y: -500 });
  ok(!fake.ok, 'rush rejects hit at wrong position / before spawn');
  const rB = await resB;
  await sleep(200);
  ok(rB.prize > 15 && hits > 10 && B.profile.balance === balB - 15 + rB.prize, `orb rush: ${rB.message}, prize ${rB.prize}, balance ${balB} -> ${B.profile.balance}`);

  // leaderboard
  const lb = await (await fetch(`${URL}/api/leaderboard?limit=10&name=${encodeURIComponent(A.name)}`)).json();
  const names = lb.players.map(p => p.name);
  ok(names.includes(A.name) && names.includes(B.name), 'leaderboard contains both players');
  const sorted = lb.players.every((p, i, arr) => i === 0 || arr[i - 1].total >= p.total);
  ok(sorted && lb.me && lb.me.total === A.profile.total, `leaderboard sorted by total collected; A rank #${lb.me && lb.me.rank} total ${lb.me && lb.me.total}`);
  console.log('Leaderboard top:', lb.players.slice(0, 5).map(p => `${p.rank}. ${p.name} ${p.total}`).join(' | '));

  A.s.close(); B.s.close();
  console.log(JSON.stringify({ A: { name: A.name, token: A.token, total: A.profile.total, balance: A.profile.balance } }));
  setTimeout(() => process.exit(), 200);
})().catch(e => { console.error(e); process.exit(1); });
