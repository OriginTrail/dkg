import { describe, expect, it, vi } from 'vitest';
import { ProtocolRouter } from '../src/protocol-router.js';

const PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const ACK_PROTOCOL = '/dkg/10.0.1/storage-ack';

describe('ProtocolRouter.probeProtocol', () => {
  it('checks live negotiation after admission without sending request bytes', async () => {
    const abort = vi.fn();
    const send = vi.fn();
    const dialProtocol = vi.fn(async () => ({ abort, send }));
    const isPeerAccepted = vi.fn(async () => true);
    const router = new ProtocolRouter({
      libp2p: { dialProtocol },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], { isPeerAccepted });

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe(true);
    expect(isPeerAccepted).toHaveBeenCalledWith(PEER_ID, ACK_PROTOCOL, 'outbound', expect.any(Object));
    expect(dialProtocol).toHaveBeenCalledWith(expect.any(Object), ACK_PROTOCOL, expect.any(Object));
    expect(abort).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not negotiate with a peer rejected by network admission', async () => {
    const dialProtocol = vi.fn();
    const router = new ProtocolRouter({
      libp2p: { dialProtocol },
      stopSignal: new AbortController().signal,
    } as unknown as ConstructorParameters<typeof ProtocolRouter>[0], {
      isPeerAccepted: async () => false,
    });

    expect(await router.probeProtocol(PEER_ID, ACK_PROTOCOL)).toBe(false);
    expect(dialProtocol).not.toHaveBeenCalled();
  });
});
