import { describe, expect, it, vi } from 'vitest';
import { AccessClient } from '@origintrail-official/dkg-publisher';
import { generateEd25519Keypair, InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore,
  encodeAccessResponse, type ProtocolRouter } from '@origintrail-official/dkg-core';
import { Messenger } from '../src/p2p/messenger.js';

const UAL = 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0';
const denied = encodeAccessResponse({ granted: false, nquads: new Uint8Array(), privateMerkleRoot: new Uint8Array(), rejectionReason: 'denied' });

it('cancels AccessClient with a real Messenger before a non-cooperative router settles', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const send = vi.fn(async () => { await blocked; throw new Error('connection closed'); });
  const outboxStore = new InMemoryProtocolOutboxStore();
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore });
  const legacy = vi.spyOn(messenger, 'sendReliable');
  const owned = vi.spyOn(messenger, 'sendRequestOwned');
  const access = new AccessClient(messenger, await generateEd25519Keypair(), 'local-peer');
  const controller = new AbortController();
  let outcome: unknown = 'pending';
  const request = access.requestAccess('publisher-peer', UAL, undefined, { signal: controller.signal, maxResponseBytes: 128 })
    .then(value => { outcome = value; }, error => { outcome = error; });
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller left'));
    await vi.waitFor(() => expect(outcome).toMatchObject({ message: 'caller left' }));
    expect(send).toHaveBeenCalledWith('publisher-peer', expect.any(String), expect.any(Uint8Array),
      expect.objectContaining({ signal: controller.signal, maxReadBytes: 128 }));
    expect(legacy).not.toHaveBeenCalled(); expect(owned).toHaveBeenCalledTimes(1);
  } finally { release(); await request; }
  await Promise.allSettled(owned.mock.results.map(result => result.value));
  expect(messenger.getOutboxStats()?.queuedEntries).toBe(0);
});

describe('legacy AccessClient compatibility', () => {
  it('keeps optionless calls on the existing sendReliable surface', async () => {
    const sendReliable = vi.fn(async () => ({ delivered: true as const, response: denied, messageId: 'legacy', attempts: 1 }));
    const access = new AccessClient({ sendReliable }, await generateEd25519Keypair(), 'local-peer');
    expect(await access.requestAccess('publisher-peer', UAL)).toMatchObject({ granted: false });
    expect(sendReliable).toHaveBeenCalledTimes(1);
  });
});
