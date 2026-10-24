import { describe, expect, it } from 'vitest';
import { ContentAddressedBlobSingleFlight } from '../src/content-addressed-blob-single-flight.js';

describe('ContentAddressedBlobSingleFlight', () => {
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
