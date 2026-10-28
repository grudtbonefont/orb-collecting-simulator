'use strict';
// Player-to-player trades. Server-authoritative: clients send intents only.
// Final swap runs in ONE store.commitTrade transaction (Postgres: SELECT … FOR UPDATE).
const crypto = require('crypto');
const G = require('../public/shared.js');
const INV = require('./inventory');

const emptyOffer = () => ({ items: [], orbs: 0, shards: 0 });
const cloneOffer = o => ({ items: (o.items || []).map(x => ({ id: x.id, qty: x.qty })), orbs: o.orbs | 0, shards: o.shards | 0 });

function offerUnits(offer) {
  let n = 0;
  for (const it of offer.items || []) {
    const d = INV.itemDef(it.id);
    if (!d || d.stackable) n += it.qty | 0;
    else n += 1;
  }
  return n;
}

function validateOfferShape(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Неверное предложение' };
  const orbs = Number(raw.orbs), shards = Number(raw.shards);
  if (!Number.isFinite(orbs) || !Number.isInteger(orbs) || orbs < 0 || orbs > G.TRADE.maxOrbs) return { ok: false, error: 'Неверное число сфер' };
  if (!Number.isFinite(shards) || !Number.isInteger(shards) || shards < 0 || shards > G.TRADE.maxShards) return { ok: false, error: 'Неверное число осколков' };
  if (!Array.isArray(raw.items)) return { ok: false, error: 'Неверный список предметов' };
  if (raw.items.length > G.TRADE.maxItems) return { ok: false, error: `Не больше ${G.TRADE.maxItems} позиций` };
  const items = [], seen = new Set();
  for (const x of raw.items) {
    if (!x || typeof x !== 'object') return { ok: false, error: 'Неверный предмет' };
    const id = typeof x.id === 'string' ? x.id : '';
    const def = INV.itemDef(id);
    if (!def || !G.isTradeable(def)) return { ok: false, error: 'Этот предмет нельзя обменять' };
    const qty = Number(x.qty);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > 9999) return { ok: false, error: 'Неверное количество' };
    if (!def.stackable && qty !== 1) return { ok: false, error: 'Неверное количество' };
    if (seen.has(id)) return { ok: false, error: 'Дубликат предмета в предложении' };
    seen.add(id);
    items.push({ id, qty });
  }
  return { ok: true, offer: { items, orbs, shards } };
}

function verifyOwnership(acc, offer) {
  if ((acc.balance || 0) < offer.orbs) return { ok: false, error: 'Недостаточно сфер' };
  if (((acc.stats && acc.stats.shards) || 0) < offer.shards) return { ok: false, error: 'Недостаточно осколков' };
  for (const it of offer.items) {
    const def = INV.itemDef(it.id);
    if (!def || !G.isTradeable(def)) return { ok: false, error: 'Этот предмет нельзя обменять' };
    if (INV.countItem(acc, it.id) < it.qty) return { ok: false, error: `Не хватает: ${def.name}` };
  }
  return { ok: true };
}

// Can the receiver fit `incoming` after giving away `outgoing`?
function canReceive(acc, outgoing, incoming) {
  const freeNow = Math.max(0, G.INV_CAP - INV.unitsUsed(acc));
  const freed = offerUnits(outgoing);
  const need = offerUnits(incoming);
  // Unique cosmetics already owned by receiver (and not being given away) cannot be received again
  for (const it of incoming.items) {
    const def = INV.itemDef(it.id);
    if (!def) return { ok: false, error: 'Нет такого предмета' };
    if (!def.stackable) {
      const giving = outgoing.items.some(x => x.id === it.id);
      if (INV.hasItem(acc, it.id) && !giving) return { ok: false, error: `У получателя уже есть «${def.name}»` };
    }
  }
  if (need > freeNow + freed) return { ok: false, error: `Инвентарь полон (${INV.unitsUsed(acc)} / ${G.INV_CAP})` };
  return { ok: true };
}

