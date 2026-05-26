/**
 * useAssertionLifecycleEvents — assertion-lifecycle activity source.
 *
 * Queries the project's `_meta` graph for `dkg:AssertionCreated` and
 * `dkg:AssertionPromoted` events emitted by `generateAssertionCreatedMetadata`
 * / `generateAssertionPromotedMetadata` (`packages/publisher/src/metadata.ts`).
 *
 * Why this exists separately from `useSwmAttributions`:
 *
 *   - `useSwmAttributions` is the source-of-truth for the SWM graph's
 *     per-agent attribution coloring + legend. It queries
 *     `dkg:WorkspaceOperation` records in `_shared_memory_meta` which
 *     are keyed on `publisherPeerId` (a libp2p peer id, `12D3…`).
 *
 *   - The assertion-lifecycle events emitted by the daemon are keyed
 *     natively on the DKG agent identity (`did:dkg:agent:0x…`) — the
 *     same identity space the rest of the UI resolves agent profiles
 *     against. Sourcing the activity feed from these events removes
 *     the "raw peer-id in author column" gap that PR #656 testing
 *     surfaced without needing a peer→agent reverse index.
 *
 * Two record classes returned in one stream so the activity feed
 * does a single SPARQL round-trip per project:
 *
 *   - `'created'` — agent created a new WM assertion bundle.
 *   - `'promoted'` — agent promoted an existing assertion WM→SWM.
 *
 * `'published'` (SWM→VM) is intentionally out of scope here — it lives
 * with `dkg:AssertionPublished` (when emitted) and the N6 publishes
 * fold-in tracked in the implementation plan.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../api.js';

export type AssertionLifecycleKind = 'created' | 'promoted';

export interface AssertionLifecycleEvent {
  /** Stable per-event identifier (`prov:Activity` URI). */
  eventUri: string;
  /** Event class: which lifecycle transition this row represents. */
  kind: AssertionLifecycleKind;
  /** The assertion entity URI the event was generated for. */
  assertionUri: string;
  /** Human-readable assertion name (`dkg:assertionName` literal). */
  assertionName: string;
  /** DKG agent identity URI (`did:dkg:agent:0x…`) — agent-identity-keyed. */
  agentUri: string;
  /** ISO timestamp of the event. */
  publishedAt: string;
  /** Sub-graph slug if the assertion is sub-graph-scoped. */
  subGraph?: string;
  /**
   * Number of root entities included in a `'promoted'` bundle —
   * `count(?event dkg:rootEntity ?root)`. Undefined for `'created'`
   * (the metadata writer doesn't emit `dkg:rootEntity` on creation,
   * see `generateAssertionCreatedMetadata` in
   * `packages/publisher/src/metadata.ts`).
   */
  entityCount?: number;
}

export interface AssertionLifecycleEventsResult {
  /**
   * Context graph id whose SPARQL response produced `events`. Lags
   * behind the caller's `contextGraphId` during a project switch — the
   * in-flight result is still for the *previous* graph until the new
   * query lands. Same gate pattern as `useSwmAttributions`.
   */
  resultContextGraphId: string | undefined;
  /** Sorted newest-first. Empty when the query hasn't returned yet. */
  events: AssertionLifecycleEvent[];
  loading: boolean;
  error: string | null;
}

const QUERY_TIMEOUT_MS = 10_000;
const DKG = 'http://dkg.io/ontology/';

