/**
 * PR #1387 — BULK `registerAgents` on the V10 publishing-conviction stack.
 *
 * The single-agent `registerAgent(uint256,address)` lives on the frozen,
 * non-upgradeable `DKGPublishingConvictionNFT` wrapper. The frozen wrapper
 * cannot host a batch entry point, so PR #1387 adds the bulk counterpart on the
 * upgradeable LOGIC contract `PublishingConviction`, owner-gated against the
 * live `ownerOf`:
 *
 *     function registerAgents(uint256 accountId, address[] calldata agents)
 *         external onlyCurrentPcaOwner(accountId)
 *
 * Per-agent validation is IDENTICAL to the single-agent path (verified in
 * PublishingConviction.sol:1216 + PublishingConvictionStorage.sol:379):
 *   - `agent != address(0)`              → else revert ZeroAgentAddress()
 *   - `agentCount(accountId) < cap`      → else revert AgentCapReached(id,cap)
 *     (cap = maxAgentsPerAccount, default 100; re-checked each iteration)
 *   - agent not already registered ANYWHERE (global reverse map) → else PCS
 *     reverts AgentAlreadyRegistered(agent,existingAccountId). Because the map
 *     is written inside the loop, this ALSO rejects in-array duplicates.
 *   - ALL-OR-NOTHING: any invalid entry reverts the whole tx (EVM atomicity);
 *     every `addAgent` write performed earlier in the same call is rolled back.
 *
 * Network-observable goal: register N agents in ONE tx; afterwards each
 * `agentToAccountId(agent) == accountId`. And a duplicate-in-batch reverts the
 * WHOLE tx with NO partial writes surviving.
 *
 * Pure-chain suite: no node publish, no daemon route, no time warp. Drives the
 * Hub-registered `PublishingConviction` logic handle directly via ethers
 * (events + bulk method live there; see conviction-lazy-settle for the same
 * wrapper/logic split) and reads post-state through the NFT wrapper's
 * `agentToAccountId` forwarder.
 *
 * Isolation: every `it` mints a FRESH isolated PCA (createFreshPca → throwaway
 * owner wallet) and uses throwaway random agent addresses. Nothing the sweep
 * depends on is mutated.
 *
 * Preconditions:  ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  createFreshPca,
  contractAt,
  setEth,
  nextNonce,
  type DevnetState,
} from '../_bootstrap/harness.js';

// Verified against packages/evm-module/abi/PublishingConviction.json:
//   registerAgents(uint256 accountId, address[] agents)
//   clearAgents(uint256 accountId)
//   event AgentRegistered(uint256 indexed accountId, address indexed agent)
//   error ZeroAgentAddress()
//   error AgentCapReached(uint256 accountId, uint256 cap)
//   error NotAccountOwner(uint256 accountId, address caller)
// AgentAlreadyRegistered is declared on PublishingConvictionStorage (the revert
// originates there); we add its fragment so ethers can best-effort decode the
// cross-contract custom error. Decoding is a bonus — the load-bearing checks
// are rejects.toThrow() + the post-state sentinel reads.
const PUBLISHING_CONVICTION_ABI = [
  'function registerAgents(uint256 accountId, address[] agents) external',
  'function maxAgentsPerAccount() view returns (uint256)',
  'event AgentRegistered(uint256 indexed accountId, address indexed agent)',
  'error ZeroAgentAddress()',
  'error AgentCapReached(uint256 accountId, uint256 cap)',
  'error NotAccountOwner(uint256 accountId, address caller)',
  'error AgentAlreadyRegistered(address agent, uint256 existingAccountId)',
];

// `agentToAccountId` returns 0 for an unregistered address (PublishingConviction
// .sol:392 documents 0 as the "never registered" sentinel; real accountIds are
// always > 0, which createFreshPca asserts). So `=== 0n` means "not registered".
const UNREGISTERED = 0n;

const randomAgents = (n: number): string[] =>
  Array.from({ length: n }, () => ethers.Wallet.createRandom().address);

let state: DevnetState;

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run ./scripts/devnet.sh start 6 (then re-run this suite).',
    );
  }
  state = detected;
  await ensureAllIdentities(state, 4);
}, 240_000);

describe('PR #1387 — bulk registerAgents on PublishingConviction', () => {
  it('registers K fresh agents in ONE tx; each agentToAccountId == accountId', async () => {
    const pca = await createFreshPca(state);
    expect(pca.accountId).toBeGreaterThan(0n);

    const pc = contractAt(state, 'PublishingConviction', PUBLISHING_CONVICTION_ABI).connect(
      pca.admin,
    ) as ethers.Contract;

    const K = 5;
    const agents = randomAgents(K);

    // Pre-state: none of the fresh agents are registered anywhere.
    for (const a of agents) {
      expect(await state.nft.agentToAccountId(a)).toBe(UNREGISTERED);
    }

    const tx = await pc.registerAgents(pca.accountId, agents, {
      nonce: await nextNonce(state.provider, pca.admin.address),
    });
    const receipt = await tx.wait();
    expect(receipt?.status).toBe(1);

    // Every agent now points at THIS account, via the NFT wrapper forwarder.
    for (const a of agents) {
      expect(await state.nft.agentToAccountId(a)).toBe(pca.accountId);
    }

    // One tx, K registrations: exactly K AgentRegistered events for this account.
    const iface = new ethers.Interface(PUBLISHING_CONVICTION_ABI);
    let emitted = 0;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'AgentRegistered' && (parsed.args.accountId as bigint) === pca.accountId) {
          emitted += 1;
          expect(agents).toContain(parsed.args.agent as string);
        }
      } catch {
        /* unrelated log */
      }
    }
    expect(emitted).toBe(K);
  });

  it('duplicate-in-batch reverts the WHOLE tx — no partial agent survives (atomicity)', async () => {
    const pca = await createFreshPca(state);

    const pc = contractAt(state, 'PublishingConviction', PUBLISHING_CONVICTION_ABI).connect(
      pca.admin,
    ) as ethers.Contract;

    // [dupA, freshB, dupA]: iteration 0 writes dupA, iteration 1 writes freshB,
    // iteration 2 hits AgentAlreadyRegistered on dupA (global reverse map already
    // set in iteration 0). The whole tx must revert. The load-bearing atomicity
    // proof is that freshB — which DID succeed mid-tx — is rolled back to 0.
    const [dupA] = randomAgents(1);
    const [freshB] = randomAgents(1);
    const batch = [dupA, freshB, dupA];

    let reverted = false;
    let decodedErrName: string | undefined;
    try {
      // No pinned nonce: estimateGas reverts before send, so the promise rejects
      // and no nonce is consumed.
      const tx = await pc.registerAgents(pca.accountId, batch);
      await tx.wait();
    } catch (err) {
      reverted = true;
      decodedErrName = (err as { revert?: { name?: string } })?.revert?.name;
    }
    expect(reverted, 'duplicate-in-batch registerAgents must revert').toBe(true);

    // Bonus (not the gate): when decodable, the revert is AgentAlreadyRegistered.
    if (decodedErrName !== undefined) {
      expect(decodedErrName).toBe('AgentAlreadyRegistered');
    }

    // Atomicity: NOTHING from the failed batch persisted — including freshB,
    // whose addAgent write succeeded before the revert. This is the real proof.
    expect(await state.nft.agentToAccountId(freshB)).toBe(UNREGISTERED);
    expect(await state.nft.agentToAccountId(dupA)).toBe(UNREGISTERED);
  });

  it('non-owner caller is rejected (NotAccountOwner) — owner-only batch surface', async () => {
    const pca = await createFreshPca(state);

    // A throwaway wallet that is NOT the PCA owner.
    const stranger = ethers.Wallet.createRandom().connect(state.provider);
    await setEth(state, stranger.address, '100');

    const pcAsStranger = contractAt(
      state,
      'PublishingConviction',
      PUBLISHING_CONVICTION_ABI,
    ).connect(stranger) as ethers.Contract;

    const [agent] = randomAgents(1);

    let reverted = false;
    let decodedErrName: string | undefined;
    try {
      const tx = await pcAsStranger.registerAgents(pca.accountId, [agent]);
      await tx.wait();
    } catch (err) {
      reverted = true;
      decodedErrName = (err as { revert?: { name?: string } })?.revert?.name;
    }
    expect(reverted, 'non-owner registerAgents must revert').toBe(true);
    if (decodedErrName !== undefined) {
      expect(decodedErrName).toBe('NotAccountOwner');
    }

    // The owner-gate fired before any write: agent stays unregistered.
    expect(await state.nft.agentToAccountId(agent)).toBe(UNREGISTERED);
  });
});
