import { encodeChangelogRequest, decodeChangelogResponse, type ChangelogDeltaRecord } from '../changelog/wire.js';
import type { Quad } from '@origintrail-official/dkg-storage';

/** One resolved apply operation, in ascending-seq order. `quads` = VERIFIED snapshot for an upsert. */
export interface PageApplyOp {
  seq: number;
  graph: string;
  op: 'upsert' | 'drop';
  quads: Quad[];
}

export interface PageApplyPlan {
  /** The contiguous, fully-verified prefix to apply (drop / drop+insert), ascending by seq. */
  ops: PageApplyOp[];
  /** Crash-safe seq the durable cursor may advance to after `ops` commit (<= page.nextSeq). */
  advanceTo: number;
  /** True when the page had a record that could not be verified/applied yet (retried next round). */
  deferred: boolean;
  /** Count of ops that will be applied. */
  applied: number;
}

/**
 * Pure, crash-safe planner for one decoded delta page (OT-RFC-59 requester, model R).
 *
 * A data graph is trusted ONLY when (a) the whole page verified cleanly, (b) metadata in
 * THIS page binds it either as a legacy `/_meta` sibling with a real `dkg:merkleRoot` or
 * as the exact `dkg:assertionGraph` of a verified V2 graph-scoped KA, and (c) every parsed
 * quad in the graph survived `verifySyncedData`. These gates prevent orphan, partially
 * verified, or unbound data from crossing the durable cursor.
 *
 * The cursor advances only along a CONTIGUOUS verified prefix (iteration stops at the FIRST
 * unresolved record), so the durable cursor never passes a change that was not applied.
 * Empty upserts are resolved NO-OPs. Peer-supplied drops and non-empty shared metadata
 * snapshots defer to authoritative resync: neither a changelog marker nor a received-row
 * count proves deletion/completeness. Store writes finish before cursor persistence, so a
 * crash re-fetches the same idempotent data replacement.
 */
