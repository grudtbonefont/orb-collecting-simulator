// Writes demo accounts (with cosmetics) into a JSON data file: node test/seed-demo.js [file]
// All demo accounts use the password "demo-pass-123". Run while the server using that file is stopped.
const fs = require('fs'), path = require('path'), bcrypt = require('bcryptjs');
const G = require('../public/shared.js');
const file = process.argv[2] || process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'accounts.json');
const all = G.ITEMS.map(i => i.id);
const hash = bcrypt.hashSync('demo-pass-123', 10);
const mk = (name, total, eq) => ({ key: name.toLowerCase(), name, passHash: hash, balance: 120, total, owned: all,
  equipped: Object.assign({}, G.DEFAULT_EQUIPPED, eq), upgrades: { magnet: 2, speed: 1 }, stats: { minigames: 0, bestReaction: null, bestRush: 0 },
  createdAt: Date.now(), lastSeen: Date.now() });
const accounts = [
  mk('Demo', 1840, { color: 'c_rainbow', shape: 's_star', trail: 't_fire', nameColor: 'n_gold', hat: 'h_crown' }),
  mk('Kometa', 1325, { color: 'c_pink', shape: 's_hexagon', trail: 't_neon', nameColor: 'n_pink', hat: 'h_halo' }),
  mk('StarGazer', 990, { color: 'c_lime', shape: 's_square', trail: 't_sparks', hat: 'h_tophat' }),
  mk('Nova_7', 760, { color: 'c_gold', shape: 's_triangle', nameColor: 'n_rainbow', hat: 'h_cap' }),
  mk('Mobile_Max', 420, { color: 'c_violet', nameColor: 'n_pink', hat: 'h_cap' }),
];
const data = { version: 2, accounts: {}, sessions: {} };
for (const a of accounts) data.accounts[a.key] = a;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(data));
console.log('seeded ' + accounts.length + ' demo accounts into ' + file);
