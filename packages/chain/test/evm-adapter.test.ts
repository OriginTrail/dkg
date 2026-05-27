import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { KCStorageRegistry } from '../src/kc-storage-registry.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
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
    const kav10 = await adapter.getContract('KnowledgeAssetsV10');
    expect(await kav10.name()).toBe('KnowledgeAssetsV10');

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

  it('verifyPublisherOwnsRange("v9") resolves KnowledgeAssetsStorage after init', async () => {
    // OT-RFC-40 §7.5: explicit `"v9"` tag routes to the V9 KAS
    // publisher-range API. A freshly-deployed V9 KAS has no
    // pre-reserved ranges for any address, so this returns false.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'v9');
    expect(owns).toBe(false);
  }, 30_000);

  it('verifyPublisherOwnsRange (default tag) defers to V10 ACK auth → returns true', async () => {
    // OT-RFC-40 §7.5: the V10 default storage does NOT pre-reserve
    // publisher ranges; ownership is verified at the ACK-signature
    // layer. The method returns true so V10 publishes on Hubs without
    // a V9 KAS deployment aren't silently rejected — the bug PR-5
    // calls out by name. Pre-RFC, this returned false unconditionally
    // when V9 KAS was empty.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const ownsDefault = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(ownsDefault).toBe(true);
    const ownsExplicitDefault = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, '');
    expect(ownsExplicitDefault).toBe(true);
  }, 30_000);

  it('verifyPublisherOwnsRange returns false for an unknown storage tag', async () => {
    // Conservative failure mode for a UAL minted under a tag the
    // receiver's registry doesn't recognise (e.g. a V11 storage that
    // the daemon hasn't refreshed against yet). RFC §7.5 — operators
    // see the rejection and can refresh the registry.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'nonexistent-tag');
    expect(owns).toBe(false);
  }, 30_000);

  it('verifyPublisherOwnsRange auto-routes a V11 KCS extension to ACK auth (Codex review on PR #718, Comment 2 of round 2)', async () => {
    // RFC §1 promises that future KC storage versions go live without
    // operator action. The registry derives `authMode` from `hubName`,
    // so a hypothetical `KnowledgeCollectionStorageV11` registered on
    // the Hub correctly inherits V10's `kcs-ack-based` policy and
    // returns `true` (defer to ACK gate downstream) — even though
    // there is no `tag === 'v11-future'` branch hardcoded in the EVM
    // adapter. This is the test that pins the additive-versions
    // contract.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    // Force adapter init so the registry is populated from the live Hub.
    await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    // Swap the live registry for a fake that surfaces a hypothetical
    // V11 storage. Replacing the whole registry (vs reaching into
    // private fields) is the public-API path: ChainAdapter exposes
    // `kcStorageRegistry` as a writeable field for exactly this reason.
    const fakeAddress = '0x0000000000000000000000000000000000001111';
    adapter.kcStorageRegistry = new KCStorageRegistry(
      {
        getAllAssetStorages: async () => [
          { name: 'KnowledgeCollectionStorageV11', addr: fakeAddress },
        ],
      },
      {
        readUriBase: async () => 'did:dkg:v11-future',
      },
    );
    await adapter.kcStorageRegistry.refresh();
    const v11Entry = adapter.kcStorageRegistry.getByTag('v11-future');
    expect(v11Entry?.address).toBe(fakeAddress);
    expect(v11Entry?.authMode).toBe('kcs-ack-based');
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'v11-future');
    expect(owns).toBe(true);
  }, 30_000);

  it('verifyPublisherOwnsRange fails closed for a registered tag whose authMode is unknown', async () => {
    // The registry filters incoming Hub entries by KC-class name
    // prefixes today, so an `unknown` authMode is unreachable through
    // the normal refresh path. The fallback exists to defend the
    // contract: if `KC_STORAGE_NAME_PREFIXES` ever broadens (or a
    // custom registry seeds an unknown-named entry directly), the
    // adapter must NOT silently attest range ownership. Construct
    // such a registry directly and pin the fail-closed answer.
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);

    // Bypass the registry's name-prefix filter by building one whose
    // hubReader emits an entry with an unrecognised hubName. The
    // registry's filter rejects it; we then mutate the entry into
    // place via a second registry that recognises the name. To keep
    // it simple, expose a custom registry-like object that returns
    // an entry with `authMode: 'unknown'` directly.
    adapter.kcStorageRegistry = {
      // Cast to satisfy the field type without going through the real
      // refresh machinery — this is the synthetic "registry seeded
      // out-of-band" path the unknown arm exists for.
      getByTag(tag: string) {
        if (tag === 'weird') {
          return {
            hubName: 'SomethingElseEntirely',
            address: '0x0000000000000000000000000000000000002222',
            uriBase: 'did:dkg:weird',
            tag: 'weird',
            authMode: 'unknown' as const,
          };
        }
        return undefined;
      },
      tagFor: () => undefined,
      getByAddress: () => undefined,
      getDefault: () => undefined,
      getDefaultAddress: () => undefined,
      getAll: () => [],
      refresh: async () => {},
    } as unknown as NonNullable<typeof adapter.kcStorageRegistry>;
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n, 'weird');
    expect(owns).toBe(false);
  }, 30_000);
});
