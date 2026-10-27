/**
 * OT-RFC-27 NeuroSymbolic Marketplace — protocol-level prototype devnet
 * validation (design doc: agent-docs/plans/2026-10-25-rfc27-marketplace-protocol.md §7).
 *
 * Exercises the RFC-27 loop end to end across every layer the prototype
 * touches, on a live 6-node devnet:
 *
 *   1. Sellers (node1 = A, node3 = B, both core) configure offerings via
 *      `POST /api/marketplace/seller/offerings`; the offer KAs land in the
 *      shared `marketplace` Context Graph.
 *   2. Buyer (node2) discovers all three offers over CG sync (polled — the
 *      FIRST seller publish also registers the `marketplace` CG on-chain, and
 *      buyer-side subscription catchup/backfill can take minutes to converge).
 *   3. Buyer funds an on-chain subscription (`POST /api/marketplace/subscribe`)
 *      with a per-bucket plan policy; the bucket funding and the registered
 *      session key are asserted against the Marketplace contract views.
 *   4. Drill phase A: a chat-style invoke routes to seller A (CHEAPER ask — B
 *      offers the same `devnet-llm` at a higher price as the routing check)
 *      and a SPARQL invoke serves against A's local graph, metered by the
 *      static query cost schedule (admission 3 + delivery 0|1 units);
 *      results, metered costs, receipt value math and the shared RCPT_DOMAIN
 *      EIP-191 crypto are asserted. A's claims stay UNSUBMITTED (no flush).
 *   5. Drill phase B: a deny-list re-subscribe drives usage to B while A's
 *      claims are still unsubmitted — the genuine RFC over-authorization
 *      race. Sellers now refuse UNDERFUNDED when on-chain claimed + their OWN
 *      unsubmitted exposure + the call's worst case (maxUnits·ask) exceeds
 *      bucket.funded, so serialized claim visibility can never over-claim;
 *      only mutually INVISIBLE unsubmitted exposure can.
 *   6. Both sellers flush (`settle {action:'flush-receipts'}`) → per-seller
 *      `getSellerClaim` equals each seller's summed invoke costs EXACTLY, and
 *      combined A+B claims EXCEED the final funded bucket.
 *   7. Soft ceiling: a call whose worst case (`maxUnits·ask`) crosses 95% of
 *      its bucket is refused locally (409 NO_ROUTE / 'no-eligible-offer' with
 *      a 'soft-ceiling' rejection) and ZERO meter movement (no reservation
 *      leak).
 *   8. `timeWarpSeconds` past `settlementDeadline(epoch)` → finalize →
 *      pro-rata (floor) asserted against an independent bigint mirror (which,
 *      like the contract and the domain `proRataFinalize`, OMITS claimed==0
 *      sellers) → both sellers claim; operational-wallet TRAC deltas equal
 *      `min(pool·QIF_i/1e18, rewardCapMultiple·R_i)` within rounding, with QIF
 *      recomputed in the test from the on-chain `R_i, Q_i, ΣR, ΣQ, λ`, and the
 *      per-epoch reward distribution totals reconciled against the payouts.
 *
 * A second describe, `… buyer gateway (devnet e2e)` (steps G1–G15, spec
 * agent-docs/plans/2026-10-27-rfc27-sellers-gateway.md §13.3), drives the
 * OpenAI-compatible buyer gateway end to end in the epoch after the drill:
 * both sellers serve `devnet-chat` (an openai-compatible chat connector to an
 * IN-PROCESS llm-stub, metered with the pinned `stub-words-v1` tokenizer),
 * the buyer subscribes, mints a scoped gateway key, and calls /models, chat
 * (JSON, buffered SSE, truncation, native tool calls) and /query with the
 * key; usage equals the stub-words count, the buyer's recount agrees, the key
 * budget refuses an over-budget call, scopes hold, the auth carve-out admits
 * gateway keys nowhere else, revocation is immediate, and seller A's on-chain
 * claim grows by exactly the gateway costs. It is self-sufficient: `-t
 * gateway` runs it alone on a seeded devnet.
 *
 * AMOUNTS: the subscription is deliberately funded in SMALL wei amounts
 * (Σ = 0.00092 TRAC) while the buyer wallet is topped up BY 10 TRAC on top of
 * whatever it already holds (its bootstrap balance is real node capital and
 * must survive this suite) — at the RFC-pinned
 * asks (0.5 µTRAC/token, 15 µTRAC/query-unit) that is what makes the
 * over-authorization drill (totalClaimed > funded) reachable with a handful
 * of real metered calls, each with a TIGHT maxUnits so the seller's
 * UNDERFUNDED headroom check admits it (reserved worst case == metered actual
 * — see the drill arithmetic at the tranche constants). The LOCAL plan-policy
 * budgets are larger than the on-chain funding on purpose: the local meter
 * governs admission, the chain bucket governs settlement, and the gap between
 * them is exactly what the pro-rata finalization exists to absorb.
 *
 * RACE WINDOW: seller receipt batchers auto-submit once their oldest pending
 * claim is 15s old (checked by a 5s flush timer), and seller B reads the
 * bucket fresh at admission (15s cache) — so everything from A's FIRST drill
 * serve (step 4) through B's serve (step 5) must complete within ~15s, or A's
 * claims land on-chain first and B CORRECTLY refuses UNDERFUNDED. Steps 4–5
 * run back-to-back with no waits; do not insert polling between them.
 *
 * ISOLATION: mutates only marketplace state keyed to this buyer/epoch
 * (fresh buckets, this suite's own offer KAs in the `marketplace` CG) plus
 * the buyer wallet's TRAC balance (increased). TIME-WARP: warps past the
 * settlement deadline — on a shared devnet run this suite after the
 * RS/consensus suites (same category as the other warping suites).
 *
 * Preconditions:
 *   pnpm build
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs
 *
 * Run: pnpm test:devnet:marketplace-rfc27
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  REPO_ROOT,
  contractAt,
  detectDevnet,
  ensureAllIdentities,
  fundTrac,
  getJson,
  postJson,
  sleep,
  timeWarpSeconds,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import {
  GATEWAY_KEY_PATTERN,
  adminRequest,
  asBigInt,
  expectGatewayError,
  expectGatewayUnauthorized,
  gatewayRequest,
  httpRequest,
  parseSse,
  type HttpReply,
} from './gateway-helpers.js';
// Plain-ESM devnet tooling (no type declarations; vitest transpiles without type checks).
import { createLlmStub } from './llm-stub.mjs';
import {
  ASK_CHAT_A,
  ASK_CHAT_B,
  ASK_KNOWLEDGE_A as SEED_ASK_KNOWLEDGE_A,
  ASK_LLM_A as SEED_ASK_LLM_A,
  ASK_LLM_B as SEED_ASK_LLM_B,
  LLM_STUB_API_KEY,
  STUB_MODEL_ID,
  chatOffering,
  llmStubPort,
  stubSecretFile,
  writeStubSecret,
} from './console/devnet-offerings.mjs';

// ───────────────────────────── constants ─────────────────────────────────

const SCALE18 = 10n ** 18n;

// Asks pinned by the design doc §7: A sells `devnet-llm` at 0.5 µTRAC/token
// and `devnet-knowledge` at 15 µTRAC/query-unit; B sells `devnet-llm` at a
// HIGHER ask so the router picking A proves lowest-ask selection (the price
// caps below admit both).
const ASK_LLM_A = 500_000_000_000n; // 5e11 wei/token
const ASK_KNOWLEDGE_A = 15_000_000_000_000n; // 1.5e13 wei/query-unit
const ASK_LLM_B = 800_000_000_000n; // 8e11 wei/token

// On-chain subscription tranches (all land in the SAME (buyer, epoch) bucket;
// fundSubscription accumulates). Drill arithmetic against the seller's
// UNDERFUNDED admission check (on-chain claimed + the seller's OWN
// unsubmitted exposure + the call's worst case maxUnits·ask must fit
// bucket.funded):
//   phase A (funded 5e14, nothing claimed): inference worst 500·5e11 = 2.5e14
//     ≤ 5e14 ✓, then query worst 16·1.5e13 = 2.4e14 on top of A's own 2.5e14
//     pending → 4.9e14 ≤ 5e14 ✓
//   phase B (funded 9e14 after tranche 2; A's claims still UNSUBMITTED and
//     invisible to B): inference worst 800·8e11 = 6.4e14 ≤ 9e14 ✓
//   combined actuals ≥ 2.5e14 + 3·1.5e13 + 6.4e14 = 9.35e14 > 9.2e14 = the
//     final funded total (tranche 3 lands only after both phases flushed).
//     The query serves admission 3 + delivery 0|1 units under the static
//     query cost schedule, so its actual is 3–4 units, not its worst case.
const SUB1_WEI = 500_000_000_000_000n; // 5e14
const SUB2_WEI = 400_000_000_000_000n; // 4e14
const SUB3_WEI = 20_000_000_000_000n; // 2e13
const FUNDED_TOTAL_WEI = SUB1_WEI + SUB2_WEI + SUB3_WEI; // 9.2e14 (0.00092 TRAC)

// The shared prototype token schedule is countTokens = ceil(utf8Bytes/4), and
// the deterministic inference stub SATURATES: the echo is truncated to fit,
// so for an ASCII prompt with promptTokens ≤ maxUnits < 2·promptTokens the
// served units equal maxUnits EXACTLY. That makes the reserved worst case
// (maxUnits·ask) equal the metered actual — the property the drill arithmetic
// above depends on.
const BASE_SENTENCE =
  'OT-RFC-27 devnet drill: the neurosymbolic marketplace pays sellers from a pooled subscription by finalized receipt value. '; // 122 UTF-8 bytes
/** 15 × 122 B = 1830 B → 458 tokens: inside (400, 500], so BOTH drill
 *  inference grants below saturate (458 ≤ 500 < 916 and 458 ≤ 800 < 916);
 *  step 4 asserts these bounds before serving anything. */
const DRILL_PROMPT = BASE_SENTENCE.repeat(15);
/** Large prompt for the soft-ceiling step — never served, refused locally. */
const PROMPT = BASE_SENTENCE.repeat(18);
const SPARQL_PROBE = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5'; // 42 UTF-8 bytes

// TIGHT per-call unit grants: worst case == actual for the saturated
// inference calls. The query is metered by the static query cost schedule
// (dkg-mkt-query-cost/1): admission = base 2 + 1 triple pattern (LIMIT
// present, so no surcharge) = 3, delivery = ceil(rows/100) with rows ≤ 5
// (LIMIT 5) → served ∈ [3, 4]; the seller's row cap (16 − 3)·100 = 1300
// never binds. The grant keeps its worst case 16·1.5e13 for the drill.
const INF_MAX_UNITS_A = 500n; // worst 500·5e11 = 2.5e14 (tranche-1 bucket 5e14)
const INF_MAX_UNITS_B = 800n; // worst 800·8e11 = 6.4e14 (funded 9e14 at phase B)
const QUERY_MAX_UNITS = 16n; // worst 16·1.5e13 = 2.4e14 (fits 5e14 − 2.5e14 pending)

// Shared crypto spec (MUST match Solidity + packages/marketplace byte-for-byte).
const RCPT_DOMAIN = 'DKG_MKT_RCPT_V1';

// Tolerance for reward-vs-QIF assertions: covers fixed-point floor-ordering
// differences between the contract and the test mirror (which are < 1 wei at
// this pool size) with a wide margin — 1e6 wei = 1e-12 TRAC.
const REWARD_TOLERANCE_WEI = 1_000_000n;

const CHRONOS_ABI = [
  'function getCurrentEpoch() view returns (uint256)',
  'function timeUntilNextEpoch() view returns (uint256)',
];

// ───────────────────────────── fixtures ──────────────────────────────────

