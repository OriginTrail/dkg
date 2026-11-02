/**
 * useVerifiableMemoryAnchors — pulls Verifiable-Memory provenance from the
 * REAL on-chain publish receipts in the context graph's `_meta` (C10; it used
 * to read WorkspaceOperation share records from `_shared_memory_meta`, which
 * are not chain receipts) and projects it as a small set of "decoration" RDF
 * triples merged into the VM graph visualisation.
 *
 * This is the visual realisation of the DKG "secret sauce": every VM entity
 * becomes surrounded by two extra kinds of nodes so the human eye instantly
 * sees *why* it is trusted:
 *
 *   ◉ OnChainAnchor    per receipted assertion (publish tx).
 *                      Labelled with the tx hash + finalize time.
 *
 *   ◈ AgentIdentity    per unique DID / peer-ID that signed a publish.
 *                      Represents the agent that attested to the batch.
 *                      Labelled with truncated peer-id.
 *
 * Edges:
 *   entity  —anchoredIn→ anchor
 *   anchor  —signedBy →  agent
 *   entity  —consensus→ "1-of-N"    (literal, shows in hover/card)
 *
 * Nothing about this modifies the daemon store — all synthetic triples live
 * in-memory on the client, under a dedicated viz:* namespace that
 * `ProjectView`'s style maps recognise for VM-only rendering.
 *
 * If the daemon has no publish provenance yet (e.g. VM wasn't seeded), the
 * hook just returns an empty list — the VM graph falls back to the plain
 * committed-sub-graph view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../api.js';
import type { Triple } from './useMemoryEntities.js';
import { buildVmReceiptSummaryQuery, isSafeIriPart, receiptAgent, receiptValue } from './useVmReceiptSummary.js';

/** Namespace for synthetic visualisation triples — unique to VM decoration
 *  so downstream code (SubGraphBar bucketing, counts) never mistakes them
 *  for real data. */
const VIZ_NS = 'http://dkg.io/viz/';
export const VIZ_ANCHOR_TYPE = `${VIZ_NS}OnChainAnchor`;
export const VIZ_AGENT_TYPE = `${VIZ_NS}AgentIdentity`;
export const VIZ_PRED_ANCHORED_IN = `${VIZ_NS}anchoredIn`;
export const VIZ_PRED_SIGNED_BY = `${VIZ_NS}signedBy`;
export const VIZ_PRED_CONSENSUS = `${VIZ_NS}consensus`;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESC = 'http://schema.org/description';

/** Single publish batch as reported by the daemon's workspace-operation
 *  records. */
export interface PublishAnchor {
  opId: string;        // raw operation id (tail of urn:dkg:share:<cg>:<opId>)
  opUri: string;       // urn:dkg:share:<cg>:<opId>
  agents: string[];    // distinct peer-ids / DIDs that attested
  roots: string[];     // KA root entities included in this batch
  publishedAt: string; // ISO timestamp
  subGraph?: string;   // sub-graph slug (from the graph URI)
}

export interface VerifiableMemoryAnchorsResult {
  /** Every anchor we know about. Useful for legends / ledgers. */
  anchors: PublishAnchor[];
  /** Synthetic triples to merge into the RdfGraph input, already filtered
   *  to the subset of anchors whose roots are visible in the current layer
   *  (see `visibleEntityUris` argument). */
  decorationTriples: Triple[];
  loading: boolean;
  error: string | null;
}

function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    // Strip wrapping quotes for literals, and the trailing ^^<datatype> tag.
    return v.startsWith('"')
      ? v.replace(/^"/, '').replace(/"(\^\^<[^>]*>)?$/, '')
      : v;
  }
  if (typeof v === 'object' && v !== null && 'value' in (v as any)) {
    return String((v as any).value);
  }
  return String(v);
}

/** Short label for an anchor: `tx mo3e0z…` + relative time if we can derive it. */
function anchorLabel(a: PublishAnchor): string {
  const short = a.opId.slice(0, 10);
  try {
    const d = new Date(a.publishedAt);
    const hhmm = d.toISOString().slice(11, 16);
    return `anchor ${short} · ${hhmm}UTC`;
  } catch {
    return `anchor ${short}`;
  }
}

