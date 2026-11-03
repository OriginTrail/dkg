/**
 * Verifiable Memory publish receipts for a context graph — loaded and
 * normalised in one place.
 *
 * Confirmed Knowledge Assets leave two kinds of record in
 * `did:dkg:context-graph:<cg>/_meta`:
 *
 *   Named-assertion receipt (local publishes; append-only):
 *     <assertionUri>  dkg:publishedAtTx        "0x…"   (one per publish)
 *     <assertionUri>  dkg:assertionFinalizedAt "…"     (seal time, optional)
 *     <assertionUri>  dkg:assertionRootEntity | dkg:assertionEntity <member>  (legacy)
 *     <assertionUri>  dkg:kaUal                <ual>   (graph-scoped KAs)
 *     <assertionUri>  prov:wasAttributedTo     <did:dkg:agent:0x…>
 *
 *   Confirmed KA metadata on the UAL (version-bound: rewritten per version;
 *   also written for assets that arrived through sync):
 *     <ual>  dkg:status "confirmed" ; dkg:kaUal <ual> ; dkg:assertionGraph <per-KA VM graph>
 *     <ual>  dkg:confirmationKind "transaction" | "finalized-materialization"
 *     <ual>  dkg:transactionHash "0x…"   (transaction kind only)
 *
 * Both kinds fold into one `VmReceipt` per Knowledge Asset (keyed by UAL
 * when there is one, else by assertion URI). Members come from legacy
 * member rows plus the subjects of the per-KA graph (`dkg:assertionGraph`,
 * else derived from the UAL), read with a second, VALUES-bounded query over
 * the context graph's partitions.
 *
 * Which transaction anchors the current content:
 *   1. The UAL metadata's single `dkg:transactionHash`: it belongs to the
 *      confirmed version, so it wins over any named receipt.
 *   2. Otherwise a named receipt with exactly one distinct transaction.
 *   3. Otherwise none. A finalized materialization carries no local hash,
 *      and a named assertion published more than once keeps several hashes
 *      and blocks with nothing pairing them, so the current one can't be
 *      told apart. Either way the asset is anchored; `tx` is null rather
 *      than a guess.
 *
 * `finalizedAt` is the seal time (`dkg:assertionFinalizedAt`) only; publish
 * and sync times are different events and never stand in for it.
 *
 * Storage identities are parsed and built with core's helpers; rows they
 * don't recognise are skipped, never thrown. Both reads are capped; when a
 * read hits its cap the result is marked incomplete, so callers never treat
 * an omitted receipt as a missing one.
 *
 * One resource per graph: `VmReceiptsProvider` (ProjectView) owns the load,
 * reload on Verifiable Memory changes and `refresh()`; the VM header facts
 * (`useVmReceiptSummary`) and graph anchors (`useVerifiableMemoryAnchors`)
 * read it through `useVmReceipts` and project it. Outside a provider for
 * that graph, `useVmReceipts` owns a resource of its own.
 *
 * Read-only over `/api/query`.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { contextGraphLayerUri, parseContextGraphAssertionStorageUri } from '@origintrail-official/dkg-core/dist/constants.js';
import { parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core/dist/ka-content-scope.js';
import { MemoryLayer } from '@origintrail-official/dkg-core/dist/memory-model.js';
import { executeQuery, type QueryExecutionOptions } from '../api.js';
import { decodeAssertionIdentity } from '../assertion-identity.js';
import { bindingLexicalValue } from '../query-bindings.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';

const DKG = 'http://dkg.io/ontology/';

/** How the chain confirmation is known. */
export type VmConfirmation =
  /** A local publish receipt (`dkg:publishedAtTx`). */
  | 'receipt'
  /** Confirmed KA metadata carrying the transaction hash. */
  | 'transaction'
  /** Confirmed through finalized materialization (synced); no local tx hash. */
  | 'finalized-materialization';

