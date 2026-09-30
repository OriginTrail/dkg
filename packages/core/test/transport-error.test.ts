import { describe, it, expect } from 'vitest';
import {
  AbortError,
  ConnectionClosedError,
  ConnectionClosingError,
  ConnectionFailedError,
  DialError,
  InvalidMessageError,
  MuxerClosedError,
  StreamAbortedError,
  StreamResetError,
  StreamStateError,
  TimeoutError,
  UnsupportedProtocolError,
} from '@libp2p/interface';
import {
  classifyTransportError,
  isProtocolUnsupportedError,
  isRecoverableSendError,
  isRetryableLaterSendError,
  type TransportErrorCategory,
} from '../src/transport-error.js';
import * as coreIndex from '../src/index.js';
import { PooledStreamResetError } from '../src/message-stream-pool.js';

/**
 * The substring classifiers exactly as they were before the typed transport
 * error model (`protocol-router.ts` at the base commit). They are the ORACLE
 * for "nothing changed except what was meant to change".
 */
function legacyIsRecoverableSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('closed') ||
    msg.includes('reset') ||
    msg.includes('stream returned in closed state') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('send timeout') ||
    msg.includes('operation timed out') ||
    msg.includes('operation was aborted due to timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('aborted') ||
    msg.includes('no valid addresses') ||
    (msg.includes('sync responder') &&
      (msg.includes('queue full') ||
        msg.includes('queue wait exceeded'))) ||
    msg.includes('all multiaddr dials failed') ||
    msg.includes('no_reservation') ||
    msg.includes('no reservation') ||
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate')
  );
}

function legacyIsProtocolUnsupportedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate') ||
    msg.includes('unsupported protocol') ||
    msg.includes('protocol mismatch')
  );
}

/** A named stand-in for a libp2p error class the package does not export (`libp2p` `NoValidAddressesError`). */
function named(name: string, message: string, extra: object = {}): Error {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, extra);
}

/**
 * By default a row's verdicts must equal the old substring classifiers, except
 * that a refusal is no longer recoverable. The two intended exceptions:
 *
 * - `typed`: a typed transient name whose wording the old list did not
 *   recognise is now recoverable because of what it is, not how it is worded.
 * - `refusalWording`: a refusal worded only "unsupported protocol" /
 *   "protocol mismatch" was never retried by the old recoverable list (libp2p
 *   3.x never emits those wordings; multistream-select says "could not
 *   negotiate"). `isRetryableLaterSendError` treats every refusal alike.
 */
interface Row {
  label: string;
  err: unknown;
  category: TransportErrorCategory;
  change?: 'typed';
  refusalWording?: true;
}

