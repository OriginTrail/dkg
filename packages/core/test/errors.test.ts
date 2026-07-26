import { describe, it, expect } from 'vitest';
import {
  DKGError,
  DKGUserError,
  DKGInternalError,
  PayloadTooLargeError,
  toErrorMessage,
  hasErrorCode,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER,
  formatPublishAuthorNotCustodialMessage,
  messageIndicatesPublishAuthorNotCustodial,
} from '../src/errors.js';

describe('DKGError hierarchy', () => {
  it('DKGUserError extends DKGError', () => {
    const err = new DKGUserError('bad input');
    expect(err).toBeInstanceOf(DKGError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DKGUserError');
    expect(err.message).toBe('bad input');
  });

  it('DKGInternalError extends DKGError and preserves cause', () => {
    const cause = new TypeError('null ref');
    const err = new DKGInternalError('unexpected', cause);
    expect(err).toBeInstanceOf(DKGError);
    expect(err.name).toBe('DKGInternalError');
    expect(err.cause).toBe(cause);
  });

  it('PayloadTooLargeError extends DKGUserError', () => {
    const err = new PayloadTooLargeError(1024);
    expect(err).toBeInstanceOf(DKGUserError);
    expect(err).toBeInstanceOf(DKGError);
    expect(err.name).toBe('PayloadTooLargeError');
    expect(err.message).toContain('1024');
  });

  it('PayloadTooLargeError works without maxBytes', () => {
    const err = new PayloadTooLargeError();
    expect(err.message).toBe('Payload too large');
  });
});

describe('toErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns string values as-is', () => {
    expect(toErrorMessage('raw string')).toBe('raw string');
  });

  it('stringifies non-Error objects', () => {
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('handles Error subclasses', () => {
    expect(toErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });
});

describe('hasErrorCode', () => {
  it('returns true for matching error code', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(hasErrorCode(err, 'ENOENT')).toBe(true);
  });

  it('returns false for non-matching code', () => {
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(hasErrorCode(err, 'ENOENT')).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(hasErrorCode('string', 'ENOENT')).toBe(false);
    expect(hasErrorCode(null, 'ENOENT')).toBe(false);
  });
});

// GH#1786 — the non-custodial-author failure crosses packages: the agent throws it, the
// daemon maps it to a 409, and the publisher's async-job classifier must see it as PERMANENT
// or the queue resets a job that can never finalize (the forever-retry trap #1013/#1121).
// `.code` survives most paths, but a re-wrap can strip it, so there is a message fallback —
// and THAT is what drifts. These pin the emitter and the matcher to one shared marker.
describe('publish-author-not-custodial cross-package message contract', () => {
  it('formats a message the classifier recognizes (emitter/matcher cannot drift)', () => {
    const message = formatPublishAuthorNotCustodialMessage('0xA32f1cc125401B55911678847426759094055B2d');
    expect(messageIndicatesPublishAuthorNotCustodial(message)).toBe(true);
    // The address is in the message: it is the actionable part for the operator.
    expect(message).toContain('0xA32f1cc125401B55911678847426759094055B2d');
  });

  it('still matches when the message is re-wrapped with a prefix and lowercased', () => {
    // Both real re-wrap shapes: the agent's own call-site prefix, and a lowercased copy
    // (the publisher classifier lowercases before matching).
    const inner = formatPublishAuthorNotCustodialMessage('0xabc');
    expect(messageIndicatesPublishAuthorNotCustodial(
      `publishFromFinalizedAssertion (update path): ${inner}`,
    )).toBe(true);
    expect(messageIndicatesPublishAuthorNotCustodial(inner.toLowerCase())).toBe(true);
  });

  it('does not match unrelated publish failures or non-strings', () => {
    expect(messageIndicatesPublishAuthorNotCustodial('RPC submit timed out after 30s')).toBe(false);
    expect(messageIndicatesPublishAuthorNotCustodial(
      'No operational wallet has enough funds to publish to Verifiable Memory',
    )).toBe(false);
    expect(messageIndicatesPublishAuthorNotCustodial(undefined)).toBe(false);
    expect(messageIndicatesPublishAuthorNotCustodial(null)).toBe(false);
    expect(messageIndicatesPublishAuthorNotCustodial({ message: PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER })).toBe(false);
  });
});
