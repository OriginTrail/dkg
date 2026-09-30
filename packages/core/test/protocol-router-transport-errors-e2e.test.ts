import { describe, it, expect, afterEach, vi } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import {
  ProtocolRouter,
  isProtocolUnsupportedError,
  isRecoverableSendError,
} from '../src/protocol-router.js';
import { POOLED_MESSAGE_PROTOCOL } from '../src/message-stream-pool.js';
import { classifyTransportError } from '../src/transport-error.js';
import { watchProtocolRefusal } from '../../../scripts/testing/protocol-refusal.js';

/**
 * End-to-end coverage of the typed transport-error classification: two REAL
 * libp2p nodes (TCP on loopback, real multistream-select, real yamux), each
 * with a REAL `ProtocolRouter`. No mocks of the unit under test.
 *
 * What is pinned down:
 *  - a peer that does not speak the protocol at all makes `send()` fail FAST
 *    (one dial, well inside the first 500 ms retry backoff), with libp2p's own
 *    typed `UnsupportedProtocolError`;
 *  - the in-line pooled -> one-shot wire-variant fallback still runs first,
 *    inside the same `send()`, when the peer speaks only the one-shot wire;
 *  - a peer that speaks NEITHER wire costs one pooled and one one-shot attempt;
 *  - a refusal is retried only when the caller opts in (`retryOnProtocolRefusal`,
 *    for a peer that is still booting); the late handler is registered from the
 *    sender's observation of its first refusal, not from a timer, so a slow dial
 *    cannot make that test pass without a retry;
 *  - genuinely transient failures (a stream reset by the responder, a peer
 *    that went away) are still retried with backoff.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Before the typed classification an unsupported peer cost >= 500 ms + 1000 ms of backoff. */
const FAIL_FAST_BUDGET_MS = 1_000;

function newNode(): DKGNode {
  return new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
}

