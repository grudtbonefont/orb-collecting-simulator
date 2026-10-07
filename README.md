# Item Collecting Simulator

Multiplayer browser game: collect glowing orbs in a shared arena, spend them on cosmetics, upgrades and mini-games, climb the all-time leaderboard.
Stack: Node.js + Express + Socket.IO (server-authoritative, 20 ticks/s), HTML5 canvas + vanilla JS client (no build step). Player data: `data/players.json`.

## Run
    npm install
    ./scripts/start-server.sh      # background server on :3000 (auto-restarts on crash)
    ./scripts/start-tunnel.sh      # public URL (hostc; TUNNEL=cloudflared for a Cloudflare quick tunnel), saved to tunnel-url.txt
    ./scripts/restart-server.sh    # restart server only (public URL stays the same)
    ./scripts/stop.sh              # stop everything (stop-server.sh / stop-tunnel.sh separately)

Logs: `logs/server.log`, `logs/tunnel.log`.

## Tests
    node test/multiplayer-test.js [url]   # 2 bots: join, move, collect, buy/equip, upgrade, both mini-games, leaderboard
    node test/screenshot.js [url]         # headless Chrome screenshots

## API
- `GET /api/leaderboard?limit=20&name=<nick>` — all-time ranking by total orbs collected
- `GET /api/health`, `GET /api/shop`
