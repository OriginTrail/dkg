#!/usr/bin/env node
// Idempotent devnet setup for the OT-RFC-27 marketplace test console.
//
//   node devnet/marketplace-rfc27/console/seed.mjs [--subscribe] [--force] [--topup-again]
//                                                  [--mint-key] [--timeout <s>]
//
//   0. Probes the llm-stub (GET http://127.0.0.1:${LLM_STUB_PORT:-18080}/healthz).
//      When it is down, prints the one command that starts it and seeds
//      anyway: mounting a chat connector makes no upstream call, so the
//      offerings publish either way and chat calls work once the stub is up.
//   1. Writes each seller's stub secret file
//      (.devnet/node<n>/marketplace/.secrets/llm-stub.env, file 0600, dir
//      0700, OPENAI_API_KEY=devnet-stub-key). Config holds only the path.
//   2. Seller A (node1) serves + publishes `devnet-llm` (inference, token,
//      0.5 µTRAC/token), `devnet-knowledge` (query, query-unit,
//      15 µTRAC/query-unit) and `devnet-chat` (OpenAI chat, model
//      `stub-chat`, 0.5 µTRAC/token: an openai-compatible connector to the
//      llm-stub, metered with the pinned `stub-words-v1` tokenizer); seller B
//      (node3) serves + publishes `devnet-llm` at 0.8 µTRAC/token and
//      `devnet-chat` at 0.8 µTRAC/token (the routing check: the router must
//      pick A). The sets live in devnet-offerings.mjs.
//      Each offering is its own Knowledge Asset in Verifiable Memory. The set
//      is always sent: the node leaves an offering whose published content is
//      unchanged alone (no transaction) and publishes a changed one as an
//      on-chain update of the same KA, so a rerun also restores asks that
//      were changed elsewhere.
//   3. Tops up the BUYER's (node2) primary operational wallet by 100 TRAC,
//      preserving its existing balance — once per devnet deployment
//      (--topup-again adds another 100).
//   4. Polls the buyer's GET /api/marketplace/offers until all five offers
//      are discovered. The buyer usually sees an offer within seconds of its
//      publish (~10 s on a fresh devnet, the first publish included, which
//      also anchors the `marketplace` CG on-chain); the default window is
//      300 s (--timeout <s> overrides; rerunning keeps polling).
//   5. --subscribe: pre-subscribe the buyer with the console's default plan.
//      By default the buyer is left UNSUBSCRIBED — subscribing is part of the
//      buyer experience in the console.
//   6. --mint-key: mint a buyer gateway key on node2 (POST
//      /api/marketplace/keys, budget 0.001 TRAC, model stub-chat) and print it
//      ONCE with a ready-to-run curl. The node stores only its hash.

import { ethers } from 'ethers';
import {
  ASK_CHAT_A,
  ASK_CHAT_B,
  ASK_KNOWLEDGE_A,
  ASK_LLM_A,
  ASK_LLM_B,
  LLM_STUB_RUN_HINT,
  STUB_MODEL_ID,
  devnetOfferings,
  llmStubPort,
  probeLlmStub,
  writeStubSecret,
} from './devnet-offerings.mjs';
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
const MINT_KEY = flag('--mint-key');
const timeoutIdx = argv.indexOf('--timeout');
const DISCOVERY_TIMEOUT_S = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) : 300;
if (flag('--help') || flag('-h')) {
  console.log('usage: seed.mjs [--subscribe] [--force] [--topup-again] [--mint-key] [--timeout <seconds>]');
  process.exit(0);
}

const SELLER_A = 1;
const BUYER = 2;
const SELLER_B = 3;
const BUYER_TOPUP_TRAC = '100';

const STUB_PORT = llmStubPort();
const OFFERINGS = devnetOfferings({ port: STUB_PORT });
/** Gateway key minted by --mint-key: 0.001 TRAC, stub-chat only. */
const MINT_KEY_BUDGET_WEI = '1000000000000000';

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

