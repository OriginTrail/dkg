import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519Sign, encodeAccessResponse, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ACCESS_ERROR_CODES, accessError, isAccessError } from '../src/access-errors.js';
import { AccessClient, RequestOwnedAccessClient, type RequestOwnedAccessSendSurface } from '../src/access-client.js';

vi.mock('@origintrail-official/dkg-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, ed25519Sign: vi.fn(actual.ed25519Sign) };
});
afterEach(() => vi.mocked(ed25519Sign).mockRestore());

const UAL = 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0';
const result = (response: Uint8Array) => ({ delivered: true as const, response, attempts: 1, messageId: 'owned' });

async function client(send: RequestOwnedAccessSendSurface['sendRequestOwned']) {
  return new RequestOwnedAccessClient({ sendRequestOwned: send }, await generateEd25519Keypair(), 'local-peer');
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

  it('cancels during signing and never sends when the signer later settles', async () => {
    let release!: (signature: Uint8Array) => void;
    const signing = new Promise<Uint8Array>(resolve => { release = resolve; });
    vi.mocked(ed25519Sign).mockImplementationOnce(() => signing);
    const send = vi.fn(async () => result(new Uint8Array()));
    const access = await client(send);
    const controller = new AbortController(); const reason = new Error('cancelled while signing');
    let outcome: unknown = 'pending';
    const request = access.requestAccess('publisher-peer', UAL, undefined, { signal: controller.signal })
      .then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.waitFor(() => expect(ed25519Sign).toHaveBeenCalledTimes(1));
      controller.abort(reason);
      await vi.waitFor(() => expect(outcome).toBe(reason), { timeout: 150 });
      expect(send).not.toHaveBeenCalled();
    } finally { release(new Uint8Array(64)); await request; }
    expect(send).not.toHaveBeenCalled();
  });

  it('requires owned transport explicitly, before any send', async () => {
    let sends = 0;
    const keypair = await generateEd25519Keypair();
    const legacy = { sendReliable: async () => { sends++; return result(new Uint8Array()); } };
    expect(() => new RequestOwnedAccessClient(legacy as unknown as RequestOwnedAccessSendSurface, keypair, 'local-peer'))
      .toThrow('sendRequestOwned');
    expect(sends).toBe(0);
  });
  it('uses owned transport even without response controls, while legacy calls preserve queued denials', async () => {
    let sends = 0;
    const failure = { delivered: false as const, queued: false as const, attempts: 1, messageId: 'id', error: 'busy' };
    const owned = await client(async () => { sends++; return failure; });
    await expect(owned.requestAccess('publisher-peer', UAL)).rejects.toMatchObject({ code: 'ACCESS_UNAVAILABLE' });
    const legacy = new AccessClient({ sendReliable: async () => ({ ...failure, queued: true }) },
      await generateEd25519Keypair(), 'local-peer');
    await expect(legacy.requestAccess('publisher-peer', UAL)).resolves.toMatchObject({ granted: false, rejectionReason: 'transport: busy' });
    expect(sends).toBe(1);
  });

  it('captures the owned send capability once and preserves its receiver across signing', async () => {
    let reads = 0;
    const denied = encodeAccessResponse({ granted: false, nquads: new Uint8Array(), privateMerkleRoot: new Uint8Array(), rejectionReason: 'denied' });
    const surface: RequestOwnedAccessSendSurface = {
      get sendRequestOwned() {
        reads++;
        return reads === 1 ? async function (this: RequestOwnedAccessSendSurface) {
          expect(this).toBe(surface); return result(denied);
        } : (() => { throw new Error('must capture owned method once'); });
      },
    };
    const access = new RequestOwnedAccessClient(surface, await generateEd25519Keypair(), 'local-peer');
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
