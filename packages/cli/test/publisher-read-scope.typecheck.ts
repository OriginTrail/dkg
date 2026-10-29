// SPDX-License-Identifier: Apache-2.0
import type { PublisherReadScope, PublisherJournalReadResult } from '@origintrail-official/dkg-publisher';
const graph: PublisherReadScope = { kind: 'context-graph', contextGraphId: 'private' };
const operator: PublisherReadScope = { kind: 'operator-only' };
const missing: PublisherReadScope = { kind: 'missing' };
// @ts-expect-error graph ownership requires its canonical id
const absentId: PublisherReadScope = { kind: 'context-graph' };
// @ts-expect-error operator-only scope cannot carry an invented graph
const inventedId: PublisherReadScope = { kind: 'operator-only', contextGraphId: 'public' };
function ownedGraph(result: PublisherJournalReadResult): string | undefined {
  return result.scope.kind === 'context-graph' ? result.scope.contextGraphId : undefined;
}
void [graph, operator, missing, absentId, inventedId, ownedGraph];
