'use strict';
// Daily rewards calendar (server-authoritative). State: acc.stats.cal = { n: claims so far, day: dayKey of the last claim }.
const G = require('../public/shared.js'), C = require('../public/content.js'), INV = require('./inventory');
const LEN = C.CALENDAR.length;
function calState(acc, now = Date.now()) {
  const c = (acc.stats && acc.stats.cal) || {}, n = Math.max(0, Math.floor(Number(c.n) || 0)), today = C.dayKey(now);
  return { n, idx: n % LEN, cycle: Math.floor(n / LEN), canClaim: c.day !== today, resetIn: C.resetIn(now), len: LEN };
}
function claimDaily(acc, now = Date.now()) {
  const s = calState(acc, now);
  if (!s.canClaim) return { ok: false, error: 'Награда за сегодня уже получена. Возвращайтесь завтра!', code: 'claimed', state: s };
  const rw = C.CALENDAR[s.idx], out = { day: s.idx + 1 };
  if (rw.orbs) { acc.balance = (Number(acc.balance) || 0) + rw.orbs; acc.total = (Number(acc.total) || 0) + rw.orbs; out.orbs = rw.orbs; }
  let shards = rw.shards || 0;
  if (rw.item) {
    if (INV.hasItem(acc, rw.item)) { shards += rw.dup || 0; out.dup = rw.item; }
    else { const g = INV.grantItem(acc, rw.item, 1, 'daily'); if (g.ok) out.item = rw.item; else { shards += rw.dup || 0; out.dup = rw.item; } }
  }
  if (shards) out.shards = INV.addShards(acc, shards);
  for (const id of rw.potions || []) { // stacks like any potion; no room → queued like quest potions (delivered when there is space)
    const g = INV.grantItem(acc, id, 1, 'daily');
    if (g.ok) (out.potions = out.potions || []).push(id);
    else { const q = acc.stats.pendingPotions = Array.isArray(acc.stats.pendingPotions) ? acc.stats.pendingPotions : []; if (q.length < 10) { q.push(id); (out.pending = out.pending || []).push(id); } }
  }
  acc.stats.cal = { n: s.n + 1, day: C.dayKey(now) };
  return { ok: true, reward: out, state: calState(acc, now) };
}
module.exports = { calState, claimDaily, LEN };