interface SuiteCtx {
  state: DevnetState;
  marketplace: ethers.Contract;
  chronos: ethers.Contract;
  sellerA: DevnetNode; // node1 (core) — cheap LLM + knowledge offerings
  sellerB: DevnetNode; // node3 (core) — expensive LLM offering
  buyer: DevnetNode; // node2 (core)
  idA: bigint;
  idB: bigint;
  /** The buyer's on-chain funding wallet = node2's primary operational wallet
   *  (the chain adapter signs marketplace writes with its primary signer). */
  buyerAddr: string;
  /** The Chronos epoch every subscription tranche funds (pinned explicitly on
   *  each subscribe call so a mid-test epoch flip fails loudly, not subtly). */
  epoch: bigint;
  /** The session key registered by the FIRST subscribe (step 3) — step 5
   *  asserts it STAYS bound: session keys bind per buyer permanently, so a
   *  later fundSubscription can never invalidate an earlier key. */
  firstSessionKey?: string;
  expectedClaimA: bigint;
  expectedClaimB: bigint;
}

let ctx: SuiteCtx;

// ───────────────────────────── helpers ───────────────────────────────────

/** Coerce a JSON-serialized bigint (string | number) with a labeled failure. */
function big(v: unknown, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || (typeof v === 'string' && v.length > 0)) return BigInt(v);
  throw new Error(`${label}: expected a bigint-coercible value, got ${JSON.stringify(v)}`);
}

/** offeringId = keccak256(utf8(offeringLocalId)) — mirrors offeringIdFor(). */
const offeringIdFor = (name: string): string => ethers.keccak256(ethers.toUtf8Bytes(name));

/** The shared receipt digest (RCPT_DOMAIN spec) — recomputed independently. */
function receiptDigest(
  authDigest: string,
  servedUnits: bigint,
  receiptValueWei: bigint,
  resultCommitment: string,
): string {
  return ethers.solidityPackedKeccak256(
    ['string', 'bytes32', 'uint64', 'uint256', 'bytes32'],
    [RCPT_DOMAIN, authDigest, servedUnits, receiptValueWei, resultCommitment],
  );
}

interface PolicyBucketSpec {
  serviceType: string;
  budgetWei: bigint;
  priceCapWeiPerUnit: bigint;
  maxUnitsPerCall: bigint;
}

/** Wire-shape a PlanPolicy (wei/unit fields as strings — the daemon parses
 *  operator strings into bigint). totalBudget = Σ bucket budgets. */
function policyJson(buckets: PolicyBucketSpec[], sellerDeny?: bigint[]): Record<string, unknown> {
  const total = buckets.reduce((sum, b) => sum + b.budgetWei, 0n);
  return {
    totalBudgetWei: total.toString(),
    buckets: buckets.map((b) => ({
      match: { serviceType: b.serviceType },
      budgetWei: b.budgetWei.toString(),
      priceCapWeiPerUnit: b.priceCapWeiPerUnit.toString(),
      maxUnitsPerCall: b.maxUnitsPerCall.toString(),
    })),
    ...(sellerDeny ? { sellerDeny: sellerDeny.map((id) => id.toString()) } : {}),
  };
}

async function subscribe(
  amountWei: bigint,
  policy: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  return postJson(ctx.buyer, '/api/marketplace/subscribe', {
    amountWei: amountWei.toString(),
    epoch: Number(ctx.epoch),
    policy,
  });
}

/** Subscribe a tranche and wait until the on-chain bucket shows the new total. */
async function subscribeAndConfirm(
  amountWei: bigint,
  policy: Record<string, unknown>,
  expectedFundedWei: bigint,
  label: string,
): Promise<void> {
  const sub = await subscribe(amountWei, policy);
  expect(sub.status, `${label} subscribe failed: ${JSON.stringify(sub.json)}`).toBe(200);
  await waitFor(
    `${label}: getBucket(${ctx.buyerAddr}, ${ctx.epoch}).funded == ${expectedFundedWei}`,
    60_000,
    2_000,
    async () => {
      const bucket = await ctx.marketplace.getBucket(ctx.buyerAddr, ctx.epoch);
      return bucket.funded === expectedFundedWei ? bucket : null;
    },
  );
}

/**
 * Assert a served invoke end to end: routed to the expected seller, cost math
 * (`costWei == servedUnits·ask`), receipt value math, and the shared
 * RCPT_DOMAIN crypto — the seller's EIP-191 signature over the independently
 * recomputed receipt digest must recover to `seller.address`, which the buyer
 * now sets to the RECOVERED, on-chain-identity-verified receipt signer (on
 * this devnet the seller's operational wallet, the same wallet that submits
 * the receipt batch). Recovering the SAME address from the INDEPENDENTLY
 * recomputed digest proves the signature covers exactly the servedUnits,
 * value and resultCommitment this response carries.
 * `expectedUnits` (drill calls) pins the stub's saturation: served == maxUnits
 * exactly, so the admission-time worst case equals the metered actual.
 * Returns `costWei` so callers can accumulate the expected on-chain claim.
 */
function assertServedInvoke(
  r: { status: number; json: any },
  label: string,
  expectedSellerId: bigint,
  askPerUnitWei: bigint,
  expectedUnits?: bigint,
): bigint {
  expect(r.status, `${label} failed: ${JSON.stringify(r.json)}`).toBe(200);
  const inv = r.json;
  expect(
    big(inv?.seller?.identityId, `${label} seller.identityId`),
    `${label}: routed to the wrong seller`,
  ).toBe(expectedSellerId);
  const servedUnits = big(inv?.servedUnits, `${label} servedUnits`);
  expect(servedUnits, `${label}: servedUnits must be metered`).toBeGreaterThan(0n);
  if (expectedUnits !== undefined) {
    expect(
      servedUnits,
      `${label}: the saturating stub must serve maxUnits exactly (reserved worst case == actual)`,
    ).toBe(expectedUnits);
  }
  const costWei = big(inv?.costWei, `${label} costWei`);
  expect(costWei, `${label}: costWei must equal servedUnits·askPerUnit`).toBe(
    servedUnits * askPerUnitWei,
  );
  expect(inv?.result, `${label}: a served invoke must carry a result`).toBeDefined();

  const rcpt = inv?.receipt;
  expect(big(rcpt?.receiptValueWei, `${label} receiptValueWei`)).toBe(costWei);
  expect(String(rcpt?.authDigest)).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(String(rcpt?.resultCommitment)).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const digest = receiptDigest(rcpt.authDigest, servedUnits, costWei, rcpt.resultCommitment);
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), rcpt.sellerSig);
  expect(
    recovered.toLowerCase(),
    `${label}: sellerSig must recover to the seller's receipt wallet over the shared RCPT_DOMAIN digest`,
  ).toBe(String(inv?.seller?.address).toLowerCase());
  return costWei;
}

/** Flush a seller's receipt batcher and wait for its on-chain claim to equal
 *  the exact sum of the invoke costs (value = servedUnits·askPerUnit, so the
 *  buyer-side costs and the contract-side claims must agree to the wei). */
async function flushAndConfirmClaim(
  seller: DevnetNode,
  identityId: bigint,
  expectedClaimedWei: bigint,
  label: string,
): Promise<void> {
  const flush = await postJson(seller, '/api/marketplace/settle', { action: 'flush-receipts' });
  expect(flush.status, `${label} flush-receipts failed: ${JSON.stringify(flush.json)}`).toBe(200);
  const claim = await waitFor(
    `${label}: getSellerClaim(buyer, ${ctx.epoch}, ${identityId}).claimed == ${expectedClaimedWei}`,
    120_000,
    3_000,
    async () => {
      const c = await ctx.marketplace.getSellerClaim(ctx.buyerAddr, ctx.epoch, identityId);
      return c.claimed === expectedClaimedWei ? c : null;
    },
  );
  // getSellerClaim's 3rd field: the first accepted claim must set the explicit
  // enrollment flag (the claimant-list membership finalization iterates).
  expect(claim.enrolled, `${label}: an accepted claim must enroll the seller`).toBe(true);
}

/** Sum a node's operational-wallet TRAC — rewards pay the submitting
 *  operational wallet (the adapter's primary signer); summing the whole pool
 *  keeps the delta robust to which pool slot signed. */
async function nodeOpTrac(node: DevnetNode): Promise<bigint> {
  let sum = 0n;
  for (const w of node.opWallets) {
    sum += BigInt(await ctx.state.token.balanceOf(w.address));
  }
  return sum;
}

/** The QIF mirror — recomputed from on-chain accounting, same floor math and
 *  ΣQ=0 guard as the contract: (1e18−λ)·R_i/ΣR + λ·Q_i/ΣQ (18-dec fixed). */
function qif18Mirror(
  lambda: bigint,
  r: bigint,
  sigmaR: bigint,
  q: bigint,
  sigmaQ: bigint,
): bigint {
  const valueTerm = sigmaR === 0n ? 0n : ((SCALE18 - lambda) * r) / sigmaR;
  const scoreTerm = sigmaQ === 0n ? 0n : (lambda * q) / sigmaQ;
  return valueTerm + scoreTerm;
}

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

// ───────────────────────────── devnet connection ─────────────────────────

/** Chain + node handles both describes need (each describe connects on its own). */
interface DevnetHandles {
  state: DevnetState;
  marketplace: ethers.Contract;
  chronos: ethers.Contract;
  sellerA: DevnetNode;
  sellerB: DevnetNode;
  buyer: DevnetNode;
  /** node2's primary operational wallet: the adapter's primary signer is fundSubscription's msg.sender. */
  buyerAddr: string;
}

/** Wall-clock ms of this process's last chain time warp (0 = none). */
let lastWarpAtMs = 0;

/** evm_increaseTime + mine, remembering when (see `waitForNodeChainClocks`). */
async function warpChain(state: DevnetState, seconds: number): Promise<void> {
  await timeWarpSeconds(state.provider, seconds);
  lastWarpAtMs = Date.now();
}

/**
 * Nodes keep a chain-time OFFSET that they refresh at most every 30 s (the
 * marketplace chain clock). Right after a warp, a buyer whose last refresh
 * predates the warp signs an authorization expiry in the PAST (by the warp)
 * — sellers refuse it EXPIRED, or a seller with an equally stale clock
 * serves it and the claim reverts on-chain. Wait out one refresh interval
 * after this process's last warp before signing new calls.
 */
async function waitForNodeChainClocks(): Promise<void> {
  const left = lastWarpAtMs + 31_000 - Date.now();
  if (lastWarpAtMs > 0 && left > 0) await sleep(left);
}

async function connectMarketplaceDevnet(): Promise<DevnetHandles> {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run `./scripts/devnet.sh start 6` (then `node devnet/_bootstrap/bootstrap.cjs`) before this suite.',
    );
  }
  const state = detected;
  await ensureAllIdentities(state, 4);

  // The Marketplace contract is an optional Hub binding — a devnet deployed
  // before the RFC-27 contracts landed has no entry, so fail with the remedy.
  let marketplaceAddr = ethers.ZeroAddress;
  try {
    marketplaceAddr = await state.hub.getContractAddress('Marketplace');
  } catch {
    /* unregistered name — handled below */
  }
  if (!marketplaceAddr || marketplaceAddr === ethers.ZeroAddress) {
    throw new Error(
      'Marketplace contract is not registered in this devnet Hub — redeploy the devnet from this branch (`./scripts/devnet.sh clean && ./scripts/devnet.sh start 6`) so the RFC-27 deploy scripts run.',
    );
  }
  state.addrs.Marketplace = marketplaceAddr;
  const marketplaceAbi = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/chain/abi/Marketplace.json'), 'utf8'),
  );
  const marketplace = contractAt(state, 'Marketplace', marketplaceAbi);
  const chronos = contractAt(state, 'Chronos', CHRONOS_ABI);

  const sellerA = state.nodes[1]!;
  const buyer = state.nodes[2]!;
  const sellerB = state.nodes[3]!;

  // Marketplace routes must be live + enabled on all three participants.
  for (const node of [sellerA, buyer, sellerB]) {
    const st = await getJson(node, '/api/marketplace/status');
    if (st.status !== 200 || st.json?.enabled !== true) {
      throw new Error(
        `node${node.num} /api/marketplace/status returned ${st.status} (${JSON.stringify(st.json)}) — ` +
          'marketplace routes unavailable or disabled. Rebuild (`pnpm build`), restart the devnet, and ensure ' +
          'node config has `"marketplace": { "enabled": true }` (or DKG_MARKETPLACE_ENABLED=1).',
      );
    }
  }

  expect(sellerA.identityId, 'node1 (seller A) must have an on-chain identity').toBeGreaterThan(0n);
  expect(sellerB.identityId, 'node3 (seller B) must have an on-chain identity').toBeGreaterThan(0n);
  return { state, marketplace, chronos, sellerA, sellerB, buyer, buyerAddr: buyer.opWallets[0]!.address };
}

