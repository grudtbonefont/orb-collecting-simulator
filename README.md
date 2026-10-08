# Orb Collecting Simulator

Multiplayer browser game: collect glowing orbs in a shared arena, spend them on cosmetics, upgrades and mini-games, chat with other players and climb the all-time leaderboard.
Stack: Node.js + Express 5 + Socket.IO (server-authoritative, 20 ticks/s), HTML5 canvas + vanilla JS client (no build step). UI language: Russian.

## Accounts
- Register / log in with **nickname + password** (screen «Вход» / «Регистрация»).
- Nickname: 3–20 characters, only `A–Z a–z 0–9 _`, at most one `_`, not at the start or end; unique case-insensitively (display case is kept); a small profanity / reserved-word filter applies.
- Password: 6–72 characters (≤ 72 bytes), stored only as a bcrypt hash (cost 10).
- After login the server issues a random 256-bit session token (only its SHA-256 is stored, 30-day sliding expiry) kept in `localStorage`; «Выйти» deletes it server-side. One game connection per account (a new login kicks the old tab).
- Brute-force protection: 5 failed attempts → 1-minute lockout, per connection and per nickname.
- Balance, all-time total, inventory, equipped cosmetics, upgrades and stats persist per account.

## Profile screen
Opening the site with a valid saved session (and right after logging in) shows the **profile** before the arena: nickname with a live preview of the equipped look, balance, all-time total, leaderboard rank, account creation date, play time, number of sessions, items / used inventory slots, best mini-game results (best reaction time, best «Сферный шторм» score, games played) and upgrade levels. Buttons: **Играть** (enter the arena), **Инвентарь**, **Выйти**. In game it opens with the 👤 name button in the HUD or **P** (Esc / ✕ / «Продолжить» close it). Phones get a 2-column layout. Data comes from `session` / `profile:get` (owner only; rank from persisted totals).

## Inventory
**Capacity: 450 items in total, counting every unit in a stack** (`G.INV_CAP`; a stack of 10 uses 10). Stacks only group items (≤ 99 each, any number of stacks). The inventory header shows «123 / 450». `grantItem` is all-or-nothing at the cap (shop, shard shop, events, drops all refuse with «Инвентарь полон (450 / 450)»). Duplicates of cosmetics are allowed and stack (you wear one). Accounts migrated from the old 100-slot model keep every item even above 450; new grants are refused until they are under the cap.

**Multi-buy:** each shop card (orb shop and «Лавка осколков») has − / qty / + / Макс and «Купить ×N · total». Server: `buy(id, qty)` / `shard:buy(id, qty)`, qty integer 1–99 (code `qty`), enough orbs (`funds`) / shards (`shards`), enough space (`full`); atomic. Screenshots: `screenshot-inventory-450.png`, `screenshot-shop-qty.png`.

