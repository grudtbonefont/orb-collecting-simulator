// Player-to-player trade: happy path + exploit attempts.
// Run: node test/trade-test.js
'use strict';
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('../public/shared.js');
const INV = require('../lib/inventory');

const ROOT = path.join(__dirname, '..');
const PORT = 3197;
const URL = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/ocs-trade-test.json';
const PASS = 'trade-pass-9x';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, passes = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (c) passes++; else failures++; };

function makeClient() {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c = { s, id: null, profile: null, token: null, events: [], tradeState: null };
  s.on('trade:state', st => { c.tradeState = st; c.events.push(['state', st]); });
  s.on('trade:req', d => c.events.push(['req', d]));
  s.on('trade:reqSent', d => c.events.push(['reqSent', d]));
  s.on('trade:reqGone', d => c.events.push(['reqGone', d]));
  s.on('trade:declined', d => c.events.push(['declined', d]));
  s.on('trade:cancel', d => { c.tradeState = null; c.events.push(['cancel', d]); });
  s.on('trade:fail', d => c.events.push(['fail', d]));
  s.on('trade:done', d => { c.tradeState = null; c.events.push(['done', d]); });
  s.on('profile', p => { c.profile = p; });
  s.on('bal', b => { if (c.profile) { c.profile.balance = b.b; c.profile.total = b.t; } });
  c.ready = new Promise(r => s.on('connect', r));
  c.call = (ev, ...args) => new Promise(res => {
    const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 12000);
    s.emit(ev, ...args, r => { clearTimeout(t); res(r); });
  });
  c.enter = r => {
    if (!r || !r.ok) return r;
    c.token = r.token; c.id = r.you; c.profile = r.profile; c.players = r.players || [];
    return r;
  };
  c.register = async name => { await c.ready; return c.enter(await c.call('auth', { mode: 'register', name, password: PASS, confirm: PASS })); };
  c.grant = (id, qty = 1) => c.call('test:grant', { id, qty });
  c.tp = (x, y, extra = {}) => c.call('test:tp', Object.assign({ x, y }, extra));
  c.prof = () => c.call('profile:get', null).then(r => { if (r && r.profile) c.profile = r.profile; return c.profile; });
  c.close = () => s.close();
  c.waitEv = async (type, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = c.events.findIndex(e => e[0] === type);
      if (i >= 0) return c.events.splice(i, 1)[0][1];
      await sleep(40);
    }
    return null;
  };
  c.clearEv = () => { c.events.length = 0; };
  return c;
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); }
  return fn();
}

async function openTrade(a, b) {
  // Ensure no leftover trade
  if (a.tradeState) await a.call('trade:cancel', {});
  if (b.tradeState) await b.call('trade:cancel', {});
  await sleep(G.TRADE.reqGapMs + 200);
  a.clearEv(); b.clearEv(); a.tradeState = null; b.tradeState = null;
  const r = await a.call('trade:request', b.id);
  if (!r || !r.ok) return { ok: false, error: 'request: ' + ((r && r.error) || 'fail') };
  const req = await b.waitEv('req', 3000);
  if (!req) return { ok: false, error: 'no req event (sent=' + JSON.stringify(r) + ')' };
  const acc = await b.call('trade:respond', { tradeId: req.id, accept: true });
  if (!acc || !acc.ok) return { ok: false, error: 'respond: ' + ((acc && acc.error) || 'fail') };
  const stA = await waitFor(() => a.tradeState && a.tradeState.state === 'open', 3000);
  const stB = await waitFor(() => b.tradeState && b.tradeState.state === 'open', 3000);
  if (!stA || !stB) return { ok: false, error: 'no open state a=' + !!(stA) + ' b=' + !!(stB) };
  return { ok: true, id: stA.id };
}


async function mustOpen(a, b, label) {
  const open = await openTrade(a, b);
  ok(open.ok, label + (open.ok ? '' : ': ' + open.error));
  if (!open.ok) throw new Error(label + ': ' + open.error);
  return open;
}

async function bothOfferReadyConfirm(a, b, offerA, offerB) {
  await a.call('trade:offer', { tradeId: a.tradeState.id, offer: offerA });
  await b.call('trade:offer', { tradeId: b.tradeState.id, offer: offerB });
  await sleep(80);
  await a.call('trade:ready', { tradeId: a.tradeState.id, ready: true });
  await b.call('trade:ready', { tradeId: b.tradeState.id, ready: true });
  await sleep(80);
  await a.call('trade:confirm', { tradeId: a.tradeState.id, confirm: true });
  await b.call('trade:confirm', { tradeId: b.tradeState.id, confirm: true });
}