export function planPageApply(params: {
  records: ChangelogDeltaRecord[]; // ascending by seq (wire decoder guarantees)
  nextSeq: number;
  priorSeq: number;
  isForeignGraph: (graph: string) => boolean;
  /** graph → VERIFIED quads (processDurableBatch verifiedData+verifiedMeta, grouped by .graph). */
  verifiedByGraph: Map<string, Quad[]>;
  /** graph → parsed record quad count (pre-verify) — to detect partial/whole rejection & empties. */
  recordQuadCountByGraph: Map<string, number>;
  /** Legacy sibling meta-graph URIs present in-page that carry a `dkg:merkleRoot`. */
  metaGraphsWithRoot: Set<string>;
  /** Exact V2 assertion graphs bound by verified graph-scoped metadata in THIS page. */
  verifiedGraphScopedDataGraphs: Set<string>;
  /** processDurableBatch rejected nothing this page (rejectedKcs===0 && dataRejectedMissingMeta===0). */
  batchVerifiedCleanly: boolean;
}): PageApplyPlan {
  const ops: PageApplyOp[] = [];
  let deferred = false;
  let earliestUnresolvedSeq = Number.POSITIVE_INFINITY;
  let applied = 0;

  // Per-graph parse/verification accounting is intentionally bounded to one
  // record. A page containing the same in-scope graph more than once is
  // ambiguous (and a later empty record could otherwise overwrite the parsed
  // count for an earlier non-empty metadata snapshot). Defer the whole page
  // before any write; the bounded-stall path will reconcile it by full sync.
  const seenGraphs = new Set<string>();
  const hasDuplicateGraph = params.records.some((record) => {
    if (params.isForeignGraph(record.graph)) return false;
    if (seenGraphs.has(record.graph)) return true;
    seenGraphs.add(record.graph);
    return false;
  });
  if (hasDuplicateGraph) {
    const firstRecordSeq = params.records.reduce(
      (earliest, record) => Math.min(earliest, record.seq),
      Number.POSITIVE_INFINITY,
    );
    return {
      ops: [],
      advanceTo: Math.max(params.priorSeq, firstRecordSeq - 1),
      deferred: true,
      applied: 0,
    };
  }

  // Changelog v1 carries a whole shared `/_meta` snapshot but no authenticated
  // subject manifest. Even when every received row verifies, a peer can omit a
  // different live KA and turn whole-graph replacement into a remote delete.
  // Defer every non-empty metadata replacement to the authoritative full-sync
  // lane, and do so before planning data so local data and metadata never split.
  const unsafeMetadataReplacement = params.records.find((record) => {
    if (
      record.op !== 'upsert'
      || params.isForeignGraph(record.graph)
      || !record.graph.endsWith('/_meta')
    ) return false;
    return (params.recordQuadCountByGraph.get(record.graph) ?? 0) > 0;
  });
  if (unsafeMetadataReplacement) {
    const firstRecordSeq = params.records.reduce(
      (earliest, record) => Math.min(earliest, record.seq),
      unsafeMetadataReplacement.seq,
    );
    return {
      ops: [],
      advanceTo: Math.max(params.priorSeq, firstRecordSeq - 1),
      deferred: true,
      applied: 0,
    };
  }

  const dataGraphTrusted = (dataGraph: string): boolean => {
    if (!params.batchVerifiedCleanly) return false; // any KC in the page failed merkle ⇒ trust nothing
    const legacySiblingBound = params.metaGraphsWithRoot.has(`${dataGraph}/_meta`);
    const graphScopeBound = params.verifiedGraphScopedDataGraphs.has(dataGraph);
    if (!legacySiblingBound && !graphScopeBound) return false;
    const parsedCount = params.recordQuadCountByGraph.get(dataGraph);
    if (parsedCount === undefined || parsedCount === 0) return false; // absent/empty ⇒ nothing merkle-checkable
    return (params.verifiedByGraph.get(dataGraph)?.length ?? 0) === parsedCount; // ALL of G's quads survived
  };

  for (const rec of params.records) {
    if (params.isForeignGraph(rec.graph)) {
      // A well-behaved responder never emits a foreign/reserved graph; if one leaks, skip
      // it but treat its seq as consumed (resolved) so the cursor cannot wedge.
      continue;
    }
    if (rec.op === 'drop') {
      // A remote changelog marker is not an authenticated deletion proof. Stop
      // before it and let the driver's bounded stall fallback reconcile through
      // the authoritative durable lane; never hand an arbitrary peer a direct
      // dropGraph primitive.
      deferred = true;
      earliestUnresolvedSeq = Math.min(earliestUnresolvedSeq, rec.seq);
      break;
    }
    // Empty-content upsert (parsed to zero quads) carries nothing to verify or apply — a
    // resolved NO-OP. It must NEVER become a REPLACE (drop): that would silently delete a
    // local graph on an empty/malformed page. Deletions arrive only via `drop` records.
    if ((params.recordQuadCountByGraph.get(rec.graph) ?? 0) === 0) {
      continue;
    }
    if (rec.graph.endsWith('/_meta')) {
      // The preflight above handles every non-empty metadata record. Keep a
      // defensive defer here so later control-flow edits cannot reintroduce a
      // whole shared-graph replacement without a completeness proof.
      deferred = true;
      earliestUnresolvedSeq = Math.min(earliestUnresolvedSeq, rec.seq);
      break;
    }
    // DATA graphs apply ONLY if they merkle-verify against their in-page meta.
    if (!dataGraphTrusted(rec.graph)) {
      deferred = true;
      earliestUnresolvedSeq = Math.min(earliestUnresolvedSeq, rec.seq);
      break; // STOP at the first unresolved record — contiguous-prefix cursor safety.
    }
    ops.push({ seq: rec.seq, graph: rec.graph, op: 'upsert', quads: params.verifiedByGraph.get(rec.graph) ?? [] });
    applied += 1;
  }

  const advanceTo = deferred
    ? Math.max(params.priorSeq, earliestUnresolvedSeq - 1) // never regress below the cursor
    : params.nextSeq; // whole page resolved ⇒ cover the filtered other-CG tail
  return { ops, advanceTo, deferred, applied };
}

/** Result of a legacy-lane resync bootstrap, surfaced to the driver for cursor + accounting. */
export interface ResyncOutcome {
  /** True iff the resync verifiably fetched EVERYTHING < headSeq (no timeout/failure/missing-meta),
   *  so the cursor may safely jump to headSeq. False ⇒ leave the cursor and retry next cycle. */
  complete: boolean;
  /** Triples the resync inserted (folded into the driver's applied count). */
  insertedTriples: number;
}

