'use strict';
// Inventory model + the single entry points for giving (grantItem) and taking away (removeItem) items.
// Stored compactly on the account: inventory = { v: 1, slots: [{ id, q, src, at }] }
//   id  - item id (see public/shared.js ITEMS), q - quantity in this slot (1..maxStack),
//   src - source that created the slot (shop | shard_shop | minigame | arena | event | admin | legacy), at - timestamp.
const G = require('../public/shared.js');

const SOURCES = ['shop', 'shard_shop', 'minigame', 'arena', 'event', 'admin', 'legacy'];
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const itemDef = id => (has(G.ITEM_BY_ID, id) ? G.ITEM_BY_ID[id] : null);
const emptyInventory = () => ({ v: 1, slots: [] });

// Old accounts (before inventories) only had `owned: [itemId...]`.
function inventoryFromOwned(owned, at) {
  const inv = emptyInventory();
  for (const id of new Set(Array.isArray(owned) ? owned : [])) {
    const d = itemDef(id);
    if (!d || d.base) continue;
    if (inv.slots.length >= G.INV_SLOTS) break;
    inv.slots.push({ id, q: 1, src: 'legacy', at: at || Date.now() });
  }
  return inv;
}

// Repairs anything malformed: unknown ids, bad quantities, duplicate uniques, too many slots.
function normalizeInventory(inv) {
  const out = emptyInventory();
  const seenUnique = new Set();
  const slots = inv && Array.isArray(inv.slots) ? inv.slots : [];
  for (const s of slots) {
    if (!s || typeof s !== 'object') continue;
    const d = itemDef(s.id);
    if (!d || d.base) continue;
    let q = Math.floor(Number(s.q));
    if (!Number.isFinite(q) || q < 1) continue;
    if (!d.stackable) { if (seenUnique.has(d.id)) continue; seenUnique.add(d.id); q = 1; }
    q = Math.min(q, d.maxStack);
    if (out.slots.length >= G.INV_SLOTS) break;
    out.slots.push({ id: d.id, q, src: SOURCES.includes(s.src) ? s.src : 'legacy', at: Number(s.at) || Date.now() });
  }
  return out;
}

const hasItem = (acc, id) => { const d = itemDef(id); return !!d && (d.base || acc.inventory.slots.some(s => s.id === id)); };
const countItem = (acc, id) => acc.inventory.slots.reduce((n, s) => n + (s.id === id ? s.q : 0), 0);
// Cosmetic ids the account may wear (base + inventory); also written to the legacy `owned` column for rollback safety.
function ownedCosmetics(acc) {
  const ids = G.DEFAULT_OWNED.slice();
  for (const s of acc.inventory.slots) { const d = itemDef(s.id); if (d && d.type === 'cosmetic' && !ids.includes(s.id)) ids.push(s.id); }
  return ids;
}

// Brings any stored account (old or new format) to the current shape. Returns true if something changed.
function migrateAccount(acc) {
  let changed = false;
  if (!acc.inventory || !Array.isArray(acc.inventory.slots)) { acc.inventory = inventoryFromOwned(acc.owned, acc.createdAt); changed = true; }
  else {
    const before = JSON.stringify(acc.inventory);
    acc.inventory = normalizeInventory(acc.inventory);
    if (JSON.stringify(acc.inventory) !== before) changed = true;
    // reconcile: a cosmetic listed in the legacy `owned` column (e.g. bought by an older build) but missing here is added back
    for (const id of new Set(Array.isArray(acc.owned) ? acc.owned : [])) {
      const d = itemDef(id);
      if (d && !d.base && d.type === 'cosmetic' && !hasItem(acc, id) && acc.inventory.slots.length < G.INV_SLOTS) {
        acc.inventory.slots.push({ id, q: 1, src: 'legacy', at: Date.now() }); changed = true;
      }
    }
  }
  const eq = Object.assign({}, G.DEFAULT_EQUIPPED, acc.equipped && typeof acc.equipped === 'object' ? acc.equipped : {});
  for (const cat of Object.keys(G.DEFAULT_EQUIPPED)) {
    const d = itemDef(eq[cat]);
    if (!d || d.cat !== cat || !hasItem(acc, eq[cat])) { eq[cat] = G.DEFAULT_EQUIPPED[cat]; changed = true; }
  }
  for (const k of Object.keys(eq)) if (!has(G.DEFAULT_EQUIPPED, k)) delete eq[k];
  acc.equipped = eq;
  acc.owned = ownedCosmetics(acc);
  // upgrades: every known key present, levels kept 1:1 on the new curves (same max levels), clamped to the max.
  // A level above the max (only possible if a future build shortens a curve) is refunded with that upgrade's last price.
  const oldUp = acc.upgrades && typeof acc.upgrades === 'object' ? acc.upgrades : {};
  const up = {};
  for (const k of G.UPGRADE_KEYS) {
    const raw = Math.max(0, Math.floor(Number(oldUp[k]) || 0)), u = G.UPGRADES[k];
    up[k] = Math.min(u.max, raw);
    if (raw > u.max) { acc.balance = (Number(acc.balance) || 0) + (raw - u.max) * u.prices[u.max - 1]; changed = true; }
    if (oldUp[k] !== up[k]) changed = true;
  }
  acc.upgrades = up;
  acc.stats = Object.assign({ minigames: 0, bestReaction: null, bestRush: 0, sessions: 0, playMs: 0, eventsPlayed: 0, eventWins: 0 }, acc.stats && typeof acc.stats === 'object' ? acc.stats : {});
  return changed;
}

