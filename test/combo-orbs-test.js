'use strict';
// Combo multipliers, mid-tier orbs, ach v3 baseline — unit + light integration.
const G = require('../public/shared.js');
const C = require('../public/content.js');
const assert = (c, m) => { if (!c) throw new Error(m); console.log('ok', m); };

assert(G.COMBO && G.COMBO.maxMult === 2 && G.COMBO.windowMs === 1800, 'COMBO window/cap');
assert(G.comboMult(1) === 1 && G.comboMult(5) === 1.1 && G.comboMult(50) === 2 && G.comboMult(999) === 2, 'comboMult steps + cap');
assert(G.SPAWN_ALTAR.x === G.ZONE_W / 2 && G.SPAWN_ALTAR.y === G.ZONE_H / 2 && G.SHOP_PAD.r > 0, 'altar + shop pad');

const mid = ['b', 'g', 'p', 'a', 'x'];
for (const k of mid) assert(G.ORB_TYPES[k] && G.ORB_RANK[k] != null, 'mid orb ' + k);
assert(G.ORB_TYPES.b.value === 2 && G.ORB_TYPES.g.value === 4 && G.ORB_TYPES.p.value === 7 && G.ORB_TYPES.a.value === 17 && G.ORB_TYPES.x.value === 35, 'mid orb values');
assert(G.ORB_TYPES.x.shards === 2 && G.ORB_TYPES.x.lifeMs > 0, 'astral shards + life');
const w = Object.values(G.ORB_TYPES).reduce((s, t) => s + (t.weight || 0), 0);
const mean = G.expectedOrbValue();
assert(w === 10000 && mean >= 1.35 && mean <= 1.5, `pool weights ${w} mean ${mean.toFixed(4)}`);

assert(C.ACH.length === 100 && C.CHAINS.length === 27, '100 ACH / 27 chains');
assert(C.achValue(C.ACH_BY_ID.total_1, { total: 10, stats: { achBase: { total: 10 } } }) === 0, 'baseline zeroes progress');
assert(C.achValue(C.ACH_BY_ID.total_1, { total: 11, stats: { achBase: { total: 10 } } }) === 1, 'progress past baseline');
assert(C.achValue(C.ACH_BY_ID.zone2_1, { stats: { unlockedDoor2: true, achBase: {} } }) === 1, 'zone2 ignores baseline');
assert(G.TROPHY_ACH === 50, 'trophy still at 50');
console.log('ALL PASS');
