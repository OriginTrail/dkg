// SPDX-License-Identifier: Apache-2.0

import type { ReadGraphPlannedMethod } from './adapter-contract.js';

export const READ_GRAPHS_UNSUPPORTED_CODE = 'READ_GRAPHS_UNSUPPORTED';

/** Settings that keep read graphs, for a store whose adapter does not send read-graph operations with every write it implements. */
export class ReadGraphsUnsupportedError extends Error {
  readonly code = READ_GRAPHS_UNSUPPORTED_CODE;

  constructor(readonly backend: string, readonly missingMethods: readonly ReadGraphPlannedMethod[], message?: string) {
    super(message ?? `Read graphs are on, but the ${backend} adapter does not send read-graph operations with ${missingMethods.join(', ')}`);
    this.name = 'ReadGraphsUnsupportedError';
  }
}
