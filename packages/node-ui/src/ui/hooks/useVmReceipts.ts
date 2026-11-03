/**
 * Verifiable Memory publish receipts for a context graph — loaded and
 * normalised in one place.
 *
 * A receipt is what the chain gave back for a published assertion, stored in
 * `did:dkg:context-graph:<cg>/_meta`:
 *
 *   <assertionUri>  dkg:publishedAtTx        "0x…"   (real tx hash)
 *   <assertionUri>  dkg:assertionFinalizedAt "…"     (finalize time, optional)
 *   <assertionUri>  dkg:assertionRootEntity | dkg:assertionEntity <member>
 *   <assertionUri>  prov:wasAttributedTo     <did:dkg:agent:0x…> (optional)
 *
 * The SPARQL result has one row per (assertion, member, agent). This module
 * folds those rows into one typed `VmReceipt` per assertion, so the VM header
 * facts (`useVmReceiptSummary`) and the VM graph anchors
 * (`useVerifiableMemoryAnchors`) are pure projections of the same records and
 * never read raw query rows themselves. Both go through `executeQuery`, which
 * shares an identical in-flight request.
 *
 * Read-only over `/api/query`.
 */
import { useEffect, useRef, useState } from 'react';
import { executeQuery } from '../api.js';
import { bindingLexicalValue } from '../query-bindings.js';

const DKG = 'http://dkg.io/ontology/';

export interface VmReceipt {
  /** Assertion URI. Its member entities are namespaced under it. */
  assertion: string;
  /** Publish transaction hash. */
  tx: string;
  /** Latest finalize time as ISO, or null when the receipt has none. */
  finalizedAt: string | null;
  /** Entities listed as members of the assertion (roots and entities). */
  members: string[];
  /** Agents that published it: attribution rows when present, otherwise the
   *  author address in the assertion URI (…/assertion/<addr>/<name>). */
  signers: string[];
  /** Sub-graph slug when the assertion lives in one. */
  subGraph?: string;
}

export interface VmReceiptsState {
  /** null until the first load finishes (or when there is no graph). */
  receipts: VmReceipt[] | null;
  loading: boolean;
  error: string | null;
}

/** A context graph id is embedded in an IRI ref; refuse anything that could break out of it. */
export function isSafeIriPart(value: string): boolean {
  return value.length > 0 && !/[\s<>"{}|^`\\]/.test(value);
}

export function buildVmReceiptQuery(cgId: string): string {
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?asrt ?tx ?finalizedAt ?agent ?member WHERE {
  GRAPH <did:dkg:context-graph:${cgId}/_meta> {
    ?asrt dkg:publishedAtTx ?tx .
    OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
    OPTIONAL { ?asrt prov:wasAttributedTo ?agent . }
    OPTIONAL { { ?asrt dkg:assertionRootEntity ?member . } UNION { ?asrt dkg:assertionEntity ?member . } }
  }
} LIMIT 20000`;
}

const term = (v: unknown): string => (bindingLexicalValue(v) ?? '').trim();

/** The author DID encoded in an assertion URI, if any. */
function authorOf(assertion: string): string | null {
  const addr = assertion.match(/\/assertion\/([^/]+)\//)?.[1];
  return addr ? `did:dkg:agent:${addr}` : null;
}

/** did:dkg:context-graph:<cg>/<sub>/assertion/… → <sub> (undefined at the root). */
function subGraphOf(assertion: string, cgId: string): string | undefined {
  const prefix = `did:dkg:context-graph:${cgId}/`;
  if (!assertion.startsWith(prefix)) return undefined;
  const seg = assertion.slice(prefix.length).split('/')[0];
  return seg && seg !== 'assertion' ? seg : undefined;
}

function isoOrNull(value: string): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Fold query rows into one receipt per assertion. Rows without an assertion
 *  or a transaction are not receipts and are skipped. */
export function parseVmReceiptRows(rows: ReadonlyArray<Record<string, unknown>>, cgId: string): VmReceipt[] {
  const byAssertion = new Map<string, VmReceipt & { attributed: string[] }>();
  for (const row of rows) {
    const assertion = term(row.asrt);
    const tx = term(row.tx);
    if (!assertion || !tx) continue;
    let r = byAssertion.get(assertion);
    if (!r) {
      r = { assertion, tx, finalizedAt: null, members: [], signers: [], attributed: [], subGraph: subGraphOf(assertion, cgId) };
      byAssertion.set(assertion, r);
    }
    const finalizedAt = isoOrNull(term(row.finalizedAt));
    if (finalizedAt && (!r.finalizedAt || finalizedAt > r.finalizedAt)) r.finalizedAt = finalizedAt;
    const member = term(row.member);
    if (member && !r.members.includes(member)) r.members.push(member);
    const agent = term(row.agent);
    if (agent && !r.attributed.includes(agent)) r.attributed.push(agent);
  }
  return [...byAssertion.values()].map(({ attributed, ...r }) => {
    const author = authorOf(r.assertion);
    return { ...r, signers: attributed.length ? attributed : author ? [author] : [] };
  });
}

export async function loadVmReceipts(cgId: string): Promise<VmReceipt[]> {
  const res = await executeQuery(buildVmReceiptQuery(cgId), { contextGraphId: cgId });
  const rows = ((res as { result?: { bindings?: unknown } })?.result?.bindings ?? []) as Array<Record<string, unknown>>;
  return parseVmReceiptRows(Array.isArray(rows) ? rows : [], cgId);
}

/** Receipts for a context graph; reloads when the graph changes. */
export function useVmReceipts(contextGraphId: string | undefined): VmReceiptsState {
  const [state, setState] = useState<VmReceiptsState>({ receipts: null, loading: false, error: null });
  const versionRef = useRef(0);
  useEffect(() => {
    const version = ++versionRef.current;
    if (!contextGraphId || !isSafeIriPart(contextGraphId)) {
      setState({ receipts: null, loading: false, error: null });
      return;
    }
    setState(prev => ({ ...prev, loading: true, error: null }));
    loadVmReceipts(contextGraphId).then(
      receipts => { if (version === versionRef.current) setState({ receipts, loading: false, error: null }); },
      (err: unknown) => {
        if (version !== versionRef.current) return;
        const message = err instanceof Error ? err.message : 'Failed to load publish receipts';
        setState({ receipts: null, loading: false, error: message });
      },
    );
  }, [contextGraphId]);
  return state;
}
