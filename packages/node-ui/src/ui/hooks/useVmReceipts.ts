/**
 * Verifiable Memory publish receipts for a context graph — loaded and
 * normalised in one place.
 *
 * Confirmed Knowledge Assets leave these records in
 * `did:dkg:context-graph:<cg>/_meta`:
 *
 *   Named-assertion publish receipt (append-only, one per publish):
 *     <assertionUri>  dkg:publishedAtTx  "0x…"
 *
 *   The assertion's active seal, on the same subject (MUTABLE: cleared when
 *   the assertion is reopened, rewritten for the next version on finalize):
 *     <assertionUri>  dkg:assertionMerkleRoot, dkg:assertionFinalizedAt,
 *                     dkg:contentScopeVersion, dkg:kaUal,
 *                     dkg:assertionRootEntity | dkg:assertionEntity (legacy members)
 *
 *   The assertion's lifecycle record (durable across reopen and re-finalize):
 *     <urn:dkg:assertion:<cg>:[<sub>:]<addr>:<name>>  dkg:reservedUal "<ual>"
 *
 *   Confirmed collection metadata from the older direct-publish path (no
 *   named receipt, no per-KA graph):
 *     <ual>  dkg:status "confirmed" ; dkg:transactionHash "0x…" ; dkg:batchId n
 *     <ual>  dkg:rootEntity | dkg:entity <member>       (current shape)
 *     <ual>/<n>  dkg:partOf <ual> ; dkg:rootEntity <member>  (older replicas)
 *
 *   Confirmed KA metadata on the UAL (version-bound: rewritten per version;
 *   also written for assets that arrived through sync):
 *     <ual>  dkg:status "confirmed" ; dkg:kaUal <ual> ; dkg:assertionGraph <per-KA VM graph>
 *     <ual>  dkg:merkleRoot "…" ; dkg:confirmationKind "transaction" | "finalized-materialization"
 *     <ual>  dkg:transactionHash "0x…"   (transaction kind only)
 *
 * Everything folds into one `VmReceipt` per Knowledge Asset, keyed by its UAL
 * when known (the lifecycle record's reservedUal, else the seal's kaUal), else
 * by assertion URI. A reopened assertion therefore stays one record.
 *
 * Which transaction anchors the current content:
 *   1. The UAL metadata's single `dkg:transactionHash`: it belongs to the
 *      confirmed version, so it wins over any named receipt.
 *   2. Otherwise a named receipt with exactly one distinct transaction.
 *   3. Otherwise none. A finalized materialization carries no local hash,
 *      and a named assertion published more than once keeps several hashes
 *      and blocks with nothing pairing them. Either way the asset is
 *      anchored; `tx` is null rather than a guess.
 *
 * Seal facts (finalize time, legacy member rows) describe whatever version
 * was last sealed, which may be an unpublished draft. They are used only
 * when the seal is the confirmed content: its merkle root equals the UAL
 * metadata's root, or, with no UAL metadata, it is a legacy root-scoped seal
 * (new finalizes only write graph-scoped seals, so a legacy seal is never a
 * newer draft). Otherwise the finalize time is unknown. `finalizedAt` never
 * comes from publish or sync times.
 *
 * A publish receipt's block number is kept only when the assertion has exactly
 * one receipt (one hash and one block); the on-chain id comes from the UAL's
 * `dkg:batchId`, else a legacy `dkg:publishedAtKaId` row.
 *
 * Members come from trusted legacy member rows, collection member rows, plus the subjects of the
 * per-KA graph (`dkg:assertionGraph`, else derived from the UAL), read with a
 * second, VALUES-bounded query over the context graph's partitions.
 *
 * IRIs are validated and serialised with core's SPARQL helpers. Rows the
 * parser doesn't recognise are skipped, never thrown. Both reads are capped;
 * when a read hits its cap the result is marked incomplete, so callers never
 * treat an omitted receipt as a missing one.
 *
 * Ownership: `useVmReceiptsResource` owns one graph's load (ProjectView, the
 * standalone layer view) and shares it through `VmReceiptsProvider`.
 * `useVmReceipts` only reads that provider; the VM header facts, graph
 * anchors and the entity provenance card (`receiptForEntity`) project it.
 *
 * Read-only over `/api/query`.
 */
