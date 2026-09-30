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
  TRANSPORT_ERROR_DISPOSITION,
  type TransportErrorCategory,
  type TransportRetryDisposition,
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
  { label: 'StreamResetError (default)', err: new StreamResetError(), category: 'Transient' },
  { label: 'ConnectionClosedError (default)', err: new ConnectionClosedError(), category: 'Transient' },
  { label: 'MuxerClosedError (default)', err: new MuxerClosedError(), category: 'Transient' },
  { label: 'StreamAbortedError (default)', err: new StreamAbortedError(), category: 'Transient' },
  { label: 'AbortError (default)', err: new AbortError(), category: 'Transient' },
  { label: 'NoValidAddressesError (real wording)', err: named('NoValidAddressesError', 'The dial request has no valid addresses for peer: 12D3KooW...'), category: 'Transient' },
  { label: 'AggregateError from the dial queue', err: new AggregateError([new Error('a'), new Error('b')], 'All multiaddr dials failed'), category: 'Transient' },
  { label: 'dialProtocol-prefixed dial exhaustion', err: new Error('dialProtocol(/dkg/10.0.1/message): All multiaddr dials failed'), category: 'Transient' },
  { label: 'relay NO_RESERVATION (InvalidMessageError)', err: new InvalidMessageError('failed to connect via relay with status NO_RESERVATION'), category: 'Transient' },
  { label: 'no reservation for relay', err: new Error('no reservation for relay'), category: 'Transient' },
  { label: 'ECONNREFUSED', err: new Error('connect ECONNREFUSED 127.0.0.1:1'), category: 'Transient' },
  { label: 'ECONNRESET', err: new Error('read ECONNRESET'), category: 'Transient' },
  { label: 'EPIPE', err: new Error('write EPIPE'), category: 'Transient' },
  { label: 'ETIMEDOUT', err: new Error('connect ETIMEDOUT'), category: 'Transient' },
  { label: 'send timeout', err: new Error('send timeout'), category: 'Transient' },
  { label: 'operation timed out', err: new Error('operation timed out'), category: 'Transient' },
  { label: 'AbortSignal.timeout wording', err: new Error('The operation was aborted due to timeout'), category: 'Transient' },
  { label: 'stream returned in closed state', err: new Error('stream returned in closed state'), category: 'Transient' },
  { label: 'Remote closed connection during opening', err: new Error('Remote closed connection during opening'), category: 'Transient' },
  { label: 'peer-closed-stream', err: new Error('peer-closed-stream'), category: 'Transient' },
  { label: 'sync responder queue full', err: new Error('sync responder queue full'), category: 'Transient' },
  { label: 'sync responder peer queue full', err: new Error('sync responder peer queue full'), category: 'Transient' },
  { label: 'sync responder queue wait exceeded', err: new Error('sync responder queue wait exceeded'), category: 'Transient' },
  { label: 'PooledStreamResetError (request timeout)', err: new PooledStreamResetError('request timeout'), category: 'Transient' },
  { label: 'PooledStreamResetError (pool closed)', err: new PooledStreamResetError('pool closed'), category: 'Transient' },
  { label: 'PooledStreamResetError wrapping an unrecognised error', err: new PooledStreamResetError('handler error', { cause: new Error('handler error') }), category: 'Transient' },
  { label: 'PooledStreamResetError wrapping a StreamResetError', err: new PooledStreamResetError('write failed', { cause: new StreamResetError() }), category: 'Transient' },
  { label: 'PooledStreamResetError wrapping a timeout', err: new PooledStreamResetError('open failed', { cause: new Error('operation timed out') }), category: 'Transient' },

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
  { label: 'StreamResetError, reworded', err: new StreamResetError('remote went away'), category: 'Transient', change: 'typed' },
  { label: 'ConnectionClosedError, reworded', err: new ConnectionClosedError('gone'), category: 'Transient', change: 'typed' },
  { label: 'MuxerClosedError, reworded', err: new MuxerClosedError('gone'), category: 'Transient', change: 'typed' },
  { label: 'StreamAbortedError, reworded', err: new StreamAbortedError('gone'), category: 'Transient', change: 'typed' },
  { label: 'NoValidAddressesError, reworded', err: named('NoValidAddressesError', 'nowhere to dial'), category: 'Transient', change: 'typed' },
];

