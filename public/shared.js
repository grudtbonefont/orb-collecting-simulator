// Shared constants and logic (used by both server and browser client)
(function (root) {
  const WORLD = { w: 3000, h: 3000 };
  const PLAYER_R = 20;
  const BASE_SPEED = 230; // px per second
  const TICK_MS = 50;     // 20 ticks per second
  const STEP_DT = TICK_MS / 1000;

  const ORB_TYPES = {
    c: { key: 'c', name: 'Обычная', value: 1, r: 7, color: '#3ee0ff', glow: 'rgba(62,224,255,', weight: 85 },
    r: { key: 'r', name: 'Редкая', value: 5, r: 10, color: '#b46bff', glow: 'rgba(180,107,255,', weight: 13 },
    l: { key: 'l', name: 'Легендарная', value: 25, r: 14, color: '#ffcc33', glow: 'rgba(255,204,51,', weight: 2 },
  };

  const CATEGORIES = [
    { key: 'color', name: 'Цвета' },
    { key: 'shape', name: 'Формы' },
    { key: 'trail', name: 'Следы' },
    { key: 'nameColor', name: 'Цвет ника' },
    { key: 'hat', name: 'Шапки' },
  ];

  const ITEMS = [
    // colors
    { id: 'c_cyan', cat: 'color', name: 'Бирюзовый', price: 0, value: '#3ee0ff' },
    { id: 'c_coral', cat: 'color', name: 'Коралловый', price: 25, value: '#ff6b6b' },
    { id: 'c_lime', cat: 'color', name: 'Лаймовый', price: 25, value: '#9dff4f' },
    { id: 'c_violet', cat: 'color', name: 'Фиолетовый', price: 50, value: '#a66bff' },
    { id: 'c_pink', cat: 'color', name: 'Неоново-розовый', price: 75, value: '#ff5fd2' },
    { id: 'c_gold', cat: 'color', name: 'Золотой', price: 250, value: '#ffcc33' },
    { id: 'c_rainbow', cat: 'color', name: 'Радужный', price: 600, value: 'rainbow' },
    // shapes
    { id: 's_circle', cat: 'shape', name: 'Круг', price: 0, value: 'circle' },
    { id: 's_square', cat: 'shape', name: 'Квадрат', price: 80, value: 'square' },
    { id: 's_triangle', cat: 'shape', name: 'Треугольник', price: 120, value: 'triangle' },
    { id: 's_hexagon', cat: 'shape', name: 'Шестиугольник', price: 180, value: 'hexagon' },
    { id: 's_star', cat: 'shape', name: 'Звезда', price: 300, value: 'star' },
    // trails
    { id: 't_none', cat: 'trail', name: 'Без следа', price: 0, value: 'none' },
    { id: 't_sparks', cat: 'trail', name: 'Искры', price: 100, value: 'sparks' },
    { id: 't_neon', cat: 'trail', name: 'Неоновый шлейф', price: 200, value: 'neon' },
    { id: 't_fire', cat: 'trail', name: 'Огненный след', price: 400, value: 'fire' },
    // name colors
    { id: 'n_white', cat: 'nameColor', name: 'Белый ник', price: 0, value: '#ffffff' },
    { id: 'n_pink', cat: 'nameColor', name: 'Розовый ник', price: 40, value: '#ff8bd8' },
    { id: 'n_gold', cat: 'nameColor', name: 'Золотой ник', price: 150, value: '#ffd34d' },
    { id: 'n_rainbow', cat: 'nameColor', name: 'Радужный ник', price: 450, value: 'rainbow' },
    // hats
    { id: 'h_none', cat: 'hat', name: 'Без шапки', price: 0, value: 'none' },
    { id: 'h_cap', cat: 'hat', name: 'Кепка', price: 90, value: 'cap' },
    { id: 'h_tophat', cat: 'hat', name: 'Цилиндр', price: 220, value: 'tophat' },
    { id: 'h_halo', cat: 'hat', name: 'Нимб', price: 350, value: 'halo' },
    { id: 'h_crown', cat: 'hat', name: 'Корона', price: 500, value: 'crown' },
  ];
  const ITEM_BY_ID = {};
  for (const it of ITEMS) ITEM_BY_ID[it.id] = it;

  const DEFAULT_EQUIPPED = { color: 'c_cyan', shape: 's_circle', trail: 't_none', nameColor: 'n_white', hat: 'h_none' };
  const DEFAULT_OWNED = ITEMS.filter(i => i.price === 0).map(i => i.id);

  const UPGRADES = {
    magnet: { key: 'magnet', name: 'Магнит', desc: '+14 к радиусу сбора сфер за уровень', max: 5, prices: [40, 100, 200, 350, 550] },
    speed: { key: 'speed', name: 'Ускорение', desc: '+6% к скорости за уровень', max: 5, prices: [60, 150, 300, 500, 800] },
  };

  const MINIGAMES = {
    reaction: { key: 'reaction', name: 'Реакция', fee: 10 },
    rush: { key: 'rush', name: 'Сферный шторм', fee: 15, duration: 20000, w: 600, h: 400 },
  };
  const REACTION_PRIZES = [ [300, 25], [400, 18], [550, 12], [800, 6] ]; // [ms threshold, prize]

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
    WORLD, PLAYER_R, BASE_SPEED, TICK_MS, STEP_DT, ORB_TYPES, CATEGORIES, ITEMS, ITEM_BY_ID,
    DEFAULT_EQUIPPED, DEFAULT_OWNED, UPGRADES, MINIGAMES, REACTION_PRIZES, speedFor, pickupFor, applyInput,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.G = api;
})(typeof window !== 'undefined' ? window : this);