/** Injected dependencies for one (peer, contextGraph) changelog sync loop. */
export interface ChangelogSyncDeps {
  contextGraphId: string;
  /** Max RAW records the responder scans per page. */
  limit: number;
  /** Durable (era,seq) cursor for (peer, cg); undefined on first contact. */
  getCursor(): { era: string; seq: number } | undefined;
  /** Persist the advanced cursor — the caller (applyPage) commits store writes FIRST. */
  setCursor(era: string, seq: number): void;
  /** One request/response round-trip on PROTOCOL_SYNC_CHANGELOG. Returns response bytes. */
  send(requestBytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Verify + selectively REPLACE graphs for one decoded delta page as a batch, and return
   * the crash-safe seq the cursor may advance to. Durably commits its store writes before
   * returning. Never throws for a rejected/meta-pending record — it defers.
   */
  applyPage(page: {
    era: string; headSeq: number; nextSeq: number; priorSeq: number; records: ChangelogDeltaRecord[];
  }): Promise<{ advanceTo: number; applied: number; deferred: boolean }>;
  /** Bootstrap this CG via the legacy full/durable lane (resync fallback + stall backstop). */
  runResync(): Promise<ResyncOutcome>;
  logWarn?(message: string): void;
}

export interface ChangelogSyncOutcome {
  kind: 'delta' | 'resync' | 'denied';
  applied: number;
}

/** After this many consecutive no-forward-progress rounds, fall back to a full resync. */
const RESYNC_AFTER_STALLED_ROUNDS = 3;

/**
 * OT-RFC-59 requester driver for ONE (peer, contextGraph). Pages the changelog from the
 * durable cursor, hands each page to {@link ChangelogSyncDeps.applyPage} for verified
 * apply, and advances the cursor only over the fully-verified prefix. On era-mismatch /
 * rollback / first-contact the responder returns `resync` and we bootstrap via the legacy
 * lane — advancing the cursor to headSeq ONLY when that resync completed fully (a partial
 * resync leaves the cursor so the next cycle retries, never leaving a gap below headSeq).
 * A page whose legacy sibling meta or V2 graph binding straddled the byte budget defers;
 * re-fetching from the unadvanced cursor pulls the binding into the same window next
 * round. If a record stays unresolvable for {@link RESYNC_AFTER_STALLED_ROUNDS} rounds,
 * a resync clears it.
 */
export async function runChangelogSync(deps: ChangelogSyncDeps): Promise<ChangelogSyncOutcome> {
  let applied = 0;
  let stalledRounds = 0;
  for (let round = 0; round < 100_000; round++) {
    const cursor = deps.getCursor();
    const priorSeq = cursor?.seq ?? 0;
    const requestBytes = encodeChangelogRequest({
      contextGraphId: deps.contextGraphId,
      sinceSeq: priorSeq,
      era: cursor?.era ?? null,
      limit: deps.limit,
    });
    const resp = decodeChangelogResponse(await deps.send(requestBytes));

    if (resp.kind === 'denied') return { kind: 'denied', applied };

    if (resp.kind === 'resync') {
      const rr = await deps.runResync();
      applied += rr.insertedTriples;
      // Only jump the cursor to headSeq if the resync verifiably fetched everything < headSeq;
      // otherwise leave it (still first-contact / behind) so the next cycle retries — no gap.
      if (rr.complete) deps.setCursor(resp.era, resp.headSeq);
      return { kind: 'resync', applied };
    }

    // delta — verified apply of the page (store writes commit inside applyPage).
    const { advanceTo, applied: n, deferred } = await deps.applyPage({
      era: resp.era, headSeq: resp.headSeq, nextSeq: resp.nextSeq, priorSeq, records: resp.records,
    });
    applied += n;

    if (advanceTo > priorSeq) {
      deps.setCursor(resp.era, advanceTo);
      stalledRounds = 0;
    } else {
      // No forward progress this round. Back off to resync after a few rounds so a
      // genuinely-missing meta (or an in-lane-unverifiable graph) can't wedge the CG.
      if (++stalledRounds >= RESYNC_AFTER_STALLED_ROUNDS) {
        deps.logWarn?.(`changelog sync stalled ${stalledRounds} rounds at seq ${priorSeq}; resyncing`);
        const rr = await deps.runResync();
        applied += rr.insertedTriples;
        if (rr.complete) deps.setCursor(resp.era, resp.headSeq);
        return { kind: 'resync', applied };
      }
    }

    if (!deferred && advanceTo >= resp.headSeq) return { kind: 'delta', applied };
  }
  deps.logWarn?.('changelog sync exceeded the round bound; stopping (misbehaving peer?)');
  return { kind: 'delta', applied };
}