export interface VmReceipt {
  /** Assertion URI when the KA has a named assertion, else its UAL. */
  assertion: string;
  /** The KA's UAL, when known. */
  ual?: string;
  /** The transaction anchoring the current content, or null when the
   *  records don't identify one (see the module comment). */
  tx: string | null;
  confirmation: VmConfirmation;
  /** Seal (finalize) time as ISO, or null when unknown. */
  finalizedAt: string | null;
  /** Entities the KA covers: seal member rows, plus the subjects of its
   *  per-KA graph for graph-scoped KAs. */
  members: string[];
  /** Agents that published it: attribution rows when present, otherwise the
   *  author address in the assertion URI (…/assertion/<addr>/<name>). */
  signers: string[];
  /** Sub-graph slug when the assertion lives in one. */
  subGraph?: string;
  /** Graph-scoped KAs: the per-KA Verifiable Memory graph holding the content. */
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
SELECT ?asrt ?ual ?tx ?kind ?finalizedAt ?agent ?member ?kaUal ?kaGraph WHERE {
  GRAPH <did:dkg:context-graph:${cgId}/_meta> {
    {
      ?asrt dkg:publishedAtTx ?tx .
      OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
      OPTIONAL { ?asrt prov:wasAttributedTo ?agent . }
      OPTIONAL { ?asrt dkg:kaUal ?kaUal . }
      OPTIONAL { { ?asrt dkg:assertionRootEntity ?member . } UNION { ?asrt dkg:assertionEntity ?member . } }
    } UNION {
      ?ual dkg:status "confirmed" ; dkg:kaUal ?ual ; dkg:assertionGraph ?kaGraph .
      OPTIONAL { ?ual dkg:transactionHash ?tx . }
      OPTIONAL { ?ual dkg:confirmationKind ?kind . }
      OPTIONAL { ?ual prov:wasAttributedTo ?agent . }
    }
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

interface Folding {
  assertion?: string;
  ual?: string;
  /** Distinct transactions on the named assertion (append-only receipts). */
  receiptTxs: string[];
  /** Distinct transaction hashes on the UAL's confirmed metadata. */
  ualTxs: string[];
  /** The UAL's confirmed metadata was read. */
  ualConfirmed: boolean;
  kind?: string;
  finalizedAt: string | null;
  members: string[];
  attributed: string[];
  kaGraph?: string;
  subGraph?: string;
}

/** Fold query rows into one receipt per Knowledge Asset (by UAL, else by
 *  assertion URI). Rows that name neither a receipted assertion nor a
 *  confirmed UAL are skipped. */
export function parseVmReceiptRows(rows: ReadonlyArray<Record<string, unknown>>, cgId: string): VmReceipt[] {
  const byKey = new Map<string, Folding>();
  const add = (list: string[], v: string) => { if (v && !list.includes(v)) list.push(v); };
  for (const row of rows) {
    const assertion = term(row.asrt);
    const ual = term(row.ual) || term(row.kaUal);
    const tx = term(row.tx);
    if (assertion && !tx) continue; // a seal without a receipt
    if (!assertion && !ual) continue;
    const key = ual || assertion;
    let f = byKey.get(key);
    if (!f) { f = { receiptTxs: [], ualTxs: [], ualConfirmed: false, finalizedAt: null, members: [], attributed: [] }; byKey.set(key, f); }
    if (assertion) {
      f.assertion = assertion;
      f.subGraph ??= decodeAssertionIdentity(assertion, cgId)?.subGraph;
      add(f.receiptTxs, tx);
      // Seal time comes from the named assertion only.
      const finalizedAt = isoOrNull(term(row.finalizedAt));
      if (finalizedAt && (!f.finalizedAt || finalizedAt > f.finalizedAt)) f.finalizedAt = finalizedAt;
    } else {
      f.ualConfirmed = true;
      add(f.ualTxs, tx);
      const kind = term(row.kind);
      if (kind) f.kind = kind;
    }
    if (ual) {
      f.ual = ual;
      // The UAL's own dkg:assertionGraph is authoritative; otherwise derive it from the UAL.
      const explicit = term(row.kaGraph);
      if (explicit) f.kaGraph = explicit;
      else f.kaGraph ??= kaGraphOf(ual, cgId, f.subGraph);
    }
    add(f.members, term(row.member));
    add(f.attributed, term(row.agent));
  }
  const out: VmReceipt[] = [];
  for (const f of byKey.values()) {
    const resolved = resolveTx(f);
    if (!resolved) continue;
    const assertion = f.assertion ?? f.ual!;
    const author = f.assertion ? authorOf(f.assertion) : null;
    out.push({
      assertion,
      ...(f.ual ? { ual: f.ual } : {}),
      tx: resolved.tx,
      confirmation: resolved.confirmation,
      finalizedAt: f.finalizedAt,
      members: f.members,
      signers: f.attributed.length ? f.attributed : author ? [author] : [],
      subGraph: f.subGraph,
      ...(f.kaGraph ? { kaGraph: f.kaGraph } : {}),
    });
  }
  return out;
}

/** The transaction anchoring the current content (see the module comment),
 *  or null when the KA isn't anchored at all. */
function resolveTx(f: Folding): { tx: string | null; confirmation: VmConfirmation } | null {
  if (f.ualConfirmed) {
    if (f.ualTxs.length === 1) return { tx: f.ualTxs[0], confirmation: 'transaction' };
    if (f.ualTxs.length === 0 && f.kind === 'finalized-materialization') return { tx: null, confirmation: 'finalized-materialization' };
  }
  if (f.receiptTxs.length === 1) return { tx: f.receiptTxs[0], confirmation: 'receipt' };
  if (f.receiptTxs.length > 1) return { tx: null, confirmation: 'receipt' };
  return null; // confirmed status without usable provenance: not anchored
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

/** A graph's receipts plus the way to reload them. */
export interface VmReceiptsResource extends VmReceiptsState {
  contextGraphId: string | undefined;
  /** Reload now (a Refresh button); also happens on Verifiable Memory changes. */
  refresh: () => void;
}

/** Load and own the receipts of one graph. Reloads when the graph changes,
 *  when its Verifiable Memory changes (a publish), and on `refresh()`. */
export function useVmReceiptsResource(contextGraphId: string | undefined): VmReceiptsResource {
  const [state, setState] = useState<VmReceiptsState>({ receipts: null, complete: true, loading: false, error: null });
  const [reloads, setReloads] = useState(0);
  const versionRef = useRef(0);
  const loadedGraphRef = useRef<string | undefined>(undefined);
  const refresh = useCallback(() => setReloads(n => n + 1), []);
  useMemoryGraphEvents(contextGraphId ?? '', refresh, { layers: ['vm'] });
  useEffect(() => {
    const version = ++versionRef.current;
    if (!contextGraphId || !isSafeIriPart(contextGraphId)) {
      setState({ receipts: null, complete: true, loading: false, error: null });
      return;
    }
    // Reloading the same graph keeps its receipts on screen (no flicker);
    // another graph starts from nothing, so its facts and anchors never show
    // the previous graph's members or signers.
    const sameGraph = loadedGraphRef.current === contextGraphId;
    setState(prev => (sameGraph ? { ...prev, loading: true, error: null } : { receipts: null, complete: true, loading: true, error: null }));
    loadVmReceipts(contextGraphId).then(
      ({ receipts, complete }) => {
        if (version !== versionRef.current) return;
        loadedGraphRef.current = contextGraphId;
        setState({ receipts, complete, loading: false, error: null });
      },
      (err: unknown) => {
        if (version !== versionRef.current) return;
        const message = err instanceof Error ? err.message : 'Failed to load publish receipts';
        setState({ receipts: null, complete: true, loading: false, error: message });
      },
    );
  }, [contextGraphId, reloads]);
  return { ...state, contextGraphId, refresh };
}

const VmReceiptsContext = createContext<VmReceiptsResource | null>(null);

/** Shares one graph's receipts with everything below it (ProjectView). */
export function VmReceiptsProvider({ value, children }: { value: VmReceiptsResource; children?: React.ReactNode }) {
  return React.createElement(VmReceiptsContext.Provider, { value }, children);
}

/** A graph's receipts: the provider's when it holds this graph, otherwise a
 *  resource of this hook's own. */
export function useVmReceipts(contextGraphId: string | undefined): VmReceiptsResource {
  const shared = useContext(VmReceiptsContext);
  const useShared = !!shared && shared.contextGraphId === contextGraphId;
  const own = useVmReceiptsResource(useShared ? undefined : contextGraphId);
  return useShared ? shared : own;
}