async function publishOfferings(num, label) {
  const desired = OFFERINGS[num];
  const kind = (o) => (o.connector ? ` [${o.connector.kind} → ${STUB_MODEL_ID}, ${o.metering?.tokenizer?.kind ?? 'provider-reported'}]` : '');
  log(`${label} (node${num}) publishing ${desired.map((o) => `${o.offeringLocalId} @ ${formatMicroTrac(o.askPerUnitWei)} µTRAC/${o.unit}${kind(o)}`).join(', ')} …`);
  const r = await nodeFetch(num, '/api/marketplace/seller/offerings', {
    method: 'POST',
    body: { offerings: desired, publish: true },
    timeoutMs: 180_000,
  });
  if (r.status !== 200) fail(`${label} offerings → ${r.status}: ${r.text.slice(0, 400)}`);
  updateConsoleState((s) => {
    s.offerings[num] = { offerings: desired, published: r.json?.published ?? [], publish: true, at: new Date().toISOString() };
  });
  const assets = Array.isArray(r.json?.assets) ? r.json.assets : [];
  const outcome = (a) => (a.outcome === 'unchanged'
    ? `${a.offeringLocalId} unchanged (no transaction)`
    : `${a.offeringLocalId} published on-chain (revision ${a.revision})`);
  log(`${label}: ${assets.length > 0 ? assets.map(outcome).join(' · ') : `${r.json?.published?.length ?? 0} offer KA(s) published`}`);
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
    { label: 'A devnet-llm', offeringId: offeringIdFor('devnet-llm'), seller: idA, ask: ASK_LLM_A },
    { label: 'A devnet-knowledge', offeringId: offeringIdFor('devnet-knowledge'), seller: idA, ask: ASK_KNOWLEDGE_A },
    { label: 'A devnet-chat', offeringId: offeringIdFor('devnet-chat'), seller: idA, ask: ASK_CHAT_A, chat: true },
    { label: 'B devnet-llm', offeringId: offeringIdFor('devnet-llm'), seller: idB, ask: ASK_LLM_B },
    { label: 'B devnet-chat', offeringId: offeringIdFor('devnet-chat'), seller: idB, ask: ASK_CHAT_B, chat: true },
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
    // A chat offer counts once its OpenAI-chat shape and metering pin arrived
    // too (an older node's view of the same KA would lack them).
    const found = wanted.map((w) => offers.some((o) =>
      String(o.offeringId).toLowerCase() === w.offeringId.toLowerCase()
      && String(o.sellerIdentityId) === String(w.seller)
      && String(o.askPerUnitWei) === w.ask
      && (!w.chat || (o.modelId === STUB_MODEL_ID && o.apiShape === 'openai-chat/v1' && o.metering?.basis === 'pinned'))));
    const line = `buyer (node2) sees ${found.filter(Boolean).length}/${wanted.length} offers: `
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
    await sleep(4000); // each poll also nudges the buyer's throttled offer refresh
  }
  fail(`buyer did not discover all ${wanted.length} offers within ${DISCOVERY_TIMEOUT_S}s — check node logs (.devnet/node2/daemon.log); rerun this seeder to keep polling`);
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

/** Write both sellers' stub secret files (0600 in a 0700 dir); config carries only the path. */
function writeSecrets() {
  for (const num of [SELLER_A, SELLER_B]) {
    const file = writeStubSecret(num);
    log(`node${num} stub secret → ${file} (0600; OPENAI_API_KEY for the openai-compatible connector)`);
  }
}

async function checkLlmStub() {
  const probe = await probeLlmStub(STUB_PORT);
  if (probe.ok) {
    log(`llm-stub is up on http://127.0.0.1:${STUB_PORT}/v1 (model ${probe.model}, ${probe.calls} call(s) so far)`);
    return true;
  }
  log(`llm-stub is NOT reachable on http://127.0.0.1:${STUB_PORT} (${probe.error}) — seeding anyway (mounting a connector makes no upstream call).`);
  log(`  start it in another terminal:  ${LLM_STUB_RUN_HINT}`);
  return false;
}

/** --mint-key: one buyer gateway key, printed ONCE with a ready-to-run curl. */
async function mintGatewayKey() {
  const st = await marketplaceStatus(BUYER);
  if (st?.gateway && st.gateway.enabled === false) {
    log('gateway is disabled on node2 (marketplace.buyer.gateway.enabled / DKG_MARKETPLACE_GATEWAY_ENABLED) — no key minted');
    return null;
  }
  const r = await nodeFetch(BUYER, '/api/marketplace/keys', {
    method: 'POST',
    body: { label: 'seed', budgetWei: MINT_KEY_BUDGET_WEI, modelAllowlist: [STUB_MODEL_ID], allowQuery: true, rps: 5 },
    timeoutMs: 30_000,
  });
  if (r.status !== 201 || typeof r.json?.key !== 'string') fail(`mint gateway key → ${r.status}: ${r.text.slice(0, 300)}`);
  log(`minted gateway key ${r.json.record?.keyId} (budget ${formatMicroTrac(MINT_KEY_BUDGET_WEI)} µTRAC, model ${STUB_MODEL_ID}); the node stores only its hash`);
  return { key: r.json.key, keyId: r.json.record?.keyId, apiPort: readNode(BUYER).apiPort, subscribed: Boolean(st?.buyer?.subscribed) };
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

  const stubUp = await checkLlmStub();
  writeSecrets();
  await publishOfferings(SELLER_A, 'seller A');
  await publishOfferings(SELLER_B, 'seller B');
  await topUpBuyer();
  const offers = await waitForDiscovery(idA, idB);
  await maybeSubscribe();
  const minted = MINT_KEY ? await mintGatewayKey() : null;

  console.log('');
  console.log('Seed complete.');
  console.log(`  offers discovered on the buyer: ${offers.length} (all 5 expected offers present)`);
  if (!stubUp) console.log(`  llm-stub: NOT running — chat calls fail until you start it:  ${LLM_STUB_RUN_HINT}`);
  if (minted) {
    const base = `http://127.0.0.1:${minted.apiPort}/api/marketplace/gateway/v1`;
    console.log('');
    console.log(`  Gateway key ${minted.keyId} (shown ONCE — copy it now; the node keeps only its hash):`);
    console.log(`    ${minted.key}`);
    console.log('');
    console.log(`  curl ${base}/chat/completions \\`);
    console.log(`    -H "Authorization: Bearer ${minted.key}" -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model":"${STUB_MODEL_ID}","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"hello marketplace world"}]}'`);
    if (!minted.subscribed) console.log('  (the buyer is not subscribed yet — subscribe in the console, or rerun with --subscribe, before calling)');
  }
  console.log('  next: pnpm devnet:marketplace:console   → open http://127.0.0.1:9300/');
}

main().catch((err) => fail(err?.stack ?? String(err)));