const rows: Row[] = [
  // --- the peer refuses the protocol ---------------------------------------
  { label: 'libp2p UnsupportedProtocolError (real wording)', err: new UnsupportedProtocolError('Protocol selection failed - could not negotiate /dkg/10.0.1/message'), category: 'ProtocolUnsupported' },
  { label: 'libp2p UnsupportedProtocolError (default wording)', err: new UnsupportedProtocolError(), category: 'ProtocolUnsupported', refusalWording: true },
  { label: 'plain Error, multistream wording', err: new Error('protocol selection failed: foo'), category: 'ProtocolUnsupported' },
  { label: 'plain Error, could not negotiate', err: new Error('Could not negotiate /dkg/10.0.2/message'), category: 'ProtocolUnsupported' },
  { label: 'plain Error, unsupported protocol', err: new Error('Unsupported protocol'), category: 'ProtocolUnsupported', refusalWording: true },
  { label: 'plain Error, protocol mismatch', err: new Error('Protocol mismatch'), category: 'ProtocolUnsupported', refusalWording: true },
  { label: 'bare string refusal', err: 'protocol selection failed', category: 'ProtocolUnsupported' },
  { label: 'reset-named error whose text says could not negotiate', err: new StreamResetError('could not negotiate /dkg/x'), category: 'ProtocolUnsupported' },
  { label: 'pooled reset wrapping the refusal text verbatim', err: new PooledStreamResetError('Protocol selection failed - could not negotiate /dkg/10.0.2/message'), category: 'ProtocolUnsupported' },

  // --- transient transport failures: unchanged -----------------------------
  { label: 'StreamResetError (default)', err: new StreamResetError(), category: 'ConnectionReset' },
  { label: 'ConnectionClosedError (default)', err: new ConnectionClosedError(), category: 'ConnectionReset' },
  { label: 'MuxerClosedError (default)', err: new MuxerClosedError(), category: 'ConnectionReset' },
  { label: 'StreamAbortedError (default)', err: new StreamAbortedError(), category: 'Aborted' },
  { label: 'AbortError (default)', err: new AbortError(), category: 'Aborted' },
  { label: 'NoValidAddressesError (real wording)', err: named('NoValidAddressesError', 'The dial request has no valid addresses for peer: 12D3KooW...'), category: 'DialExhausted' },
  { label: 'AggregateError from the dial queue', err: new AggregateError([new Error('a'), new Error('b')], 'All multiaddr dials failed'), category: 'DialExhausted' },
  { label: 'dialProtocol-prefixed dial exhaustion', err: new Error('dialProtocol(/dkg/10.0.1/message): All multiaddr dials failed'), category: 'DialExhausted' },
  { label: 'relay NO_RESERVATION (InvalidMessageError)', err: new InvalidMessageError('failed to connect via relay with status NO_RESERVATION'), category: 'NoReservation' },
  { label: 'no reservation for relay', err: new Error('no reservation for relay'), category: 'NoReservation' },
  { label: 'ECONNREFUSED', err: new Error('connect ECONNREFUSED 127.0.0.1:1'), category: 'DialExhausted' },
  { label: 'ECONNRESET', err: new Error('read ECONNRESET'), category: 'ConnectionReset' },
  { label: 'EPIPE', err: new Error('write EPIPE'), category: 'ConnectionReset' },
  { label: 'ETIMEDOUT', err: new Error('connect ETIMEDOUT'), category: 'Timeout' },
  { label: 'send timeout', err: new Error('send timeout'), category: 'Timeout' },
  { label: 'operation timed out', err: new Error('operation timed out'), category: 'Timeout' },
  { label: 'AbortSignal.timeout wording', err: new Error('The operation was aborted due to timeout'), category: 'Timeout' },
  { label: 'stream returned in closed state', err: new Error('stream returned in closed state'), category: 'ConnectionReset' },
  { label: 'Remote closed connection during opening', err: new Error('Remote closed connection during opening'), category: 'ConnectionReset' },
  { label: 'peer-closed-stream', err: new Error('peer-closed-stream'), category: 'ConnectionReset' },
  { label: 'sync responder queue full', err: new Error('sync responder queue full'), category: 'ResponderBusy' },
  { label: 'sync responder peer queue full', err: new Error('sync responder peer queue full'), category: 'ResponderBusy' },
  { label: 'sync responder queue wait exceeded', err: new Error('sync responder queue wait exceeded'), category: 'ResponderBusy' },
  { label: 'PooledStreamResetError (request timeout)', err: new PooledStreamResetError('request timeout'), category: 'PooledStreamReset' },
  { label: 'PooledStreamResetError (pool closed)', err: new PooledStreamResetError('pool closed'), category: 'PooledStreamReset' },
  { label: 'PooledStreamResetError wrapping an unrecognised error', err: new PooledStreamResetError('handler error', { cause: new Error('handler error') }), category: 'PooledStreamReset' },
  { label: 'PooledStreamResetError wrapping a StreamResetError', err: new PooledStreamResetError('write failed', { cause: new StreamResetError() }), category: 'ConnectionReset' },
  { label: 'PooledStreamResetError wrapping a timeout', err: new PooledStreamResetError('open failed', { cause: new Error('operation timed out') }), category: 'Timeout' },

  // --- not retryable: unchanged --------------------------------------------
  { label: 'sync snapshot limit', err: new Error('sync responder snapshot limit exceeded (active=128/128)'), category: 'Unknown' },
  { label: 'Read limit exceeded', err: new Error('Read limit exceeded'), category: 'Unknown' },
  { label: 'handler error', err: new Error('handler error'), category: 'Unknown' },
  { label: 'Invalid payload', err: new Error('Invalid payload'), category: 'Unknown' },
  { label: 'InvalidMessageError with unrelated text', err: new InvalidMessageError('bad frame'), category: 'Unknown' },
  { label: 'libp2p TimeoutError (default) — left as before', err: new TimeoutError(), category: 'Unknown' },
  { label: 'libp2p tcp connection timeout — left as before', err: new TimeoutError('Connection timeout after 5000ms'), category: 'Unknown' },
  { label: 'StreamStateError (closing) — left as before', err: new StreamStateError('Cannot write to a stream that is closing'), category: 'Unknown' },
  { label: 'ConnectionClosingError — left as before', err: new ConnectionClosingError(), category: 'Unknown' },
  { label: 'ConnectionFailedError — left as before', err: new ConnectionFailedError(), category: 'Unknown' },
  { label: 'DialError (dial self) — left as before', err: new DialError('Tried to dial self'), category: 'Unknown' },
  { label: 'AbortError with a caller reason — left to its wording', err: new AbortError('caller cancelled'), category: 'Unknown' },
  { label: 'null', err: null, category: 'Unknown' },
  { label: 'undefined', err: undefined, category: 'Unknown' },
  { label: 'number', err: 42, category: 'Unknown' },
  { label: 'empty object', err: {}, category: 'Unknown' },

  // --- typed names: wording no longer decides ------------------------------
  { label: 'StreamResetError, reworded', err: new StreamResetError('remote went away'), category: 'ConnectionReset', change: 'typed' },
  { label: 'ConnectionClosedError, reworded', err: new ConnectionClosedError('gone'), category: 'ConnectionReset', change: 'typed' },
  { label: 'MuxerClosedError, reworded', err: new MuxerClosedError('gone'), category: 'ConnectionReset', change: 'typed' },
  { label: 'StreamAbortedError, reworded', err: new StreamAbortedError('gone'), category: 'Aborted', change: 'typed' },
  { label: 'NoValidAddressesError, reworded', err: named('NoValidAddressesError', 'nowhere to dial'), category: 'DialExhausted', change: 'typed' },
];

