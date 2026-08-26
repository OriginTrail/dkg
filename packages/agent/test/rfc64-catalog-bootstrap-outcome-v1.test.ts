// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { classifyRfc64CatalogBootstrapFailureV1 } from '../src/dkg-agent-rfc64-catalog-bootstrap.js';
import { Rfc64CatalogReconciliationTerminalErrorV1 } from '../src/index.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
import { Rfc64PublicCatalogNativeReceiverErrorV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  Rfc64CatalogProviderFailureAggregateV1,
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
    const knownIncomplete = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: new Rfc64PublicCatalogNativeReceiverErrorV1(
        'catalog-native-receiver-incomplete',
        'current private finalized reconciliation is incomplete',
      ),
    });
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
    const compositionFailure = new FinalizedVmCompositionErrorV1(
      'finalized-vm-composition-incomplete',
      'one private finalized placement is absent',
    );
    const receiverFailure = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-activation',
      'the exact precommit failed',
      { cause: compositionFailure },
    );
    const synchronizationFailure = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: receiverFailure,
    });

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
    const synchronizationFailure = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: receiverFailure,
    });

    expect(classifyRfc64CatalogBootstrapFailureV1(true, synchronizationFailure)).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
    expect(classifyRfc64CatalogBootstrapFailureV1(false, synchronizationFailure)).toEqual({
      outcome: 'failed',
      completionReason: null,
    });
  });

  it('keeps mixed provider failures operational in both orders', () => {
    const timeout = new Error('provider transport timed out');
    const incomplete = new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-incomplete',
      'the authorized provider does not have the signed bundle',
    );
    for (const providerErrors of [
      [timeout, incomplete],
      [incomplete, timeout],
    ]) {
      const aggregate = new Rfc64CatalogProviderFailureAggregateV1(2, providerErrors.map(
        (error, index) => ({ providerPeerId: `peer-${index}`, error }),
      ));
      const serviceFailure = new Rfc64CatalogReconciliationTerminalErrorV1({
        outcome: 'failed',
        error: aggregate,
      });
      expect(classifyRfc64CatalogReconciliationTerminalReasonV1(aggregate)).toBeNull();
      expect(classifyRfc64CatalogBootstrapFailureV1(true, serviceFailure)).toEqual({
        outcome: 'failed',
        completionReason: null,
      });
    }
  });

  it('classifies only an all-incomplete provider set as known-incomplete', () => {
    const aggregate = new Rfc64CatalogProviderFailureAggregateV1(2, [0, 1].map((index) => ({
      providerPeerId: `peer-${index}`,
      error: new Rfc64PublicCatalogNativeReceiverErrorV1(
        'catalog-native-receiver-incomplete',
        'the authorized provider does not have the signed bundle',
      ),
    })));
    const serviceFailure = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: aggregate,
    });
    expect(classifyRfc64CatalogReconciliationTerminalReasonV1(aggregate))
      .toBe('no-authorized-provider');
    expect(classifyRfc64CatalogBootstrapFailureV1(true, serviceFailure)).toEqual({
      outcome: 'known-incomplete',
      completionReason: 'no-authorized-provider',
    });
  });

  it('keeps every non-success completion structurally distinguishable', () => {
    const dropped = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'dropped',
      error: null,
    });
    const failed = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: new Error('unclassified failure'),
    });
    expect(dropped).toMatchObject({ outcome: 'dropped', terminalReason: null });
    expect(failed).toMatchObject({ outcome: 'failed', terminalReason: null });
  });
});
