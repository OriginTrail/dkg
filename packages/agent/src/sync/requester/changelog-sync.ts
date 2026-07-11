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
 * A data graph is trusted ONLY when (a) the whole page verified cleanly, (b) its sibling
 * `/_meta` record — carrying a real `dkg:merkleRoot` — is in THIS page, and (c) every one
 * of its parsed quads survived `verifySyncedData`. Gates (a)+(b) close the default-accept
 * hole: `verifiedData` passes through quads whose subject is not a recognised root entity
 * and is permissive on empty/rootless meta, so "survived verification" ALONE would let
 * orphan or unbound data through — the clean-batch + merkle-root-present checks force an
 * actual merkle bind.
 *
 * The cursor advances only along a CONTIGUOUS verified prefix (iteration stops at the FIRST
 * unresolved record), so the durable cursor never passes a change that was not applied.
 * An empty-content upsert is a resolved NO-OP — never a REPLACE — so it can never delete a
 * local graph (genuine deletions arrive only via `drop` records). Store writes commit
 * BEFORE the caller persists the cursor; upsert=REPLACE and drop are idempotent, so a crash
 * between commit and cursor-persist re-fetches and re-applies harmlessly.
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
  /** meta-graph URIs present in-page THAT carry a `dkg:merkleRoot` (a rootless meta cannot bind data). */
  metaGraphsWithRoot: Set<string>;
  /** processDurableBatch rejected nothing this page (rejectedKcs===0 && dataRejectedMissingMeta===0). */
  batchVerifiedCleanly: boolean;
}): PageApplyPlan {
  const ops: PageApplyOp[] = [];
  let deferred = false;
  let earliestUnresolvedSeq = Number.POSITIVE_INFINITY;
  let applied = 0;

  const dataGraphTrusted = (dataGraph: string): boolean => {
    if (!params.batchVerifiedCleanly) return false; // any KC in the page failed merkle ⇒ trust nothing
    if (!params.metaGraphsWithRoot.has(`${dataGraph}/_meta`)) return false; // no merkle-root-bearing sibling in-page
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
      ops.push({ seq: rec.seq, graph: rec.graph, op: 'drop', quads: [] });
      applied += 1;
      continue;
    }
    // Empty-content upsert (parsed to zero quads) carries nothing to verify or apply — a
    // resolved NO-OP. It must NEVER become a REPLACE (drop): that would silently delete a
    // local graph on an empty/malformed page. Deletions arrive only via `drop` records.
    if ((params.recordQuadCountByGraph.get(rec.graph) ?? 0) === 0) {
      continue;
    }
    const isMeta = rec.graph.endsWith('/_meta');
    const dataGraph = isMeta ? rec.graph.slice(0, -'/_meta'.length) : rec.graph;
    if (!dataGraphTrusted(dataGraph)) {
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
 * A page whose sibling meta straddled the byte budget defers; re-fetching from the
 * (unadvanced) cursor pulls the meta into the same window next round. If a record stays
 * unresolvable for {@link RESYNC_AFTER_STALLED_ROUNDS} rounds, a resync clears it.
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
