import { describe, expect, it } from 'vitest';
import { ContentAddressedBlobLeaseManager } from '../src/content-addressed-blob-lease-manager.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ContentAddressedBlobLeaseManager', () => {
  it('creates once for concurrent users and preserves a committed blob', async () => {
    const blobs = new Map<string, string>();
    let creates = 0;
    let removes = 0;
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
      remove: async (hash) => {
        removes += 1;
        blobs.delete(hash);
      },
    });
    const first = manager.createScope();
    const second = manager.createScope();

    await Promise.all([
      manager.acquire('same', 'value', first),
      manager.acquire('same', 'value', second),
    ]);
    await manager.release(first, false);
    await manager.release(second, true);

    expect(creates).toBe(1);
    expect(removes).toBe(0);
    expect(blobs.get('same')).toBe('value');
  });

  it('reclaims a blob created only for a losing writer', async () => {
    const blobs = new Map<string, string>();
    const manager = new ContentAddressedBlobLeaseManager({
      createOrVerify: async (hash, value) => {
        const created = !blobs.has(hash);
        blobs.set(hash, value);
        return created;
      },
      remove: async (hash) => { blobs.delete(hash); },
    });
    const scope = manager.createScope();

    await manager.acquire('loser', 'value', scope);
    await manager.release(scope, false);

    expect(blobs.has('loser')).toBe(false);
  });

  it('serializes a new writer behind losing-writer cleanup and recreates the blob', async () => {
    const blobs = new Map<string, string>();
    const removalStarted = deferred();
    const allowRemoval = deferred();
    let creates = 0;
    const manager = new ContentAddressedBlobLeaseManager({
      createOrVerify: async (hash, value) => {
        const created = !blobs.has(hash);
        if (created) creates += 1;
        blobs.set(hash, value);
        return created;
      },
      remove: async (hash) => {
        removalStarted.resolve();
        await allowRemoval.promise;
        blobs.delete(hash);
      },
    });
    const losing = manager.createScope();
    await manager.acquire('race', 'value', losing);
    const losingRelease = manager.release(losing, false);
    await removalStarted.promise;

    const winner = manager.createScope();
    const winningAcquire = manager.acquire('race', 'value', winner);
    allowRemoval.resolve();
    await Promise.all([losingRelease, winningAcquire]);
    await manager.release(winner, true);

    expect(creates).toBe(2);
    expect(blobs.get('race')).toBe('value');
  });

  it('rejects double release and cross-manager scope use without corrupting leases', async () => {
    const blobs = new Map<string, string>();
    const options = {
      createOrVerify: async (hash: string, value: string) => {
        const created = !blobs.has(hash);
        blobs.set(hash, value);
        return created;
      },
      remove: async (hash: string) => { blobs.delete(hash); },
    };
    const owner = new ContentAddressedBlobLeaseManager(options);
    const stranger = new ContentAddressedBlobLeaseManager(options);
    const scope = owner.createScope();
    await owner.acquire('owned', 'value', scope);

    await expect(stranger.acquire('owned', 'value', scope))
      .rejects.toThrow(/different manager/);
    await owner.release(scope, true);
    await expect(owner.release(scope, false)).rejects.toThrow(/already been released/);
    await expect(owner.acquire('owned', 'value', scope)).rejects.toThrow(/already been released/);
    expect(blobs.get('owned')).toBe('value');
  });
});
