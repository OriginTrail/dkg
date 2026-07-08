/**
 * V10 Random Sampling — operational-wallet ROTATION, end-to-end on a live devnet.
 *
 * Proves the Phase-4 dispatcher behaviour against the DEPLOYED contracts + the
 * REAL prover loop — the layer the chain unit tests can't reach. The rotation
 * LOGIC (fail-closed registered-wallet eligibility, native-only funding,
 * prefer-idle, self-heal) is proven deterministically in
 * `packages/chain/test/evm-adapter.unit.test.ts`; here we prove the operational
 * story on a running network:
 *
 *   1. A node with ≥2 REGISTERED operational wallets rotates its RS writes
 *      (createChallenge / submitProof) across them instead of pinning wallet #0.
 *   2. FAIL-CLOSED: every RS transaction the node sends is signed by a wallet
 *      that resolves to the node's identity on-chain (getIdentityId(sender) ===
 *      identityId) — never a stray / unregistered sender (which would revert
 *      ProfileDoesntExist and burn the proof period).
 *
 * Determinism note (same shape as v10-rs-prune): the network-wide DRAW selects
 * across every weighted CG, so the draw TARGET isn't deterministically
 * assertable on a shared devnet. What IS deterministic and devnet-only evidence
 * is the SENDER identity of the node's own RS txs: (a) every sender is a
 * registered op key of the node, and (b) over a window that includes a full
 * create→submit cycle the senders span ≥2 wallets (createChallenge and
 * submitProof advance the round-robin cursor, so within a period they differ).
 *
 * ── VALIDATION STATUS ──────────────────────────────────────────────────────
 * The scaffolding + assertions follow the established devnet pattern. RS
 * observation is passive: a local untuned run skips when no full create→submit
 * cycle is observed, while DKG_REQUIRE_RS_ROTATION=1 turns that into a hard
 * failure for a required validation lane.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Run:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   pnpm test:devnet:v10-rs-wallet-rotation
 *
 * Tuning:
 *   DKG_RS_ROT_NODE   (default 1)      — which node to observe
 *   DKG_RS_ROT_WINDOW (default 600000) — ms to watch for RS txs
 *   DKG_REQUIRE_RS_ROTATION=1          — fail instead of skip when no full cycle is observed
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  contractAt,
  getJson,
  sleep,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';
import {
  classifyObservedRsSenders,
  classifyRsRotationObservation,
} from './observation-policy.js';

const OBSERVE_NODE = Number(process.env.DKG_RS_ROT_NODE ?? 1);
// Longer default: on a quiet devnet the autonomous prover's proof period can
// exceed a short window, so we passively watch longer. We deliberately do NOT
// evm_increaseTime to force RS — the harness warns that time-warping the SHARED
// chain clock breaks in-flight RS challenges for every node/suite.
const WINDOW_MS = Number(process.env.DKG_RS_ROT_WINDOW ?? 600_000);
// Required-lane opt-in: when set, a not-observed RS cycle FAILS instead of
// skipping (for a lane that guarantees a long-enough window). Mirrors the
// DEVNET_REQUIRE_STORE_OUTAGE gate on the store-outage suite.
const REQUIRE_RS_ROTATION = process.env.DKG_REQUIRE_RS_ROTATION === '1';

// RandomSampling method selectors — RS txs from the node's wallets are matched
// by `to === RandomSampling` and one of these leading 4 bytes.
const RS_IFACE = new ethers.Interface([
  'function createChallenge()',
  'function submitProof(bytes content, bytes32[] proof)',
]);
const CREATE_SELECTOR = RS_IFACE.getFunction('createChallenge')!.selector;
const SUBMIT_SELECTOR = RS_IFACE.getFunction('submitProof')!.selector;

const IDENTITY_STORAGE_ABI = [
  'function getIdentityId(address operational) view returns (uint72)',
];

let state: DevnetState;
let node: DevnetNode;
let identityStorage: ethers.Contract;
let randomSamplingAddr: string;

/**
 * Lowercased addresses from the node's LOCAL wallet store. `operational`
 * excludes the admin key; `all` is the node's complete signing universe —
 * the attribution scope for "this node sent that tx" (a node can only sign
 * with keys it holds).
 */
async function nodeLocalWallets(): Promise<{ operational: Set<string>; all: Set<string> }> {
  const { json } = await getJson(node, '/api/operational-wallets');
  const operational = new Set<string>();
  const all = new Set<string>();
  for (const w of json.wallets ?? []) {
    const addr = String(w.address).toLowerCase();
    all.add(addr);
    if (!w.isAdmin) operational.add(addr);
  }
  return { operational, all };
}

/**
 * Scan blocks `[fromBlock, toBlock]` for transactions THE OBSERVED NODE's
 * wallets sent to the RandomSampling contract, bucketed by method. Returns the
 * distinct sender set per method (all lowercased). `nodeWallets` scopes the
 * scan: every node on the devnet runs a prover, so without the sender filter
 * the buckets fill with OTHER nodes' RS txs — tripping both the fail-closed
 * assertion (foreign sender ∉ this node's wallets) and the ≥2-sender early
 * stop (two senders from two different nodes is not rotation).
 */
