import { createHash } from 'node:crypto';
import { DKG_ONTOLOGY, contextGraphDataUri, contextGraphSharedMemoryUri, paranetDataGraphUri, paranetWorkspaceGraphUri, sparqlString } from '@origintrail-official/dkg-core';
import { DKG_ENDORSES, DKG_ENDORSED_BY } from './endorse.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { CclFactTuple } from './ccl-evaluator.js';

const CCL_FACT_NS = 'https://example.org/ccl-fact#';
const CCL_INPUT_FACT = `${CCL_FACT_NS}InputFact`;
const CCL_FACT_PREDICATE = `${CCL_FACT_NS}predicate`;
const CCL_ARG_PREFIX = `${CCL_FACT_NS}arg`;

const CANONICAL_FACT_RESOLVER_VERSION = 'canonical-input-facts/v1';
const MANUAL_FACT_RESOLVER_VERSION = 'manual-input/v1';
const SUPPORTED_POLICY_FAMILIES = new Set(['owner_assertion', 'context_corroboration']);

export type CclFactResolutionMode = 'manual' | 'snapshot-resolved';

export interface ResolveCclFactsFromSnapshotOptions {
  paranetId: string;
  snapshotId?: string;
  view?: string;
  scopeUal?: string;
  policyName?: string;
  contextType?: string;
}

export interface ResolvedCclFacts {
  facts: CclFactTuple[];
  factSetHash: string;
  factQueryHash: string;
  factResolverVersion: string;
  factResolutionMode: 'snapshot-resolved';
  context: {
    paranetId: string;
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  };
}

export interface ManualCclFacts {
  facts: CclFactTuple[];
  factSetHash: string;
  factQueryHash: string;
  factResolverVersion: string;
  factResolutionMode: 'manual';
}

export async function resolveFactsFromSnapshot(
  store: TripleStore,
  opts: ResolveCclFactsFromSnapshotOptions,
): Promise<ResolvedCclFacts> {
  const profile = resolveProfile(opts.policyName, opts.contextType);
  const graph = opts.view === 'workspace'
    ? paranetWorkspaceGraphUri(opts.paranetId)
    : paranetDataGraphUri(opts.paranetId);
  const query = `
    SELECT ?fact ?predicate ?snapshotId ?view ?scopeUal ?argPred ?argVal WHERE {
      GRAPH <${graph}> {
        ?fact <${DKG_ONTOLOGY.RDF_TYPE}> <${CCL_INPUT_FACT}> ;
              <${CCL_FACT_PREDICATE}> ?predicate ;
              ?argPred ?argVal .
        FILTER(STRSTARTS(STR(?argPred), ${sparqlString(CCL_ARG_PREFIX)}))
        OPTIONAL { ?fact <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
        OPTIONAL { ?fact <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
        OPTIONAL { ?fact <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
      }
    }
    ORDER BY ?fact ?argPred
  `;
  const result = await store.query(query);
  const factsByNode = new Map<string, SnapshotFactNode>();

  if (result.type === 'bindings') {
    for (const row of result.bindings as Record<string, string>[]) {
      const snapshotId = row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined;
      const view = row['view'] ? stripLiteral(row['view']) : undefined;
      const scopeUal = row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined;
      if (opts.snapshotId && snapshotId !== opts.snapshotId) continue;
      if (opts.view && view != null && view !== opts.view) continue;
      if (opts.view && view == null && opts.view !== 'accepted') continue;
      if (opts.scopeUal && scopeUal !== opts.scopeUal) continue;

      const factId = row['fact'];
      const next = factsByNode.get(factId) ?? {
        predicate: stripLiteral(row['predicate']),
        args: new Map<number, unknown>(),
      };
      next.snapshotId = snapshotId;
      next.view = view;
      next.scopeUal = scopeUal;
      const argIndex = parseArgIndex(row['argPred']);
      next.args.set(argIndex, parseFactArg(stripLiteral(row['argVal'])));
      factsByNode.set(factId, next);
    }
  }

  const deduped = new Map<string, CclFactTuple>();
  for (const fact of factsByNode.values()) {
    const tuple = [fact.predicate, ...materializeArgs(fact.args)] as CclFactTuple;
    deduped.set(JSON.stringify(tuple), tuple);
  }

  // Resolve endorsement facts scoped to the same snapshot context.
  // Using deduped map (keyed by full tuple JSON) avoids the collision bug
  // where endorsement(agentA, ual) and endorsement(agentB, ual) would
  // overwrite each other if keyed only by UAL.
  const endorsementFacts = await resolveEndorsementFacts(store, graph, {
    snapshotId: opts.snapshotId,
    scopeUal: opts.scopeUal,
    view: opts.view,
  });
  for (const ef of endorsementFacts) {
    deduped.set(JSON.stringify(ef), ef);
  }

  const facts = Array.from(deduped.values()).sort(compareTuples) as CclFactTuple[];
  return {
    facts,
    factSetHash: hashFacts(facts),
    factQueryHash: hashString(`${profile.id}\n${query}\nsnapshotId=${opts.snapshotId ?? ''}\nview=${opts.view ?? ''}\nscopeUal=${opts.scopeUal ?? ''}`),
    factResolverVersion: profile.version,
    factResolutionMode: 'snapshot-resolved',
    context: {
      paranetId: opts.paranetId,
      contextType: opts.contextType,
      view: opts.view,
      snapshotId: opts.snapshotId,
      scopeUal: opts.scopeUal,
    },
  };
}