export function buildLifecycleEventsQuery(cgId: string): string {
  const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
  // Created events use `prov:generated` (the activity produced the
  // assertion); promoted events use `prov:used` (the activity acted
  // on an existing assertion). UNION-bind ?assertion to the right
  // predicate per kind. Aggregate the count of `dkg:rootEntity`
  // bindings into ?entityCount — created events never have any
  // (`generateAssertionCreatedMetadata` does not emit them) so they
  // group to 0 cleanly; promoted events report one row per bundle.
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?event ?type ?assertion ?name ?agent ?ts ?subGraph (COUNT(?root) AS ?entityCount) WHERE {
  GRAPH <${metaGraph}> {
    ?event a ?type ;
           prov:startedAtTime ?ts ;
           prov:wasAssociatedWith ?agent .
    { ?event prov:generated ?assertion . FILTER(?type = dkg:AssertionCreated) }
    UNION
    { ?event prov:used ?assertion . FILTER(?type = dkg:AssertionPromoted) }
    ?assertion dkg:assertionName ?name .
    OPTIONAL { ?assertion dkg:subGraphName ?subGraph }
    OPTIONAL { ?event dkg:rootEntity ?root }
  }
} GROUP BY ?event ?type ?assertion ?name ?agent ?ts ?subGraph
  ORDER BY DESC(?ts) LIMIT 5000`;
}

function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    return v.startsWith('"')
      ? v.replace(/^"/, '').replace(/"(\^\^<[^>]*>)?$/, '')
      : v;
  }
  if (typeof v === 'object' && v !== null && 'value' in (v as any)) {
    return String((v as any).value);
  }
  return String(v);
}

function kindForType(typeUri: string | undefined): AssertionLifecycleKind | null {
  if (typeUri === `${DKG}AssertionCreated`) return 'created';
  if (typeUri === `${DKG}AssertionPromoted`) return 'promoted';
  return null;
}

export function useAssertionLifecycleEvents(
  contextGraphId: string | undefined,
): AssertionLifecycleEventsResult {
  const [events, setEvents] = useState<AssertionLifecycleEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(contextGraphId));
  const [error, setError] = useState<string | null>(null);
  const [resultContextGraphId, setResultContextGraphId] = useState<string | undefined>(undefined);
  const lastRequestedCg = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!contextGraphId) {
      setEvents([]);
      setLoading(false);
      setError(null);
      setResultContextGraphId(undefined);
      lastRequestedCg.current = undefined;
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    lastRequestedCg.current = contextGraphId;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(
              `Assertion-lifecycle query timed out after ${Math.round(QUERY_TIMEOUT_MS / 1000)}s`,
            ));
          }, QUERY_TIMEOUT_MS);
        });
        const request = (async () => {
          const res = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            signal: controller.signal,
            body: JSON.stringify({
              sparql: buildLifecycleEventsQuery(contextGraphId),
              contextGraphId,
            }),
          });
          if (!res.ok) throw new Error(`SPARQL query failed: ${res.status}`);
          return res.json();
        })();
        const data = await Promise.race([request, timeout]);
        if (cancelled || lastRequestedCg.current !== contextGraphId) return;
        const rows: any[] = data?.result?.bindings ?? [];
        const out: AssertionLifecycleEvent[] = [];
        for (const row of rows) {
          const eventUri = bv(row.event);
          const typeUri = bv(row.type);
          const assertionUri = bv(row.assertion);
          const assertionName = bv(row.name);
          const agentUri = bv(row.agent);
          const ts = bv(row.ts);
          if (!eventUri || !assertionUri || !agentUri || !ts) continue;
          const kind = kindForType(typeUri);
          if (!kind) continue;
          // entityCount is only meaningful on promoted rows. The
          // GROUP BY produces a numeric literal (often typed as
          // xsd:integer); `bv()` strips the type tag, leaving a
          // bare digit string. Missing/zero on created rows.
          let entityCount: number | undefined;
          if (kind === 'promoted') {
            const raw = bv(row.entityCount);
            const n = raw != null ? Number(raw) : NaN;
            if (Number.isFinite(n) && n >= 0) entityCount = n;
          }
          out.push({
            eventUri,
            kind,
            assertionUri,
            assertionName: assertionName ?? '',
            agentUri,
            publishedAt: ts,
            subGraph: bv(row.subGraph),
            entityCount,
          });
        }
        setEvents(out);
        setResultContextGraphId(contextGraphId);
        setError(null);
      } catch (err) {
        if (cancelled || (err as any)?.name === 'AbortError') return;
        setError((err as Error).message ?? String(err));
        setEvents([]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [contextGraphId]);

  return useMemo(
    () => ({ resultContextGraphId, events, loading, error }),
    [resultContextGraphId, events, loading, error],
  );
}
