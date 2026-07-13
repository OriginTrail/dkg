import type { Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { SyncPageResult } from './page-fetch.js';
import { applySwmRecovery, type SwmRecoveryStore } from './swm-recovery-apply.js';
import { sharedMemoryOwnershipKeyFromGraph } from './shared-memory-sync.js';
import { appendInPlace } from '../append-in-place.js';

/**
 * recovery entry point. Recovers a CG's
 * `_shared_memory` current state from a single authoritative peer (a member or
 * a designated anchor), applying via REPLACE rather than the shared incremental
 * sync path's blind union (which corrupts a non-empty store — see
 * {@link applySwmRecovery}).
 *
 * It fetches the COMPLETE state across pages (each `fetchSyncPages` call loops
 * internally to completion-or-deadline), verifies it, then replaces each root
 * exactly once.
 *
 * A partial fetch (deadline) is NOT safe to apply, and is deliberately NOT
 * applied. Pagination is row-based, so a single root's rows (the root + its
 * skolemized children + every predicate) can straddle the last fetched page: a
 * deadline can cut a root mid-stream. REPLACE-ing such a root would clear it and
 * reinsert only the fetched prefix, truncating the entity until a later retry —
 * the same corruption the per-root REPLACE exists to prevent. So recovery is
 * all-or-nothing: we apply ONLY when BOTH phases fetched to completion; on a
 * partial fetch we mutate the store not at all, drop the mid-stream checkpoint
 * so the retry re-accumulates from offset 0, and return `completed: false` for
 * the caller to retry. (Per-root completeness is not cheaply recoverable here —
 * `entityCreators` is a set derived from possibly-truncated rows, so the
 * truncated tail root can't be singled out; all-or-nothing is the correct gate.)
 *
 * This is deliberately separate from `runSharedMemorySync` so the shared
 * incremental path (cold-start / public / top-up, where union is correct) is
 * untouched.
 */

type RecoverableSyncPhase = 'data' | 'meta';

interface ProcessedSwmBatch {
  readonly verifiedData: Quad[];
  readonly verifiedMeta: Quad[];
  readonly entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
  readonly droppedDataTriples: number;
}

export interface RecoverContextGraphSwmDeps {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  /** Absolute wall-clock deadline (ms) for the whole recovery. */
  readonly deadline: number;
  readonly fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: RecoverableSyncPhase,
    graphUri: string,
    deadline: number,
  ) => Promise<SyncPageResult>;
  readonly processSharedMemoryBatch: (
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ) => Promise<ProcessedSwmBatch>;
  readonly store: SwmRecoveryStore;
  /**
   * REPLACE (not append) the SWM meta for each recovered root, BEFORE the fresh
   * `verifiedMeta` is inserted. `applySwmRecovery` REPLACEs the root DATA, but
   * without also replacing the meta an older `WorkspaceOperation`/`rootEntity`
   * row for the same root lingers in `_shared_memory_meta`; the TTL sweep then
   * deletes data for that expired op and can wipe the freshly-recovered root
   * (Codex high). Mirrors the share/gossip apply path's per-root meta
   * replacement (`deleteMetaForRoot`). Production callers MUST pass it.
   */
  readonly replaceMetaForRoots?: (
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ) => Promise<void>;
  readonly ensureContextGraph: (contextGraphId: string) => Promise<void>;
  readonly setCheckpoint: (key: string, offset: number) => void;
  readonly deleteCheckpoint: (key: string) => void;
  readonly getRegisteredSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  readonly getExcludedSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  /**
   * Rule-4 ownership cache hydrator (parity with `runSharedMemorySync`). Without
   * it, a recovered member holds correct triples but an empty ownership map and
   * mis-arbitrates its NEXT contended write — so production callers MUST pass it.
   */
  readonly ensureOwnedMap?: (ownershipKey: string) => Map<string, string>;
  readonly logInfo?: (ctx: OperationContext, message: string) => void;
  readonly logWarn?: (ctx: OperationContext, message: string) => void;
  /** Backstop against a misbehaving responder that never reports `completed`. */
  readonly maxPagesPerPhase?: number;
}

export interface RecoverContextGraphSwmResult {
  readonly replacedRoots: number;
  readonly insertedDataQuads: number;
  readonly insertedMetaQuads: number;
  readonly droppedDataTriples: number;
  /** false if a phase hit the deadline without completing — partial, safe to retry. */
  readonly completed: boolean;
}

const DEFAULT_MAX_PAGES_PER_PHASE = 1000;

