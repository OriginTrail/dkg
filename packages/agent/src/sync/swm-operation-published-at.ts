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

import { canonicalQuadKey } from './requester/quad-key.js';
import { assertSafeIri, isSafeIri } from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { formatCanonicalRdfLiteralTerm, parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { decodeWorkspaceOperationTimestamp, earliestWorkspaceOperationTimestamp, isResolverWorkspaceOperationTimestamp } from '@origintrail-official/dkg-publisher';

import { filterOversizedSyncQuads, insertPrefilteredSyncQuads, type OversizeGuardHooks } from './oversize-filter.js';

const PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';
/** Operation subjects per stored-stamp read. */
const READ_CHUNK = 100;

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

export interface OperationPublishedAtPlan {
  /** The rows to write: the input without the incoming stamps that lose. */
  readonly rows: Quad[];
  /** Each group's stored losers and the incoming winner required before retiring them. */
  readonly retirements: readonly {
    readonly rows: readonly Quad[];
    readonly winner: Quad;
    readonly requiredReplacement?: Quad;
  }[];
}

/**
 * The rows that add verified metadata to a store holding `stored` without
 * giving a share operation a second stamp. The earliest stamp the head
 * resolver accepts is kept: it is the value the resolver already reported for
 * a union, and copies stamped later leave it unchanged.
 *
 * `stored` maps `${graph}\u0000${subject}` to the stamps the store holds.
 */
export function planOperationPublishedAt(
  rows: readonly Quad[],
  stored: ReadonlyMap<string, readonly string[]>,
): OperationPublishedAtPlan {
  const incoming = new Map<string, Quad[]>();
  for (const row of rows) {
    if (!isOperationPublishedAtRow(row)) continue;
    const key = `${row.graph}\u0000${row.subject}`;
    incoming.set(key, [...(incoming.get(key) ?? []), row]);
  }
  const kept = new Set<Quad>();
  const retirements: OperationPublishedAtPlan['retirements'][number][] = [];
  for (const [key, stamps] of incoming) {
    const { graph, subject } = stamps[0]!;
    const storedObjects = stored.get(key) ?? [];
    const winner = [
      ...storedObjects.map((object): StampCandidate => ({ object })),
      ...stamps.map((row): StampCandidate => ({ object: row.object, row })),
    ].reduce((best, candidate) => (compareStamps(candidate, best) < 0 ? candidate : best));
    if (winner.row) kept.add(winner.row);
    const retiring: Quad[] = [];
    for (const object of storedObjects) {
      if (winner.row || object !== winner.object) {
        retiring.push({ subject, predicate: PUBLISHED_AT, object, graph });
      }
    }
    if (retiring.length > 0) {
      retirements.push({ rows: retiring, winner: { subject, predicate: PUBLISHED_AT, object: winner.object, graph }, ...(winner.row ? { requiredReplacement: winner.row } : {}) });
    }
  }
  return {
    rows: rows.filter((row) => !isOperationPublishedAtRow(row) || kept.has(row)),
    retirements,
  };
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
  for (const row of rows) {
    if (!isOperationPublishedAtRow(row) || !isSafeIri(row.graph) || !isSafeIri(row.subject)) continue;
    targets.set(row.graph, (targets.get(row.graph) ?? new Set<string>()).add(row.subject));
  }
  const stored = new Map<string, string[]>();
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
        stored.set(key, [...(stored.get(key) ?? []), object]);
      }
    }
  }
  // Select only stamps that can survive the canonical ingest filter. Otherwise
  // an oversized early winner could discard the only writable later stamp.
  const plan = planOperationPublishedAt(filtered.kept, stored);
  assertUsableOperationTimestamps(targets, stored, plan.rows);
  const inserted = await insertPrefilteredSyncQuads(
    rows => store.insert(rows, { priority: 'background', source: `${source}.insert` }),
    plan.rows, { recordDrops }, seam,
  );
  assertUsableOperationTimestamps(targets, stored, inserted);
  const written = new Set(inserted.map(canonicalQuadKey));
  // The winning stamp must still exist in the SAME backend delete operation.
  // A recovery can replace all operation rows after our insert; an unconditional
  // delete based on the earlier read would then remove its only restored stamp.
  // Backends without UPDATE keep harmless duplicate stamps for a later repair.
  for (const { rows: losers, winner, requiredReplacement } of plan.retirements) {
    if (requiredReplacement && !written.has(canonicalQuadKey(requiredReplacement))) continue;
    const graph = assertSafeIri(winner.graph), subject = assertSafeIri(winner.subject);
    const term = (object: string): string => {
      const literal = parseRdfLiteralTerm(object);
      return literal === null ? `<${assertSafeIri(object)}>` : formatCanonicalRdfLiteralTerm(literal);
    };
    const winnerTerm = term(winner.object);
    await tryUpdateWithTouchedGraphs(store,
      `DELETE { GRAPH <${graph}> { <${subject}> <${PUBLISHED_AT}> ?loser } } WHERE { `
      + `GRAPH <${graph}> { <${subject}> <${PUBLISHED_AT}> ${winnerTerm} . `
      + `<${subject}> <${PUBLISHED_AT}> ?loser } `
      + `VALUES ?loser { ${losers.map(row => term(row.object)).join(' ')} } `
      + `FILTER(!sameTerm(?loser, ${winnerTerm})) }`,
      [graph], { priority: 'background', source: `${source}.retirePublishedAt` });
  }
  return inserted;
}

/** Never report a new operation as materialized without a persisted usable stamp. */
function assertUsableOperationTimestamps(
  targets: ReadonlyMap<string, ReadonlySet<string>>,
  stored: ReadonlyMap<string, readonly string[]>,
  rows: readonly Quad[],
): void {
  const incoming = new Set(rows.filter(row => isOperationPublishedAtRow(row) && usableStampMs(row.object) !== null)
    .map(row => `${row.graph}\u0000${row.subject}`));
  for (const [graph, subjects] of targets) for (const subject of subjects) {
    const key = `${graph}\u0000${subject}`;
    if (!incoming.has(key) && !(stored.get(key) ?? []).some(object => usableStampMs(object) !== null)) {
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

/** A stored stamp, or an incoming one with its row. */
interface StampCandidate {
  readonly object: string;
  readonly row?: Quad;
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
  if (Boolean(left.row) !== Boolean(right.row)) return left.row ? 1 : -1;
  return left.object < right.object ? -1 : left.object > right.object ? 1 : 0;
}
