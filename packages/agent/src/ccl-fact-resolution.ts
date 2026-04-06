import { createHash } from 'node:crypto';
import { DKG_ONTOLOGY, contextGraphDataUri, contextGraphSharedMemoryUri, paranetDataGraphUri, paranetWorkspaceGraphUri, sparqlString } from '@origintrail-official/dkg-core';
import { DKG_ENDORSES } from './endorse.js';
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
  if (scope?.view) {
    filters.push(`FILTER(EXISTS { GRAPH <${graph}${scope.view}> { ?ual ?_vp ?_vo } })`);
  }
  const query = `
    SELECT ?endorser ?ual WHERE {
      GRAPH <${graph}> {
        ?endorser <${DKG_ENDORSES}> ?ual .
        ${snapshotJoin}
        ${filters.join('\n        ')}
      }
    }
  `;
  const result = await store.query(query);
  if (result.type !== 'bindings') return [];

  const facts: CclFactTuple[] = [];
  const counts = new Map<string, number>();

  for (const row of result.bindings as Record<string, string>[]) {
    const endorser = row['endorser'] ?? '';
    const ual = row['ual'] ?? '';
    if (!endorser || !ual) continue;

    facts.push(['endorsement', endorser, ual]);
    counts.set(ual, (counts.get(ual) ?? 0) + 1);
  }

  for (const [ual, count] of counts) {
    facts.push(['endorsement_count', ual, count]);
  }

  return facts;
}
