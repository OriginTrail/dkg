// SPDX-License-Identifier: Apache-2.0

/**
 * One dkg:publishedAt per share operation.
 *
 * StorageACK copies of one share carry the same deterministic operation id on
 * every Core, and each Core stamps its copy with its own clock. Catch-up and
 * recovery used to add a peer's copy of an operation to the local store as a
 * plain union, so a holder that already stored the operation ended up with two
 * stamps on it. The holder's head resolver reads such an operation as its
 * earliest stamp and never repaired it, while the recovery parser of every
 * Core that later caught up from that holder rejected the operation, and with
 * it every descriptor of the graph.
 *
 * Both sides now follow the head resolver's rule: an operation is dated by its
 * earliest stamp. Readers accept several stamps on one operation; writers keep
 * only the earliest when they add a copy to a store that already holds one.
 */

import { assertSafeIri, formatSparqlTerm, isSafeIri } from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { decodeWorkspaceOperationTimestamp, isResolverWorkspaceOperationTimestamp } from '@origintrail-official/dkg-publisher';

import { filterOversizedSyncQuads, insertPrefilteredSyncQuads, type OversizeGuardHooks } from './oversize-filter.js';

const PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';
/** Operation subjects per stored-stamp read. */
const READ_CHUNK = 100;
const RETIREMENT_TUPLES = 100;
const RETIREMENT_BYTES = 256 * 1024;

export { operationPublishedAtMs } from './swm-operation-timestamp-reader.js';

export interface OperationPublishedAtPlan {
  /** The rows to write, including every selected winner even when it was already stored. */
  readonly rows: Quad[];
  /** Each group's stored losers and the selected winner required before retiring them. */
  readonly retirements: readonly {
    readonly rows: readonly Quad[];
    readonly winner: Quad;
  }[];
}

export interface OperationPublishedAtGroup {
  readonly graph: string;
  readonly subject: string;
  readonly incoming: readonly string[];
  readonly stored: readonly string[];
}

/** Complete groups retain stored evidence even when every incoming stamp was filtered. */
export function planOperationPublishedAt(groups: readonly OperationPublishedAtGroup[]): OperationPublishedAtPlan {
  const rows: Quad[] = [];
  const retirements: OperationPublishedAtPlan['retirements'][number][] = [];
  for (const { graph, subject, incoming, stored } of groups) {
    const stampRow = (object: string): Quad => ({ graph, subject, predicate: PUBLISHED_AT, object });
    // A historical stored value may also exceed today's canonical ingest bound.
    const acceptedStored = filterOversizedSyncQuads(stored.map(stampRow)).kept;
    const candidates: StampCandidate[] = [
      ...acceptedStored.map(({ object }) => ({ object, source: 'stored' as const })),
      ...incoming.map(object => ({ object, source: 'incoming' as const })),
    ];
    if (candidates.length === 0) continue;
    const winner = candidates.reduce((best, candidate) => compareStamps(candidate, best) < 0 ? candidate : best);
    const winnerRow = stampRow(winner.object);
    rows.push(winnerRow);
    const losers = stored.filter(object => object !== winner.object).map(stampRow);
    if (losers.length > 0) retirements.push({ rows: losers, winner: winnerRow });
  }
  return { rows, retirements };
}

/**
 * Own guarded persistence of `rows`, keeping one publishedAt per share operation:
 * read the stamps `store` holds for the operations the rows stamp, write the
 * planned rows, then conditionally delete the stored stamps that lost. An interruption
 * between the two leaves an extra stamp, never none, and the next write of the
 * operation removes it.
 */
export async function insertKeepingOnePublishedAt(
  store: TripleStore,
  rows: readonly Quad[],
  options: { source: string; seam: string; recordDrops: OversizeGuardHooks['recordDrops'] },
): Promise<Quad[]> {
  const { source, seam, recordDrops } = options;
  const filtered = filterOversizedSyncQuads(rows);
  if (filtered.dropped.length > 0) recordDrops(filtered.dropped, seam);
  const targets = new Map<string, Set<string>>();
  const groups = new Map<string, { graph: string; subject: string; incoming: string[]; stored: string[] }>();
  for (const row of rows) {
    if (!isOperationPublishedAtRow(row) || !isSafeIri(row.graph) || !isSafeIri(row.subject)) continue;
    targets.set(row.graph, (targets.get(row.graph) ?? new Set<string>()).add(row.subject));
    const key = `${row.graph}\u0000${row.subject}`;
    if (!groups.has(key)) groups.set(key, { graph: row.graph, subject: row.subject, incoming: [], stored: [] });
  }
  if (targets.size === 0) return insertPrefilteredSyncQuads(
    rows => store.insert(rows, { priority: 'background', source: `${source}.insert` }),
    filtered.kept, { recordDrops }, seam,
  );
  const otherRows: Quad[] = [];
  for (const row of filtered.kept) {
    const group = isOperationPublishedAtRow(row) ? groups.get(`${row.graph}\u0000${row.subject}`) : undefined;
    if (group) group.incoming.push(row.object); else otherRows.push(row);
  }
  for (const [graph, subjectSet] of targets) {
    const subjects = [...subjectSet];
    for (let start = 0; start < subjects.length; start += READ_CHUNK) {
      const chunk = subjects.slice(start, start + READ_CHUNK);
      const result = await store.query(
        `SELECT ?s ?o WHERE { GRAPH <${graph}> { `
        + `VALUES ?s { ${chunk.map((subject) => `<${subject}>`).join(' ')} } `
        + `?s <${PUBLISHED_AT}> ?o } }`,
        { priority: 'background', source: `${source}.readPublishedAt` },
      );
      // Stamps that cannot be read cannot be weighed, and a blind union is
      // exactly what this prevents.
      if (result.type !== 'bindings') {
        throw new Error(`Unexpected ${result.type} result reading stored publishedAt in ${graph}`);
      }
      for (const binding of result.bindings) {
        const subject = binding['s'];
        const object = binding['o'];
        if (!subject || !object) continue;
        const key = `${graph}\u0000${subject}`;
        groups.get(key)?.stored.push(object);
      }
    }
  }
  // The planner sees complete operation groups, including empty incoming sets.
  // Its selected stored winners are reinserted with metadata: a read alone is
  // not persistence evidence after concurrent operation cleanup.
  const plan = planOperationPublishedAt([...groups.values()]);
  assertUsableOperationTimestamps(targets, plan.rows);
  const inserted = await insertPrefilteredSyncQuads(
    rows => store.insert(rows, { priority: 'background', source: `${source}.insert` }),
    [...otherRows, ...plan.rows], { recordDrops }, seam,
  );
  assertUsableOperationTimestamps(targets, inserted);
  // The winning stamp must still exist in the SAME backend delete operation.
  // A recovery can replace all operation rows after our insert; an unconditional
  // delete based on the earlier read would then remove its only restored stamp.
  // Backends without UPDATE keep harmless duplicate stamps for a later repair.
  for (const { graph, sparql } of retirementUpdates(plan.retirements)) {
    const supported = await tryUpdateWithTouchedGraphs(store, sparql, [graph],
      { priority: 'background', source: `${source}.retirePublishedAt` });
    if (!supported) break;
  }
  return inserted;
}