describe('classifyTransportError', () => {
  for (const row of rows) {
    it(`${row.label} -> ${row.category}`, () => {
      expect(classifyTransportError(row.err)).toBe(row.category);
    });
  }

  it('is exported from the package entry point', () => {
    expect(coreIndex.classifyTransportError).toBe(classifyTransportError);
    expect(coreIndex.isRecoverableSendError).toBe(isRecoverableSendError);
    expect(coreIndex.isProtocolUnsupportedError).toBe(isProtocolUnsupportedError);
    expect(coreIndex.isRetryableLaterSendError).toBe(isRetryableLaterSendError);
  });

  it('classifies by error name, not instanceof (a lookalike from another copy of libp2p still counts)', () => {
    const foreign = named('UnsupportedProtocolError', 'no such protocol');
    expect(foreign).not.toBeInstanceOf(UnsupportedProtocolError);
    expect(classifyTransportError(foreign)).toBe('ProtocolUnsupported');
    const foreignObject = { name: 'StreamResetError', message: 'x' };
    expect(classifyTransportError(foreignObject)).toBe('ConnectionReset');
  });

  it('does not treat inherited Object properties as error names', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(classifyTransportError(named(name, 'plain'))).toBe('Unknown');
    }
  });

  it('never throws, even for a value whose string conversion throws', () => {
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(classifyTransportError(hostile)).toBe('Unknown');
    expect(isRecoverableSendError(hostile)).toBe(false);
    expect(isProtocolUnsupportedError(hostile)).toBe(false);
  });

  it('follows a PooledStreamResetError cause chain but is bounded against cycles', () => {
    const a = new PooledStreamResetError('a');
    const b = new PooledStreamResetError('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(classifyTransportError(a)).toBe('PooledStreamReset');

    let chain: unknown = new UnsupportedProtocolError('deep');
    for (let i = 0; i < 3; i += 1) chain = new PooledStreamResetError(`level ${i}`, { cause: chain });
    expect(classifyTransportError(chain)).toBe('ProtocolUnsupported');
    for (let i = 0; i < 8; i += 1) chain = new PooledStreamResetError(`more ${i}`, { cause: chain });
    // Beyond the depth bound the wrapper itself is what is classified.
    expect(classifyTransportError(chain)).toBe('PooledStreamReset');
  });

  it('ignores the cause of anything that is not a pool wrapper', () => {
    const outer = new Error('handler error', { cause: new UnsupportedProtocolError('inner') });
    expect(classifyTransportError(outer)).toBe('Unknown');
  });
});

