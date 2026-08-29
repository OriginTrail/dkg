import { describe, expect, it } from 'vitest';
import { ContentAddressedBlobLeaseManager } from '../src/content-addressed-blob-lease-manager.js';

describe('ContentAddressedBlobLeaseManager', () => {
  it('creates once for concurrent users and preserves a committed blob', async () => {
    const blobs = new Map<string, string>();
    let creates = 0;
    const manager = new ContentAddressedBlobLeaseManager({
      createOrVerify: async (hash, value) => {
        const existing = blobs.get(hash);
        if (existing !== undefined) {
          expect(existing).toBe(value);
          return false;
        }
        creates += 1;
        blobs.set(hash, value);
        return true;
      },
    });
    const first = manager.createScope();
    const second = manager.createScope();

    await Promise.all([
      manager.acquire('same', 'value', first),
      manager.acquire('same', 'value', second),
    ]);
    await manager.release(first);
    await manager.release(second);

    expect(creates).toBe(1);
    expect(blobs.get('same')).toBe('value');
  });

  it('retains a blob created by a losing writer for reference-aware garbage collection', async () => {
    const blobs = new Map<string, string>();
    const manager = new ContentAddressedBlobLeaseManager({
      createOrVerify: async (hash, value) => {
        const created = !blobs.has(hash);
        blobs.set(hash, value);
        return created;
      },
    });
    const scope = manager.createScope();

    await manager.acquire('loser', 'value', scope);
    await manager.release(scope);

    expect(blobs.get('loser')).toBe('value');
  });

  it('does not let one manager delete a hash preserved by another manager', async () => {
    const blobs = new Map<string, string>();
    const options = {
      createOrVerify: async (hash, value) => {
        const created = !blobs.has(hash);
        blobs.set(hash, value);
        return created;
      },
    };
    const losingManager = new ContentAddressedBlobLeaseManager(options);
    const winningManager = new ContentAddressedBlobLeaseManager(options);
    const losing = losingManager.createScope();
    const winning = winningManager.createScope();

    await losingManager.acquire('shared', 'value', losing);
    await winningManager.acquire('shared', 'value', winning);
    await winningManager.release(winning);
    await losingManager.release(losing);

    expect(blobs.get('shared')).toBe('value');
  });

  it('rejects double release and cross-manager scope use without corrupting leases', async () => {
    const blobs = new Map<string, string>();
    const options = {
      createOrVerify: async (hash: string, value: string) => {
        const created = !blobs.has(hash);
        blobs.set(hash, value);
        return created;
      },
    };
    const owner = new ContentAddressedBlobLeaseManager(options);
    const stranger = new ContentAddressedBlobLeaseManager(options);
    const scope = owner.createScope();
    await owner.acquire('owned', 'value', scope);

    await expect(stranger.acquire('owned', 'value', scope))
      .rejects.toThrow(/different manager/);
    await owner.release(scope);
    await expect(owner.release(scope)).rejects.toThrow(/already been released/);
    await expect(owner.acquire('owned', 'value', scope)).rejects.toThrow(/already been released/);
    expect(blobs.get('owned')).toBe('value');
  });
});