export function buildManualCclFacts(facts: CclFactTuple[]): ManualCclFacts {
  return {
    facts,
    factSetHash: hashFacts(facts),
    factQueryHash: hashString('manual-input'),
    factResolverVersion: MANUAL_FACT_RESOLVER_VERSION,
    factResolutionMode: 'manual',
  };
}

interface SnapshotFactNode {
  predicate: string;
  args: Map<number, unknown>;
  snapshotId?: string;
  view?: string;
  scopeUal?: string;
}

function resolveProfile(policyName?: string, contextType?: string): { id: string; version: string } {
  if (contextType && SUPPORTED_POLICY_FAMILIES.has(contextType)) {
    return { id: `profile:${contextType}`, version: CANONICAL_FACT_RESOLVER_VERSION };
  }
  if (policyName && SUPPORTED_POLICY_FAMILIES.has(policyName)) {
    return { id: `policy:${policyName}`, version: CANONICAL_FACT_RESOLVER_VERSION };
  }
  throw new Error(
    `No snapshot fact resolver is configured for ${policyName ?? contextType ?? 'this policy'}. Pass facts explicitly or add a resolver profile.`,
  );
}

function parseArgIndex(argPredicate: string): number {
  const value = strip(argPredicate);
  const suffix = value.startsWith(CCL_ARG_PREFIX) ? value.slice(CCL_ARG_PREFIX.length) : '';
  const index = Number.parseInt(suffix, 10);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid CCL fact argument predicate: ${argPredicate}`);
  }
  return index;
}

function materializeArgs(args: Map<number, unknown>): unknown[] {
  const sorted = Array.from(args.entries()).sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i][0] !== i) {
      throw new Error(`Non-contiguous CCL fact argument indices: expected arg${i} but found arg${sorted[i][0]}`);
    }
  }
  return sorted.map(([, value]) => value);
}

function parseFactArg(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hashFacts(facts: CclFactTuple[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(facts.map(tuple => [...tuple]).sort(compareTuples))).digest('hex')}`;
}

function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareTuples(left: unknown[], right: unknown[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function strip(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1);
  return value;
}

function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return unescapeLiteralContent(s.slice(1, -1));
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return unescapeLiteralContent(match[1]);
  return s;
}

