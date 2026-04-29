/**
 * Unit tests for the daemon's HTTP error classification helper.
 *
 * Covers a subtle behaviour of {@link classifyClientError}: an
 * earlier revision had a single regex that recognised malformed
 * peer-ids AND `timed out` / `unable to dial`, which downgraded
 * transient transport failures from a retryable 504 to a
 * non-retryable client-side 400. The CLI / SDK then never retried
 * even though the next dial attempt would have succeeded.
 */
import { describe, it, expect } from 'vitest';
import { classifyClientError } from '../src/daemon.js';

describe('classifyClientError — transient transport errors return 504, not 400', () => {
  for (const msg of [
    'request to peer 12D3KooW… timed out after 30000ms',
    'libp2p: timeout',
    'unable to dial peer: ENETUNREACH',
    'libp2p could not dial peer: connection refused',
    'connection refused',
    'connection reset by peer',
    'connection closed before response',
    'aborted',
    'request aborted',
    'fetch failed: ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'deadline exceeded while contacting peer',
  ]) {
    it(`maps "${msg}" to 504`, () => {
      const r = classifyClientError(msg);
      expect(r).not.toBeNull();
      expect(r!.status).toBe(504);
    });
  }
});

describe('classifyClientError — input validation still 400', () => {
  for (const msg of [
    'invalid peerId provided',
    'invalid multihash',
    'malformed input',
    'bad request',
    'incorrect length',
    'could not parse peerId',
    'parse peerId failed',
    'peer ID is not valid',
    'invalid contextGraphId',
    'invalid policyUri',
  ]) {
    it(`maps "${msg}" to 400`, () => {
      const r = classifyClientError(msg);
      expect(r).not.toBeNull();
      expect(r!.status).toBe(400);
    });
  }

  it('multibase / multiformats parse errors map to 400', () => {
    expect(classifyClientError('Non-base58btc character at position 4')?.status).toBe(400);
    expect(classifyClientError('Unknown base for multihash')?.status).toBe(400);
    expect(classifyClientError('ERR_INVALID_PEER_ID')?.status).toBe(400);
  });
});

describe('classifyClientError — not-found stays 404', () => {
  for (const msg of [
    'peer not found in DHT',
    'context graph does not exist',
    'no such verified-memory id',
    'unknown paranet',
    'unknown context-graph',
    'peer is not connected',
    'cannot resolve peer',
    'no addresses for peer',
  ]) {
    it(`maps "${msg}" to 404`, () => {
      const r = classifyClientError(msg);
      expect(r).not.toBeNull();
      expect(r!.status).toBe(404);
    });
  }
});

describe('classifyClientError — hybrid messages are conservatively transient', () => {
  // libp2p sometimes embeds "invalid" inside what is actually a transport
  // timeout (e.g. `invalid response: timed out waiting for stream`). The
  // operator wants the retryable 504 here, not a hard 400 that hides the
  // network condition. Order-of-checks in `classifyClientError` puts the
  // transient set first to honour this intent.
  it('"invalid response: timed out" is treated as 504 (transient)', () => {
    expect(
      classifyClientError('invalid response: timed out waiting for stream')?.status,
    ).toBe(504);
  });
});

describe('classifyClientError — unknown errors return null (caller falls through to 500)', () => {
  it('does not classify a generic internal error', () => {
    expect(classifyClientError('Internal database corruption')).toBeNull();
    expect(classifyClientError('Unexpected token at offset 42')).toBeNull();
  });
});
