import { describe, expect, it } from 'vitest';
import { encodeAccessResponse, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ACCESS_ERROR_CODES, accessError, isAccessError } from '../src/access-errors.js';
import { AccessClient, type AccessSendSurface } from '../src/access-client.js';

const UAL = 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0';
const result = (response: Uint8Array) => ({ delivered: true as const, response, attempts: 1, messageId: 'owned' });

async function client(send: NonNullable<AccessSendSurface['sendRequestOwned']>) {
  return new AccessClient({ sendReliable: send, sendRequestOwned: send }, await generateEd25519Keypair(), 'local-peer');
}

describe('caller-owned private access bounds', () => {
  it('recognizes declared cross-package failures and rejects unknown codes', () => {
    for (const code of ACCESS_ERROR_CODES) {
      expect(isAccessError(accessError(code, 'local detail'))).toBe(true);
      expect(isAccessError(Object.assign(new Error('other package'), { code }))).toBe(true);
      expect(isAccessError({ code })).toBe(true);
    }
    for (const error of [null, new Error('ordinary'), Object.assign(new Error('typo'), { code: 'ACCESS_TIMOUT' })]) {
      expect(isAccessError(error)).toBe(false);
    }
  });
  it('does not send an already cancelled request', async () => {
    let sends = 0;
    const access = await client(async () => { sends++; return result(new Uint8Array()); });
    const signal = AbortSignal.abort(new Error('caller ended'));
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { signal }))
      .rejects.toThrow('caller ended');
    expect(sends).toBe(0);
  });

  it('rejects bounded calls on legacy-only adapters before any send', async () => {
    let sends = 0;
    const access = new AccessClient({ sendReliable: async () => { sends++; return result(new Uint8Array()); } },
      await generateEd25519Keypair(), 'local-peer');
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { maxResponseBytes: 100 }))
      .rejects.toMatchObject({ code: 'ACCESS_REQUEST_OWNED_REQUIRED' });
    expect(sends).toBe(0);
  });
  it('ignores unrelated enumerable properties when all supported controls are undefined', async () => {
    let sends = 0;
    const denied = encodeAccessResponse({ granted: false, nquads: new Uint8Array(), privateMerkleRoot: new Uint8Array(), rejectionReason: 'denied' });
    const access = new AccessClient({ sendReliable: async () => { sends++; return result(denied); } },
      await generateEd25519Keypair(), 'local-peer');
    const options = { signal: undefined, timeoutMs: undefined, maxResponseBytes: undefined,
      maxQuads: undefined, traceId: 'read-1' };
    await expect(access.requestAccess('publisher-peer', UAL, undefined, options)).resolves.toMatchObject({ granted: false });
    expect(sends).toBe(1);
  });

  it('captures the owned send capability once and preserves its receiver across signing', async () => {
    let reads = 0;
    const denied = encodeAccessResponse({ granted: false, nquads: new Uint8Array(), privateMerkleRoot: new Uint8Array(), rejectionReason: 'denied' });
    const surface: AccessSendSurface = {
      sendReliable: async () => { throw new Error('legacy path must not run'); },
      get sendRequestOwned() {
        reads++;
        return reads === 1 ? async function (this: AccessSendSurface) {
          expect(this).toBe(surface); return result(denied);
        } : undefined;
      },
    };
    const access = new AccessClient(surface, await generateEd25519Keypair(), 'local-peer');
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { maxQuads: 1 }))
      .resolves.toMatchObject({ granted: false });
    expect(reads).toBe(1);
  });

  it('forwards deadline and cancellation, and never delivers a late response', async () => {
    const controller = new AbortController();
    let observed: unknown;
    const access = await client(async (_peer, _protocol, _payload, options) => {
      observed = options;
      controller.abort(new Error('caller ended'));
      return result(encodeAccessResponse({ granted: false, nquads: new Uint8Array(), privateMerkleRoot: new Uint8Array(), rejectionReason: 'late' }));
    });
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { signal: controller.signal, timeoutMs: 100 }))
      .rejects.toThrow('caller ended');
    expect(observed).toMatchObject({ signal: controller.signal, timeoutMs: 100 });
  });

  it('rejects oversized protocol bytes before decoding', async () => {
    const access = await client(async () => result(new Uint8Array(101)));
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { maxResponseBytes: 100 }))
      .rejects.toMatchObject({ code: 'ACCESS_RESPONSE_TOO_LARGE' });
  });

  it('bounds decoded quad count before computing the peer-root self-check', async () => {
    const response = encodeAccessResponse({ granted: true,
      nquads: new TextEncoder().encode('<urn:a> <urn:p> "a" <urn:g> .\n<urn:b> <urn:p> "b" <urn:g> .'),
      privateMerkleRoot: new Uint8Array(32).fill(1), rejectionReason: '',
    });
    const access = await client(async () => result(response));
    await expect(access.requestAccess('publisher-peer', UAL, undefined, { maxQuads: 1 }))
      .rejects.toMatchObject({ code: 'ACCESS_RESPONSE_TOO_LARGE' });
  });
});
