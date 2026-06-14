import type { Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { SyncPageResult } from './page-fetch.js';
import { applySwmRecovery, type SwmRecoveryStore } from './swm-recovery-apply.js';
import { sharedMemoryOwnershipKeyFromGraph } from './shared-memory-sync.js';

/**
 * OT-RFC-49 strip — WS-0.0 recovery entry point. Recovers a CG's
 * `_shared_memory` current state from a single authoritative peer (a member or
 * a designated anchor), applying via REPLACE rather than the shared incremental
 * sync path's blind union (which corrupts a non-empty store — see
 * {@link applySwmRecovery}).
 *
 * It fetches the COMPLETE state across pages (each `fetchSyncPages` call loops
 * internally to completion-or-deadline; we resume across calls via the
 * checkpoint), verifies it, then replaces each root exactly once. A partial
 * fetch (deadline) is safe: the roots fetched are replaced; the rest keep their
 * local value until a retry — no union corruption either way. This is
 * deliberately separate from `runSharedMemorySync` so the shared incremental
 * path (cold-start / public / top-up, where union is correct) is untouched.
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
  for (let i = 0; i < maxPages; i++) {
    const page = await deps.fetchSyncPages(
      deps.ctx, deps.remotePeerId, deps.contextGraphId, true, phase, graphUri, deps.deadline,
    );
    all.push(...page.quads);
    if (page.completed) {
      deps.deleteCheckpoint(page.checkpointKey);
      return { quads: all, completed: true };
    }
    // Not completed (deadline or partial). Stop if no forward progress.
    if (page.nextOffset <= page.resumedFromOffset) break;
    deps.setCheckpoint(page.checkpointKey, page.nextOffset);
  }
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

  // REPLACE per root (the WS-0.0 fix), applied over the COMPLETE fetched state.
  const applied = await applySwmRecovery({
    store: deps.store,
    verifiedData: processed.verifiedData,
    roots: processed.entityCreators,
  });
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
  deps.logInfo?.(
    deps.ctx,
    `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: replaced ${applied.replacedRoots} roots, ` +
    `${applied.insertedQuads} data + ${processed.verifiedMeta.length} meta triples` +
    `${meta.completed && data.completed ? '' : ' (partial — will retry)'}`,
  );

  return {
    replacedRoots: applied.replacedRoots,
    insertedDataQuads: applied.insertedQuads,
    insertedMetaQuads: processed.verifiedMeta.length,
    droppedDataTriples: processed.droppedDataTriples,
    completed: meta.completed && data.completed,
  };
}
