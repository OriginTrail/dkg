#!/usr/bin/env node
// Idempotent devnet setup for the OT-RFC-27 marketplace test console.
//
//   node devnet/marketplace-rfc27/console/seed.mjs [--subscribe] [--force] [--topup-again] [--timeout <s>]
//
//   1. Seller A (node1) serves + publishes `devnet-llm` (inference, token,
//      0.5 µTRAC/token) and `devnet-knowledge` (query, query-unit,
//      15 µTRAC/query-unit); seller B (node3) serves + publishes `devnet-llm`
//      at 0.8 µTRAC/token (the routing check: the router must pick A).
//      Skipped when the console already published that exact set and the node
//      still serves it (--force republishes).
//   2. Tops up the BUYER's (node2) primary operational wallet by 100 TRAC,
//      preserving its existing balance — once per devnet deployment
//      (--topup-again adds another 100).
//   3. Polls the buyer's GET /api/marketplace/offers until all three offers
//      are discovered. CG sync usually converges ~3 min after the first
//      publish but was observed at ~6 min on a fresh devnet, so the default
//      window is 600 s (--timeout <s> overrides; rerunning keeps polling).
//   4. --subscribe: pre-subscribe the buyer with the console's default plan.
//      By default the buyer is left UNSUBSCRIBED — subscribing is part of the
//      buyer experience in the console.

import { ethers } from 'ethers';
import {
  formatMicroTrac,
  formatTrac,
  getChain,
  nodeFetch,
  parseTracToWei,
  readConsoleState,
  readNode,
  sleep,
  topUpTrac,
  updateConsoleState,
} from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const SUBSCRIBE = flag('--subscribe');
const FORCE = flag('--force');
const TOPUP_AGAIN = flag('--topup-again');
const timeoutIdx = argv.indexOf('--timeout');
const DISCOVERY_TIMEOUT_S = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) : 600;
if (flag('--help') || flag('-h')) {
  console.log('usage: seed.mjs [--subscribe] [--force] [--topup-again] [--timeout <seconds>]');
  process.exit(0);
}

const SELLER_A = 1;
const BUYER = 2;
const SELLER_B = 3;
const BUYER_TOPUP_TRAC = '100';

const OFFERINGS = {
  [SELLER_A]: [
    { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: '500000000000' },
    { offeringLocalId: 'devnet-knowledge', serviceType: 'query', unit: 'query-unit', askPerUnitWei: '15000000000000' },
  ],
  [SELLER_B]: [
    { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: '800000000000' },
  ],
};

/** The console's default buyer plan (kept in sync with public/app.js DEFAULT_PLAN). */
const DEFAULT_PLAN = {
  amountTrac: '0.01',
  buckets: [
    { serviceType: 'inference', budgetTrac: '0.006', priceCapWeiPerUnit: '1000000000000', maxUnitsPerCall: '16000' },
    { serviceType: 'query', budgetTrac: '0.004', priceCapWeiPerUnit: '20000000000000', maxUnitsPerCall: '200' },
  ],
};

const t0 = Date.now();
const elapsed = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const log = (msg) => console.log(`[seed ${elapsed()}] ${msg}`);
const offeringIdFor = (name) => ethers.keccak256(ethers.toUtf8Bytes(name));

function fail(msg) {
  console.error(`[seed] FAILED: ${msg}`);
  process.exit(1);
}