describe('classifyTransportError', () => {
  for (const row of rows) {
    it(`${row.label} -> ${row.category}`, () => {
      expect(classifyTransportError(row.err)).toBe(row.category);
    });
  }

  it('exports the three retry predicates from the package entry point and keeps the category detail internal', () => {
    expect(coreIndex.isRecoverableSendError).toBe(isRecoverableSendError);
    expect(coreIndex.isProtocolUnsupportedError).toBe(isProtocolUnsupportedError);
    expect(coreIndex.isRetryableLaterSendError).toBe(isRetryableLaterSendError);
    // Nothing outside the classifier consumes the categories or the table.
    expect(coreIndex).not.toHaveProperty('classifyTransportError');
    expect(coreIndex).not.toHaveProperty('TRANSPORT_ERROR_DISPOSITION');
  });

  it('classifies by error name, not instanceof (a lookalike from another copy of libp2p still counts)', () => {
    const foreign = named('UnsupportedProtocolError', 'no such protocol');
    expect(foreign).not.toBeInstanceOf(UnsupportedProtocolError);
    expect(classifyTransportError(foreign)).toBe('ProtocolUnsupported');
    const foreignObject = { name: 'StreamResetError', message: 'x' };
    expect(classifyTransportError(foreignObject)).toBe('Transient');
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
    expect(classifyTransportError(a)).toBe('Transient');

    let chain: unknown = new UnsupportedProtocolError('deep');
    for (let i = 0; i < 3; i += 1) chain = new PooledStreamResetError(`level ${i}`, { cause: chain });
    expect(classifyTransportError(chain)).toBe('ProtocolUnsupported');
    for (let i = 0; i < 8; i += 1) chain = new PooledStreamResetError(`more ${i}`, { cause: chain });
    // Beyond the depth bound the wrapper itself is what is classified.
    expect(classifyTransportError(chain)).toBe('Transient');
  });

  it('ignores the cause of anything that is not a pool wrapper', () => {
    const outer = new Error('handler error', { cause: new UnsupportedProtocolError('inner') });
    expect(classifyTransportError(outer)).toBe('Unknown');
  });
});

/**
 * The predicates' verdict for each category, spelled out here (not read from
 * `TRANSPORT_ERROR_DISPOSITION`) so the table and the classifier are each
 * checked against an independent statement of the policy.
 */
const VERDICT_BY_CATEGORY: Record<TransportErrorCategory, { recoverable: boolean; retryableLater: boolean; unsupported: boolean }> = {
  ProtocolUnsupported: { recoverable: false, retryableLater: true, unsupported: true },
  Transient: { recoverable: true, retryableLater: true, unsupported: false },
  Unknown: { recoverable: false, retryableLater: false, unsupported: false },
};

/** The category and all three predicates, for one value. */
function expectClassified(err: unknown, category: TransportErrorCategory, label: string): void {
  expect(classifyTransportError(err), `${label}: category`).toBe(category);
  expect(
    {
      recoverable: isRecoverableSendError(err),
      retryableLater: isRetryableLaterSendError(err),
      unsupported: isProtocolUnsupportedError(err),
    },
    `${label}: predicates`,
  ).toEqual(VERDICT_BY_CATEGORY[category]);
}

/**
 * Every message wording the classifier recognises and the near misses that it
 * must not, hard-coded here rather than imported from the module: dropping a
 * wording from the module (or widening one) fails the row that names it.
 * (`econnreset`, `stream returned in closed state` and `operation was aborted
 * due to timeout` are also matched by `reset`, `closed` and `aborted`, so their
 * rows cannot tell the narrow needle from the broad one.)
 */
