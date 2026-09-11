// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDecimalU256,
  type DecimalU256V1,
} from '@origintrail-official/dkg-core';

/** Canonical positive ContextGraphStorage identifier used by index views. */
export type ContextGraphAuthorityIndexId = DecimalU256V1;

export function assertContextGraphAuthorityIndexId(
  value: unknown,
  label = 'Context Graph authority index target id',
): asserts value is ContextGraphAuthorityIndexId {
  try {
    assertCanonicalDecimalU256(value, label);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (value === '0') throw new Error(`${label} is invalid`);
}

export function contextGraphAuthorityIndexIdFromBigInt(
  value: bigint,
): ContextGraphAuthorityIndexId {
  const decimal = typeof value === 'bigint' ? value.toString(10) : value;
  assertContextGraphAuthorityIndexId(decimal);
  return decimal;
}

export function normalizeContextGraphAuthorityIndexId(
  value: unknown,
): ContextGraphAuthorityIndexId | undefined {
  try {
    assertContextGraphAuthorityIndexId(value);
    return value;
  } catch {
    return undefined;
  }
}
