import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES } from '../src/evm-adapter-events.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
  createNodeProfile,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext;

describe('EVMChainAdapter integration', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8545);
  }, 60_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('should connect and resolve V10 contracts from Hub', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe('evm:31337');

    // V8 `KnowledgeCollection` + `Staking` were archived in TB-1 (PRD §4.1)
    // — their Hub bindings no longer exist. Hub-resolve the V10 successors
    // instead to assert the adapter still talks to a fresh V10 deploy.
    // Greenfield (PR #815): the lifecycle contract's Hub key + `name()` were
    // renamed KnowledgeAssetsV10 → KnowledgeAssetsLifecycle.
    const kav10 = await adapter.getContract('KnowledgeAssetsLifecycle');
    expect(await kav10.name()).toBe('KnowledgeAssetsLifecycle');

    const stakingV10 = await adapter.getContract('StakingV10');
    expect(await stakingV10.name()).toBe('StakingV10');
  }, 30_000);

  it('should have correct signer address', () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const address = adapter.getSignerAddress();
    expect(address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('getBlockNumber reads from the live Hardhat node (no contract init required)', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const bn = await adapter.getBlockNumber();
    expect(typeof bn).toBe('number');
    expect(bn).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('verifyPublisherOwnsRange resolves KnowledgeAssetsStorage after init', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(owns).toBe(false);
  }, 30_000);

  // verifyACKIdentity gates the off-chain ACKCollector pre-flight. Post RFC-001
  // the on-chain check inside `KnowledgeAssetsV10._verifyACKSignature` is
  // (`keyHasPurpose` && `shardingTableStorage.nodeExists`), and the off-chain
  // pre-flight must mirror that exactly. The harness stakes CORE + REC1..REC3
  // at `minimumStake` so all four are in the sharding table; any newly minted
  // profile with no stake must NOT pass the gate.
  describe('verifyACKIdentity (RFC-001 off-chain ↔ on-chain gate parity)', () => {
    it('accepts a staked-and-in-sharding-table operator key', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const coreOpAddr = new Wallet(HARDHAT_KEYS.CORE_OP).address;
      const ok = await adapter.verifyACKIdentity(coreOpAddr, BigInt(ctx.coreProfileId));
      expect(ok).toBe(true);
      // Off-chain decision must agree with the on-chain ST gate that
      // KnowledgeAssetsV10 enforces at publish time.
      const inST = await adapter.isShardingTableMember!(BigInt(ctx.coreProfileId));
      expect(inST).toBe(true);
    }, 30_000);

    it('rejects a signer that is not a registered operational key for the identity', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const stranger = ethers.Wallet.createRandom().address;
      const ok = await adapter.verifyACKIdentity(stranger, BigInt(ctx.coreProfileId));
      expect(ok).toBe(false);
    }, 30_000);

    it('rejects an operator whose identity is not in the sharding table (unstaked)', async () => {
      // Mint a fresh profile with the EXTRA1 wallet but DON'T stake it. Its
      // operational key is registered (so `keyHasPurpose` passes) but
      // `shardingTableStorage.nodeExists` returns false because the node
      // never crossed `minimumStake`. Pre-RFC-001 this method would have
      // accepted it as long as `getNodeStakeV10 > 0`; we assert the new
      // ST-membership gate keeps it locked out, matching the on-chain
      // contract that would revert the publish with
      // `"ACK signer not in sharding table"`.
      const newId = await createNodeProfile(
        ctx.provider, ctx.hubAddress,
        HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA2, // op + admin keys (unique)
        'UnstakedProfile',
      );
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      const opAddr = new Wallet(HARDHAT_KEYS.EXTRA1).address;
      const ok = await adapter.verifyACKIdentity(opAddr, BigInt(newId));
      expect(ok).toBe(false);
      // Confirm the on-chain ST gate is in the same state.
      const inST = await adapter.isShardingTableMember!(BigInt(newId));
      expect(inST).toBe(false);
    }, 60_000);
  });

  /**
   * #2435 — the four root-mutation events, driven by the REAL emitters.
   *
   * The unit suite proves the decode against encoded logs; it cannot prove that
   * `DKGKnowledgeAssets` still emits what that encoding assumes. A contract
   * change that renamed a field or moved it in or out of the indexed set would
   * leave every unit row green while production yielded nothing — which reads,
   * downstream, exactly like "this asset's root never changed".
   *
   * All four emitters are `onlyContracts`, which `HubDependent._checkHubContract`
   * also grants to the Hub OWNER — the deployer here. That is asserted rather
   * than assumed, so a harness change surfaces as "the deployer is no longer the
   * hub owner" instead of an opaque revert.
   */
  describe('listenForEvents — Knowledge Asset root mutations (#2435)', () => {
    it('yields all four root-mutation events emitted by the real contract', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      await (adapter as any).init();

      const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER).address;
      const hub = (adapter as any).contracts.hub;
      const ka = (adapter as any).contracts.knowledgeAssetStorage;
      expect(String(await hub.owner()).toLowerCase()).toBe(deployer.toLowerCase());

      // OT-RFC-43: the KA id's high 160 bits MUST equal the attested author.
      const author = ethers.getAddress('0x5555555555555555555555555555555555555555');
      const kaId = (BigInt(author) << 96n) | 4_242n;
      const createRoot = ethers.keccak256(ethers.toUtf8Bytes('root-mutations-create'));
      const updateRoot = ethers.keccak256(ethers.toUtf8Bytes('root-mutations-update'));
      const pushedRoot = ethers.keccak256(ethers.toUtf8Bytes('root-mutations-pushed'));
      const replacedRoot = ethers.keccak256(ethers.toUtf8Bytes('root-mutations-replaced'));

      const created = await (await ka.createKnowledgeAsset(
        deployer, author, kaId, 'rm-create', createRoot,
        1, 1000, 1, 2, 0, false, 1,
      )).wait();
      const fromBlock = Number(created.blockNumber);

      // One transaction per emitter, in the order a real asset would see them.
      await (await ka.updateKnowledgeAsset(
        deployer, author, kaId, 'rm-update', updateRoot,
        0, [], 2000, 0, 2,
      )).wait();                                                  // KnowledgeAssetUpdated
      await (await ka.pushMerkleRoot(deployer, kaId, pushedRoot)).wait();  // ...MerkleRootAdded
      await (await ka.setMerkleRoots(kaId, [
        [deployer, replacedRoot, 1_700_000_000n],
      ])).wait();                                                 // ...MerkleRootsUpdated
      const popped = await (await ka.popMerkleRoot(kaId)).wait();  // ...MerkleRootRemoved
      const toBlock = Number(popped.blockNumber);

      // Scan with EXACTLY the exported constant — the same list the poller
      // lane subscribes with, so a name dropped from it fails here too.
      const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
      for await (const ev of adapter.listenForEvents({
        eventTypes: [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES],
        fromBlock,
        toBlock,
      })) {
        if (ev.data['kaId'] === kaId.toString()) seen.push({ type: ev.type, data: ev.data });
      }

      expect(new Set(seen.map((e) => e.type))).toEqual(
        new Set(KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES),
      );

      const byType = new Map(seen.map((e) => [e.type, e.data]));
      for (const [type, data] of byType) {
        expect(data['kaId'], type).toBe(kaId.toString());
        expect(String(data['txHash']), type).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(String(data['blockHash']), type).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(typeof data['txIndex'], type).toBe('number');
        expect(typeof data['logIndex'], type).toBe('number');
      }

      // The root each emitter actually committed, straight off the wire.
      expect(byType.get('KnowledgeAssetUpdated')!['merkleRoot']).toBe(updateRoot);
      expect(byType.get('KnowledgeAssetMerkleRootAdded')!['merkleRoot']).toBe(pushedRoot);
      expect(byType.get('KnowledgeAssetMerkleRootRemoved')!['merkleRoot']).toBe(replacedRoot);
      // `setMerkleRoots` carries a dynamic array we deliberately never decode.
      expect('merkleRoot' in byType.get('KnowledgeAssetMerkleRootsUpdated')!).toBe(false);

      // `author` is indexed on the lifecycle update only.
      expect(String(byType.get('KnowledgeAssetUpdated')!['author']).toLowerCase())
        .toBe(author.toLowerCase());
      expect('author' in byType.get('KnowledgeAssetMerkleRootAdded')!).toBe(false);
      expect('author' in byType.get('KnowledgeAssetMerkleRootsUpdated')!).toBe(false);
      expect('author' in byType.get('KnowledgeAssetMerkleRootRemoved')!).toBe(false);
    }, 120_000);

    it('reports the deployed ABI as supporting every root-mutation event', async () => {
      const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
      await expect(
        adapter.supportsEventTypes([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]),
      ).resolves.toEqual([]);
      // Negative control — otherwise an implementation that always answered
      // "nothing missing" would pass the row above.
      await expect(
        adapter.supportsEventTypes(['KnowledgeAssetUpdated', 'NoSuchEventEverEmitted']),
      ).resolves.toEqual(['NoSuchEventEverEmitted']);
    }, 60_000);
  });
});
