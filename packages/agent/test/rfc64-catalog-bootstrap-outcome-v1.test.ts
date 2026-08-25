// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { classifyRfc64CatalogBootstrapFailureV1 } from '../src/dkg-agent-rfc64-catalog-bootstrap.js';

describe('RFC-64 catalog bootstrap terminal outcome v1', () => {
  it('distinguishes absence, ordinary failure, and typed private VM incompleteness', () => {
    expect(classifyRfc64CatalogBootstrapFailureV1(true, null)).toEqual({
      outcome: 'not-found',
      completionReason: null,
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(true, new Error('RPC failed'))).toEqual({
      outcome: 'failed',
      completionReason: null,
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(false, Object.assign(
      new Error('public mismatch'),
      { code: 'finalized-vm-composition-incomplete' },
    ))).toEqual({
      outcome: 'failed',
      completionReason: null,
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(true, Object.assign(
      new Error('private author bytes are unavailable'),
      { code: 'finalized-vm-composition-incomplete' },
    ))).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
  });
});
