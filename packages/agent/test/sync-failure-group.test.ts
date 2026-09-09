import { expect, it } from 'vitest';
import { OversizedRdfLiteralError } from '@origintrail-official/dkg-core';
import {
  combineSyncFailures, didSyncPeerRespond, isKnownRetryableSyncTransportInterruption,
  isSyncBackoffWorthyError, isSyncPermanentRejection, isSyncTransportFailure,
  isSyncValidationRejection, toSyncPeerRespondedError, toSyncTransportFailureError,
  toSyncValidationRejectionError,
} from '../src/sync/error-tags.js';

it('preserves single frozen error identity and side-channel tags', () => {
  const error = toSyncTransportFailureError(Object.freeze(new Error('stream reset')));
  const combined = combineSyncFailures(error, [error]);
  expect(combined).toBe(error);
  expect(isSyncTransportFailure(combined)).toBe(true);
  expect(isKnownRetryableSyncTransportInterruption(combined)).toBe(true);
});

it('retains every secondary classification without replacing the triggering local failure', () => {
  const primary = new Error('disk write failed');
  const denial = Object.freeze(Object.assign(new Error('denied'), { syncDenied: true }));
  const transport = toSyncTransportFailureError(Object.freeze(new Error('stream reset')));
  const permanent = new OversizedRdfLiteralError({ actualBytes: 100, maxBytes: 10 });
  const rejected = toSyncValidationRejectionError(Object.freeze(new Error('invalid response')));
  const group = combineSyncFailures(primary, [denial, transport, permanent, rejected, primary]);
  expect(group).toMatchObject({ cause: primary, errors: [primary, denial, transport, permanent, rejected], syncDenied: true });
  expect(didSyncPeerRespond(group)).toBe(true);
  expect(isSyncTransportFailure(group)).toBe(true);
  expect(isSyncBackoffWorthyError(group)).toBe(true);
  expect(isSyncPermanentRejection(group)).toBe(true);
  expect(isSyncValidationRejection(group)).toBe(true);
  expect(isKnownRetryableSyncTransportInterruption(group)).toBe(false);
});

it('allows transport-prefix recovery only when every concurrent cause permits it', () => {
  const first = toSyncTransportFailureError(new Error('first reset'));
  const second = toSyncTransportFailureError(new Error('second reset'));
  expect(isKnownRetryableSyncTransportInterruption(combineSyncFailures(first, [second]))).toBe(true);
  const responded = toSyncPeerRespondedError(Object.freeze(new Error('invalid page')));
  const group = combineSyncFailures(first, [responded]);
  expect(didSyncPeerRespond(group)).toBe(true);
  expect(isKnownRetryableSyncTransportInterruption(group)).toBe(false);
});

it('honors a response classification added to the group by a later boundary', () => {
  const group = combineSyncFailures(
    toSyncTransportFailureError(new Error('first reset')),
    [toSyncTransportFailureError(new Error('second reset'))],
  );
  toSyncPeerRespondedError(group);
  expect(didSyncPeerRespond(group)).toBe(true);
  expect(isKnownRetryableSyncTransportInterruption(group)).toBe(false);
});