async function connect(a: DKGNode, b: DKGNode): Promise<void> {
  await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
  // Let identify settle so the connection is fully usable.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

describe('ProtocolRouter typed transport errors (two real libp2p nodes)', () => {
  const nodes: DKGNode[] = [];
  const routers: ProtocolRouter[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const router of routers) await router.closePooling();
    routers.length = 0;
    for (const node of nodes) {
      if (node.isStarted) await node.stop();
    }
    nodes.length = 0;
  });

  async function pair(): Promise<{
    sender: DKGNode;
    receiver: DKGNode;
    senderRouter: ProtocolRouter;
    receiverRouter: ProtocolRouter;
  }> {
    const sender = newNode();
    const receiver = newNode();
    nodes.push(sender, receiver);
    await sender.start();
    await receiver.start();
    await connect(sender, receiver);
    const senderRouter = new ProtocolRouter(sender);
    const receiverRouter = new ProtocolRouter(receiver);
    routers.push(senderRouter, receiverRouter);
    return { sender, receiver, senderRouter, receiverRouter };
  }

  const poolingOptions = { keepaliveIntervalMs: 0, idleTimeoutMs: 0 } as const;

  it('fails fast, with one dial, against a peer that does not handle the protocol', async () => {
    const { sender, receiver, senderRouter } = await pair();
    const protocol = '/test/never-registered/1.0.0';
    const dialSpy = vi.spyOn(sender.libp2p, 'dialProtocol');

    const startedAt = Date.now();
    const failure = await senderRouter
      .send(receiver.peerId, protocol, enc.encode('hello'))
      .then(() => undefined, (err: unknown) => err);
    const elapsedMs = Date.now() - startedAt;

    // libp2p's real, typed refusal reaches the caller unchanged.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('UnsupportedProtocolError');
    expect((failure as Error).message).toMatch(/could not negotiate/i);
    expect(classifyTransportError(failure)).toBe('ProtocolUnsupported');
    expect(isProtocolUnsupportedError(failure)).toBe(true);
    expect(isRecoverableSendError(failure)).toBe(false);

    // One dial, no backoff. (Before: three dials and >= 1.5 s of backoff.)
    expect(dialSpy).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(FAIL_FAST_BUDGET_MS);
  }, 15_000);

  it('still falls back from the pooled wire to the one-shot wire inside one send()', async () => {
    const { sender, receiver, senderRouter, receiverRouter } = await pair();
    const protocol = '/test/oneshot-only/1.0.0';
    // The receiver speaks the logical protocol on the one-shot wire only.
    receiverRouter.register(protocol, async (data) => enc.encode(`echo:${dec.decode(data)}`));
    senderRouter.enablePooling(protocol, poolingOptions);
    const dialSpy = vi.spyOn(sender.libp2p, 'dialProtocol');

    const startedAt = Date.now();
    const response = await senderRouter.send(receiver.peerId, protocol, enc.encode('hello'));
    const elapsedMs = Date.now() - startedAt;

    expect(dec.decode(response)).toBe('echo:hello');
    expect(elapsedMs).toBeLessThan(FAIL_FAST_BUDGET_MS);
    // The pooled wire was tried once and refused; the peer is pinned to one-shot.
    const pooledDials = dialSpy.mock.calls.filter((call) => call[1] === POOLED_MESSAGE_PROTOCOL);
    expect(pooledDials).toHaveLength(1);
    expect(senderRouter.peerWireVariantFor(receiver.peerId, protocol)).toBe('one-shot');

    // A later send skips the pooled attempt entirely.
    const again = await senderRouter.send(receiver.peerId, protocol, enc.encode('again'));
    expect(dec.decode(again)).toBe('echo:again');
    expect(dialSpy.mock.calls.filter((call) => call[1] === POOLED_MESSAGE_PROTOCOL)).toHaveLength(1);
  }, 15_000);

  it('costs one pooled and one one-shot attempt against a peer that speaks neither wire, then fails fast', async () => {
    const { sender, receiver, senderRouter } = await pair();
    const protocol = '/test/neither-wire/1.0.0';
    senderRouter.enablePooling(protocol, poolingOptions);
    const dialSpy = vi.spyOn(sender.libp2p, 'dialProtocol');

    const startedAt = Date.now();
    const failure = await senderRouter
      .send(receiver.peerId, protocol, enc.encode('hello'))
      .then(() => undefined, (err: unknown) => err);
    const elapsedMs = Date.now() - startedAt;

    expect((failure as Error).name).toBe('UnsupportedProtocolError');
    expect(isProtocolUnsupportedError(failure)).toBe(true);
    expect(isRecoverableSendError(failure)).toBe(false);
    // The in-line fallback ran (pooled wire first), then the one-shot wire
    // failed once and the send stopped. Before: pooled + three one-shot dials.
    expect(dialSpy.mock.calls.map((call) => call[1])).toEqual([POOLED_MESSAGE_PROTOCOL, protocol]);
    expect(elapsedMs).toBeLessThan(FAIL_FAST_BUDGET_MS);
  }, 15_000);

  it('fails fast against a peer that registers the protocol only after refusing it, unless the caller opts into retrying a refusal', async () => {
    const { sender, receiverRouter, receiver, senderRouter } = await pair();
    const protocol = '/test/registers-late/1.0.0';
    let handled = 0;
    const echo = async (data: Uint8Array): Promise<Uint8Array> => {
      handled += 1;
      return enc.encode(`echo:${dec.decode(data)}`);
    };

    // Default: the refusal is final for this send().
    const failure = await senderRouter
      .send(receiver.peerId, protocol, enc.encode('one'))
      .then(() => undefined, (err: unknown) => err);
    expect((failure as Error).name).toBe('UnsupportedProtocolError');
    expect(handled).toBe(0);

    // A booting peer: multistream answers `na` until the handler is registered.
    // The handler appears only once the sender has seen its own `dialProtocol`
    // refused, never on a timer (see `watchProtocolRefusal`), so the send can
    // only get through by a retry. retryOnProtocolRefusal keeps the router's
    // in-line retry, which is what the network-identity probe uses.
    const watch = watchProtocolRefusal(sender.libp2p, protocol, () => {
      receiverRouter.register(protocol, echo);
    });
    let response: Uint8Array;
    let respondedAfterRefusalMs = 0;
    try {
      // Bounded by the send's own deadline: if the refusal is never seen the
      // handler is never registered and this rejects, it does not hang.
      response = await senderRouter
        .send(receiver.peerId, protocol, enc.encode('two'), {
          retryOnProtocolRefusal: true,
          timeoutMs: 10_000,
        })
        .catch(watch.failWithContext('send did not get through'));
      respondedAfterRefusalMs = watch.msSinceFirstRefusal();
    } finally {
      watch.dispose();
    }
    expect(dec.decode(response)).toBe('echo:two');
    // The refusal was observed, and it is what registered the handler. The one
    // refused dial ended the first attempt; the retry got through.
    expect(watch.refusedDials).toBe(1);
    expect(watch.registrations).toBe(1);
    expect(handled).toBe(1);
    // The retry waited out at least one backoff step (500 ms) after the refusal.
    expect(respondedAfterRefusalMs).toBeGreaterThanOrEqual(450);
  }, 20_000);

  it('still retries a stream the responder resets mid-send, and succeeds on the retry', async () => {
    const { receiver, senderRouter, receiverRouter } = await pair();
    const protocol = '/test/resets-once/1.0.0';
    let handled = 0;
    receiverRouter.register(protocol, async (data) => {
      handled += 1;
      // The first request kills the stream (the router aborts it on a
      // handler error, so the sender sees a real yamux stream reset).
      if (handled === 1) throw new Error('responder reset the stream');
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const startedAt = Date.now();
    const response = await senderRouter.send(receiver.peerId, protocol, enc.encode('hello'));
    const elapsedMs = Date.now() - startedAt;

    expect(dec.decode(response)).toBe('echo:hello');
    expect(handled).toBe(2);
    // The retry waited out the first backoff step (500 ms) before re-sending.
    expect(elapsedMs).toBeGreaterThanOrEqual(450);
  }, 15_000);

  it('still retries a peer that has gone away (dial refused) with the full backoff schedule', async () => {
    const { sender, receiver, senderRouter } = await pair();
    const protocol = '/test/peer-gone/1.0.0';
    const gonePeerId = receiver.peerId;
    await receiver.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dialSpy = vi.spyOn(sender.libp2p, 'dialProtocol');

    const startedAt = Date.now();
    const failure = await senderRouter
      .send(gonePeerId, protocol, enc.encode('hello'), 10_000)
      .then(() => undefined, (err: unknown) => err);
    const elapsedMs = Date.now() - startedAt;

    expect(failure).toBeInstanceOf(Error);
    expect(classifyTransportError(failure)).toBe('Transient');
    expect(isRecoverableSendError(failure)).toBe(true);
    expect(isProtocolUnsupportedError(failure)).toBe(false);
    // All three attempts ran, separated by the 500 ms + 1000 ms backoff.
    expect(dialSpy).toHaveBeenCalledTimes(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
  }, 20_000);
});
