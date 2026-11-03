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

export interface VerifiableMemoryAnchorsResult {
  /** Every receipt we know about, newest first (undated last). Useful for
   *  legends / ledgers. */
  anchors: VmReceipt[];
  /** Synthetic triples to merge into the RdfGraph input, already filtered
   *  to the subset of anchors whose roots are visible in the current layer
   *  (see `visibleEntityUris` argument). */
  decorationTriples: Triple[];
  loading: boolean;
  error: string | null;
}


/** Short label for an anchor: `tx mo3e0z…` + finalize time when known. */
function anchorLabel(r: VmReceipt): string {
  const short = r.tx ? r.tx.slice(0, 10) : 'confirmed';
  return r.finalizedAt ? `anchor ${short} · ${r.finalizedAt.slice(11, 16)}UTC` : `anchor ${short}`;
}

/** Why an anchored KA shows no transaction, if it doesn't. */
function noTxNote(r: VmReceipt): string {
  if (r.tx) return '';
  return r.confirmation === 'finalized-materialization'
    ? ' · confirmed by finalized materialization (no local transaction hash)'
    : ' · published more than once; the current transaction is not recorded';
}

/** One synthetic node per Knowledge Asset: by its tx, else by its UAL or
 *  assertion when no single transaction is known. */
function anchorUriFor(r: VmReceipt): string {
  return `urn:dkg:viz:anchor:${r.tx ?? encodeURIComponent(r.ual ?? r.assertion)}`;
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

/** Receipts newest first; receipts without a finalize time go last.
 *  Sorts a copy. Exported for tests. */
export function newestFirst(receipts: readonly VmReceipt[]): VmReceipt[] {
  return [...receipts].sort((x, y) => (y.finalizedAt ?? '').localeCompare(x.finalizedAt ?? ''));
}

/** Synthetic anchor / agent triples for the graph. Exported for tests. */
export function buildDecorationTriples(
  receipts: readonly VmReceipt[],
  visibleEntityUris: Set<string> | null,
): Triple[] {
  const out: Triple[] = [];
  const seenAgents = new Set<string>();

  for (const r of receipts) {
    // If we know which entities the graph is currently rendering (VM view),
    // restrict the anchor's edges to roots that will actually show up as
    // nodes — otherwise we end up with orphan anchor hubs floating next to
    // the graph, connected to roots that live only in SWM.
    // Members come from the seal rows and the per-KA graph; entities
    // namespaced under the assertion URI belong to it too (same rule as the
    // receipt summary).
    const visibleRoots = visibleEntityUris
      ? [...new Set([...r.members.filter(m => visibleEntityUris.has(m)), ...[...visibleEntityUris].filter(u => u !== r.assertion && isAtOrUnder(u, r.assertion))])]
      : r.members;
    if (visibleRoots.length === 0) continue;

    const anchorUri = anchorUriFor(r);
    // Anchor node typing + label so RdfGraph can render it with our viz colors.
    out.push({ subject: anchorUri, predicate: RDF_TYPE, object: VIZ_ANCHOR_TYPE, subGraph: r.subGraph });
    out.push({ subject: anchorUri, predicate: SCHEMA_NAME, object: `"${anchorLabel(r)}"`, subGraph: r.subGraph });
    out.push({
      subject: anchorUri,
      predicate: SCHEMA_DESC,
      object: `"Published ${r.members.length} KA${r.members.length === 1 ? '' : 's'}${r.finalizedAt ? ` · finalized ${r.finalizedAt}` : ' · finalize time unknown'}${noTxNote(r)}"`,
      subGraph: r.subGraph,
    });

    // anchor ← anchoredIn ← entity  (we model the edge outward-from-entity
    // so it reads `<decision> anchored-in <anchor>` in graph hover).
    for (const root of visibleRoots) {
      out.push({ subject: root, predicate: VIZ_PRED_ANCHORED_IN, object: anchorUri, subGraph: r.subGraph });
      // A per-entity consensus literal — picked up by the entity card / hover.
      // We only know 1 signer in the current devnet (minimumRequiredSignatures=1)
      // so we render 1-of-1. A production publish with a quorum would list
      // additional `signedBy` edges from anchor → each signing agent.
      out.push({
        subject: root,
        predicate: VIZ_PRED_CONSENSUS,
        object: `"${r.signers.length}-of-${r.signers.length}"`,
        subGraph: r.subGraph,
      });
    }

    // Agent nodes — dedupe so we don't emit 50 copies of the same DID.
    for (const agentRaw of r.signers) {
      const agent = agentRaw.startsWith('did:') || agentRaw.startsWith('12D3')
        ? agentRaw
        : `did:dkg:agent:${agentRaw}`;
      const agentUri = `urn:dkg:viz:agent:${encodeURIComponent(agent)}`;
      out.push({ subject: anchorUri, predicate: VIZ_PRED_SIGNED_BY, object: agentUri, subGraph: r.subGraph });
      if (!seenAgents.has(agentUri)) {
        seenAgents.add(agentUri);
        out.push({ subject: agentUri, predicate: RDF_TYPE, object: VIZ_AGENT_TYPE, subGraph: r.subGraph });
        out.push({ subject: agentUri, predicate: SCHEMA_NAME, object: `"${agentLabel(agent)}"`, subGraph: r.subGraph });
        out.push({ subject: agentUri, predicate: SCHEMA_DESC, object: `"${agent}"`, subGraph: r.subGraph });
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
  const anchors = useMemo(() => (receipts ? newestFirst(receipts) : []), [receipts]);

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
