// Shared constants and logic (used by both server and browser client)
(function (root) {
  const WORLD = { w: 3000, h: 3000 };
  const PLAYER_R = 20;
  const BASE_SPEED = 230; // px per second
  const TICK_MS = 50;     // 20 ticks per second
  const STEP_DT = TICK_MS / 1000;

  // Orb tiers. `weight` = share (per 10 000) of normal pool spawns; 0 = never in the pool (timed / event orbs).
  // The pool mean (≈1.43 per orb) is tuned so a player without upgrades still earns ≈100 orbs/min (README «Orb rarities»).
  const ORB_TYPES = {
    c: { key: 'c', name: 'Обычная', value: 1, r: 7, color: '#3ee0ff', glow: 'rgba(62,224,255,', weight: 8224 },
    u: { key: 'u', name: 'Необычная', value: 2, r: 8, color: '#5dff8f', glow: 'rgba(93,255,143,', weight: 1200 },
    r: { key: 'r', name: 'Редкая', value: 5, r: 10, color: '#b46bff', glow: 'rgba(180,107,255,', weight: 460 },
    e: { key: 'e', name: 'Эпическая', value: 10, r: 12, color: '#ff9a2e', glow: 'rgba(255,154,46,', weight: 110 },
    l: { key: 'l', name: 'Легендарная', value: 25, r: 14, color: '#ffcc33', glow: 'rgba(255,204,51,', weight: 0, shards: 1, note: 'по расписанию, раз в 1,5–2,5 мин' },
    m: { key: 'm', name: 'Мифическая', value: 50, r: 15, color: '#ff3d6e', glow: 'rgba(255,61,110,', weight: 6, shards: 3, maxAlive: 1, lifeMs: 60000, note: 'очень редкая, живёт 60 с' },
    t: { key: 't', name: 'Сокровище', value: 50, r: 15, color: '#ffe680', glow: 'rgba(255,230,128,', weight: 0, shards: 1, event: true, note: 'только во время события' },
  };
  const ORB_RANK = { c: 0, u: 1, r: 2, e: 3, l: 4, t: 4, m: 5 };
  const ORB_LEGEND = ['c', 'u', 'r', 'e', 'l', 'm', 't'];
  const POOL_WEIGHTS = {};
  for (const t of Object.values(ORB_TYPES)) if (t.weight > 0) POOL_WEIGHTS[t.key] = t.weight;
  const RAIN_WEIGHTS = { c: 5400, u: 2600, r: 1400, e: 600 }; // «Сферный дождь»: rarer orbs much more often
  function rollOrbType(weights = POOL_WEIGHTS, rnd = Math.random) {
    let sum = 0; for (const k in weights) sum += weights[k];
    let x = rnd() * sum;
    for (const k in weights) { x -= weights[k]; if (x < 0) return k; }
    return 'c';
  }
  const expectedOrbValue = (weights = POOL_WEIGHTS) => { let s = 0, v = 0; for (const k in weights) { s += weights[k]; v += weights[k] * ORB_TYPES[k].value; } return v / s; };

  const CATEGORIES = [
    { key: 'color', name: 'Цвета' },
    { key: 'shape', name: 'Формы' },
    { key: 'trail', name: 'Следы' },
    { key: 'nameColor', name: 'Цвет ника' },
    { key: 'hat', name: 'Шапки' },
  ];

  // ---------------------------------------------------------------- item model
  // Every item: id, type ('cosmetic' | 'collectible'), cat, name, rarity ('common'|'rare'|'epic'|'legendary'),
  // stackable, maxStack, sources (where it can come from: base | shop | minigame | arena | event | admin),
  // price (shop price in orbs, only when sources includes 'shop'), value (visual parameter for cosmetics).
  // Base items (price 0) are always available to everyone and never occupy inventory slots.
  const RARITIES = {
    common: { name: 'Обычный', color: '#9fb3d9' },
    rare: { name: 'Редкий', color: '#3ee0ff' },
    epic: { name: 'Эпический', color: '#b46bff' },
    legendary: { name: 'Легендарный', color: '#ffcc33' },
  };
  // Multi-colour paints used by colour / nickname-colour values (anything that is not '#hex' or 'rainbow').
  // stops: gradient colours (cycled slowly in the arena), base: single colour for the minimap / leaderboard dot,
  // fx: optional cheap extra effect (stars on the body, ember glow, neon pulse, glitch flicker).
  const PAINTS = {
    sunset: { stops: ['#ffcf5c', '#ff6f61', '#a64dff'], base: '#ff6f61' },
    aurora: { stops: ['#3dffb0', '#3ee0ff', '#a66bff'], base: '#3ee0ff' },
    galaxy: { stops: ['#3b23a8', '#8a3cff', '#ff4fd8', '#3ee0ff'], base: '#8a3cff', fx: 'stars' },
    lava: { stops: ['#5a1000', '#ff3b00', '#ffae00'], base: '#ff3b00', fx: 'embers' },
    ice: { stops: ['#ffffff', '#bdefff', '#7fd8ff'], base: '#bdefff' },
    fire: { stops: ['#ffe14d', '#ff7b00', '#ff2d2d'], base: '#ff7b00' },
    ocean: { stops: ['#7af0ff', '#2f8cff', '#4a5cff'], base: '#2f8cff' },
    neon: { stops: ['#39ff88', '#b6ffd6'], base: '#39ff88', fx: 'pulse' },
    glitch: { stops: ['#ff2fd6', '#ffffff', '#2ff3ff'], base: '#e8e8ff', fx: 'glitch' },
    // exclusives (shard shop)
    void: { stops: ['#05030c', '#1c0b3d', '#3a1478'], base: '#9b5cff', glow: '#9b5cff', fx: 'void' },
    prism: { stops: ['#ff9de2', '#9de8ff', '#c9ff9d', '#fff59d', '#c7a6ff'], base: '#c9e8ff', fx: 'prism' },
    shard: { stops: ['#fff3b0', '#ffcc33', '#ffffff', '#9de8ff'], base: '#ffd966', fx: 'shard' },
  };
  const C = (id, cat, name, price, rarity, value) => ({ id, type: 'cosmetic', cat, name, price, rarity, value,
    stackable: price !== 0, maxStack: price === 0 ? 1 : 99, base: price === 0, sources: price === 0 ? ['base'] : ['shop', 'event', 'admin'] }); // duplicates stack (wear one)
  const X = (id, cat, name, shardPrice, rarity, value) => ({ id, type: 'cosmetic', cat, name, price: null, shardPrice, exclusive: true, rarity, value,
    stackable: true, maxStack: 99, base: false, sources: ['shard_shop', 'admin'] });
  const ITEMS = [
    // colors
    C('c_cyan', 'color', 'Бирюзовый', 0, 'common', '#3ee0ff'),
    C('c_coral', 'color', 'Коралловый', 150, 'common', '#ff6b6b'),
    C('c_lime', 'color', 'Лаймовый', 150, 'common', '#9dff4f'),
    C('c_violet', 'color', 'Фиолетовый', 400, 'rare', '#a66bff'),
    C('c_pink', 'color', 'Неоново-розовый', 700, 'rare', '#ff5fd2'),
    C('c_gold', 'color', 'Золотой', 2400, 'epic', '#ffcc33'),
    C('c_rainbow', 'color', 'Радужный', 15000, 'legendary', 'rainbow'),
    C('c_mint', 'color', 'Мятный', 200, 'common', '#5dffc4'),
    C('c_ocean', 'color', 'Океанский синий', 250, 'common', '#2f7bff'),
    C('c_orange', 'color', 'Оранжевый', 300, 'common', '#ff9a2e'),
    C('c_crimson', 'color', 'Багровый', 600, 'rare', '#e0234e'),
    C('c_ice', 'color', 'Ледяной', 900, 'rare', '#a8ecff'),
    C('c_midnight', 'color', 'Полночный', 1200, 'rare', '#4a4fe0'),
    C('c_sunset', 'color', 'Закат', 3000, 'epic', 'sunset'),
    C('c_aurora', 'color', 'Северное сияние', 3600, 'epic', 'aurora'),
    C('c_galaxy', 'color', 'Галактика', 16000, 'legendary', 'galaxy'),
    C('c_lava', 'color', 'Лава', 18000, 'legendary', 'lava'),
    // shapes
    C('s_circle', 'shape', 'Круг', 0, 'common', 'circle'),
    C('s_square', 'shape', 'Квадрат', 400, 'common', 'square'),
    C('s_triangle', 'shape', 'Треугольник', 800, 'rare', 'triangle'),
    C('s_hexagon', 'shape', 'Шестиугольник', 1400, 'rare', 'hexagon'),
    C('s_star', 'shape', 'Звезда', 4000, 'epic', 'star'),
    C('s_diamond', 'shape', 'Ромб', 300, 'common', 'diamond'),
    C('s_pentagon', 'shape', 'Пятиугольник', 450, 'common', 'pentagon'),
    C('s_octagon', 'shape', 'Восьмиугольник', 600, 'rare', 'octagon'),
    C('s_drop', 'shape', 'Капля', 900, 'rare', 'drop'),
    C('s_cross', 'shape', 'Плюс', 1200, 'rare', 'cross'),
    C('s_heart', 'shape', 'Сердце', 2200, 'epic', 'heart'),
    C('s_gear', 'shape', 'Шестерёнка', 3400, 'epic', 'gear'),
    C('s_flower', 'shape', 'Цветок', 3800, 'epic', 'flower'),
    C('s_blob', 'shape', 'Желе', 10000, 'legendary', 'blob'),
    // trails
    C('t_none', 'trail', 'Без следа', 0, 'common', 'none'),
    C('t_sparks', 'trail', 'Искры', 1000, 'rare', 'sparks'),
    C('t_neon', 'trail', 'Неоновый шлейф', 2800, 'epic', 'neon'),
    C('t_fire', 'trail', 'Огненный след', 12000, 'legendary', 'fire'),
    C('t_smoke', 'trail', 'Дымок', 300, 'common', 'smoke'),
    C('t_bubbles', 'trail', 'Пузыри', 400, 'common', 'bubbles'),
    C('t_pixel', 'trail', 'Пиксели', 800, 'rare', 'pixel'),
    C('t_leaves', 'trail', 'Листопад', 1100, 'rare', 'leaves'),
    C('t_snow', 'trail', 'Снежинки', 1400, 'rare', 'snow'),
    C('t_hearts', 'trail', 'Сердечки', 2400, 'epic', 'hearts'),
    C('t_stars', 'trail', 'Звёзды', 3000, 'epic', 'stars'),
    C('t_lightning', 'trail', 'Молния', 3800, 'epic', 'lightning'),
    C('t_rainbow', 'trail', 'Радужная лента', 14000, 'legendary', 'rainbow'),
    C('t_galaxy', 'trail', 'Галактическая пыль', 17000, 'legendary', 'galaxy'),
    // name colors
    C('n_white', 'nameColor', 'Белый ник', 0, 'common', '#ffffff'),
    C('n_pink', 'nameColor', 'Розовый ник', 300, 'common', '#ff8bd8'),
    C('n_gold', 'nameColor', 'Золотой ник', 1800, 'epic', '#ffd34d'),
    C('n_rainbow', 'nameColor', 'Радужный ник', 9000, 'legendary', 'rainbow'),
    C('n_cyan', 'nameColor', 'Бирюзовый ник', 200, 'common', '#5ff0ff'),
    C('n_green', 'nameColor', 'Зелёный ник', 250, 'common', '#7dff6b'),
    C('n_orange', 'nameColor', 'Оранжевый ник', 300, 'common', '#ffa64d'),
    C('n_red', 'nameColor', 'Красный ник', 500, 'rare', '#ff5a5a'),
    C('n_purple', 'nameColor', 'Фиолетовый ник', 700, 'rare', '#c38bff'),
    C('n_ice', 'nameColor', 'Ледяной ник', 1000, 'rare', 'ice'),
    C('n_fire', 'nameColor', 'Огненный ник', 2600, 'epic', 'fire'),
    C('n_ocean', 'nameColor', 'Океанский ник', 3000, 'epic', 'ocean'),
    C('n_neon', 'nameColor', 'Неоновый пульс', 3800, 'epic', 'neon'),
    C('n_glitch', 'nameColor', 'Глитч', 12000, 'legendary', 'glitch'),
    // hats
    C('h_none', 'hat', 'Без шапки', 0, 'common', 'none'),
    C('h_cap', 'hat', 'Кепка', 500, 'common', 'cap'),
    C('h_tophat', 'hat', 'Цилиндр', 1500, 'rare', 'tophat'),
    C('h_halo', 'hat', 'Нимб', 3200, 'epic', 'halo'),
    C('h_crown', 'hat', 'Корона', 20000, 'legendary', 'crown'),
    C('h_beanie', 'hat', 'Шапка-бини', 300, 'common', 'beanie'),
    C('h_party', 'hat', 'Праздничный колпак', 450, 'common', 'party'),
    C('h_bunny', 'hat', 'Заячьи ушки', 500, 'common', 'bunny'),
    C('h_cat', 'hat', 'Кошачьи ушки', 700, 'rare', 'cat'),
    C('h_headphones', 'hat', 'Наушники', 1000, 'rare', 'headphones'),
    C('h_cowboy', 'hat', 'Ковбойская шляпа', 1300, 'rare', 'cowboy'),
    C('h_horns', 'hat', 'Рожки', 2000, 'epic', 'horns'),
    C('h_viking', 'hat', 'Шлем викинга', 3000, 'epic', 'viking'),
    C('h_propeller', 'hat', 'Кепка с пропеллером', 3900, 'epic', 'propeller'),
    C('h_wizard', 'hat', 'Шляпа волшебника', 9500, 'legendary', 'wizard'),
    // collectibles (not sold; example of a non-shop, stackable item)
    { id: 'x_legend_shard', type: 'collectible', cat: 'misc', name: 'Легендарный осколок', rarity: 'legendary', icon: '✦', art: 'shard',
      desc: 'Выпадает из легендарных (1) и мифических (3) сфер и за события. Тратится в «Лавке осколков».', stackable: true, maxStack: 99, base: false, price: null,
      sources: ['arena', 'event', 'admin'] },
    // exclusives: only for legendary shards in «Лавка осколков» (never for orbs)
    X('c_void', 'color', 'Пустота', 40, 'epic', 'void'),
    X('n_shard', 'nameColor', 'Осколочный ник', 50, 'epic', 'shard'),
    X('t_comet', 'trail', 'Хвост кометы', 70, 'epic', 'comet'),
    X('s_crystal', 'shape', 'Кристалл', 90, 'epic', 'crystal'),
    X('h_satellites', 'hat', 'Спутники', 120, 'legendary', 'satellites'),
    X('t_crystal', 'trail', 'Кристальный след', 150, 'legendary', 'crystal'),
    X('c_prism', 'color', 'Призма', 200, 'legendary', 'prism'),
    X('h_shard_crown', 'hat', 'Осколочная корона', 300, 'legendary', 'shardcrown'),
  ];
  const SHARD_ID = 'x_legend_shard';
  const SHARD_EXCHANGE = { orbs: 40, maxPerTrade: 99 }; // «Лавка осколков»: 1 shard → 40 orbs (balance only, not the all-time total)
  const ITEM_BY_ID = {};
  for (const it of ITEMS) ITEM_BY_ID[it.id] = it;
  const INV_CAP = 450;       // inventory capacity in UNITS (a stack of 10 uses 10); stacks only group items (≤ maxStack each)
  const INV_SLOTS = INV_CAP; // legacy name kept for old references
  const BUY_MAX_QTY = 99;
  const INV_CATEGORIES = CATEGORIES.concat([{ key: 'misc', name: 'Прочее' }]);

  const DEFAULT_EQUIPPED = { color: 'c_cyan', shape: 's_circle', trail: 't_none', nameColor: 'n_white', hat: 'h_none' };
  const DEFAULT_OWNED = ITEMS.filter(i => i.base).map(i => i.id);

  // Upgrades: optional, diminishing returns per level, costs scale from a few minutes to ~3 h of play for the last level.
  // `values[level]` is the cumulative effect at that level (index 0 = not bought). All effects are applied server-side.
  // Fully maxed magnet + speed + multiplier + luck ≈ +60–80 % orb income (measured, see README "Upgrades").
  const UPGRADES = {
    magnet: { key: 'magnet', name: 'Магнит', desc: 'Больше радиус сбора сфер', max: 5, prices: [300, 900, 2400, 5500, 11000], values: [0, 10, 19, 26, 32, 36], unit: 'px' },
    speed: { key: 'speed', name: 'Ускорение', desc: 'Быстрее движение по арене', max: 5, prices: [400, 1100, 2800, 6000, 12000], values: [0, 6, 10, 13, 16, 18], unit: '%' },
    mult: { key: 'mult', name: 'Множитель сфер', desc: 'Каждая сфера приносит больше (дробные части копятся)', max: 5, prices: [600, 1600, 3800, 8000, 15000], values: [0, 5, 10, 15, 20, 25], unit: '%' },
    luck: { key: 'luck', name: 'Удача', desc: 'Шанс ×2 за сферу; с 3-го уровня ещё и «находка»: обычная или необычная сфера становится эпической (+10)', max: 5, prices: [500, 1400, 3400, 7000, 13000],
      values: [0, 2, 4, 6, 7, 8], jackpot: [0, 0, 0, 0.5, 0.75, 1], unit: '%' },
    sense: { key: 'sense', name: 'Чутьё легенды', desc: 'Компас: стрелки к самым редким сферам и к событиям', max: 3, prices: [500, 1500, 4000], values: [0, 1, 2, 3], unit: '' },
    skill: { key: 'skill', name: 'Мастер мини-игр', desc: 'Бонус к выигрышам в мини-играх', max: 3, prices: [300, 900, 2000], values: [0, 5, 10, 15], unit: '%' },
  };
  const UPGRADE_KEYS = Object.keys(UPGRADES);
  const SENSE_TEXT = ['нет', 'стрелки к легендарной и мифической сферам', '+ стрелка к ближайшей эпической, расстояния', '+ сигнал за 15 с до легендарной и стрелки к целям событий'];
  const SENSE_EPIC_RANGE = 1500; // «Чутьё легенды» 2+: nearest epic orb within this distance
  const upLevel = (key, level) => Math.max(0, Math.min(UPGRADES[key].max, Math.floor(Number(level) || 0))); // caps any stored value
  const upValue = (key, level) => UPGRADES[key].values[upLevel(key, level)];
  const jackpotChance = level => UPGRADES.luck.jackpot[upLevel('luck', level)]; // % per common/uncommon pickup
  function upgradeText(key, level) {
    const u = UPGRADES[key], v = upValue(key, level);
    if (key === 'magnet') return `радиус ${PLAYER_R + v} px` + (v ? ` (+${v})` : '');
    if (key === 'speed') return `скорость ${Math.round(BASE_SPEED * (1 + v / 100))}` + (v ? ` (+${v}%)` : '');
    if (key === 'mult') return `×${(1 + v / 100).toFixed(2)} за сферу`;
    if (key === 'luck') { const j = jackpotChance(level); return `${v}% шанс ×2` + (j ? ` · ${String(j).replace('.', ',')}% находка +10` : ''); }
    if (key === 'sense') return SENSE_TEXT[upLevel(key, level)];
    if (key === 'skill') return `+${v}% к выигрышу`;
    return String(v) + u.unit;
  }

  // Mini-games are for fun and skill, not a better income than collecting orbs (see README "Economy").
  const MINIGAMES = {
    reaction: { key: 'reaction', name: 'Реакция', fee: 10, cooldownMs: 15000 },
    rush: { key: 'rush', name: 'Сферный шторм', fee: 20, duration: 20000, w: 600, h: 400, payoutRate: 0.75, maxPrize: 40, cooldownMs: 20000 },
    // «Память»: repeat a growing sequence of 4 coloured orbs; prize 3 per round after the first 2, cap 30 (12 rounds)
    memory: { key: 'memory', name: 'Память', fee: 10, cooldownMs: 20000, colors: 4, maxRounds: 12, onMs: 450, gapMs: 200, leadMs: 700, pauseMs: 500,
      minInputMs: 120, inputMsPerStep: 1200, inputBaseMs: 3000, freeRounds: 2, perRound: 3, maxPrize: 30 },
    // «Угадай чашу»: follow the orb under 3 cups; win = 16 (fee 10) → blind guessing loses (EV 5.3), perfect tracking stays far below farming
    shell: { key: 'shell', name: 'Угадай чашу', fee: 10, prize: 16, maxPrize: 16, cooldownMs: 15000, cups: 3, swaps: 9, showMs: 1000, swapMsFrom: 420, swapMsTo: 220, pickTimeoutMs: 8000 },
    // «Точный бросок»: 3 throws, stop the marker in the target; points by distance (bar = 0..1), prize 80 % of points, cap 24
    throw: { key: 'throw', name: 'Точный бросок', fee: 10, cooldownMs: 25000, throws: 3, points: [[0.015, 10], [0.035, 7], [0.06, 4], [0.1, 1]], payoutRate: 0.8, maxPrize: 24,
      periodMin: 1300, periodMax: 1800, minStopMs: 250, gapMs: 900, throwTimeoutMs: 6000 },
    // «Цепочка»: tap orbs 1..8 in order; prize by time
    chain: { key: 'chain', name: 'Цепочка', fee: 10, cooldownMs: 20000, n: 8, w: 600, h: 400, r: 28, countdownMs: 1200, limitMs: 15000, minTapGapMs: 120,
      prizes: [[3500, 18], [4500, 14], [6000, 10], [8000, 6], [10000, 3]], maxPrize: 18 },
  };
  const memoryPrize = rounds => { const d = MINIGAMES.memory; return Math.max(0, Math.min(d.maxPrize, (Math.min(rounds, d.maxRounds) - d.freeRounds) * d.perRound)); };
  const memoryShowMs = round => { const d = MINIGAMES.memory; return d.leadMs + round * (d.onMs + d.gapMs); };
  // shell game: cups are swapped by slot; the orb follows its cup
  const shellFinal = (start, swaps) => swaps.reduce((b, [x, y]) => (b === x ? y : b === y ? x : b), start);
  const shellShuffleMs = swaps => MINIGAMES.shell.showMs + swaps.reduce((n, s) => n + s[2], 0);
  // throw: marker goes 0 → 1 → 0 once per period, starting at phase
  const throwPos = (t, period, phase) => { const u = ((t / period + phase) % 1 + 1) % 1; return u < 0.5 ? u * 2 : 2 - u * 2; };
  const throwPoints = d => { for (const [lim, p] of MINIGAMES.throw.points) if (d <= lim) return p; return 0; };
  const throwPrize = total => Math.max(0, Math.min(MINIGAMES.throw.maxPrize, Math.round(total * MINIGAMES.throw.payoutRate)));
  const chainPrize = ms => { for (const [lim, p] of MINIGAMES.chain.prizes) if (ms < lim) return p; return 0; };
  // fastest humanly-allowed full game (ms) — used for the "less than half of farming" rule
  function minigameMinMs(kind) {
    const d = MINIGAMES[kind];
    if (kind === 'reaction') return 1500 + 80;
    if (kind === 'rush') return d.duration;
    if (kind === 'memory') { let t = 0; for (let r = 1; r <= d.maxRounds; r++) t += memoryShowMs(r) + r * d.minInputMs + d.pauseMs; return t; }
    if (kind === 'shell') { let t = d.showMs; for (let i = 0; i < d.swaps; i++) t += d.swapMsFrom + (d.swapMsTo - d.swapMsFrom) * i / (d.swaps - 1); return t; }
    if (kind === 'throw') return d.throws * (d.minStopMs + d.gapMs);
    if (kind === 'chain') return d.countdownMs + (d.n - 1) * d.minTapGapMs;
    return 0;
  }
  const REACTION_PRIZES = [ [250, 16], [320, 12], [400, 10], [550, 6], [750, 3] ]; // [ms threshold, prize]
  const rushPrize = score => Math.max(0, Math.min(MINIGAMES.rush.maxPrize, Math.floor(score * MINIGAMES.rush.payoutRate)));

  function speedFor(level) { return BASE_SPEED * (1 + upValue('speed', level) / 100); }
  function pickupFor(level) { return PLAYER_R + upValue('magnet', level); }
  // Orb reward: «Удача» find (a common/uncommon pickup counts as an epic +10), luck ×2, then the multiplier
  // (fractions are carried in state.frac so +1 orbs are never rounded away). rnd is injectable for tests.
  function orbReward(base, ups, state, rnd = Math.random, type) {
    ups = ups || {};
    let v = base, lucky = false, jackpot = false;
    const j = jackpotChance(ups.luck) / 100;
    if (j > 0 && (type === 'c' || type === 'u') && rnd() < j) { v = ORB_TYPES.e.value; jackpot = true; }
    const luck = upValue('luck', ups.luck) / 100;
    if (luck > 0 && rnd() < luck) { v *= 2; lucky = true; }
    const m = upValue('mult', ups.mult) / 100;
    if (m > 0) {
      const f = (state.frac || 0) + v * m, whole = Math.floor(f + 1e-9);
      state.frac = f - whole; v += whole;
    }
    return { value: v, lucky, jackpot };
  }
  // «Чутьё легенды» compass targets (client display; every position here is public anyway).
  // lvl 1: legendary + mythic orbs · lvl 2: + nearest epic within SENSE_EPIC_RANGE, distances · lvl 3: + event targets.
  // «Радар» (sonar minimap): only plentiful tiers. Epic / legendary / mythic orbs, event treasures and the runner
  // never show up (that's the compass' job). Pure function over data the client already has; the server sends nothing extra.
  const RADAR = { range: 900, periodMs: 3000, sweepMs: 1100, tiers: { c: 1, u: 1, r: 0.35 } }; // tier → blip strength (rare is faint)
  function radarBlips(orbList, me, range = RADAR.range) {
    const out = [];
    for (const o of orbList) {
      const a = RADAR.tiers[o.t]; if (!a) continue;
      const dx = o.x - me.x, dy = o.y - me.y, d = Math.hypot(dx, dy);
      if (d <= range) out.push({ x: o.x, y: o.y, t: o.t, a, d });
    }
    return out;
  }
  function compassTargets(level, orbList, me, ev) {
    const lvl = upLevel('sense', level), out = [];
    if (lvl < 1 || !me) return out;
    let epic = null, ed = SENSE_EPIC_RANGE;
    for (const o of orbList) {
      if (o.t === 'l' || o.t === 'm') out.push({ x: o.x, y: o.y, kind: o.t });
      else if (lvl >= 3 && o.t === 't') out.push({ x: o.x, y: o.y, kind: 'event' });
      else if (lvl >= 2 && o.t === 'e') { const d = Math.hypot(o.x - me.x, o.y - me.y); if (d < ed) { ed = d; epic = o; } }
    }
    if (epic) out.push({ x: epic.x, y: epic.y, kind: 'e' });
    if (lvl >= 3 && ev && ev.zone) out.push({ x: ev.zone.x, y: ev.zone.y, kind: 'event' });
    if (lvl >= 3 && ev && ev.runner) out.push({ x: ev.runner.x, y: ev.runner.y, kind: 'event' });
    for (const t of out) t.dist = lvl >= 2 ? Math.hypot(t.x - me.x, t.y - me.y) : null;
    return out;
  }

  // ---------------------------------------------------------------- timed arena events (server-run, see README «Arena events»)
  // Rewards are a bonus worth a few minutes of farming (≈100 orbs/min without upgrades), never more.
  const EVENTS = {
    rain: { key: 'rain', name: 'Сферный дождь', icon: '🌧️', durationMs: 45000,
      desc: '45 секунд с неба падают дополнительные сферы — редкие и эпические намного чаще. Собирайте!',
      extraBase: 40, extraPerPlayer: 25, extraMax: 220, perTick: 3 },
    koth: { key: 'koth', name: 'Царь горы', icon: '👑', durationMs: 60000, radius: 230, pointsPerSec: 1, minScore: 10,
      desc: 'Стойте в светящейся зоне: каждая секунда в ней — очко. Топ-3 получают сферы и осколки.',
      rewards: [{ orbs: 200, shards: 2 }, { orbs: 120, shards: 1 }, { orbs: 80, shards: 0 }], solo: { orbs: 100, shards: 1 }, participation: { orbs: 20, shards: 0 } },
    treasure: { key: 'treasure', name: 'Охота за сокровищем', icon: '💰', durationMs: 90000, count: 3, perPlayers: 4, maxCount: 6, minDist: 900,
      desc: 'В дальних углах арены появились сферы-сокровища. Кто первым схватит — получит награду!', reward: { orbs: 50, shards: 1 } },
    runner: { key: 'runner', name: 'Сфера-беглец', icon: '💨', durationMs: 60000, speed: 175, wander: 90, r: 14, fleeRange: 700,
      desc: 'По арене носится сфера, которая убегает от игроков. Поймайте её первым!', reward: { orbs: 120, shards: 2 } },
  };
  const EVENT_KEYS = Object.keys(EVENTS);
  const EVENT_SCHEDULE = { minMs: 6 * 60000, maxMs: 10 * 60000, announceMs: 25000 }; // counted only while ≥ 1 player is online

  const skillPrize = (prize, level) => prize > 0 ? Math.round(prize * (1 + upValue('skill', level) / 100)) : prize;

  // Apply one movement input step (STEP_DT seconds). dx,dy is a direction vector with length <= 1.
  // Player pushing (server-authoritative): players are solid circles. Overlaps are split so that whoever walks INTO the
  // other gets the smaller share — a moving player shoves a standing one (at ≈ 2/3 speed); two players pushing head-on
  // stall. «Ускорение» gives at most +2 % push strength per level. A light knockback (≤ PUSH.maxKnock px/tick, decays)
  // pops the shoved player away. Everything stays inside the world.
  const PUSH = { knock: 2.5, maxKnock: 5, decay: 0.7, speedEdge: 0.02, passes: 2 };
  const clampP = p => { p.x = Math.min(WORLD.w - PLAYER_R, Math.max(PLAYER_R, p.x)); p.y = Math.min(WORLD.h - PLAYER_R, Math.max(PLAYER_R, p.y)); };
  // list: [{ x, y, mx, my (movement this tick), lvl (speed level), kx, ky }] — mutated in place
  function separatePlayers(list) {
    const D = PLAYER_R * 2, ref = BASE_SPEED * STEP_DT;
    for (const p of list) { // knockback from earlier shoves
      if (p.kx || p.ky) { p.x += p.kx; p.y += p.ky; p.kx *= PUSH.decay; p.ky *= PUSH.decay; if (Math.hypot(p.kx, p.ky) < 0.2) p.kx = p.ky = 0; clampP(p); }
    }
    for (let pass = 0; pass < PUSH.passes; pass++) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y; const d2 = dx * dx + dy * dy;
        if (d2 >= D * D) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-3) { dx = a.x < WORLD.w / 2 ? 1 : -1; dy = 0; d = 1; } // exactly on top of each other
        const nx = dx / d, ny = dy / d, overlap = D - Math.min(d, D);
        const aa = Math.min(1, Math.max(0, ((a.mx || 0) * nx + (a.my || 0) * ny) / ref)); // how hard a walks into b
        const bb = Math.min(1, Math.max(0, -((b.mx || 0) * nx + (b.my || 0) * ny) / ref));
        const sa = 1 + aa * (1 + PUSH.speedEdge * (a.lvl || 0)), sb = 1 + bb * (1 + PUSH.speedEdge * (b.lvl || 0));
        const shareB = sa / (sa + sb);
        const bx0 = b.x, by0 = b.y, ax0 = a.x, ay0 = a.y;
        b.x += nx * overlap * shareB; b.y += ny * overlap * shareB; clampP(b);
        a.x -= nx * overlap * (1 - shareB); a.y -= ny * overlap * (1 - shareB); clampP(a);
        // whatever a wall blocked goes to the other player
        const left = overlap - (Math.hypot(b.x - bx0, b.y - by0) + Math.hypot(a.x - ax0, a.y - ay0));
        if (left > 0.01) { const mb = Math.hypot(b.x - bx0, b.y - by0) < overlap * shareB - 0.01; const q = mb ? a : b, s = mb ? -1 : 1; q.x += s * nx * left; q.y += s * ny * left; clampP(q); }
        if (pass === 0 && Math.abs(aa - bb) > 0.3) { // light knockback for the one being shoved
          const v = aa > bb ? b : a, s = aa > bb ? 1 : -1, k = PUSH.knock * Math.abs(aa - bb);
          v.kx = (v.kx || 0) + s * nx * k; v.ky = (v.ky || 0) + s * ny * k;
          const m = Math.hypot(v.kx, v.ky); if (m > PUSH.maxKnock) { v.kx *= PUSH.maxKnock / m; v.ky *= PUSH.maxKnock / m; }
        }
      }
    }
  }
  function applyInput(pos, dx, dy, speed) {
    let len = Math.hypot(dx, dy);
    if (!isFinite(len)) return;
    if (len > 1) { dx /= len; dy /= len; }
    pos.x += dx * speed * STEP_DT;
    pos.y += dy * speed * STEP_DT;
    if (pos.x < PLAYER_R) pos.x = PLAYER_R;
    if (pos.y < PLAYER_R) pos.y = PLAYER_R;
    if (pos.x > WORLD.w - PLAYER_R) pos.x = WORLD.w - PLAYER_R;
    if (pos.y > WORLD.h - PLAYER_R) pos.y = WORLD.h - PLAYER_R;
  }

  const api = {
    WORLD, PLAYER_R, BASE_SPEED, TICK_MS, STEP_DT, ORB_TYPES, ORB_RANK, ORB_LEGEND, POOL_WEIGHTS, RAIN_WEIGHTS, rollOrbType, expectedOrbValue, CATEGORIES, INV_CATEGORIES, RARITIES, ITEMS, ITEM_BY_ID, INV_SLOTS, INV_CAP, BUY_MAX_QTY, PAINTS,
    DEFAULT_EQUIPPED, DEFAULT_OWNED, UPGRADES, UPGRADE_KEYS, upLevel, upValue, jackpotChance, upgradeText, orbReward, skillPrize, compassTargets, SENSE_EPIC_RANGE, RADAR, radarBlips, PUSH, separatePlayers,
    EVENTS, EVENT_KEYS, EVENT_SCHEDULE, SHARD_ID, SHARD_EXCHANGE,
    MINIGAMES, REACTION_PRIZES, rushPrize, memoryPrize, memoryShowMs, shellFinal, shellShuffleMs, throwPos, throwPoints, throwPrize, chainPrize, minigameMinMs, speedFor, pickupFor, applyInput,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.G = api;
})(typeof window !== 'undefined' ? window : this);
