// Shared constants and logic (used by both server and browser client)
(function (root) {
  const ZONE_W = 6000, ZONE_H = 6000; // one zone (was 3000×3000; 2× each side)
  const WORLD = { w: ZONE_W * 2, h: ZONE_H }; // zone 1 (violet) | door | zone 2 (blue)
  const DOOR_COST = 3750; // one-time unlock for zone 2 (~35 min of base farming); earlier 1000-orb unlocks are kept
  const ZONE2_WEIGHTS = { c: 6960, u: 1800, r: 850, e: 280, l: 80, m: 30 }; // same tiers as zone 1, better odds: c 69.6 / u 18 / r 8.5 / e 2.8 / l 0.8 / m 0.3 % (mean ≈ 2.03 vs 1.49)
  const zoneOf = x => (x < ZONE_W ? 1 : 2);
  const DOOR = { x: ZONE_W, y: ZONE_H / 2, half: ZONE_H / 2, clear: 300 }; // the whole dividing wall is the door (wall-door); spawns keep `clear` px off it
  const doorDist = x => Math.abs(x - ZONE_W); // distance to the wall-door line
  // The wall at x = ZONE_W blocks locked players everywhere; unlocked players cross anywhere along it. prevX = x before the move.
  function zoneGate(pos, prevX, unlocked) {
    if (unlocked) return;
    if (prevX <= ZONE_W) { if (pos.x > ZONE_W - PLAYER_R) pos.x = ZONE_W - PLAYER_R; }
    else if (pos.x < ZONE_W + PLAYER_R) pos.x = ZONE_W + PLAYER_R;
  }
  const PLAYER_R = 20;
  const BASE_SPEED = 230; // px per second
  const TICK_MS = 50;     // 20 ticks per second
  const STEP_DT = TICK_MS / 1000;

  // Orb tiers. `weight` = share (per 10 000) of normal pool spawns; 0 = never in the pool (timed / event orbs).
  // The pool mean (≈1.43 per orb) is tuned so a player without upgrades still earns ≈100 orbs/min (README «Orb rarities»).
  const ORB_TYPES = {
    c: { key: 'c', name: 'Обычная', value: 1, r: 7, color: '#3ee0ff', glow: 'rgba(62,224,255,', weight: 8204 },
    u: { key: 'u', name: 'Необычная', value: 2, r: 8, color: '#5dff8f', glow: 'rgba(93,255,143,', weight: 1200 },
    r: { key: 'r', name: 'Редкая', value: 5, r: 10, color: '#b46bff', glow: 'rgba(180,107,255,', weight: 460 },
    e: { key: 'e', name: 'Эпическая', value: 10, r: 12, color: '#ff9a2e', glow: 'rgba(255,154,46,', weight: 110 },
    l: { key: 'l', name: 'Легендарная', value: 25, r: 14, color: '#ffcc33', glow: 'rgba(255,204,51,', weight: 20, shards: 1, lifeMs: 75000, note: 'редкая: шанс 0,2 % на каждую новую сферу (во 2-й зоне 0,8 %), живёт 75 с' },
    m: { key: 'm', name: 'Мифическая', value: 50, r: 15, color: '#ff3d6e', glow: 'rgba(255,61,110,', weight: 6, shards: 3, lifeMs: 60000, note: 'очень редкая: появляется только по шансу, живёт 60 с' },
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
    C('c_coral', 'color', 'Коралловый', 225, 'common', '#ff6b6b'),
    C('c_lime', 'color', 'Лаймовый', 225, 'common', '#9dff4f'),
    C('c_violet', 'color', 'Фиолетовый', 600, 'rare', '#a66bff'),
    C('c_pink', 'color', 'Неоново-розовый', 1050, 'rare', '#ff5fd2'),
    C('c_gold', 'color', 'Золотой', 3600, 'epic', '#ffcc33'),
    C('c_rainbow', 'color', 'Радужный', 22500, 'legendary', 'rainbow'),
    C('c_mint', 'color', 'Мятный', 300, 'common', '#5dffc4'),
    C('c_ocean', 'color', 'Океанский синий', 375, 'common', '#2f7bff'),
    C('c_orange', 'color', 'Оранжевый', 450, 'common', '#ff9a2e'),
    C('c_crimson', 'color', 'Багровый', 900, 'rare', '#e0234e'),
    C('c_ice', 'color', 'Ледяной', 1350, 'rare', '#a8ecff'),
    C('c_midnight', 'color', 'Полночный', 1800, 'rare', '#4a4fe0'),
    C('c_sunset', 'color', 'Закат', 4500, 'epic', 'sunset'),
    C('c_aurora', 'color', 'Северное сияние', 5400, 'epic', 'aurora'),
    C('c_galaxy', 'color', 'Галактика', 24000, 'legendary', 'galaxy'),
    C('c_lava', 'color', 'Лава', 27000, 'legendary', 'lava'),
    // shapes
    C('s_circle', 'shape', 'Круг', 0, 'common', 'circle'),
    C('s_square', 'shape', 'Квадрат', 600, 'common', 'square'),
    C('s_triangle', 'shape', 'Треугольник', 1200, 'rare', 'triangle'),
    C('s_hexagon', 'shape', 'Шестиугольник', 2100, 'rare', 'hexagon'),
    C('s_star', 'shape', 'Звезда', 6000, 'epic', 'star'),
    C('s_diamond', 'shape', 'Ромб', 450, 'common', 'diamond'),
    C('s_pentagon', 'shape', 'Пятиугольник', 675, 'common', 'pentagon'),
    C('s_octagon', 'shape', 'Восьмиугольник', 900, 'rare', 'octagon'),
    C('s_drop', 'shape', 'Капля', 1350, 'rare', 'drop'),
    C('s_cross', 'shape', 'Плюс', 1800, 'rare', 'cross'),
    C('s_heart', 'shape', 'Сердце', 3300, 'epic', 'heart'),
    C('s_gear', 'shape', 'Шестерёнка', 5100, 'epic', 'gear'),
    C('s_flower', 'shape', 'Цветок', 5700, 'epic', 'flower'),
    C('s_blob', 'shape', 'Желе', 15000, 'legendary', 'blob'),
    // trails
    C('t_none', 'trail', 'Без следа', 0, 'common', 'none'),
    C('t_sparks', 'trail', 'Искры', 1500, 'rare', 'sparks'),
    C('t_neon', 'trail', 'Неоновый шлейф', 4200, 'epic', 'neon'),
    C('t_fire', 'trail', 'Огненный след', 18000, 'legendary', 'fire'),
    C('t_smoke', 'trail', 'Дымок', 450, 'common', 'smoke'),
    C('t_bubbles', 'trail', 'Пузыри', 600, 'common', 'bubbles'),
    C('t_pixel', 'trail', 'Пиксели', 1200, 'rare', 'pixel'),
    C('t_leaves', 'trail', 'Листопад', 1650, 'rare', 'leaves'),
    C('t_snow', 'trail', 'Снежинки', 2100, 'rare', 'snow'),
    C('t_hearts', 'trail', 'Сердечки', 3600, 'epic', 'hearts'),
    C('t_stars', 'trail', 'Звёзды', 4500, 'epic', 'stars'),
    C('t_lightning', 'trail', 'Молния', 5700, 'epic', 'lightning'),
    C('t_rainbow', 'trail', 'Радужная лента', 21000, 'legendary', 'rainbow'),
    C('t_galaxy', 'trail', 'Галактическая пыль', 25500, 'legendary', 'galaxy'),
    // name colors
    C('n_white', 'nameColor', 'Белый ник', 0, 'common', '#ffffff'),
    C('n_pink', 'nameColor', 'Розовый ник', 450, 'common', '#ff8bd8'),
    C('n_gold', 'nameColor', 'Золотой ник', 2700, 'epic', '#ffd34d'),
    C('n_rainbow', 'nameColor', 'Радужный ник', 13500, 'legendary', 'rainbow'),
    C('n_cyan', 'nameColor', 'Бирюзовый ник', 300, 'common', '#5ff0ff'),
    C('n_green', 'nameColor', 'Зелёный ник', 375, 'common', '#7dff6b'),
    C('n_orange', 'nameColor', 'Оранжевый ник', 450, 'common', '#ffa64d'),
    C('n_red', 'nameColor', 'Красный ник', 750, 'rare', '#ff5a5a'),
    C('n_purple', 'nameColor', 'Фиолетовый ник', 1050, 'rare', '#c38bff'),
    C('n_ice', 'nameColor', 'Ледяной ник', 1500, 'rare', 'ice'),
    C('n_fire', 'nameColor', 'Огненный ник', 3900, 'epic', 'fire'),
    C('n_ocean', 'nameColor', 'Океанский ник', 4500, 'epic', 'ocean'),
    C('n_neon', 'nameColor', 'Неоновый пульс', 5700, 'epic', 'neon'),
    C('n_glitch', 'nameColor', 'Глитч', 18000, 'legendary', 'glitch'),
    // hats
    C('h_none', 'hat', 'Без шапки', 0, 'common', 'none'),
    C('h_cap', 'hat', 'Кепка', 750, 'common', 'cap'),
    C('h_tophat', 'hat', 'Цилиндр', 2250, 'rare', 'tophat'),
    C('h_halo', 'hat', 'Нимб', 4800, 'epic', 'halo'),
    C('h_crown', 'hat', 'Корона', 30000, 'legendary', 'crown'),
    C('h_beanie', 'hat', 'Шапка-бини', 450, 'common', 'beanie'),
    C('h_party', 'hat', 'Праздничный колпак', 675, 'common', 'party'),
    C('h_bunny', 'hat', 'Заячьи ушки', 750, 'common', 'bunny'),
    C('h_cat', 'hat', 'Кошачьи ушки', 1050, 'rare', 'cat'),
    C('h_headphones', 'hat', 'Наушники', 1500, 'rare', 'headphones'),
    C('h_cowboy', 'hat', 'Ковбойская шляпа', 1950, 'rare', 'cowboy'),
    C('h_horns', 'hat', 'Рожки', 3000, 'epic', 'horns'),
    C('h_viking', 'hat', 'Шлем викинга', 4500, 'epic', 'viking'),
    C('h_propeller', 'hat', 'Кепка с пропеллером', 5850, 'epic', 'propeller'),
    C('h_wizard', 'hat', 'Шляпа волшебника', 14250, 'legendary', 'wizard'),
    // collectibles (not sold; example of a non-shop, stackable item)
    { id: 'x_legend_shard', type: 'collectible', cat: 'misc', name: 'Легендарный осколок', rarity: 'legendary', icon: '✦', art: 'shard',
      desc: 'Выпадает из легендарных (1) и мифических (3) сфер и за события. Тратится в «Лавке осколков».', stackable: true, maxStack: 99, base: false, price: null,
      sources: ['arena', 'event', 'admin'] },
    // exclusives: only for legendary shards in «Лавка осколков» (never for orbs)
    X('c_void', 'color', 'Пустота', 108, 'epic', 'void'),
    X('n_shard', 'nameColor', 'Осколочный ник', 78, 'epic', 'shard'),
    X('t_comet', 'trail', 'Хвост кометы', 180, 'epic', 'comet'),
    X('s_crystal', 'shape', 'Кристалл', 48, 'epic', 'crystal'),
    X('h_satellites', 'hat', 'Спутники', 210, 'legendary', 'satellites'),
    X('t_crystal', 'trail', 'Кристальный след', 270, 'legendary', 'crystal'),
    X('c_prism', 'color', 'Призма', 330, 'legendary', 'prism'),
    X('h_shard_crown', 'hat', 'Осколочная корона', 540, 'legendary', 'shardcrown'),
    // final achievement reward: only granted by the server when ALL achievement tiers are done (never sold)
    { id: 'h_trophy', type: 'cosmetic', cat: 'hat', name: 'Кубок', price: null, rarity: 'legendary', value: 'trophy', stackable: false, maxStack: 1, base: false, award: true,
      desc: 'Награда за все достижения. Не продаётся.', sources: ['achievement', 'admin'] },
  ];
  const SHARD_ID = 'x_legend_shard';
  const SHARD_EXCHANGE = { orbs: 25, maxPerTrade: 99 }; // «Лавка осколков»: 1 shard → 25 orbs (was 40) (balance only, not the all-time total)
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
  // Softer curve: maxed farm ≈ ≤1.4× base (magnet no longer vacuums the field). Same names/levels.
  const UPGRADES = {
    magnet: { key: 'magnet', name: 'Магнит', desc: 'Чуть больше радиус сбора сфер', max: 5, prices: [150, 450, 1130, 2630, 5250], values: [0, 4.4, 8.8, 13.2, 16.5, 19.8], unit: 'px' },
    speed: { key: 'speed', name: 'Ускорение', desc: 'Чуть быстрее движение по арене', max: 5, prices: [190, 520, 1350, 3000, 6000], values: [0, 3.3, 5.5, 7.7, 9.9, 12.1], unit: '%' },
    mult: { key: 'mult', name: 'Множитель сфер', desc: 'Каждая сфера приносит чуть больше (дробные части копятся)', max: 5, prices: [260, 680, 1650, 3750, 7500], values: [0, 3.3, 6.6, 9.9, 13.2, 16.5], unit: '%' },
    luck: { key: 'luck', name: 'Удача', desc: 'Шанс ×2 за сферу; с 3-го уровня ещё и «находка»: обычная или необычная сфера становится эпической (+10)', max: 5, prices: [220, 600, 1500, 3380, 6750],
      values: [0, 1.1, 2.2, 3.3, 4.4, 5.5], jackpot: [0, 0, 0, 0.3, 0.4, 0.6], unit: '%' },
    sense: { key: 'sense', name: 'Чутьё легенды', desc: 'Компас: стрелки к самым редким сферам и к событиям', max: 3, prices: [300, 900, 2250], values: [0, 1, 2, 3], unit: '' },
    skill: { key: 'skill', name: 'Мастер мини-игр', desc: 'Бонус к выигрышам в мини-играх', max: 3, prices: [150, 450, 1050], values: [0, 11, 22, 33], unit: '%' },
  };
  // Prices players actually paid before the soft-reset (used once to refund → then upgrades reset to 0)
  const UPGRADE_REFUND_PRICES = {
    magnet: [300, 900, 2400, 5500, 11000], speed: [400, 1100, 2800, 6000, 12000], mult: [600, 1600, 3800, 8000, 15000],
    luck: [500, 1400, 3400, 7000, 13000], sense: [500, 1500, 4000], skill: [300, 900, 2000],
  };
  const UPGRADE_KEYS = Object.keys(UPGRADES);
  const SENSE_TEXT = ['нет', 'стрелки к легендарной и мифической сферам', '+ стрелка к ближайшей эпической, расстояния', '+ стрелки к целям событий'];
  const SENSE_EPIC_RANGE = 1500; // «Чутьё легенды» 2+: nearest epic orb within this distance
  const upLevel = (key, level) => Math.max(0, Math.min(UPGRADES[key].max, Math.floor(Number(level) || 0))); // caps any stored value
  const upValue = (key, level) => UPGRADES[key].values[upLevel(key, level)];
  const jackpotChance = level => UPGRADES.luck.jackpot[upLevel('luck', level)]; // % per common/uncommon pickup
  function upgradeText(key, level) {
    const u = UPGRADES[key], v = upValue(key, level);
    if (key === 'magnet') return `радиус ${Math.round(PLAYER_R + v)} px` + (v ? ` (+${String(v).replace('.', ',')})` : '');
    if (key === 'speed') return `скорость ${Math.round(BASE_SPEED * (1 + v / 100))}` + (v ? ` (+${String(v).replace('.', ',')}%)` : '');
    if (key === 'mult') return `×${(1 + v / 100).toFixed(2)} за сферу`;
    if (key === 'luck') { const j = jackpotChance(level); return `${String(v).replace('.', ',')}% шанс ×2` + (j ? ` · ${String(j).replace('.', ',')}% находка +10` : ''); }
    if (key === 'sense') return SENSE_TEXT[upLevel(key, level)];
    if (key === 'skill') return `+${v}% к выигрышу`; // values ×1.1 since Oct 2026 (11/22/33)
    return String(v) + u.unit;
  }

  // Mini-games are for fun and skill, not a better income than collecting orbs (see README "Economy").
  // Prizes ≈ 2× (Oct 2026) with a 100 s pause per game: flawless rotation of all 6 with «Мастер» 3 ≈ 100/min < zone-1 farming (~112/min).
  const MINIGAMES = {
    reaction: { key: 'reaction', name: 'Реакция', fee: 10, cooldownMs: 100000 },
    rush: { key: 'rush', name: 'Сферный шторм', fee: 20, duration: 20000, w: 600, h: 400, payoutRate: 1.5, maxPrize: 80, cooldownMs: 100000 },
    // «Память»: repeat a growing sequence of 4 coloured orbs; prize 6 per round after the first 2, cap 60 (12 rounds)
    memory: { key: 'memory', name: 'Память', fee: 10, cooldownMs: 100000, colors: 4, maxRounds: 12, onMs: 450, gapMs: 200, leadMs: 700, pauseMs: 500,
      minInputMs: 120, inputMsPerStep: 1200, inputBaseMs: 3000, freeRounds: 2, perRound: 6, maxPrize: 60 },
    // «Угадай чашу»: follow the orb under 3 cups; win = 22 (fee 10) → blind guessing loses (EV 7.3, 9.5 with «Мастер» 3), perfect tracking stays far below farming
    shell: { key: 'shell', name: 'Угадай чашу', fee: 10, prize: 22, maxPrize: 22, cooldownMs: 100000, cups: 3, swaps: 9, showMs: 1000, swapMsFrom: 420, swapMsTo: 220, pickTimeoutMs: 8000 },
    // «Точный бросок»: 3 throws, stop the marker in the target; points by distance (bar = 0..1), prize 160 % of points, cap 48
    throw: { key: 'throw', name: 'Точный бросок', fee: 10, cooldownMs: 100000, throws: 3, points: [[0.015, 10], [0.035, 7], [0.06, 4], [0.1, 1]], payoutRate: 1.6, maxPrize: 48,
      periodMin: 1300, periodMax: 1800, minStopMs: 250, gapMs: 900, throwTimeoutMs: 6000 },
    // «Цепочка»: tap orbs 1..8 in order; prize by time
    chain: { key: 'chain', name: 'Цепочка', fee: 10, cooldownMs: 100000, n: 8, w: 600, h: 400, r: 28, countdownMs: 1200, limitMs: 15000, minTapGapMs: 120,
      prizes: [[3500, 36], [4500, 28], [6000, 20], [8000, 12], [10000, 6]], maxPrize: 36 },
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
  const REACTION_PRIZES = [ [250, 32], [320, 24], [400, 20], [550, 12], [750, 6] ]; // [ms threshold, prize]
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
    if (lvl >= 3 && ev && ev.runners) for (const r of ev.runners) out.push({ x: r.x, y: r.y, kind: 'event' });
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
    treasure: { key: 'treasure', name: 'Охота за сокровищем', icon: '💰', durationMs: 120000, count: 5, maxCount: 5, minDist: 900,
      desc: 'По всей карте в случайных местах спрятаны 5 сфер-сокровищ. Кто первым схватит — получит награду!', reward: { orbs: 50, shards: 1 } },
    runner: { key: 'runner', name: 'Раннеры', icon: '💨', durationMs: 90000, count: 3, speed: 150, wander: 70, r: 30, touchPad: 80, historyMs: 600, fleeRange: 450, catchPad: 12, tireEveryMs: 5000, restMs: 1500, restSpeed: 0.35, spawnNear: [900, 1600],
      desc: 'По карте носятся 3 Раннера — они убегают от игроков. Каждый пойманный Раннер — награда!', reward: { orbs: 80, shards: 1 } },
    lucky: { key: 'lucky', name: 'Волна удачи', icon: '🍀', durationMs: 75000, spawnMult: 1.25, rareMult: 2,
      desc: '75 секунд на карте на 25 % больше сфер, а шанс редких, эпических, легендарных и мифических сфер удвоен (×2)!' },
  };
  const EVENT_KEYS = Object.keys(EVENTS);
  const AUTO_EVENT_KEYS = ['treasure', 'runner', 'lucky']; // the scheduler only picks these (rain / koth stay off)
  const EVENT_SCHEDULE = { minMs: 2 * 60000, maxMs: 6 * 60000, announceMs: 25000 }; // counted only while ≥ 1 player is online

  // «Волна удачи»: rare+ tiers (r, e, l, m) weigh ×rareMult
  const luckyWeights = (w, k = EVENTS.lucky.rareMult) => { const o = {}; for (const t in w) o[t] = 'relm'.includes(t) ? w[t] * k : w[t]; return o; };

  // ---------------------------------------------------------------- temporary obstacles (server spawns, everyone collides)
  // kinds: 'wall' (long thin rect), 'block' (square-ish rect), 'rock' (circle), 'laser' (solid pylon + spinning beam)
  const OBSTACLES = { maxAlive: 30, everyMinMs: 6000, everyMaxMs: 15000, lifeMinMs: 45000, lifeMaxMs: 90000, laserChance: 0.25,
    warnMs: 3000, playerClear: 380, doorClear: 300, gap: 450, pylonR: 26, beamMin: 240, beamMax: 340, spinMin: 0.8, spinMax: 1.3,
    penaltyPct: 0.07, penaltyMax: 150, invulnMs: 3000, dropMax: 10, dropLifeMs: 30000,
    // iron robot (own timer, separate from obstacles: 30 % roll every 45–90 s): rare solid player-shaped obstacle that shoots slow shots at players in range (shared immunity with lasers)
    robotChance: 0.3, robotEveryMinMs: 45000, robotEveryMaxMs: 90000, robotMax: 2, robotR: 30, robotRange: 500, aimMs: 700, shotEveryMin: 1500, shotEveryMax: 2000,
    shotSpeed: 260, shotR: 9, shotLifeMs: 2600, robotPct: 0.05, robotCap: 100 };
  const robotPenalty = balance => (balance >= 1 ? Math.min(OBSTACLES.robotCap, Math.max(1, Math.round(balance * OBSTACLES.robotPct))) : 0);
  // weekend bonus: Saturday + Sunday in Europe/Moscow (UTC+3, no DST) → orbs from collecting ×1.5
  const WEEKEND = { mult: 1.5, offsetMs: 3 * 3600000, name: 'Выходные', icon: '🎉', desc: 'Выходные: x1.5 орбов' };
  function weekendInfo(now = Date.now()) {
    const t = now + WEEKEND.offsetMs, day = new Date(t).getUTCDay(); // 0 = Sunday, 6 = Saturday (Moscow local)
    if (day !== 0 && day !== 6) return { on: false, left: 0 };
    const midnight = Math.floor(t / 86400000) * 86400000, end = midnight + (day === 6 ? 2 : 1) * 86400000; // Monday 00:00 MSK
    return { on: true, left: end - t };
  }
  const laserAngle = (o, now) => o.a0 + o.w * (now - o.t0) / 1000;
  // pushes a player circle out of every solid obstacle (rects axis-aligned; lasers: only the pylon is solid)
  function resolveObstacles(pos, list) {
    if (!list) return;
    for (const o of list) {
      if (o.k === 'rect') {
        const hx = o.w / 2, hy = o.h / 2, cx = Math.max(o.x - hx, Math.min(o.x + hx, pos.x)), cy = Math.max(o.y - hy, Math.min(o.y + hy, pos.y));
        let dx = pos.x - cx, dy = pos.y - cy; const d = Math.hypot(dx, dy);
        if (d >= PLAYER_R) continue;
        if (d > 1e-6) { pos.x = cx + dx / d * PLAYER_R; pos.y = cy + dy / d * PLAYER_R; continue; }
        const px = hx - Math.abs(pos.x - o.x), py = hy - Math.abs(pos.y - o.y); // centre inside: shortest way out
        if (px < py) pos.x = o.x + Math.sign(pos.x - o.x || 1) * (hx + PLAYER_R); else pos.y = o.y + Math.sign(pos.y - o.y || 1) * (hy + PLAYER_R);
      } else {
        const r = o.r + PLAYER_R, dx = pos.x - o.x, dy = pos.y - o.y, d = Math.hypot(dx, dy);
        if (d >= r) continue;
        if (d < 1e-6) { pos.x = o.x + r; continue; }
        pos.x = o.x + dx / d * r; pos.y = o.y + dy / d * r;
      }
    }
  }
  // is a point (player centre) touched by an armed laser beam?
  function laserHits(o, x, y, now, pad = PLAYER_R) {
    if (o.k !== 'laser' || now < o.armAt) return false;
    const a = laserAngle(o, now), ex = Math.cos(a), ey = Math.sin(a);
    const t = Math.max(0, Math.min(o.len, (x - o.x) * ex + (y - o.y) * ey));
    return Math.hypot(o.x + ex * t - x, o.y + ey * t - y) <= pad;
  }
  const laserPenalty = balance => (balance >= 1 ? Math.min(OBSTACLES.penaltyMax, Math.max(1, Math.round(balance * OBSTACLES.penaltyPct))) : 0);

  const skillPrize = (prize, level) => prize > 0 ? Math.round(prize * (1 + upValue('skill', level) / 100)) : prize;

  // Apply one movement input step (STEP_DT seconds). dx,dy is a direction vector with length <= 1.
  // Player pushing (server-authoritative): players are solid circles. Overlaps are split so that whoever walks INTO the
  // other gets the smaller share — a moving player shoves a standing one (at ≈ 2/3 speed); two players pushing head-on
  // stall. «Ускорение» gives at most +2 % push strength per level. A light knockback (≤ PUSH.maxKnock px/tick, decays)
  // pops the shoved player away. Everything stays inside the world.
  const PUSH = { knock: 2.5, maxKnock: 5, decay: 0.7, speedEdge: 0.02, passes: 2 };
  // «Бонусный портал»: a small room outside the arena (below zone 1); whoever is in it stays in it until the server moves them back
  const BONUS_ROOM = { x: 400, y: WORLD.h + 600, w: 1100, h: 800 };
  const inBonusRoom = p => p.y > WORLD.h + 100;
  const clampRoom = p => { p.x = Math.min(BONUS_ROOM.x + BONUS_ROOM.w - PLAYER_R, Math.max(BONUS_ROOM.x + PLAYER_R, p.x)); p.y = Math.min(BONUS_ROOM.y + BONUS_ROOM.h - PLAYER_R, Math.max(BONUS_ROOM.y + PLAYER_R, p.y)); };
  const clampP = p => { if (inBonusRoom(p)) return clampRoom(p); p.x = Math.min(WORLD.w - PLAYER_R, Math.max(PLAYER_R, p.x)); p.y = Math.min(WORLD.h - PLAYER_R, Math.max(PLAYER_R, p.y)); };
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
    if (inBonusRoom(pos)) { clampRoom(pos); return; }
    if (pos.x < PLAYER_R) pos.x = PLAYER_R;
    if (pos.y < PLAYER_R) pos.y = PLAYER_R;
    if (pos.x > WORLD.w - PLAYER_R) pos.x = WORLD.w - PLAYER_R;
    if (pos.y > WORLD.h - PLAYER_R) pos.y = WORLD.h - PLAYER_R;
  }

  const api = {
    WORLD, ZONE_W, ZONE_H, DOOR, doorDist, DOOR_COST, ZONE2_WEIGHTS, zoneOf, zoneGate, PLAYER_R, BASE_SPEED, TICK_MS, STEP_DT, ORB_TYPES, ORB_RANK, ORB_LEGEND, POOL_WEIGHTS, RAIN_WEIGHTS, rollOrbType, expectedOrbValue, CATEGORIES, INV_CATEGORIES, RARITIES, ITEMS, ITEM_BY_ID, INV_SLOTS, INV_CAP, BUY_MAX_QTY, PAINTS,
    DEFAULT_EQUIPPED, DEFAULT_OWNED, UPGRADES, UPGRADE_KEYS, UPGRADE_REFUND_PRICES, upLevel, upValue, jackpotChance, upgradeText, orbReward, skillPrize, compassTargets, SENSE_EPIC_RANGE, RADAR, radarBlips, PUSH, separatePlayers,
    EVENTS, EVENT_KEYS, AUTO_EVENT_KEYS, EVENT_SCHEDULE, luckyWeights, OBSTACLES, laserAngle, resolveObstacles, laserHits, laserPenalty, robotPenalty, WEEKEND, weekendInfo, SHARD_ID, SHARD_EXCHANGE,
    MINIGAMES, REACTION_PRIZES, rushPrize, memoryPrize, memoryShowMs, shellFinal, shellShuffleMs, throwPos, throwPoints, throwPrize, chainPrize, minigameMinMs, speedFor, pickupFor, applyInput, BONUS_ROOM, inBonusRoom,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.G = api;
})(typeof window !== 'undefined' ? window : this);
