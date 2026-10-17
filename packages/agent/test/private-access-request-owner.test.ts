import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAccessResponse, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { computePrivateRootV10 } from '@origintrail-official/dkg-publisher';
import { requestOwnedPrivateAccess } from '../src/private-access-request.js';

const PEER = '12D3KooWCUmtMdmJuxp2YsJya4JASgt4tf7VeKAFrA4NZ415q2RS';
const input = { publisherPeerId: PEER, kaUal: 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0' };
const quads = [{ subject: 'urn:a', predicate: 'urn:p', object: '"private"', graph: '' }];
const good = encodeAccessResponse({ granted: true,
  nquads: new TextEncoder().encode('<urn:a> <urn:p> "private" .'),
  privateMerkleRoot: computePrivateRootV10(quads)!, rejectionReason: '',
});
async function fixture(response = good) {
  const stop = new AbortController();
  const sendRequestOwned = vi.fn(async () => ({ delivered: true as const, response, attempts: 1, messageId: 'owned' }));
  const owner = { peerId: PEER, wallet: { keypair: await generateEd25519Keypair() },
    node: { stopSignal: stop.signal }, messenger: { sendRequestOwned } };
  return { owner: owner as unknown as Parameters<typeof requestOwnedPrivateAccess>[0], stop, sendRequestOwned };
}
afterEach(() => vi.useRealTimers());

describe('bounded private access owner', () => {
  it('labels a self-consistent peer payload without asserting any chain anchor', async () => {
    const f = await fixture();
    expect(await requestOwnedPrivateAccess(f.owner, input)).toMatchObject({
      granted: true, quads, storedInGraph: false,
      verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false },
    });
    expect(f.sendRequestOwned).toHaveBeenCalledWith(PEER, expect.any(String), expect.any(Uint8Array),
      expect.objectContaining({ recoverPeerAfterFailure: false, signal: expect.any(AbortSignal), maxReadBytes: 1024 * 1024 }));
  });
  it('refuses tampered content instead of returning its quads', async () => {
    const f = await fixture(encodeAccessResponse({ granted: true,
      nquads: new TextEncoder().encode('<urn:a> <urn:p> "tampered" .'),
      privateMerkleRoot: computePrivateRootV10(quads)!, rejectionReason: '',
    }));
    await expect(requestOwnedPrivateAccess(f.owner, input)).rejects.toMatchObject({ code: 'ACCESS_INTEGRITY_FAILED' });
  });
  it('does not return unverified rootless payloads', async () => {
    const f = await fixture(encodeAccessResponse({ granted: true,
      nquads: new TextEncoder().encode('<urn:a> <urn:p> "private" .'),
      privateMerkleRoot: new Uint8Array(), rejectionReason: '',
    }));
    await expect(requestOwnedPrivateAccess(f.owner, input)).rejects.toMatchObject({ code: 'ACCESS_INTEGRITY_FAILED' });
  });
  it('does not propagate peer rejection text or content', async () => {
    const f = await fixture(encodeAccessResponse({ granted: false, nquads: new TextEncoder().encode('private detail'),
      privateMerkleRoot: new Uint8Array(), rejectionReason: 'untrusted detail',
    }));
    expect(await requestOwnedPrivateAccess(f.owner, input)).toEqual({
      granted: false, quads: [], storedInGraph: false,
      verification: { kind: 'not-checked', matches: false, chainAnchored: false },
    });
  });
  it('ends at its deadline even when a transport does not settle', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.sendRequestOwned.mockImplementation(() => new Promise(() => {}));
    const outcome = requestOwnedPrivateAccess(f.owner, input).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toMatchObject({ code: 'ACCESS_TIMEOUT' });
  });
  it('bounds concurrent requests and releases the slot after cancellation', async () => {
    const f = await fixture();
    const caller = new AbortController();
    f.sendRequestOwned.mockImplementationOnce(() => new Promise(() => {}));
    const first = requestOwnedPrivateAccess(f.owner, input, { signal: caller.signal }).catch(error => error);
    await vi.waitFor(() => expect(f.sendRequestOwned).toHaveBeenCalledTimes(1));
    await expect(requestOwnedPrivateAccess(f.owner, input)).rejects.toMatchObject({ code: 'ACCESS_BUSY' });
    expect(f.sendRequestOwned).toHaveBeenCalledTimes(1);
    caller.abort(new Error('left'));
    expect(await first).toMatchObject({ message: 'left' });
    expect(await requestOwnedPrivateAccess(f.owner, input)).toMatchObject({ granted: true });
  });
  it('cancels on node stop and ignores a late successful payload', async () => {
    const f = await fixture();
    f.sendRequestOwned.mockImplementation(async () => {
      f.stop.abort();
      return { delivered: true as const, response: good, attempts: 1, messageId: 'late' };
    });
    await expect(requestOwnedPrivateAccess(f.owner, input)).rejects.toMatchObject({ code: 'ACCESS_UNAVAILABLE' });
  });
  it('rejects an already disconnected caller without sending', async () => {
    const f = await fixture();
    await expect(requestOwnedPrivateAccess(f.owner, input, { signal: AbortSignal.abort(new Error('gone')) }))
      .rejects.toThrow('gone');
    expect(f.sendRequestOwned).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, publisherPeerId: 'https://unrelated.example/' },
    { ...input, kaUal: 'did:dkg:invalid' },
    { ...input, paymentProof: 'unsupported' },
  ])('rejects malformed selectors before transport', async selector => {
    const f = await fixture();
    await expect(requestOwnedPrivateAccess(f.owner, selector)).rejects.toMatchObject({ code: 'ACCESS_INVALID_REQUEST' });
    expect(f.sendRequestOwned).not.toHaveBeenCalled();
  });
});
