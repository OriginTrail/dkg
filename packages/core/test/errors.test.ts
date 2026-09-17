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
  PUBLISHER_NOT_AUTHORIZED_MESSAGE_MARKER,
  formatPublisherNotAuthorizedMessage,
  messageIndicatesPublisherNotAuthorized,
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
    // Transport-neutral: this package is shared with non-HTTP consumers, so the CONDITION
    // lives here but naming a route to call instead is the throw site's presentation. A
    // regression that folds remediation back into core would fail here.
    expect(message).not.toContain('/api/');
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

describe('publisher-not-authorized message contract [GH#2648]', () => {
  const ADDR = '0xd896f0E677b5648cd727794C5e0334966264b40F';

  it('builds a message the matching classifier recognises', () => {
    // Emitter and classifier are paired here on purpose: the chain adapter throws a typed error
    // carrying `.code`, but a re-wrap across a transport keeps only the text. Asserting the round
    // trip is what stops a re-wording from silently turning a PERMANENT refusal back into a
    // retryable one, which is the forever-retry trap this constant exists to close.
    const message = formatPublisherNotAuthorizedMessage(ADDR, 7n);
    expect(message).toContain(ADDR);
    expect(message).toContain(PUBLISHER_NOT_AUTHORIZED_MESSAGE_MARKER);
    expect(message).toContain('7');
    expect(messageIndicatesPublisherNotAuthorized(message)).toBe(true);
  });

  it('accepts the context graph id as a string as well as a bigint', () => {
    expect(formatPublisherNotAuthorizedMessage(ADDR, '7'))
      .toBe(formatPublisherNotAuthorizedMessage(ADDR, 7n));
  });

  it('still matches when the message is re-wrapped with a prefix and lowercased', () => {
    const inner = formatPublisherNotAuthorizedMessage(ADDR, 7n);
    expect(messageIndicatesPublisherNotAuthorized(`publish failed: ${inner}`)).toBe(true);
    expect(messageIndicatesPublisherNotAuthorized(inner.toLowerCase())).toBe(true);
  });

  it('does not match unrelated publish failures or non-strings', () => {
    // Each of these must stay retryable. The sibling no-custodial and no-funded-wallet messages
    // are included because all three travel the same classifier.
    expect(messageIndicatesPublisherNotAuthorized('RPC submit timed out after 30s')).toBe(false);
    expect(messageIndicatesPublisherNotAuthorized(
      'No operational wallet has enough funds to publish to Verifiable Memory',
    )).toBe(false);
    expect(messageIndicatesPublisherNotAuthorized(
      formatPublishAuthorNotCustodialMessage('0xabc'),
    )).toBe(false);
    expect(messageIndicatesPublisherNotAuthorized(undefined)).toBe(false);
    expect(messageIndicatesPublisherNotAuthorized(null)).toBe(false);
    expect(messageIndicatesPublisherNotAuthorized(
      { message: PUBLISHER_NOT_AUTHORIZED_MESSAGE_MARKER },
    )).toBe(false);
  });
});
