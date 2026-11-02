/**
 * useVmReceiptSummary — graph-level summary of REAL on-chain publish
 * receipts for a context graph (C11, Verifiable Memory header facts).
 *
 * Reads the same receipt rows `useEntityOnChainReceipt` reads for a single
 * entity, but for every assertion at once:
 *
 *   <assertionUri>  dkg:publishedAtTx        "0x…"   (real tx hash)
 *   <assertionUri>  dkg:assertionFinalizedAt "…"     (finalize time)
 *   <assertionUri>  dkg:assertionRootEntity | dkg:assertionEntity <member>
 *   <assertionUri>  prov:wasAttributedTo     <did:dkg:agent:0x…>
 *
 * all in `did:dkg:context-graph:<cg>/_meta`.
 *
 * Deliberately NOT `useVerifiableMemoryAnchors`: that hook reads
 * WorkspaceOperation records from `_shared_memory_meta` (share batches),
 * which are not chain receipts.
 *
 * Read-only over `/api/query`.
 */
import { useEffect, useRef, useState } from 'react';
import { executeQuery } from '../api.js';

const DKG = 'http://dkg.io/ontology/';

export interface VmReceiptSummary {
  /** Assertion URIs that have a real publish tx. Member entities are also
   *  namespaced under their assertion URI, so these double as prefixes. */
  assertions: string[];
  /** Entity IRIs listed as members of a receipted assertion. */
  members: Set<string>;
  /** Distinct agents that published (attribution, else the assertion author). */
  signers: Set<string>;
  /** Latest finalize time (ms), or null when unknown. */
  lastPublishedAt: number | null;
}

export interface VmReceiptSummaryState {
  summary: VmReceiptSummary | null;
  loading: boolean;
  error: string | null;
}

function bv(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    return v.startsWith('"') ? v.replace(/^"/, '').replace(/"(\^\^<[^>]*>|@[\w-]+)?$/, '') : v;
  }
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw == null ? '' : String(raw);
  }
  return String(v);
}
const unwrapIri = (s: string) => { const t = s.trim(); return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t; };

/** A context graph id is embedded in an IRI ref; refuse anything that could break out of it. */
export function isSafeIriPart(value: string): boolean {
  return value.length > 0 && !/[\s<>"{}|^`\\]/.test(value);
}

export function buildVmReceiptSummaryQuery(cgId: string): string {
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?asrt ?finalizedAt ?agent ?member WHERE {
  GRAPH <did:dkg:context-graph:${cgId}/_meta> {
    ?asrt dkg:publishedAtTx ?tx .
    OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
    OPTIONAL { ?asrt prov:wasAttributedTo ?agent . }
    OPTIONAL { { ?asrt dkg:assertionRootEntity ?member . } UNION { ?asrt dkg:assertionEntity ?member . } }
  }
} LIMIT 20000`;
}

/** Fold query rows into a summary. Exported for tests. */
export function summariseVmReceipts(rows: Array<Record<string, unknown>>): VmReceiptSummary {
  const assertions = new Set<string>();
  const members = new Set<string>();
  const signers = new Set<string>();
  let last: number | null = null;
  for (const row of rows) {
    const asrt = unwrapIri(bv(row.asrt));
    if (!asrt) continue;
    assertions.add(asrt);
    const member = unwrapIri(bv(row.member));
    if (member) members.add(member);
    // Attribution row when present; otherwise the author address is part of
    // the assertion URI (…/assertion/<addr>/<name>), as the per-entity
    // receipt hook also falls back to.
    const agent = unwrapIri(bv(row.agent));
    const addr = asrt.match(/\/assertion\/([^/]+)\//)?.[1];
    if (agent) signers.add(agent);
    else if (addr) signers.add(`did:dkg:agent:${addr}`);
    const t = Date.parse(bv(row.finalizedAt));
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return { assertions: [...assertions], members, signers, lastPublishedAt: last };
}

/** Is this entity covered by a receipted assertion (member row or URI prefix)? */
export function hasReceipt(entityUri: string, s: VmReceiptSummary): boolean {
  if (s.members.has(entityUri)) return true;
  for (const a of s.assertions) if (entityUri.startsWith(a)) return true;
  return false;
}

export function useVmReceiptSummary(contextGraphId: string | undefined): VmReceiptSummaryState {
  const [state, setState] = useState<VmReceiptSummaryState>({ summary: null, loading: false, error: null });
  const versionRef = useRef(0);
  useEffect(() => {
    if (!contextGraphId || !isSafeIriPart(contextGraphId)) {
      setState({ summary: null, loading: false, error: null });
      return;
    }
    const version = ++versionRef.current;
    setState(prev => ({ ...prev, loading: true, error: null }));
    (async () => {
      try {
        const res = await executeQuery(buildVmReceiptSummaryQuery(contextGraphId), { contextGraphId });
        if (version !== versionRef.current) return;
        const rows = ((res as any)?.result?.bindings ?? []) as Array<Record<string, unknown>>;
        setState({ summary: summariseVmReceipts(rows), loading: false, error: null });
      } catch (err: any) {
        if (version !== versionRef.current) return;
        setState({ summary: null, loading: false, error: err?.message ?? 'Failed to load publish receipts' });
      }
    })();
  }, [contextGraphId]);
  return state;
}
