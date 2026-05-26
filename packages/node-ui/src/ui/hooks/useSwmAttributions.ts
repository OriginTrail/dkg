/**
 * useSwmAttributions — SWM-only agent attribution layer.
 *
 * Queries the project's `_shared_memory_meta` partition(s) for every
 * `dkg:WorkspaceOperation` and folds them into a per-entity attribution
 * map: which agent(s) promoted this entity into SWM, when, and from which
 * sub-graph. The result powers two VM-style visual affordances on the SWM
 * graph tab:
 *
 *   ◈ Per-node tinting — each root KA URI is recoloured to its proposing
 *     agent's palette slot. If the graph engine already applied a class
 *     colour (Decision green, Task cyan, etc.), the agent tint overrides
 *     it for that single URI so the "who said this" signal wins over
 *     "what type is this". Non-root triples (internal structure) keep
 *     their class colouring.
 *
 *   ⚠ Conflict badges — entities promoted by two or more distinct agents
 *     are flagged as "in review"; the UI can render a warning halo or
 *     list them separately. In a single-agent devnet this set is empty
 *     but the plumbing is ready the moment a second agent joins.
 *
 * The hook is SWM-specific by design: WM is per-agent by construction
 * (attribution is in the assertion graph URI), and VM uses a dedicated
 * on-chain anchor hook. Trying to generalise all three into one hook made
 * the mental model murkier, so we keep them separate.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../api.js';

export interface AgentAttribution {
  /** Canonical agent identifier. Peer-id for libp2p (`12D3…`), `did:dkg:agent:`
   *  for V10 eth-address-based identities. */
  agent: string;
  /** WorkspaceOperation URI that promoted this entity. */
  opUri: string;
  /** ISO timestamp of the promotion. */
  publishedAt: string;
  /** Sub-graph the entity was promoted into. */
  subGraph?: string;
}

/**
 * Raw `dkg:WorkspaceOperation` row from `_shared_memory_meta`, *not*
 * deduplicated by `(root, agent)`. One entry per SPARQL binding —
 * preserves re-promotions (same agent promoting the same root twice
 * with different op ids / timestamps) and is the substrate the activity
 * feed needs for an accurate timeline.
 *
 * Codex Code2 (PR #656) caught the bug: the deduped `attributions` map
 * is fine for the SWM-graph legend (where collapsing repeated
 * promotions to a single agent per root is what you want) but wrong
 * for the activity feed, where each promotion should be its own event.
 * We compute both shapes from the same SPARQL response so callers pick
 * the shape that matches their semantics.
 */
export interface WorkspaceOperationEvent {
  opUri: string;
  rootUri: string;
  agent: string;
  publishedAt: string;
  subGraph?: string;
}

export interface AgentPaletteEntry {
  agent: string;
  color: string;
  label: string;
  /** How many SWM entities this agent has promoted. */
  entityCount: number;
}

export interface SwmAttributionsResult {
  /**
   * Context graph id whose SPARQL response produced the rest of the
   * fields in this result. `undefined` until the first query for the
   * current `contextGraphId` resolves; lags behind the caller's
   * `contextGraphId` during a project switch — the in-flight result is
   * still for the *previous* graph until the new query lands.
   *
   * Codex Code7 (PR #656) — exposing this lets page-level consumers
   * (e.g. `ProjectView` feeding the Overview activity feed) gate
   * downstream rendering on `resultContextGraphId === contextGraphId`
   * so users don't briefly see promotion rows from the previous
   * project after switching context graphs. The SWM graph internally
   * doesn't gate (momentary stale tints are less misleading than
   * stale activity-feed rows, and it re-renders cleanly once the new
   * attribution lands).
   */
  resultContextGraphId: string | undefined;
  /** Attribution map keyed by entity URI. Callers pass these into the
   *  graph engine via a derived `nodeColors` record. Deduplicated by
   *  `(root, agent)` — at most one entry per pair. */
  attributions: Map<string, AgentAttribution[]>;
  /**
   * Raw, undeduplicated per-operation event list. One entry per SPARQL
   * binding so re-promotions (same agent promoting the same root again
   * with a different op id / timestamp) are preserved. Sorted by
   * `publishedAt` ASC. R2-Local-3 (PR #656) — the source query is now
   * `ORDER BY DESC` + `LIMIT 5000` (Code5; keeps the newest 5000 ops
   * within the cap), but the hook reverses client-side before exposing
   * this array so the legend dedup's first-seen-wins semantics still
   * pick the oldest promotion per `(root, agent)`. The activity-feed
   * consumer re-sorts newest-first, so it's order-agnostic on input.
   */
  events: WorkspaceOperationEvent[];
  /** Stable colour + label per agent, for legends and per-URI tinting. */
  palette: AgentPaletteEntry[];
  /** Per-URI override map ready to drop into RdfGraph's `style.nodeColors`. */
  nodeColors: Record<string, string>;
  /** Entities promoted by more than one distinct agent. A zero-length
   *  array is the normal case in a single-agent devnet. */
  conflicts: string[];
  loading: boolean;
  error: string | null;
}

