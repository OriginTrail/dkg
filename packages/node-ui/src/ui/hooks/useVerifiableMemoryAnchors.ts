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
 * Receipts come from `useVmReceipts` (shared with the VM header facts), so
 * this hook only projects typed receipt records into triples.
 *
 * If the daemon has no publish provenance yet (e.g. VM wasn't seeded), the
 * hook just returns an empty list — the VM graph falls back to the plain
 * committed-sub-graph view.
 */

import { useMemo } from 'react';
import type { Triple } from './useMemoryEntities.js';
import { useVmReceipts, type VmReceipt } from './useVmReceipts.js';
import { isAtOrUnder } from './useVmReceiptSummary.js';

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

/** One receipted assertion, as drawn in the VM graph. */
export interface PublishAnchor {
  opId: string;        // publish transaction hash
  opUri: string;       // assertion URI
  agents: string[];    // distinct DIDs that published it
  roots: string[];     // member entities of the assertion
  /** ISO timestamp of the on-chain finalize, or null when the receipt has
   *  none (older receipts, or a finalize not yet recorded). */
  publishedAt: string | null;
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


/** Short label for an anchor: `tx mo3e0z…` + relative time if we can derive it. */
function anchorLabel(a: PublishAnchor): string {
  const short = a.opId.slice(0, 10);
  return a.publishedAt ? `anchor ${short} · ${a.publishedAt.slice(11, 16)}UTC` : `anchor ${short}`;
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

/** One anchor per receipt, newest first; receipts without a finalize time
 *  go last. Exported for tests. */
export function anchorsFromReceipts(receipts: readonly VmReceipt[]): PublishAnchor[] {
  return receipts
    .map(r => ({ opId: r.tx, opUri: r.assertion, agents: [...r.signers], roots: [...r.members], publishedAt: r.finalizedAt, subGraph: r.subGraph }))
    .sort((x, y) => (y.publishedAt ?? '').localeCompare(x.publishedAt ?? ''));
}

/** Synthetic anchor / agent triples for the graph. Exported for tests. */
export function buildDecorationTriples(
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
      ? [...new Set([...a.roots.filter(r => visibleEntityUris.has(r)), ...[...visibleEntityUris].filter(u => u !== a.opUri && isAtOrUnder(u, a.opUri))])]
      : a.roots;
    if (visibleRoots.length === 0) continue;

    const anchorUri = `urn:dkg:viz:anchor:${a.opId}`;
    // Anchor node typing + label so RdfGraph can render it with our viz colors.
    out.push({ subject: anchorUri, predicate: RDF_TYPE, object: VIZ_ANCHOR_TYPE, subGraph: a.subGraph });
    out.push({ subject: anchorUri, predicate: SCHEMA_NAME, object: `"${anchorLabel(a)}"`, subGraph: a.subGraph });
    out.push({
      subject: anchorUri,
      predicate: SCHEMA_DESC,
      object: `"Published ${a.roots.length} KA${a.roots.length === 1 ? '' : 's'}${a.publishedAt ? ` · ${a.publishedAt}` : ' · finalize time unknown'}"`,
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
  const { receipts, loading, error } = useVmReceipts(contextGraphId);
  const anchors = useMemo(() => (receipts ? anchorsFromReceipts(receipts) : []), [receipts]);

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
