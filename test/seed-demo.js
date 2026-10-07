// Writes demo accounts (cosmetics in the inventory) into a JSON data file: node test/seed-demo.js [file]
// All demo accounts use the password "demo-pass-123". Run while the server using that file is stopped.
const fs = require('fs'), path = require('path'), bcrypt = require('bcryptjs');
const G = require('../public/shared.js');
const INV = require('../lib/inventory');
const file = process.argv[2] || process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'accounts.json');
const hash = bcrypt.hashSync('demo-pass-123', 10);
const DAY = 86400000, now = Date.now();
const mk = (name, total, balance, items, eq, extra = {}) => {
  const a = { key: name.toLowerCase(), name, passHash: hash, balance, total, inventory: INV.emptyInventory(),
    equipped: Object.assign({}, G.DEFAULT_EQUIPPED, eq), upgrades: { magnet: 2, speed: 1 },
    stats: Object.assign({ minigames: 0, bestReaction: null, bestRush: 0, sessions: 3, playMs: 40 * 60000 }, extra.stats),
    createdAt: now - (extra.days || 5) * DAY, lastSeen: now };
  for (const id of items) INV.grantItem(a, id, 1, 'shop');
  if (extra.shards) INV.grantItem(a, 'x_legend_shard', extra.shards, 'arena');
  INV.migrateAccount(a); // fills the legacy `owned` list too
  return a;
};
const accounts = [
  mk('Demo', 48210, 2450,
    ['c_coral', 'c_lime', 'c_pink', 'c_rainbow', 's_square', 's_triangle', 's_star', 't_sparks', 't_fire', 'n_pink', 'n_gold', 'h_cap', 'h_tophat', 'h_crown'],
    { color: 'c_rainbow', shape: 's_star', trail: 't_fire', nameColor: 'n_gold', hat: 'h_crown' },
    { days: 34, shards: 3, stats: { minigames: 41, bestReaction: 231, bestRush: 34, sessions: 27, playMs: (11 * 60 + 25) * 60000 } }),
  mk('Kometa', 31325, 800, ['c_pink', 's_hexagon', 't_neon', 'n_pink', 'h_halo'], { color: 'c_pink', shape: 's_hexagon', trail: 't_neon', nameColor: 'n_pink', hat: 'h_halo' }),
  mk('StarGazer', 12990, 300, ['c_lime', 's_square', 't_sparks', 'h_tophat'], { color: 'c_lime', shape: 's_square', trail: 't_sparks', hat: 'h_tophat' }),
  mk('Nova_7', 9760, 150, ['c_gold', 's_triangle', 'n_rainbow', 'h_cap'], { color: 'c_gold', shape: 's_triangle', nameColor: 'n_rainbow', hat: 'h_cap' }),
  mk('Mobile_Max', 4420, 900, ['c_violet', 'n_pink', 'h_cap', 's_square'], { color: 'c_violet', nameColor: 'n_pink', hat: 'h_cap' },
    { days: 9, shards: 1, stats: { minigames: 6, bestReaction: 287, bestRush: 22, sessions: 8, playMs: 3 * 3600000 } }),
];
const data = { version: 2, accounts: {}, sessions: {} };
for (const a of accounts) data.accounts[a.key] = a;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data));
console.log('seeded ' + accounts.length + ' demo accounts into ' + file);