/** Deliberately picked for contrast against the existing class palette
 *  (Package purple, Function amber, Decision red, Task cyan, etc.) — these
 *  sit in the gaps so agent identity reads as its own axis. */
const AGENT_PALETTE = [
  '#f97316', // orange
  '#14b8a6', // teal
  '#f43f5e', // rose
  '#facc15', // yellow
  '#8b5cf6', // violet
  '#10b981', // emerald
  '#0ea5e9', // sky
  '#d946ef', // fuchsia
];
const ATTRIBUTION_QUERY_TIMEOUT_MS = 10_000;

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

function agentLabel(agent: string): string {
  if (agent.startsWith('did:dkg:agent:')) {
    const tail = agent.slice('did:dkg:agent:'.length);
    if (tail.startsWith('0x')) return tail.slice(0, 6) + '…' + tail.slice(-4);
    return tail.slice(0, 6) + '…' + tail.slice(-6);
  }
  if (agent.length > 18) return agent.slice(0, 8) + '…' + agent.slice(-6);
  return agent;
}

function canonicaliseAgent(raw: string): string {
  if (raw.startsWith('did:') || raw.startsWith('12D3')) return raw;
  // Bare 0x… address → wrap as a DID so legend + graph + VM hook all agree.
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return `did:dkg:agent:${raw}`;
  return raw;
}

function subGraphFromMetaGraphUri(gUri: string, cgId: string): string | undefined {
  // did:dkg:context-graph:<cg>/<sg>/_shared_memory_meta  →  <sg>
  const prefix = `did:dkg:context-graph:${cgId}/`;
  if (!gUri.startsWith(prefix)) return undefined;
  const tail = gUri.slice(prefix.length);
  const slash = tail.indexOf('/');
  if (slash < 0) return undefined;
  const seg = tail.slice(0, slash);
  if (!seg || seg.startsWith('_')) return undefined;
  return seg;
}

export function buildAttributionsQuery(cgId: string): string {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  return `PREFIX dkg: <http://dkg.io/ontology/>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?op ?root ?agent ?publishedAt ?g WHERE {
  GRAPH ?g {
    ?op a dkg:WorkspaceOperation ;
        dkg:rootEntity ?root ;
        dkg:publishedAt ?publishedAt ;
        prov:wasAttributedTo ?agent .
  }
  FILTER(
    STRSTARTS(STR(?g), "${cgUri}") &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} ORDER BY DESC(?publishedAt) LIMIT 5000`;
}

/** Stable hash → palette index so a given agent always keeps the same
 *  colour across reloads, and two nearby agents don't collide on colour 0. */
