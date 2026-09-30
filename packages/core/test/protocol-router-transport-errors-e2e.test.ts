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

type StreamOpenOutcome = 'refused' | 'opened' | 'failed';

interface ProtocolOpenWatch {
  /**
   * Every attempt to open `protocol` on a stream from the watched node, in
   * order, however the router reached it: libp2p's `dialProtocol`, or
   * `newStream` on a connection the router reuses. A refused attempt is the
   * peer's multistream `na`.
   */
  readonly opens: readonly StreamOpenOutcome[];
  /**
   * How many `libp2p.dialProtocol` calls for `protocol` rejected as a refusal.
   * That rejection is what ends a ProtocolRouter attempt: the router first
   * tries `newStream` on an open connection (a refusal there is swallowed),
   * then falls through to `dialProtocol` inside the same attempt.
   */
  readonly refusedDials: number;
  /**
   * How many stream opens had been observed when the first refused
   * `dialProtocol` ended a router attempt. One attempt can make several opens
   * (the reuse path's `newStream`, then `dialProtocol`'s own), so counting opens
   * does not count attempts; this index marks where the refused attempt ends.
   * Every open at or after it belongs to a later attempt, that is, the retry.
   */
  readonly opensAtFirstRefusedDial: number;
  dispose(): void;
}

/**
 * Observe, on the sending side, every stream the node opens for `protocol`.
 * `onFirstRefusedDial` runs once, synchronously, when a `dialProtocol` of
 * `protocol` has just been rejected as unsupported, before that rejection
 * reaches the router. Registering the peer's handler from it therefore puts the
 * handler in place after the refusal and before the router's retry, whatever
 * the timing of the dial. It must not run on the reuse path's refusal: that one
 * is followed, in the same attempt, by a `dialProtocol` the fresh handler
 * would already answer, so the attempt would succeed without any retry.
 */
function watchProtocolOpens(
  libp2p: DKGNode['libp2p'],
  protocol: string,
  onFirstRefusedDial: () => void,
): ProtocolOpenWatch {
  const opens: StreamOpenOutcome[] = [];
  let refusedDials = 0;
  let opensAtFirstRefusedDial = 0;
  const forProtocol = (protocols: unknown): boolean =>
    (Array.isArray(protocols) ? protocols : [protocols]).includes(protocol);
  const outcomeOf = (err: unknown): StreamOpenOutcome =>
    (isProtocolUnsupportedError(err) ? 'refused' : 'failed');
  const spies: Array<{ mockRestore(): void }> = [];

  const target = libp2p as unknown as {
    dialProtocol(peer: unknown, protocols: unknown, options?: unknown): Promise<unknown>;
  };
  const originalDial = target.dialProtocol.bind(target);
  spies.push(vi.spyOn(target, 'dialProtocol').mockImplementation(async (peer, protocols, options) => {
    try {
      return await originalDial(peer, protocols, options);
    } catch (err) {
      if (forProtocol(protocols) && isProtocolUnsupportedError(err)) {
        refusedDials += 1;
        if (refusedDials === 1) {
          opensAtFirstRefusedDial = opens.length;
          onFirstRefusedDial();
        }
      }
      throw err;
    }
  }));

  type WatchedConnection = {
    newStream(protocols: unknown, options?: unknown): Promise<unknown>;
  };
  const patched = new WeakSet<object>();
  const watchConnection = (connection: WatchedConnection): void => {
    if (patched.has(connection)) return;
    patched.add(connection);
    const originalNewStream = connection.newStream.bind(connection);
    spies.push(vi.spyOn(connection, 'newStream').mockImplementation(async (protocols, options) => {
      if (!forProtocol(protocols)) return originalNewStream(protocols, options);
      try {
        const stream = await originalNewStream(protocols, options);
        opens.push('opened');
        return stream;
      } catch (err) {
        opens.push(outcomeOf(err));
        throw err;
      }
    }));
  };
  for (const connection of libp2p.getConnections()) watchConnection(connection as unknown as WatchedConnection);
  const onConnectionOpen = (evt: Event): void => {
    watchConnection((evt as CustomEvent<WatchedConnection>).detail);
  };
  libp2p.addEventListener('connection:open', onConnectionOpen);

  return {
    opens,
    get refusedDials() { return refusedDials; },
    get opensAtFirstRefusedDial() { return opensAtFirstRefusedDial; },
    dispose() {
      libp2p.removeEventListener('connection:open', onConnectionOpen);
      for (const spy of spies) spy.mockRestore();
    },
  };
}

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
    // refused, never on a timer: a timer started before the send (say 700 ms)
    // lets a slow dial or an event-loop pause install the handler before the
    // first attempt, and the send then succeeds without any retry, so the test
    // would pass with the retry removed. retryOnProtocolRefusal keeps the
    // router's in-line retry, which is what the network-identity probe uses.
    let handlerRegistrations = 0;
    let refusedAt = 0;
    const watch = watchProtocolOpens(sender.libp2p, protocol, () => {
      handlerRegistrations += 1;
      refusedAt = Date.now();
      receiverRouter.register(protocol, echo);
    });
    let response: Uint8Array;
    let respondedAt = 0;
    try {
      // Bounded by the send's own deadline: if the refusal is never seen the
      // handler is never registered and this rejects, it does not hang.
      response = await senderRouter
        .send(receiver.peerId, protocol, enc.encode('two'), {
          retryOnProtocolRefusal: true,
          timeoutMs: 10_000,
        })
        .catch((err: unknown) => {
          throw new Error(
            `send did not get through (stream opens seen on the sender: [${watch.opens.join(', ')}], ` +
              `refused dials: ${watch.refusedDials}, handler registrations: ${handlerRegistrations}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        });
      respondedAt = Date.now();
    } finally {
      watch.dispose();
    }
    expect(dec.decode(response)).toBe('echo:two');
    // The refusal was observed, and it is what registered the handler.
    expect(watch.refusedDials).toBeGreaterThanOrEqual(1);
    expect(handlerRegistrations).toBe(1);
    expect(handled).toBe(1);
    // Direct retry signal. Counting opens does not count attempts (one refused
    // attempt is two refused opens: the reuse path's, then `dialProtocol`'s), so
    // split the opens at the refusal that ended the first attempt: everything
    // before it was refused, and a stream was then opened, and got through to the
    // handler registered in between, by a LATER attempt: the retry.
    const beforeRefusal = watch.opens.slice(0, watch.opensAtFirstRefusedDial);
    const afterRefusal = watch.opens.slice(watch.opensAtFirstRefusedDial);
    expect(beforeRefusal.length).toBeGreaterThanOrEqual(1);
    expect(beforeRefusal.every((outcome) => outcome === 'refused')).toBe(true);
    expect(afterRefusal.at(-1)).toBe('opened');
    // The retry waited out at least one backoff step (500 ms) after the refusal.
    expect(respondedAt - refusedAt).toBeGreaterThanOrEqual(450);
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
    expect(classifyTransportError(failure)).toBe('DialExhausted');
    expect(isRecoverableSendError(failure)).toBe(true);
    expect(isProtocolUnsupportedError(failure)).toBe(false);
    // All three attempts ran, separated by the 500 ms + 1000 ms backoff.
    expect(dialSpy).toHaveBeenCalledTimes(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
  }, 20_000);
});
