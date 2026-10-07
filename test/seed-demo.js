// Writes demo profiles with cosmetics into data/players.json (run while server is stopped)
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const h = t => crypto.createHash('sha256').update(t).digest('hex');
const G = require('../public/shared.js');
const all = G.ITEMS.map(i => i.id);
const mk = (name, token, eq, extra = {}) => ({ name, tokenHash: h(token), balance: 120, total: 120, owned: all, equipped: Object.assign({}, G.DEFAULT_EQUIPPED, eq), upgrades: { magnet: 2, speed: 1 }, stats: { minigames: 0, bestReaction: null, bestRush: 0 }, createdAt: Date.now(), lastSeen: Date.now(), ...extra });
const db = { players: {} };
const add = p => db.players[p.name.toLowerCase()] = p;
add(mk('Демо', 'demo-main-token-xxxxxxxxxxxx', { color: 'c_rainbow', shape: 's_star', trail: 't_fire', nameColor: 'n_gold', hat: 'h_crown' }));
add(mk('Комета', 'demo-bot-token-0-xxxxxxxx', { color: 'c_pink', shape: 's_hexagon', trail: 't_neon', nameColor: 'n_pink', hat: 'h_halo' }));
add(mk('Звездочёт', 'demo-bot-token-1-xxxxxxxx', { color: 'c_lime', shape: 's_square', trail: 't_sparks', hat: 'h_tophat' }));
add(mk('Nova', 'demo-bot-token-2-xxxxxxxx', { color: 'c_gold', shape: 's_triangle', nameColor: 'n_rainbow', hat: 'h_cap' }));
fs.writeFileSync(path.join(__dirname, '..', 'data', 'players.json'), JSON.stringify(db));
console.log('seeded');
