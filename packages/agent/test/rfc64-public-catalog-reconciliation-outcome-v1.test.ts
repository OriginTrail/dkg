// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { Rfc64CatalogSynchronizationErrorV1 } from '../src/dkg-agent-rfc64-catalog-sync.js';
import { Rfc64CatalogReconciliationTerminalErrorV1 } from
  '../src/rfc64/public-catalog-reconciliation-failure-v1.js';
import {
  RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1,
  isRfc64CatalogReconciliationFailureOutcomeV1,
} from '../src/rfc64/public-catalog-reconciliation-outcome-v1.js';

describe('RFC-64 canonical reconciliation outcome v1', () => {
  it('owns the complete closed receiver outcome set and derives failures from it', () => {
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1).toEqual([
      'already-applied',
      'applied',
      'staged-only',
      'not-found',
      'failed',
      'dropped',
      'closed',
    ]);
    expect(Object.isFrozen(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1)).toBe(true);
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1.map(
      isRfc64CatalogReconciliationFailureOutcomeV1,
    )).toEqual([false, false, true, true, true, true, true]);
    expect(isRfc64CatalogReconciliationFailureOutcomeV1('unknown')).toBe(false);
  });

  it('keeps modern terminal errors compatible with the historical class and fields', () => {
    const terminal = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: Object.assign(new Error('receiver failed'), { code: 'receiver-code' }),
    });

    expect(terminal).toBeInstanceOf(Rfc64CatalogSynchronizationErrorV1);
    expect(terminal).toMatchObject({
      code: 'receiver-code',
      outcome: 'failed',
      terminalReason: null,
    });
    expect(new Rfc64CatalogSynchronizationErrorV1(
      'no-authorized-provider',
      'legacy-code',
    )).toMatchObject({
      code: 'legacy-code',
      terminalReason: 'no-authorized-provider',
    });
  });
});