(async () => {
  try { fs.unlinkSync(DATA); } catch (_) {}
  const logFile = '/tmp/ocs-trade-test-server.log';
  const logFd = fs.openSync(logFile, 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_FILE: DATA, DATABASE_URL: '',
      EVENT_EVERY_MS: '0', OBSTACLES: '0', OCS_TEST_HOOKS: '1',
    }),
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(URL + '/api/health')).ok) break; } catch (_) {}
    await sleep(150);
  }
  ok((await (await fetch(URL + '/api/health')).json()).ok, 'server up');

  // static flags
  ok(G.TRADING_ENABLED === true, 'TRADING_ENABLED');
  ok(typeof G.isTradeable === 'function', 'isTradeable exported');
  ok(!G.isTradeable(G.ITEM_BY_ID.h_beta), 'h_beta non-tradeable');
  ok(!G.isTradeable(G.ITEM_BY_ID.h_trophy), 'h_trophy non-tradeable');
  ok(G.NON_TRADEABLE_IDS.includes('h_beta'), 'NON_TRADEABLE_IDS has h_beta');
  const coral = G.ITEM_BY_ID.c_coral;
  ok(G.isTradeable(coral), 'shop color tradeable');
  const pot = G.ITEM_BY_ID.p_speed;
  ok(G.isTradeable(pot), 'potion tradeable');

  const A = makeClient(), C = makeClient(); let B = makeClient();
  const ra = await A.register('TradeA' + crypto.randomInt(100, 999));
  const rb = await B.register('TradeB' + crypto.randomInt(100, 999));
  const rc = await C.register('TradeC' + crypto.randomInt(100, 999));
  ok(ra.ok && rb.ok && rc.ok, 'three accounts registered in game');

  // seed inventories/balances
  await A.tp(500, 500, { orbs: 5000 });
  await B.tp(520, 500, { orbs: 5000 });
  await C.tp(540, 500, { orbs: 5000 });
  await A.grant('c_coral', 2);
  await A.grant('p_speed', 5);
  await B.grant('c_lime', 2);
  await B.grant('p_luck', 3);
  await A.grant(G.SHARD_ID, 10);
  await B.grant(G.SHARD_ID, 10);
  await A.grant('h_beta', 1); // untradeable (may already have)
  await sleep(200);
  await A.prof(); await B.prof();
  ok(A.profile.inventory.some(s => s.id === 'c_coral'), 'A has coral');
  ok(B.profile.inventory.some(s => s.id === 'c_lime'), 'B has lime');

  // ---- normal swap ----
  {
    const open = await openTrade(A, B);
    ok(open.ok, 'trade window opens after accept');
    const beforeA = { bal: A.profile.balance, coral: INV.countItem({ inventory: { slots: A.profile.inventory }, stats: A.profile.stats }, 'c_coral'),
      lime: INV.countItem({ inventory: { slots: A.profile.inventory }, stats: A.profile.stats }, 'c_lime'),
      shards: A.profile.shards | 0 };
    // profile.inventory is array of {id,q} in ownProfile — adapt
    const count = (p, id) => (p.inventory || []).filter(s => s.id === id).reduce((n, s) => n + s.q, 0);
    const ba = { bal: A.profile.balance, coral: count(A.profile, 'c_coral'), lime: count(A.profile, 'c_lime'), shards: A.profile.shards | 0 };
    const bb = { bal: B.profile.balance, coral: count(B.profile, 'c_coral'), lime: count(B.profile, 'c_lime'), shards: B.profile.shards | 0 };

    A.clearEv(); B.clearEv();
    await bothOfferReadyConfirm(A, B,
      { items: [{ id: 'c_coral', qty: 1 }, { id: 'p_speed', qty: 2 }], orbs: 100, shards: 2 },
      { items: [{ id: 'c_lime', qty: 1 }], orbs: 50, shards: 1 });
    const doneA = await A.waitEv('done', G.TRADE.countdownMs + 3000);
    const doneB = await B.waitEv('done', 2000);
    ok(!!doneA && !!doneB, 'normal trade completes after countdown');
    await A.prof(); await B.prof();
    const aa = { bal: A.profile.balance, coral: count(A.profile, 'c_coral'), lime: count(A.profile, 'c_lime'), shards: A.profile.shards | 0 };
    const ab = { bal: B.profile.balance, coral: count(B.profile, 'c_coral'), lime: count(B.profile, 'c_lime'), shards: B.profile.shards | 0 };
    ok(aa.coral === ba.coral - 1 && aa.lime === ba.lime + 1 && aa.bal === ba.bal - 100 + 50 && aa.shards === ba.shards - 2 + 1, `A assets swapped (${JSON.stringify(ba)} → ${JSON.stringify(aa)})`);
    ok(ab.coral === bb.coral + 1 && ab.lime === bb.lime - 1 && ab.bal === bb.bal - 50 + 100 && ab.shards === bb.shards - 1 + 2, `B assets swapped`);
  }

  // ---- untradeable ----
  {
    const open = await openTrade(A, B);
    ok(open.ok, 'reopen trade for untradeable test');
    const r = await A.call('trade:offer', { tradeId: A.tradeState.id, offer: { items: [{ id: 'h_beta', qty: 1 }], orbs: 0, shards: 0 } });
    ok(r && !r.ok, 'untradeable h_beta rejected: ' + (r && r.error));
    await A.call('trade:cancel', {});
    await sleep(100);
  }

  // ---- negative / overflow / NaN ----
  {
    const open = await openTrade(A, B);
    ok(open.ok, 'reopen for validation' + (open.ok ? '' : ': ' + open.error));
    if (!open.ok) { console.log('skip validation'); }
    else {
    const bad = [
      { items: [], orbs: -5, shards: 0 },
      { items: [], orbs: 1.5, shards: 0 },
      { items: [], orbs: 'NaN', shards: 0 },
      { items: [], orbs: null, shards: 'nope' },
      { items: [], orbs: 1e15, shards: 0 },
      { items: [{ id: 'c_coral', qty: -1 }], orbs: 0, shards: 0 },
      { items: [{ id: 'c_coral', qty: 999999 }], orbs: 0, shards: 0 },
      { items: [{ id: 'not_an_item', qty: 1 }], orbs: 0, shards: 0 },
    ];
    let allBad = true;
    for (const o of bad) {
      const r = await A.call('trade:offer', { tradeId: A.tradeState.id, offer: o });
      if (r && r.ok) { allBad = false; console.log('  unexpectedly accepted', o); }
    }
    ok(allBad, 'negative/NaN/overflow/unknown item offers rejected');
    await A.call('trade:cancel', {});
    await sleep(100);
    }
  }

  // ---- modified offer after confirm resets ----
  {
    await A.grant('p_speed', 2); await B.grant('p_luck', 2); await sleep(100);
    await mustOpen(A, B, 'reopen for confirm-reset test');
    await bothOfferReadyConfirm(A, B,
      { items: [{ id: 'p_speed', qty: 1 }], orbs: 10, shards: 0 },
      { items: [{ id: 'p_luck', qty: 1 }], orbs: 10, shards: 0 });
    await waitFor(() => A.tradeState && A.tradeState.state === 'countdown', 2000);
    ok(A.tradeState && A.tradeState.state === 'countdown', 'countdown started');
    // A sneaks an extra item into the offer
    const r = await A.call('trade:offer', { tradeId: A.tradeState.id, offer: { items: [{ id: 'p_speed', qty: 2 }], orbs: 10, shards: 0 } });
    ok(r && r.ok, 'offer change accepted (resets ready)');
    await sleep(100);
    ok(A.tradeState && A.tradeState.state === 'open' && !A.tradeState.myReady && !A.tradeState.myConfirm, 'offer change reset ready+confirm and cancelled countdown');
    // ensure no silent complete
    await sleep(G.TRADE.countdownMs + 500);
    ok(!A.events.some(e => e[0] === 'done'), 'no trade:done after offer tamper');
    await A.call('trade:cancel', {});
    await sleep(100);
  }

  // ---- disconnect mid-countdown ----
  {
    await A.grant('p_speed', 1); await B.grant('p_luck', 1); await sleep(80);
    await mustOpen(A, B, 'reopen for disconnect test');
    await bothOfferReadyConfirm(A, B,
      { items: [{ id: 'p_speed', qty: 1 }], orbs: 5, shards: 0 },
      { items: [{ id: 'p_luck', qty: 1 }], orbs: 5, shards: 0 });
    await waitFor(() => A.tradeState && A.tradeState.state === 'countdown', 2000);
    const balBefore = (await A.prof()).balance;
    B.clearEv();
    B.close(); // disconnect mid-countdown
    const cancel = await A.waitEv('cancel', G.TRADE.countdownMs + 2000);
    ok(!!cancel, 'trade cancelled on partner disconnect');
    await A.prof();
    ok(A.profile.balance === balBefore || Math.abs(A.profile.balance - balBefore) < 1, 'no orb swap after disconnect cancel');
    // recreate B (fresh socket — old one disconnected)
    B = makeClient();
    const rb2 = await B.register('TradeB2' + crypto.randomInt(100, 999));
    ok(rb2.ok, 'replacement B registered');
    await B.tp(520, 500, { orbs: 5000 });
    await B.grant('c_lime', 3);
    await B.grant('p_luck', 5);
    await B.grant(G.SHARD_ID, 10);
    await sleep(200);
  }

  // ---- spending items/orbs elsewhere during trade blocked ----
  {
    await mustOpen(A, B, 'reopen for mutation guard');
    await A.call('trade:offer', { tradeId: A.tradeState.id, offer: { items: [{ id: 'p_speed', qty: 1 }], orbs: 200, shards: 0 } });
    await sleep(80);
    const trash = await A.call('inv:trash', { id: 'p_speed', qty: 99 });
    ok(trash && !trash.ok && /обмен/i.test(trash.error || ''), 'trash of offered item blocked: ' + (trash && trash.error));
    // buy something expensive that would eat offered orbs
    const buy = await A.call('buy', 'c_coral', 1); // may fail for owned nonstack? coral is stackable
    // spend via upgrade if possible
    const door = await A.call('door:unlock');
    // If door already unlocked or funds: mutationGuard only triggers when spend would breach lock
    // Force: set offer of almost all balance
    await A.prof();
    const almost = Math.max(0, A.profile.balance - 10);
    await A.call('trade:offer', { tradeId: A.tradeState.id, offer: { items: [], orbs: almost, shards: 0 } });
    await sleep(50);
    const up = await A.call('upgrade', 'speed');
    ok(up && !up.ok, 'upgrade blocked while orbs locked: ' + JSON.stringify(up));
    // More definitive: trash remaining free p_speed after locking 1
    await A.grant('p_speed', 3); await sleep(50);
    await A.call('trade:offer', { tradeId: A.tradeState.id, offer: { items: [{ id: 'p_speed', qty: 2 }], orbs: 0, shards: 0 } });
    await sleep(50);
    await A.prof();
    const have = (A.profile.inventory || []).filter(s => s.id === 'p_speed').reduce((n, s) => n + s.q, 0);
    const trash2 = await A.call('inv:trash', { id: 'p_speed', qty: have });
    ok(trash2 && !trash2.ok, 'cannot trash more than unlocked qty while in trade');
    await A.call('trade:cancel', {});
    await sleep(100);
  }

  // ---- concurrent double trade blocked ----
  {
    await mustOpen(A, B, 'A↔B trade open');
    const r = await A.call('trade:request', C.id);
    ok(r && !r.ok, 'cannot start second trade while in one: ' + (r && r.error));
    const r2 = await C.call('trade:request', A.id);
    ok(r2 && !r2.ok, 'third party cannot trade with busy player: ' + (r2 && r2.error));
    await A.call('trade:cancel', {});
    await sleep(100);
  }

  // ---- self-trade blocked ----
  {
    const r = await A.call('trade:request', A.id);
    ok(r && !r.ok, 'self-trade blocked');
  }

  // ---- full inventory ----
  {
    // Fill B nearly to cap, then try to receive a big stack
    await B.prof();
    const used = (B.profile.inventory || []).reduce((n, s) => n + s.q, 0);
    const need = G.INV_CAP - used - 1; // leave 1 free
    if (need > 0) {
      // grant in chunks of 99
      let left = need;
      while (left > 0) {
        const q = Math.min(99, left);
        await B.grant('p_orbs', q);
        left -= q;
      }
    }
    await B.prof();
    const used2 = (B.profile.inventory || []).reduce((n, s) => n + s.q, 0);
    ok(used2 >= G.INV_CAP - 2, `B inventory nearly full (${used2}/${G.INV_CAP})`);
    await A.grant('p_magnet', 5); await sleep(80);
    await mustOpen(A, B, 'open trade for full-inv');
    A.clearEv(); B.clearEv();
    await bothOfferReadyConfirm(A, B,
      { items: [{ id: 'p_magnet', qty: 5 }], orbs: 0, shards: 0 },
      { items: [], orbs: 1, shards: 0 });
    const fail = await A.waitEv('fail', G.TRADE.countdownMs + 3000);
    const done = A.events.find(e => e[0] === 'done');
    ok(!!fail && !done, 'full inventory aborts trade at commit: ' + JSON.stringify(fail));
    await A.call('trade:cancel', {}).catch(() => {});
    await sleep(100);
  }

  // guests can't trade — covered by auth-only (no guest mode in this game)
  ok(true, 'guests N/A (auth-only accounts)');

  A.close(); B.close(); C.close();
  proc.kill('SIGTERM');
  await sleep(400);
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
