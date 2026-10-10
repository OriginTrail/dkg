import { vi } from 'vitest';

/**
 * The one method of libp2p's `Libp2p` this helper wraps, over the peer, options
 * and result types of its signature. `watchProtocolRefusal` infers all three
 * from the host it is given: a real node (`Libp2p['dialProtocol']` is
 * `(DialTarget, string | string[], DialProtocolOptions?) => Promise<Stream>`)
 * passes with no cast and no type arguments, and a test's own fake host is
 * called through the same signature the wrapper forwards. They are type
 * parameters, not libp2p's types, because this file must not import libp2p: the
 * repo root, where `scripts/testing` lives, does not resolve it.
 */
export interface DialProtocolHost<Peer, Options, Result> {
  dialProtocol: (peer: Peer, protocols: string | string[], options?: Options) => Promise<Result>;
}

export interface ProtocolRefusalWatch {
  /** How many dials offering only `protocol` were rejected as a refusal so far. */
  readonly refusedDials: number;
  /** How many times `onFirstRefusal` ran: 0 before the first refusal, 1 after it, never more. */
  readonly registrations: number;
  /** Milliseconds since the first refusal was observed; throws if none was. */
  msSinceFirstRefusal(): number;
  /**
   * For `.catch(...)` on the awaited work: rethrows the rejection with what the
   * watch saw, so a refusal that was never observed (the handler never gets
   * registered, the work rejects at its own deadline) reads as that.
   */
  failWithContext(what: string): (err: unknown) => never;
  dispose(): void;
}

/** libp2p's multistream-select `na`, matched by name as `classifyTransportError` does. */
function isProtocolRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'UnsupportedProtocolError';
}

function offersOnly(protocols: string | string[], protocol: string): boolean {
  return protocols === protocol || (Array.isArray(protocols) && protocols.length === 1 && protocols[0] === protocol);
}

/**
 * Register a booting peer's handler from the observation of the first refusal,
 * never from a timer.
 *
 * A timer started before the dial (say 700 ms) lets a slow dial or an
 * event-loop pause install the handler before the first attempt, and the send
 * then succeeds without any retry: the test would pass with the retry removed.
 *
 * `onFirstRefusal` runs once, synchronously, when a `libp2p.dialProtocol` that
 * offers only `protocol` has just been rejected as unsupported, before that
 * rejection reaches `ProtocolRouter`. The router ends an attempt at that
 * rejection (its connection-reuse `newStream` runs before `dialProtocol`, and a
 * refusal there is swallowed, which is why this hooks the dial and not the
 * stream open), and a send that then fails fast rejects. So a send, or a probe,
 * that goes through after the callback ran can only have done so on a LATER
 * attempt: the router's retry of a refusal (`retryOnProtocolRefusal`).
 *
 * The registration is guarded to the first refusal: two probes sharing one
 * in-flight attempt, or a refusal on each of several attempts, register the
 * handler once. Only dials offering exactly `protocol` count, so a dial for
 * another protocol (the pooled wire variant of the same logical protocol, whose
 * refusal the router answers with an in-line fallback inside the same send)
 * never fires it.
 */
export function watchProtocolRefusal<Peer, Options, Result>(
  host: DialProtocolHost<Peer, Options, Result>,
  protocol: string,
  onFirstRefusal: () => void,
): ProtocolRefusalWatch {
  let refusedDials = 0;
  let registrations = 0;
  let firstRefusalAt: number | undefined;
  const dial = host.dialProtocol.bind(host);
  const spy = vi.spyOn(host, 'dialProtocol').mockImplementation(async (peer, protocols, options) => {
    try {
      return await dial(peer, protocols, options);
    } catch (err) {
      if (offersOnly(protocols, protocol) && isProtocolRefusal(err)) {
        refusedDials += 1;
        if (refusedDials === 1) {
          firstRefusalAt = Date.now();
          registrations += 1;
          onFirstRefusal();
        }
      }
      throw err;
    }
  });
  return {
    get refusedDials() { return refusedDials; },
    get registrations() { return registrations; },
    msSinceFirstRefusal() {
      if (firstRefusalAt === undefined) throw new Error(`no refusal of ${protocol} was observed`);
      return Date.now() - firstRefusalAt;
    },
    failWithContext(what) {
      return (err) => {
        throw new Error(
          `${what} (refused dials: ${refusedDials}, handler registrations: ${registrations}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      };
    },
    dispose() {
      spy.mockRestore();
    },
  };
}
