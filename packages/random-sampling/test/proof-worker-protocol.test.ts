import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyV10ProofMaterial } from '@origintrail-official/dkg-core';
import { proofRequest } from './helpers/proof-fixture.js';

afterEach(() => { vi.doUnmock('node:worker_threads'); vi.resetModules(); });

async function loadHandler() {
  vi.resetModules();
  let receive: ((request: unknown) => void) | undefined;
  const postMessage = vi.fn();
  vi.doMock('node:worker_threads', () => ({ parentPort: {
    on(event: string, callback: typeof receive) { expect(event).toBe('message'); receive = callback; },
    postMessage,
  } }));
  await import('../src/proof-worker-entry.js');
  expect(receive).toBeTypeOf('function');
  return { receive: receive!, postMessage };
}

describe('proof worker entry message protocol', () => {
  it.each(['catalog', 'public'] as const)('returns verifiable %s proofs with the original task id', async kind => {
    const { receive, postMessage } = await loadHandler();
    const request = proofRequest(kind);
    const before = structuredClone(request);
    receive({ ...request, taskId: 37 });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const response = postMessage.mock.calls[0][0];
    expect(response).toMatchObject({ taskId: 37, ok: true, leafCount: 3 });
    expect(verifyV10ProofMaterial(response, request.chunkId, request.expected)).toBe(true);
    expect(request).toEqual(before);
  });

  it.each(['root', 'count', 'chunk'] as const)('serializes exact %s mismatch diagnostics', async mode => {
    const { receive, postMessage } = await loadHandler();
    const request = proofRequest();
    const computedRoot = request.expected.merkleRoot;
    const wrongRoot = new Uint8Array(32).fill(255);
    if (mode === 'root') request.expected.merkleRoot = wrongRoot;
    if (mode === 'count') request.expected.merkleLeafCount = 42;
    if (mode === 'chunk') request.chunkId = 3;
    receive({ ...request, taskId: 91 });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const expected = mode === 'root'
      ? { errorName: 'V10ProofRootMismatchError', fields: { kind: 'rootMismatch', computedMerkleRoot: computedRoot, expectedMerkleRoot: wrongRoot } }
      : mode === 'count'
        ? { errorName: 'V10ProofLeafCountMismatchError', fields: { kind: 'leafCountMismatch', computedLeafCount: 3, expectedLeafCount: 42 } }
        : { errorName: 'V10ProofChunkOutOfRangeError', fields: { kind: 'chunkOutOfRange', chunkId: 3, leafCount: 3 } };
    expect(postMessage.mock.calls[0][0]).toEqual({ taskId: 91, ok: false, message: expect.any(String), ...expected });
  });

  it('returns a generic malformed-request error without losing its correlation id', async () => {
    const { receive, postMessage } = await loadHandler();
    receive({ ...proofRequest(), contents: null, taskId: 12 });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ taskId: 12, ok: false, errorName: 'Error',
      message: expect.stringContaining('map'), fields: undefined });
  });

  it('refuses to run outside a worker message port', async () => {
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({ parentPort: null }));
    await expect(import('../src/proof-worker-entry.js')).rejects.toThrow('proof-worker-entry must run inside a worker_threads worker');
  });
});