/**
 * Epoch-boundary guard: every subscription tranche pins ONE epoch, and
 * fundSubscription only accepts current/current+1 — so within ~20 minutes of
 * the boundary, warp into a fresh epoch first instead of flaking mid-run.
 * With `emptyBucket`, also warp when the buyer already funded the current
 * epoch (an earlier run's gateway arc, a console or `seed --subscribe`
 * subscription): the drill pins exact bucket and pool totals. Returns the
 * epoch to fund.
 */
async function currentEpochWithHeadroom(h: DevnetHandles, { emptyBucket = false } = {}): Promise<bigint> {
  const untilNext: bigint = await h.chronos.timeUntilNextEpoch();
  const current: bigint = await h.chronos.getCurrentEpoch();
  const funded = emptyBucket ? BigInt((await h.marketplace.getBucket(h.buyerAddr, current)).funded) : 0n;
  if (untilNext < 1200n || funded > 0n) {
    await warpChain(h.state, Number(untilNext) + 30);
  }
  const epoch: bigint = await h.chronos.getCurrentEpoch();
  expect(epoch).toBeGreaterThan(0n);
  return epoch;
}

// ───────────────────────────── scenario ──────────────────────────────────
//
// The `it`s below are ONE sequential scenario (sequence.concurrent = false):
// each step builds on the previous step's marketplace state, exactly like the
// RFC's buyer/seller lifecycle. Receipt-ordering note: the drill DELIBERATELY
// holds both sellers' claims unsubmitted across phases A and B (steps 4–5) —
// mutually invisible unsubmitted exposure is the only way past the sellers'
// UNDERFUNDED headroom admission — and flushes both in step 6, where
// getSellerClaim still pins each seller's EXACT summed costs. (Session-key
// rotation can strand nothing: keys bind per buyer PERMANENTLY —
// boundSessionKeys — so every historically bound key keeps authorizing.)

