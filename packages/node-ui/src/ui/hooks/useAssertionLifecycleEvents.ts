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
  // on an existing assertion). Bind both as OPTIONAL and COALESCE
  // into a single `?assertion` — the prior UNION-with-inner-FILTER
  // shape silently returned zero rows in production (the FILTER on
  // `?type` inside the UNION branch did not interact correctly with
  // the outer `?event a ?type` binding once an event carried multiple
  // `rdf:type` triples — every emitted event has both
  // `rdf:type prov:Activity` AND `rdf:type dkg:Assertion{Created,
  // Promoted}`). Pulling the type filter OUT of the UNION (or, as
  // here, using OPTIONAL + COALESCE without UNION at all) restores
  // the row stream. Pinned by `use-assertion-lifecycle-events.test.ts`
  // against the actual `oxigraph` daemon shape.
  //
  // Aggregate the count of `dkg:rootEntity` bindings into
  // `?entityCount` — created events never have any
  // (`generateAssertionCreatedMetadata` does not emit them) so they
  // group to 0 cleanly; the consumer normalises 0 → undefined.
  // Promoted events report one row per bundle.
  //
  // PR #694 review fix — the lifecycle metadata writers
  // (`generateAssertionCreatedMetadata` / `…PromotedMetadata`) do
  // NOT emit `dkg:subGraphName` on the assertion subject (only
  // `generateShareMetadata` does, and that's the WorkspaceOperation
  // source we collapsed away from). They DO emit
  // `dkg:assertionGraph` — a stable triple set on creation
  // (`metadata.ts:632`). Project the assertion-graph URI and parse
  // the sub-graph slug client-side; the URI is shaped per
  // `contextGraphAssertionUri` in `packages/core/src/constants.ts`.
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?event ?type ?assertion ?name ?agent ?ts ?assertionGraph (COUNT(?root) AS ?entityCount) WHERE {
  GRAPH <${metaGraph}> {
    ?event a ?type ;
           prov:startedAtTime ?ts ;
           prov:wasAssociatedWith ?agent .
    FILTER(?type IN (dkg:AssertionCreated, dkg:AssertionPromoted))
    OPTIONAL { ?event prov:generated ?gen }
    OPTIONAL { ?event prov:used ?used }
    BIND(COALESCE(?gen, ?used) AS ?assertion)
    ?assertion dkg:assertionName ?name .
    OPTIONAL { ?assertion dkg:assertionGraph ?assertionGraph }
    OPTIONAL { ?event dkg:rootEntity ?root }
  }
} GROUP BY ?event ?type ?assertion ?name ?agent ?ts ?assertionGraph
  ORDER BY DESC(?ts) LIMIT 5000`;
}

/**
 * Parse a sub-graph slug out of a `dkg:assertionGraph` URI. Mirror of
 * `contextGraphAssertionUri` in `packages/core/src/constants.ts`:
 *
 *   root-bucket : `did:dkg:context-graph:<cgId>/assertion/<agent>/<name>`
 *   sub-graph   : `did:dkg:context-graph:<cgId>/<subGraphName>/assertion/<agent>/<name>`
 *
 * Returns the slug when present, `undefined` for root-bucket
 * assertions or any URI that doesn't match the expected shape (the
 * latter shouldn't happen in practice — `dkg:assertionGraph` is set
 * by the writer — but the parse stays defensive so a malformed URI
 * just suppresses the sub-graph filter rather than throwing).
 */
export function subGraphFromAssertionGraphUri(
  assertionGraphUri: string,
  contextGraphId: string,
): string | undefined {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  if (!assertionGraphUri.startsWith(prefix)) return undefined;
  const tail = assertionGraphUri.slice(prefix.length);
  const segments = tail.split('/');
  // Root-bucket: tail starts with `assertion/…` (no sub-graph segment).
  if (segments[0] === 'assertion') return undefined;
  // Sub-graph: `<subGraphName>/assertion/…`. Require the assertion
  // segment to actually be there so we don't misparse stray URIs.
  if (segments.length >= 2 && segments[1] === 'assertion') return segments[0];
  return undefined;
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
      // PR #694 Comment 20 — when the caller gates the hook off (e.g.
      // user switched away from Overview), STOP fetching but preserve
      // the last successful result so returning to the gated state
      // doesn't render an empty feed during the re-fetch window. The
      // `resultContextGraphId === contextGraphId` discriminator in
      // consumers still correctly identifies "stale prev-project
      // result" when the user later switches to a different cgId,
      // because that new cgId will trigger a fresh fetch.
      setLoading(false);
      return;
    }
    // Stale cache from a DIFFERENT cgId — clear so the consumer's
    // discriminator doesn't accidentally accept prev-project events
    // during the new fetch window. Compared via the ref so this
    // effect can stay keyed only on `contextGraphId`.
    if (lastRequestedCg.current != null && lastRequestedCg.current !== contextGraphId) {
      setEvents([]);
      setError(null);
      setResultContextGraphId(undefined);
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
          // PR #694 review fix — derive the sub-graph slug from
          // `dkg:assertionGraph` (which writers DO emit) instead of
          // `dkg:subGraphName` (which the lifecycle writers don't).
          // Falls back to undefined for root-bucket assertions.
          const assertionGraphUri = bv(row.assertionGraph);
          const subGraph = assertionGraphUri
            ? subGraphFromAssertionGraphUri(assertionGraphUri, contextGraphId)
            : undefined;
          out.push({
            eventUri,
            kind,
            assertionUri,
            assertionName: assertionName ?? '',
            agentUri,
            publishedAt: ts,
            subGraph,
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
        // PR #694 review fix — advance `resultContextGraphId` on
        // failure so consumers gating on
        // `resultContextGraphId === contextGraphId` (the Code7 pattern
        // shared with `useSwmAttributions`) can distinguish "still
        // loading the new graph" from "the new graph errored and
        // that's the answer for this graph". Without this, an early
        // failure keeps consumers stuck in the previous-graph state
        // until the hook re-runs.
        setResultContextGraphId(contextGraphId);
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
