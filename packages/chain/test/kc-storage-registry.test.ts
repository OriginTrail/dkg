/**
 * Unit tests for KCStorageRegistry (OT-RFC-40 PR-3).
 *
 * The class itself is ethers-free, so these tests use plain in-memory
 * fakes for the `KCStorageHubReader` + `KCStorageUriReader` injection
 * points rather than spinning up a real Hub via the EVM adapter.
 */
import { describe, it, expect } from 'vitest';
import {
  KCStorageRegistry,
  deriveStorageTag,
  type KCStorageEntry,
  type KCStorageHubReader,
  type KCStorageUriReader,
} from '../src/kc-storage-registry.js';

interface FakeStorage {
  hubName: string;
  address: string;
  uriBase: string | (() => Promise<never>);
}

function buildRegistry(storages: FakeStorage[], opts: { warns?: string[] } = {}) {
  const hubReader: KCStorageHubReader = {
    async getAllAssetStorages() {
      return storages.map(s => ({ name: s.hubName, addr: s.address }));
    },
  };
  const uriReader: KCStorageUriReader = {
    async readUriBase(addr: string) {
      const match = storages.find(s => s.address === addr);
      if (!match) throw new Error(`unknown storage address ${addr}`);
      if (typeof match.uriBase === 'function') return match.uriBase();
      return match.uriBase;
    },
  };
  const warns = opts.warns ?? [];
  const log = { warn: (m: string) => warns.push(m) };
  const registry = new KCStorageRegistry(hubReader, uriReader, { log });
  return { registry, warns };
}

describe('deriveStorageTag', () => {
  // The tag mapping is the precise contract for what a deployment
  // script may use for a storage's `uriBase`. These tests pin the
  // exact accept/reject set RFC §5.2 specifies.

  it('maps did:dkg → empty (default storage marker)', () => {
    expect(deriveStorageTag('did:dkg')).toBe('');
  });

  it('maps did:dkg:v9 → v9 (the V9 KAS pattern in production today)', () => {
    expect(deriveStorageTag('did:dkg:v9')).toBe('v9');
  });

  it('maps did:dkg:foo-bar → foo-bar (hyphenated tags allowed)', () => {
    expect(deriveStorageTag('did:dkg:foo-bar')).toBe('foo-bar');
  });

  it('rejects anything that does not start with did:dkg', () => {
    expect(deriveStorageTag('http://example.org')).toBeNull();
    expect(deriveStorageTag('did:web:example.org')).toBeNull();
    expect(deriveStorageTag('')).toBeNull();
  });

  it('rejects bare "did:dkg:" (empty tag after the prefix)', () => {
    expect(deriveStorageTag('did:dkg:')).toBeNull();
  });

  it('rejects tags with characters outside [a-z0-9-]', () => {
    expect(deriveStorageTag('did:dkg:V9')).toBeNull();
    expect(deriveStorageTag('did:dkg:v9.1')).toBeNull();
    expect(deriveStorageTag('did:dkg:tag with space')).toBeNull();
    expect(deriveStorageTag('did:dkg:tag/with/slash')).toBeNull();
    // Colons are forbidden because they collide with the chainId
    // segment in UAL parsing — see parseUal's disambiguation rules.
    expect(deriveStorageTag('did:dkg:base:84532')).toBeNull();
  });
});

