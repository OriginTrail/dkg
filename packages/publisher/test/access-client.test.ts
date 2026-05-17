import { describe, it, expect, vi } from 'vitest';
import {
  PROTOCOL_ACCESS,
  decodeAccessRequest,
  decodeReliableEnvelope,
  encodeAccessResponse,
  generateEd25519Keypair,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { AccessClient } from '../src/access-client.js';
import { createSubstrateClient } from './_helpers/substrate.js';

describe('AccessClient transport wiring', () => {
  it('accepts a sendReliable surface that wraps requests in a ReliableEnvelope', async () => {
    const keypair = await generateEd25519Keypair();
    const send = vi.fn(async (_peerId: string, protocolId: string, payload: Uint8Array) => {
      expect(protocolId).toBe(PROTOCOL_ACCESS);
      const envelope = decodeReliableEnvelope(payload);
      const request = decodeAccessRequest(envelope.payload);
      expect(request.kaUal).toBe('did:dkg:test/1');
      expect(request.requesterPeerId).toBe('requester-peer');
      return encodeAccessResponse({
        granted: false,
        nquads: new Uint8Array(),
        privateMerkleRoot: new Uint8Array(),
        rejectionReason: 'denied by policy',
      });
    });

    const client = new AccessClient(
      createSubstrateClient({ send } as unknown as ProtocolRouter),
      keypair,
      'requester-peer',
    );
    const result = await client.requestAccess('publisher-peer', 'did:dkg:test/1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBe('denied by policy');
  });

  it('rejects raw ProtocolRouter.send surfaces (no durable outbox)', async () => {
    const keypair = await generateEd25519Keypair();
    expect(() => new AccessClient({ send: async () => new Uint8Array() } as any, keypair, 'requester-peer'))
      .toThrow('AccessClient requires a Messenger sendReliable surface');
  });

  it('throws queued transport failures instead of reporting access denial', async () => {
    const keypair = await generateEd25519Keypair();
    const client = new AccessClient(
      {
        async sendReliable() {
          return {
            delivered: false as const,
            queued: true as const,
            attempts: 1,
            messageId: 'msg-1',
            error: 'ECONNRESET',
          };
        },
      },
      keypair,
      'requester-peer',
    );

    await expect(client.requestAccess('publisher-peer', 'did:dkg:test/1'))
      .rejects.toThrow('Access transport queued: ECONNRESET');
  });
});

describe('createSubstrateClient test helper', () => {
  it('queues recoverable router errors', async () => {
    const send = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = createSubstrateClient({ send } as unknown as ProtocolRouter);

    const result = await client.sendReliable('peer', PROTOCOL_ACCESS, new Uint8Array([1]));

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('ECONNRESET');
  });

  it('rethrows non-recoverable router errors', async () => {
    const send = vi.fn(async () => {
      throw new Error('invalid payload');
    });
    const client = createSubstrateClient({ send } as unknown as ProtocolRouter);

    await expect(client.sendReliable('peer', PROTOCOL_ACCESS, new Uint8Array([1])))
      .rejects.toThrow('invalid payload');
  });
});