const REFUSAL_WORDINGS = ['protocol selection failed', 'could not negotiate', 'unsupported protocol', 'protocol mismatch'];
const TRANSIENT_WORDINGS = [
  'no_reservation', 'no reservation',
  'all multiaddr dials failed', 'no valid addresses', 'econnrefused',
  'etimedout', 'send timeout', 'operation timed out', 'operation was aborted due to timeout',
  'closed', 'reset', 'stream returned in closed state', 'econnreset', 'epipe',
  'aborted',
  'sync responder queue full', 'sync responder peer queue full', 'sync responder queue wait exceeded',
  // The two halves of the responder-busy rule are searched independently, so their order does not matter.
  'queue full sync responder',
];
const UNRECOGNISED_WORDINGS = [
  // Half of the responder-busy rule is not the rule.
  'queue full', 'queue wait exceeded', 'sync responder', 'sync  responder queue full',
  'sync responder snapshot limit exceeded (active=128/128)',
  // Near misses of recognised wordings.
  'no valid address', 'no  reservation', 'noreservation', 'dials failed', 'abort', 'aborting', 'timeout', 'Timed out',
  'Connection timeout after 5000ms', 'Cannot write to a stream that is closing', 'The connection is closing',
  'protocol', 'could not', 'unsupported', 'mismatch', 'negotiate',
  // Failures the router does not retry.
  'handler error', 'Invalid payload', 'Read limit exceeded', 'Tried to dial self', '',
];

describe('message wordings, under a generic Error name and as a bare string', () => {
  const table: Array<[string, TransportErrorCategory]> = [
    ...REFUSAL_WORDINGS.map((w): [string, TransportErrorCategory] => [w, 'ProtocolUnsupported']),
    ...TRANSIENT_WORDINGS.map((w): [string, TransportErrorCategory] => [w, 'Transient']),
    ...UNRECOGNISED_WORDINGS.map((w): [string, TransportErrorCategory] => [w, 'Unknown']),
  ];
  const forms: Array<[string, (wording: string) => string]> = [
    ['as written', (w) => w],
    ['upper case', (w) => w.toUpperCase()],
    ['embedded in a longer message', (w) => `dialProtocol(/dkg/10.0.1/message): ${w} (peer 12D3KooWabc)`],
  ];
  for (const [wording, category] of table) {
    it(`${JSON.stringify(wording)} -> ${category}`, () => {
      for (const [form, shape] of forms) {
        // A whitespace-only or empty wording has no upper-case or embedded form worth checking.
        if (wording === '' && form !== 'as written') continue;
        const text = shape(wording);
        expectClassified(new Error(text), category, `${form}, Error`);
        expectClassified(text, category, `${form}, bare string`);
      }
    });
  }
});

describe('typed error names', () => {
  // Each with a message that says nothing, so only the name can decide.
  const table: Array<[string, TransportErrorCategory]> = [
    ['UnsupportedProtocolError', 'ProtocolUnsupported'],
    ['PooledStreamResetError', 'Transient'],
    ['StreamResetError', 'Transient'],
    ['ConnectionClosedError', 'Transient'],
    ['MuxerClosedError', 'Transient'],
    ['StreamAbortedError', 'Transient'],
    ['NoValidAddressesError', 'Transient'],
    // Not classified by name: a default-worded libp2p error of these names was not retried before either.
    ['TimeoutError', 'Unknown'],
    ['StreamStateError', 'Unknown'],
    ['ConnectionClosingError', 'Unknown'],
    ['ConnectionFailedError', 'Unknown'],
    ['DialError', 'Unknown'],
    ['AbortError', 'Unknown'],
    ['InvalidMessageError', 'Unknown'],
    ['AggregateError', 'Unknown'],
    ['Error', 'Unknown'],
    ['streamreseterror', 'Unknown'],
    ['StreamResetError ', 'Unknown'],
  ];
  for (const [name, category] of table) {
    it(`${JSON.stringify(name)} with an unrelated message -> ${category}`, () => {
      expectClassified(named(name, 'nothing recognisable here'), category, 'Error');
      expectClassified({ name, message: 'nothing recognisable here' }, category, 'plain object');
    });
  }

  it('leaves a name that is not classified to its wording', () => {
    expectClassified(named('TimeoutError', 'operation timed out'), 'Transient', 'TimeoutError + timeout wording');
    expectClassified(named('AbortError', 'The operation was aborted'), 'Transient', 'AbortError + abort wording');
    expectClassified(named('DialError', 'All multiaddr dials failed'), 'Transient', 'DialError + dial wording');
    expectClassified(named('InvalidMessageError', 'status NO_RESERVATION'), 'Transient', 'InvalidMessageError + relay wording');
    expectClassified(named('StreamStateError', 'Protocol selection failed'), 'ProtocolUnsupported', 'StreamStateError + refusal wording');
  });

  it('reads a name from an object only: a function that carries an error name is not an error', () => {
    const namedFunction = (name: string): unknown => Object.defineProperty(() => undefined, 'name', { value: name });
    for (const name of ['UnsupportedProtocolError', 'StreamResetError', 'PooledStreamResetError']) {
      expectClassified(namedFunction(name), 'Unknown', name);
    }
    // ... nor as the cause of a pooled wrapper.
    expectClassified(
      new PooledStreamResetError('open failed', { cause: namedFunction('UnsupportedProtocolError') }),
      'Transient',
      'function as a pooled cause',
    );
  });

  it('lets a transient name decide whatever its own wording says', () => {
    for (const name of ['StreamResetError', 'ConnectionClosedError', 'MuxerClosedError', 'StreamAbortedError', 'NoValidAddressesError', 'PooledStreamResetError']) {
      for (const wording of ['', 'gone', 'handler error', 'sync responder snapshot limit exceeded (active=128/128)']) {
        expectClassified(named(name, wording), 'Transient', `${name} / ${JSON.stringify(wording)}`);
      }
    }
  });
});

