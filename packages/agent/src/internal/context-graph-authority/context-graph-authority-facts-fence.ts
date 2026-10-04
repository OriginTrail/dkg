// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions } from '@origintrail-official/dkg-storage';
import type { ContextGraphReadAuthorityFactsSnapshot } from '../../context-graph-meta-projection.js';

interface GraphAuthorityFactsSource {
  readContextGraphAuthorityFactsRevision(contextGraphId: string): string;
}
interface ReadAuthorityFactsSource {
  readonly readAuthorityFactsRevision: number;
  findContextGraphIdsWithReadAuthorityFacts(
    contextGraphIds: readonly string[], options: QueryOptions,
  ): Promise<ReadonlySet<string>>;
}

/** Own the comparison for one source-qualified metadata proof. */
export function captureContextGraphAuthorityFactsFence(
  source: GraphAuthorityFactsSource,
  contextGraphId: string,
): Readonly<{ assertCurrent(): boolean }> {
  const revision = source.readContextGraphAuthorityFactsRevision(contextGraphId);
  return Object.freeze({
    assertCurrent: () => source.readContextGraphAuthorityFactsRevision(contextGraphId) === revision,
  });
}

/**
 * Capture an owned request-local absence snapshot. Consumers never compare
 * revision counters themselves; they ask this projection whether its proof
 * is still current at the exact point where absence would be used.
 */
export async function prepareReadAuthorityFactsSnapshot(
  source: ReadAuthorityFactsSource,
  contextGraphIds: readonly string[],
  options: QueryOptions,
): Promise<ContextGraphReadAuthorityFactsSnapshot> {
  const revision = source.readAuthorityFactsRevision;
  const present = new Set(
    await source.findContextGraphIdsWithReadAuthorityFacts(contextGraphIds, options),
  );
  options.signal?.throwIfAborted();
  return Object.freeze({
    assertCurrent: () => source.readAuthorityFactsRevision === revision,
    isAbsent: (contextGraphId: string) => !present.has(contextGraphId),
  });
}
