/**
 * useEntityOnChainReceipt: the on-chain identity of ONE graph entity (UAL,
 * transaction hash, block number, on-chain id, author, finalize time, agent)
 * for the provenance card and the verified-identity banner.
 *
 * It does not query or interpret publish evidence itself. The receipt model
 * and its resolution policy live in `useVmReceipts` (named receipts, the
 * lifecycle link, confirmed KA and collection metadata, seal trust, which
 * transaction is current). This hook is the per-entity adapter: it reads the
 * graph's receipts from the nearest `VmReceiptsProvider` and picks the one
 * the entity belongs to (`receiptForEntity`).
 *
 * The one remaining query is for old stores only: an entity that no receipt
 * names (no member row, not under its assertion URI) may still be linked to
 * its assertion by a `ShareTransition` record in `_shared_memory_meta`,
 * which the publisher no longer writes. That record only says WHICH
 * assertion; the receipt itself still comes from the shared model.
 *
 * Status semantics:
 *   • 'verified'  — the entity belongs to an anchored Knowledge Asset.
 *   • 'offchain'  — no receipt covers it (Working / Shared Memory only).
 *   • 'error'     — a read failed (kept DISTINCT from 'offchain').
 *   • 'loading'   — receipts (or the old-store link) are still loading.
 *   • 'idle'      — no entity / disabled.
 *
 * Read-only over `/api/query`.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseContextGraphAssertionStorageUri } from '@origintrail-official/dkg-core/dist/constants.js';
import { isSafeIri, sparqlIri, sparqlString } from '@origintrail-official/dkg-core/sparql-safe';
import { executeQuery } from '../api.js';
import { bindingLexicalValue } from '../query-bindings.js';
import { useVmReceipts, type VmReceipt } from './useVmReceipts.js';
import { isAtOrUnder } from './useVmReceiptSummary.js';

const DKG = 'http://dkg.io/ontology/';

export type OnChainReceiptStatus = 'idle' | 'loading' | 'verified' | 'offchain' | 'error';

export interface EntityOnChainReceipt {
  status: OnChainReceiptStatus;
  /** Deterministic UAL: did:dkg:<chain>/<addr>/<number>. */
  ual: string | null;
  /** Transaction anchoring the current content (null when not determinable). */
  txHash: string | null;
  /** Block number of the publish, when unambiguous. */
  blockNumber: string | null;
  /** On-chain id of the Knowledge Asset, as a decimal string. */
  kaId: string | null;
  /** 0x author address. */
  author: string | null;
  /** Seal (finalize) time of the confirmed content, ISO. */
  finalizedAt: string | null;
  /** did:dkg:agent:… that published it. */
  agent: string | null;
  error?: string;
}

const EMPTY: EntityOnChainReceipt = {
  status: 'idle', ual: null, txHash: null, blockNumber: null, kaId: null, author: null, finalizedAt: null, agent: null,
};

const term = (v: unknown): string => (bindingLexicalValue(v) ?? '').trim();
const AUTHOR_IN_UAL = /^did:dkg:[^/]+\/(0x[0-9a-fA-F]{40})\//;

/** The receipt an entity belongs to: one whose assertion URI it lives under
 *  wins over one that lists it as a member; then the most specific (longest)
 *  assertion; then a stable order. Null when no receipt covers it. */
export function receiptForEntity(receipts: readonly VmReceipt[], entityUri: string): VmReceipt | null {
  let best: { r: VmReceipt; score: number } | null = null;
  for (const r of receipts) {
    const score = r.assertion !== r.ual && isAtOrUnder(entityUri, r.assertion) ? 2 : r.members.includes(entityUri) ? 1 : 0;
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && compareSpecific(r, best.r) < 0)) best = { r, score };
  }
  return best?.r ?? null;
}

const compareSpecific = (a: VmReceipt, b: VmReceipt): number =>
  b.assertion.length - a.assertion.length || (a.assertion < b.assertion ? -1 : a.assertion > b.assertion ? 1 : 0);

/** A receipt as the card and banner show it. */
export function entityReceiptOf(r: VmReceipt): EntityOnChainReceipt {
  const author = parseContextGraphAssertionStorageUri(r.assertion)?.agentAddress ?? r.ual?.match(AUTHOR_IN_UAL)?.[1] ?? null;
  return {
    status: 'verified',
    ual: r.ual ?? null,
    txHash: r.tx,
    blockNumber: r.blockNumber ?? null,
    kaId: r.batchId ?? null,
    author,
    finalizedAt: r.finalizedAt,
    agent: r.signers[0] ?? (author ? `did:dkg:agent:${author.toLowerCase()}` : null),
  };
}

