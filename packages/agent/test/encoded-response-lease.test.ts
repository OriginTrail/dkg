import { describe, expect, it, vi } from 'vitest';
import { createEncodedResponseLease } from '../src/sync/responder/encoded-response-lease.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(publish?: () => Promise<void> | void) {
  const body = new Uint8Array([1, 2, 3]), metadata = new Uint8Array([4, 5]);
  const ownership = { assertCurrent: vi.fn(async () => {}), release: vi.fn(), ...(publish ? { publish: vi.fn(publish) } : {}) };
  const lease = createEncodedResponseLease({ body, metadata, plainBytes: 3, identity: 'snapshot',
    wholePayloadExports: 1, encodingDurationMs: 0 }, ownership,
  { changed: () => new Error('changed'), invalid: () => new Error('invalid') });
  return { lease, ownership, body, metadata };
}

describe('encoded response finalization ownership', () => {
  it('validates before one publication and revalidates every concurrent caller after it settles', async () => {
    const disk = deferred(), started = deferred();
    const f = fixture(() => { started.resolve(); return disk.promise; });
    const a = f.lease.assertCurrent(), b = f.lease.assertCurrent();
    await started.promise;
    expect(f.ownership.publish).toHaveBeenCalledTimes(1);
    expect(f.ownership.assertCurrent).toHaveBeenCalledTimes(2);
    disk.resolve(); await Promise.all([a, b]);
    expect(f.ownership.assertCurrent).toHaveBeenCalledTimes(4);
    await f.lease.assertCurrent();
    expect(f.ownership.publish).toHaveBeenCalledTimes(1);
    f.lease.release(); f.lease.release();
    expect(f.ownership.release).toHaveBeenCalledTimes(1);
  });
  it.each(['body', 'metadata'] as const)('rejects %s mutation while publication is pending', async (part) => {
    const disk = deferred(), started = deferred();
    const f = fixture(() => { started.resolve(); return disk.promise; });
    const check = expect(f.lease.assertCurrent()).rejects.toThrow('invalid');
    await started.promise; f[part][0] ^= 1; disk.resolve(); await check;
    f.lease.release(); expect(f.ownership.release).toHaveBeenCalledTimes(1);
  });
  it('holds physical ownership through publication after early release and refuses success', async () => {
    const disk = deferred(), started = deferred();
    const f = fixture(() => { started.resolve(); return disk.promise; });
    const check = expect(f.lease.assertCurrent()).rejects.toThrow('changed');
    await started.promise; f.lease.release(); f.lease.release();
    expect(f.ownership.release).not.toHaveBeenCalled();
    disk.resolve(); await check;
    expect(f.ownership.release).toHaveBeenCalledTimes(1);
    await expect(f.lease.assertCurrent()).rejects.toThrow('changed');
    expect(f.ownership.publish).toHaveBeenCalledTimes(1);
  });
  it('does not publish after the initial source fence fails', async () => {
    const f = fixture(() => {});
    f.ownership.assertCurrent.mockRejectedValueOnce(new Error('source changed'));
    await expect(f.lease.assertCurrent()).rejects.toThrow('source changed');
    expect(f.ownership.publish).not.toHaveBeenCalled(); f.lease.release();
  });
  it('rejects a source change during disk publication', async () => {
    const f = fixture(() => { f.ownership.assertCurrent.mockRejectedValue(new Error('source changed')); return Promise.resolve(); });
    await expect(f.lease.assertCurrent()).rejects.toThrow('source changed'); f.lease.release();
  });
  it('preserves one publication failure for later callers without retrying I/O', async () => {
    const f = fixture(() => { throw new Error('disk failed'); });
    await expect(f.lease.assertCurrent()).rejects.toThrow('disk failed');
    await expect(f.lease.assertCurrent()).rejects.toThrow('disk failed');
    expect(f.ownership.publish).toHaveBeenCalledTimes(1); f.lease.release();
  });
});