describe('OT-RFC-27 marketplace protocol prototype (devnet e2e)', () => {
  beforeAll(async () => {
    const h = await connectMarketplaceDevnet();
    // (This suite already time-warps for settlement.)
    const epoch = await currentEpochWithHeadroom(h, { emptyBucket: true });

    // TOP UP the buyer's on-chain funding wallet (node2's primary operational
    // wallet — the adapter's primary signer is fundSubscription's msg.sender).
    // fundTrac OVERWRITES the ERC-20 balance slot, so read-modify-write:
    // setting it to a bare 10 TRAC would wipe the wallet's bootstrap balance
    // (~1M TRAC), which the node's other on-chain roles rely on.
    const buyerTracBefore: bigint = await h.state.token.balanceOf(h.buyerAddr);
    await fundTrac(h.state, h.buyerAddr, buyerTracBefore + ethers.parseEther('10'));

    ctx = {
      state: h.state,
      marketplace: h.marketplace,
      chronos: h.chronos,
      sellerA: h.sellerA,
      sellerB: h.sellerB,
      buyer: h.buyer,
      idA: h.sellerA.identityId,
      idB: h.sellerB.identityId,
      buyerAddr: h.buyerAddr,
      epoch,
      expectedClaimA: 0n,
      expectedClaimB: 0n,
    };
  });

  it('1. sellers publish offer KAs into the marketplace CG', async () => {
    // Each offering is its own Knowledge Asset published to Verifiable Memory
    // (an on-chain KA publish from the seller's operational wallet), and the
    // FIRST publish also anchors the `marketplace` CG on-chain
    // (ContextGraphs.createContextGraph) so buyer replicas can verify its
    // RFC-64 authority. This suite intentionally asserts no seller nonces/ETH,
    // and the only seller TRAC deltas it measures (step 9) are taken long
    // after these txs.
    const offersA = await postJson(ctx.sellerA, '/api/marketplace/seller/offerings', {
      offerings: [
        {
          offeringLocalId: 'devnet-llm',
          serviceType: 'inference',
          unit: 'token',
          askPerUnitWei: ASK_LLM_A.toString(),
        },
        {
          offeringLocalId: 'devnet-knowledge',
          serviceType: 'query',
          unit: 'query-unit',
          askPerUnitWei: ASK_KNOWLEDGE_A.toString(),
        },
      ],
      publish: true,
    });
    expect(offersA.status, `seller A offerings: ${JSON.stringify(offersA.json)}`).toBe(200);

    // Seller B: the SAME devnet-llm offering at a higher ask — the routing check.
    const offersB = await postJson(ctx.sellerB, '/api/marketplace/seller/offerings', {
      offerings: [
        {
          offeringLocalId: 'devnet-llm',
          serviceType: 'inference',
          unit: 'token',
          askPerUnitWei: ASK_LLM_B.toString(),
        },
      ],
      publish: true,
    });
    expect(offersB.status, `seller B offerings: ${JSON.stringify(offersB.json)}`).toBe(200);
  });

  it('2. buyer discovers all three offers via CG sync (polled)', async () => {
    const llmId = offeringIdFor('devnet-llm');
    const knowledgeId = offeringIdFor('devnet-knowledge');
    // Tolerant matcher: a half-synced offer row must make the POLL retry, not
    // crash the probe — so field coercion failures count as "not found yet".
    const sameId = (v: unknown, id: bigint): boolean => {
      try {
        return big(v, 'offer.sellerIdentityId') === id;
      } catch {
        return false;
      }
    };
    const find = (offers: any[], offeringId: string, sellerId: bigint) =>
      offers.find(
        (o) =>
          String(o?.offeringId).toLowerCase() === offeringId.toLowerCase() &&
          sameId(o?.sellerIdentityId, sellerId),
      );

    // Offers from two sellers reach the buyer eventually — poll. Discovery is
    // usually seconds: each offer KA is shared, then published on-chain. The
    // buyer must first bind the CG anchor the FIRST publish registers, and a
    // node that missed the shared copy waits for its chain reconcile of the
    // KA, so the window stays generous and each GET /api/marketplace/offers
    // poll also nudges the buyer's throttled refresh (VM reconcile; SWM
    // backfill while empty).
    const offers = await waitFor(
      'buyer sees all 3 marketplace offers (A: devnet-llm + devnet-knowledge, B: devnet-llm) via CG sync',
      360_000,
      3_000,
      async () => {
        const r = await getJson(ctx.buyer, '/api/marketplace/offers');
        if (r.status !== 200) return null;
        const list: any[] = Array.isArray(r.json) ? r.json : (r.json?.offers ?? []);
        return find(list, llmId, ctx.idA) &&
          find(list, knowledgeId, ctx.idA) &&
          find(list, llmId, ctx.idB)
          ? list
          : null;
      },
    );

    // The discovered asks must be the configured asks (they feed routing AND
    // the signed authorizations, so a mangled wei string would poison both).
    expect(big(find(offers, llmId, ctx.idA)?.askPerUnitWei, 'offer A llm ask')).toBe(ASK_LLM_A);
    expect(big(find(offers, knowledgeId, ctx.idA)?.askPerUnitWei, 'offer A knowledge ask')).toBe(
      ASK_KNOWLEDGE_A,
    );
    expect(big(find(offers, llmId, ctx.idB)?.askPerUnitWei, 'offer B llm ask')).toBe(ASK_LLM_B);
  });

  it('3. buyer subscribes on-chain: bucket funded, session key registered', async () => {
    const sub = await subscribe(
      SUB1_WEI,
      policyJson([
        {
          serviceType: 'inference',
          budgetWei: 15_000_000_000_000_000n, // 1.5e16 — local budget ≫ funding (see header)
          priceCapWeiPerUnit: 1_000_000_000_000n, // 1e12 admits BOTH asks (routing is price, not cap)
          maxUnitsPerCall: 4000n,
        },
        {
          serviceType: 'query',
          budgetWei: 4_000_000_000_000_000n, // 4e15
          priceCapWeiPerUnit: 20_000_000_000_000n, // 2e13 ≥ the 1.5e13 knowledge ask
          maxUnitsPerCall: 1000n,
        },
      ]),
    );
    expect(sub.status, `subscribe failed: ${JSON.stringify(sub.json)}`).toBe(200);
    expect(big(sub.json?.epoch, 'subscribe epoch')).toBe(ctx.epoch);

    // On-chain truth: the bucket holds the tranche and the session key is live.
    const bucket = await waitFor(
      `bucket(${ctx.buyerAddr}, ${ctx.epoch}) funded with the first tranche`,
      60_000,
      2_000,
      async () => {
        const b = await ctx.marketplace.getBucket(ctx.buyerAddr, ctx.epoch);
        return b.funded === SUB1_WEI ? b : null;
      },
    );
    expect(bucket.totalClaimed).toBe(0n);
    expect(bucket.finalized).toBe(false);

    const sessionKey: string = await ctx.marketplace.activeSessionKey(ctx.buyerAddr);
    expect(sessionKey, 'fundSubscription must register the session key').not.toBe(
      ethers.ZeroAddress,
    );
    expect(sessionKey.toLowerCase()).toBe(String(sub.json?.sessionKeyAddress).toLowerCase());
    // Session keys bind per buyer PERMANENTLY (boundSessionKeys): registering
    // must also bind, and step 6 asserts the binding survives a re-subscribe.
    expect(
      await ctx.marketplace.isSessionKeyBound(ctx.buyerAddr, sessionKey),
      'the registered session key must be bound to the buyer',
    ).toBe(true);
    ctx.firstSessionKey = sessionKey;

    // And the status route reflects the live subscription (step 3's assert).
    const st = await getJson(ctx.buyer, '/api/marketplace/status');
    expect(st.status).toBe(200);
    expect(st.json?.buyer?.subscribed, `status: ${JSON.stringify(st.json)}`).toBe(true);
    expect(big(st.json?.buyer?.epoch, 'status buyer.epoch')).toBe(ctx.epoch);
  });

  it('4. drill phase A: router picks the cheaper seller A; SPARQL serves from A; claims stay unsubmitted', async () => {
    // A warp in this process (the epoch guard) must reach the nodes' chain
    // clocks before the buyer signs expiries (no-op otherwise).
    await waitForNodeChainClocks();

    // Saturation preconditions — pure math, so a mis-sized prompt fails HERE
    // with a clear message instead of as an UNDERFUNDED/arithmetic surprise:
    // promptTokens ≤ maxUnits < 2·promptTokens makes the stub serve maxUnits
    // exactly (countTokens = ceil(utf8/4); ASCII prompt).
    const drillPromptTokens = BigInt(
      Math.ceil(new TextEncoder().encode(DRILL_PROMPT).length / 4),
    );
    for (const [grant, label] of [
      [INF_MAX_UNITS_A, 'A'],
      [INF_MAX_UNITS_B, 'B'],
    ] as const) {
      expect(drillPromptTokens, `drill prompt must fit seller ${label}'s grant`).toBeLessThanOrEqual(grant);
      expect(2n * drillPromptTokens, `drill prompt must saturate seller ${label}'s grant`).toBeGreaterThan(grant);
    }

    const meterBefore = await getJson(ctx.buyer, '/api/marketplace/meter');
    expect(meterBefore.status).toBe(200);

    // One chat-style call — with BOTH devnet-llm offers eligible under the
    // price cap, landing on A proves lowest-ask routing. TIGHT maxUnits: the
    // seller's UNDERFUNDED admission reserves maxUnits·ask = 2.5e14 against
    // the 5e14 tranche-1 funding. THE RACE WINDOW OPENS HERE: A's batcher
    // auto-submits this claim ~15–20s from now, so steps 4–5 stay lean.
    const r = await postJson(ctx.buyer, '/api/marketplace/invoke', {
      serviceType: 'inference',
      payload: { prompt: DRILL_PROMPT },
      maxUnits: INF_MAX_UNITS_A.toString(),
    });
    ctx.expectedClaimA += assertServedInvoke(
      r,
      'phase-A inference invoke',
      ctx.idA,
      ASK_LLM_A,
      INF_MAX_UNITS_A, // saturated
    );

    // One SPARQL call — only A offers `devnet-knowledge`, served against A's
    // local graph via the query executor. Worst case 16·1.5e13 = 2.4e14 fits
    // the 5e14 bucket on top of A's own 2.5e14 unsubmitted exposure. (Chat
    // offers carry `apiShape openai-chat/v1` and never take a generic
    // `{ prompt }` invoke — the router's symmetric api-shape rule.)
    const q = await postJson(ctx.buyer, '/api/marketplace/invoke', {
      serviceType: 'query',
      payload: { sparql: SPARQL_PROBE },
      maxUnits: QUERY_MAX_UNITS.toString(),
    });
    const queryCost = assertServedInvoke(q, 'query invoke', ctx.idA, ASK_KNOWLEDGE_A);
    // The static query cost schedule: admission 3 + delivery ceil(rows/100),
    // rows ∈ 0..5 → served ∈ [3, 4].
    const queryUnits = big(q.json?.servedUnits, 'query servedUnits');
    expect(queryUnits, 'query servedUnits = admission 3 + delivery 0|1').toBeGreaterThanOrEqual(3n);
    expect(queryUnits, 'query servedUnits = admission 3 + delivery 0|1').toBeLessThanOrEqual(4n);
    ctx.expectedClaimA += queryCost;

    // Meter movement: settled usage must be visible on the meter route.
    // NO FLUSH here — A's claims must stay unsubmitted (invisible to B) when
    // phase B is admitted, or the over-authorization drill is impossible.
    const meterAfter = await getJson(ctx.buyer, '/api/marketplace/meter');
    expect(meterAfter.status).toBe(200);
    expect(
      JSON.stringify(meterAfter.json),
      'buyer meter must move after served invokes',
    ).not.toBe(JSON.stringify(meterBefore.json));
  });

  it('5. drill phase B: deny-list re-subscribe routes to pricier seller B before anything flushes', async () => {
    // Same epoch, extra funds, NEW local policy: seller A is denied, so the
    // router must fall through to B's pricier devnet-llm. The subscribe POST
    // returns with the tx already mined, so the confirm poll resolves on its
    // first probe — the race window stays open.
    await subscribeAndConfirm(
      SUB2_WEI,
      policyJson(
        [
          {
            serviceType: 'inference',
            budgetWei: 15_000_000_000_000_000n,
            priceCapWeiPerUnit: 1_000_000_000_000n,
            maxUnitsPerCall: 4000n,
          },
        ],
        [ctx.idA], // sellerDeny
      ),
      SUB1_WEI + SUB2_WEI,
      'tranche 2',
    );

    // B's admission: funded 9e14, on-chain claimed 0 (A has NOT flushed), B's
    // own pending 0 → worst case 800·8e11 = 6.4e14 fits. If this returns 502
    // UNDERFUNDED, A's auto-flush won the race (a slow devnet run) — rerun.
    const r = await postJson(ctx.buyer, '/api/marketplace/invoke', {
      serviceType: 'inference',
      payload: { prompt: DRILL_PROMPT },
      maxUnits: INF_MAX_UNITS_B.toString(),
    });
    ctx.expectedClaimB += assertServedInvoke(
      r,
      'phase-B (deny-list) inference invoke',
      ctx.idB,
      ASK_LLM_B,
      INF_MAX_UNITS_B, // saturated
    );

    // Subscribing again must NOT invalidate anything key-side: bindings are
    // per buyer and permanent, so the step-3 key stays bound (and, since the
    // buyer persists one session key, stays the active one) — a rotation via
    // a later fundSubscription would keep the OLD key valid for settlement.
    expect(
      await ctx.marketplace.isSessionKeyBound(ctx.buyerAddr, ctx.firstSessionKey!),
      're-subscribing must keep the originally bound session key valid',
    ).toBe(true);
  });

  it('6. both sellers flush; combined on-chain claims over-claim the bucket', async () => {
    expect(ctx.expectedClaimA).toBeGreaterThan(0n);
    expect(ctx.expectedClaimB).toBeGreaterThan(0n);

    // A's claims may ALREADY be on-chain (its batcher's 15s delay trigger) —
    // the manual flush then just drains nothing; getSellerClaim still pins the
    // EXACT per-seller sums either way. The flush response's requeuedClaims /
    // failedClaims counters are deliberately not asserted here.
    await flushAndConfirmClaim(ctx.sellerA, ctx.idA, ctx.expectedClaimA, 'seller A');
    await flushAndConfirmClaim(ctx.sellerB, ctx.idB, ctx.expectedClaimB, 'seller B');

    // The over-authorization is already on-chain: combined claims exceed even
    // the FINAL funded total (tranche 3, another 2e13, lands in step 7).
    const bucket = await ctx.marketplace.getBucket(ctx.buyerAddr, ctx.epoch);
    expect(bucket.totalClaimed, 'combined claims must be exact').toBe(
      ctx.expectedClaimA + ctx.expectedClaimB,
    );
    expect(
      bucket.totalClaimed,
      'mutually invisible unsubmitted exposure must over-claim the final funding',
    ).toBeGreaterThan(FUNDED_TOTAL_WEI);
  });

  it('7. soft ceiling: a call crossing 95% of its bucket is refused with zero meter movement', async () => {
    // Tiny bucket (1e14) — ANY eligible offer's worst case (maxUnits·ask ≥
    // 1000·5e11 = 5e14) crosses 95% of it, so the router must refuse locally.
    await subscribeAndConfirm(
      SUB3_WEI,
      policyJson([
        {
          serviceType: 'inference',
          budgetWei: 100_000_000_000_000n, // 1e14
          priceCapWeiPerUnit: 1_000_000_000_000n,
          maxUnitsPerCall: 4000n,
        },
      ]),
      FUNDED_TOTAL_WEI,
      'tranche 3',
    );

    const meterBefore = await getJson(ctx.buyer, '/api/marketplace/meter');
    expect(meterBefore.status).toBe(200);

    const refused = await postJson(ctx.buyer, '/api/marketplace/invoke', {
      serviceType: 'inference',
      payload: { prompt: PROMPT },
      maxUnits: '1000',
    });
    const refusalText = JSON.stringify(refused.json);
    expect(
      refused.status,
      `a soft-ceiling-crossing call must be refused with 409, got ${refused.status}: ${refusalText}`,
    ).toBe(409);
    expect(refused.json?.code, `refusal code: ${refusalText}`).toBe('NO_ROUTE');
    // The router distinguishes empty discovery (reason 'no-offers',
    // rejections []) from offers all rejected by policy ('no-eligible-offer',
    // rejections populated). Here offers EXIST — both devnet-llm asks pass the
    // price cap — and every one is rejected by the soft ceiling, so the reason
    // must be 'no-eligible-offer'. ('no-offers' is not assertable from this
    // scenario without subscribing before the first publish, and re-runs on a
    // shared devnet leave offers in the CG — the unit lane covers it.)
    expect(refused.json?.reason, `refusal reason: ${refusalText}`).toBe('no-eligible-offer');
    const rejections: any[] = Array.isArray(refused.json?.rejections) ? refused.json.rejections : [];
    expect(rejections.length, `rejections must be populated: ${refusalText}`).toBeGreaterThan(0);
    expect(
      rejections.some((r) => /soft[-_\s]?ceiling/i.test(String(r?.reason))),
      `a rejections[] entry must name the soft ceiling: ${refusalText}`,
    ).toBe(true);

    // Zero movement: a refused call must not leak a reservation into the meter.
    const meterAfter = await getJson(ctx.buyer, '/api/marketplace/meter');
    expect(meterAfter.status).toBe(200);
    expect(meterAfter.json, 'refused call leaked meter state').toEqual(meterBefore.json);
  });

  it('8. finalize after the settlement deadline: pro-rata (floor) matches the bigint mirror', async () => {
    // Pre-finalize truth, read from chain (the mirror's ONLY inputs).
    const bucket = await ctx.marketplace.getBucket(ctx.buyerAddr, ctx.epoch);
    expect(bucket.funded, 'all three tranches must be in the bucket').toBe(FUNDED_TOTAL_WEI);
    expect(bucket.totalClaimed, 'every flushed receipt must be claimed on-chain').toBe(
      ctx.expectedClaimA + ctx.expectedClaimB,
    );
    expect(
      bucket.totalClaimed,
      'over-authorization drill precondition: combined A+B claims must exceed the funding',
    ).toBeGreaterThan(bucket.funded);

    const claimA = await ctx.marketplace.getSellerClaim(ctx.buyerAddr, ctx.epoch, ctx.idA);
    const claimB = await ctx.marketplace.getSellerClaim(ctx.buyerAddr, ctx.epoch, ctx.idB);
    expect(claimA.enrolled, 'seller A must be enrolled as a bucket claimant').toBe(true);
    expect(claimB.enrolled, 'seller B must be enrolled as a bucket claimant').toBe(true);

    // Warp strictly past settlementDeadline(epoch) = epochEnd + grace.
    const deadline: bigint = await ctx.marketplace.settlementDeadline(ctx.epoch);
    const block = await ctx.state.provider.getBlock('latest');
    const warp = deadline - BigInt(block!.timestamp) + 15n;
    if (warp > 0n) await warpChain(ctx.state, Number(warp));

    // The settle route takes { action, buyer?, epoch? } only — pagination is
    // internal: the agent calls the adapter's marketplaceFinalizeBucket without
    // a bound, which hits the contract's finalizeBucket(buyer, epoch,
    // maxSellers) with maxSellers = 0 = all remaining claimants in one page
    // (paging only matters past one block's gas worth of claimants).
    const fin = await postJson(ctx.buyer, '/api/marketplace/settle', {
      action: 'finalize',
      epoch: Number(ctx.epoch),
    });
    expect(fin.status, `finalize failed: ${JSON.stringify(fin.json)}`).toBe(200);
    await waitFor(`bucket(${ctx.buyerAddr}, ${ctx.epoch}) finalized`, 60_000, 2_000, async () => {
      const b = await ctx.marketplace.getBucket(ctx.buyerAddr, ctx.epoch);
      return b.finalized ? b : null;
    });

    // Independent pro-rata mirror — pure bigint floor division, no priority:
    // finalized_i = claimed_i · funded / totalClaimed (residue stays pooled),
    // and Q_i scales with the finalized share: qiScore_i = qiRaw_i·fin_i/claimed_i.
    // Like the contract loop and the domain proRataFinalize, the mirror OMITS
    // claimed==0 sellers — they contribute nothing and must never reach the
    // divisions. No zero-claim seller can occur in this suite (zero-value
    // claims revert ZeroClaimValue), but the mirror stays byte-exact with the
    // reference semantics anyway.
    const mirror = (c: { claimed: bigint; qiRaw: bigint }): { fin: bigint; qi: bigint } => {
      if (c.claimed === 0n) return { fin: 0n, qi: 0n }; // omitted by the finalize loop
      const fin = (c.claimed * bucket.funded) / bucket.totalClaimed;
      return { fin, qi: (c.qiRaw * fin) / c.claimed };
    };
    const mirrorA = mirror(claimA);
    const mirrorB = mirror(claimB);
    const acctA = await ctx.marketplace.getNodeEpochAccounting(ctx.epoch, ctx.idA);
    const acctB = await ctx.marketplace.getNodeEpochAccounting(ctx.epoch, ctx.idB);
    expect(acctA.finalizedValue, 'seller A pro-rata (floor) mismatch').toBe(mirrorA.fin);
    expect(acctB.finalizedValue, 'seller B pro-rata (floor) mismatch').toBe(mirrorB.fin);
    expect(acctA.totalFinalizedValue).toBe(mirrorA.fin + mirrorB.fin);
    expect(
      acctA.totalFinalizedValue,
      'pro-rata may never finalize more than the funding',
    ).toBeLessThanOrEqual(bucket.funded);
    expect(acctA.qiScore, 'seller A qiScore scaling').toBe(mirrorA.qi);
    expect(acctB.qiScore, 'seller B qiScore scaling').toBe(mirrorB.qi);
  });

  it('9. epoch rewards: TRAC deltas equal min(pool·QIF, cap·R_i) within rounding (QIF recomputed from chain)', async () => {
    // getParams grew a 4th member: the wash-trading reward cap. Destructure
    // all four and pin the deploy defaults the math below depends on.
    const params = await ctx.marketplace.getParams();
    const lambda: bigint = params.lambdaQif18;
    const rewardCapMultiple: bigint = params.rewardCapMultiple;
    expect(params.settlementGraceSeconds).toBeGreaterThan(0n);
    expect(params.softCeilingBps).toBe(9_500n);
    expect(
      rewardCapMultiple,
      'getParams().rewardCapMultiple must be the deploy default (10; 0 would mean uncapped)',
    ).toBe(10n);

    let totalPaid = 0n;
    for (const [seller, identityId, label] of [
      [ctx.sellerA, ctx.idA, 'seller A'],
      [ctx.sellerB, ctx.idB, 'seller B'],
    ] as const) {
      const acct = await ctx.marketplace.getNodeEpochAccounting(ctx.epoch, identityId);
      expect(acct.claimed, `${label} must not have claimed yet`).toBe(false);
      expect(acct.totalFinalizedValue).toBeGreaterThan(0n);

      // QIF recomputed in the test from on-chain R_i, Q_i, ΣR, ΣQ and λ —
      // then cross-checked against the contract's own view.
      const myQif = qif18Mirror(
        lambda,
        acct.finalizedValue,
        acct.totalFinalizedValue,
        acct.qiScore,
        acct.totalQiScore,
      );
      const chainQif: bigint = await ctx.marketplace.getQif18(ctx.epoch, identityId);
      expect(
        absDiff(myQif, chainQif),
        `${label}: QIF mirror ${myQif} vs contract ${chainQif}`,
      ).toBeLessThanOrEqual(2n);

      const balBefore = await nodeOpTrac(seller);
      const res = await postJson(seller, '/api/marketplace/settle', {
        action: 'claim',
        epoch: Number(ctx.epoch),
      });
      expect(res.status, `${label} claim failed: ${JSON.stringify(res.json)}`).toBe(200);
      await waitFor(`${label} epoch reward marked claimed on-chain`, 60_000, 2_000, async () => {
        const after = await ctx.marketplace.getNodeEpochAccounting(ctx.epoch, identityId);
        return after.claimed ? true : null;
      });

      const delta = (await nodeOpTrac(seller)) - balBefore;
      // Expected payout = min(pool·QIF/1e18, rewardCapMultiple·R_i): the cap
      // bounds a staked node's harvest of an under-utilized pool to a multiple
      // of its own finalized receipt value. At this suite's stakes/claims the
      // cap is NOT binding (QIF ≤ 1e18 ⇒ pool·QIF ≤ pool ≈ ΣR ≤ 10·R_i), so
      // min() must still select the QIF payout — asserting through min keeps
      // the mirror honest if the deploy default ever changes.
      let expectedReward = (acct.pool * myQif) / SCALE18;
      if (rewardCapMultiple !== 0n) {
        const rewardCap = rewardCapMultiple * acct.finalizedValue;
        if (expectedReward > rewardCap) expectedReward = rewardCap;
      }
      expect(delta, `${label} reward must move TRAC to the operational wallet`).toBeGreaterThan(0n);
      expect(
        absDiff(delta, expectedReward),
        `${label}: TRAC delta ${delta} vs min(pool·QIF, cap·R_i) ${expectedReward} `
          + `(pool=${acct.pool}, qif18=${myQif}, cap=${rewardCapMultiple}·${acct.finalizedValue})`,
      ).toBeLessThanOrEqual(REWARD_TOLERANCE_WEI);
      if (res.json?.rewardWei !== undefined) {
        expect(big(res.json.rewardWei, `${label} rewardWei`)).toBe(delta);
      }
      totalPaid += delta;
    }

    // Per-epoch distribution tracking: the pool is exactly the summed
    // subscription tranches, `distributed` is exactly what the two claims
    // paid out, and `undistributed` is the identity `pool − distributed` —
    // which here is floor residue only (the reward cap is not binding), so it
    // stays within the rounding tolerance.
    const dist = await ctx.marketplace.getEpochRewardDistribution(ctx.epoch);
    expect(dist.pool, 'epoch pool must equal the summed subscription tranches').toBe(
      FUNDED_TOTAL_WEI,
    );
    expect(dist.distributed, 'distributed must equal the summed paid rewards').toBe(totalPaid);
    expect(dist.undistributed, 'undistributed must be pool − distributed').toBe(
      dist.pool - dist.distributed,
    );
    expect(
      dist.undistributed,
      'QIF must distribute the pool up to floor residue',
    ).toBeLessThanOrEqual(REWARD_TOLERANCE_WEI);
  });
});

