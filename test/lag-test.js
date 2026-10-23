// Lag / rubber-band bench: 75 obstacles + bots, a driver client with 150 ms simulated RTT and one 800 ms upstream stall.
// Reports server tick cost (/api/health perf), payload sizes, and the driver's biggest prediction correction (snap-back).
//   node test/lag-test.js
const { io } = require('socket.io-client'); const { spawn } = require('child_process'); const path = require('path');
const G = require('../public/shared.js'); const ROOT = path.join(__dirname, '..'), PORT = 3150, URL = 'http://localhost:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const BOTS = +(process.env.BOTS || 8), RTT = 150;
(async () => {
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/lagbench.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OCS_TEST_HOOKS: '1' }), stdio: process.env.LOGS ? 'inherit' : 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(URL + '/api/health')).ok) break; } catch (e) {} await sleep(250); }
  const mk = async name => { const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false }); await new Promise(r => s.on('connect', r));
    const call = (ev, d) => new Promise(r => { const t = setTimeout(() => r({ ok: false, timeout: 1 }), 3000); s.emit(ev, d, v => { clearTimeout(t); r(v); }); }); s.on('disconnect', why => console.log('disconnect', name, why)); const r = await call('auth', { mode: 'register', name, password: 'correct-horse-9', confirm: 'correct-horse-9' }); if (!r.ok) console.log('auth', name, JSON.stringify(r)); return { s, call, r }; };
  const tag = Date.now() % 100000, bots = [];
  console.log('server up'); for (let i = 0; i < BOTS; i++) bots.push(await mk('lb' + tag + 'b' + i));
  const D = await mk('lb' + tag + 'd');
  let n = 0, miss = 0, nat = 0; for (let i = 0; n < 75 && miss < 25; i++) { await sleep(25); const r = await D.call('test:obstacle', { kind: ['wall', 'block', 'rock', 'laser'][i % 4], lifeMs: 600000 }); if (r.ok) { n = r.obstacles.length; miss = 0; } else miss++; }
  nat = n; // the spacing rules (gap / door / players) cap natural placement; fill the rest on a grid for a worst-case 75
  for (let i = 0; n < 75 && i < 200; i++) { await sleep(25); const r = await D.call('test:obstacle', { kind: ['block', 'rock', 'laser', 'wall'][i % 4], x: 400 + (i % 14) * 820, y: 500 + Math.floor(i / 14) * 1000, lifeMs: 600000 }); if (r.ok) n = r.obstacles.length; }
  console.log(`natural placement fits ${nat} obstacles; total now ${n}`);
  for (let i = 0; i < 2; i++) await D.call('test:obstacle', { kind: 'robot', lifeMs: 600000 });
  ok(n >= 60, `obstacles placed: ${n}`);
  // payload sizes (driver)
  const bytes = { s: 0, obs: 0, other: 0 }; let sN = 0;
  D.s.onAny((ev, ...a) => { const b = JSON.stringify(a).length; if (ev === 's') { bytes.s += b; sN++; } else if (ev === 'obs') bytes.obs += b; else bytes.other += b; });
  // bots: random walk
  const bt = bots.map((b, i) => { let seq = 0, dx = 1, dy = 0; return setInterval(() => { if (Math.random() < 0.05) { const a = Math.random() * 6.28; dx = Math.cos(a); dy = Math.sin(a); } b.s.emit('input', { s: ++seq, x: dx, y: dy }); }, G.TICK_MS); });
  // driver: client-side prediction like public/client.js, with RTT/2 each way
  let obstacles = []; D.s.on('obs', l => setTimeout(() => { obstacles = l; }, RTT / 2));
  const me = D.r.players.find(p => p.id === D.r.you); const pos = { x: me.x, y: me.y }; let pending = [], seq = 0, maxErr = 0, snaps = 0, stallUntil = 0, held = [];
  const speed = G.speedFor(0);
  D.s.on('s', st => setTimeout(() => { const r = st.p.find(q => q[0] === D.r.you); if (!r) return; pending = pending.filter(i => i.s > r[3]);
    const p = { x: r[1], y: r[2] }; for (const i of pending) { const px = p.x; G.applyInput(p, i.x, i.y, speed); G.zoneGate(p, px, false); G.resolveObstacles(p, obstacles); }
    const e = Math.hypot(pos.x - p.x, pos.y - p.y); if (e > maxErr) maxErr = e; if (e > 30) snaps++; pos.x = p.x; pos.y = p.y; }, RTT / 2));
  let ang = 0; const t0 = Date.now();
  const dt = setInterval(() => { if (Date.now() - t0 > 2000 * Math.ceil((Date.now() - t0 + 1) / 2000) - 50) ang += 1.3; const inp = { s: ++seq, x: +Math.cos(ang).toFixed(3), y: +Math.sin(ang).toFixed(3) };
    const px = pos.x; G.applyInput(pos, inp.x, inp.y, speed); G.zoneGate(pos, px, false); G.resolveObstacles(pos, obstacles); pending.push(inp);
    if (Date.now() < stallUntil) held.push(inp); else { const out = held.concat([inp]); held = []; for (const m of out) setTimeout(() => D.s.emit('input', m), RTT / 2); } }, G.TICK_MS);
  setTimeout(() => { stallUntil = Date.now() + 800; }, 6000); // network hiccup: 800 ms of inputs arrive at once
  await fetch(URL + '/api/health?perf=1'); await sleep(12000);
  const h = await (await fetch(URL + '/api/health?perf=1')).json(); clearInterval(dt); bt.forEach(clearInterval); await sleep(300);
  const secs = 12; console.log(`perf ${JSON.stringify(h.perf)}  players ${h.online}  obstacles ${h.obstacles}`);
  console.log(`payload/client: s ${(bytes.s / sN | 0)} B/tick (${(bytes.s / secs / 1024).toFixed(1)} KB/s), obs ${(bytes.obs / secs / 1024).toFixed(2)} KB/s, other ${(bytes.other / secs / 1024).toFixed(2)} KB/s`);
  console.log(`driver (RTT ${RTT} ms + 800 ms stall): max correction ${maxErr.toFixed(1)} px, corrections >30px: ${snaps}`);
  ok(h.perf.tickAvgMs < 5 && h.perf.tickMaxMs < 25, `tick cost avg ${h.perf.tickAvgMs} ms / max ${h.perf.tickMaxMs} ms (budget ${G.TICK_MS})`);
  ok(h.perf.inputsDropped === 0, `no inputs dropped (${h.perf.inputsDropped})`);
  ok(maxErr < 30, `no snap-back (max correction ${maxErr.toFixed(1)} px)`);
  proc.kill(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