describe('KCStorageRegistry.refresh', () => {
  const V10_KCS = {
    hubName: 'KnowledgeCollectionStorage',
    address: '0x4fCA405d46ADeDD7050420C1937842D2a36a04D8',
    uriBase: 'did:dkg',
  };
  const V9_KAS = {
    hubName: 'KnowledgeAssetsStorage',
    address: '0x45E0e14c695681c8c93d6A489a314ea1EC28ba59',
    uriBase: 'did:dkg:v9',
  };

  it('discovers two registered storages (V9 KAS + V10 KCS, the production case)', async () => {
    // Mirror of `packages/evm-module/deployments/base_sepolia_v10_contracts.json`.
    const { registry } = buildRegistry([V10_KCS, V9_KAS]);
    await registry.refresh();

    expect(registry.getDefaultAddress()).toBe(V10_KCS.address);
    expect(registry.getByTag('')!.address).toBe(V10_KCS.address);
    expect(registry.getByTag('v9')!.address).toBe(V9_KAS.address);
    expect(registry.tagFor(V10_KCS.address)).toBe('');
    expect(registry.tagFor(V9_KAS.address)).toBe('v9');
  });

  it('preserves uriBase + hubName on each entry for diagnostics', async () => {
    const { registry } = buildRegistry([V10_KCS, V9_KAS]);
    await registry.refresh();
    const v9 = registry.getByTag('v9') as KCStorageEntry;
    expect(v9).toEqual({
      hubName: 'KnowledgeAssetsStorage',
      address: V9_KAS.address,
      uriBase: 'did:dkg:v9',
      tag: 'v9',
    });
  });

  it('ignores Hub entries that are not KC-class storages', async () => {
    // Hub.getAllAssetStorages() returns every asset storage, not just
    // KC ones. The registry must skip ContextGraphStorage etc.
    const cgs = {
      hubName: 'ContextGraphStorage',
      address: '0x1111111111111111111111111111111111111111',
      uriBase: 'did:dkg',
    };
    const { registry } = buildRegistry([V10_KCS, cgs, V9_KAS]);
    await registry.refresh();
    expect(registry.getAll().map(e => e.hubName).sort()).toEqual([
      'KnowledgeAssetsStorage',
      'KnowledgeCollectionStorage',
    ]);
  });

  it('skips storages with malformed uriBase and warns once', async () => {
    const malformed = {
      hubName: 'KnowledgeCollectionStorageFuture',
      address: '0x9999999999999999999999999999999999999999',
      uriBase: 'http://nope.example.org',
    };
    const { registry, warns } = buildRegistry([V10_KCS, malformed]);
    await registry.refresh();

    expect(registry.getByAddress(malformed.address)).toBeUndefined();
    expect(registry.getDefaultAddress()).toBe(V10_KCS.address);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('malformed uriBase');
    expect(warns[0]).toContain('http://nope.example.org');
  });

  it('skips storages whose uri(0) read throws and continues with the rest', async () => {
    const broken = {
      hubName: 'KnowledgeCollectionStorageV99',
      address: '0x8888888888888888888888888888888888888888',
      uriBase: async () => { throw new Error('rpc unavailable'); },
    };
    const { registry, warns } = buildRegistry([V10_KCS, broken, V9_KAS]);
    await registry.refresh();

    expect(registry.getByAddress(broken.address)).toBeUndefined();
    expect(registry.getDefaultAddress()).toBe(V10_KCS.address);
    expect(registry.getByTag('v9')?.address).toBe(V9_KAS.address);
    expect(warns.some(w => w.includes('uri(0) read failed'))).toBe(true);
  });

  it('warns when no default storage is detected (every UAL would fail to resolve)', async () => {
    const { registry, warns } = buildRegistry([V9_KAS]);
    await registry.refresh();

    expect(registry.getDefaultAddress()).toBeUndefined();
    expect(warns.some(w => w.includes('no default KC storage'))).toBe(true);
  });

  it('handles two storages claiming the same tag by warning + using the latter', async () => {
    // This is a deployment misconfiguration; the registry must not crash.
    // Hub semantics: AssetStorageChanged overwrites, so "newer wins" is
    // the correct convergence rule.
    const dup1 = { hubName: 'KnowledgeCollectionStorage', address: '0xAAAa', uriBase: 'did:dkg' };
    const dup2 = { hubName: 'KnowledgeCollectionStorageV2', address: '0xBBBb', uriBase: 'did:dkg' };
    const { registry, warns } = buildRegistry([dup1, dup2]);
    await registry.refresh();

    expect(registry.getDefaultAddress()).toBe(dup2.address);
    expect(warns.some(w => w.includes('claimed by both'))).toBe(true);
  });

  it('replaces the previous cache atomically on subsequent refresh calls', async () => {
    // Simulate a Hub event triggering re-discovery.
    const v11 = {
      hubName: 'KnowledgeCollectionStorageV11',
      address: '0xC1C1C1C1C1C1C1C1C1C1C1C1C1C1C1C1C1C1C1C1',
      uriBase: 'did:dkg:v11',
    };
    let storages = [V10_KCS, V9_KAS];
    const hubReader: KCStorageHubReader = {
      async getAllAssetStorages() {
        return storages.map(s => ({ name: s.hubName, addr: s.address }));
      },
    };
    const uriReader: KCStorageUriReader = {
      async readUriBase(addr: string) {
        const match = storages.find(s => s.address === addr);
        if (!match) throw new Error(`unknown ${addr}`);
        return typeof match.uriBase === 'string' ? match.uriBase : '';
      },
    };
    const registry = new KCStorageRegistry(hubReader, uriReader);

    await registry.refresh();
    expect(registry.getByTag('v11')).toBeUndefined();

    // V11 deploys; Hub fires NewAssetStorage; registry refreshes.
    storages = [V10_KCS, V9_KAS, v11];
    await registry.refresh();
    expect(registry.getByTag('v11')?.address).toBe(v11.address);
  });

  it('does not throw if Hub.getAllAssetStorages() throws (RPC outage)', async () => {
    const hubReader: KCStorageHubReader = {
      async getAllAssetStorages() {
        throw new Error('rpc timeout');
      },
    };
    const uriReader: KCStorageUriReader = {
      async readUriBase() { throw new Error('unreachable'); },
    };
    const warns: string[] = [];
    const registry = new KCStorageRegistry(hubReader, uriReader, {
      log: { warn: m => warns.push(m) },
    });

    await registry.refresh();
    expect(warns.some(w => w.includes('getAllAssetStorages() failed'))).toBe(true);
    expect(registry.getDefaultAddress()).toBeUndefined();
  });

  it('returns a stable getAll() snapshot regardless of insertion order', async () => {
    const { registry } = buildRegistry([V9_KAS, V10_KCS]);
    await registry.refresh();
    const all = registry.getAll();
    expect(all.map(e => e.tag).sort()).toEqual(['', 'v9']);
  });
});

describe('KCStorageRegistry — lookup correctness on an empty registry', () => {
  // A registry that never had refresh() called should answer
  // every lookup with undefined. Important for sites that ask
  // optimistically and only fall back to a slower path on miss.
  it('returns undefined for every lookup before refresh()', () => {
    const hubReader: KCStorageHubReader = { async getAllAssetStorages() { return []; } };
    const uriReader: KCStorageUriReader = { async readUriBase() { return ''; } };
    const registry = new KCStorageRegistry(hubReader, uriReader);
    expect(registry.getByTag('')).toBeUndefined();
    expect(registry.getByTag('v9')).toBeUndefined();
    expect(registry.getByAddress('0xanything')).toBeUndefined();
    expect(registry.getDefault()).toBeUndefined();
    expect(registry.getDefaultAddress()).toBeUndefined();
    expect(registry.tagFor('0xanything')).toBeUndefined();
    expect(registry.getAll()).toEqual([]);
  });
});
