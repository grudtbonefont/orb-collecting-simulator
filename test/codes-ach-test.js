// «Охотник за кодами»: progress = distinct redeemed codes (all sources), no Oct-2026 baseline, retroactive. Run: node test/codes-ach-test.js
const C = require('../public/content.js'); const CODES = require('../lib/codes.js');
let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const tiers = C.ACH.filter(a => a.chain === 'codes');
const prof = (codes, base) => ({ total: 0, stats: { achBase: base || {} }, codesUsed: new Set(codes.map(c => String(c).trim().toUpperCase())).size, items: 0, liveMs: 0 });
const all = CODES.CODES.map(c => CODES.norm(c.code));
ok(tiers.length === 3 && tiers.every(t => t.goal <= all.length), 'tiers achievable with built-in codes: ' + tiers.map(t => t.goal) + ' / ' + all.length);
// account that had all codes before the reset (baseline 10) must still complete every tier
ok(tiers.every(t => C.achValue(t, prof(all, { codes: all.length })) >= t.goal), 'baseline ignored: all tiers done with all codes');
ok(C.achValue(tiers[0], prof([], { codes: 10 })) === 0, 'no codes → 0');
ok(C.achValue(tiers[1], prof(['SHARDY', 'shardy', ' SHARDY ', 'TREASURE'])) === 2, 'duplicates not double counted');
ok(C.achValue(tiers[0], prof(['MYADMINCODE'])) === 1, 'admin DB code counts');
process.exit(f ? 1 : 0);
