import { describe, expect, it, vi } from 'vitest';
import { ContentAddressedBlobSingleFlight } from '../src/content-addressed-blob-single-flight.js';

describe('ContentAddressedBlobSingleFlight', () => {
  it('remembers successful immutable preparation without another disk operation', async () => {
    const createOrVerify = vi.fn(async () => {});
    const blobs = new ContentAddressedBlobSingleFlight({ createOrVerify });
    await blobs.createOrVerify('same', 'value');
    await blobs.createOrVerify('same', 'value');
    expect(createOrVerify).toHaveBeenCalledOnce();
    await expect(blobs.createOrVerify('same', 'different')).rejects.toThrow('conflicting bytes');
  });

  it('bounds completed preparations by bytes and entries and re-verifies evicted content', async () => {
    const createOrVerify = vi.fn(async () => {});
    const blobs = new ContentAddressedBlobSingleFlight({ createOrVerify, maxCachedBytes: 6, maxCachedEntries: 2 });
    await blobs.createOrVerify('a', 'aa');
    await blobs.createOrVerify('b', 'bb');
    await blobs.createOrVerify('a', 'aa'); // Refresh the older entry.
    await blobs.createOrVerify('c', 'cc');
    await blobs.createOrVerify('b', 'bb'); // Entry limit evicted b.
    expect(createOrVerify).toHaveBeenCalledTimes(4);
    await blobs.createOrVerify('large', '1234567'); // Cannot be cached.
    await blobs.createOrVerify('large', '1234567');
    await blobs.createOrVerify('d', '12345'); // Byte limit evicts a/c/b.
    await blobs.createOrVerify('b', 'bb');
    expect(createOrVerify).toHaveBeenCalledTimes(8);
  });

  it('bounds distinct physical preparations while coalescing queued duplicate content', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const createOrVerify = vi.fn(async () => held);
    const blobs = new ContentAddressedBlobSingleFlight({ createOrVerify, maxConcurrent: 2 });
    const work = ['a', 'b', 'c', 'c'].map(hash => blobs.createOrVerify(hash, hash));
    try {
      await vi.waitFor(() => expect(createOrVerify).toHaveBeenCalledTimes(2));
    } finally { release(); await Promise.all(work); }
    expect(createOrVerify).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent same-hash writes and preserves the immutable blob', async () => {
    const blobs = new Map<string, string>();
    let writes = 0;
    const singleFlight = new ContentAddressedBlobSingleFlight({
      createOrVerify: async (hash, value) => {
        writes += 1;
        blobs.set(hash, value);
      },
    });

    await Promise.all([
      singleFlight.createOrVerify('same', 'value'),
      singleFlight.createOrVerify('same', 'value'),
    ]);

    expect(writes).toBe(1);
    expect(blobs.get('same')).toBe('value');
  });

  it('fails closed when one pending hash is paired with different bytes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const singleFlight = new ContentAddressedBlobSingleFlight({
      createOrVerify: async () => blocked,
    });

    const first = singleFlight.createOrVerify('same', 'first');
    await expect(singleFlight.createOrVerify('same', 'second'))
      .rejects.toThrow(/conflicting bytes/u);
    release();
    await expect(first).resolves.toBeUndefined();
  });

  it('shares the original failure and permits a later same-hash retry', async () => {
    const diskError = new Error('simulated disk write failure');
    let attempts = 0;
    const singleFlight = new ContentAddressedBlobSingleFlight({
      createOrVerify: async () => {
        attempts += 1;
        if (attempts === 1) throw diskError;
      },
    });

    const first = singleFlight.createOrVerify('retry', 'value');
    const waiter = singleFlight.createOrVerify('retry', 'value');
    const settled = await Promise.allSettled([first, waiter]);

    expect(settled).toEqual([
      { status: 'rejected', reason: diskError },
      { status: 'rejected', reason: diskError },
    ]);
    expect(attempts).toBe(1);
    await expect(singleFlight.createOrVerify('retry', 'value')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
