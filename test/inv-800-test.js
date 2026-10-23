// inventory 800 units / stacks of 99 + safe migration. Run: node test/inv-800-test.js
const G = require('../public/shared.js'), INV = require('../lib/inventory'); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
ok(G.INV_CAP === 800, 'INV_CAP 800 units');
ok(G.ITEMS.filter(d => d.stackable && d.id !== G.SHARD_ID).every(d => d.maxStack === 99), 'every stackable item stacks to 99');
const acc = { inventory: { v: 1, slots: [{ id: 'p_luck', q: 20 }, { id: 'p_luck', q: 20 }, { id: 'p_luck', q: 20 }, { id: 'p_luck', q: 20 }, { id: 'p_luck', q: 20 }, { id: 'p_luck', q: 7 }, { id: 'c_coral', q: 3 }, { id: 'p_speed', q: 20 }] }, owned: [], equipped: {}, stats: {} };
const before = INV.unitsUsed({ inventory: acc.inventory }); INV.migrateAccount(acc);
const luck = acc.inventory.slots.filter(s => s.id === 'p_luck').map(s => s.q);
ok(INV.unitsUsed(acc) - acc.inventory.slots.filter(s => s.id === 'h_beta').length === before && before === 130, `no units lost (${before} → ${INV.unitsUsed(acc)})`);
ok(luck.join(',') === '99,8', 'old 20-stacks merged into 99 + 8: ' + luck);
const g = INV.grantItem(acc, 'p_speed', 79, 'event'); ok(g.ok && acc.inventory.slots.filter(s => s.id === 'p_speed').map(s => s.q).join(',') === '99', 'potion grant fills stack to 99');
const g2 = INV.grantItem(acc, 'c_lime', 800 - INV.unitsUsed(acc), 'event'), g3 = INV.grantItem(acc, 'c_lime', 1, 'event');
ok(g2.ok && INV.unitsUsed(acc) === 800 && !g3.ok && /800 \/ 800/.test(g3.error), 'fills to 800, then full');
console.log(f ? f + ' FAIL' : 'ALL PASS'); process.exit(f ? 1 : 0);
