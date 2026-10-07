# Orb Collecting Simulator

Multiplayer browser game: collect glowing orbs in a shared arena, spend them on cosmetics, upgrades and mini-games, chat with other players and climb the all-time leaderboard.
Stack: Node.js + Express 5 + Socket.IO (server-authoritative, 20 ticks/s), HTML5 canvas + vanilla JS client (no build step). UI language: Russian.

## Accounts
- Register / log in with **nickname + password** (screen «Вход» / «Регистрация»).
- Nickname: 3–20 characters, only `A–Z a–z 0–9 _`, at most one `_`, not at the start or end; unique case-insensitively (display case is kept); a small profanity / reserved-word filter applies.
- Password: 6–72 characters (≤ 72 bytes), stored only as a bcrypt hash (cost 10).
- After login the server issues a random 256-bit session token (only its SHA-256 is stored, 30-day sliding expiry) kept in `localStorage`; «Выйти» deletes it server-side. One game connection per account (a new login kicks the old tab).
- Brute-force protection: 5 failed attempts → 1-minute lockout, per connection and per nickname.
- Balance, all-time total, owned/equipped cosmetics, upgrades and stats persist per account.

## Storage
`lib/storage.js` picks the backend at startup:
- **PostgreSQL** when `DATABASE_URL` is set (`pg`). Tables `ocs_accounts` / `ocs_sessions` are created automatically. TLS: off first for hosts without a dot (Render internal URLs such as `dpg-xxxx-a`), on (`rejectUnauthorized:false`) first for external hosts; the other mode is tried as a fallback. Override with `DATABASE_SSL=true|false`.
- **JSON file** otherwise (local dev): `data/accounts.json` (override with `DATA_FILE`).

Live gameplay state is in memory; changed accounts are flushed in batches every 3 s, right after purchases/disconnects, and on SIGTERM/SIGINT (graceful shutdown). The leaderboard reads persisted all-time totals. `GET /api/health` reports which storage is active.

## Chat
Global arena chat (logged-in players only), last 50 messages are sent on join, join/leave system lines.
- Desktop: compact panel bottom-left. **Enter** or **T** focuses it, **Enter** sends, **Esc** leaves. While typing, movement keys and hotkeys are ignored.
- Phones / touch / narrow screens (≤ 760 px or coarse pointer): a 💬 button with an unread badge; tap opens a full-screen sheet (sized to the visual viewport so the on-screen keyboard doesn't hide the input), ✕ returns to the game. New messages flash as a small toast at the top.
- Moderation (server-side): 120 chars max, 1 message / 1.5 s and 5 / 10 s, no duplicates, control / invisible / bidi characters stripped, links, domains, e-mails, IP addresses and phone-like numbers → `***`, basic RU/EN profanity → `***`, repeated-character spam collapsed. Rendered with `textContent` only.

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
    npm test                                   # spawns its own servers on :3101 (JSON mode; + PostgreSQL mode if TEST_DATABASE_URL is set)
    TEST_DATABASE_URL=postgres://user:pw@localhost:5432/ocs_test npm test   # NOTE: drops the ocs_* tables in that DB first
    node test/multiplayer-test.js <url>        # auth/chat/gameplay suite against a running server
    npm run test:ui                            # headless Chrome: login, desktop + mobile chat checks, screenshots
    node test/seed-demo.js [file]              # demo accounts (password demo-pass-123) into a JSON data file

## API
- `GET /api/leaderboard?limit=20&name=<nick>` — all-time ranking by total orbs collected (rank, name, total, color, online)
- `GET /api/health`, `GET /api/shop`
