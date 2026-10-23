// daily rewards calendar. Run: NODE_PATH=./node_modules node test/daily-cal-test.js
const G = require('../public/shared.js'), C = require('../public/content.js'), INV = require('../lib/inventory.js'), D = require('../lib/daily.js');
const { spawn } = require('child_process'); const fs = require('fs');
let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const DAY = 86400000, T0 = Date.UTC(2026, 9, 23, 9, 0, 0); // 12:00 MSK
const mk = () => { const a = { balance: 0, total: 0, inventory: INV.emptyInventory(), owned: G.DEFAULT_OWNED.slice(), equipped: Object.assign({}, G.DEFAULT_EQUIPPED), stats: {}, createdAt: T0 }; INV.migrateAccount(a); return a; };
(async () => {
  // table sanity
  ok(C.CALENDAR.length === 14, '14-day cycle');
  for (const id of ['c_calendar', 't_pages', 'e_calendar', 'e_check']) { const d = G.ITEM_BY_ID[id]; ok(d && d.sources.includes('daily') && !d.sources.includes('shop') && !(d.price > 0) && !d.shardPrice, `${id} exists, not sold`); }
  ok(C.CALENDAR.some(r => r.orbs) && C.CALENDAR.some(r => r.shards) && C.CALENDAR.some(r => r.potions), 'calendar has orbs, shards and potions');
  // once per day
  const a = mk();
  let r = D.claimDaily(a, T0); ok(r.ok && r.reward.day === 1 && a.balance === 50, 'day 1 claimed: +50 orbs');
  r = D.claimDaily(a, T0 + 3600000); ok(!r.ok && r.code === 'claimed' && a.balance === 50, 'second claim same day refused');
  r = D.claimDaily(a, T0 + 11.5 * 3600000); ok(!r.ok, 'still refused at 23:30 MSK');
  r = D.claimDaily(a, T0 + 12.5 * 3600000); ok(r.ok && r.reward.day === 2 && INV.countItem(a, 'p_speed') === 1, 'after 00:00 MSK: day 2 → speed potion');
  // missed days: progress continues
  r = D.claimDaily(a, T0 + 5 * DAY); ok(r.ok && r.reward.day === 3 && (a.stats.shards || 0) === 1, 'after missing days: day 3 (no reset), +1 shard');
  r = D.claimDaily(a, T0 + 6 * DAY); ok(r.ok && r.reward.item === 'e_calendar' && INV.hasItem(a, 'e_calendar'), 'day 4: emote «Календарь» granted');
  // full cycle
  let t = T0 + 7 * DAY; for (let i = 5; i <= 14; i++, t += DAY) { r = D.claimDaily(a, t); if (!r.ok || r.reward.day !== i) ok(false, 'cycle day ' + i); }
  ok(INV.hasItem(a, 'c_calendar') && INV.hasItem(a, 'e_check') && INV.hasItem(a, 't_pages'), 'cycle: colour, 2nd emote and trail granted');
  ok(a.stats.cal.n === 14 && D.calState(a, t).idx === 0 && D.calState(a, t).cycle === 1, 'after day 14 the cycle restarts at day 1');
  // duplicate → shards
  for (let i = 1; i <= 3; i++, t += DAY) D.claimDaily(a, t);
  const s0 = a.stats.shards; r = D.claimDaily(a, t); t += DAY;
  ok(r.ok && r.reward.day === 4 && r.reward.dup === 'e_calendar' && !r.reward.item && a.stats.shards === s0 + 3 && INV.countItem(a, 'e_calendar') === 1, 'second cycle: owned emote → 3 shards instead');
  // over the wire: rate limit + once per day
  const PORT = 3161, DF = '/tmp/ocs-cal-test.json'; try { fs.unlinkSync(DF); } catch (_) {}
  const proc = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: DF, DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0' }), stdio: 'ignore' });
  try {
    const URL = 'http://localhost:' + PORT; for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 200)); }
    const { io } = require('socket.io-client'); const s = io(URL, { transports: ['websocket'] });
    const em = (ev, ...a) => new Promise(res => s.emit(ev, ...a, res));
    await new Promise(r => s.on('connect', r));
    const reg = await em('auth', { mode: 'register', name: 'Cal' + Math.floor(Math.random() * 1e6), password: 'demo-pass-123', confirm: 'demo-pass-123', enter: true });
    ok(reg && reg.ok !== false, 'registered');
    const c1 = await em('daily:claim'), c2 = await em('daily:claim');
    ok(c1.ok && c1.reward.orbs === 50 && c1.profile.balance >= 50, 'socket claim works');
    ok(!c2.ok && c2.code === 'rate', 'immediate second claim rate-limited');
    await new Promise(r => setTimeout(r, 1600)); const c3 = await em('daily:claim');
    ok(!c3.ok && c3.code === 'claimed', 'second claim same day refused by the server');
    s.close();
  } finally { proc.kill(); try { fs.unlinkSync(DF); } catch (_) {} }
  console.log(f ? `${f} FAILED` : 'ALL PASS'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