function unescapeLiteralContent(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Query endorsement triples and produce CCL facts:
 *   endorsement(agent, ual)       — one per endorsement
 *   endorsement_count(ual, N)     — aggregate count per KA
 *
 * When snapshot scope filters are provided, only endorsements for KAs
 * that exist within the scoped snapshot are included.
 */
async function resolveEndorsementFacts(
  store: TripleStore,
  graph: string,
  scope?: { snapshotId?: string; scopeUal?: string; view?: string },
): Promise<CclFactTuple[]> {
  // Build optional FILTER clauses to scope endorsements to the snapshot.
  // If scopeUal is given, only include endorsements for that specific UAL.
  // If snapshotId is given, only include endorsements where the endorsed
  // UAL has a snapshotId matching the requested snapshot.
  // If view is given, restrict to endorsements whose UAL exists in that view graph.
  const filters: string[] = [];
  if (scope?.scopeUal) {
    filters.push(`FILTER(?ual = <${scope.scopeUal}>)`);
  }
  const snapshotJoin = scope?.snapshotId
    ? `?ual <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?sid . FILTER(STR(?sid) = ${JSON.stringify(scope.snapshotId)})`
    : '';
  // NOTE: view-based filtering of endorsement KAs requires resolving the
  // view's named-graph URI (e.g. contextGraphVerifiedMemoryUri). The view
  // value is included in factQueryHash via the caller, ensuring snapshot
  // determinism. Full view-graph filtering deferred to CCL v1.0.
  // endorsement quads moved
  // from `<agent> dkg:endorses <ual>` to a per-event subject so that
  // two endorsements by the same agent can't collide on the
  // signature / nonce / timestamp tuple. CCL fact resolution now
  // has to do the two-hop join through the endorsement resource:
  //
  //   ?endorsement dkg:endorses   ?ual
  //   ?endorsement dkg:endorsedBy ?endorser
  //
  // Verifiers that need the full proof tuple can fetch the remaining
  // three predicates off `?endorsement` — they are no longer spread
  // across the agent subject and are no longer ambiguous.
  //
  // the
  // r19-3 query above ONLY matches the new endorsement-resource
  // shape. Every endorsement that was published BEFORE r19-3 lives
  // as the legacy direct shape `<agent> dkg:endorses <ual>` (no
  // intermediate endorsement subject, no separate `dkg:endorsedBy`
  // predicate — the endorser IS the subject). Without back-compat
  // those historical endorsements vanish on deploy until storage is
  // migrated, which silently flips CCL `endorsement_count` facts to
  // 0 for every UAL whose endorsements predate r19-3 and would
  // cause owner_assertion / context_corroboration policies to deny
  // access to genuinely-endorsed content.
  //
  // Fix: union both shapes here and de-duplicate (endorser, ual)
  // pairs in JS so a UAL endorsed by the same agent under both
  // shapes only counts once. The `r19-3` shape stays preferred
  // because `?endorsement` carries the full proof tuple — the
  // legacy shape only contributes to recall.
  const newShapeQuery = `
    SELECT ?endorser ?ual WHERE {
      GRAPH <${graph}> {
        ?endorsement <${DKG_ENDORSES}>   ?ual .
        ?endorsement <${DKG_ENDORSED_BY}> ?endorser .
        ${snapshotJoin}
        ${filters.join('\n        ')}
      }
    }
  `;
  const legacyShapeQuery = `
    SELECT ?endorser ?ual WHERE {
      GRAPH <${graph}> {
        ?endorser <${DKG_ENDORSES}> ?ual .
        # Exclude rows that ALSO match the new shape so we don't
        # double-count a [?endorsement dkg:endorses ?ual] quad whose
        # subject happens to be an agent IRI. This is cheap because
        # the new shape requires the matching dkg:endorsedBy join
        # which the legacy shape never carries.
        FILTER NOT EXISTS { ?endorser <${DKG_ENDORSED_BY}> ?_ }
        ${snapshotJoin}
        ${filters.join('\n        ')}
      }
    }
  `;
  const [newResult, legacyResult] = await Promise.all([
    store.query(newShapeQuery),
    store.query(legacyShapeQuery),
  ]);

  const facts: CclFactTuple[] = [];
  const counts = new Map<string, number>();
  const seenPairs = new Set<string>();

  const ingest = (rows: Record<string, string>[]): void => {
    for (const row of rows) {
      const endorser = row['endorser'] ?? '';
      const ual = row['ual'] ?? '';
      if (!endorser || !ual) continue;
      // Per (endorser, ual) dedupe:
      // agent's two endorsements of the same UAL count as one
      // endorsement for `endorsement_count` purposes (the policy
      // semantics are "how many distinct endorsers", not "how many
      // endorsement events"). Mirror that here so the legacy/new
      // union doesn't inflate the count when the same agent issued
      // both shapes.
      const pairKey = `${endorser}\u0001${ual}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      facts.push(['endorsement', endorser, ual]);
      counts.set(ual, (counts.get(ual) ?? 0) + 1);
    }
  };

  if (newResult.type === 'bindings') {
    ingest(newResult.bindings as Record<string, string>[]);
  }
  if (legacyResult.type === 'bindings') {
    ingest(legacyResult.bindings as Record<string, string>[]);
  }

  for (const [ual, count] of counts) {
    facts.push(['endorsement_count', ual, count]);
  }

  return facts;
}