import React, { createContext, useCallback, useContext } from 'react';
import {
  assertionLifecycleUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  parseContextGraphAssertionStorageUri,
} from '@origintrail-official/dkg-core/dist/constants.js';
import { parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core/dist/ka-content-scope.js';
import { MemoryLayer } from '@origintrail-official/dkg-core/dist/memory-model.js';
import { isSafeIri, sparqlIri, sparqlString } from '@origintrail-official/dkg-core/sparql-safe';
import { executeQuery, type QueryExecutionOptions } from '../api.js';
import { useFetch } from '../hooks.js';
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
  /** Seal (finalize) time of the confirmed content as ISO, or null when unknown. */
  finalizedAt: string | null;
  /** Entities the KA covers: trusted seal member rows, plus the subjects of
   *  its per-KA graph for graph-scoped KAs. */
  members: string[];
  /** Agents that published it: attribution rows when present, otherwise the
   *  author address in the assertion URI (…/assertion/<addr>/<name>). */
  signers: string[];
  /** Sub-graph slug when the assertion lives in one. */
  subGraph?: string;
  /** Graph-scoped KAs: the per-KA Verifiable Memory graph holding the content. */
  kaGraph?: string;
  /** Block of the publish, when exactly one receipt pairs one hash with one block. */
  blockNumber?: string;
  /** The on-chain id (UAL `dkg:batchId`, else a legacy `dkg:publishedAtKaId`). */
  batchId?: string;
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

/** Row caps for the two reads; a read that returns this many rows may be cut short. */
export const RECEIPT_ROW_LIMIT = 20000;
export const MEMBER_ROW_LIMIT = 20000;

/** The graph's `_meta` IRI, or undefined when the id can't form a safe IRI. */
export function receiptMetaGraph(cgId: string | undefined): string | undefined {
  if (!cgId) return undefined;
  const meta = contextGraphMetaUri(cgId);
  return isSafeIri(meta) ? meta : undefined;
}

/** Throws (via core's helpers) when `cgId` can't form a safe graph IRI. */
export function buildVmReceiptQuery(cgId: string): string {
  return `PREFIX dkg: <${DKG}>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?asrt ?ual ?kc ?life ?tx ?block ?batchId ?kind ?finalizedAt ?agent ?member ?kaUal ?kaGraph ?sealRoot ?scope ?ualRoot ?reservedUal ?lifeAgent ?kcSub WHERE {
  GRAPH ${sparqlIri(contextGraphMetaUri(cgId))} {
    {
      ?asrt dkg:publishedAtTx ?tx .
      OPTIONAL { ?asrt dkg:publishedAtBlock ?block . }
      OPTIONAL { ?asrt dkg:publishedAtKaId ?batchId . }
      OPTIONAL { ?asrt dkg:assertionMerkleRoot ?sealRoot . }
      OPTIONAL { ?asrt dkg:contentScopeVersion ?scope . }
      OPTIONAL { ?asrt dkg:assertionFinalizedAt ?finalizedAt . }
      OPTIONAL { ?asrt prov:wasAttributedTo ?agent . }
      OPTIONAL { ?asrt dkg:kaUal ?kaUal . }
      OPTIONAL { { ?asrt dkg:assertionRootEntity ?member . } UNION { ?asrt dkg:assertionEntity ?member . } }
    } UNION {
      ?ual dkg:status "confirmed" ; dkg:kaUal ?ual ; dkg:assertionGraph ?kaGraph .
      OPTIONAL { ?ual dkg:transactionHash ?tx . }
      OPTIONAL { ?ual dkg:merkleRoot ?ualRoot . }
      OPTIONAL { ?ual dkg:confirmationKind ?kind . }
      OPTIONAL { ?ual dkg:batchId ?batchId . }
      OPTIONAL { ?ual prov:wasAttributedTo ?agent . }
    } UNION {
      ?kc dkg:status "confirmed" ; dkg:transactionHash ?tx .
      FILTER NOT EXISTS { ?kc dkg:assertionGraph ?graphScoped . }
      OPTIONAL { ?kc dkg:batchId ?batchId . }
      OPTIONAL { ?kc dkg:subGraphName ?kcSub . }
      OPTIONAL { ?kc prov:wasAttributedTo ?agent . }
      OPTIONAL {
        { ?kc dkg:rootEntity ?member . } UNION { ?kc dkg:entity ?member . }
        UNION { ?part dkg:partOf ?kc . { ?part dkg:rootEntity ?member . } UNION { ?part dkg:entity ?member . } }
      }
    } UNION {
      ?life dkg:reservedUal ?reservedUal .
      OPTIONAL { ?life prov:wasAttributedTo ?lifeAgent . }
      FILTER(STRSTARTS(STR(?life), ${sparqlString(`urn:dkg:assertion:${cgId}:`)}))
    }
  }
} LIMIT ${RECEIPT_ROW_LIMIT}`;
}

/** Most per-KA graphs read by one membership query. */
export const KA_GRAPH_BATCH = 100;

/** Subjects of exact per-KA graphs: the members of graph-scoped KAs.
 *  Graphs that aren't safe IRIs are skipped. */
export function buildKaGraphMemberQuery(kaGraphs: readonly string[]): string {
  const values = kaGraphs.filter(isSafeIri).map(sparqlIri).join(' ');
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

/** Ethereum addresses in identifiers compare case-insensitively. */
const normaliseAddresses = (s: string): string => s.replace(/0x[0-9a-fA-F]{40}/g, (m) => m.toLowerCase());
const normaliseRoot = (s: string): string => s.replace(/^0x/i, '').toLowerCase();

/** The author DID encoded in an assertion URI, if any. */
function authorOf(assertion: string): string | null {
  const addr = parseContextGraphAssertionStorageUri(assertion)?.agentAddress;
  return addr ? `did:dkg:agent:${addr}` : null;
}

/** The lifecycle record URN for a named assertion, address-normalised. */
function lifecycleKeyOf(assertion: string, cgId: string): string | undefined {
  const coordinate = parseContextGraphAssertionStorageUri(assertion);
  const identity = decodeAssertionIdentity(assertion, cgId);
  if (!coordinate || !identity) return undefined;
  return normaliseAddresses(assertionLifecycleUri(cgId, coordinate.agentAddress, identity.name, identity.subGraph));
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
  ualRoots: string[];
  kind?: string;
  /** Active-seal facts on the named assertion; trusted only after `sealIsConfirmed`. */
  sealRoots: string[];
  sealScopes: string[];
  sealFinalizedAt: string | null;
  sealMembers: string[];
  attributed: string[];
  kaGraph?: string;
  subGraph?: string;
  /** Distinct blocks on the named assertion's receipts. */
  receiptBlocks: string[];
  batchIds: string[];
  /** Older direct-publish collection metadata was read. */
  kcConfirmed: boolean;
  kcTxs: string[];
  kcMembers: string[];
  /** Attribution on the assertion's lifecycle record (older stores). */
  lifecycleAgent?: string;
}

/** The active seal describes the confirmed content (see the module comment). */
function sealIsConfirmed(f: Folding): boolean {
  if (f.sealRoots.length !== 1) return false;
  if (f.ualConfirmed) return f.ualRoots.length === 1 && f.ualRoots[0] === f.sealRoots[0];
  const legacy = f.sealScopes.length === 0 || f.sealScopes.every((s) => s === '1');
  return legacy;
}

/** Fold query rows into one receipt per Knowledge Asset (by UAL, else by
 *  assertion URI). Rows that name neither a receipted assertion nor a
 *  confirmed UAL are skipped. */
export function parseVmReceiptRows(rows: ReadonlyArray<Record<string, unknown>>, cgId: string): VmReceipt[] {
  const add = (list: string[], v: string) => { if (v && !list.includes(v)) list.push(v); };
  // The durable assertion → UAL links, from the lifecycle records.
  const reserved = new Map<string, string>();
  const lifeAgents = new Map<string, string>();
  for (const row of rows) {
    const life = term(row.life);
    const ual = term(row.reservedUal);
    if (life && ual) reserved.set(normaliseAddresses(life), ual);
    const agent = term(row.lifeAgent);
    if (life && agent) lifeAgents.set(normaliseAddresses(life), agent);
  }
  const byKey = new Map<string, Folding>();
  const keyOf = (ual: string) => normaliseAddresses(ual);
  for (const row of rows) {
    if (term(row.life)) continue;
    const assertion = term(row.asrt);
    const kc = term(row.kc);
    const tx = term(row.tx);
    if (assertion && !tx) continue; // a seal without a receipt
    const lifecycleKey = assertion ? lifecycleKeyOf(assertion, cgId) : undefined;
    const ual = assertion
      ? (lifecycleKey && reserved.get(lifecycleKey)) || term(row.kaUal)
      : kc || term(row.ual);
    if (!assertion && !ual) continue;
    const key = ual ? keyOf(ual) : assertion;
    let f = byKey.get(key);
    if (!f) {
      f = {
        receiptTxs: [], ualTxs: [], ualConfirmed: false, ualRoots: [], sealRoots: [], sealScopes: [], sealFinalizedAt: null, sealMembers: [], attributed: [],
        receiptBlocks: [], batchIds: [], kcConfirmed: false, kcTxs: [], kcMembers: [],
      };
      byKey.set(key, f);
    }
    if (assertion) {
      f.assertion ??= assertion;
      const lifeAgent = lifecycleKey ? lifeAgents.get(lifecycleKey) : undefined;
      if (lifeAgent) f.lifecycleAgent ??= lifeAgent;
      f.subGraph ??= decodeAssertionIdentity(assertion, cgId)?.subGraph;
      add(f.receiptTxs, tx);
      const sealRoot = term(row.sealRoot);
      if (sealRoot) add(f.sealRoots, normaliseRoot(sealRoot));
      add(f.sealScopes, term(row.scope));
      const finalizedAt = isoOrNull(term(row.finalizedAt));
      if (finalizedAt && (!f.sealFinalizedAt || finalizedAt > f.sealFinalizedAt)) f.sealFinalizedAt = finalizedAt;
      add(f.sealMembers, term(row.member));
      add(f.receiptBlocks, term(row.block));
    } else if (kc) {
      // Older direct publish: the collection's own record is the published fact.
      f.kcConfirmed = true;
      add(f.kcTxs, tx);
      add(f.kcMembers, term(row.member));
      f.subGraph ??= term(row.kcSub) || undefined;
    } else {
      f.ualConfirmed = true;
      add(f.ualTxs, tx);
      const root = term(row.ualRoot);
      if (root) add(f.ualRoots, normaliseRoot(root));
      const kind = term(row.kind);
      if (kind) f.kind = kind;
    }
    if (ual) {
      f.ual ??= ual;
      // The UAL's own dkg:assertionGraph is authoritative; otherwise derive it from the UAL.
      const explicit = term(row.kaGraph);
      if (explicit) f.kaGraph = explicit;
    }
    add(f.attributed, term(row.agent));
    add(f.batchIds, term(row.batchId));
  }
  mergeCollectionsIntoReceipts(byKey);
  const out: VmReceipt[] = [];
  for (const f of byKey.values()) {
    const resolved = resolveTx(f);
    if (!resolved) continue;
    const kaGraph = f.kaGraph ?? (f.ual && !f.kcConfirmed ? kaGraphOf(f.ual, cgId, f.subGraph) : undefined);
    const trusted = sealIsConfirmed(f);
    const assertion = f.assertion ?? f.ual!;
    const author = f.assertion ? authorOf(f.assertion) : null;
    out.push({
      assertion,
      ...(f.ual ? { ual: f.ual } : {}),
      tx: resolved.tx,
      confirmation: resolved.confirmation,
      finalizedAt: trusted ? f.sealFinalizedAt : null,
      members: [...new Set([...(trusted ? f.sealMembers : []), ...f.kcMembers])],
      signers: f.attributed.length ? f.attributed : f.lifecycleAgent ? [f.lifecycleAgent] : author ? [author] : [],
      subGraph: f.subGraph,
      ...(kaGraph ? { kaGraph } : {}),
      ...(f.receiptTxs.length === 1 && f.receiptBlocks.length === 1 && resolved.tx === f.receiptTxs[0] ? { blockNumber: f.receiptBlocks[0] } : {}),
      ...(f.batchIds.length === 1 ? { batchId: f.batchIds[0] } : {}),
    });
  }
  return out;
}

/** A named receipt and the collection record of the same publish share its
 *  transaction: fold the collection into that receipt, so one publish is one
 *  record (used when no lifecycle link joined them by UAL already). */
function mergeCollectionsIntoReceipts(byKey: Map<string, Folding>): void {
  const byTx = new Map<string, Folding>();
  for (const f of byKey.values()) if (f.assertion && f.receiptTxs.length === 1 && !f.kcConfirmed) byTx.set(f.receiptTxs[0], f);
  for (const [key, f] of byKey) {
    if (!f.kcConfirmed || f.assertion || f.kcTxs.length !== 1) continue;
    const named = byTx.get(f.kcTxs[0]);
    if (!named) continue;
    named.kcConfirmed = true;
    named.kcTxs = f.kcTxs;
    named.kcMembers = [...new Set([...named.kcMembers, ...f.kcMembers])];
    named.ual ??= f.ual;
    for (const a of f.attributed) if (!named.attributed.includes(a)) named.attributed.push(a);
    for (const b of f.batchIds) if (!named.batchIds.includes(b)) named.batchIds.push(b);
    byKey.delete(key);
  }
}

/** The transaction anchoring the current content (see the module comment),
 *  or null when the KA isn't anchored at all. */
function resolveTx(f: Folding): { tx: string | null; confirmation: VmConfirmation } | null {
  if (f.ualConfirmed) {
    if (f.ualTxs.length === 1) return { tx: f.ualTxs[0], confirmation: 'transaction' };
    if (f.ualTxs.length === 0 && f.kind === 'finalized-materialization') return { tx: null, confirmation: 'finalized-materialization' };
  }
  if (f.kcConfirmed && f.kcTxs.length === 1) return { tx: f.kcTxs[0], confirmation: 'transaction' };
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
  const kaGraphs = [...new Set(receipts.flatMap(r => (r.kaGraph && isSafeIri(r.kaGraph) ? [r.kaGraph] : [])))];
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
 *  when its Verifiable Memory changes (a publish), and on `refresh()`.
 *  A missing id, or one that can't form a safe graph IRI, loads nothing.
 *
 *  The request lifecycle is the shared `useFetch`: scoped to the graph with
 *  `retention: 'scope'`, so a same-graph reload keeps its receipts on screen,
 *  and a render for another graph (including the first one after a switch,
 *  before any effect runs) never exposes the previous graph's receipts or
 *  error. The only receipt-specific policy is reloading on VM changes. */
export function useVmReceiptsResource(contextGraphId: string | undefined): VmReceiptsResource {
  const loadable = receiptMetaGraph(contextGraphId) ? contextGraphId : undefined;
  const { data, loading, error, refresh: load } = useFetch(
    () => loadVmReceipts(loadable!),
    [loadable],
    0,
    { scope: loadable, retention: 'scope', enabled: loadable !== undefined },
  );
  const refresh = useCallback(() => { void load(); }, [load]);
  useMemoryGraphEvents(loadable ?? '', refresh, { layers: ['vm'] });
  return { receipts: data?.receipts ?? null, complete: data?.complete ?? true, loading, error, contextGraphId, refresh };
}

const EMPTY_STATE: VmReceiptsState = { receipts: null, complete: true, loading: false, error: null };
const noop = () => {};

const VmReceiptsContext = createContext<VmReceiptsResource | null>(null);

/** Shares one graph's receipts with everything below it (ProjectView). */
export function VmReceiptsProvider({ value, children }: { value: VmReceiptsResource; children?: React.ReactNode }) {
  return React.createElement(VmReceiptsContext.Provider, { value }, children);
}

/** Read a graph's receipts from the nearest `VmReceiptsProvider`. Owns
 *  nothing: with no id (a disabled consumer), no provider, or a provider for
 *  another graph, it returns an empty result. */
export function useVmReceipts(contextGraphId: string | undefined): VmReceiptsResource {
  const shared = useContext(VmReceiptsContext);
  if (contextGraphId && shared && shared.contextGraphId === contextGraphId) return shared;
  return { ...EMPTY_STATE, contextGraphId, refresh: noop };
}