function paletteIndex(agent: string): number {
  let h = 0;
  for (let i = 0; i < agent.length; i++) {
    h = (h * 31 + agent.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % AGENT_PALETTE.length;
}

export function useSwmAttributions(contextGraphId: string | undefined): SwmAttributionsResult {
  const [attributions, setAttributions] = useState<Map<string, AgentAttribution[]>>(new Map());
  const [events, setEvents] = useState<WorkspaceOperationEvent[]>([]);
  const [palette, setPalette] = useState<AgentPaletteEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolvedContextGraphId, setResolvedContextGraphId] = useState<string | undefined>(undefined);
  const versionRef = useRef(0);

  useEffect(() => {
    if (!contextGraphId) {
      versionRef.current += 1;
      setAttributions(new Map());
      setEvents([]);
      setPalette([]);
      setLoading(false);
      setResolvedContextGraphId(undefined);
      return;
    }
    const version = ++versionRef.current;
    const controller = new AbortController();
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => !cancelled && version === versionRef.current;

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(
              `SWM attribution query timed out after ${Math.round(ATTRIBUTION_QUERY_TIMEOUT_MS / 1000)}s`,
            ));
          }, ATTRIBUTION_QUERY_TIMEOUT_MS);
        });
        const request = (async () => {
          const res = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            signal: controller.signal,
            body: JSON.stringify({
              sparql: buildAttributionsQuery(contextGraphId),
              contextGraphId,
            }),
          });
          if (!res.ok) throw new Error(`SPARQL query failed: ${res.status}`);
          return res.json();
        })();
        const data = await Promise.race([request, timeout]);
        // Codex Code5 (PR #656) — the SPARQL query orders DESC and
        // caps at 5000 so a project with more than 5000 promotion ops
        // returns the *newest* 5000 (the activity feed needs recent
        // events). The downstream legend dedup is order-sensitive
        // (first-seen wins), so we reverse here to ASC before folding
        // — keeps the legend semantics (oldest promotion wins per
        // (root, agent)) identical to the pre-DESC behaviour for
        // projects with <5000 ops, and stays meaningful for larger ones.
        const rawRows: any[] = data?.result?.bindings ?? [];
        const rows = rawRows.slice().reverse();

        const attrMap = new Map<string, AgentAttribution[]>();
        const agentTotals = new Map<string, Set<string>>();
        // Raw per-op event log (no dedup) — separate from `attrMap`
        // because the activity feed needs every promotion as its own
        // row, while the legend wants one entry per `(root, agent)`.
        const eventLog: WorkspaceOperationEvent[] = [];

        for (const row of rows) {
          const op = bv(row.op);
          const root = bv(row.root);
          const agentRaw = bv(row.agent);
          const ts = bv(row.publishedAt);
          const g = bv(row.g);
          if (!op || !root || !agentRaw || !ts) continue;
          const agent = canonicaliseAgent(agentRaw);
          const subGraph = g ? subGraphFromMetaGraphUri(g, contextGraphId) : undefined;

          // Raw event always recorded — preserves re-promotions
          // (same `(root, agent)` with a different `opUri` or `ts`).
          eventLog.push({ opUri: op, rootUri: root, agent, publishedAt: ts, subGraph });

          const entry: AgentAttribution = { agent, opUri: op, publishedAt: ts, subGraph };
          const list = attrMap.get(root);
          if (list) {
            // De-dupe: an entity can appear in multiple ops from the same
            // agent (re-promotion). Only keep one attribution per (agent)
            // so the conflict check doesn't false-positive.
            if (!list.some(x => x.agent === agent)) list.push(entry);
          } else {
            attrMap.set(root, [entry]);
          }

          let roots = agentTotals.get(agent);
          if (!roots) { roots = new Set(); agentTotals.set(agent, roots); }
          roots.add(root);
        }

        const paletteEntries: AgentPaletteEntry[] = [...agentTotals.entries()]
          .map(([agent, roots]) => ({
            agent,
            color: AGENT_PALETTE[paletteIndex(agent)]!,
            label: agentLabel(agent),
            entityCount: roots.size,
          }))
          .sort((a, b) => b.entityCount - a.entityCount);

        if (!isCurrent()) return;
        setAttributions(attrMap);
        setEvents(eventLog);
        setPalette(paletteEntries);
        setResolvedContextGraphId(contextGraphId);
      } catch (err: any) {
        if (!isCurrent()) return;
        setError(err?.message ?? 'Failed to load SWM attributions');
        setAttributions(new Map());
        setEvents([]);
        setPalette([]);
        setResolvedContextGraphId(contextGraphId);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (isCurrent()) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      controller.abort();
    };
  }, [contextGraphId]);

  const { nodeColors, conflicts } = useMemo(() => {
    const nc: Record<string, string> = {};
    const confl: string[] = [];
    // A single-signer devnet will have one-element attribution arrays; the
    // conflict branch is dead code there but we keep it wired so the UI
    // "just works" the moment a second signer joins.
    for (const [uri, list] of attributions) {
      if (list.length === 0) continue;
      if (list.length === 1) {
        nc[uri] = AGENT_PALETTE[paletteIndex(list[0]!.agent)]!;
      } else {
        // Tag conflict nodes with a distinct warning colour — takes
        // priority over any single agent's palette slot so they're
        // instantly scannable.
        confl.push(uri);
        nc[uri] = '#f59e0b';
      }
    }
    return { nodeColors: nc, conflicts: confl };
  }, [attributions]);

  const attributionPending = Boolean(contextGraphId && (loading || resolvedContextGraphId !== contextGraphId));

  return {
    resultContextGraphId: resolvedContextGraphId,
    attributions,
    events,
    palette,
    nodeColors,
    conflicts,
    loading: attributionPending,
    error,
  };
}