describe('precedence: a refusal wins over every transient reading', () => {
  const transientNames = ['StreamResetError', 'ConnectionClosedError', 'MuxerClosedError', 'StreamAbortedError', 'NoValidAddressesError', 'PooledStreamResetError'];

  it('a typed refusal name wins over transient wording in its message', () => {
    for (const wording of TRANSIENT_WORDINGS) {
      expectClassified(named('UnsupportedProtocolError', wording), 'ProtocolUnsupported', `UnsupportedProtocolError / ${wording}`);
    }
  });

  it('refusal wording wins over a transient name', () => {
    for (const name of transientNames) {
      for (const wording of REFUSAL_WORDINGS) {
        expectClassified(named(name, wording), 'ProtocolUnsupported', `${name} / ${wording}`);
      }
    }
  });

  it('a message carrying both wordings is a refusal, in either order and any case', () => {
    for (const refusal of REFUSAL_WORDINGS) {
      for (const transient of TRANSIENT_WORDINGS) {
        for (const text of [`${refusal} - ${transient}`, `${transient}: ${refusal}`, `${refusal.toUpperCase()} ${transient.toUpperCase()}`]) {
          expectClassified(new Error(text), 'ProtocolUnsupported', text);
          expectClassified(text, 'ProtocolUnsupported', `bare ${text}`);
        }
      }
    }
  });
});