async function fetchPhaseFully(
  deps: RecoverContextGraphSwmDeps,
  phase: RecoverableSyncPhase,
  graphUri: string,
): Promise<{ quads: Quad[]; completed: boolean }> {
  const maxPages = deps.maxPagesPerPhase ?? DEFAULT_MAX_PAGES_PER_PHASE;
  const all: Quad[] = [];
  let lastCheckpointKey: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await deps.fetchSyncPages(
      deps.ctx, deps.remotePeerId, deps.contextGraphId, true, phase, graphUri, deps.deadline,
    );
    appendInPlace(all, page.quads);
    lastCheckpointKey = page.checkpointKey;
    if (page.completed) {
      deps.deleteCheckpoint(page.checkpointKey);
      return { quads: all, completed: true };
    }
    // Not completed (deadline or partial). Stop if no forward progress.
    if (page.nextOffset <= page.resumedFromOffset) break;
    deps.setCheckpoint(page.checkpointKey, page.nextOffset);
  }
  // Incomplete: the accumulated `all` is a prefix that the caller MUST NOT
  // apply (a tail root may be truncated mid-stream). `all` is local to this
  // call and never reused, so drop any persisted mid-stream cursor — recovery
  // has no cross-invocation accumulator, so the retry must restart from
  // offset 0 (which makes the responder re-read from the start of its row
  // list) and rebuild the COMPLETE state before the apply gate can pass.
  if (lastCheckpointKey !== undefined) deps.deleteCheckpoint(lastCheckpointKey);
  return { quads: all, completed: false };
}

export async function recoverContextGraphSwm(
  deps: RecoverContextGraphSwmDeps,
): Promise<RecoverContextGraphSwmResult> {
  const wsGraph = contextGraphWorkspaceGraphUri(deps.contextGraphId);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(deps.contextGraphId);

  // Meta first (its rootEntity list is what validates the data subjects), then data.
  const meta = await fetchPhaseFully(deps, 'meta', wsMetaGraph);
  const data = await fetchPhaseFully(deps, 'data', wsGraph);

  // All-or-nothing gate (B10): a partial fetch may have cut a root mid-stream,
  // so applying REPLACE over a prefix would truncate that root. If EITHER phase
  // is incomplete, mutate nothing — not the data REPLACE, not the additive meta
  // insert, not the ownership-cache hydration (hydrating roots we didn't write
  // would desync the ownership map from the store) — and report `completed:
  // false` so the caller retries. The checkpoint was already dropped above, so
  // the retry re-accumulates the complete state from offset 0.
  if (!meta.completed || !data.completed) {
    deps.logInfo?.(
      deps.ctx,
      `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: partial fetch ` +
      `(meta ${meta.completed ? 'complete' : 'incomplete'}, data ${data.completed ? 'complete' : 'incomplete'}) — skipped, will retry`,
    );
    return {
      replacedRoots: 0,
      insertedDataQuads: 0,
      insertedMetaQuads: 0,
      droppedDataTriples: 0,
      completed: false,
    };
  }

  const registered = deps.getRegisteredSubGraphNames
    ? await deps.getRegisteredSubGraphNames(deps.contextGraphId)
    : undefined;
  const excluded = deps.getExcludedSubGraphNames
    ? await deps.getExcludedSubGraphNames(deps.contextGraphId)
    : undefined;

  const processed = await deps.processSharedMemoryBatch(
    data.quads, meta.quads, deps.contextGraphId, registered, excluded,
  );

  await deps.ensureContextGraph(deps.contextGraphId);

  // REPLACE per root (the recovery fix), applied over the COMPLETE fetched state.
  const applied = await applySwmRecovery({
    store: deps.store,
    verifiedData: processed.verifiedData,
    roots: processed.entityCreators,
  });
  // Codex high: REPLACE the SWM meta for each recovered root (the data was
  // REPLACEd above; the meta must be too). Otherwise a stale WorkspaceOperation
  // pointing at the root survives and the TTL sweep later deletes the
  // freshly-recovered root. Scope to the meta graphs the curator's fresh meta
  // populates (+ the caller's base fallback when empty). Runs BEFORE the insert.
  if (processed.entityCreators.length > 0) {
    const metaGraphs = [...new Set(processed.verifiedMeta.map((q) => q.graph))];
    await deps.replaceMetaForRoots?.(processed.entityCreators, metaGraphs);
  }
  if (processed.verifiedMeta.length > 0) {
    await deps.store.insert([...processed.verifiedMeta]);
  }

  // R2 — hydrate the Rule-4 ownership cache for the recovered roots (parity with
  // runSharedMemorySync); otherwise the member's next contended write to a
  // recovered root is mis-arbitrated against an empty ownership map.
  if (deps.ensureOwnedMap) {
    for (const { dataGraph, entity, creator } of processed.entityCreators) {
      const ownershipKey = sharedMemoryOwnershipKeyFromGraph(deps.contextGraphId, dataGraph);
      if (!ownershipKey) continue;
      const ownedMap = deps.ensureOwnedMap(ownershipKey);
      if (!ownedMap.has(entity)) ownedMap.set(entity, creator);
    }
  }

  if (processed.droppedDataTriples > 0) {
    deps.logWarn?.(deps.ctx, `SWM recovery for "${deps.contextGraphId}" dropped ${processed.droppedDataTriples} triples with invalid subjects`);
  }
  // Reaching here means both phases completed (the partial path returned above).
  deps.logInfo?.(
    deps.ctx,
    `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: replaced ${applied.replacedRoots} roots, ` +
    `${applied.insertedQuads} data + ${processed.verifiedMeta.length} meta triples`,
  );

  return {
    replacedRoots: applied.replacedRoots,
    insertedDataQuads: applied.insertedQuads,
    insertedMetaQuads: processed.verifiedMeta.length,
    droppedDataTriples: processed.droppedDataTriples,
    completed: true,
  };
}