// ═════════════════════════════ buyer gateway arc ═════════════════════════════
//
// Spec agent-docs/plans/2026-10-27-rfc27-sellers-gateway.md §13.3 (G1–G15).
// Golden numbers are copied from the spec (§3): they are NOT recomputed here.

const STUB_WORDS_DIGEST = 'sha256:77c4f56809020ef019a66d94aeb5e2f45cd300521472a4418c7ab4e502215c95';
const CHAT_TEMPLATE_ID = 'openai-chat-count/v1';
const CHAT_TEMPLATE_DIGEST = 'sha256:53662e1fb5c8ef588e2d3e3b8fc9025e25a7a4caf0650842a64323b29c71cee8';
const QUERY_SCHEDULE_ID = 'dkg-mkt-query-cost/1';
const QUERY_SCHEDULE_DIGEST = 'sha256:70beea38241810353b4934b29627f4ef0699d6b0159d33ccf0357b070f7b0642';

// GV-2 / GV-3: stub-words prompt 17, reply 5 (3 with max_tokens 3).
const GV2_MESSAGES = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello marketplace world' },
];
const GV2_REPLY = 'STUB:WORLD MARKETPLACE HELLO :: ok';
const GV3_REPLY = 'STUB:WORLD MARKETPLACE HELLO';

// Chat asks equal the devnet-llm asks (spec §13.2): A 0.5 µTRAC, B 0.8 µTRAC.
const ASK_CHAT_A_WEI = 500_000_000_000n;
const ASK_CHAT_B_WEI = 800_000_000_000n;
/** marketplace.buyer.gateway.defaultMaxTokens (default 256): GV-2 authorizes 17 + 256 = 273 units. */
const GATEWAY_DEFAULT_MAX_TOKENS = 256;
const GW_SUB_WEI = 2_000_000_000_000_000n; // 2e15
const GW_KEY_BUDGET_WEI = 1_000_000_000_000_000n; // 1e15
/** 1e13 < the GV-2 worst case 273 · 5e11 = 1.365e14 → refused by the key, before any reservation. */
const GW_SMALL_KEY_BUDGET_WEI = 10_000_000_000_000n;

interface GatewayCtx extends DevnetHandles {
  idA: bigint;
  idB: bigint;
  epoch: bigint;
  stub: {
    state: { calls: number; lastAuthorization: string | null; lastBody: any };
    close(): Promise<void>;
  };
  stubPort: number;
  /** Set once G1 re-pointed the sellers' devnet-chat at the in-process stub. */
  repointed: boolean;
  key: string;
  keyId: string;
  /** Extra keys minted by G11/G12, revoked in G14. */
  helperKeyIds: string[];
  claimABefore: bigint;
  claimBBefore: bigint;
  /** Σ cost_wei of every gateway call served (all by seller A). */
  costsA: bigint;
  chatContent: string;
  chatCallId: string;
}

let gw: GatewayCtx;

/** The offering sets G1 serves: the seeder's (console/devnet-offerings.mjs), chat → `port`. */
function gatewayOfferingSets(port: number): Array<[DevnetNode, Array<Record<string, unknown>>, string]> {
  return [
    [
      gw.sellerA,
      [
        { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: ASK_LLM_A.toString() },
        { offeringLocalId: 'devnet-knowledge', serviceType: 'query', unit: 'query-unit', askPerUnitWei: ASK_KNOWLEDGE_A.toString() },
        chatOffering({ askPerUnitWei: ASK_CHAT_A, secretEnvFile: stubSecretFile(1), port }),
      ],
      'seller A',
    ],
    [
      gw.sellerB,
      [
        { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: ASK_LLM_B.toString() },
        chatOffering({ askPerUnitWei: ASK_CHAT_B, secretEnvFile: stubSecretFile(3), port }),
      ],
      'seller B',
    ],
  ];
}

/** Mint a gateway key on the buyer (node-admin route). */
async function mintGatewayKey(body: Record<string, unknown>, label: string): Promise<{ key: string; keyId: string; record: any }> {
  const r = await adminRequest(gw.buyer, '/api/marketplace/keys', { method: 'POST', body });
  expect(r.status, `${label} mint: ${r.text.slice(0, 400)}`).toBe(201);
  const m = GATEWAY_KEY_PATTERN.exec(String(r.json?.key));
  expect(m, `${label}: the plaintext key must match dkg_gw_<8hex>_<43 b64url>`).not.toBeNull();
  expect(r.json.record?.keyId).toBe(`gw_${m![1]}`);
  return { key: r.json.key, keyId: r.json.record.keyId, record: r.json.record };
}

async function listGatewayKeys(): Promise<{ text: string; keys: any[] }> {
  const r = await adminRequest(gw.buyer, '/api/marketplace/keys');
  expect(r.status, `GET /api/marketplace/keys: ${r.text.slice(0, 300)}`).toBe(200);
  return { text: r.text, keys: Array.isArray(r.json?.keys) ? r.json.keys : [] };
}

/** Wall-clock ms of the arc's last gateway request (see `gwCall`). */
let lastGatewayCallMs = 0;

/**
 * A gateway request under the buyer's base path. Keys are minted with
 * `rps: 5` (spec G4) and the gateway counts them in a sliding 1 s window, so
 * consecutive calls are spaced ≥ 250 ms: a 429 must never pre-empt the
 * answer a step asserts.
 */