/** Short label for an agent peer-id / DID. */
function agentLabel(agentId: string): string {
  if (agentId.startsWith('did:dkg:agent:')) {
    const tail = agentId.slice('did:dkg:agent:'.length);
    if (tail.startsWith('0x')) return tail.slice(0, 6) + '…' + tail.slice(-4);
    return tail.slice(0, 6) + '…' + tail.slice(-6);
  }
  // libp2p peer id or raw 0x address — truncate from the middle
  if (agentId.length > 18) return agentId.slice(0, 8) + '…' + agentId.slice(-6);
  return agentId;
}

/** did:dkg:context-graph:<cg>/<sub>/assertion/… → <sub> (undefined at the root). */
function subGraphFromAssertionUri(asrt: string, cgId: string): string | undefined {
  const prefix = `did:dkg:context-graph:${cgId}/`;
  if (!asrt.startsWith(prefix)) return undefined;
  const seg = asrt.slice(prefix.length).split('/')[0];
  return seg && seg !== 'assertion' ? seg : undefined;
}

/** Fold receipt rows into one anchor per receipted assertion. Exported for tests. */
export function anchorsFromReceiptRows(rows: Array<Record<string, unknown>>, cgId: string): PublishAnchor[] {
  const byAsrt = new Map<string, PublishAnchor>();
  for (const row of rows) {
    const asrt = receiptValue(row.asrt);
    const tx = receiptValue(row.tx);
    if (!asrt || !tx) continue;
    let a = byAsrt.get(asrt);
    if (!a) {
      a = { opId: tx, opUri: asrt, agents: [], roots: [], publishedAt: receiptValue(row.finalizedAt), subGraph: subGraphFromAssertionUri(asrt, cgId) };
      byAsrt.set(asrt, a);
    }
    const member = receiptValue(row.member);
    if (member && !a.roots.includes(member)) a.roots.push(member);
    const agent = receiptAgent(row);
    if (agent && !a.agents.includes(agent)) a.agents.push(agent);
  }
  return [...byAsrt.values()].sort((x, y) => y.publishedAt.localeCompare(x.publishedAt));
}