async function marketplaceStatus(num) {
  const r = await nodeFetch(num, '/api/marketplace/status', { timeoutMs: 15_000 });
  if (r.status !== 200) throw new Error(`node${num} /api/marketplace/status → ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

async function ensureIdentity(num) {
  const read = async () => {
    const r = await nodeFetch(num, '/api/status', { auth: false, timeoutMs: 15_000 });
    return r.status === 200 ? BigInt(r.json?.identityId ?? 0) : 0n;
  };
  let id = await read();
  if (id > 0n) return id;
  log(`node${num} has no on-chain identity yet — requesting POST /api/identity/ensure`);
  await nodeFetch(num, '/api/identity/ensure', { method: 'POST', body: {}, timeoutMs: 60_000 });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    id = await read();
    if (id > 0n) return id;
  }
  throw new Error(`node${num} did not register an identity within 60s`);
}

function sameOfferings(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function publishOfferings(num, label) {
  const desired = OFFERINGS[num];
  const remembered = readConsoleState().offerings?.[num];
  const status = await marketplaceStatus(num);
  const serving = status?.seller?.offerings ?? 0;
  if (!FORCE && remembered && sameOfferings(remembered.offerings, desired) && serving === desired.length) {
    log(`${label} (node${num}) already serves + published ${desired.map((o) => o.offeringLocalId).join(', ')} — skipped (--force republishes)`);
    return;
  }
  log(`${label} (node${num}) publishing ${desired.map((o) => `${o.offeringLocalId} @ ${formatMicroTrac(o.askPerUnitWei)} µTRAC/${o.unit}`).join(', ')} …`);
  const r = await nodeFetch(num, '/api/marketplace/seller/offerings', {
    method: 'POST',
    body: { offerings: desired, publish: true },
    timeoutMs: 180_000,
  });
  if (r.status !== 200) fail(`${label} offerings → ${r.status}: ${r.text.slice(0, 400)}`);
  updateConsoleState((s) => {
    s.offerings[num] = { offerings: desired, published: r.json?.published ?? [], publish: true, at: new Date().toISOString() };
  });
  log(`${label} published ${r.json?.published?.length ?? 0} offer KA(s) into the marketplace context graph`);
}

async function topUpBuyer() {
  const chain = await getChain();
  const node = readNode(BUYER);
  const address = node.opWallets[0];
  if (!address) fail('buyer node2 has no operational wallet in .devnet/node2/wallets.json');
  const state = readConsoleState();
  const prior = state.seed?.buyerTopUp;
  if (!TOPUP_AGAIN && prior && prior.hub === chain.addrs.Hub && prior.address === address) {
    const bal = await chain.token.balanceOf(address);
    log(`buyer wallet ${address} already topped up by the seeder on this deployment (balance ${formatTrac(bal)} TRAC) — skipped (--topup-again adds ${BUYER_TOPUP_TRAC})`);
    return;
  }
  const r = await topUpTrac(chain, address, parseTracToWei(BUYER_TOPUP_TRAC));
  updateConsoleState((s) => {
    s.seed = { ...s.seed, buyerTopUp: { hub: chain.addrs.Hub, address, addedWei: r.added.toString(), at: new Date().toISOString() } };
  });
  log(`buyer wallet ${address} topped up +${BUYER_TOPUP_TRAC} TRAC: ${formatTrac(r.before)} → ${formatTrac(r.after)} TRAC`);
}

async function waitForDiscovery(idA, idB) {
  const wanted = [
    { label: 'A devnet-llm', offeringId: offeringIdFor('devnet-llm'), seller: idA, ask: '500000000000' },
    { label: 'A devnet-knowledge', offeringId: offeringIdFor('devnet-knowledge'), seller: idA, ask: '15000000000000' },
    { label: 'B devnet-llm', offeringId: offeringIdFor('devnet-llm'), seller: idB, ask: '800000000000' },
  ];
  const deadline = Date.now() + DISCOVERY_TIMEOUT_S * 1000;
  let lastLine = '';
  let lastPrint = 0;
  while (Date.now() < deadline) {
    let offers = [];
    let note = '';
    try {
      const r = await nodeFetch(BUYER, '/api/marketplace/offers', { timeoutMs: 30_000 });
      if (r.status === 200) offers = Array.isArray(r.json?.offers) ? r.json.offers : [];
      else note = ` (offers → ${r.status}: ${String(r.json?.error ?? r.text).slice(0, 120)})`;
    } catch (err) {
      note = ` (offers request failed: ${err.message})`;
    }
    const found = wanted.map((w) => offers.some((o) =>
      String(o.offeringId).toLowerCase() === w.offeringId.toLowerCase()
      && String(o.sellerIdentityId) === String(w.seller)
      && String(o.askPerUnitWei) === w.ask));
    const line = `buyer (node2) sees ${found.filter(Boolean).length}/3 offers: `
      + wanted.map((w, i) => `${w.label} ${found[i] ? 'yes' : '…'}`).join(' · ') + note;
    if (found.every(Boolean)) {
      log(line);
      return offers;
    }
    if (line !== lastLine || Date.now() - lastPrint > 15_000) {
      log(line);
      lastLine = line;
      lastPrint = Date.now();
    }
    await sleep(4000); // each poll also nudges the buyer's throttled SWM backfill
  }
  fail(`buyer did not discover all 3 offers within ${DISCOVERY_TIMEOUT_S}s — check node logs (.devnet/node2/daemon.log); rerun this seeder to keep polling`);
  return [];
}

async function maybeSubscribe() {
  const st = await marketplaceStatus(BUYER);
  if (!SUBSCRIBE) {
    log(`buyer subscription: ${st?.buyer?.subscribed ? `already subscribed (epoch ${st.buyer.epoch})` : 'NOT subscribed — subscribe from the console (or rerun with --subscribe)'}`);
    return;
  }
  if (st?.buyer?.subscribed && String(st.buyer.epoch) === String(st.epoch) && !FORCE) {
    log(`buyer already subscribed for epoch ${st.buyer.epoch} — skipped (--force re-subscribes and adds funds)`);
    return;
  }
  const buckets = DEFAULT_PLAN.buckets.map((b) => ({
    match: { serviceType: b.serviceType },
    budgetWei: parseTracToWei(b.budgetTrac).toString(),
    priceCapWeiPerUnit: b.priceCapWeiPerUnit,
    maxUnitsPerCall: b.maxUnitsPerCall,
  }));
  const policy = {
    totalBudgetWei: buckets.reduce((s, b) => s + BigInt(b.budgetWei), 0n).toString(),
    buckets,
  };
  const amountWei = parseTracToWei(DEFAULT_PLAN.amountTrac).toString();
  log(`subscribing the buyer: ${DEFAULT_PLAN.amountTrac} TRAC for the current epoch …`);
  const r = await nodeFetch(BUYER, '/api/marketplace/subscribe', {
    method: 'POST',
    body: { amountWei, policy },
    timeoutMs: 120_000,
  });
  if (r.status !== 200) fail(`subscribe → ${r.status}: ${r.text.slice(0, 400)}`);
  updateConsoleState((s) => {
    s.plans[BUYER] = {
      epoch: String(r.json.epoch),
      policy,
      lastAmountWei: amountWei,
      fundedByConsoleWei: amountWei,
      sessionKeyAddress: r.json.sessionKeyAddress,
      txHash: r.json.txHash,
      at: new Date().toISOString(),
    };
  });
  log(`subscribed: epoch ${r.json.epoch}, session key ${r.json.sessionKeyAddress}, tx ${r.json.txHash}`);
}

async function main() {
  log('checking the devnet …');
  let chain;
  try {
    chain = await getChain();
  } catch (err) {
    fail(`chain not ready: ${err.message} — start the devnet first (./scripts/devnet.sh start 6 && node devnet/_bootstrap/bootstrap.cjs)`);
  }
  log(`chain ok — Hub ${chain.addrs.Hub}, Marketplace ${chain.addrs.Marketplace}`);
  for (const num of [SELLER_A, BUYER, SELLER_B]) {
    try {
      const st = await marketplaceStatus(num);
      if (st?.enabled !== true) fail(`node${num} marketplace is disabled (config.marketplace.enabled / DKG_MARKETPLACE_ENABLED=1)`);
      if (st?.degraded) log(`WARNING node${num} marketplace degraded: ${st.degraded}`);
    } catch (err) {
      fail(`node${num} is not reachable: ${err.message}`);
    }
  }
  const [idA, idB] = await Promise.all([ensureIdentity(SELLER_A), ensureIdentity(SELLER_B)]);
  log(`seller A = node1 (identity ${idA}), seller B = node3 (identity ${idB}), buyer = node2`);

  await publishOfferings(SELLER_A, 'seller A');
  await publishOfferings(SELLER_B, 'seller B');
  await topUpBuyer();
  const offers = await waitForDiscovery(idA, idB);
  await maybeSubscribe();

  console.log('');
  console.log('Seed complete.');
  console.log(`  offers discovered on the buyer: ${offers.length} (all 3 expected offers present)`);
  console.log('  next: pnpm devnet:marketplace:console   → open http://127.0.0.1:9300/');
}

main().catch((err) => fail(err?.stack ?? String(err)));
