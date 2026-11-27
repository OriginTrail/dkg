// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipBounded, gunzipBounded, BoundedGzipLimitError, BoundedGzipCapacityError } from '../src/bounded-gzip.js';
const profile = { maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 5_000 };
describe('physically bounded async gzip', () => {
  it('round trips unchanged RDF bytes', async () => {
    const bytes = new TextEncoder().encode('<urn:s> <urn:p> "hello" <urn:g> .\n'.repeat(10_000));
    const compressed = await gzipBounded(bytes, profile);
    expect(compressed.byteLength).toBeLessThan(bytes.byteLength / 10);
    expect(await gunzipBounded(compressed, { ...profile, maxOutputLines: 10_000 })).toEqual(bytes);
  });
  it('rejects compressed input and inflated output over their independent caps', async () => {
    const bomb = gzipSync(Buffer.alloc(100_000, 97));
    await expect(gunzipBounded(bomb, { ...profile, maxOutputBytes: 1_024 })).rejects.toBeInstanceOf(BoundedGzipLimitError);
    await expect(gunzipBounded(bomb, { ...profile, maxInputBytes: 10 })).rejects.toMatchObject({ dimension: 'input-bytes' });
  });
  it('enforces row bounds across output chunks and an unterminated final row', async () => {
    const bytes = Buffer.from('x\n'.repeat(100_000) + 'last');
    await expect(gunzipBounded(gzipSync(bytes), { ...profile, maxOutputLines: 100_000 }))
      .rejects.toMatchObject({ dimension: 'output-lines' });
  });
  it('refuses malformed/truncated/trailing gzip instead of returning a prefix', async () => {
    const gzip = gzipSync(Buffer.from('RDF\n'));
    for (const bytes of [gzip.subarray(0, gzip.length - 1), Buffer.concat([gzip, Buffer.from('junk')]), Buffer.from('not gzip')]) {
      await expect(gunzipBounded(bytes, profile)).rejects.toThrow();
    }
  });
  it('propagates owner cancellation, drains the native flight, and permits the subsequent caller', async () => {
    const owner = new AbortController(); const reason = new Error('retired exact fetch');
    const pending = gzipBounded(randomBytes(4 * 1024 * 1024), { ...profile, signal: owner.signal });
    owner.abort(reason); await expect(pending).rejects.toBe(reason);
    const bytes = Buffer.from('after\n');
    expect(await gunzipBounded(await gzipBounded(bytes, profile), profile)).toEqual(new Uint8Array(bytes));
    await expect(gzipBounded(bytes, { ...profile, signal: owner.signal })).rejects.toBe(reason);
  });
  it('fails local excess capacity before dispatch, then retires every accepted codec', async () => {
    const bytes = randomBytes(4 * 1024 * 1024);
    const runs = Array.from({ length: 8 }, () => gzipBounded(bytes, profile));
    const results = await Promise.allSettled(runs);
    expect(results.filter(result => result.status === 'rejected'
      && result.reason instanceof BoundedGzipCapacityError).length).toBeGreaterThan(0);
    expect(await gzipBounded(Buffer.from('again'), profile)).toBeInstanceOf(Uint8Array);
  });
  it('rejects after its bounded deadline while draining the pending chunk', async () => {
    await expect(gzipBounded(randomBytes(16 * 1024 * 1024), { ...profile, timeoutMs: 1 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
