'use strict';
// Persistent storage: PostgreSQL when DATABASE_URL is set, JSON file otherwise (local dev).
// Account object shape (camelCase, used live by the game):
//   { key, name, passHash, balance, total, owned[], equipped{}, upgrades{}, stats{}, createdAt, lastSeen }
const fs = require('fs');
const path = require('path');

const clone = o => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ JSON file store
class JsonStore {
  constructor(file) { this.file = file; this.mode = 'json'; this.data = { version: 2, accounts: {}, sessions: {} }; this.timer = null; }
  describe() { return `JSON file (${this.file})`; }
  async init() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (d && d.version === 2 && d.accounts && d.sessions) this.data = d;
      }
    } catch (e) { console.error('JSON store: failed to read data file, starting fresh:', e.message); }
  }
  scheduleWrite(ms = 1000) { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, ms); }
  writeNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  async countAccounts() { return Object.keys(this.data.accounts).length; }
  async getAccount(key) { const a = this.data.accounts[key]; return a ? clone(a) : null; }
  async createAccount(acc) {
    if (this.data.accounts[acc.key]) return false;
    this.data.accounts[acc.key] = clone(acc);
    this.scheduleWrite(200);
    return true;
  }
  async saveAccounts(list) {
    for (const a of list) {
      const rec = this.data.accounts[a.key];
      if (!rec) continue;
      Object.assign(rec, { balance: a.balance, total: a.total, owned: clone(a.owned), equipped: clone(a.equipped), upgrades: clone(a.upgrades), stats: clone(a.stats), lastSeen: a.lastSeen });
    }
    this.scheduleWrite(500);
  }
  async createSession(hash, key, expiresAt) { this.data.sessions[hash] = { key, createdAt: Date.now(), expiresAt }; this.scheduleWrite(200); }
  async getSession(hash) { const s = this.data.sessions[hash]; return s ? { key: s.key, expiresAt: s.expiresAt } : null; }
  async touchSession(hash, expiresAt) { const s = this.data.sessions[hash]; if (s) { s.expiresAt = expiresAt; this.scheduleWrite(); } }
  async deleteSession(hash) { if (this.data.sessions[hash]) { delete this.data.sessions[hash]; this.scheduleWrite(200); } }
  async purgeExpiredSessions(now) {
    let n = 0;
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.expiresAt <= now) { delete this.data.sessions[h]; n++; }
    if (n) this.scheduleWrite();
    return n;
  }
  async leaderboard(limit, meKey) {
    const list = Object.values(this.data.accounts).filter(a => a.total > 0).sort((a, b) => b.total - a.total || a.createdAt - b.createdAt);
    const row = a => ({ name: a.name, total: a.total, equipped: a.equipped });
    let me = null;
    if (meKey) { const i = list.findIndex(a => a.key === meKey); if (i >= 0) me = Object.assign({ rank: i + 1 }, row(list[i])); }
    return { totalPlayers: list.length, rows: list.slice(0, limit).map(row), me };
  }
  async close() { this.writeNow(); }
}

