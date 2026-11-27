// SPDX-License-Identifier: Apache-2.0

import {
  Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1,
  Rfc64PublicCatalogNativeTransportErrorV1,
} from '@origintrail-official/dkg-agent';

const EXPECTED_PRIVATE_DENIALS = Object.freeze([
  Object.freeze({
    ErrorClass: Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1,
    failureClass: 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
    failureCode: 'catalog-discovery-policy-denied',
  }),
  Object.freeze({
    ErrorClass: Rfc64PublicCatalogNativeTransportErrorV1,
    failureClass: 'Rfc64PublicCatalogNativeTransportErrorV1',
    failureCode: 'catalog-native-policy-denied',
  }),
]);

/**
 * Accept only a typed RFC-64 policy denial. Aggregate/wrapper errors are safe
 * only when every terminal branch is the same typed denial. A timeout,
 * protocol failure, or provider failure in any branch makes the probe fail.
 */
export function classifyExpectedPrivateCatalogDenialV1(error) {
  const terminal = collectTerminalDenialsV1(error, new Set());
  if (terminal === null || terminal.length < 1) return null;
  const first = terminal[0];
  if (terminal.some((item) => (
    item.failureClass !== first.failureClass || item.failureCode !== first.failureCode
  ))) return null;
  return Object.freeze({ ...first });
}

/** Exact parent-process proof shape. Boolean flags alone are not evidence. */
export function isExpectedPrivateCatalogDenialResultV1(value) {
  if (
    value === null
    || typeof value !== 'object'
    || value.denied !== true
    || value.applied !== false
  ) return false;
  return EXPECTED_PRIVATE_DENIALS.some(({ failureClass, failureCode }) => (
    value.failureClass === failureClass && value.failureCode === failureCode
  ));
}

function collectTerminalDenialsV1(error, seen) {
  if (error === null || typeof error !== 'object' || seen.has(error)) return null;
  seen.add(error);

  if (error instanceof AggregateError) {
    if (error.errors.length < 1) return null;
    const collected = [];
    for (const child of error.errors) {
      const childDenials = collectTerminalDenialsV1(child, seen);
      if (childDenials === null) return null;
      collected.push(...childDenials);
    }
    return collected;
  }

  for (const expected of EXPECTED_PRIVATE_DENIALS) {
    if (error instanceof expected.ErrorClass && error.code === expected.failureCode) {
      return [{
        failureClass: expected.failureClass,
        failureCode: expected.failureCode,
      }];
    }
  }

  return 'cause' in error && error.cause !== undefined
    ? collectTerminalDenialsV1(error.cause, seen)
    : null;
}
