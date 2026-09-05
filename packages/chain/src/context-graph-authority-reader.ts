// SPDX-License-Identifier: Apache-2.0

import type {
  ChainAdapter,
  ChainReadOptions,
  ContextGraphAuthoritySnapshot,
} from './chain-adapter.js';

/** Required finalized Context Graph authority read surface. */
export interface ContextGraphAuthorityReader {
  getContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
    options?: ChainReadOptions,
  ): Promise<ContextGraphAuthoritySnapshot>;
}

export type ContextGraphAuthorityReaderCapability =
  | Readonly<{
      status: 'supported';
      reader: ContextGraphAuthorityReader;
    }>
  | Readonly<{
      status: 'unsupported';
      reason: 'get-context-graph-authority-snapshot-unavailable';
    }>;

const UNSUPPORTED_CONTEXT_GRAPH_AUTHORITY_READER = Object.freeze({
  status: 'unsupported' as const,
  reason: 'get-context-graph-authority-snapshot-unavailable' as const,
});

/**
 * Bind the optional broad-adapter method once into an explicit capability.
 * NoChain and legacy adapters remain valid ChainAdapters, while consumers that
 * require finalized authority can depend on a non-optional reader.
 */
export function bindContextGraphAuthorityReader(
  adapter: ChainAdapter,
): ContextGraphAuthorityReaderCapability {
  const readSnapshot = adapter.getContextGraphAuthoritySnapshot;
  if (typeof readSnapshot !== 'function') {
    return UNSUPPORTED_CONTEXT_GRAPH_AUTHORITY_READER;
  }
  return Object.freeze({
    status: 'supported' as const,
    reader: Object.freeze({
      getContextGraphAuthoritySnapshot: (
        contextGraphId: bigint,
        options?: ChainReadOptions,
      ) => readSnapshot.call(adapter, contextGraphId, options),
    }),
  });
}