async function gwCall(subPath: string, key: string | null, opts: Parameters<typeof gatewayRequest>[3] = {}): Promise<HttpReply> {
  const wait = lastGatewayCallMs + 250 - Date.now();
  if (wait > 0) await sleep(wait);
  lastGatewayCallMs = Date.now();
  return gatewayRequest(gw.buyer, subPath, key, opts);
}

function chatRequest(key: string, body: Record<string, unknown>): Promise<HttpReply> {
  return gwCall('/chat/completions', key, { method: 'POST', body: { model: STUB_MODEL_ID, messages: GV2_MESSAGES, ...body } });
}

/**
 * Assert a gateway call's `dkg` block (spec §9.3): the serving seller, the
 * offering, cost = served·ask, and the seller's EIP-191 receipt signature
 * over the independently recomputed RCPT_DOMAIN digest. Returns cost_wei.
 */
function assertGatewayCall(
  dkg: any,
  label: string,
  expected: { sellerId: bigint; offering: string; askPerUnitWei: bigint; servedUnits: bigint },
): bigint {
  const dump = `${label}: dkg=${JSON.stringify(dkg)}`;
  expect(String(dkg?.call_id), dump).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(String(dkg?.offering_id).toLowerCase(), dump).toBe(offeringIdFor(expected.offering).toLowerCase());
  expect(asBigInt(dkg?.seller?.identity_id, `${label} seller`), `${label}: routed to the wrong seller`).toBe(expected.sellerId);
  expect(String(dkg?.seller?.peer_id), dump).toMatch(/^12D3Koo/);
  const servedUnits = asBigInt(dkg?.served_units, `${label} served_units`);
  expect(servedUnits, dump).toBe(expected.servedUnits);
  expect(asBigInt(dkg?.ask_per_unit_wei, `${label} ask`), dump).toBe(expected.askPerUnitWei);
  const costWei = asBigInt(dkg?.cost_wei, `${label} cost_wei`);
  expect(costWei, `${label}: cost_wei must equal served_units · ask`).toBe(servedUnits * expected.askPerUnitWei);
  const rc = dkg?.receipt ?? {};
  expect(String(rc.auth_digest), dump).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(String(rc.result_commitment), dump).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const digest = receiptDigest(rc.auth_digest, servedUnits, costWei, rc.result_commitment);
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), rc.seller_sig);
  expect(
    recovered.toLowerCase(),
    `${label}: seller_sig must recover to the seller's receipt wallet over the shared RCPT_DOMAIN digest`,
  ).toBe(String(dkg?.seller?.address).toLowerCase());
  return costWei;
}

/** GV-2 / GV-3 pinned chat metering block (spec §9.3), as strings. */
function expectChatMetering(dkg: any, label: string, units: { prompt: number; tool: number; completion: number }, providerUsage: { prompt_tokens: number; completion_tokens: number }): void {
  expect(dkg?.metering, `${label}: metering`).toMatchObject({
    basis: 'pinned',
    tokenizer_kind: 'stub-words-v1',
    tokenizer_digest: STUB_WORDS_DIGEST,
    chat_template: CHAT_TEMPLATE_ID,
    prompt_units: String(units.prompt),
    tool_units: String(units.tool),
    completion_units: String(units.completion),
    provider_usage: providerUsage,
  });
  expect(typeof dkg?.metering?.truncated, label).toBe('boolean');
  const served = units.prompt + units.tool + units.completion;
  expect(dkg?.recount, `${label}: the buyer's stub-words recount must agree with the receipt`).toEqual({
    verdict: 'match',
    reason: null,
    recount_units: String(served),
  });
}

