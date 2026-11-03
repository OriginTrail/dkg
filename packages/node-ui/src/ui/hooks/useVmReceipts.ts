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
 *   <assertionUri>  dkg:kaUal                <did:dkg:<chain>/<addr>/<n>> (graph-scoped KAs)
 *
 * Membership has two shapes. Legacy (root-scoped) seals list their entities
 * with the member predicates above. Current graph-scoped seals list none:
 * the KA's content is the exact per-KA graph
 * `did:dkg:context-graph:<cg>[/<sub>]/_verifiable_memory/<addr>/<n>` named by
 * its `dkg:kaUal`, so its members are the subjects of that graph, read with a
 * second, VALUES-bounded query that asks for the context graph's registered
 * partitions (sub-graph VM graphs are only readable that way).
 *
 * Storage identities are parsed and built with core's helpers
 * (`parseContextGraphAssertionStorageUri`, `parseDeterministicKnowledgeAssetUal`,
 * `contextGraphLayerUri`); rows they don't recognise are skipped, never thrown.
 *
 * Both reads are capped. When a read hits its cap the result is marked
 * incomplete, so callers never treat an omitted receipt as a missing one.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { contextGraphLayerUri, parseContextGraphAssertionStorageUri } from '@origintrail-official/dkg-core/dist/constants.js';
import { parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core/dist/ka-content-scope.js';
import { MemoryLayer } from '@origintrail-official/dkg-core/dist/memory-model.js';
import { executeQuery, type QueryExecutionOptions } from '../api.js';
import { decodeAssertionIdentity } from '../assertion-identity.js';
import { bindingLexicalValue } from '../query-bindings.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';

const DKG = 'http://dkg.io/ontology/';

export interface VmReceipt {
  /** Assertion URI. Legacy members are namespaced under it. */
  assertion: string;
  /** Publish transaction hash. */
  tx: string;
  /** Latest finalize time as ISO, or null when the receipt has none. */
  finalizedAt: string | null;
  /** Entities the KA covers: seal member rows, plus the subjects of its
   *  per-KA graph for graph-scoped KAs. */
  members: string[];
  /** Agents that published it: attribution rows when present, otherwise the
   *  author address in the assertion URI (…/assertion/<addr>/<name>). */
  signers: string[];
  /** Sub-graph slug when the assertion lives in one. */
  subGraph?: string;
  /** Graph-scoped KAs: the per-KA Verifiable Memory graph holding the
   *  content, derived from `dkg:kaUal`. */
  kaGraph?: string;
}

/** Receipts plus whether every receipt and membership row was read. */
export interface VmReceiptLoad {
  receipts: VmReceipt[];
  /** false when a capped read came back full: some receipts or members may be missing. */
  complete: boolean;
}

export interface VmReceiptsState {
  /** null until the first load finishes (or when there is no graph). */
  receipts: VmReceipt[] | null;
  /** false when the last load hit a read cap (see `VmReceiptLoad`). */
  complete: boolean;
  loading: boolean;
  error: string | null;
}

/** A context graph id is embedded in an IRI ref; refuse anything that could break out of it. */
export function isSafeIriPart(value: string): boolean {
  return value.length > 0 && !/[\s<>"{}|^`\\]/.test(value);
}

/** Row caps for the two reads; a read that returns this many rows may be cut short. */
export const RECEIPT_ROW_LIMIT = 20000;
export const MEMBER_ROW_LIMIT = 20000;

export function buildVmReceiptQuery(cgId: string): string {
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?asrt ?tx ?finalizedAt ?agent ?member ?kaUal WHERE {
  GRAPH <did:dkg:context-graph:${cgId}/_meta> {
    ?asrt dkg:publishedAtTx ?tx .
    OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
    OPTIONAL { ?asrt prov:wasAttributedTo ?agent . }
    OPTIONAL { ?asrt dkg:kaUal ?kaUal . }
    OPTIONAL { { ?asrt dkg:assertionRootEntity ?member . } UNION { ?asrt dkg:assertionEntity ?member . } }
  }
} LIMIT ${RECEIPT_ROW_LIMIT}`;
}

/** Most per-KA graphs read by one membership query. */
export const KA_GRAPH_BATCH = 100;

/** Subjects of exact per-KA graphs: the members of graph-scoped KAs. */
export function buildKaGraphMemberQuery(kaGraphs: readonly string[]): string {
  const values = kaGraphs.filter(isSafeIriPart).map(g => `<${g}>`).join(' ');
  return `SELECT DISTINCT ?g ?member WHERE {
  VALUES ?g { ${values} }
  GRAPH ?g { ?member ?p ?o . }
  FILTER(isIRI(?member))
} LIMIT ${MEMBER_ROW_LIMIT}`;
}

/** Query options for the receipt read (`_meta` is in every scope). */
export const receiptQueryOptions = (cgId: string): QueryExecutionOptions => ({ contextGraphId: cgId });
/** Query options for the membership read: per-KA graphs inside registered
 *  sub-graphs are only readable through the context graph's partitions. */
export const memberQueryOptions = (cgId: string): QueryExecutionOptions => ({ contextGraphId: cgId, includeContextGraphPartitions: true });

const term = (v: unknown): string => (bindingLexicalValue(v) ?? '').trim();

/** The author DID encoded in an assertion URI, if any. */
function authorOf(assertion: string): string | null {
  const addr = parseContextGraphAssertionStorageUri(assertion)?.agentAddress;
  return addr ? `did:dkg:agent:${addr}` : null;
}

/** did:dkg:<chain>/<0x-author>/<n> → that KA's Verifiable Memory graph in
 *  this context graph (and sub-graph); undefined for anything else. */
export function kaGraphOf(kaUal: string, cgId: string, subGraph?: string): string | undefined {
  try {
    const ka = parseDeterministicKnowledgeAssetUal(kaUal);
    return contextGraphLayerUri(cgId, MemoryLayer.VerifiableMemory, ka.agentAddress, ka.kaNumber, subGraph);
  } catch {
    return undefined;
  }
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
      r = { assertion, tx, finalizedAt: null, members: [], signers: [], attributed: [], subGraph: decodeAssertionIdentity(assertion, cgId)?.subGraph };
      byAssertion.set(assertion, r);
    }
    const finalizedAt = isoOrNull(term(row.finalizedAt));
    if (finalizedAt && (!r.finalizedAt || finalizedAt > r.finalizedAt)) r.finalizedAt = finalizedAt;
    const member = term(row.member);
    if (member && !r.members.includes(member)) r.members.push(member);
    const agent = term(row.agent);
    if (agent && !r.attributed.includes(agent)) r.attributed.push(agent);
    const kaUal = term(row.kaUal);
    if (kaUal && !r.kaGraph) r.kaGraph = kaGraphOf(kaUal, cgId, r.subGraph);
  }
  return [...byAssertion.values()].map(({ attributed, ...r }) => {
    const author = authorOf(r.assertion);
    return { ...r, signers: attributed.length ? attributed : author ? [author] : [] };
  });
}

/** Add the subjects of each graph-scoped receipt's KA graph to its members. */
export function addKaGraphMembers(receipts: readonly VmReceipt[], rows: ReadonlyArray<Record<string, unknown>>): VmReceipt[] {
  const byGraph = new Map<string, string[]>();
  for (const row of rows) {
    const g = term(row.g);
    const member = term(row.member);
    if (!g || !member) continue;
    const list = byGraph.get(g);
    if (list) list.push(member);
    else byGraph.set(g, [member]);
  }
  return receipts.map(r => {
    const extra = r.kaGraph ? byGraph.get(r.kaGraph) : undefined;
    return extra ? { ...r, members: [...new Set([...r.members, ...extra])] } : r;
  });
}

/** Runs one read and returns its binding rows. */
export type VmQueryRunner = (sparql: string, options: QueryExecutionOptions) => Promise<Array<Record<string, unknown>>>;

const bindingsOf = (res: unknown): Array<Record<string, unknown>> => {
  const rows = (res as { result?: { bindings?: unknown } })?.result?.bindings;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
};

/** Load receipts with a given query runner (the API in the app, a scoped
 *  engine in tests), using the same queries and options either way. */
export async function loadVmReceiptsWith(cgId: string, run: VmQueryRunner): Promise<VmReceiptLoad> {
  const rows = await run(buildVmReceiptQuery(cgId), receiptQueryOptions(cgId));
  let complete = rows.length < RECEIPT_ROW_LIMIT;
  const receipts = parseVmReceiptRows(rows, cgId);
  const kaGraphs = [...new Set(receipts.flatMap(r => (r.kaGraph ? [r.kaGraph] : [])))];
  if (kaGraphs.length === 0) return { receipts, complete };
  const memberRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < kaGraphs.length; i += KA_GRAPH_BATCH) {
    const batch = await run(buildKaGraphMemberQuery(kaGraphs.slice(i, i + KA_GRAPH_BATCH)), memberQueryOptions(cgId));
    if (batch.length >= MEMBER_ROW_LIMIT) complete = false;
    memberRows.push(...batch);
  }
  return { receipts: addKaGraphMembers(receipts, memberRows), complete };
}

export function loadVmReceipts(cgId: string): Promise<VmReceiptLoad> {
  return loadVmReceiptsWith(cgId, async (sparql, options) => bindingsOf(await executeQuery(sparql, options)));
}

// Explicit reloads (a Refresh button) reach every mounted reader of a graph.
const refreshListeners = new Set<(cgId: string) => void>();

/** Reload receipts for a context graph wherever they're shown. */
export function refreshVmReceipts(contextGraphId: string): void {
  for (const listener of refreshListeners) listener(contextGraphId);
}

/** Receipts for a context graph. Reloads when the graph changes, when its
 *  Verifiable Memory changes (a publish), and on `refreshVmReceipts`. */
export function useVmReceipts(contextGraphId: string | undefined): VmReceiptsState {
  const [state, setState] = useState<VmReceiptsState>({ receipts: null, complete: true, loading: false, error: null });
  const [reloads, setReloads] = useState(0);
  const versionRef = useRef(0);
  const reload = useCallback(() => setReloads(n => n + 1), []);
  useMemoryGraphEvents(contextGraphId ?? '', reload, { layers: ['vm'] });
  useEffect(() => {
    if (!contextGraphId) return undefined;
    const listener = (cgId: string) => { if (cgId === contextGraphId) reload(); };
    refreshListeners.add(listener);
    return () => { refreshListeners.delete(listener); };
  }, [contextGraphId, reload]);
  useEffect(() => {
    const version = ++versionRef.current;
    if (!contextGraphId || !isSafeIriPart(contextGraphId)) {
      setState({ receipts: null, complete: true, loading: false, error: null });
      return;
    }
    // Keep the last receipts while reloading so facts and anchors don't flicker.
    setState(prev => ({ ...prev, loading: true, error: null }));
    loadVmReceipts(contextGraphId).then(
      ({ receipts, complete }) => { if (version === versionRef.current) setState({ receipts, complete, loading: false, error: null }); },
      (err: unknown) => {
        if (version !== versionRef.current) return;
        const message = err instanceof Error ? err.message : 'Failed to load publish receipts';
        setState({ receipts: null, complete: true, loading: false, error: message });
      },
    );
  }, [contextGraphId, reloads]);
  return state;
}
