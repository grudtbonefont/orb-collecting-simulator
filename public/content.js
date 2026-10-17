// Goals & happenings (shared by server and client): mini-events, achievements + titles, daily quests, boss.
// Pure data + pure functions only; the server decides everything. Numbers are documented in README «Content update».
(function (root) {
  'use strict';
  const G = typeof module !== 'undefined' && module.exports ? require('./shared.js') : root.G;
  const MIN = 60000, H = 3600000, DAY = 86400000, MSK = 3 * H;

  // ---------------------------------------------------------------- mini-events (small, frequent, independent of the 2–6 min events)
  // Rewards ≈ 20–60 s of farming (≈100 orbs/min without upgrades).
  const MINI = {
    everyMinMs: 60000, everyMaxMs: 120000, // between two mini-events (only while someone is online)
    goldrain: { key: 'goldrain', name: 'Золотой дождь', icon: '🌟', durationMs: 25000, count: 24, radius: 230, weights: { u: 50, r: 40, e: 10 },
      desc: 'В одном месте карты высыпалась горсть ценных сфер. Место отмечено на радаре — успейте за 25 секунд!' },
    chest: { key: 'chest', name: 'Сундук с замком', icon: '🧰', durationMs: 40000, r: 34, openR: 150, duoMs: 3000, soloMs: 8000, pool: { orbs: 100, shards: 2 }, minOrbs: 30,
      desc: 'Сундук открывается, когда рядом стоят 2 игрока 3 секунды (если вы одни онлайн — 8 секунд). Награда делится между открывшими.' },
    portal: { key: 'portal', name: 'Бонусный портал', icon: '🌀', durationMs: 30000, r: 46, roomMs: 30000, roomOrbs: 40, refillPerSec: 2, weights: { c: 60, u: 30, r: 10 },
      desc: 'Войдите в портал: 30 секунд в бонусной комнате, полной сфер, затем вы вернётесь туда, где были.' },
  };
  const MINI_KEYS = ['goldrain', 'chest', 'portal'];
  // the bonus room lies outside the arena (below zone 1); applyInput keeps players inside it while they are there
  const ROOM = G.BONUS_ROOM, inRoom = G.inBonusRoom;

  // ---------------------------------------------------------------- achievements: tiered chains by category (I…V), every tier pays orbs + shards
  // stat(p): p = { total, stats, codesUsed, items, liveMs }. Tier ids: `${chain}_${tier}` (1-based), stored in stats.ach like before.
  const ACH_CATS = [
    { key: 'orbs', name: 'Сбор сфер', icon: '🔮' }, { key: 'boss', name: 'Босс', icon: '👹' }, { key: 'events', name: 'Эвенты', icon: '🎪' },
    { key: 'games', name: 'Мини-игры', icon: '🎮' }, { key: 'quests', name: 'Задания', icon: '📜' }, { key: 'danger', name: 'Опасности', icon: '⚡' },
    { key: 'explore', name: 'Исследование', icon: '🧭' }, { key: 'collect', name: 'Коллекция', icon: '🎒' },
  ];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  const TIER_ORBS = [30, 80, 180, 350, 600], TIER_SHARDS = [1, 2, 3, 5, 8]; // × chain difficulty (orbs), shards rounded, min 1
  const playMin = p => Math.floor(((p.stats.playMs || 0) + (p.liveMs || 0)) / MIN);
  const CHAINS = [
    { id: 'total', cat: 'orbs', icon: '🧺', name: 'Собиратель', desc: n => `Соберите ${fmtN(n)} сфер`, stat: p => p.total, goals: [100, 1000, 10000, 50000, 200000] },
    { id: 'rare', cat: 'orbs', icon: '🔷', name: 'Знаток редкостей', desc: n => `Поймайте ${fmtN(n)} редких или лучше сфер`, stat: p => p.stats.rareCaught, goals: [25, 300, 2500] },
    { id: 'epic', cat: 'orbs', icon: '🟣', name: 'Эпик', desc: n => `Поймайте ${fmtN(n)} эпических или лучше сфер`, stat: p => p.stats.epicCaught, goals: [5, 60, 500], k: 1.1 },
    { id: 'legend', cat: 'orbs', icon: '🟡', name: 'Легенда', desc: n => `Поймайте ${fmtN(n)} ${pl(n, 'легендарную сферу', 'легендарные сферы', 'легендарных сфер')}`, stat: p => p.stats.legendaryCaught, goals: [1, 8, 30], k: 1.2 },
    { id: 'myth', cat: 'orbs', icon: '🔴', name: 'Миф', desc: n => `Поймайте ${fmtN(n)} ${pl(n, 'мифическую сферу', 'мифические сферы', 'мифических сфер')}`, stat: p => p.stats.mythicCaught, goals: [1, 5, 20], k: 1.4 },
    { id: 'bosskill', cat: 'boss', icon: '👹', name: 'Победитель босса', desc: n => `Победите босса ${fmtN(n)} ${pl(n, 'раз', 'раза', 'раз')}`, stat: p => p.stats.bossKills, goals: [1, 3, 10, 25, 50], k: 1.3 },
    { id: 'bossdmg', cat: 'boss', icon: '👊', name: 'Сокрушитель', desc: n => `Нанесите боссам ${fmtN(n)} урона`, stat: p => p.stats.bossDmg, goals: [100, 1500, 8000] },
    { id: 'runners', cat: 'events', icon: '💨', name: 'Ловец Раннеров', desc: n => `Поймайте ${fmtN(n)} ${pl(n, 'Раннера', 'Раннеров', 'Раннеров')}`, stat: p => p.stats.runnersCaught, goals: [1, 10, 50] },
    { id: 'treasure', cat: 'events', icon: '💰', name: 'Кладоискатель', desc: n => `Найдите ${fmtN(n)} ${pl(n, 'сокровище', 'сокровища', 'сокровищ')}`, stat: p => p.stats.treasures, goals: [1, 10, 50] },
    { id: 'lucky', cat: 'events', icon: '🍀', name: 'Везунчик', desc: n => `Поучаствуйте в «Волне удачи» ${fmtN(n)} ${pl(n, 'раз', 'раза', 'раз')}`, stat: p => p.stats.luckyPlayed, goals: [1, 8, 30], k: 0.8 },
    { id: 'mini', cat: 'events', icon: '🌟', name: 'Охотник за чудесами', desc: n => `Мини-события: ${fmtN(n)} ${pl(n, 'раз', 'раза', 'раз')} (золотой дождь, сундуки, порталы)`, stat: p => (p.stats.goldRains || 0) + (p.stats.chests || 0) + (p.stats.portals || 0), goals: [3, 25, 120] },
    { id: 'games', cat: 'games', icon: '🎮', name: 'Игрок', desc: n => `Сыграйте ${fmtN(n)} мини-игр`, stat: p => p.stats.minigames, goals: [5, 50, 300], k: 0.8 },
    { id: 'mgwins', cat: 'games', icon: '🥇', name: 'Мастер игр', desc: n => `Выиграйте приз в ${fmtN(n)} мини-играх`, stat: p => p.stats.mgWins, goals: [3, 30, 200], k: 0.9 },
    { id: 'quests', cat: 'quests', icon: '📜', name: 'Исполнительный', desc: n => `Выполните ${fmtN(n)} ежедневных заданий`, stat: p => p.stats.questsDone, goals: [3, 10, 50, 200] },
    { id: 'streak', cat: 'quests', icon: '🔥', name: 'Неудержимый', desc: n => `Серия: ${fmtN(n)} дней подряд все задания`, stat: p => p.stats.bestStreak, goals: [2, 7, 14, 30], k: 1.3 },
    { id: 'zaps', cat: 'danger', icon: '⚡', name: 'Несгибаемый', desc: n => `Переживите ${fmtN(n)} попаданий лазеров, выстрелов и ударов`, stat: p => p.stats.zaps, goals: [1, 25, 150], k: 0.7 },
    { id: 'nearlaser', cat: 'danger', icon: '🔥', name: 'По краю', desc: n => `Проведите ${fmtN(n)} с рядом с лазером, не попав под луч`, stat: p => p.stats.nearLaserSec, goals: [30, 180, 900, 3000], unit: 'с' },
    { id: 'zone2', cat: 'explore', icon: '🚪', name: 'Первопроходец', desc: () => 'Откройте дверь во 2-ю зону', stat: p => (p.stats.unlockedDoor2 ? 1 : 0), goals: [1], k: 1.5 },
    { id: 'dist', cat: 'explore', icon: '👣', name: 'Путешественник', desc: n => `Пройдите ${fmtN(n)} м`, stat: p => p.stats.distM, goals: [2000, 25000, 150000, 600000], unit: 'м' },
    { id: 'play', cat: 'explore', icon: '⏱️', name: 'Ветеран', desc: n => `Проведите в игре ${n >= 60 ? fmtN(n / 60) + ' ч' : n + ' мин'}`, stat: playMin, goals: [60, 300, 1500, 6000], unit: 'мин' },
    { id: 'items', cat: 'collect', icon: '🎨', name: 'Коллекционер', desc: n => `Соберите ${fmtN(n)} разных предметов`, stat: p => p.items, goals: [3, 10, 20, 40] },
    { id: 'buys', cat: 'collect', icon: '🛒', name: 'Покупатель', desc: n => `Совершите ${fmtN(n)} ${pl(n, 'покупку', 'покупки', 'покупок')} в магазине`, stat: p => p.stats.buys, goals: [1, 5, 20, 60], k: 0.8 },
    { id: 'codes', cat: 'collect', icon: '🎟️', name: 'Охотник за кодами', desc: n => `Активируйте ${fmtN(n)} ${pl(n, 'промокод', 'промокода', 'промокодов')}`, stat: p => p.codesUsed, goals: [1, 3, 6], k: 0.7 },
  ];
  function pl(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }
  function fmtN(n) { return Number(n).toLocaleString('ru-RU'); }
  const tierReward = (chain, i) => { const k = chain.k || 1, n = chain.goals.length; i = n >= 5 || n === 1 ? i : Math.round(i * 4 / (n - 1)); // short chains: their last tier pays like tier V
    return { orbs: Math.round(TIER_ORBS[i] * k / 5) * 5, shards: Math.max(1, Math.round(TIER_SHARDS[i] * k)) }; };
  const ACH = [];
  for (const ch of CHAINS) ch.tiers = ch.goals.map((goal, i) => {
    const a = { id: `${ch.id}_${i + 1}`, chain: ch.id, cat: ch.cat, tier: i + 1, icon: ch.icon, name: ch.goals.length > 1 ? `${ch.name} ${ROMAN[i]}` : ch.name, desc: ch.desc(goal), stat: ch.stat, goal, unit: ch.unit, reward: tierReward(ch, i) };
    ACH.push(a); return a;
  });
  const CHAIN_BY_ID = Object.fromEntries(CHAINS.map(c => [c.id, c]));
  const ACH_BY_ID = Object.fromEntries(ACH.map(a => [a.id, a]));
  const achValue = (a, p) => Math.max(0, Math.floor(Number(a.stat(p)) || 0));
  // distinct non-base cosmetics in the inventory (slots: [{id,q}])
  const itemsOwned = slots => new Set((slots || []).filter(s => s && G.ITEM_BY_ID[s.id] && G.ITEM_BY_ID[s.id].type === 'cosmetic' && !G.ITEM_BY_ID[s.id].base).map(s => s.id)).size;
  // pre-tier achievements (paid once) → the tier they cover (highest tier with goal ≤ the old goal) and what they paid
  const OLD_ACH = { first100: ['total', 100, { orbs: 20 }], collector: ['total', 5000, { orbs: 150 }], magnate: ['total', 50000, { shards: 3 }], legend: ['legend', 1, { shards: 1 }],
    myth: ['myth', 1, { shards: 2 }], runners: ['runners', 5, { orbs: 100 }], treasure: ['treasure', 3, { orbs: 100 }], bosshit: ['bossdmg', 100, { orbs: 80 }], bosskill: ['bosskill', 1, { shards: 3 }],
    games: ['games', 25, { orbs: 100 }], zone2: ['zone2', 1, { orbs: 100 }], codes: ['codes', 3, { orbs: 50 }], play1h: ['play', 60, { orbs: 100 }], play10h: ['play', 600, { shards: 5 }],
    zaps: ['zaps', 10, { orbs: 50 }], chests: ['mini', 5, { shards: 1 }], portals: ['mini', 3, { orbs: 80 }], quests: ['quests', 10, { shards: 2 }], streak7: ['streak', 7, { shards: 5 }], };
  const oldTier = id => { const o = OLD_ACH[id]; if (!o) return null; const ch = CHAIN_BY_ID[o[0]]; let t = null; for (const a of ch.tiers) if (a.goal <= o[1]) t = a; return t; };

  // ---------------------------------------------------------------- daily quests: 3 per day, reset 00:00 Moscow time
  const dayKey = (now = Date.now()) => Math.floor((now + MSK) / DAY);
  const resetIn = (now = Date.now()) => (dayKey(now) + 1) * DAY - MSK - now;
  // kind = counter that grows (server: questProgress(acc, kind, n)); diff 1–3 scales the reward
  const QUESTS = [
    { id: 'orbs300', kind: 'orbs', goal: 300, diff: 1, text: 'Соберите 300 сфер' },
    { id: 'orbs1000', kind: 'orbs', goal: 1000, diff: 2, text: 'Соберите 1 000 сфер' },
    { id: 'orbs2500', kind: 'orbs', goal: 2500, diff: 3, text: 'Соберите 2 500 сфер' },
    { id: 'rare10', kind: 'rare', goal: 10, diff: 1, text: 'Соберите 10 редких (или ценнее) сфер' },
    { id: 'rare30', kind: 'rare', goal: 30, diff: 2, text: 'Соберите 30 редких (или ценнее) сфер' },
    { id: 'runner1', kind: 'runner', goal: 1, diff: 2, text: 'Поймайте Раннера' },
    { id: 'mg2', kind: 'mg', goal: 2, diff: 1, text: 'Сыграйте 2 мини-игры' },
    { id: 'mg5', kind: 'mg', goal: 5, diff: 2, text: 'Сыграйте 5 мини-игр' },
    { id: 'zone2', kind: 'zone2', goal: 1, diff: 1, text: 'Побывайте во 2-й зоне', needs: 'door' },
    { id: 'boss1', kind: 'boss', goal: 1, diff: 3, text: 'Ударьте босса' },
    { id: 'chest1', kind: 'chest', goal: 1, diff: 2, text: 'Откройте сундук с замком' },
    { id: 'portal1', kind: 'portal', goal: 1, diff: 2, text: 'Побывайте в бонусной комнате' },
    { id: 'event1', kind: 'event', goal: 1, diff: 2, text: 'Примите участие в событии арены' },
    { id: 'play15', kind: 'play', goal: 15, diff: 1, text: 'Проведите на арене 15 минут' },
    { id: 'gold10', kind: 'gold', goal: 10, diff: 1, text: 'Соберите 10 сфер «Золотого дождя»' },
  ];
  const QUEST_BY_ID = Object.fromEntries(QUESTS.map(q => [q.id, q]));
  // varied rewards, scaled by difficulty: orbs, shards, temporary boosts, rarely a cosmetic (trail / skin)
  const BOOSTS = { orbs: { name: 'Сферы ×1.5', icon: '✖️', mult: 1.5 }, speed: { name: 'Скорость +10 %', icon: '👟', mult: 1.1 } };
  const QUEST_REWARDS = {
    1: [[50, { orbs: 80 }], [30, { boost: 'orbs', min: 5 }], [20, { boost: 'speed', min: 5 }]],
    2: [[40, { orbs: 200 }], [30, { shards: 1 }], [30, { boost: 'orbs', min: 10 }]],
    3: [[35, { shards: 2 }], [30, { orbs: 400 }], [20, { boost: 'orbs', min: 15 }], [15, { item: true }]],
  };
  const ALL_DONE = { orbs: 100, shards: 1, perStreakDay: 25, streakCap: 10 }; // bonus for all 3: 100 + 25 × streak (≤ 10 days) orbs + 1 shard
  const allDoneBonus = streak => ({ orbs: ALL_DONE.orbs + ALL_DONE.perStreakDay * Math.min(ALL_DONE.streakCap, Math.max(0, streak - 1)), shards: ALL_DONE.shards });
  function pickWeighted(list, rnd) { const tot = list.reduce((n, x) => n + x[0], 0); let r = rnd() * tot; for (const [w, v] of list) { if ((r -= w) < 0) return v; } return list[list.length - 1][1]; }
  // cosmetics a quest may give: cheap shop skins / trails
  const questItems = () => G.ITEMS.filter(i => i.type === 'cosmetic' && i.sources.includes('shop') && !i.exclusive && (i.cat === 'trail' || i.cat === 'color') && i.price > 0 && i.price <= 1500).map(i => i.id);
  // 3 different quests (one per difficulty when possible); ctx: { door: zone 2 unlocked, owned: Set of item ids }
  function rollQuests(rnd = Math.random, ctx = {}) {
    const pool = QUESTS.filter(q => q.needs !== 'door' || ctx.door), out = [], used = new Set();
    for (const d of [1, 2, 3]) {
      const c = pool.filter(q => q.diff === d && !used.has(q.kind)); const any = pool.filter(q => !used.has(q.kind));
      const q = (c.length ? c : any)[Math.floor(rnd() * (c.length ? c.length : any.length))]; if (!q) continue;
      used.add(q.kind);
      let rw = Object.assign({}, pickWeighted(QUEST_REWARDS[q.diff], rnd));
      if (rw.item) { const free = questItems().filter(id => !(ctx.owned && ctx.owned.has(id))); rw = free.length ? { item: free[Math.floor(rnd() * free.length)] } : { shards: 2 }; }
      out.push({ id: q.id, p: 0, done: false, rw });
    }
    return out;
  }
  function rewardText(rw) {
    if (!rw) return '';
    const parts = [];
    if (rw.orbs) parts.push(`+${rw.orbs} сфер`);
    if (rw.shards) parts.push(`+${rw.shards} оск.`);
    if (rw.boost) parts.push(`${BOOSTS[rw.boost].name} на ${rw.min} мин`);
    if (rw.item) { const it = G.ITEM_BY_ID[rw.item]; parts.push(`предмет «${it ? it.name : rw.item}»`); }
    return parts.join(', ');
  }
  const boostMult = (stats, kind, now = Date.now()) => (stats && stats.boosts && stats.boosts[kind] > now ? BOOSTS[kind].mult : 1);

  // ---------------------------------------------------------------- boss (about once an hour of online play, zone 1)
  const BOSS = {
    name: 'Пожиратель сфер', icon: '👹', everyMinMs: 50 * MIN, everyMaxMs: 70 * MIN, announceMs: 25000, lifeMs: 3 * MIN,
    r: 70, speed: 70, hpBase: 300, hpPerPlayer: 250, hpMax: 6000, hitDmg: 10, hitCooldownMs: 600, hitPad: 8,
    ringEveryMinMs: 6000, ringEveryMaxMs: 8000, ringWarnMs: 1000, ringSpeed: 260, ringMax: 560, ringW: 26,
    shotEveryMs: 1800, shotRange: 700, shotSpeed: 280, pct: 0.03, cap: 60,
    reward: { base: 150, share: 350, shards: 1, bigShareShards: 1, bigShare: 0.25, topOrbs: 100, topShards: 2 },
    desc: 'Огромный босс в 1-й зоне! Толкайте его, чтобы наносить урон (каждые 0,6 с). Берегитесь колец и выстрелов — они отнимают 3 % сфер (максимум 60). Победите за 3 минуты — награда по доле урона.',
  };
  const bossHp = online => Math.min(BOSS.hpMax, BOSS.hpBase + BOSS.hpPerPlayer * Math.max(1, online));
  const bossPenalty = balance => (balance >= 1 ? Math.min(BOSS.cap, Math.max(1, Math.round(balance * BOSS.pct))) : 0);
  // reward for a damage share (0..1) of a killed boss; top: the best damage dealer
  function bossReward(share, top) {
    const R = BOSS.reward, r = { orbs: Math.round(R.base + R.share * Math.max(0, Math.min(1, share))), shards: R.shards + (share >= R.bigShare ? R.bigShareShards : 0) };
    if (top) { r.orbs += R.topOrbs; r.shards += R.topShards; }
    return r;
  }

  const api = { MINI, MINI_KEYS, ROOM, inRoom, ACH, ACH_BY_ID, ACH_CATS, CHAINS, CHAIN_BY_ID, achValue, itemsOwned, OLD_ACH, oldTier, tierReward, dayKey, resetIn, QUESTS, QUEST_BY_ID, BOOSTS, QUEST_REWARDS, ALL_DONE, allDoneBonus,
    rollQuests, questItems, rewardText, boostMult, BOSS, bossHp, bossPenalty, bossReward };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.C = api;
})(typeof window !== 'undefined' ? window : this);