/**
 * OLD STORES: entity → ShareTransition → `assertion/{addr}/{name}` and agent.
 * Cross-subgraph `GRAPH ?g` over `_shared_memory_meta`, so it is run without
 * a context-graph scope (that would constrain `GRAPH ?g` to CG-direct graphs
 * and drop the share records). Throws on an unsafe entity IRI.
 */
export function buildShareQuery(cgId: string, entityUri: string): string {
  return `PREFIX dkg: <${DKG}>
SELECT ?source ?agent ?ts WHERE {
  GRAPH ?g {
    ?op a dkg:ShareTransition ;
        dkg:entities ${sparqlIri(entityUri)} ;
        dkg:source ?source ;
        dkg:agent ?agent ;
        dkg:timestamp ?ts .
  }
  FILTER(
    STRSTARTS(STR(?g), ${sparqlString(`did:dkg:context-graph:${cgId}/`)}) &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} ORDER BY DESC(?ts) LIMIT 1`;
}

/** The receipt of `assertion/{addr}/{name}` (an old-store share source) for
 *  this entity: same-named assertions in other sub-graphs lose to the one the
 *  entity lives under, then to the most specific. */
export function receiptForShareSource(receipts: readonly VmReceipt[], source: string, entityUri: string): VmReceipt | null {
  const m = source.match(/^assertion\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const suffix = `/assertion/${m[1]}/${m[2]}`;
  const named = receipts.filter((r) => r.assertion.endsWith(suffix));
  named.sort((a, b) => Number(isAtOrUnder(entityUri, b.assertion)) - Number(isAtOrUnder(entityUri, a.assertion)) || compareSpecific(a, b));
  return named[0] ?? null;
}

interface ShareLink { key: string; source: string | null; agent: string | null; error?: string }

export function useEntityOnChainReceipt(
  contextGraphId: string | undefined,
  entityUri: string | null | undefined,
  enabled: boolean = true,
): EntityOnChainReceipt {
  const graph = enabled && entityUri ? contextGraphId : undefined;
  const { receipts, error } = useVmReceipts(graph);
  const direct = useMemo(() => (receipts && entityUri ? receiptForEntity(receipts, entityUri) : null), [receipts, entityUri]);
  const shareKey = graph && entityUri ? `${graph}\u0000${entityUri}` : '';
  const needsShare = !!shareKey && !!receipts && !direct;
  const [share, setShare] = useState<ShareLink | null>(null);

  useEffect(() => {
    if (!needsShare) return;
    let live = true;
    if (!isSafeIri(entityUri!)) {
      setShare({ key: shareKey, source: null, agent: null });
      return;
    }
    executeQuery(buildShareQuery(graph!, entityUri!)).then(
      (res) => {
        if (!live) return;
        const row = ((res as { result?: { bindings?: Array<Record<string, unknown>> } })?.result?.bindings ?? [])[0];
        setShare({ key: shareKey, source: row ? term(row.source) || null : null, agent: row ? term(row.agent) || null : null });
      },
      (err: unknown) => {
        if (!live) return;
        setShare({ key: shareKey, source: null, agent: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { live = false; };
  }, [needsShare, shareKey, graph, entityUri]);

  return useMemo((): EntityOnChainReceipt => {
    if (!graph || !entityUri) return EMPTY;
    if (error) return { ...EMPTY, status: 'error', error };
    if (!receipts) return { ...EMPTY, status: 'loading' };
    if (direct) return entityReceiptOf(direct);
    if (!share || share.key !== shareKey) return { ...EMPTY, status: 'loading' };
    if (share.error) return { ...EMPTY, status: 'error', error: share.error };
    const linked = share.source ? receiptForShareSource(receipts, share.source, entityUri) : null;
    if (linked) return { ...entityReceiptOf(linked), ...(share.agent && !linked.signers.length ? { agent: share.agent } : {}) };
    const addr = share.source?.match(/^assertion\/([^/]+)\//)?.[1] ?? null;
    return { ...EMPTY, status: 'offchain', author: addr, agent: share.agent };
  }, [graph, entityUri, error, receipts, direct, share, shareKey]);
}
