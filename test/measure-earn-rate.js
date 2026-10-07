// Earn-rate measurement used for pricing: node test/measure-earn-rate.js <bots> <seconds> [url]
// Registers <bots> throw-away accounts on the given server (default http://localhost:3110 — use a scratch server, not production!)
// and prints orbs/min per bot. HUMAN=1 makes the bots re-target only every 600 ms.
// UPGRADES=max (or a JSON object like '{"magnet":5,"speed":5}') sets the bots' upgrade levels first — needs a server with OCS_TEST_HOOKS=1.
const { io } = require('socket.io-client');
const G = require('../public/shared.js');
const URL = process.argv[4] || 'http://localhost:3110', N = +process.argv[2] || 1, SEC = +process.argv[3] || 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bot(i) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const b = { orbs: new Map(), pos: null, id: null, total: 0, seq: 0 };
  s.on('s', st => { for (const [id, x, y] of st.p) if (id === b.id) b.pos = { x, y }; for (const [id, x, y, t] of st.oa) b.orbs.set(id, { x, y, t }); for (const [id] of st.od) b.orbs.delete(id); });
  s.on('bal', v => { b.total = v.s; });
  s.on('sping', v => s.emit('spong', v));
  const r = await new Promise(res => s.emit('auth', { mode: 'register', name: 'Meas' + i + '_' + Math.floor(Math.random() * 1e5), password: 'measure-pass', confirm: 'measure-pass' }, res));
  const want = process.env.UPGRADES === 'max' ? Object.fromEntries(G.UPGRADE_KEYS.map(k => [k, G.UPGRADES[k].max])) : process.env.UPGRADES ? JSON.parse(process.env.UPGRADES) : null;
  if (want) { const u = await new Promise(res => s.emit('test:upgrades', want, res)); if (!u || !u.ok) throw new Error('test:upgrades failed — start the server with OCS_TEST_HOOKS=1'); }
  b.id = r.you; for (const o of r.orbs) b.orbs.set(o[0], { x: o[1], y: o[2], t: o[3] }); b.pos = r.players.find(p => p.id === r.you);
  const human = process.env.HUMAN === '1';
  const t0 = Date.now(); let target = null, retarget = 0;
  while (Date.now() - t0 < SEC * 1000) {
    if (!target || !b.orbs.has(target.id) || Date.now() > retarget) {
      let best = null, bd = Infinity;
      for (const [id, o] of b.orbs) { const d = Math.hypot(o.x - b.pos.x, o.y - b.pos.y) / G.ORB_TYPES[o.t].value ** 0.5; if (d < bd) { bd = d; best = { id, ...o }; } }
      target = best; retarget = Date.now() + (human ? 600 : 0);
    }
    let dx = 0, dy = 0;
    if (target && b.orbs.has(target.id)) { dx = target.x - b.pos.x; dy = target.y - b.pos.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
    s.emit('input', { s: ++b.seq, x: dx, y: dy });
    await sleep(50);
  }
  s.close();
  return b.total / SEC * 60;
}
(async () => { const r = await Promise.all(Array.from({ length: N }, (_, i) => bot(i))); const h = await (await fetch(URL + '/api/health')).json();
  console.log(`bots=${N} ${process.env.HUMAN === '1' ? '(human-like)' : '(greedy)'} upgrades=${process.env.UPGRADES || 'none'} orbs/min per bot:`, r.map(x => x.toFixed(0)).join(', '), 'avg', (r.reduce((a, b) => a + b, 0) / N).toFixed(0), 'orbs now', h.orbs, 'target', h.targetOrbs); process.exit(); })();