- **Инвентарь** button or **I** (also from the profile screen). 100 slots; tabs per category (Цвета, Формы, Следы, Цвет ника, Шапки, Прочее); cards show the item icon, rarity, quantity badge and where the item came from; **Надеть / Снять** equip and unequip (unequip returns to the free default item of that category). Phones: bottom sheet with a 3-column grid.
- Item model (`public/shared.js`): `{ id, type: 'cosmetic' | 'collectible', cat, name, rarity: common | rare | epic | legendary, stackable, maxStack, price, sources[] }`. Cosmetics are unique (`maxStack` 1); stackable items take up to **99 per slot** (example: «Легендарный осколок», dropped by legendary orbs). Free default items (price 0) are always owned and never take a slot.
- Stored compactly per account: `inventory = { v: 1, slots: [{ id, q, src, at }] }` — a `JSONB` column in Postgres, a field in the JSON file.
- Every item enters through one server function, `grantItem(account, itemId, qty, source)` (`lib/inventory.js`), which validates item, quantity and source (`shop`, `minigame`, `arena`, `event`, `admin`, `legacy`), refuses duplicates of unique items and refuses atomically when the items don't fit («Инвентарь полон (100 ячеек). Освободите место.»). The shop and the legendary-orb drop both use it and record the source.
- The shop only **sells**: a purchase goes into the inventory (not auto-equipped); buying with a full inventory is refused before any orbs are taken. Equip / unequip / buy are validated server-side (ownership, category, type).
- **Trash (delete items):** every inventory card has a 🗑 button (desktop also: drag a card onto the «🗑 Корзина» zone). A confirmation «Удалить навсегда? Это нельзя отменить. Сферы не возвращаются.» follows; for stacks the player picks how many (−/+ buttons, number field, slider, «Все»; capped at the stack size). Deleting an equipped item takes it off (the free default of that slot comes back; the dialog warns about it). Free default items are never in the inventory and cannot be deleted. No refund; deleted shop items can be bought again.
- Server: `inv:trash { id, qty, slot? }` → `removeItem(account, itemId, qty, reason, slotIndex?)` in `lib/inventory.js`, the counterpart of `grantItem` (reasons `trash`, `admin`, `use`). It validates the item, exact integer quantity (1…owned, ≤ the slot when a slot is given, exactly 1 for unique items) and that the slot really holds that item, removes all-or-nothing, frees emptied slots, unequips if needed and keeps the legacy `owned` list in sync (so a deleted item is not resurrected by the migration reconcile). Rate limit: 8 deletions per 5 s per connection. The account is flushed to storage before the reply.

### Cosmetics catalog
75 items: 17 colours, 14 shapes, 14 trails, 14 nickname colours, 15 hats (5 of them free defaults) + the legendary shard. All drawn by the shared arena renderer (`drawAvatar` / `drawTrail` / `drawHat` / `drawNameTag` in `public/client.js`), so every player sees the same look.
- Multi-colour values (`G.PAINTS` in `public/shared.js`: sunset, aurora, galaxy, lava, ice, fire, ocean, neon, glitch) slowly cycle their colours in the arena (one interpolated colour per frame); galaxy adds twinkling stars, lava ember glow + crust, neon a pulsing glow, glitch an RGB-split flicker. Chat and the leaderboard show them as gradients / glow.
- New shapes (diamond, pentagon, octagon, drop, cross, heart, rotating gear, flower, wobbling jelly), trails (smoke, bubbles, pixels, leaves, snow, hearts, stars, lightning, rainbow ribbon, galaxy dust) and hats (beanie, party hat, bunny / cat ears, headphones, cowboy hat, horns, viking helmet, propeller cap with a spinning propeller, wizard hat with twinkling stars).
- Performance: new trails use only plain fills/strokes (no per-point gradients or shadow blur), draw every second point for the larger particles and are deterministic from each point's seed (no `Math.random` while drawing); the trail buffer is unchanged (≤ 26 points, 650 ms).
- The look of the original 25 items is unchanged.

### Shop
Category tabs + a rarity filter (chips with counts), sorting (cheapest / most expensive first, by rarity, by name) and «Скрыть купленные»; the filter and sort stay active across categories. Phones: the tabs and rarity chips scroll sideways, 3-column grid. The «⚡ Улучшения» tab shows each upgrade with its icon, level pips, current effect → next level and the cost.

