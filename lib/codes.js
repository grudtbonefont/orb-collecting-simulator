'use strict';
// Promo codes (redeemed in the shop tab «Коды»). Edit this list and redeploy to add / remove a code.
// Format of one entry:
//   {
//     code: 'WELCOME2026',                    // matched case-insensitively, surrounding spaces ignored
//     rewards: {
//       orbs: 500,                            // optional: added to the balance (NOT to the all-time total / leaderboard)
//       shards: 3,                            // optional: legendary shards (go into the inventory)
//       items: [{ id: 'c_lime', qty: 2 }],    // optional: item ids from public/shared.js ITEMS
//     },
//     expiresAt: '2026-12-31T23:59:59Z',      // ISO date or null (never expires)
//     maxUses: 1000,                          // total redemptions across all accounts, or null (unlimited)
//   }
// Every account can redeem each code once. Item + shard rewards must fit into the 450-unit inventory, otherwise nothing is given.
const CODES = [
];

// test-only codes (exist only when OCS_TEST_HOOKS=1, never in production)
if (process.env.OCS_TEST_HOOKS === '1') {
  CODES.push(
    { code: 'TEST-GIFT', rewards: { orbs: 250, shards: 2, items: [{ id: 'c_lime', qty: 3 }] }, expiresAt: null, maxUses: null },
    { code: 'TEST-OLD', rewards: { orbs: 1 }, expiresAt: '2020-01-01T00:00:00Z', maxUses: null },
    { code: 'TEST-ONCE', rewards: { orbs: 7 }, expiresAt: null, maxUses: 1 },
  );
}

const norm = s => (typeof s === 'string' ? s.trim().toUpperCase() : '');
const BY_CODE = new Map(CODES.map(c => [norm(c.code), c]));
const findCode = input => { const k = norm(input); return k && k.length <= 64 ? BY_CODE.get(k) || null : null; };
const isExpired = (c, now = Date.now()) => !!c.expiresAt && Date.parse(c.expiresAt) <= now;

module.exports = { CODES, norm, findCode, isExpired };
