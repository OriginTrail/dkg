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
 *      and a SPARQL invoke serves against A's local graph; results, metered
 *      costs, receipt value math and the shared RCPT_DOMAIN EIP-191 crypto
 *      are asserted. A's claims stay UNSUBMITTED (no flush).
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
 * AMOUNTS: the subscription is deliberately funded in SMALL wei amounts
 * (Σ = 0.001 TRAC) while the buyer wallet is topped up BY 10 TRAC on top of
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
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
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
  timeWarpSeconds,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

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
//   combined actuals ≥ 2.5e14 + 11·1.5e13 + 6.4e14 = 1.055e15 > 1e15 = the
//     final funded total (tranche 3 lands only after both phases flushed).
const SUB1_WEI = 500_000_000_000_000n; // 5e14
const SUB2_WEI = 400_000_000_000_000n; // 4e14
const SUB3_WEI = 100_000_000_000_000n; // 1e14
const FUNDED_TOTAL_WEI = SUB1_WEI + SUB2_WEI + SUB3_WEI; // 1e15 (0.001 TRAC)

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
// inference calls; the query's worst case caps the deterministic schedule
// queryUnits = 10 + ceil(42/100) + rows, rows ≤ 5 (LIMIT 5) → [11, 16] units.
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

// ───────────────────────────── beforeAll ─────────────────────────────────

beforeAll(async () => {
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

  // Epoch-boundary guard: every subscription tranche below pins the SAME
  // epoch, and fundSubscription only accepts current/current+1 — so if we are
  // within ~20 minutes of the boundary, warp into a fresh epoch first instead
  // of flaking mid-run. (This suite already time-warps for settlement.)
  const untilNext: bigint = await chronos.timeUntilNextEpoch();
  if (untilNext < 1200n) {
    await timeWarpSeconds(state.provider, Number(untilNext) + 30);
  }
  const epoch: bigint = await chronos.getCurrentEpoch();
  expect(epoch).toBeGreaterThan(0n);

  // TOP UP the buyer's on-chain funding wallet (node2's primary operational
  // wallet — the adapter's primary signer is fundSubscription's msg.sender).
  // fundTrac OVERWRITES the ERC-20 balance slot, so read-modify-write: setting
  // it to a bare 10 TRAC would wipe the wallet's bootstrap balance (~1M TRAC),
  // which the node's other on-chain roles rely on.
  const buyerAddr = buyer.opWallets[0]!.address;
  const buyerTracBefore: bigint = await state.token.balanceOf(buyerAddr);
  await fundTrac(state, buyerAddr, buyerTracBefore + ethers.parseEther('10'));

  ctx = {
    state,
    marketplace,
    chronos,
    sellerA,
    sellerB,
    buyer,
    idA: sellerA.identityId,
    idB: sellerB.identityId,
    buyerAddr,
    epoch,
    expectedClaimA: 0n,
    expectedClaimB: 0n,
  };
});

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
    // the 5e14 bucket on top of A's own 2.5e14 unsubmitted exposure.
    const q = await postJson(ctx.buyer, '/api/marketplace/invoke', {
      serviceType: 'query',
      payload: { sparql: SPARQL_PROBE },
      maxUnits: QUERY_MAX_UNITS.toString(),
    });
    const queryCost = assertServedInvoke(q, 'query invoke', ctx.idA, ASK_KNOWLEDGE_A);
    // The deterministic schedule: 10 + ceil(42/100) + rows(0..5) ∈ [11, 16].
    expect(big(q.json?.servedUnits, 'query servedUnits')).toBeGreaterThanOrEqual(11n);
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
    // the FINAL funded total (tranche 3, another 1e14, lands in step 7).
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
    if (warp > 0n) await timeWarpSeconds(ctx.state.provider, Number(warp));

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