/**
 * A send can fail with any thrown value, including a Proxy or an object whose
 * accessors throw. The classifiers run in the catch blocks of the router, the
 * outbox and sync, so they must give a verdict for such a value and never
 * replace the original failure with their own exception.
 */
describe('hostile error values (throwing accessors, Proxies)', () => {
  const GETTER_FAILED = 'accessor failed';

  /** Make `key` on `target` an accessor that throws. */
  function withThrowingAccessor<T extends object>(target: T, key: string): T {
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        throw new Error(GETTER_FAILED);
      },
    });
    return target;
  }

  /** Make `key` on `target` an accessor that returns `value`. */
  function withAccessorReturning<T extends object>(target: T, key: string, value: unknown): T {
    Object.defineProperty(target, key, { configurable: true, get: () => value });
    return target;
  }

  const throwingTrap = (): never => {
    throw new Error(GETTER_FAILED);
  };
  /** A Proxy whose every reflective trap throws. */
  function proxyWithEveryTrapThrowing(): object {
    return new Proxy({}, {
      get: throwingTrap,
      getPrototypeOf: throwingTrap,
      has: throwingTrap,
      ownKeys: throwingTrap,
      getOwnPropertyDescriptor: throwingTrap,
    });
  }
  function revokedProxy(): object {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }

  interface Verdict {
    category: TransportErrorCategory;
    recoverable: boolean;
    retryableLater: boolean;
    unsupported: boolean;
  }

  /** Run every public predicate; a throw from any of them fails the calling test. */
  function verdictOf(err: unknown): Verdict {
    return {
      category: classifyTransportError(err),
      recoverable: isRecoverableSendError(err),
      retryableLater: isRetryableLaterSendError(err),
      unsupported: isProtocolUnsupportedError(err),
    };
  }

  const cases: Array<{ label: string; err: () => unknown; verdict: Verdict }> = [
    // --- an unreadable `name` counts as absent; the message still decides ---
    {
      label: 'throwing name getter, refusal wording -> the message still says ProtocolUnsupported',
      err: () => withThrowingAccessor(
        new Error('Protocol selection failed - could not negotiate /dkg/10.0.1/message'),
        'name',
      ),
      verdict: { category: 'ProtocolUnsupported', recoverable: false, retryableLater: true, unsupported: true },
    },
    {
      label: 'throwing name getter, reset wording -> ConnectionReset',
      err: () => withThrowingAccessor(new Error('read ECONNRESET'), 'name'),
      verdict: { category: 'ConnectionReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'throwing name getter, unrecognised wording -> Unknown',
      err: () => withThrowingAccessor(new Error('Invalid payload'), 'name'),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    {
      label: 'name getter returning a non-string -> treated as absent',
      err: () => withAccessorReturning(new Error('Invalid payload'), 'name', { toString: () => 'UnsupportedProtocolError' }),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    {
      label: 'plain object with a throwing name getter and no message -> Unknown',
      err: () => withThrowingAccessor({}, 'name'),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },

    // --- an unreadable or non-string `message` counts as empty; the name still decides ---
    {
      label: 'typed refusal whose message getter throws -> ProtocolUnsupported by name',
      err: () => withThrowingAccessor(new UnsupportedProtocolError('declined'), 'message'),
      verdict: { category: 'ProtocolUnsupported', recoverable: false, retryableLater: true, unsupported: true },
    },
    {
      label: 'typed reset whose message getter throws -> ConnectionReset by name',
      err: () => withThrowingAccessor(new StreamResetError('gone'), 'message'),
      verdict: { category: 'ConnectionReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'generic error whose message getter throws -> Unknown',
      err: () => withThrowingAccessor(new Error('unused'), 'message'),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    ...[42, null, Symbol('message'), { toString: () => 'econnreset' }].map((message, index) => ({
      label: `generic error whose message is not a string (#${index}) -> Unknown`,
      err: () => withAccessorReturning(new Error('unused'), 'message', message),
      verdict: { category: 'Unknown' as const, recoverable: false, retryableLater: false, unsupported: false },
    })),
    {
      label: 'typed reset whose message is not a string -> ConnectionReset by name',
      err: () => withAccessorReturning(new StreamResetError('gone'), 'message', 42),
      verdict: { category: 'ConnectionReset', recoverable: true, retryableLater: true, unsupported: false },
    },

    // --- an unreadable pooled `cause` is an unspecified pooled reset ---
    {
      label: 'PooledStreamResetError with a throwing cause getter -> PooledStreamReset',
      err: () => withThrowingAccessor(new PooledStreamResetError('request timeout'), 'cause'),
      verdict: { category: 'PooledStreamReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper with refusal wording and a throwing cause -> ProtocolUnsupported (the message is checked first)',
      err: () => withThrowingAccessor(
        new PooledStreamResetError('Protocol selection failed - could not negotiate /dkg/10.0.2/message'),
        'cause',
      ),
      verdict: { category: 'ProtocolUnsupported', recoverable: false, retryableLater: true, unsupported: true },
    },
    {
      label: 'pooled wrapper whose cause has an unreadable name and a timeout message -> Timeout',
      err: () => new PooledStreamResetError('open failed', {
        cause: withThrowingAccessor(new Error('operation timed out'), 'name'),
      }),
      verdict: { category: 'Timeout', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause has an unreadable name and no known wording -> PooledStreamReset',
      err: () => new PooledStreamResetError('open failed', {
        cause: withThrowingAccessor(new Error('handler error'), 'name'),
      }),
      verdict: { category: 'PooledStreamReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause is a Proxy with every trap throwing -> PooledStreamReset',
      err: () => new PooledStreamResetError('open failed', { cause: proxyWithEveryTrapThrowing() }),
      verdict: { category: 'PooledStreamReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause is a revoked Proxy -> PooledStreamReset',
      err: () => new PooledStreamResetError('open failed', { cause: revokedProxy() }),
      verdict: { category: 'PooledStreamReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause is a typed refusal with a throwing message getter -> ProtocolUnsupported',
      err: () => new PooledStreamResetError('open failed', {
        cause: withThrowingAccessor(new UnsupportedProtocolError('declined'), 'message'),
      }),
      verdict: { category: 'ProtocolUnsupported', recoverable: false, retryableLater: true, unsupported: true },
    },

    // --- Proxies ---
    {
      label: 'Proxy whose get trap always throws -> Unknown',
      err: () => new Proxy({}, { get: throwingTrap }),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    {
      label: 'Proxy whose every trap throws -> Unknown',
      err: proxyWithEveryTrapThrowing,
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    {
      label: 'revoked Proxy -> Unknown',
      err: revokedProxy,
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
    {
      label: 'Proxy around a real refusal whose name trap throws -> ProtocolUnsupported by message',
      err: () => new Proxy(new Error('Protocol selection failed - could not negotiate /dkg/x'), {
        get(target, key, receiver) {
          if (key === 'name') throw new Error(GETTER_FAILED);
          return Reflect.get(target, key, receiver);
        },
      }),
      verdict: { category: 'ProtocolUnsupported', recoverable: false, retryableLater: true, unsupported: true },
    },
    {
      label: 'Proxy around a StreamResetError whose message trap throws -> ConnectionReset by name',
      err: () => new Proxy(new StreamResetError('gone'), {
        get(target, key, receiver) {
          if (key === 'message') throw new Error(GETTER_FAILED);
          return Reflect.get(target, key, receiver);
        },
      }),
      verdict: { category: 'ConnectionReset', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'string conversion that throws -> Unknown',
      err: () => ({ toString: throwingTrap }),
      verdict: { category: 'Unknown', recoverable: false, retryableLater: false, unsupported: false },
    },
  ];

  for (const { label, err, verdict } of cases) {
    it(`${label}`, () => {
      expect(verdictOf(err())).toEqual(verdict);
    });
  }

  it('gives the same verdict when the same hostile value is classified again', () => {
    const value = withThrowingAccessor(new PooledStreamResetError('request timeout'), 'cause');
    expect(verdictOf(value)).toEqual(verdictOf(value));
  });

  it('ends an endless pooled cause chain (each cause read yields a fresh wrapper) after a bounded number of reads', () => {
    let causeReads = 0;
    const endless = (): object => new Proxy({}, {
      get(_target, key) {
        if (key === 'name') return 'PooledStreamResetError';
        if (key === 'cause') {
          causeReads += 1;
          return endless();
        }
        return undefined;
      },
    });
    expect(classifyTransportError(endless())).toBe('PooledStreamReset');
    // One classification follows a bounded number of links (MAX_CAUSE_DEPTH).
    expect(causeReads).toBeGreaterThan(0);
    expect(causeReads).toBeLessThanOrEqual(4);
    expect(verdictOf(endless())).toEqual({
      category: 'PooledStreamReset',
      recoverable: true,
      retryableLater: true,
      unsupported: false,
    });
  });

  it('ends a pooled cause getter that returns the wrapper itself', () => {
    const err = new PooledStreamResetError('request timeout');
    Object.defineProperty(err, 'cause', { configurable: true, get: () => err });
    expect(verdictOf(err).category).toBe('PooledStreamReset');
  });
});

describe('PooledStreamResetError classification', () => {
  it('is recoverable by name whatever its message says', () => {
    const err = new PooledStreamResetError('request timeout');
    err.message = 'completely different wording';
    expect(classifyTransportError(err)).toBe('PooledStreamReset');
    expect(isRecoverableSendError(err)).toBe(true);
    expect(isProtocolUnsupportedError(err)).toBe(false);
  });

  it('is classified by the typed error it wraps, even when the wrapper text carries no refusal wording', () => {
    const err = new PooledStreamResetError('open failed', {
      cause: new UnsupportedProtocolError('declined'),
    });
    expect(classifyTransportError(err)).toBe('ProtocolUnsupported');
    expect(isRecoverableSendError(err)).toBe(false);
    expect(isProtocolUnsupportedError(err)).toBe(true);
  });
});

describe('isRecoverableSendError / isProtocolUnsupportedError against the pre-typed substring classifiers', () => {
  for (const row of rows) {
    const legacyRecoverable = legacyIsRecoverableSendError(row.err);
    const legacyUnsupported = legacyIsProtocolUnsupportedError(row.err);
    it(`${row.label}`, () => {
      const unsupported = isProtocolUnsupportedError(row.err);
      // isProtocolUnsupportedError may only ever get wider.
      if (legacyUnsupported) expect(unsupported).toBe(true);
      expect(unsupported).toBe(row.category === 'ProtocolUnsupported');

      const recoverable = isRecoverableSendError(row.err);
      if (row.change === 'typed') {
        // The one intended widening: a typed transient name is retryable
        // whatever its wording. (A typed refusal is never retryable.)
        expect(recoverable).toBe(row.category !== 'ProtocolUnsupported');
        expect(legacyRecoverable && !unsupported).toBe(false);
      } else {
        // Everything else: the old verdict, except that a refusal is no
        // longer recoverable.
        expect(recoverable).toBe(legacyRecoverable && !unsupported);
      }
      expect(recoverable).toBe(row.category !== 'ProtocolUnsupported' && row.category !== 'Unknown');
    });
  }
});

describe('isRetryableLaterSendError', () => {
  it('keeps every failure retryable that the previous classifier accepted (Messenger outbox, sync backoff)', () => {
    for (const row of rows) {
      if (row.change === 'typed' || row.refusalWording) continue;
      expect(isRetryableLaterSendError(row.err), row.label).toBe(legacyIsRecoverableSendError(row.err));
    }
  });

  it('widens only for typed transient names and for refusals worded without "could not negotiate"', () => {
    for (const row of rows) {
      if (row.change !== 'typed' && !row.refusalWording) continue;
      expect(legacyIsRecoverableSendError(row.err), row.label).toBe(false);
      expect(isRetryableLaterSendError(row.err), row.label).toBe(true);
    }
  });

  it('accepts a refusal that isRecoverableSendError rejects', () => {
    const refusal = new UnsupportedProtocolError('Protocol selection failed - could not negotiate /dkg/x');
    expect(isRecoverableSendError(refusal)).toBe(false);
    expect(isRetryableLaterSendError(refusal)).toBe(true);
    expect(isRetryableLaterSendError(new Error('Invalid payload'))).toBe(false);
  });
});