### Item icons
Every item has its own icon, drawn in the browser with the game's own renderer so it matches the arena: colors = the player body in that color (rainbow as a full gradient), shapes = the body in that shape (neutral silver), trails = a small body with the trail effect behind it, nickname colors = an «Aa» tag in that color/effect, hats = the body wearing the hat, the legendary shard = a gold crystal; free defaults get their own variant (e.g. dashed outline / crossed-out trail). Icons sit in a rarity-coloured frame with a glow (`.ico`, `--rc`).
- Data-driven (`ICON_ART` in `public/client.js`): cosmetics are drawn by `cat` + `value`, collectibles by their `art` key (e.g. `art: 'shard'`), so new items granted from any source get an icon automatically; unknown art or ids fall back to a rarity-coloured gem with the item's `icon` glyph (or «?»).
- Generated lazily, once per item, at `devicePixelRatio` (max 2) on a 96 px offscreen canvas and cached as PNG `data:` URLs (already allowed by the CSP's `img-src 'self' data:`, no external images).
- Used in the inventory grid, the trash confirmation, shop cards and the profile («надето»: 5 icons of the equipped items next to the animated avatar preview). Upgrades have their own icons (`u_magnet`, `u_speed`, …).

### Migration of existing accounts (no data loss)
Accounts from the previous version have an `owned` list instead of an inventory. On startup the server migrates them:
- Postgres: `ALTER TABLE ocs_accounts ADD COLUMN IF NOT EXISTS inventory JSONB`, then in one transaction every row with `inventory IS NULL` (`SELECT … FOR UPDATE`) gets an inventory built from `owned` (source `legacy`; unknown ids dropped, free items implicit). Nicknames, password hashes, balances, totals, equipped items, upgrades, stats and sessions are untouched (existing tokens keep working).
- JSON file: same conversion when the file is loaded; the file is rewritten once.
- The old `owned` column / field is **kept and kept in sync** (derived from the inventory) so a rollback to the previous build still works. If the previous build is still running during a zero-downtime deploy and records a purchase in `owned` only, the item is reconciled into the inventory the next time the account is loaded.
- Covered by `npm test`: an account in the old format (old Postgres schema from 7c2dacd and an old JSON file) is migrated, logs in with its old password and old session token, keeps everything, and a later write by the old build is reconciled.

## Storage
`lib/storage.js` picks the backend at startup:
- **PostgreSQL** when `DATABASE_URL` is set (`pg`). Tables `ocs_accounts` / `ocs_sessions` are created automatically. TLS: off first for hosts without a dot (Render internal URLs such as `dpg-xxxx-a`), on (`rejectUnauthorized:false`) first for external hosts; the other mode is tried as a fallback. Override with `DATABASE_SSL=true|false`.
- **JSON file** otherwise (local dev): `data/accounts.json` (override with `DATA_FILE`).

Live gameplay state is in memory; changed accounts are flushed in batches every 3 s, right after purchases/disconnects, and on SIGTERM/SIGINT (graceful shutdown). The leaderboard reads persisted all-time totals. `GET /api/health` reports which storage is active.

## Chat
Global arena chat (logged-in players only), last 50 messages are sent on join, join/leave system lines.
- **Silent auto-clear every 15 minutes** on a fixed wall-clock cycle (:00, :15, :30, :45 server time): the server wipes the history and broadcasts an empty `chat:clear`; clients simply empty the log. Players are never shown the schedule or a «cleared» notice, and the next-clear time is not sent to clients. Interval configurable with `CHAT_CLEAR_MS` (tests use 3–4 s).
- Desktop: compact panel bottom-left. **Enter** or **T** focuses it, **Enter** sends, **Esc** leaves. While typing, movement keys and hotkeys are ignored.
- Phones / touch / narrow screens (≤ 760 px or coarse pointer): a 💬 button with an unread badge; tap opens a full-screen sheet (sized to the visual viewport so the on-screen keyboard doesn't hide the input), ✕ returns to the game. New messages flash as a small toast at the top.
- Moderation (server-side): 120 chars max, 1 message / 1.5 s and 5 / 10 s, no duplicates, control / invisible / bidi characters stripped, links, domains, e-mails, IP addresses and phone-like numbers → `***`, basic RU/EN profanity → `***`, repeated-character spam collapsed. Rendered with `textContent` only.

## Orb spawning (server-authoritative, `SPAWN` in `server.js`)
| setting | value |
|---|---|
| target orbs on the field | `clamp(70 + 30 × players online, 90, 320)` → 90 when empty, 160 with 3 players, 320 from 9 players |
| world / grid | 3000 × 3000 px split into 10 × 10 cells of 300 px |
| placement | best-of-6 emptiest random cells, then up to 8 random points per cell (Poisson-disc-like): ≥ 70 px from any other orb, ≥ 220 px from every player |
| rarity | see «Orb rarities» below |
| refill | a collected orb respawns 3–9 s later somewhere else; orbs added because more players joined fade in over ~4 s; ≤ 4 spawns per tick |
| legendary (+25) | timed event, never part of the normal pool: first one 60 s after start, then every 90–150 s (only while someone is online), at most 1 alive, disappears after 75 s, announced to everyone; picking it up also grants a «Легендарный осколок» |

Previously 380 orbs refilled instantly with 2 % legendaries regardless of player count; now the field scales with the player count and is evenly spread. `GET /api/health` shows `orbs` and `targetOrbs`.

## Orb rarities (`G.ORB_TYPES` in `public/shared.js`)
| tier | value | spawn weight (of 10 000) | color | notes |
|---|---|---|---|---|
| обычная (c) | +1 | 8 224 (82.2 %) | `#3ee0ff` cyan | |
| необычная (u) | +2 | 1 200 (12 %) | `#5dff8f` green | |
| редкая (r) | +5 | 460 (4.6 %) | `#b46bff` violet | |
| эпическая (e) | +10 | 110 (1.1 %) | `#ff9a2e` orange, glow + spikes | |
| легендарная (l) | +25 | timed, never in the pool | `#ffcc33` gold | + 1 «Легендарный осколок», announced |
| мифическая (m) | +50 | 6 (0.06 %), max 1 alive, vanishes after 60 s | `#ff3d6e` crimson, rotating rays | + 3 осколка, announced |
| сокровище (t) | +50 | events only | `#ffe680` | + 1 осколок (event «Охота за сокровищем») |

Pool average ≈ 1.43 per orb. Each tier has its own look on the arena and minimap; the «?» button (or H) opens a legend. Old cached clients draw unknown tiers with the common sprite.

**Pushing:** players are solid circles (server-authoritative, `G.separatePlayers` every tick). Overlaps are split so that whoever walks into the other gets the smaller share: a moving player shoves a standing one at ≈ 2/3 of their speed (e.g. out of the «Царь горы» zone), and two players pushing head-on stall. There is a light knockback (≤ 5 px/tick, decaying), «Ускорение» adds at most +2 % push strength per level, and players are always kept inside the world (a player pinned at the edge stops the pusher).

**«Радар»** (bottom-right, collapsible with its button; 92 px on phones): a sonar view of ±900 px around you, where a wave every 3 s briefly lights up players and common/uncommon (faint: rare) orbs. Epic, legendary and mythic orbs, event treasures and the runner never appear (the compass handles those); the «Царь горы» zone is shown. It is drawn client-side from data the client already receives (`G.radarBlips`), and the server sends nothing extra. Screenshot: `screenshot-radar.png`.

## Arena events (server-authoritative, `G.EVENTS` / `eventTick` in `server.js`)
Scheduler: only while ≥ 1 player is online, one event every **6–10 min** (random), never the same kind twice in a row, never while a legendary orb is alive or imminent (the legendary waits until 20 s after the event). Each event is announced **25 s** ahead (banner with countdown and rules), then a HUD shows timer/progress, then everyone gets the results (top 5 names + scores + rewards and their own line). Rewards are paid by the server only to players online at the end; shards go through `grantItem(..., 'event')`. If everyone leaves, the event is cancelled.

| event | duration | rules | rewards |
|---|---|---|---|
| Сферный дождь | 45 s | 40 + 25 per player (≤ 220) extra orbs (c/u/r/e mix) fall; leftovers vanish at the end | whatever you collect (paid on pickup) |
| Царь горы | 60 s | stand in a zone (r = 230 px, shown on the arena + minimap); +1 point per second inside | 1st 200 ◉ + 2 💎, 2nd 120 ◉ + 1 💎, 3rd 80 ◉, others ≥ 10 points 20 ◉; alone: 100 ◉ + 1 💎; < 10 points: nothing |
| Охота за сокровищем | 90 s | 3 treasure orbs (+1 per 4 players, ≤ 6) placed ≥ 900 px from players; the HUD says how many are left | each treasure 50 ◉ + 1 💎 |
| Сфера-беглец | 60 s | a fast orb (175 px/s) flees from the closest player; position streamed to all | the catcher: 120 ◉ + 2 💎 |

Rewards are worth ≈ 1–2.5 min of farming. Env: `EVENT_EVERY_MS` (unset = random 6–10 min, `0` = events off, `N` = fixed interval), `EVENT_ANNOUNCE_MS` (default 25 000), `EVENT_DURATION_MS` (override all durations, for testing). Stats: `eventsPlayed`, `eventWins` (added with default 0).

## «Лавка осколков» (shard shop)
Exclusive cosmetics that **cannot be bought with orbs**, only with «Легендарный осколок» (shards are taken with `removeItem(..., 'shard_shop')`; all-or-nothing if the inventory is full). They have their own icons, arena rendering and an «Эксклюзив» badge in the inventory/shop.

| item | category | shards |
|---|---|---|
| Пустота | цвет | 40 |
| Осколочный ник | цвет ника | 50 |
| Хвост кометы | след | 70 |
| Кристалл | форма | 90 |
| Спутники | шапка | 120 |
| Кристальный след | след | 150 |
| Призма | цвет | 200 |
| Осколочная корона | шапка | 300 |

All 8 together: 1 020 shards. Exchange: **1 shard → 40 orbs** (balance only, not the all-time total; up to 99 per trade). Shard income (estimate): legendary orbs ≈ up to 30/h if you catch every one, mythic orbs ≈ 7/h server-wide, events ≈ 2–4/h → a typical active player gets ≈ 15–35 shards/h, so the top item takes ≈ 8–20 h of play. Socket: `shard:buy(itemId)`, `shard:exchange(qty)` (rate limited 8 / 5 s).

## Economy
Measured with greedy bots on the new spawn settings (`node test/measure-earn-rate.js <bots> <seconds>` against a scratch server, no upgrades): **≈ 80–110 orbs/min** per player with 1–4 players online (≈ 80 used for pricing; humans are usually a bit slower, upgrades make it faster).

| tier | price | ≈ time at 80 orbs/min |
|---|---|---|
| common | 150–500 | 2–6 min |
| rare | 400–1 500 | 5–19 min |
| epic | 1 800–4 000 | 23–50 min |
| legendary | 9 000–20 000 | 1.9–4.2 h |

Shop prices (★ = new in this update):
- Цвета: Коралловый 150, Лаймовый 150, Мятный 200 ★, Океанский синий 250 ★, Оранжевый 300 ★, Фиолетовый 400, Багровый 600 ★, Неоново-розовый 700, Ледяной 900 ★, Полночный 1 200 ★, Золотой 2 400, Закат 3 000 ★, Северное сияние 3 600 ★, Радужный 15 000, Галактика 16 000 ★, Лава 18 000 ★
- Формы: Ромб 300 ★, Квадрат 400, Пятиугольник 450 ★, Восьмиугольник 600 ★, Треугольник 800, Капля 900 ★, Плюс 1 200 ★, Шестиугольник 1 400, Сердце 2 200 ★, Шестерёнка 3 400 ★, Цветок 3 800 ★, Звезда 4 000, Желе 10 000 ★
- Следы: Дымок 300 ★, Пузыри 400 ★, Пиксели 800 ★, Искры 1 000, Листопад 1 100 ★, Снежинки 1 400 ★, Сердечки 2 400 ★, Неоновый шлейф 2 800, Звёзды 3 000 ★, Молния 3 800 ★, Огненный след 12 000, Радужная лента 14 000 ★, Галактическая пыль 17 000 ★
- Цвет ника: Бирюзовый 200 ★, Зелёный 250 ★, Розовый 300, Оранжевый 300 ★, Красный 500 ★, Фиолетовый 700 ★, Ледяной 1 000 ★, Золотой 1 800, Огненный 2 600 ★, Океанский 3 000 ★, Неоновый пульс 3 800 ★, Радужный 9 000, Глитч 12 000 ★
- Шапки: Шапка-бини 300 ★, Праздничный колпак 450 ★, Кепка 500, Заячьи ушки 500 ★, Кошачьи ушки 700 ★, Наушники 1 000 ★, Ковбойская шляпа 1 300 ★, Цилиндр 1 500, Рожки 2 000 ★, Шлем викинга 3 000 ★, Нимб 3 200, Кепка с пропеллером 3 900 ★, Шляпа волшебника 9 500 ★, Корона 20 000
- Everything together: 235 600 (the 49 new items: 158 100). Existing item ids, prices and ownership are unchanged.

## Upgrades
Optional, server-authoritative (applied in `collectAround` / the movement step / mini-game payouts on the server; the client only displays them). Diminishing returns per level; first levels cost a few minutes of play, the last level of the main four ≈ 2.3–3.1 h at 80 orbs/min. Levels are capped server-side (`G.upLevel`), other players never see them.

| upgrade | effect at level 1 / 2 / 3 / 4 / 5 | cost per level | total |
|---|---|---|---|
| Магнит | pickup radius +10 / +19 / +26 / +32 / +36 px (base 20 → 56 max) | 300 / 900 / 2 400 / 5 500 / 11 000 | 20 100 |
| Ускорение | speed +6 / +10 / +13 / +16 / +18 % (230 → 271 px/s max) | 400 / 1 100 / 2 800 / 6 000 / 12 000 | 22 300 |
| Множитель сфер | every orb ×1.05 / 1.10 / 1.15 / 1.20 / 1.25 (fractions are carried per player, so +5 % of a 1-orb pickup is never rounded away) | 600 / 1 600 / 3 800 / 8 000 / 15 000 | 29 000 |
| Удача | 2 / 4 / 6 / 7 / 8 % chance that a collected orb counts twice (the client shows «×2!»); from level 3 also a «находка»: 0.5 / 0.75 / 1 % of common/uncommon pickups count as an epic (+10) | 500 / 1 400 / 3 400 / 7 000 / 13 000 | 25 300 |
| Чутьё легенды (компас) | 1: arrows to the legendary and mythic orbs · 2: + arrow to the nearest epic within 1 500 px, distances · 3: + heads-up 15 s before a legendary and arrows to event targets (zone, treasures, runner) | 500 / 1 500 / 4 000 | 6 000 |
| Мастер мини-игр | mini-game prizes +5 / +10 / +15 % (perfect play still nets < half of farming: ≤ 39 orbs/min in «Сферный шторм») | 300 / 900 / 2 000 | 3 200 |

All six maxed cost 105 900. With orb rarities (Oct 2026, 6 + 6 runs, `test/measure-earn-rate.js`): **no upgrades ≈ 106 orbs/min (79–119), everything maxed ≈ 181 orbs/min (158–220) → ×1.71**; luck was retuned so the larger orb values don't inflate it. Previous measurement (greedy bot, `UPGRADES=max node test/measure-earn-rate.js 1 90 <url>` against fresh scratch servers with `OCS_TEST_HOOKS=1`, 12 runs each, one bot per server): **no upgrades 102 orbs/min (94–113), everything maxed 182 orbs/min (152–230) → ×1.79 on average (+79 %), median ×1.72 (+72 %)**; repeated batches with the same settings vary by roughly ±7 %, so treat it as ≈ +70–80 %. Multiplier × luck alone is ×1.40 (1.25 × 1.12); speed and magnet add the rest.
- Existing players keep their levels: magnet and speed still have 5 levels and map 1:1 onto the new curves, the new upgrades start at 0. A stored level above a max (not possible today) would be clamped and refunded at that upgrade's last price.
- Before: Магнит +14 px per level (up to +70 px), Ускорение +6 % per level (up to +30 %), 300…6 000 / 400…7 200.

- Mini-games are for fun and pay **less than farming**:
  - Память: fee 10, a growing sequence of 4 coloured orbs (12 rounds max); prize 3 per round after round 2, up to 30; cooldown 20 s. The server sends only the part of the sequence played so far, times each answer (faster than the sequence can be shown → rejected).
  - Угадай чашу: fee 10, the orb is shown under one of 3 cups, 9 visible swaps; win 16, cooldown 15 s. The server picks the cup and the swaps (the animation replays exactly those), reveals the cup only in the result; picking before the shuffle ends is rejected. Blind guessing: EV 5.3 < fee.
  - Точный бросок: fee 10, 3 throws; the marker position is a server-side function of time (RTT-compensated), points 10 / 7 / 4 / 1 by distance; prize 80 % of points, up to 24; cooldown 25 s. Stops < 250 ms are refused.
  - Цепочка: fee 10, tap orbs 1…8 in order; prize < 3.5 s 18, < 4.5 s 14, < 6 s 10, < 8 s 6, < 10 s 3; cooldown 20 s. The server checks order, position and ≥ 120 ms between taps.
  - Flawless back-to-back play incl. cooldowns with «Мастер мини-игр» 3 (tested in `npm test`): Реакция 29, Сферный шторм 39, Память 16, Угадай чашу 25, Точный бросок 38, Цепочка 30 orbs/min (farming ≈ 100). Screenshots: `screenshot-minigames-6.png`, `screenshot-minigame-shell.png`.

**Trails by rarity** (client only, `trailFx` in `public/client.js`): every trail keeps its own look; a rarity layer adds common: soft fade · rare: glow + twinkling sparkles · epic: wide two-colour shimmering glow + drifting particles · legendary: long (1 s) pulsing luminous tail with a white-hot core, swirling double-helix particles and bursts from the head · exclusives: legendary + a signature effect (Хвост кометы: blazing coma + blue ion tails; Кристальный след: spinning prism halo + rainbow glints). Performance: ≤ 6 / 20 / 36 / 50 particles per player by tier, plain strokes/arcs only (no shadows, no per-frame gradients/arrays), off-screen trails skipped, quality drops automatically (half particles on phones, `screenshot-minigames-6.png`, `screenshot-minigame-shell.png`.gt; 10 trails on screen or `screenshot-minigames-6.png`, `screenshot-minigame-shell.png`.lt; 45 FPS; glow only with `screenshot-minigames-6.png`, `screenshot-minigame-shell.png`.gt; 22 trails or `screenshot-minigames-6.png`, `screenshot-minigame-shell.png`.lt; 30 FPS). Screenshot: `screenshot-trails-epic.png`.
  - Реакция: fee 10, prize by reaction time < 250 ms 16, < 320 ms 12, < 400 ms 10, < 550 ms 6, < 750 ms 3; cooldown 15 s. Typical players roughly break even. (Before: 25 / 18 / 12 / 6, no cooldown.)
  - Сферный шторм: fee 20 (was 15), payout 75 % of the score capped at 40 (was 100 %, uncapped), cooldown 20 s. A perfect run nets at most +20 per 40 s ≈ 30 orbs/min vs ≈ 80 when farming.

## Security / privacy
- Clients only ever receive public data: a random per-session public player id (not the socket id), nickname, cosmetics, position, public stats. No IPs, socket ids, tokens or hashes are sent, logged or stored.
- Security headers (CSP, nosniff, frame-deny, no-referrer, COOP/CORP, HSTS behind HTTPS), `x-powered-by` off, `trust proxy` = 1 (Render).
- Socket.IO `maxHttpBufferSize` 10 KB, per-socket event flood guard, every payload type-checked, broadcasts only to logged-in players.

## Run
    npm install
    ./scripts/start-server.sh      # background server on :3000 (auto-restarts on crash)
    ./scripts/start-tunnel.sh      # optional public URL (hostc), saved to tunnel-url.txt
    ./scripts/restart-server.sh    # restart server only
    ./scripts/stop.sh              # stop everything

Logs: `logs/server.log`. Deployed on Render: build `npm install --omit=dev`, start `node server.js`, env `DATABASE_URL`.

## Tests
    npm test                                   # spawns its own servers on :3101 / :3104 (JSON mode, short-timer chat/spawn server; + PostgreSQL mode if TEST_DATABASE_URL is set)
    TEST_DATABASE_URL=postgres://user:pw@localhost:5432/ocs_test npm test   # NOTE: drops the ocs_* tables in that DB first
    node test/multiplayer-test.js <url>        # auth/chat/gameplay suite against a running server
    npm run test:ui                            # headless Chrome on :3102 / :3105 / :3106: login, profile, inventory, item icons, shop filters, upgrades, trash, chat, arena with every new cosmetic (desktop + mobile), screenshots
    UPGRADES=max node test/measure-earn-rate.js 1 90 http://localhost:3110   # income measurement against a scratch server started with OCS_TEST_HOOKS=1
    node test/seed-demo.js [file]              # demo accounts (password demo-pass-123) into a JSON data file

`npm test` covers: auth, profile data, chat moderation + the clear cycle, spawn distribution (count vs players, spread, gaps, no spawns on players, rarity share, legendary event), price sanity, shop purchases, inventory limit / stacking / full-inventory refusal, equip & unequip from the inventory, trash (unique items, partial / whole stacks, equipped items, invalid requests, rate limit, re-buying, persistence across restarts), the silent chat clear (no schedule or notice reaches clients), mini-game payouts and cooldowns, persistence across restarts, migration of old-format accounts (JSON and Postgres) upgrades (price tables, diminishing curves, caps, exact multiplier accounting with carried fractions, luck, speed, mini-game skill, legendary heads-up only for «Чутьё легенды» 3, level migration), income with everything maxed vs none (3 + 3 fresh servers in parallel; skip with `OCS_TEST_INCOME=0`), every new cosmetic bought / equipped / seen by others / trashed, catalog rules (tier price ranges, unchanged old ids and prices) and a privacy audit of everything clients received. Also: orb tier weights / roll distribution / pool income, luck «находка» and compass levels, every arena event (rain, king of the hill with placed rewards, treasure, runner, cancelling), the event scheduler (no events with 0 players or while a legendary is alive, sequencing, announce timing), the shard shop (prices, refusals, exchange, all-or-nothing) and event payload privacy. `OCS_TEST_ONLY=events` runs just those. `OCS_TEST_HOOKS=1` enables test-only socket events (`test:grant`, `test:orbs`, `test:upgrades`, `test:event`, `test:spawn`) — the test runner sets it for its own servers; never set it in production.
Screenshots: `screenshot-profile.png`, `screenshot-profile-mobile.png`, `screenshot-inventory.png`, `screenshot-inventory-mobile.png`, `screenshot-trash-confirm.png`, `screenshot-shop.png`, `screenshot-shop-mobile.png`, `screenshot-shop-upgrades.png`, `screenshot-icons-all.png` (every item + upgrade icon), `screenshot-arena-cosmetics.png` (players wearing new cosmetics), `screenshot-event-banner.png`, `screenshot-event-koth.png`, `screenshot-shard-shop.png`, `screenshot-shop-icons.png` (currency icons: CSS glowing orb for orb amounts, gold SVG shard for shard prices — no emoji), `screenshot-orb-rarities.png` (test:ui also writes `screenshot-event-results.png` and `screenshot-arena-exclusives.png`, not committed), plus the login / chat screenshots.

## API
- `GET /api/leaderboard?limit=20&name=<nick>` — all-time ranking by total orbs collected (rank, name, total, color, online)
- `GET /api/health`, `GET /api/shop`
