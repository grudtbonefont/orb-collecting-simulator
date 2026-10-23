// random per-player daily/weekly quests. Run: node test/quest-random-test.js
const C = require('../public/content.js'); let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const FX = require('../lib/features.js')({ markDirty() {}, flushSoon() {}, emitProfile() {}, players: new Map(), io: { emit() {} } });
const mk = k => ({ key: k, name: k, inventory: { slots: [] }, stats: {} });
const ids = q => q.map(x => x.id).join(',');
const day = Date.UTC(2026, 9, 23, 12), D = 86400000;
ok(C.QUESTS.length >= 30 && [1, 2, 3].every(d => C.QUESTS.filter(q => q.diff === d).length >= 9), `daily pool ${C.QUESTS.length} (${[1, 2, 3].map(d => C.QUESTS.filter(q => q.diff === d).length).join('/')})`);
let diffPairs = 0; const sets = new Set();
for (let i = 0; i < 40; i++) { const a = mk('p' + i), b = mk('q' + i); if (ids(FX.ensureDaily(a, day).q) !== ids(FX.ensureDaily(b, day).q)) diffPairs++; sets.add(ids(a.stats.daily.q)); }
ok(diffPairs >= 36 && sets.size >= 25, `different players get different sets (${diffPairs}/40 pairs differ, ${sets.size} distinct)`);
const A = mk('alice'), s1 = ids(FX.ensureDaily(A, day).q); A.stats.daily.q[0].p = 5;
const A2 = mk('alice');
ok(ids(FX.ensureDaily(A, day + 3600e3).q) === s1 && A.stats.daily.q[0].p === 5 && ids(FX.ensureDaily(A2, day).q) === s1, 'same player: stable within the day, progress kept');
let changed = 0; for (let k = 1; k <= 30; k++) { const prev = ids(A.stats.daily.q); if (ids(FX.ensureDaily(A, day + k * D).q) !== prev) changed++; }
ok(changed === 30, `new day → new set (${changed}/30)`);
const W = FX.ensureWeekly(A, day), w1 = ids(W.q), wb = ids(FX.ensureWeekly(mk('bob'), day).q);
ok(W.q.length === 5 && ids(FX.ensureWeekly(A, day + D).q) === w1, 'weekly: 5 quests, stable within the week');
let wd = 0; for (let k = 1; k <= 10; k++) { const p = ids(A.stats.weekly.q); if (ids(FX.ensureWeekly(A, day + k * 7 * D).q) !== p) wd++; }
ok(wd === 10, `new week → new set (${wd}/10); players differ: ${w1 !== wb}`);
const old = mk('legacy'); old.stats.daily = { day: C.dayKey(day), q: [{ id: 'orbs300', p: 100, done: false, rw: { orbs: 80 } }], bonus: false };
ok(FX.ensureDaily(old, day).q[0].p === 100, 'existing current-day quests kept');
FX.rerollQuests(A, 'daily', day + 30 * D); FX.rerollQuests(A, 'weekly', day + 70 * D); ok(A.stats.daily.q.length === 3 && A.stats.weekly.q.length === 5, 'paid reroll still works');
console.log(f ? f + ' FAIL' : 'ALL PASS'); process.exit(f ? 1 : 0);