describe('PooledStreamResetError causes', () => {
  const wrap = (cause: unknown, detail = 'open failed'): PooledStreamResetError => new PooledStreamResetError(detail, { cause });
  /** `count` pooled wrappers around `leaf`, the outermost first. */
  const wrapTimes = (count: number, leaf: unknown): unknown => {
    let current = leaf;
    for (let i = 0; i < count; i += 1) current = wrap(current, `level ${i}`);
    return current;
  };

  it('is a refusal when its cause is one, by typed name or by each refusal wording', () => {
    expectClassified(wrap(new UnsupportedProtocolError('declined')), 'ProtocolUnsupported', 'typed cause');
    for (const wording of REFUSAL_WORDINGS) {
      expectClassified(wrap(new Error(wording)), 'ProtocolUnsupported', `cause ${wording}`);
      expectClassified(wrap(wording), 'ProtocolUnsupported', `bare cause ${wording}`);
    }
  });

  it('is a refusal when its own text says so, whatever its cause is', () => {
    for (const cause of [new StreamResetError(), new Error('handler error'), undefined, null]) {
      expectClassified(wrap(cause, 'Protocol selection failed - could not negotiate /dkg/x'), 'ProtocolUnsupported', `cause ${String(cause)}`);
    }
  });

  it('decides a wrapper whose own wording says refusal without reading its cause', () => {
    let causeReads = 0;
    const err = new PooledStreamResetError('Protocol selection failed - could not negotiate /dkg/x');
    Object.defineProperty(err, 'cause', {
      configurable: true,
      get() {
        causeReads += 1;
        return new StreamResetError();
      },
    });
    expectClassified(err, 'ProtocolUnsupported', 'refusal wording, readable cause');
    expect(causeReads).toBe(0);
  });

  it('is a refusal when its cause is one even though its own text names a transient failure', () => {
    expectClassified(wrap(new UnsupportedProtocolError('declined'), 'read ECONNRESET'), 'ProtocolUnsupported', 'text says reset');
  });

  it('stays a transient reset for any other cause: transient, unrecognised, absent or not an error', () => {
    const causes: unknown[] = [
      new StreamResetError(), new StreamAbortedError(), named('NoValidAddressesError', 'nowhere'),
      new Error('operation timed out'), new Error('all multiaddr dials failed'),
      new Error('handler error'), new TimeoutError(), new StreamStateError('closing'),
      undefined, null, 'plain text', 42, {}, { name: 'UnsupportedProtocolErrorX' },
    ];
    for (const cause of causes) {
      expectClassified(wrap(cause), 'Transient', `cause ${String(cause)}`);
    }
    expectClassified(new PooledStreamResetError('no cause at all'), 'Transient', 'no cause option');
  });

  it('follows exactly four wrappers to the error underneath, and no further', () => {
    const refusal = (): unknown => new UnsupportedProtocolError('deep');
    for (const count of [1, 2, 3, 4]) {
      expectClassified(wrapTimes(count, refusal()), 'ProtocolUnsupported', `${count} wrappers`);
    }
    for (const count of [5, 6, 12]) {
      // Beyond the depth bound the outermost wrapper is what is classified.
      expectClassified(wrapTimes(count, refusal()), 'Transient', `${count} wrappers`);
    }
  });

  it('follows a wrapper only, never the cause of another error', () => {
    for (const name of ['StreamResetError', 'Error', 'TimeoutError', 'ConnectionClosedError']) {
      const outer = named(name, 'handler error', { cause: new UnsupportedProtocolError('inner') });
      expectClassified(outer, name === 'ConnectionClosedError' || name === 'StreamResetError' ? 'Transient' : 'Unknown', name);
    }
  });

  it('classifies a wrapper nested in a plain error by that error, not by the wrapper', () => {
    const inner = wrap(new UnsupportedProtocolError('declined'));
    expectClassified(new Error('handler error', { cause: inner }), 'Unknown', 'plain error around a refusal wrapper');
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
      label: 'throwing name getter, reset wording -> Transient',
      err: () => withThrowingAccessor(new Error('read ECONNRESET'), 'name'),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
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
      label: 'typed reset whose message getter throws -> Transient by name',
      err: () => withThrowingAccessor(new StreamResetError('gone'), 'message'),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
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
      label: 'typed reset whose message is not a string -> Transient by name',
      err: () => withAccessorReturning(new StreamResetError('gone'), 'message', 42),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
    },

    // --- an unreadable pooled `cause` is an unspecified pooled reset ---
    {
      label: 'PooledStreamResetError with a throwing cause getter -> Transient',
      err: () => withThrowingAccessor(new PooledStreamResetError('request timeout'), 'cause'),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
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
      label: 'pooled wrapper whose cause has an unreadable name and a timeout message -> Transient',
      err: () => new PooledStreamResetError('open failed', {
        cause: withThrowingAccessor(new Error('operation timed out'), 'name'),
      }),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause has an unreadable name and no known wording -> Transient',
      err: () => new PooledStreamResetError('open failed', {
        cause: withThrowingAccessor(new Error('handler error'), 'name'),
      }),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause is a Proxy with every trap throwing -> Transient',
      err: () => new PooledStreamResetError('open failed', { cause: proxyWithEveryTrapThrowing() }),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
    },
    {
      label: 'pooled wrapper whose cause is a revoked Proxy -> Transient',
      err: () => new PooledStreamResetError('open failed', { cause: revokedProxy() }),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
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
      label: 'Proxy around a StreamResetError whose message trap throws -> Transient by name',
      err: () => new Proxy(new StreamResetError('gone'), {
        get(target, key, receiver) {
          if (key === 'message') throw new Error(GETTER_FAILED);
          return Reflect.get(target, key, receiver);
        },
      }),
      verdict: { category: 'Transient', recoverable: true, retryableLater: true, unsupported: false },
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
    expect(classifyTransportError(endless())).toBe('Transient');
    // One classification follows a bounded number of links (MAX_CAUSE_DEPTH).
    expect(causeReads).toBeGreaterThan(0);
    expect(causeReads).toBeLessThanOrEqual(4);
    expect(verdictOf(endless())).toEqual({
      category: 'Transient',
      recoverable: true,
      retryableLater: true,
      unsupported: false,
    });
  });

  it('ends a pooled cause getter that returns the wrapper itself', () => {
    const err = new PooledStreamResetError('request timeout');
    Object.defineProperty(err, 'cause', { configurable: true, get: () => err });
    expect(verdictOf(err).category).toBe('Transient');
  });
});

