// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReconciliationTerminalReasonV1,
} from './public-catalog-reconciliation-outcome-v1.js';

/**
 * Historical synchronization error contract retained at its original module
 * path. New terminal errors extend this class so prototype and field checks
 * continue to work for package consumers.
 */
export class Rfc64CatalogSynchronizationErrorV1 extends Error {
  constructor(
    readonly terminalReason: Rfc64CatalogReconciliationTerminalReasonV1 | null,
    readonly code: string | null,
    options: ErrorOptions = {},
  ) {
    super(
      'RFC-64 current catalog head reconciliation failed'
      + ` (${terminalReason ?? code ?? 'unknown'})`,
      options,
    );
    this.name = 'Rfc64CatalogSynchronizationErrorV1';
  }
}