function applySwap(a, b, aOffer, bOffer) {
  const va = verifyOwnership(a, aOffer); if (!va.ok) return va;
  const vb = verifyOwnership(b, bOffer); if (!vb.ok) return vb;
  const ra = canReceive(a, aOffer, bOffer); if (!ra.ok) return { ok: false, error: `Сторона A: ${ra.error}` };
  const rb = canReceive(b, bOffer, aOffer); if (!rb.ok) return { ok: false, error: `Сторона B: ${rb.error}` };

  // Take from A
  if (aOffer.orbs) a.balance -= aOffer.orbs;
  if (aOffer.shards) { if (!INV.spendShards(a, aOffer.shards)) return { ok: false, error: 'Осколки A' }; }
  for (const it of aOffer.items) {
    const r = INV.removeItem(a, it.id, it.qty, 'trade');
    if (!r.ok) return { ok: false, error: r.error || 'Снятие A' };
  }
  // Take from B
  if (bOffer.orbs) b.balance -= bOffer.orbs;
  if (bOffer.shards) { if (!INV.spendShards(b, bOffer.shards)) return { ok: false, error: 'Осколки B' }; }
  for (const it of bOffer.items) {
    const r = INV.removeItem(b, it.id, it.qty, 'trade');
    if (!r.ok) return { ok: false, error: r.error || 'Снятие B' };
  }
  // Give to B (A's offer)
  if (aOffer.orbs) { b.balance += aOffer.orbs; /* balance only, not all-time total */ }
  if (aOffer.shards) INV.addShards(b, aOffer.shards);
  for (const it of aOffer.items) {
    const g = INV.grantItem(b, it.id, it.qty, 'trade');
    if (!g.ok) return { ok: false, error: g.error || 'Выдача B' };
  }
  // Give to A (B's offer)
  if (bOffer.orbs) a.balance += bOffer.orbs;
  if (bOffer.shards) INV.addShards(a, bOffer.shards);
  for (const it of bOffer.items) {
    const g = INV.grantItem(a, it.id, it.qty, 'trade');
    if (!g.ok) return { ok: false, error: g.error || 'Выдача A' };
  }
  a.lastSeen = Date.now(); b.lastSeen = Date.now();
  return { ok: true };
}

// How many of `id` are locked in the player's current offer?
function lockedQty(offer, id) {
  if (!offer) return 0;
  if (id === '__orbs') return offer.orbs | 0;
  if (id === '__shards') return offer.shards | 0;
  const it = (offer.items || []).find(x => x.id === id);
  return it ? it.qty : 0;
}