describe('OT-RFC-27 marketplace buyer gateway (devnet e2e)', () => {
  beforeAll(async () => {
    const h = await connectMarketplaceDevnet();
    const st = await getJson(h.buyer, '/api/marketplace/status');
    if (st.json?.gateway?.enabled !== true) {
      throw new Error(
        `node2 reports gateway ${JSON.stringify(st.json?.gateway)} — the buyer gateway must be enabled ` +
          '(default with the marketplace; check marketplace.buyer.gateway.enabled / DKG_MARKETPLACE_GATEWAY_ENABLED) ' +
          'and the daemon built from this branch.',
      );
    }
    // The upstream every devnet-chat call reaches: an IN-PROCESS llm-stub on
    // an ephemeral loopback port, pinned to the key the sellers read from
    // their secret files — so `state.lastAuthorization` proves that wiring.
    const stub = createLlmStub({ apiKey: LLM_STUB_API_KEY, log: () => {} });
    const stubPort: number = await stub.listen(0, '127.0.0.1');
    // The seller-local secret files (0600 in a 0700 dir); config names only the path.
    for (const node of [h.sellerA, h.sellerB]) {
      const file = writeStubSecret(node.num);
      expect(file, `node${node.num}'s secret file must live in its devnet home`).toBe(stubSecretFile(node.num));
      expect(file.startsWith(h.state.nodes[node.num]!.home), `${file} outside ${node.home}`).toBe(true);
      expect(statSync(file).mode & 0o777, `${file} must be 0600`).toBe(0o600);
    }
    gw = {
      ...h,
      idA: h.sellerA.identityId,
      idB: h.sellerB.identityId,
      epoch: 0n,
      stub,
      stubPort,
      repointed: false,
      key: '',
      keyId: '',
      helperKeyIds: [],
      claimABefore: 0n,
      claimBBefore: 0n,
      costsA: 0n,
      chatContent: '',
      chatCallId: '',
    };
  });

  afterAll(async () => {
    if (!gw) return;
    // Hand the sellers back to the STANDALONE stub the seeder points at
    // (same published content, so no transaction), keeping a console
    // session usable after this suite closes its in-process stub.
    if (gw.repointed) {
      for (const [node, offerings, label] of gatewayOfferingSets(llmStubPort())) {
        try {
          const r = await adminRequest(node, '/api/marketplace/seller/offerings', { method: 'POST', body: { offerings, publish: false } });
          if (r.status !== 200) console.warn(`[gateway e2e] could not re-point ${label}'s devnet-chat at :${llmStubPort()}: ${r.status} ${r.text.slice(0, 200)}`);
        } catch (err) {
          console.warn(`[gateway e2e] could not re-point ${label}'s devnet-chat: ${String(err)}`);
        }
      }
    }
    await gw.stub.close();
  });

  it('G1. sellers serve devnet-chat: an openai-compatible connector to the llm-stub, pinned to stub-words-v1', async () => {
    // The shared offering module must carry the spec's asks (§13.2).
    expect(BigInt(ASK_CHAT_A)).toBe(ASK_CHAT_A_WEI);
    expect(BigInt(ASK_CHAT_B)).toBe(ASK_CHAT_B_WEI);
    expect([BigInt(SEED_ASK_LLM_A), BigInt(SEED_ASK_KNOWLEDGE_A), BigInt(SEED_ASK_LLM_B)]).toEqual([ASK_LLM_A, ASK_KNOWLEDGE_A, ASK_LLM_B]);

    for (const [node, offerings, label] of gatewayOfferingSets(gw.stubPort)) {
      const r = await postJson(node, '/api/marketplace/seller/offerings', { offerings, publish: true });
      expect(r.status, `${label} offerings: ${JSON.stringify(r.json)}`).toBe(200);
      expect(r.json?.offerings, label).toBe(offerings.length);
      // An offering whose published content is unchanged is left alone (no
      // transaction): devnet-chat is `published` on its first publish and
      // `unchanged` once seeded (the stub port is seller-local, never
      // published); devnet-knowledge republishes once for its schedule pin.
      const assets: any[] = Array.isArray(r.json?.assets) ? r.json.assets : [];
      expect(assets.map((a) => a.offeringLocalId).sort(), `${label} assets`).toEqual(
        offerings.map((o) => String(o.offeringLocalId)).sort(),
      );
      for (const a of assets) {
        expect(['published', 'unchanged'], `${label} ${a.offeringLocalId}: ${JSON.stringify(a)}`).toContain(a.outcome);
      }
    }
    gw.repointed = true;

    // Connector status (node-admin): mounted, upstream ORIGIN only, the
    // secret reported as a boolean, the stub-words pin; the live probe
    // (GET <base>/models with the secret-file bearer) proves the wiring.
    for (const [node, label] of [[gw.sellerA, 'seller A'], [gw.sellerB, 'seller B']] as const) {
      const c = await adminRequest(node, '/api/marketplace/seller/connectors?probe=1');
      expect(c.status, `${label} connectors: ${c.text.slice(0, 300)}`).toBe(200);
      const chat = (c.json?.connectors ?? []).find((x: any) => x.offeringLocalId === 'devnet-chat');
      expect(chat, `${label}: devnet-chat connector status: ${c.text.slice(0, 400)}`).toBeTruthy();
      expect(chat).toMatchObject({
        modelId: STUB_MODEL_ID,
        kind: 'openai-compatible',
        state: 'mounted',
        upstreamOrigin: `http://127.0.0.1:${gw.stubPort}`,
        secretConfigured: true,
        metering: { basis: 'pinned', tokenizerKind: 'stub-words-v1', tokenizerDigest: STUB_WORDS_DIGEST },
      });
      expect(chat.health?.ok, `${label}: health probe ${JSON.stringify(chat.health)}`).toBe(true);
      expect(c.text, `${label}: status must not carry the secret`).not.toContain(LLM_STUB_API_KEY);
      expect(c.text, `${label}: status must not carry file paths`).not.toContain('.secrets');
    }
    expect(gw.stub.state.lastAuthorization, 'the health probe must send the secret-file key').toBe(`Bearer ${LLM_STUB_API_KEY}`);
  });

  it('G2. buyer discovers both devnet-chat offers with the OpenAI-chat shape and the stub-words pin', async () => {
    const chatId = offeringIdFor('devnet-chat');
    const knowledgeId = offeringIdFor('devnet-knowledge');
    const find = (offers: any[], offeringId: string, sellerId: bigint) =>
      offers.find((o) => {
        try {
          return String(o?.offeringId).toLowerCase() === offeringId.toLowerCase() && BigInt(o?.sellerIdentityId) === sellerId;
        } catch {
          return false;
        }
      });
    const pinned = (o: any): boolean =>
      o?.modelId === STUB_MODEL_ID &&
      o?.apiShape === 'openai-chat/v1' &&
      o?.metering?.basis === 'pinned' &&
      o?.metering?.tokenizer?.kind === 'stub-words-v1' &&
      o?.metering?.tokenizer?.digest === STUB_WORDS_DIGEST;
    const seen = await waitFor(
      'buyer sees devnet-chat from A and B (pinned, openai-chat/v1) and A devnet-knowledge with its schedule pin',
      360_000,
      3_000,
      async () => {
        const r = await getJson(gw.buyer, '/api/marketplace/offers');
        if (r.status !== 200) return null;
        const list: any[] = r.json?.offers ?? [];
        const chatA = find(list, chatId, gw.idA);
        const chatB = find(list, chatId, gw.idB);
        const knowledge = find(list, knowledgeId, gw.idA);
        return pinned(chatA) && pinned(chatB) && knowledge?.queryCost ? { list, chatA, chatB, knowledge } : null;
      },
    );
    expect(seen.list.filter((o: any) => o.modelId === STUB_MODEL_ID).length, 'exactly two stub-chat offers').toBe(2);
    for (const [o, ask, label] of [[seen.chatA, ASK_CHAT_A_WEI, 'A'], [seen.chatB, ASK_CHAT_B_WEI, 'B']] as const) {
      expect(big(o.askPerUnitWei, `${label} chat ask`)).toBe(ask);
      expect(o.serviceType).toBe('inference');
      expect(o.unit).toBe('token');
      expect(o.toolTransport).toBe('native');
      expect(o.metering.chatTemplate).toEqual({ id: CHAT_TEMPLATE_ID, digest: CHAT_TEMPLATE_DIGEST });
      expect(o.model).toMatchObject({ provenanceClass: 'upstream-claimed', upstreamModel: STUB_MODEL_ID, displayName: 'Stub Chat' });
      expect(big(o.model.contextLength, `${label} contextLength`)).toBe(32_768n);
      expect(o.access ?? 'open', `${label}: no allowedBuyers → open access`).toBe('open');
    }
    expect(seen.knowledge.queryCost).toEqual({ schedule: QUERY_SCHEDULE_ID, digest: QUERY_SCHEDULE_DIGEST });
    // Offer KAs never carry endpoints, file paths or secrets (spec §5.4).
    const published = JSON.stringify(seen.list);
    for (const leak of [LLM_STUB_API_KEY, '.secrets', 'llm-stub.env', `127.0.0.1:${gw.stubPort}`]) {
      expect(published, `discovered offers must not carry ${leak}`).not.toContain(leak);
    }
  });

  it('G3. buyer subscribes for the current epoch with a stub-chat inference bucket and a query bucket', async () => {
    gw.epoch = await currentEpochWithHeadroom(gw);
    const before = await gw.marketplace.getBucket(gw.buyerAddr, gw.epoch);
    const sub = await adminRequest(gw.buyer, '/api/marketplace/subscribe', {
      method: 'POST',
      body: {
        amountWei: GW_SUB_WEI.toString(),
        epoch: Number(gw.epoch),
        policy: {
          totalBudgetWei: GW_SUB_WEI.toString(),
          buckets: [
            {
              match: { serviceType: 'inference', modelId: STUB_MODEL_ID },
              budgetWei: '1000000000000000', // 1e15
              priceCapWeiPerUnit: '1000000000000', // 1e12 admits both chat asks
              maxUnitsPerCall: '4000',
            },
            {
              match: { serviceType: 'query' },
              budgetWei: '500000000000000', // 5e14
              priceCapWeiPerUnit: '20000000000000', // 2e13 ≥ the 1.5e13 knowledge ask
              maxUnitsPerCall: '200',
            },
          ],
        },
      },
      timeoutMs: 120_000,
    });
    expect(sub.status, `subscribe failed: ${sub.text.slice(0, 400)}`).toBe(200);
    expect(big(sub.json?.epoch, 'subscribe epoch')).toBe(gw.epoch);
    const funded = BigInt(before.funded) + GW_SUB_WEI;
    await waitFor(`bucket(${gw.buyerAddr}, ${gw.epoch}).funded == ${funded}`, 60_000, 2_000, async () => {
      const b = await gw.marketplace.getBucket(gw.buyerAddr, gw.epoch);
      return b.funded === funded ? b : null;
    });
    const st = await getJson(gw.buyer, '/api/marketplace/status');
    expect(st.json?.buyer?.subscribed, JSON.stringify(st.json)).toBe(true);
    expect(big(st.json?.buyer?.epoch, 'status buyer.epoch')).toBe(gw.epoch);

    // G15's baseline, taken BEFORE any gateway call: drain anything pending
    // first (a re-run in the same epoch), then read both sellers' claims.
    for (const seller of [gw.sellerA, gw.sellerB]) {
      const flush = await adminRequest(seller, '/api/marketplace/settle', { method: 'POST', body: { action: 'flush-receipts' } });
      expect(flush.status, `node${seller.num} flush: ${flush.text.slice(0, 300)}`).toBe(200);
      await waitFor(`node${seller.num} has no pending receipts`, 60_000, 2_000, async () => {
        const s = await getJson(seller, '/api/marketplace/status');
        return s.json?.seller?.pendingReceipts === 0 ? true : null;
      });
    }
    gw.claimABefore = BigInt((await gw.marketplace.getSellerClaim(gw.buyerAddr, gw.epoch, gw.idA)).claimed);
    gw.claimBBefore = BigInt((await gw.marketplace.getSellerClaim(gw.buyerAddr, gw.epoch, gw.idB)).claimed);
  });

  it('G4. node admin mints a scoped gateway key: plaintext once, hashed at rest', async () => {
    const minted = await mintGatewayKey(
      { label: 'e2e', budgetWei: GW_KEY_BUDGET_WEI.toString(), modelAllowlist: [STUB_MODEL_ID], allowQuery: true, rps: 5 },
      'G4',
    );
    const secretPart = GATEWAY_KEY_PATTERN.exec(minted.key)![2]!;
    expect(minted.record).toMatchObject({
      keyId: minted.keyId,
      scopes: {
        label: 'e2e',
        budgetWei: GW_KEY_BUDGET_WEI.toString(),
        expiresAt: null,
        modelAllowlist: [STUB_MODEL_ID],
        allowQuery: true,
        rps: 5,
      },
      revokedAt: null,
    });
    expect(asBigInt(minted.record.usage?.spentWei, 'usage.spentWei')).toBe(0n);
    expect(minted.record.keyHash, 'the record must never carry the hash').toBeUndefined();
    expect(JSON.stringify(minted.record)).not.toContain(secretPart);

    const list = await listGatewayKeys();
    expect(list.keys.some((k) => k.keyId === minted.keyId), 'GET /api/marketplace/keys lists the new key').toBe(true);
    expect(list.text, 'the key list must not carry the plaintext').not.toContain(secretPart);
    expect(list.text, 'the key list must not carry hashes').not.toContain('keyHash');

    // Hashed at rest: the store file is 0600 and holds no plaintext.
    const keyFile = join(gw.buyer.home, 'marketplace', 'gateway-keys.json');
    expect(statSync(keyFile).mode & 0o777, `${keyFile} must be 0600`).toBe(0o600);
    const stored = readFileSync(keyFile, 'utf8');
    expect(stored).toContain(minted.keyId);
    expect(stored, 'the key store must not hold the plaintext').not.toContain(secretPart);
    gw.key = minted.key;
    gw.keyId = minted.keyId;
  });

  it('G5. /models lists stub-chat for the key; no key and the node token are 401', async () => {
    const r = await gwCall('/models', gw.key);
    expect(r.status, r.text.slice(0, 400)).toBe(200);
    expect(r.json?.object).toBe('list');
    // The key's allowlist is ['stub-chat'], so that is all it may see.
    expect((r.json?.data ?? []).map((m: any) => m.id)).toEqual([STUB_MODEL_ID]);
    const model = r.json.data[0];
    expect(model).toMatchObject({ id: STUB_MODEL_ID, object: 'model', created: 0, owned_by: 'dkg-marketplace', context_length: 32_768 });
    expect(model.dkg).toMatchObject({
      offers: 2,
      min_ask_per_unit_wei: ASK_CHAT_A_WEI.toString(),
      metering_bases: ['pinned'],
      tokenizer_kinds: ['stub-words-v1'],
      provenance_classes: ['upstream-claimed'],
      tool_transports: ['native'],
      routable: true,
    });
    expect([...model.dkg.sellers].map(String).sort()).toEqual([gw.idA.toString(), gw.idB.toString()].sort());

    expectGatewayUnauthorized(await gwCall('/models', null), 'models without a key', 'invalid_api_key');
    // S5: node tokens never spend through the gateway.
    expectGatewayUnauthorized(
      await httpRequest(gw.buyer, '/api/marketplace/gateway/v1/models', { authorization: `Bearer ${gw.buyer.authToken}` }),
      'models with the node-admin token',
      'invalid_api_key',
    );
  });

  it('G6. chat (JSON): GV-2 → usage 17/5/22 metered by stub-words, recount match, signed receipt, key charged', async () => {
    // A warp in this process (the drill's settlement step, or G3's epoch
    // guard) must reach the nodes' chain clocks before the buyer signs.
    await waitForNodeChainClocks();
    const callsBefore = gw.stub.state.calls;
    const r = await chatRequest(gw.key, {});
    expect(r.status, `G6: ${r.text.slice(0, 600)}`).toBe(200);
    const j = r.json;
    expect(j).toMatchObject({ object: 'chat.completion', model: STUB_MODEL_ID, system_fingerprint: null });
    expect(j.id).toBe(`chatcmpl-${String(j.dkg?.call_id).slice(2)}`);
    expect(Number.isSafeInteger(j.created)).toBe(true);
    expect(j.choices).toEqual([
      { index: 0, message: { role: 'assistant', content: GV2_REPLY }, finish_reason: 'stop', logprobs: null },
    ]);
    expect(j.usage).toEqual({ prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
    const cost = assertGatewayCall(j.dkg, 'G6', { sellerId: gw.idA, offering: 'devnet-chat', askPerUnitWei: ASK_CHAT_A_WEI, servedUnits: 22n });
    expect(cost).toBe(22n * ASK_CHAT_A_WEI);
    expectChatMetering(j.dkg, 'G6', { prompt: 17, tool: 0, completion: 5 }, { prompt_tokens: 17, completion_tokens: 5 });
    expect(j.dkg.metering.truncated).toBe(false);

    // The upstream saw the seller's secret-file key and exactly the GV-2
    // request, capped at the gateway default (authorized 17 + 256 = 273).
    expect(gw.stub.state.calls).toBe(callsBefore + 1);
    expect(gw.stub.state.lastAuthorization).toBe(`Bearer ${LLM_STUB_API_KEY}`);
    expect(gw.stub.state.lastBody).toMatchObject({ model: STUB_MODEL_ID, messages: GV2_MESSAGES, max_tokens: GATEWAY_DEFAULT_MAX_TOKENS, stream: false });

    // Key accounting: the call settled against the key at the receipt value.
    expect(j.dkg.key.key_id).toBe(gw.keyId);
    expect(asBigInt(j.dkg.key.spent_wei, 'spent_wei')).toBe(cost);
    expect(asBigInt(j.dkg.key.remaining_wei, 'remaining_wei')).toBe(GW_KEY_BUDGET_WEI - cost);
    gw.costsA += cost;
    gw.chatContent = j.choices[0].message.content;
    gw.chatCallId = j.dkg.call_id;
  });

  it('G7. chat (stream): buffered SSE carries the same reply and units as the JSON call', async () => {
    const r = await chatRequest(gw.key, { stream: true });
    expect(r.status, `G7: ${r.text.slice(0, 600)}`).toBe(200);
    expect(String(r.headers.get('content-type'))).toMatch(/^text\/event-stream/);
    const sse = parseSse(r.text);
    expect(sse.done, 'the stream must end with data: [DONE]').toBe(true);
    expect(sse.events.length, `G7 events: ${r.text.slice(0, 600)}`).toBe(4); // role, content, finish, usage
    const usageChunk = sse.events.at(-1);
    const id = `chatcmpl-${String(usageChunk?.dkg?.call_id).slice(2)}`;
    for (const e of sse.events) {
      expect(e).toMatchObject({ id, object: 'chat.completion.chunk', model: STUB_MODEL_ID });
    }
    const [role, content, finish] = sse.events;
    expect(role.choices).toEqual([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    expect(content.choices).toEqual([{ index: 0, delta: { content: gw.chatContent }, finish_reason: null }]);
    expect(finish.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    const streamed = sse.events.slice(0, -1).map((e) => e.choices[0]?.delta?.content ?? '').join('');
    expect(streamed, 'concatenated deltas = the JSON reply').toBe(GV2_REPLY);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 });
    expect(usageChunk.dkg.call_id, 'a new call, not a replay').not.toBe(gw.chatCallId);
    const cost = assertGatewayCall(usageChunk.dkg, 'G7', { sellerId: gw.idA, offering: 'devnet-chat', askPerUnitWei: ASK_CHAT_A_WEI, servedUnits: 22n });
    expectChatMetering(usageChunk.dkg, 'G7', { prompt: 17, tool: 0, completion: 5 }, { prompt_tokens: 17, completion_tokens: 5 });
    gw.costsA += cost;
  });

  it('G8. chat truncation: max_tokens 3 → GV-3 reply, finish length, usage 17/3/20', async () => {
    const r = await chatRequest(gw.key, { max_tokens: 3 });
    expect(r.status, `G8: ${r.text.slice(0, 600)}`).toBe(200);
    expect(r.json.choices[0]).toMatchObject({ message: { role: 'assistant', content: GV3_REPLY }, finish_reason: 'length' });
    expect(r.json.usage).toEqual({ prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 });
    expect(gw.stub.state.lastBody?.max_tokens, 'the upstream cap is the caller max_tokens').toBe(3);
    const cost = assertGatewayCall(r.json.dkg, 'G8', { sellerId: gw.idA, offering: 'devnet-chat', askPerUnitWei: ASK_CHAT_A_WEI, servedUnits: 20n });
    expectChatMetering(r.json.dkg, 'G8', { prompt: 17, tool: 0, completion: 3 }, { prompt_tokens: 17, completion_tokens: 3 });
    gw.costsA += cost;
  });

  it('G9. native tool calls: tool_choice required → finish tool_calls, the named function, recount match', async () => {
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const r = await chatRequest(gw.key, { tools, tool_choice: 'required' });
    expect(r.status, `G9: ${r.text.slice(0, 600)}`).toBe(200);
    const choice = r.json.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toHaveLength(1);
    const call = choice.message.tool_calls[0];
    expect(call.type).toBe('function');
    expect(call.function.name).toBe('lookup');
    expect(call.id).toMatch(/^call_stub_[0-9a-f]{16}$/);
    expect(JSON.parse(call.function.arguments)).toEqual({ echo: 3 }); // words('hello marketplace world')
    // The upstream got the tools natively, max_tokens still the default (the
    // tool-call slack is authorization headroom only tool calls can use).
    expect(gw.stub.state.lastBody).toMatchObject({ tool_choice: 'required', max_tokens: GATEWAY_DEFAULT_MAX_TOKENS });
    expect(gw.stub.state.lastBody.tools?.[0]?.function?.name).toBe('lookup');
    // Units: prompt 17 + the tool envelope (one whitespace-free JSON word under
    // stub-words) + the tool call's JSON (one word).
    const toolUnits = Number(r.json.dkg?.metering?.tool_units);
    expect(toolUnits, 'the tool envelope is metered').toBeGreaterThanOrEqual(1);
    expect(r.json.usage).toEqual({ prompt_tokens: 17 + toolUnits, completion_tokens: 1, total_tokens: 18 + toolUnits });
    const cost = assertGatewayCall(r.json.dkg, 'G9', {
      sellerId: gw.idA,
      offering: 'devnet-chat',
      askPerUnitWei: ASK_CHAT_A_WEI,
      servedUnits: BigInt(18 + toolUnits),
    });
    expectChatMetering(r.json.dkg, 'G9', { prompt: 17, tool: toolUnits, completion: 1 }, { prompt_tokens: 17, completion_tokens: 1 });
    gw.costsA += cost;
  });

  it('G10. /query: the static cost schedule meters admission 3 + delivery 0|1, recount match', async () => {
    const r = await gwCall('/query', gw.key, { method: 'POST', body: { sparql: SPARQL_PROBE, max_rows: 100 } });
    expect(r.status, `G10: ${r.text.slice(0, 600)}`).toBe(200);
    const j = r.json;
    expect(j.object).toBe('dkg.query.result');
    expect(j.id).toBe(j.dkg?.call_id);
    expect(j.aborted).toBeNull();
    expect(j.row_count).toBeGreaterThanOrEqual(0);
    expect(j.row_count).toBeLessThanOrEqual(5);
    const delivery = j.row_count > 0 ? 1 : 0;
    expect(j.usage).toEqual({ admission_units: 3, delivery_units: delivery, total_units: 3 + delivery });
    expect(j.dkg.metering).toEqual({ schedule_digest: QUERY_SCHEDULE_DIGEST, admission_units: '3', delivery_units: String(delivery) });
    expect(j.dkg.recount).toEqual({ verdict: 'match', reason: null, recount_units: String(3 + delivery) });
    const cost = assertGatewayCall(j.dkg, 'G10', {
      sellerId: gw.idA,
      offering: 'devnet-knowledge',
      askPerUnitWei: ASK_KNOWLEDGE_A,
      servedUnits: BigInt(3 + delivery),
    });
    gw.costsA += cost;
    // Every gateway call so far was served by A and charged to this key.
    expect(asBigInt(j.dkg.key.spent_wei, 'spent_wei'), 'key spend = Σ gateway costs').toBe(gw.costsA);
    expect(asBigInt(j.dkg.key.remaining_wei, 'remaining_wei')).toBe(GW_KEY_BUDGET_WEI - gw.costsA);
  });

  it('G11. key budget: a call whose worst case exceeds the key budget is refused 429 with zero movement', async () => {
    const small = await mintGatewayKey(
      { label: 'e2e-small', budgetWei: GW_SMALL_KEY_BUDGET_WEI.toString(), modelAllowlist: [STUB_MODEL_ID] },
      'G11',
    );
    gw.helperKeyIds.push(small.keyId);
    const meterBefore = await getJson(gw.buyer, '/api/marketplace/meter');
    expect(meterBefore.status).toBe(200);
    const callsBefore = gw.stub.state.calls;
    const r = await chatRequest(small.key, {});
    expectGatewayError(r, 'G11 over-budget chat', { status: 429, type: 'insufficient_quota', code: 'key_budget_exceeded', chargedWei: 0n });
    const meterAfter = await getJson(gw.buyer, '/api/marketplace/meter');
    expect(meterAfter.json?.state, 'the refused call must not move the plan meter').toEqual(meterBefore.json?.state);
    expect(meterAfter.json?.state?.totalReservedWei).toBe(meterBefore.json?.state?.totalReservedWei);
    expect(gw.stub.state.calls, 'the refused call never reaches the upstream').toBe(callsBefore);
    const rec = (await listGatewayKeys()).keys.find((k) => k.keyId === small.keyId);
    expect(asBigInt(rec?.usage?.spentWei, 'small key spentWei')).toBe(0n);
  });

  it('G12. key scopes: allowQuery false → 403 query_not_allowed; another model only → 403 model_not_allowed', async () => {
    const noQuery = await mintGatewayKey({ label: 'e2e-no-query', budgetWei: GW_KEY_BUDGET_WEI.toString(), allowQuery: false }, 'G12 no-query');
    gw.helperKeyIds.push(noQuery.keyId);
    expectGatewayError(
      await gwCall('/query', noQuery.key, { method: 'POST', body: { sparql: SPARQL_PROBE } }),
      'G12 query without allowQuery',
      { status: 403, type: 'permission_error', code: 'query_not_allowed', chargedWei: 0n },
    );
    const other = await mintGatewayKey(
      { label: 'e2e-other-model', budgetWei: GW_KEY_BUDGET_WEI.toString(), modelAllowlist: ['other-model'] },
      'G12 other-model',
    );
    gw.helperKeyIds.push(other.keyId);
    expectGatewayError(await chatRequest(other.key, {}), 'G12 chat outside the allowlist', {
      status: 403,
      type: 'permission_error',
      code: 'model_not_allowed',
      param: 'model',
      chargedWei: 0n,
    });
    const models = await gwCall('/models', other.key);
    expect(models.status).toBe(200);
    expect(models.json?.data, '/models is filtered by the key allowlist').toEqual([]);
  });

  it('G13. carve-out: a gateway key authenticates nothing outside the gateway; unknown gateway paths 404 after the key', async () => {
    const asKey = { authorization: `Bearer ${gw.key}` };
    expect((await httpRequest(gw.buyer, '/api/marketplace/status', asKey)).status, 'gateway key on /api/marketplace/status').toBe(401);
    expect(
      (await httpRequest(gw.buyer, '/api/marketplace/keys', { ...asKey, method: 'POST', body: { budgetWei: '1' } })).status,
      'gateway key on the key admin route',
    ).toBe(401);
    expect(
      (await httpRequest(gw.buyer, '/api/query', { ...asKey, method: 'POST', body: { sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1' } })).status,
      'gateway key on /api/query',
    ).toBe(401);
    expectGatewayError(await gwCall('/keys', gw.key), 'G13 unknown gateway path', {
      status: 404,
      type: 'invalid_request_error',
      code: 'unknown_url',
      chargedWei: 0n,
    });
    expectGatewayError(await gwCall('/chat/completions', gw.key), 'G13 wrong method', {
      status: 405,
      type: 'invalid_request_error',
      code: 'method_not_allowed',
      chargedWei: 0n,
    });
    // The route table is not enumerable without a key (S3).
    expectGatewayUnauthorized(await gwCall('/keys', null), 'unknown gateway path without a key', 'invalid_api_key');
  });

  it('G14. revoke: idempotent, and the very next call with the key is 401 key_revoked', async () => {
    const r = await adminRequest(gw.buyer, `/api/marketplace/keys/${gw.keyId}/revoke`, { method: 'POST', body: {} });
    expect(r.status, `revoke: ${r.text.slice(0, 300)}`).toBe(200);
    expect(r.json?.keyId).toBe(gw.keyId);
    expect(Number.isSafeInteger(r.json?.revokedAt)).toBe(true);
    const again = await adminRequest(gw.buyer, `/api/marketplace/keys/${gw.keyId}/revoke`, { method: 'POST', body: {} });
    expect(again.status).toBe(200);
    expect(again.json?.revokedAt, 'a second revoke keeps the original revokedAt').toBe(r.json.revokedAt);
    const callsBefore = gw.stub.state.calls;
    expectGatewayUnauthorized(await chatRequest(gw.key, {}), 'chat with the revoked key', 'key_revoked');
    expect(gw.stub.state.calls).toBe(callsBefore);
    const rec = (await listGatewayKeys()).keys.find((k) => k.keyId === gw.keyId);
    expect(rec?.revokedAt).toBe(r.json.revokedAt);
    // Leave nothing spendable behind.
    for (const keyId of gw.helperKeyIds) {
      const h = await adminRequest(gw.buyer, `/api/marketplace/keys/${keyId}/revoke`, { method: 'POST', body: {} });
      expect(h.status, `revoke ${keyId}`).toBe(200);
    }
  });

  it('G15. claims: seller A\'s on-chain claim grows by exactly the gateway costs; B served nothing', async () => {
    expect(gw.costsA).toBeGreaterThan(0n);
    // The plan meter (fresh since G3's subscribe) settled exactly the gateway costs.
    const meter = await getJson(gw.buyer, '/api/marketplace/meter');
    expect(big(meter.json?.state?.totalSettledWei, 'meter totalSettledWei')).toBe(gw.costsA);
    expect(big(meter.json?.state?.totalReservedWei, 'meter totalReservedWei')).toBe(0n);

    const flush = await adminRequest(gw.sellerA, '/api/marketplace/settle', { method: 'POST', body: { action: 'flush-receipts' } });
    expect(flush.status, `seller A flush: ${flush.text.slice(0, 300)}`).toBe(200);
    const expectedA = gw.claimABefore + gw.costsA;
    const claim = await waitFor(
      `getSellerClaim(buyer, ${gw.epoch}, A).claimed == ${gw.claimABefore} + ${gw.costsA}`,
      120_000,
      3_000,
      async () => {
        const c = await gw.marketplace.getSellerClaim(gw.buyerAddr, gw.epoch, gw.idA);
        return c.claimed === expectedA ? c : null;
      },
    );
    expect(claim.enrolled).toBe(true);
    const claimB = await gw.marketplace.getSellerClaim(gw.buyerAddr, gw.epoch, gw.idB);
    expect(BigInt(claimB.claimed), 'the pricier seller B served no gateway call').toBe(gw.claimBBefore);
  });
});