// ------------------------------------------------------------------ PostgreSQL store
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ocs_accounts (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  balance    BIGINT NOT NULL DEFAULT 0,
  total      BIGINT NOT NULL DEFAULT 0,
  owned      JSONB NOT NULL,
  equipped   JSONB NOT NULL,
  upgrades   JSONB NOT NULL,
  stats      JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ocs_accounts_rank_idx ON ocs_accounts (total DESC, created_at ASC);
CREATE TABLE IF NOT EXISTS ocs_sessions (
  token_hash  TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES ocs_accounts(key) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ocs_sessions_account_idx ON ocs_sessions (account_key);
CREATE INDEX IF NOT EXISTS ocs_sessions_expiry_idx ON ocs_sessions (expires_at);
`;

function sslCandidates(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { /* invalid URL: let pg report it */ }
  const forced = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (forced === 'true' || forced === 'require') return [{ rejectUnauthorized: false }];
  if (forced === 'false' || forced === 'disable') return [false];
  // Render internal hosts look like "dpg-xxxx-a" (no dot) and don't need TLS; external hosts do.
  const internal = !host.includes('.') || host === '127.0.0.1' || host === '::1';
  return internal ? [false, { rejectUnauthorized: false }] : [{ rejectUnauthorized: false }, false];
}

class PgStore {
  constructor(url) { this.url = url; this.mode = 'postgres'; this.pool = null; this.ssl = null; }
  describe() { return `PostgreSQL (ssl: ${this.ssl ? 'on' : 'off'})`; }
  async init() {
    const pg = require('pg');
    pg.types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number
    let lastErr = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (const ssl of sslCandidates(this.url)) {
        const pool = new pg.Pool({ connectionString: this.url, ssl, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
        pool.on('error', e => console.error('PostgreSQL pool error:', e.message));
        try {
          await pool.query('SELECT 1');
          this.pool = pool; this.ssl = ssl;
          await pool.query(SCHEMA);
          return;
        } catch (e) {
          lastErr = e;
          await pool.end().catch(() => {});
        }
      }
      console.error(`PostgreSQL connect attempt ${attempt} failed: ${lastErr && lastErr.message}`);
      await new Promise(r => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
    }
    throw new Error('Could not connect to PostgreSQL: ' + (lastErr && lastErr.message));
  }
  static rowToAccount(r) {
    return { key: r.key, name: r.name, passHash: r.pass_hash, balance: r.balance, total: r.total, owned: r.owned, equipped: r.equipped,
      upgrades: r.upgrades, stats: r.stats, createdAt: r.created_at, lastSeen: r.last_seen };
  }
  async countAccounts() { return (await this.pool.query('SELECT COUNT(*)::int AS n FROM ocs_accounts')).rows[0].n; }
  async getAccount(key) {
    const r = await this.pool.query('SELECT * FROM ocs_accounts WHERE key = $1', [key]);
    return r.rows[0] ? PgStore.rowToAccount(r.rows[0]) : null;
  }
  async createAccount(a) {
    const r = await this.pool.query(
      `INSERT INTO ocs_accounts (key, name, pass_hash, balance, total, owned, equipped, upgrades, stats, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (key) DO NOTHING`,
      [a.key, a.name, a.passHash, a.balance, a.total, JSON.stringify(a.owned), JSON.stringify(a.equipped), JSON.stringify(a.upgrades), JSON.stringify(a.stats), a.createdAt, a.lastSeen]);
    return r.rowCount === 1;
  }
  async saveAccounts(list) {
    if (!list.length) return;
    const rows = list.map(a => ({ key: a.key, balance: a.balance, total: a.total, owned: a.owned, equipped: a.equipped, upgrades: a.upgrades, stats: a.stats, last_seen: a.lastSeen }));
    await this.pool.query(
      `UPDATE ocs_accounts AS a SET balance = v.balance, total = v.total, owned = v.owned, equipped = v.equipped,
         upgrades = v.upgrades, stats = v.stats, last_seen = v.last_seen
       FROM jsonb_to_recordset($1::jsonb) AS v(key TEXT, balance BIGINT, total BIGINT, owned JSONB, equipped JSONB, upgrades JSONB, stats JSONB, last_seen BIGINT)
       WHERE a.key = v.key`, [JSON.stringify(rows)]);
  }
  async createSession(hash, key, expiresAt) {
    await this.pool.query('INSERT INTO ocs_sessions (token_hash, account_key, created_at, expires_at) VALUES ($1,$2,$3,$4)', [hash, key, Date.now(), expiresAt]);
  }
  async getSession(hash) {
    const r = await this.pool.query('SELECT account_key, expires_at FROM ocs_sessions WHERE token_hash = $1', [hash]);
    return r.rows[0] ? { key: r.rows[0].account_key, expiresAt: r.rows[0].expires_at } : null;
  }
  async touchSession(hash, expiresAt) { await this.pool.query('UPDATE ocs_sessions SET expires_at = $2 WHERE token_hash = $1', [hash, expiresAt]); }
  async deleteSession(hash) { await this.pool.query('DELETE FROM ocs_sessions WHERE token_hash = $1', [hash]); }
  async purgeExpiredSessions(now) { return (await this.pool.query('DELETE FROM ocs_sessions WHERE expires_at <= $1', [now])).rowCount; }
  async leaderboard(limit, meKey) {
    const [rows, cnt] = await Promise.all([
      this.pool.query('SELECT name, total, equipped FROM ocs_accounts WHERE total > 0 ORDER BY total DESC, created_at ASC LIMIT $1', [limit]),
      this.pool.query('SELECT COUNT(*)::int AS n FROM ocs_accounts WHERE total > 0'),
    ]);
    let me = null;
    if (meKey) {
      const m = await this.pool.query('SELECT name, total, equipped, created_at FROM ocs_accounts WHERE key = $1 AND total > 0', [meKey]);
      if (m.rows[0]) {
        const r = m.rows[0];
        const rank = await this.pool.query('SELECT COUNT(*)::int AS n FROM ocs_accounts WHERE total > $1 OR (total = $1 AND created_at < $2)', [r.total, r.created_at]);
        me = { rank: rank.rows[0].n + 1, name: r.name, total: r.total, equipped: r.equipped };
      }
    }
    return { totalPlayers: cnt.rows[0].n, rows: rows.rows.map(r => ({ name: r.name, total: r.total, equipped: r.equipped })), me };
  }
  async close() { if (this.pool) await this.pool.end(); }
}

function createStore() {
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) return new PgStore(url.trim());
  const file = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, '..', 'data', 'accounts.json');
  return new JsonStore(file);
}

module.exports = { createStore, JsonStore, PgStore, sslCandidates };
