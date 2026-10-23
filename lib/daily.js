'use strict';
// Daily rewards calendar (server-authoritative). State: acc.stats.cal = { n: claims so far, day: dayKey of the last claim }.
const G = require('../public/shared.js'), C = require('../public/content.js'), INV = require('./inventory');
const LEN = C.CALENDAR.length, SKIP_COST = 50;
function calState(acc, now = Date.now()) {
  const c = (acc.stats && acc.stats.cal) || {}, n = Math.max(0, Math.floor(Number(c.n) || 0)), today = C.dayKey(now);
  const canClaim = c.day !== today;
  return { n, idx: n % LEN, cycle: Math.floor(n / LEN), canClaim, canSkip: !canClaim && c.skip !== today, skipCost: SKIP_COST, resetIn: C.resetIn(now), len: LEN };
}
function claimDaily(acc, now = Date.now()) {
  const s = calState(acc, now);
  if (!s.canClaim) return { ok: false, error: 'Награда за сегодня уже получена. Возвращайтесь завтра!', code: 'claimed', state: s };
  const out = payDay(acc, s.idx);
  acc.stats.cal = { n: s.n + 1, day: C.dayKey(now) };
  return { ok: true, reward: out, state: calState(acc, now) };
}
// Paid skip: after today's free claim, once per MSK day, pay SKIP_COST shards to take the next day's reward now.
function skipDaily(acc, now = Date.now()) {
  const s = calState(acc, now), today = C.dayKey(now);
  if (s.canClaim) return { ok: false, error: 'Сначала заберите бесплатную награду за сегодня.', code: 'claim_first', state: s };
  if (!s.canSkip) return { ok: false, error: 'Пропуск уже использован сегодня. Возвращайтесь завтра!', code: 'skipped', state: s };
  if (!INV.spendShards(acc, SKIP_COST)) return { ok: false, error: `Недостаточно осколков: нужно ${SKIP_COST}, у вас ${acc.stats.shards || 0}.`, code: 'shards', state: s };
  const out = payDay(acc, s.idx); out.skip = true; out.cost = SKIP_COST;
  acc.stats.cal = { n: s.n + 1, day: today, skip: today };
  return { ok: true, reward: out, state: calState(acc, now) };
}
function payDay(acc, idx) {
  const rw = C.CALENDAR[idx], out = { day: idx + 1 };
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
  return out;
}
module.exports = { calState, claimDaily, skipDaily, LEN, SKIP_COST };
