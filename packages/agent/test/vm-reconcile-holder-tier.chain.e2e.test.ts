/**
 * The VM holder tier against a REAL chain (Hardhat, the real contracts).
 *
 * The unit and libp2p suites drive the tier with `MockChainAdapter`, which
 * answers `getShardingTable()` and `getIdentityIdForAddress()` from a table the
 * test wrote. This suite proves the two chain facts the tier trusts for routing
 * really line up on the deployed contracts:
 *
 *   phonebook profile `agentAddress` (an operational wallet)
 *     -> `IdentityStorage`: the identity that wallet is registered under
 *     -> `ShardingTable.getShardingTable()`: is that identity a member
 *
 * Staked Cores are members; a registered-but-unstaked identity, a wallet with no
 * identity and a profile with no wallet at all are not, so none of their peers
 * becomes a dial candidate. Run through the full config (Hardhat global setup).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { buildAgentProfile } from '../src/profile.js';
import {
  HARDHAT_KEYS,
  createNodeProfile,
} from '../../chain/test/hardhat-harness.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';

const CG = '0x0000000000000000000000000000000000000001/holder-tier-real-chain';
const SELF = '12D3KooWRealChainHolderTierSelf';
// Real chain, fake transport: these peers are never dialed by this suite.
const PEER_CORE = '12D3KooWRealChainCoreAAAAAAAA';
const PEER_REC1 = '12D3KooWRealChainReceiver1AAA';
const PEER_REC2 = '12D3KooWRealChainReceiver2AAA';
const PEER_UNSTAKED = '12D3KooWRealChainUnstakedAAAA';
const PEER_UNKNOWN = '12D3KooWRealChainNoIdentityAA';
const PEER_NO_WALLET = '12D3KooWRealChainNoWalletAAAAA';

const address = (key: string): string => new Wallet(key).address;

describe('holder tier resolves ShardingTable membership on a real chain', () => {
  let snapshot: string;
  let agent: DKGAgent;
  let unstakedIdentityId: number;

  beforeAll(async () => {
    snapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    // An identity that exists on chain but never staked: not in the ShardingTable.
    unstakedIdentityId = await createNodeProfile(
      createProvider(), hubAddress, HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3, 'UnstakedNode',
    );
    agent = await DKGAgent.create({
      name: 'RealChainHolderTier',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const stubs = agent as unknown as Record<string, unknown>;
    stubs.node = { peerId: SELF, libp2p: { getConnections: () => [] } };
    // The graph's public policy is its own chain read, covered elsewhere.
    stubs.readAgentsPhonebookAccessPolicy = async () => 'public';

    const profile = (peerId: string, agentAddress?: string): Quad[] => buildAgentProfile({
      peerId,
      name: `node-${peerId.slice(-6)}`,
      skills: [],
      nodeRole: 'core',
      ...(agentAddress === undefined ? {} : { agentAddress }),
      lastSeen: new Date().toISOString(),
    }).quads;
    await agent.store.insert([
      ...profile(PEER_CORE, address(HARDHAT_KEYS.CORE_OP)),
      ...profile(PEER_REC1, address(HARDHAT_KEYS.REC1_OP)),
      ...profile(PEER_REC2, address(HARDHAT_KEYS.REC2_OP)),
      ...profile(PEER_UNSTAKED, address(HARDHAT_KEYS.EXTRA1)),
      ...profile(PEER_UNKNOWN, address(HARDHAT_KEYS.PUBLISHER)),
      ...profile(PEER_NO_WALLET),
    ]);
  }, 120_000);

  afterAll(async () => {
    await agent?.stop().catch(() => undefined);
    await revertSnapshot(snapshot);
  });

  it('keeps the peers of staked ShardingTable identities and nobody else', async () => {
    expect(unstakedIdentityId).toBeGreaterThan(0);
    const internals = agent as unknown as {
      chain: { listDesignatableNodes(): Promise<Array<{ identityId: bigint }>>; getIdentityIdForAddress(a: string): Promise<bigint> };
      vmReconcileHolderTier: { peerIdsFor(cg: string): readonly string[] };
      refreshVmReconcileHolderTier(cg: string, o: { isCurrent: () => boolean }): Promise<void>;
      vmReconcileObservedCandidatePeerIds(cg: string): string[];
    };

    // The premise, read straight from the contracts.
    const table = new Set((await internals.chain.listDesignatableNodes()).map((node) => node.identityId));
    const { coreProfileId, receiverIds } = getSharedContext();
    expect(table.has(BigInt(coreProfileId))).toBe(true);
    expect(await internals.chain.getIdentityIdForAddress(address(HARDHAT_KEYS.CORE_OP))).toBe(BigInt(coreProfileId));
    expect(table.has(BigInt(unstakedIdentityId))).toBe(false);
    expect(await internals.chain.getIdentityIdForAddress(address(HARDHAT_KEYS.EXTRA1))).toBe(BigInt(unstakedIdentityId));
    expect(await internals.chain.getIdentityIdForAddress(address(HARDHAT_KEYS.PUBLISHER))).toBe(0n);
    expect(receiverIds.length).toBeGreaterThanOrEqual(2);

    await internals.refreshVmReconcileHolderTier(CG, { isCurrent: () => true });

    const holders = internals.vmReconcileHolderTier.peerIdsFor(CG);
    expect([...holders].sort()).toEqual([PEER_CORE, PEER_REC1, PEER_REC2].sort());
    // No connection view and no curator: the roster is exactly the hinted holders.
    expect(internals.vmReconcileObservedCandidatePeerIds(CG).sort()).toEqual([PEER_CORE, PEER_REC1, PEER_REC2].sort());
    for (const rejected of [PEER_UNSTAKED, PEER_UNKNOWN, PEER_NO_WALLET]) {
      expect(holders).not.toContain(rejected);
    }
  }, 120_000);
});