function buildDecorationTriples(
  anchors: PublishAnchor[],
  visibleEntityUris: Set<string> | null,
): Triple[] {
  const out: Triple[] = [];
  const seenAgents = new Set<string>();

  for (const a of anchors) {
    // If we know which entities the graph is currently rendering (VM view),
    // restrict the anchor's edges to roots that will actually show up as
    // nodes — otherwise we end up with orphan anchor hubs floating next to
    // the graph, connected to roots that live only in SWM.
    // Members come from the seal rows; entities namespaced under the
    // assertion URI belong to it too (same rule as the receipt hook).
    const visibleRoots = visibleEntityUris
      ? [...new Set([...a.roots.filter(r => visibleEntityUris.has(r)), ...[...visibleEntityUris].filter(u => u.startsWith(a.opUri + '/'))])]
      : a.roots;
    if (visibleRoots.length === 0) continue;

    const anchorUri = `urn:dkg:viz:anchor:${a.opId}`;
    // Anchor node typing + label so RdfGraph can render it with our viz colors.
    out.push({ subject: anchorUri, predicate: RDF_TYPE, object: VIZ_ANCHOR_TYPE, subGraph: a.subGraph });
    out.push({ subject: anchorUri, predicate: SCHEMA_NAME, object: `"${anchorLabel(a)}"`, subGraph: a.subGraph });
    out.push({
      subject: anchorUri,
      predicate: SCHEMA_DESC,
      object: `"Published ${a.roots.length} KA${a.roots.length === 1 ? '' : 's'} · ${new Date(a.publishedAt).toISOString()}"`,
      subGraph: a.subGraph,
    });

    // anchor ← anchoredIn ← entity  (we model the edge outward-from-entity
    // so it reads `<decision> anchored-in <anchor>` in graph hover).
    for (const root of visibleRoots) {
      out.push({ subject: root, predicate: VIZ_PRED_ANCHORED_IN, object: anchorUri, subGraph: a.subGraph });
      // A per-entity consensus literal — picked up by the entity card / hover.
      // We only know 1 signer in the current devnet (minimumRequiredSignatures=1)
      // so we render 1-of-1. A production publish with a quorum would list
      // additional `signedBy` edges from anchor → each signing agent.
      out.push({
        subject: root,
        predicate: VIZ_PRED_CONSENSUS,
        object: `"${a.agents.length}-of-${a.agents.length}"`,
        subGraph: a.subGraph,
      });
    }

    // Agent nodes — dedupe so we don't emit 50 copies of the same DID.
    for (const agentRaw of a.agents) {
      const agent = agentRaw.startsWith('did:') || agentRaw.startsWith('12D3')
        ? agentRaw
        : `did:dkg:agent:${agentRaw}`;
      const agentUri = `urn:dkg:viz:agent:${encodeURIComponent(agent)}`;
      out.push({ subject: anchorUri, predicate: VIZ_PRED_SIGNED_BY, object: agentUri, subGraph: a.subGraph });
      if (!seenAgents.has(agentUri)) {
        seenAgents.add(agentUri);
        out.push({ subject: agentUri, predicate: RDF_TYPE, object: VIZ_AGENT_TYPE, subGraph: a.subGraph });
        out.push({ subject: agentUri, predicate: SCHEMA_NAME, object: `"${agentLabel(agent)}"`, subGraph: a.subGraph });
        out.push({ subject: agentUri, predicate: SCHEMA_DESC, object: `"${agent}"`, subGraph: a.subGraph });
      }
    }
  }
  return out;
}

export function useVerifiableMemoryAnchors(
  contextGraphId: string | undefined,
  visibleEntityUris?: Set<string> | Iterable<string>,
): VerifiableMemoryAnchorsResult {
  const [anchors, setAnchors] = useState<PublishAnchor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  useEffect(() => {
    if (!contextGraphId || !isSafeIriPart(contextGraphId)) {
      setAnchors([]);
      setLoading(false);
      return;
    }
    const version = ++versionRef.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ contextGraphId, sparql: buildVmReceiptSummaryQuery(contextGraphId) }),
        });
        if (!res.ok) throw new Error(`SPARQL query failed: ${res.status}`);
        const data = await res.json();
        const rows: any[] = data?.result?.bindings ?? [];
        const next = anchorsFromReceiptRows(rows, contextGraphId);

        if (version !== versionRef.current) return;
        setAnchors(next);
      } catch (err: any) {
        if (version !== versionRef.current) return;
        setError(err?.message ?? 'Failed to load anchors');
        setAnchors([]);
      } finally {
        if (version === versionRef.current) setLoading(false);
      }
    })();
  }, [contextGraphId]);

  // Normalise visibleEntityUris into a stable Set whose identity only
  // changes when the membership changes. We serialise to a sorted join
  // so React doesn't rebuild decorations every render in the common case
  // where the caller passes a fresh Set with identical contents.
  const visibilityKey = useMemo(() => {
    if (!visibleEntityUris) return null;
    const arr: string[] = [];
    if (visibleEntityUris instanceof Set) {
      for (const v of visibleEntityUris) arr.push(v);
    } else {
      for (const v of visibleEntityUris) arr.push(v);
    }
    arr.sort();
    return arr.join('|');
  }, [visibleEntityUris]);

  const visibleSet = useMemo(() => {
    if (visibilityKey == null) return null;
    return new Set(visibilityKey.length === 0 ? [] : visibilityKey.split('|'));
  }, [visibilityKey]);

  const decorationTriples = useMemo(
    () => buildDecorationTriples(anchors, visibleSet),
    [anchors, visibleSet],
  );

  return { anchors, decorationTriples, loading, error };
}
