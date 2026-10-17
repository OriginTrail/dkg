import { describe, expect, it, vi } from 'vitest';
import { AccessClient, RequestOwnedAccessClient } from '@origintrail-official/dkg-publisher';
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
  const access = new RequestOwnedAccessClient(messenger, await generateEd25519Keypair(), 'local-peer');
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

it('cancels one owned recovery wait without cancelling shared resolution or retaining its attempt', async () => {
  let release!: () => void;
  const recovery = new Promise<void>(resolve => { release = resolve; });
  let recoverySignal: AbortSignal | undefined;
  const resolvePeer = vi.fn(async (_peer: string, { signal }: { signal: AbortSignal }) => {
    recoverySignal = signal; await recovery;
  });
  const addressError = new Error('no valid addresses for peer');
  const send = vi.fn(async () => { throw addressError; });
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: new InMemoryProtocolOutboxStore(), resolvePeer });
  const controller = new AbortController(); const reason = new Error('caller left during recovery');
  let cancelled: unknown = 'pending'; let survivor: unknown = 'pending';
  const first = messenger.sendRequestOwned('publisher-peer', '/dkg/test', new Uint8Array(),
    { messageId: 'cancelled', signal: controller.signal }).catch(error => { cancelled = error; });
  const second = messenger.sendRequestOwned('publisher-peer', '/dkg/test', new Uint8Array(),
    { messageId: 'survivor' }).catch(error => { survivor = error; });
  try {
    await vi.waitFor(() => expect(resolvePeer).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await vi.waitFor(() => expect(cancelled).toBe(reason), { timeout: 150 });
    expect(survivor).toBe('pending'); expect(recoverySignal?.aborted).toBe(false);
    send.mockImplementation(async () => denied);
    await expect(messenger.sendRequestOwned('publisher-peer', '/dkg/test', new Uint8Array(),
      { messageId: 'cancelled' })).resolves.toMatchObject({ delivered: true });
    expect(send).toHaveBeenCalledTimes(3);
    expect(messenger.getOutboxStats()?.queuedEntries).toBe(0);
  } finally { release(); await Promise.all([first, second]); }
  expect(survivor).toBe(addressError);
  expect(resolvePeer).toHaveBeenCalledTimes(1);
});
