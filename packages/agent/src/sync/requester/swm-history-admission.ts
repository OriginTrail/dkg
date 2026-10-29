import type { Quad } from '@origintrail-official/dkg-storage';
import { decodeWorkspaceOperationTimestamp, isResolverWorkspaceOperationTimestamp } from '@origintrail-official/dkg-publisher';
import { filterOversizedSyncQuads } from '../oversize-filter.js';

/** Historical operation rows cannot prevent a valid current head from completing.
 * Quarantine the whole unusable history group, including its snapshot manifest.
 * Every referenced operation stays untouched for strict head/materialization checks.
 */
export function quarantineUnusableSwmHistory(
  rows: readonly Quad[],
  referenced: readonly Pick<Quad, 'graph' | 'subject'>[],
): Quad[] {
  const key = (row: Pick<Quad, 'graph' | 'subject'>) => `${row.graph}\u0000${row.subject}`;
  const required = new Set(referenced.map(key));
  const candidates = new Set<string>(), usable = new Set<string>();
  for (const row of rows) {
    if (!row.subject.startsWith('urn:dkg:share:') || !row.graph.endsWith('/_shared_memory_meta')) continue;
    const identity = key(row);
    candidates.add(identity);
    if (row.predicate === 'http://dkg.io/ontology/publishedAt'
      && filterOversizedSyncQuads([row]).kept.length > 0
      && isResolverWorkspaceOperationTimestamp(decodeWorkspaceOperationTimestamp(row.object))) usable.add(identity);
  }
  const quarantined = new Set([...candidates].filter(identity => !required.has(identity) && !usable.has(identity)));
  return rows.filter(row => !quarantined.has(key(row)));
}