// How many more units of `def` fit (existing stacks + free slots)?
function roomFor(acc, def) {
  const free = G.INV_SLOTS - acc.inventory.slots.length;
  if (!def.stackable) return hasItem(acc, def.id) ? 0 : Math.min(1, free);
  let room = free * def.maxStack;
  for (const s of acc.inventory.slots) if (s.id === def.id) room += def.maxStack - s.q;
  return room;
}

// THE way to give an item to a player (shop, mini-games, arena drops, events, admin). All-or-nothing.
function grantItem(acc, itemId, qty, source) {
  const def = itemDef(itemId);
  if (!def || def.base) return { ok: false, error: 'Нет такого предмета' };
  if (!SOURCES.includes(source)) return { ok: false, error: 'Неизвестный источник предмета' };
  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty < 1 || qty > 9999) return { ok: false, error: 'Неверное количество' };
  if (!def.stackable && hasItem(acc, def.id)) return { ok: false, error: 'Этот предмет уже есть в инвентаре', code: 'owned' };
  if (!def.stackable && qty !== 1) return { ok: false, error: 'Неверное количество' };
  if (roomFor(acc, def) < qty) return { ok: false, error: `Инвентарь полон (${G.INV_SLOTS} ячеек). Освободите место.`, code: 'full' };
  const now = Date.now();
  let left = qty;
  if (def.stackable) for (const s of acc.inventory.slots) {
    if (s.id !== def.id || s.q >= def.maxStack) continue;
    const add = Math.min(left, def.maxStack - s.q); s.q += add; left -= add;
    if (!left) break;
  }
  while (left > 0) { const add = Math.min(left, def.maxStack); acc.inventory.slots.push({ id: def.id, q: add, src: source, at: now }); left -= add; }
  if (def.type === 'cosmetic') acc.owned = ownedCosmetics(acc);
  return { ok: true, item: def.id, qty, source };
}

const REMOVE_REASONS = ['trash', 'admin', 'use', 'shard_shop'];
// THE way to take items away (trash, admin, shards spent in «Лавка осколков» = 'shard_shop'). Mirrors grantItem; all-or-nothing.
// slotIndex (optional): take from that slot only (the UI deletes from a specific stack); otherwise from the last stacks first.
// Unequips a removed cosmetic (back to the free default) and keeps the legacy `owned` list in sync.
function removeItem(acc, itemId, qty, reason, slotIndex) {
  const def = itemDef(itemId);
  if (!def) return { ok: false, error: 'Нет такого предмета' };
  if (def.base) return { ok: false, error: 'Базовые предметы нельзя удалить', code: 'base' };
  if (!REMOVE_REASONS.includes(reason)) return { ok: false, error: 'Неизвестная причина удаления' };
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 9999) return { ok: false, error: 'Неверное количество', code: 'qty' };
  if (!def.stackable && qty !== 1) return { ok: false, error: 'Неверное количество', code: 'qty' };
  const slots = acc.inventory.slots;
  if (slotIndex !== undefined && slotIndex !== null) {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slots.length || slots[slotIndex].id !== def.id) return { ok: false, error: 'Этого предмета нет в этой ячейке', code: 'slot' };
    if (slots[slotIndex].q < qty) return { ok: false, error: `В ячейке только ${slots[slotIndex].q} шт.`, code: 'qty' };
    slots[slotIndex].q -= qty;
    if (!slots[slotIndex].q) slots.splice(slotIndex, 1);
  } else {
    const have = countItem(acc, def.id);
    if (!have) return { ok: false, error: 'Этого предмета нет в инвентаре', code: 'missing' };
    if (have < qty) return { ok: false, error: `У вас только ${have} шт.`, code: 'qty' };
    let left = qty;
    for (let i = slots.length - 1; i >= 0 && left; i--) {
      if (slots[i].id !== def.id) continue;
      const take = Math.min(left, slots[i].q); slots[i].q -= take; left -= take;
      if (!slots[i].q) slots.splice(i, 1);
    }
  }
  let unequipped = false;
  if (def.type === 'cosmetic' && acc.equipped[def.cat] === def.id && !hasItem(acc, def.id)) { acc.equipped[def.cat] = G.DEFAULT_EQUIPPED[def.cat]; unequipped = true; }
  acc.owned = ownedCosmetics(acc);
  return { ok: true, item: def.id, qty, reason, unequipped, left: countItem(acc, def.id) };
}

module.exports = { SOURCES, REMOVE_REASONS, itemDef, emptyInventory, inventoryFromOwned, normalizeInventory, migrateAccount, grantItem, removeItem, hasItem, countItem, roomFor, ownedCosmetics };
