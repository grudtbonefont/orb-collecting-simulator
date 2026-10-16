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

  // ---------------------------------------------------------------- achievements (one-time reward, some give a title)
  // stat(p): p = own profile (total, stats, codesUsed); playMs includes the running session (p.liveMs)
  const ACH = [
    { id: 'first100', icon: '✨', name: 'Первые шаги', desc: 'Соберите 100 сфер', stat: p => p.total, goal: 100, reward: { orbs: 20 } },
    { id: 'collector', icon: '🧺', name: 'Собиратель', desc: 'Соберите 5 000 сфер', stat: p => p.total, goal: 5000, reward: { orbs: 150 }, title: 'Собиратель' },
    { id: 'magnate', icon: '💎', name: 'Магнат', desc: 'Соберите 50 000 сфер', stat: p => p.total, goal: 50000, reward: { shards: 3 }, title: 'Магнат' },
    { id: 'legend', icon: '🟡', name: 'Легенда', desc: 'Поймайте легендарную сферу', stat: p => p.stats.legendaryCaught, goal: 1, reward: { shards: 1 }, title: 'Легендарный' },
    { id: 'myth', icon: '🔴', name: 'Миф', desc: 'Поймайте мифическую сферу', stat: p => p.stats.mythicCaught, goal: 1, reward: { shards: 2 }, title: 'Мифический' },
    { id: 'runners', icon: '💨', name: 'Ловец Раннеров', desc: 'Поймайте 5 Раннеров', stat: p => p.stats.runnersCaught, goal: 5, reward: { orbs: 100 }, title: 'Ловец Раннеров' },
    { id: 'treasure', icon: '💰', name: 'Кладоискатель', desc: 'Найдите 3 сокровища', stat: p => p.stats.treasures, goal: 3, reward: { orbs: 100 }, title: 'Кладоискатель' },
    { id: 'bosshit', icon: '👊', name: 'Смельчак', desc: 'Нанесите боссу 100 урона', stat: p => p.stats.bossDmg, goal: 100, reward: { orbs: 80 } },
    { id: 'bosskill', icon: '👹', name: 'Победитель босса', desc: 'Победите босса', stat: p => p.stats.bossKills, goal: 1, reward: { shards: 3 }, title: 'Победитель босса' },
    { id: 'games', icon: '🎮', name: 'Игрок', desc: 'Сыграйте 25 мини-игр', stat: p => p.stats.minigames, goal: 25, reward: { orbs: 100 }, title: 'Игрок' },
    { id: 'zone2', icon: '🚪', name: 'Первопроходец', desc: 'Откройте дверь во 2-ю зону', stat: p => (p.stats.unlockedDoor2 ? 1 : 0), goal: 1, reward: { orbs: 100 }, title: 'Первопроходец' },
    { id: 'codes', icon: '🎟️', name: 'Охотник за кодами', desc: 'Активируйте 3 промокода', stat: p => p.codesUsed, goal: 3, reward: { orbs: 50 } },
    { id: 'play1h', icon: '⏱️', name: 'Час на арене', desc: 'Проведите в игре 1 час', stat: p => Math.floor(((p.stats.playMs || 0) + (p.liveMs || 0)) / MIN), goal: 60, reward: { orbs: 100 }, unit: 'мин' },
    { id: 'play10h', icon: '🕰️', name: 'Ветеран', desc: 'Проведите в игре 10 часов', stat: p => Math.floor(((p.stats.playMs || 0) + (p.liveMs || 0)) / MIN), goal: 600, reward: { shards: 5 }, title: 'Ветеран', unit: 'мин' },
    { id: 'zaps', icon: '⚡', name: 'Под обстрелом', desc: 'Переживите 10 попаданий лазеров и выстрелов', stat: p => p.stats.zaps, goal: 10, reward: { orbs: 50 }, title: 'Несгибаемый' },
    { id: 'chests', icon: '🧰', name: 'Взломщик', desc: 'Откройте 5 сундуков', stat: p => p.stats.chests, goal: 5, reward: { shards: 1 }, title: 'Взломщик' },
    { id: 'portals', icon: '🌀', name: 'Путешественник', desc: 'Побывайте в бонусной комнате 3 раза', stat: p => p.stats.portals, goal: 3, reward: { orbs: 80 } },
    { id: 'quests', icon: '📜', name: 'Исполнительный', desc: 'Выполните 10 ежедневных заданий', stat: p => p.stats.questsDone, goal: 10, reward: { shards: 2 }, title: 'Исполнительный' },
    { id: 'streak7', icon: '🔥', name: 'Неудержимый', desc: 'Серия: 7 дней подряд все задания', stat: p => p.stats.bestStreak, goal: 7, reward: { shards: 5 }, title: 'Неудержимый' },
    { id: 'events', icon: '🏅', name: 'Чемпион', desc: 'Выиграйте 10 событий арены', stat: p => p.stats.eventWins, goal: 10, reward: { orbs: 150 }, title: 'Чемпион' },
  ];
  const ACH_BY_ID = Object.fromEntries(ACH.map(a => [a.id, a]));
  const achValue = (a, p) => Math.max(0, Math.floor(Number(a.stat(p)) || 0));
  const titleOf = stats => { const a = stats && stats.title && ACH_BY_ID[stats.title]; return a && a.title && stats.ach && stats.ach[a.id] ? a.title : ''; };

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

  const api = { MINI, MINI_KEYS, ROOM, inRoom, ACH, ACH_BY_ID, achValue, titleOf, dayKey, resetIn, QUESTS, QUEST_BY_ID, BOOSTS, QUEST_REWARDS, ALL_DONE, allDoneBonus,
    rollQuests, questItems, rewardText, boostMult, BOSS, bossHp, bossPenalty, bossReward };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.C = api;
})(typeof window !== 'undefined' ? window : this);