function createTradeSystem(ctx) {
  // ctx: { store, profiles, byKey, players, markDirty, flush, flushSoon, emitProfile, accountChanged, systemChat }
  const trades = new Map();       // tradeId -> trade
  const byAcc = new Map();        // accountKey -> tradeId
  const requests = new Map();     // reqId -> request
  const reqByTarget = new Map();  // targetKey -> reqId (one incoming at a time for UX)
  const reqRate = new Map();      // key -> { at, n, last }
  const committing = new Set();   // account keys locked during commit

  function partnerOf(t, key) { return t.aKey === key ? t.bKey : t.aKey; }
  function sideOf(t, key) { return t.aKey === key ? 'a' : 'b'; }
  function plOf(key) { return ctx.byKey.get(key) || null; }
  function socketOf(key) { const p = plOf(key); return p ? p.socket : null; }

  function publicState(t, forKey) {
    const me = sideOf(t, forKey), them = me === 'a' ? 'b' : 'a';
    return {
      id: t.id,
      state: t.state,
      you: me,
      partner: { name: them === 'a' ? t.aName : t.bName, id: them === 'a' ? t.aPid : t.bPid },
      myOffer: cloneOffer(me === 'a' ? t.aOffer : t.bOffer),
      theirOffer: cloneOffer(them === 'a' ? t.aOffer : t.bOffer),
      myReady: me === 'a' ? t.aReady : t.bReady,
      theirReady: them === 'a' ? t.aReady : t.bReady,
      myConfirm: me === 'a' ? t.aConfirm : t.bConfirm,
      theirConfirm: them === 'a' ? t.aConfirm : t.bConfirm,
      countdownMs: t.countdownAt ? Math.max(0, t.countdownAt + G.TRADE.countdownMs - Date.now()) : 0,
      countdownAt: t.countdownAt || 0,
    };
  }

  function emitState(t) {
    for (const key of [t.aKey, t.bKey]) {
      const s = socketOf(key);
      if (s) s.emit('trade:state', publicState(t, key));
    }
  }

  function clearCountdown(t) {
    if (t._cdTimer) { clearTimeout(t._cdTimer); t._cdTimer = null; }
    t.countdownAt = 0;
  }

  function resetReady(t) {
    t.aReady = false; t.bReady = false; t.aConfirm = false; t.bConfirm = false;
    clearCountdown(t);
    if (t.state === 'countdown') t.state = 'open';
  }

  function cancelTrade(t, reason, notify = true) {
    if (!t || t.state === 'done' || t.state === 'cancelled' || t.state === 'committing') return;
    clearCountdown(t);
    t.state = 'cancelled';
    trades.delete(t.id);
    byAcc.delete(t.aKey); byAcc.delete(t.bKey);
    if (notify) {
      for (const key of [t.aKey, t.bKey]) {
        const s = socketOf(key);
        if (s) s.emit('trade:cancel', { id: t.id, reason: reason || 'Обмен отменён' });
      }
    }
  }

  function cancelRequest(req, reason) {
    if (!req || req.done) return;
    req.done = true;
    if (req._timer) clearTimeout(req._timer);
    requests.delete(req.id);
    if (reqByTarget.get(req.toKey) === req.id) reqByTarget.delete(req.toKey);
    const toS = socketOf(req.toKey), fromS = socketOf(req.fromKey);
    if (toS) toS.emit('trade:reqGone', { id: req.id, reason });
    if (fromS) fromS.emit('trade:reqGone', { id: req.id, reason });
  }

  function onLeave(pl) {
    if (!pl || !pl.acc) return;
    const key = pl.acc.key;
    const tid = byAcc.get(key);
    if (tid) {
      const t = trades.get(tid);
      if (t) cancelTrade(t, `${pl.acc.name} вышел(ла) из игры`);
    }
    for (const req of Array.from(requests.values())) {
      if (req.fromKey === key || req.toKey === key) cancelRequest(req, 'Игрок вышел');
    }
  }

  // Block spending/trashing below locked offer amounts, and block all mutations while committing
  function mutationGuard(acc, kind, id, qty) {
    if (!acc) return null;
    if (committing.has(acc.key)) return { ok: false, error: 'Идёт обмен — подождите' };
    const tid = byAcc.get(acc.key);
    if (!tid) return null;
    const t = trades.get(tid);
    if (!t || t.state === 'done' || t.state === 'cancelled') return null;
    const offer = sideOf(t, acc.key) === 'a' ? t.aOffer : t.bOffer;
    if (kind === 'orbs') {
      const left = (acc.balance || 0) - lockedQty(offer, '__orbs');
      if (qty > left) return { ok: false, error: 'Сферы участвуют в обмене' };
    } else if (kind === 'shards') {
      const left = ((acc.stats && acc.stats.shards) || 0) - lockedQty(offer, '__shards');
      if (qty > left) return { ok: false, error: 'Осколки участвуют в обмене' };
    } else if (kind === 'item') {
      const have = INV.countItem(acc, id), lock = lockedQty(offer, id);
      if (qty > have - lock) return { ok: false, error: 'Предмет участвует в обмене' };
    }
    return null;
  }

  function takeRate(key) {
    const now = Date.now();
    let e = reqRate.get(key);
    if (!e || now - e.at > G.TRADE.reqWindowMs) e = { at: now, n: 0, last: 0 };
    if (now - e.last < G.TRADE.reqGapMs) return { ok: false, error: 'Подождите немного…' };
    if (e.n >= G.TRADE.reqWindowMax) return { ok: false, error: 'Слишком много запросов на обмен' };
    e.n++; e.last = now; reqRate.set(key, e);
    return { ok: true };
  }

  function requestTrade(fromPl, toId) {
    if (!G.TRADING_ENABLED) return { ok: false, error: 'Обмен временно отключён' };
    if (!fromPl || !fromPl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    if (byAcc.has(fromPl.acc.key) || committing.has(fromPl.acc.key)) return { ok: false, error: 'Вы уже в обмене' };
    const toPl = ctx.players.get(toId);
    if (!toPl || !toPl.acc) return { ok: false, error: 'Игрок не в сети' };
    if (toPl.acc.key === fromPl.acc.key) return { ok: false, error: 'Нельзя обмениваться с собой' };
    if (byAcc.has(toPl.acc.key) || committing.has(toPl.acc.key)) return { ok: false, error: 'Игрок уже в обмене' };
    if (reqByTarget.has(toPl.acc.key)) return { ok: false, error: 'У игрока уже есть запрос на обмен' };
    // one outgoing pending
    for (const r of requests.values()) if (r.fromKey === fromPl.acc.key && !r.done) return { ok: false, error: 'Дождитесь ответа на предыдущий запрос' };
    const rate = takeRate(fromPl.acc.key); if (!rate.ok) return rate;

    const id = crypto.randomBytes(8).toString('hex');
    const req = {
      id, fromKey: fromPl.acc.key, toKey: toPl.acc.key,
      fromName: fromPl.acc.name, toName: toPl.acc.name,
      fromPid: fromPl.id, toPid: toPl.id,
      at: Date.now(), done: false,
    };
    req._timer = setTimeout(() => cancelRequest(req, 'Время истекло'), G.TRADE.requestMs);
    requests.set(id, req);
    reqByTarget.set(toPl.acc.key, id);
    toPl.socket.emit('trade:req', { id, from: fromPl.acc.name, fromId: fromPl.id, ms: G.TRADE.requestMs });
    fromPl.socket.emit('trade:reqSent', { id, to: toPl.acc.name, toId: toPl.id, ms: G.TRADE.requestMs });
    return { ok: true, id };
  }

  function respondRequest(pl, reqId, accept) {
    if (!pl || !pl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    const req = requests.get(reqId);
    if (!req || req.done) return { ok: false, error: 'Запрос устарел' };
    if (req.toKey !== pl.acc.key) return { ok: false, error: 'Это не ваш запрос' };
    if (!accept) { cancelRequest(req, 'Отклонено'); const s = socketOf(req.fromKey); if (s) s.emit('trade:declined', { id: req.id, by: pl.acc.name }); return { ok: true, accepted: false }; }
    if (!G.TRADING_ENABLED) { cancelRequest(req, 'Обмен отключён'); return { ok: false, error: 'Обмен временно отключён' }; }
    const fromPl = plOf(req.fromKey);
    if (!fromPl) { cancelRequest(req, 'Игрок вышел'); return { ok: false, error: 'Игрок вышел' }; }
    if (byAcc.has(req.fromKey) || byAcc.has(req.toKey)) { cancelRequest(req, 'Уже в обмене'); return { ok: false, error: 'Уже в обмене' }; }

    req.done = true; if (req._timer) clearTimeout(req._timer);
    requests.delete(req.id); reqByTarget.delete(req.toKey);

    const id = crypto.randomBytes(8).toString('hex');
    const t = {
      id, state: 'open',
      aKey: req.fromKey, bKey: req.toKey,
      aName: req.fromName, bName: req.toName,
      aPid: fromPl.id, bPid: pl.id,
      aOffer: emptyOffer(), bOffer: emptyOffer(),
      aReady: false, bReady: false, aConfirm: false, bConfirm: false,
      countdownAt: 0, _cdTimer: null, commitOnce: false,
    };
    trades.set(id, t);
    byAcc.set(t.aKey, id); byAcc.set(t.bKey, id);
    emitState(t);
    return { ok: true, accepted: true, id };
  }

  function setOffer(pl, raw) {
    if (!pl || !pl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    const tid = byAcc.get(pl.acc.key); if (!tid) return { ok: false, error: 'Нет активного обмена' };
    const t = trades.get(tid); if (!t || t.state === 'committing' || t.state === 'done') return { ok: false, error: 'Обмен недоступен' };
    const shaped = validateOfferShape(raw); if (!shaped.ok) return shaped;
    const own = verifyOwnership(pl.acc, shaped.offer); if (!own.ok) return own;
    if (sideOf(t, pl.acc.key) === 'a') t.aOffer = shaped.offer; else t.bOffer = shaped.offer;
    resetReady(t);
    emitState(t);
    return { ok: true };
  }

  function setReady(pl, ready) {
    if (!pl || !pl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    const tid = byAcc.get(pl.acc.key); if (!tid) return { ok: false, error: 'Нет активного обмена' };
    const t = trades.get(tid); if (!t || (t.state !== 'open' && t.state !== 'countdown')) return { ok: false, error: 'Обмен недоступен' };
    const offer = sideOf(t, pl.acc.key) === 'a' ? t.aOffer : t.bOffer;
    if (ready) {
      const own = verifyOwnership(pl.acc, offer); if (!own.ok) return own;
    }
    if (sideOf(t, pl.acc.key) === 'a') { t.aReady = !!ready; if (!ready) { t.aConfirm = false; t.bConfirm = false; clearCountdown(t); t.state = 'open'; } }
    else { t.bReady = !!ready; if (!ready) { t.aConfirm = false; t.bConfirm = false; clearCountdown(t); t.state = 'open'; } }
    // unready partner confirm when one unreadies
    if (!ready) { t.aConfirm = false; t.bConfirm = false; }
    emitState(t);
    return { ok: true };
  }

  function setConfirm(pl, confirm) {
    if (!pl || !pl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    const tid = byAcc.get(pl.acc.key); if (!tid) return { ok: false, error: 'Нет активного обмена' };
    const t = trades.get(tid); if (!t || (t.state !== 'open' && t.state !== 'countdown')) return { ok: false, error: 'Обмен недоступен' };
    if (!t.aReady || !t.bReady) return { ok: false, error: 'Оба игрока должны нажать «Готов»' };
    const offer = sideOf(t, pl.acc.key) === 'a' ? t.aOffer : t.bOffer;
    if (confirm) {
      const own = verifyOwnership(pl.acc, offer); if (!own.ok) return own;
    }
    if (sideOf(t, pl.acc.key) === 'a') t.aConfirm = !!confirm; else t.bConfirm = !!confirm;
    if (!confirm) { clearCountdown(t); t.state = 'open'; emitState(t); return { ok: true }; }
    if (t.aConfirm && t.bConfirm) {
      if (t._cdTimer) { clearTimeout(t._cdTimer); t._cdTimer = null; }
      t.state = 'countdown';
      t.countdownAt = Date.now();
      t._cdTimer = setTimeout(() => { finalize(t).catch(e => console.error('[trade] finalize', e.message)); }, G.TRADE.countdownMs);
      emitState(t);
    } else emitState(t);
    return { ok: true };
  }

  function syncLive(live, from) {
    if (!live || !from) return;
    live.balance = from.balance; live.total = from.total;
    live.inventory = from.inventory; live.owned = from.owned; live.equipped = from.equipped;
    live.upgrades = from.upgrades; live.stats = from.stats; live.codes = from.codes;
    live.lastSeen = from.lastSeen;
  }

  async function finalize(t) {
    if (!t || t.commitOnce || t.state === 'done' || t.state === 'cancelled') return;
    if (!(t.aConfirm && t.bConfirm)) return;
    t.commitOnce = true; // idempotent
    clearCountdown(t);
    t.state = 'committing';
    committing.add(t.aKey); committing.add(t.bKey);
    emitState(t);

    const aOffer = cloneOffer(t.aOffer), bOffer = cloneOffer(t.bOffer);
    const empty = !aOffer.orbs && !aOffer.shards && !aOffer.items.length && !bOffer.orbs && !bOffer.shards && !bOffer.items.length;
    if (empty) {
      committing.delete(t.aKey); committing.delete(t.bKey);
      cancelTrade(t, 'Пустой обмен');
      return;
    }

    // Push live memory to DB so FOR UPDATE sees current inventories
    const liveA = ctx.profiles.get(t.aKey), liveB = ctx.profiles.get(t.bKey);
    if (liveA) ctx.markDirty(liveA);
    if (liveB) ctx.markDirty(liveB);
    try { await ctx.flush(); } catch (e) {
      committing.delete(t.aKey); committing.delete(t.bKey);
      t.commitOnce = false; t.state = 'open'; t.aConfirm = false; t.bConfirm = false;
      emitState(t);
      for (const key of [t.aKey, t.bKey]) { const s = socketOf(key); if (s) s.emit('trade:fail', { id: t.id, error: 'Ошибка сохранения, попробуйте снова' }); }
      return;
    }

    const audit = {
      id: t.id, aKey: t.aKey, bKey: t.bKey, aName: t.aName, bName: t.bName,
      aOffer, bOffer, createdAt: Date.now(),
    };

    let result;
    try {
      result = await ctx.store.commitTrade(t.aKey, t.bKey, (a, b) => applySwap(a, b, aOffer, bOffer), audit);
    } catch (e) {
      console.error('[trade] commit failed', e.message);
      result = { ok: false, error: 'Ошибка сервера' };
    }

    committing.delete(t.aKey); committing.delete(t.bKey);

    if (result && result.code === 'already') {
      // Idempotent success path
      t.state = 'done';
      trades.delete(t.id); byAcc.delete(t.aKey); byAcc.delete(t.bKey);
      return;
    }

    if (!result || !result.ok) {
      const err = (result && result.error) || 'Обмен не удался';
      const aHere = !!plOf(t.aKey), bHere = !!plOf(t.bKey);
      if (!aHere || !bHere) {
        t.state = 'cancelled';
        trades.delete(t.id); byAcc.delete(t.aKey); byAcc.delete(t.bKey);
        for (const key of [t.aKey, t.bKey]) { const s = socketOf(key); if (s) s.emit('trade:fail', { id: t.id, error: err }); }
        return;
      }
      t.commitOnce = false; t.state = 'open'; t.aConfirm = false; t.bConfirm = false; t.aReady = false; t.bReady = false;
      emitState(t);
      for (const key of [t.aKey, t.bKey]) { const s = socketOf(key); if (s) s.emit('trade:fail', { id: t.id, error: err }); }
      return;
    }

    // Achievement counter: completed trades (synced onto live via syncLive below)
    for (const acc of [result.a, result.b]) {
      if (!acc.stats) acc.stats = {};
      acc.stats.tradesDone = (acc.stats.tradesDone || 0) + 1;
    }

    // Sync live account objects in place (keep pl.acc identity)
    if (liveA) syncLive(liveA, result.a);
    if (liveB) syncLive(liveB, result.b);
    // Ensure profiles map points at live objects
    if (liveA) ctx.profiles.set(t.aKey, liveA);
    else ctx.profiles.set(t.aKey, result.a);
    if (liveB) ctx.profiles.set(t.bKey, liveB);
    else ctx.profiles.set(t.bKey, result.b);

    t.state = 'done';
    trades.delete(t.id); byAcc.delete(t.aKey); byAcc.delete(t.bKey);

    for (const key of [t.aKey, t.bKey]) {
      const acc = ctx.profiles.get(key);
      if (acc) {
        ctx.markDirty(acc); // already persisted, but keep cache coherent
        ctx.accountChanged(acc, { looks: true });
        const s = socketOf(key);
        if (s) s.emit('trade:done', { id: t.id, profile: null }); // client refetches via profile event
      }
    }
    ctx.systemChat(`🤝 ${t.aName} и ${t.bName} совершили обмен`);
  }

  function cancelByPlayer(pl) {
    if (!pl || !pl.acc) return { ok: false, error: 'Сначала войдите в аккаунт' };
    const tid = byAcc.get(pl.acc.key);
    if (!tid) {
      for (const req of Array.from(requests.values())) {
        if (req.fromKey === pl.acc.key && !req.done) { cancelRequest(req, 'Отменено'); return { ok: true }; }
      }
      return { ok: false, error: 'Нет активного обмена' };
    }
    const t = trades.get(tid);
    if (!t) return { ok: false, error: 'Нет активного обмена' };
    if (t.state === 'committing') return { ok: false, error: 'Обмен уже выполняется' };
    cancelTrade(t, `${pl.acc.name} отменил(а) обмен`);
    return { ok: true };
  }

  return {
    requestTrade, respondRequest, setOffer, setReady, setConfirm, cancelByPlayer,
    // Socket-handler aliases (tradeId ignored — binding is by account key)
    request: requestTrade,
    respond: respondRequest,
    setOffer: (pl, _tradeId, offer) => setOffer(pl, offer),
    setReady: (pl, _tradeId, ready) => setReady(pl, ready),
    setConfirm: (pl, _tradeId, confirm) => setConfirm(pl, confirm),
    cancel: (pl, _tradeId) => cancelByPlayer(pl),
    onLeave, mutationGuard, publicState,
    _trades: trades, _requests: requests, // for tests
  };
}

module.exports = { createTradeSystem, validateOfferShape, verifyOwnership, canReceive, applySwap, offerUnits, emptyOffer, cloneOffer, isTradeable: G.isTradeable };