async function collectRsSenders(
  fromBlock: number,
  toBlock: number,
  nodeWallets: Set<string>,
): Promise<{ create: Set<string>; submit: Set<string> }> {
  const create = new Set<string>();
  const submit = new Set<string>();
  const rsLower = randomSamplingAddr.toLowerCase();
  for (let b = fromBlock; b <= toBlock; b += 1) {
    const block = await state.provider.getBlock(b, true);
    if (!block) continue;
    for (const tx of block.prefetchedTransactions ?? []) {
      if ((tx.to ?? '').toLowerCase() !== rsLower) continue;
      const from = tx.from.toLowerCase();
      if (!nodeWallets.has(from)) continue; // another node's prover — out of scope
      const sel = (tx.data ?? '0x').slice(0, 10);
      if (sel === CREATE_SELECTOR) create.add(from);
      else if (sel === SUBMIT_SELECTOR) submit.add(from);
    }
  }
  return { create, submit };
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run `./scripts/devnet.sh start 6` before this suite ' +
        '(needs a live 6-node devnet + deployed contracts).',
    );
  }
  state = detected;
  await ensureAllIdentities(state, 4);

  node = state.nodes[OBSERVE_NODE]!;
  if (node.identityId === 0n) {
    throw new Error(`node${OBSERVE_NODE} has no on-chain identity — bootstrap the devnet first`);
  }
  identityStorage = contractAt(state, 'IdentityStorage', IDENTITY_STORAGE_ABI);

  const hub = contractAt(state, 'Hub', ['function getContractAddress(string) view returns (address)']);
  randomSamplingAddr = await hub.getContractAddress('RandomSampling');

  // HARD PRECONDITION: the node needs ≥2 LOCAL operational wallets (keys it
  // can actually sign with). POSTing a random address to
  // /api/operational-wallets cannot manufacture one — that route only
  // AUTHORIZES an address on-chain; the daemon holds no key for it and the
  // GET below lists the LOCAL wallet store, so a fallback registration can
  // never satisfy this check. The canonical devnet provisions 3
  // (`NUM_OP_WALLETS=3` in scripts/devnet.sh).
  const { operational } = await nodeLocalWallets();
  expect(
    operational.size,
    `node${OBSERVE_NODE} has ${operational.size} local operational wallet(s); rotation needs ≥2. ` +
      'Start the devnet with NUM_OP_WALLETS>=2 (scripts/devnet.sh default is 3) — ' +
      'an on-chain-only registration cannot substitute for a local signing key.',
  ).toBeGreaterThanOrEqual(2);
}, 300_000);

describe('V10 Random Sampling — operational-wallet rotation (Phase 4)', () => {
  it('rotates RS writes across registered wallets, and EVERY sender is a registered op key (fail-closed)', async (ctx) => {
    const { operational: registered, all: localWallets } = await nodeLocalWallets();
    const startBlock = await state.provider.getBlockNumber();

    // Watch a window for the node's autonomous prover to emit RS txs. NOTE: this
    // is passive by design; use the required lane when an inconclusive
    // observation must fail instead of skip.
    const deadline = Date.now() + WINDOW_MS;
    let senders = new Set<string>();
    let create = new Set<string>();
    let submit = new Set<string>();
    while (Date.now() < deadline) {
      await sleep(10_000);
      const toBlock = await state.provider.getBlockNumber();
      // Scope by the node's FULL local store (not just op keys) so the
      // fail-closed check below keeps teeth: an RS tx signed by a local
      // non-operational key (e.g. the admin wallet) must FAIL, not vanish.
      ({ create, submit } = await collectRsSenders(startBlock, toBlock, localWallets));
      senders = new Set([...create, ...submit]);
      // Stop early once we've observed a full create→submit cycle spanning ≥2 wallets.
      if (create.size >= 1 && submit.size >= 1 && senders.size >= 2) break;
    }

    const senderOutcome = classifyObservedRsSenders(senders, registered);
    if (senderOutcome.kind === 'fail') throw new Error(senderOutcome.reason);

    // FAIL-CLOSED (deterministic, the core safety property): every observed RS
    // sender is validated before an incomplete-cycle observation can skip. A
    // partial window with a stray/admin sender is still a hard failure.
    for (const sender of senders) {
      const id = BigInt(await identityStorage.getIdentityId(ethers.getAddress(sender)));
      expect(id, `RS sender ${sender} must resolve to the node identity on-chain`).toBe(node.identityId);
    }

    const observationOutcome = classifyRsRotationObservation(create, submit, WINDOW_MS, REQUIRE_RS_ROTATION);
    if (observationOutcome.kind === 'skip') {
      console.warn(`[rs-rotation] SKIP: ${observationOutcome.reason}`);
      ctx.skip();
      return;
    }
    if (observationOutcome.kind === 'fail') throw new Error(observationOutcome.reason);

    // ROTATION: over a window that includes a full create→submit cycle the RS
    // senders span ≥2 wallets (createChallenge and submitProof advance the
    // round-robin cursor, so within a period they differ).
    expect(senders.size, 'RS did not rotate across ≥2 wallets in the window (see VALIDATION STATUS in the header)').toBeGreaterThanOrEqual(2);
  }, WINDOW_MS + 120_000);
});
