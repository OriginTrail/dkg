// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { classifyRfc64CatalogBootstrapFailureV1 } from '../src/dkg-agent-rfc64-catalog-bootstrap.js';
import { Rfc64CatalogSynchronizationErrorV1 } from '../src/dkg-agent-rfc64-catalog-sync.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
import { Rfc64PublicCatalogNativeReceiverErrorV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  Rfc64PublicCatalogReconciliationFailureRegistryV1,
  classifyRfc64CatalogReconciliationTerminalReasonV1,
} from '../src/rfc64/public-catalog-reconciliation-failure-v1.js';

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
    const knownIncomplete = new Rfc64CatalogSynchronizationErrorV1(
      'no-authorized-provider',
      'catalog-native-receiver-activation',
    );
    expect(classifyRfc64CatalogBootstrapFailureV1(false, knownIncomplete)).toEqual({
      outcome: 'failed',
      completionReason: null,
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(true, knownIncomplete)).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
  });

  it('propagates the typed VM terminal reason without exception-depth inspection', () => {
    const headDigest = `0x${'12'.repeat(32)}` as never;
    const registry = new Rfc64PublicCatalogReconciliationFailureRegistryV1();
    const compositionFailure = new FinalizedVmCompositionErrorV1(
      'finalized-vm-composition-incomplete',
      'one private finalized placement is absent',
    );
    const receiverFailure = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-activation',
      'the exact precommit failed',
      { cause: compositionFailure },
    );
    registry.beginAttempt(headDigest);
    registry.record(
      headDigest,
      receiverFailure,
      classifyRfc64CatalogReconciliationTerminalReasonV1(receiverFailure),
    );
    const attempt = registry.readCurrentAttempt(headDigest)!;
    const synchronizationFailure = new Rfc64CatalogSynchronizationErrorV1(
      attempt.terminalReason,
      attempt.errorCode,
    );

    expect(classifyRfc64CatalogBootstrapFailureV1(true, synchronizationFailure)).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
  });

  it('classifies a signed catalog row with unavailable bytes as known-incomplete for private VM', () => {
    const receiverFailure = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-incomplete',
      'the authorized provider does not have the bundle named by the signed row',
    );
    const terminalReason = classifyRfc64CatalogReconciliationTerminalReasonV1(receiverFailure);
    const synchronizationFailure = new Rfc64CatalogSynchronizationErrorV1(
      terminalReason,
      receiverFailure.code,
    );

    expect(classifyRfc64CatalogBootstrapFailureV1(true, synchronizationFailure)).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(false, synchronizationFailure)).toEqual({
      outcome: 'failed',
      completionReason: null,
    });
  });
});
