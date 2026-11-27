import { generateEd25519Keypair, InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore, TypedEventBus } from '@origintrail-official/dkg-core';
import { MessageHandler, ed25519ToX25519Private } from '@origintrail-official/dkg-agent';
import { Messenger } from '../../../agent/src/p2p/messenger.js';

/** Real encrypted sender/receiver caches; only the network hop is in-process. */
export async function encryptedSkillTransport() {
  const senderPeer = 'peer-sender', receiverPeer = 'peer-author';
  const keys = [await generateEd25519Keypair(), await generateEd25519Keypair()];
  const incoming = new Map<string, any>();
  const receiverCache = new InMemoryMessageIdempotencyStore();
  let sender: MessageHandler;
  const create = (index: number, cache: InMemoryMessageIdempotencyStore) => {
    const peer = index === 0 ? senderPeer : receiverPeer;
    const messenger = new Messenger({ router: {
      register: (_protocol: string, handler: any) => incoming.set(peer, handler),
      send: (to: string, _protocol: string, data: Uint8Array) => incoming.get(to)(data, { toString: () => peer }),
    } as any, idempotencyStore: cache, outboxStore: new InMemoryProtocolOutboxStore() });
    const handler = new MessageHandler(messenger, keys[index], ed25519ToX25519Private(keys[index].secretKey), peer, new TypedEventBus());
    handler.registerPeerKey(index === 0 ? receiverPeer : senderPeer, keys[1 - index].publicKey);
    return handler;
  };
  sender = create(0, new InMemoryMessageIdempotencyStore());
  const receiver = create(1, receiverCache);
  return {
    receiver,
    restartSender() { sender = create(0, new InMemoryMessageIdempotencyStore()); },
    send: (to: string, skillUri: string, inputData: Uint8Array, options: any) => sender.sendSkillRequest(to, { skillUri, inputData }, options),
  };
}
