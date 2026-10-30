import { describe, it, expect } from 'vitest';
import {
  isKnownRetryableSyncTransportInterruption,
  isSyncBackoffWorthyError,
} from '../src/sync/error-tags.js';

/**
 * Untagged send errors reach sync's classifiers straight from
 * `ProtocolRouter`. The router itself stopped treating a peer that refuses the
 * protocol as "recoverable" (it fails fast instead of re-negotiating inside one
 * `send()`), but sync's retry / peer-backoff verdicts must not change: such a
 * peer may still be booting or about to be upgraded, and the backoff is what
 * keeps a sync cycle from hammering it.
 */

/** libp2p's multistream-select refusal: an error NAMED `UnsupportedProtocolError`. */
function unsupportedProtocolError(message: string): Error {
  const err = new Error(message);
  err.name = 'UnsupportedProtocolError';
  return err;
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('sync error classification of untagged send errors', () => {
  const refusals: Array<[string, unknown]> = [
    ['libp2p UnsupportedProtocolError', unsupportedProtocolError('Protocol selection failed - could not negotiate /dkg/10.0.1/sync')],
    ['reworded UnsupportedProtocolError', unsupportedProtocolError('the remote declined every offered protocol')],
    ['bare multistream text', new Error('Protocol selection failed - could not negotiate /dkg/10.0.1/sync')],
  ];

  for (const [label, error] of refusals) {
    it(`treats a peer refusing the protocol as backoff-worthy and retryable: ${label}`, () => {
      expect(isSyncBackoffWorthyError(error)).toBe(true);
      expect(isKnownRetryableSyncTransportInterruption(error)).toBe(true);
    });
  }

  it('still treats transient transport errors as backoff-worthy and retryable', () => {
    for (const error of [
      new Error('The stream has been reset'),
      new Error('All multiaddr dials failed'),
      namedError('StreamResetError', 'gone'),
      namedError('PooledStreamResetError', 'anything'),
    ]) {
      expect(isSyncBackoffWorthyError(error)).toBe(true);
      expect(isKnownRetryableSyncTransportInterruption(error)).toBe(true);
    }
  });

  it('does not classify unrelated errors as transport interruptions', () => {
    for (const error of [new Error('Invalid payload'), new Error('handler error')]) {
      expect(isSyncBackoffWorthyError(error)).toBe(false);
      expect(isKnownRetryableSyncTransportInterruption(error)).toBe(false);
    }
  });

  it('never infers an untagged AbortError from its text', () => {
    expect(isKnownRetryableSyncTransportInterruption(namedError('AbortError', 'The operation was aborted'))).toBe(false);
  });
});
