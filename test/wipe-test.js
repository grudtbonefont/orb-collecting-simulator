const { spawn } = require('child_process'); const fs = require('fs'); const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = process.cwd(), PORT = 3149, URL = 'http://localhost:' + PORT; let f = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) f++; };
const start = () => { const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE: '/tmp/wipe.json', DATABASE_URL: '', EVENT_EVERY_MS: '0', OBSTACLES: '0' }) }); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.log = () => out; return p; };
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(URL + '/api/health')).ok) return; } catch (_) {} await sleep(200); } };
const reg = async n => { const r = await fetch(URL + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, password: 'demo-pass-123' }) }); return r.status; };
(async () => {
  try { fs.unlinkSync('/tmp/wipe.json'); } catch (_) {}
  const base = { inventory: { v: 1, slots: [] }, owned: [], equipped: {}, upgrades: { magnet: 0, speed: 0, mult: 0, luck: 0, sense: 0, skill: 0 }, stats: { upgradeRefundV1: true, upgradeRefundAmount: 0, shardMigrationV1: true, achV2: true, achResetV2: 1, achBase: {} }, balance: 0, total: 0, createdAt: 1, lastSeen: 1, codes: [] };
  const names = ['DragonzTV', 'Simbobeze_2', 'DragonzMobile', 'Dragonz', 'Simbobeze_1', 'dragonztv2'];
  fs.writeFileSync('/tmp/wipe.json', JSON.stringify({ version: 2, sessions: {}, accounts: Object.fromEntries(names.map(n => [n.toLowerCase(), Object.assign(JSON.parse(JSON.stringify(base)), { key: n.toLowerCase(), name: n, passHash: 'h-' + n })])) }));
  let p;
  const d = JSON.parse(fs.readFileSync('/tmp/wipe.json', 'utf8'));
  for (const a of Object.values(d.accounts)) { a.balance = 500; a.total = 9000; a.upgrades.speed = 2; a.stats.shards = 7; a.stats.unlockedDoor2 = true; a.stats.ach = { x: 1 }; a.stats.ban = a.name === 'Simbobeze_2' ? { at: 1, r: 'x' } : undefined; a.stats.warns = [{ at: 1, r: 'w' }]; a.inventory.slots.push({ id: 'e_crown', q: 1, src: 'shop', at: 1 }); }
  fs.writeFileSync('/tmp/wipe.json', JSON.stringify(d)); const hashes = Object.fromEntries(Object.values(d.accounts).map(a => [a.name, a.passHash]));
  p = start(); await up(); await sleep(800); p.kill(); await sleep(1500); 
  const log = p.log(); ok((log.match(/\[wipeV1\] wiped/g) || []).length === 3 && !/passHash/.test(log), 'wiped 3, backup logged without hash');
  const d2 = JSON.parse(fs.readFileSync('/tmp/wipe.json', 'utf8'));
  for (const a of Object.values(d2.accounts)) {
    const w = ['DragonzTV', 'Simbobeze_2', 'DragonzMobile'].includes(a.name);
    if (w) ok(a.balance === 0 && a.total === 0 && a.upgrades.speed === 0 && !a.stats.shards && !a.stats.unlockedDoor2 && !Object.keys(a.stats.ach || {}).length && !a.inventory.slots.some(s => s.id === 'e_crown') && a.passHash === hashes[a.name] && a.stats.warns.length === 1 && (a.name !== 'Simbobeze_2' || a.stats.ban), a.name + ' wiped, hash/warn/ban kept');
    else ok(a.balance === 500 && a.total === 9000 && a.stats.shards === 7 && a.inventory.slots.some(s => s.id === 'e_crown'), a.name + ' untouched');
  }
  p = start(); await up(); await sleep(500); p.kill(); await sleep(800); ok(!/wiped/.test(p.log()), 'runs only once');
  console.log(f ? 'FAILED ' + f : 'ALL PASS'); process.exit(f ? 1 : 0);
})();
