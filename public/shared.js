// Shared constants and logic (used by both server and browser client)
(function (root) {
  const WORLD = { w: 3000, h: 3000 };
  const PLAYER_R = 20;
  const BASE_SPEED = 230; // px per second
  const TICK_MS = 50;     // 20 ticks per second
  const STEP_DT = TICK_MS / 1000;

  const ORB_TYPES = {
    c: { key: 'c', name: 'Обычная', value: 1, r: 7, color: '#3ee0ff', glow: 'rgba(62,224,255,', weight: 90 },
    r: { key: 'r', name: 'Редкая', value: 5, r: 10, color: '#b46bff', glow: 'rgba(180,107,255,', weight: 10 },
    l: { key: 'l', name: 'Легендарная', value: 25, r: 14, color: '#ffcc33', glow: 'rgba(255,204,51,', weight: 0 },
  };

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
  const C = (id, cat, name, price, rarity, value) => ({ id, type: 'cosmetic', cat, name, price, rarity, value,
    stackable: false, maxStack: 1, base: price === 0, sources: price === 0 ? ['base'] : ['shop', 'event', 'admin'] });
  const ITEMS = [
    // colors
    C('c_cyan', 'color', 'Бирюзовый', 0, 'common', '#3ee0ff'),
    C('c_coral', 'color', 'Коралловый', 150, 'common', '#ff6b6b'),
    C('c_lime', 'color', 'Лаймовый', 150, 'common', '#9dff4f'),
    C('c_violet', 'color', 'Фиолетовый', 400, 'rare', '#a66bff'),
    C('c_pink', 'color', 'Неоново-розовый', 700, 'rare', '#ff5fd2'),
    C('c_gold', 'color', 'Золотой', 2400, 'epic', '#ffcc33'),
    C('c_rainbow', 'color', 'Радужный', 15000, 'legendary', 'rainbow'),
    // shapes
    C('s_circle', 'shape', 'Круг', 0, 'common', 'circle'),
    C('s_square', 'shape', 'Квадрат', 400, 'common', 'square'),
    C('s_triangle', 'shape', 'Треугольник', 800, 'rare', 'triangle'),
    C('s_hexagon', 'shape', 'Шестиугольник', 1400, 'rare', 'hexagon'),
    C('s_star', 'shape', 'Звезда', 4000, 'epic', 'star'),
    // trails
    C('t_none', 'trail', 'Без следа', 0, 'common', 'none'),
    C('t_sparks', 'trail', 'Искры', 1000, 'rare', 'sparks'),
    C('t_neon', 'trail', 'Неоновый шлейф', 2800, 'epic', 'neon'),
    C('t_fire', 'trail', 'Огненный след', 12000, 'legendary', 'fire'),
    // name colors
    C('n_white', 'nameColor', 'Белый ник', 0, 'common', '#ffffff'),
    C('n_pink', 'nameColor', 'Розовый ник', 300, 'common', '#ff8bd8'),
    C('n_gold', 'nameColor', 'Золотой ник', 1800, 'epic', '#ffd34d'),
    C('n_rainbow', 'nameColor', 'Радужный ник', 9000, 'legendary', 'rainbow'),
    // hats
    C('h_none', 'hat', 'Без шапки', 0, 'common', 'none'),
    C('h_cap', 'hat', 'Кепка', 500, 'common', 'cap'),
    C('h_tophat', 'hat', 'Цилиндр', 1500, 'rare', 'tophat'),
    C('h_halo', 'hat', 'Нимб', 3200, 'epic', 'halo'),
    C('h_crown', 'hat', 'Корона', 20000, 'legendary', 'crown'),
    // collectibles (not sold; example of a non-shop, stackable item)
    { id: 'x_legend_shard', type: 'collectible', cat: 'misc', name: 'Легендарный осколок', rarity: 'legendary', icon: '✦',
      desc: 'Выпадает из легендарных сфер. Пока коллекционный.', stackable: true, maxStack: 99, base: false, price: null,
      sources: ['arena', 'event', 'admin'] },
  ];
  const ITEM_BY_ID = {};
  for (const it of ITEMS) ITEM_BY_ID[it.id] = it;
  const INV_SLOTS = 100;
  const INV_CATEGORIES = CATEGORIES.concat([{ key: 'misc', name: 'Прочее' }]);

  const DEFAULT_EQUIPPED = { color: 'c_cyan', shape: 's_circle', trail: 't_none', nameColor: 'n_white', hat: 'h_none' };
  const DEFAULT_OWNED = ITEMS.filter(i => i.base).map(i => i.id);

  // Upgrades are optional: each level costs more, the bonus is a convenience, not a requirement.
  const UPGRADES = {
    magnet: { key: 'magnet', name: 'Магнит', desc: '+14 к радиусу сбора сфер за уровень', max: 5, prices: [300, 700, 1500, 3000, 6000] },
    speed: { key: 'speed', name: 'Ускорение', desc: '+6% к скорости за уровень', max: 5, prices: [400, 900, 1800, 3600, 7200] },
  };

  // Mini-games are for fun and skill, not a better income than collecting orbs (see README "Economy").
  const MINIGAMES = {
    reaction: { key: 'reaction', name: 'Реакция', fee: 10, cooldownMs: 15000 },
    rush: { key: 'rush', name: 'Сферный шторм', fee: 20, duration: 20000, w: 600, h: 400, payoutRate: 0.75, maxPrize: 40, cooldownMs: 20000 },
  };
  const REACTION_PRIZES = [ [250, 16], [320, 12], [400, 10], [550, 6], [750, 3] ]; // [ms threshold, prize]
  const rushPrize = score => Math.max(0, Math.min(MINIGAMES.rush.maxPrize, Math.floor(score * MINIGAMES.rush.payoutRate)));

  function speedFor(level) { return BASE_SPEED * (1 + 0.06 * (level || 0)); }
  function pickupFor(level) { return PLAYER_R + 14 * (level || 0); }

  // Apply one movement input step (STEP_DT seconds). dx,dy is a direction vector with length <= 1.
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
    WORLD, PLAYER_R, BASE_SPEED, TICK_MS, STEP_DT, ORB_TYPES, CATEGORIES, INV_CATEGORIES, RARITIES, ITEMS, ITEM_BY_ID, INV_SLOTS,
    DEFAULT_EQUIPPED, DEFAULT_OWNED, UPGRADES, MINIGAMES, REACTION_PRIZES, rushPrize, speedFor, pickupFor, applyInput,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.G = api;
})(typeof window !== 'undefined' ? window : this);
