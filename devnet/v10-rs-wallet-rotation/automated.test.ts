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
 * The scaffolding + assertions follow the established devnet pattern, but the
 * RS-timing orchestration (how long to warp / wait for the prover to emit a
 * full create→submit cycle) has NOT yet been tuned against a live network.
 * Run `./scripts/devnet.sh start 6` and `pnpm test:devnet:v10-rs-wallet-rotation`,
 * then adjust WINDOW_MS / warp cadence to your devnet's proofing-period length.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Run:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   pnpm test:devnet:v10-rs-wallet-rotation
 *
 * Tuning:
 *   DKG_RS_ROT_NODE   (default 1)      — which node to observe
 *   DKG_RS_ROT_WINDOW (default 300000) — ms to watch for RS txs
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  contractAt,
  setEth,
  getJson,
  postJson,
  sleep,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';

const OBSERVE_NODE = Number(process.env.DKG_RS_ROT_NODE ?? 1);
const WINDOW_MS = Number(process.env.DKG_RS_ROT_WINDOW ?? 300_000);

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

/** Lowercased addresses the node reports as its registered operational wallets. */
async function nodeOperationalWallets(): Promise<Set<string>> {
  const { json } = await getJson(node, '/api/operational-wallets');
  const set = new Set<string>();
  for (const w of json.wallets ?? []) {
    if (!w.isAdmin) set.add(String(w.address).toLowerCase());
  }
  return set;
}

/**
 * Scan blocks `[fromBlock, toBlock]` for transactions the node's wallets sent to
 * the RandomSampling contract, bucketed by method. Returns the distinct sender
 * set per method (all lowercased).
 */
async function collectRsSenders(
  fromBlock: number,
  toBlock: number,
): Promise<{ create: Set<string>; submit: Set<string> }> {
  const create = new Set<string>();
  const submit = new Set<string>();
  const rsLower = randomSamplingAddr.toLowerCase();
  for (let b = fromBlock; b <= toBlock; b += 1) {
    const block = await state.provider.getBlock(b, true);
    if (!block) continue;
    for (const tx of block.prefetchedTransactions ?? []) {
      if ((tx.to ?? '').toLowerCase() !== rsLower) continue;
      const sel = (tx.data ?? '0x').slice(0, 10);
      const from = tx.from.toLowerCase();
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

  // Ensure the node has ≥2 registered operational wallets. If it starts with
  // only the primary, add a throwaway one via the node-admin route (this is the
  // same on-chain-verified path pr1370-admin-op-wallet exercises) and fund it
  // with gas so RS can actually route to it.
  let wallets = await nodeOperationalWallets();
  if (wallets.size < 2) {
    const throwaway = ethers.Wallet.createRandom().address;
    const res = await postJson(node, '/api/operational-wallets', { address: throwaway });
    expect(res.status, `add op wallet: ${JSON.stringify(res.json)}`).toBe(200);
    await setEth(state, throwaway, '10'); // fund gas so RS may select it
    wallets = await nodeOperationalWallets();
  }
  expect(wallets.size, 'node must have ≥2 registered operational wallets to observe rotation').toBeGreaterThanOrEqual(2);
}, 300_000);

describe('V10 Random Sampling — operational-wallet rotation (Phase 4)', () => {
  it('rotates RS writes across registered wallets, and EVERY sender is a registered op key (fail-closed)', async () => {
    const registered = await nodeOperationalWallets();
    const startBlock = await state.provider.getBlockNumber();

    // Watch a window for the node's autonomous prover to emit RS txs. NOTE: this
    // is the part that needs tuning to the devnet's proofing-period length — on
    // a quiet devnet you may need to warp time and/or lengthen DKG_RS_ROT_WINDOW.
    const deadline = Date.now() + WINDOW_MS;
    let senders = new Set<string>();
    let create = new Set<string>();
    let submit = new Set<string>();
    while (Date.now() < deadline) {
      await sleep(10_000);
      const toBlock = await state.provider.getBlockNumber();
      ({ create, submit } = await collectRsSenders(startBlock, toBlock));
      senders = new Set([...create, ...submit]);
      // Stop early once we've observed a full create→submit cycle spanning ≥2 wallets.
      if (create.size >= 1 && submit.size >= 1 && senders.size >= 2) break;
    }

    expect(senders.size, 'observed NO RS txs from the node in the window — lengthen DKG_RS_ROT_WINDOW / warp proof periods').toBeGreaterThan(0);

    // FAIL-CLOSED (deterministic, the core safety property): every wallet that
    // signed an RS tx resolves to THIS node's identity on-chain.
    for (const sender of senders) {
      expect(registered.has(sender), `RS sender ${sender} is not a reported operational wallet`).toBe(true);
      const id = BigInt(await identityStorage.getIdentityId(ethers.getAddress(sender)));
      expect(id, `RS sender ${sender} must resolve to the node identity on-chain`).toBe(node.identityId);
    }

    // ROTATION: over a window that includes a full create→submit cycle the RS
    // senders span ≥2 wallets (createChallenge and submitProof advance the
    // round-robin cursor, so within a period they differ).
    expect(senders.size, 'RS did not rotate across ≥2 wallets in the window (see VALIDATION STATUS in the header)').toBeGreaterThanOrEqual(2);
  }, WINDOW_MS + 120_000);
});
