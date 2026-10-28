// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { earliestWorkspaceOperationTimestamp } from '@origintrail-official/dkg-publisher';

const PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';

/**
 * An operation's publishedAt as the head resolver reads it: the earliest
 * stamp. A missing or unparseable stamp still fails closed.
 */
export function operationPublishedAtMs(rows: readonly Quad[], operationSubject: string): number {
  const earliest = earliestWorkspaceOperationTimestamp(
    rows.filter((row) => row.predicate === PUBLISHED_AT).map((row) => row.object));
  if (earliest === undefined) throw new Error('missing publishedAt');
  if (!Number.isFinite(earliest)) {
    throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publishedAt`);
  }
  return earliest;
}

