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
 * Mirrors legacy durable-sync's correctness invariant WITHOUT copying its two-phase
 * mechanism: a data graph is trusted ONLY when its sibling `/_meta` record is in THIS
 * page (so its merkle root is available) AND every one of its parsed quads survived
 * verification (`processDurableBatch` → `verifySyncedData`). This closes the orphan-data
 * hole — `verifiedData` default-accepts quads whose subject is not a recognised root
 * entity, so "survived verification" alone is insufficient; pairing with the sibling
 * meta is what makes the KC actually merkle-checked.
 *
 * The cursor advances only along a CONTIGUOUS verified prefix: iteration stops at the
 * FIRST unresolved (meta-pending / rejected) record, so the durable cursor never passes
 * a change that was not applied. Store writes commit BEFORE the caller persists the
 * cursor; upsert=REPLACE and drop are idempotent, so a crash between commit and
 * cursor-persist re-fetches and re-applies harmlessly.
 */
export function planPageApply(params: {
  records: ChangelogDeltaRecord[]; // ascending by seq (wire decoder guarantees)
  nextSeq: number;
  priorSeq: number;
  isForeignGraph: (graph: string) => boolean;
  /** graph → VERIFIED quads (processDurableBatch verifiedData+verifiedMeta, grouped by .graph). */
  verifiedByGraph: Map<string, Quad[]>;
  /** graph → parsed record quad count (pre-verify) — to detect partial/whole rejection. */
  recordQuadCountByGraph: Map<string, number>;
  /** meta-graph URIs present as upsert records in this page (sibling-presence test). */
  metaGraphsInPage: Set<string>;
}): PageApplyPlan {
  const ops: PageApplyOp[] = [];
  let deferred = false;
  let earliestUnresolvedSeq = Number.POSITIVE_INFINITY;
  let applied = 0;

  // A data graph G is trusted iff its sibling meta record is in-page AND ALL of G's
  // parsed quads survived verification (partial survival ⇒ a rejected KC ⇒ defer whole G).
  const dataGraphTrusted = (dataGraph: string): boolean => {
    if (!params.metaGraphsInPage.has(`${dataGraph}/_meta`)) return false;
    const parsedCount = params.recordQuadCountByGraph.get(dataGraph);
    if (parsedCount === undefined) return false; // data graph not in this page
    return (params.verifiedByGraph.get(dataGraph)?.length ?? 0) === parsedCount;
  };

  for (const rec of params.records) {
    if (params.isForeignGraph(rec.graph)) {
      // A well-behaved responder never emits a foreign/reserved graph; if one leaks,
      // skip it but treat its seq as consumed (resolved) so the cursor cannot wedge.
      continue;
    }
    if (rec.op === 'drop') {
      ops.push({ seq: rec.seq, graph: rec.graph, op: 'drop', quads: [] });
      applied += 1;
      continue;
    }
    // upsert — resolve the data graph this record verifies against.
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
   * Verify + selectively REPLACE graphs for one decoded delta page as a batch, and
   * return the crash-safe seq the cursor may advance to. Durably commits its store
   * writes before returning. Never throws for a rejected/meta-pending record — it
   * defers by returning `deferred: true` with `advanceTo` capped before it.
   */
  applyPage(page: {
    era: string; headSeq: number; nextSeq: number; priorSeq: number; records: ChangelogDeltaRecord[];
  }): Promise<{ advanceTo: number; applied: number; deferred: boolean }>;
  /** Bootstrap this CG via the legacy full/durable lane (resync fallback + stall backstop). */
  runResync(): Promise<void>;
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
 * lane. A page whose sibling meta straddled the byte budget defers; re-fetching from the
 * (unadvanced) cursor pulls the meta into the same window next round. If a record stays
 * unresolvable for {@link RESYNC_AFTER_STALLED_ROUNDS} rounds (genuinely missing meta, or
 * an in-lane-unverifiable top-level graph), a resync clears it — correct, occasionally
 * stalls, never inserts unverified data.
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
      await deps.runResync();
      deps.setCursor(resp.era, resp.headSeq);
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
      // No forward progress this round (first record unresolved). Back off to resync
      // after a few rounds so a genuinely-missing meta or top-level graph can't wedge.
      if (++stalledRounds >= RESYNC_AFTER_STALLED_ROUNDS) {
        deps.logWarn?.(`changelog sync stalled ${stalledRounds} rounds at seq ${priorSeq}; resyncing`);
        await deps.runResync();
        deps.setCursor(resp.era, resp.headSeq);
        return { kind: 'resync', applied };
      }
    }

    if (!deferred && advanceTo >= resp.headSeq) return { kind: 'delta', applied };
  }
  deps.logWarn?.('changelog sync exceeded the round bound; stopping (misbehaving peer?)');
  return { kind: 'delta', applied };
}
