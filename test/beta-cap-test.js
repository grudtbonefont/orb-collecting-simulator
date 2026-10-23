// beta-test cap auto-grant (once per account, never sold). Run: node test/beta-cap-test.js
const G = require('../public/shared.js'), INV = require('../lib/inventory.js');
let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const ID = G.BETA_CAP_ID, def = G.ITEM_BY_ID[ID], n = a => INV.countItem(a, ID);
ok(G.BETA_CAP_GRANT === true && def && def.cat === 'hat' && def.rarity === 'exclusive', 'h_beta exists, hat, rarity «Эксклюзив»');
ok(G.RARITIES.exclusive && G.RARITIES.exclusive.name === 'Эксклюзив', 'exclusive rarity defined');
ok(G.ITEMS.filter(i => i.rarity === 'exclusive').map(i => i.id).join() === ID, 'only the beta cap uses «Эксклюзив»');
ok(G.ITEMS.filter(i => i.exclusive).every(i => ['common', 'rare', 'epic', 'legendary'].includes(i.rarity)), 'shard-shop items use normal rarities');
ok(!def.sources.includes('shop') && !def.sources.includes('shard_shop') && !(def.price > 0) && !def.shardPrice && !def.exclusive, 'not in orb shop or shard shop');
// new account
const fresh = { balance: 0, total: 0, inventory: INV.emptyInventory(), owned: G.DEFAULT_OWNED.slice(), equipped: Object.assign({}, G.DEFAULT_EQUIPPED), stats: {}, createdAt: Date.now() };
INV.migrateAccount(fresh); ok(n(fresh) === 1 && fresh.owned.includes(ID) && fresh.equipped.hat === 'h_none', 'new account gets the cap (not equipped)');
INV.migrateAccount(fresh); INV.migrateAccount(fresh); ok(n(fresh) === 1, 'new account: still exactly one after re-login');
// existing (legacy) account with items
const old = { balance: 500, total: 9000, owned: ['h_cap', 'c_void'], equipped: { hat: 'h_cap' }, stats: { upgradeRefundV1: true }, upgrades: {}, createdAt: 1 };
INV.migrateAccount(old); ok(n(old) === 1 && INV.hasItem(old, 'h_cap') && INV.hasItem(old, 'c_void') && old.equipped.hat === 'h_cap', 'existing account gets the cap once, keeps items + equipped hat');
INV.migrateAccount(old); ok(n(old) === 1, 'existing account: no duplicate');
// removed afterwards → not re-granted
INV.removeItem(old, ID, 1, INV.REMOVE_REASONS[0]); INV.migrateAccount(old); ok(n(old) === 0, 'not re-granted after removal (grant once)');
console.log(f ? `${f} FAILED` : 'ALL PASS'); process.exit(f ? 1 : 0);