describe('PooledStreamResetError classification', () => {
  it('is recoverable by name whatever its message says', () => {
    const err = new PooledStreamResetError('request timeout');
    err.message = 'completely different wording';
    expect(classifyTransportError(err)).toBe('Transient');
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

/**
 * The retry policy is an explicit table with one row per category, checked for
 * exhaustiveness by the compiler (`Record<TransportErrorCategory, ...>`), so a
 * category added later cannot inherit "retryable" from being not `Unknown`.
 */
describe('TRANSPORT_ERROR_DISPOSITION', () => {
  /** One representative error per category. The `Record` type keeps this list exhaustive too. */
  const sampleByCategory: Record<TransportErrorCategory, unknown> = {
    ProtocolUnsupported: new UnsupportedProtocolError('Protocol selection failed - could not negotiate /dkg/x'),
    Transient: new StreamResetError(),
    Unknown: new Error('handler error'),
  };
  const categories = Object.keys(sampleByCategory) as TransportErrorCategory[];

  /** The verdicts pinned by the tests above, spelled out row by row. */
  const expected: Record<TransportErrorCategory, TransportRetryDisposition> = {
    ProtocolUnsupported: { retryNow: false, retryLater: true },
    Transient: { retryNow: true, retryLater: true },
    Unknown: { retryNow: false, retryLater: false },
  };

  it('has exactly one row per category, and exactly three categories', () => {
    expect(Object.keys(TRANSPORT_ERROR_DISPOSITION).sort()).toEqual([...categories].sort());
    expect([...categories].sort()).toEqual(['ProtocolUnsupported', 'Transient', 'Unknown']);
  });

  it('gives every category an explicit retryNow and retryLater decision', () => {
    for (const category of categories) {
      const row = TRANSPORT_ERROR_DISPOSITION[category];
      expect(row, category).toBeDefined();
      expect(Object.keys(row).sort(), category).toEqual(['retryLater', 'retryNow']);
      expect(typeof row.retryNow, `${category}.retryNow`).toBe('boolean');
      expect(typeof row.retryLater, `${category}.retryLater`).toBe('boolean');
    }
  });

  it('pins each category\'s decisions', () => {
    expect(TRANSPORT_ERROR_DISPOSITION).toEqual(expected);
  });

  it('never retries in-line what a durable caller would drop (retryNow implies retryLater)', () => {
    for (const category of categories) {
      const row = TRANSPORT_ERROR_DISPOSITION[category];
      if (row.retryNow) expect(row.retryLater, category).toBe(true);
    }
  });

  it('refuses to retry anything unrecognised, now or later', () => {
    expect(TRANSPORT_ERROR_DISPOSITION.Unknown).toEqual({ retryNow: false, retryLater: false });
  });

  it('is reachable: every category is what its sample classifies as', () => {
    for (const category of categories) {
      expect(classifyTransportError(sampleByCategory[category]), category).toBe(category);
    }
  });

  it('drives the predicates: each is a lookup of its column for the classified category', () => {
    for (const category of categories) {
      const sample = sampleByCategory[category];
      expect(isRecoverableSendError(sample), `${category} retryNow`).toBe(TRANSPORT_ERROR_DISPOSITION[category].retryNow);
      expect(isRetryableLaterSendError(sample), `${category} retryLater`).toBe(TRANSPORT_ERROR_DISPOSITION[category].retryLater);
      expect(isProtocolUnsupportedError(sample), `${category} unsupported`).toBe(category === 'ProtocolUnsupported');
    }
  });
});
