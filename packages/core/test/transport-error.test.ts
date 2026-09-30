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