/** Bounded set-based cleanup; every tuple retains its own operation's winner guard. */
function* retirementUpdates(retirements: OperationPublishedAtPlan['retirements']) {
  const graphs = new Map<string, string[]>();
  for (const { rows: losers, winner } of retirements) {
    const graph = assertSafeIri(winner.graph), subject = assertSafeIri(winner.subject);
    const winnerTerm = formatSparqlTerm(winner.object, { position: 'object' });
    let tuples = graphs.get(graph);
    if (!tuples) { tuples = []; graphs.set(graph, tuples); }
    for (const loser of losers) tuples.push(
      `(<${subject}> ${winnerTerm} ${formatSparqlTerm(loser.object, { position: 'object' })})`);
  }
  for (const [graph, tuples] of graphs) {
    const prefix = `DELETE { GRAPH <${graph}> { ?subject <${PUBLISHED_AT}> ?loser } } WHERE { `
      + `GRAPH <${graph}> { ?subject <${PUBLISHED_AT}> ?winner . ?subject <${PUBLISHED_AT}> ?loser } `
      + 'FILTER(!sameTerm(?loser, ?winner)) VALUES (?subject ?winner ?loser) { ';
    let batch: string[] = [], bytes = Buffer.byteLength(prefix) + 3;
    for (const tuple of tuples) {
      const tupleBytes = Buffer.byteLength(tuple) + 1;
      if (batch.length && (batch.length >= RETIREMENT_TUPLES || bytes + tupleBytes > RETIREMENT_BYTES)) {
        yield { graph, sparql: prefix + batch.join(' ') + ' } }' };
        batch = []; bytes = Buffer.byteLength(prefix) + 3;
      }
      batch.push(tuple); bytes += tupleBytes;
    }
    if (batch.length) yield { graph, sparql: prefix + batch.join(' ') + ' } }' };
  }
}

/** Never report a new operation as materialized without a persisted usable stamp. */
function assertUsableOperationTimestamps(
  targets: ReadonlyMap<string, ReadonlySet<string>>,
  rows: readonly Quad[],
): void {
  const incoming = new Set(rows.filter(row => isOperationPublishedAtRow(row) && usableStampMs(row.object) !== null)
    .map(row => `${row.graph}\u0000${row.subject}`));
  for (const [graph, subjects] of targets) for (const subject of subjects) {
    const key = `${graph}\u0000${subject}`;
    if (!incoming.has(key)) {
      throw new Error(`Cannot materialize SWM operation ${subject} without a usable publishedAt`);
    }
  }
}

/** A publishedAt row on a share operation in a shared-memory metadata graph. */
function isOperationPublishedAtRow(row: Quad): boolean {
  return row.predicate === PUBLISHED_AT
    && row.subject.startsWith('urn:dkg:share:')
    && row.graph.endsWith('/_shared_memory_meta');
}

/** Original evidence provenance preserves stored-value preference on a tie. */
interface StampCandidate {
  readonly object: string;
  readonly source: 'stored' | 'incoming';
}

/** A stamp the head resolver accepts, or null. */
function usableStampMs(object: string): number | null {
  const ms = decodeWorkspaceOperationTimestamp(object);
  return isResolverWorkspaceOperationTimestamp(ms) ? ms : null;
}

/** Usable before unusable, then earlier first, then stored before incoming. */
function compareStamps(left: StampCandidate, right: StampCandidate): number {
  const leftMs = usableStampMs(left.object);
  const rightMs = usableStampMs(right.object);
  if ((leftMs === null) !== (rightMs === null)) return leftMs === null ? 1 : -1;
  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) return leftMs - rightMs;
  if (left.source !== right.source) return left.source === 'incoming' ? 1 : -1;
  return left.object < right.object ? -1 : left.object > right.object ? 1 : 0;
}
