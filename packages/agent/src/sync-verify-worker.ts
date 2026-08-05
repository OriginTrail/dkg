import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SyncVerifyLogEntry {
  level: 'debug' | 'warn';
  message: string;
}

export interface SyncVerifyResult {
  data: Quad[];
  meta: Quad[];
  rejected: number;
  logs: SyncVerifyLogEntry[];
}

export interface SyncParseResult {
  quads: Quad[];
  totalQuads: number;
}

export interface SharedMemoryProcessResult {
  validQuads: Quad[];
  dropped: number;
  entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
}

export interface SharedMemoryBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  droppedDataTriples: number;
  emptyResponses: number;
  entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
}

export type DurableBatchVerificationMode =
  | { kind: 'fullSnapshot' }
  | { kind: 'sinceBatchId'; sinceBatchId: string }
  | { kind: 'changelogPage'; changedDataGraphs: readonly string[] };

export interface DurableBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  verifiedGraphScopedDataGraphs: string[];
  /** Metadata controls deliberately consumed after failing authentication (diagnostic). */
  droppedSyncControlTriples: number;
  /**
   * Non-IRI (blank-node/literal) `_meta` subject rows deliberately dropped at
   * ingest (#1921) — a verifier-side diagnostic count.
   */
  droppedNonIriSubjectTriples: number;
  /**
   * Reason-agnostic aggregate of meta rows the verifier deliberately CONSUMED
   * but did not persist (unverified sync controls + non-IRI subjects). This is
   * the single count the requester uses to decide whether a fully-discarded
   * metadata-only page still advances the meta checkpoint (rather than pinning
   * durable sync on the same page). Keeping the per-reason counts above as
   * diagnostics only keeps checkpoint orchestration decoupled from verifier
   * discard policy.
   */
  consumedUnpersistedMetaTriples: number;
  /** Clean batches containing verified V2 assets with no public assertion triples. */
  verifiedPrivateOnlyResponses: number;
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  rejectedKcs: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  logs: SyncVerifyLogEntry[];
}

/**
 * Worker-wire form of {@link DurableBatchProcessResult}.
 *
 * Returning verified Quad objects through `postMessage()` structured-clones
 * every accepted quad back into the requester heap. The requester already
 * retains the original input arrays, so that clone briefly doubles the
 * complete durable phase immediately before store serialization. Return only
 * indexes across the worker boundary and rebuild arrays of references to the
 * caller-owned quads on the main thread.
 */
export interface DurableBatchProcessWireResult
  extends Omit<DurableBatchProcessResult, 'verifiedData' | 'verifiedMeta'> {
  verifiedDataIndexes: number[];
  verifiedMetaIndexes: number[];
}

export class SyncVerifyWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    // Workers boot from compiled `.js`. In production, `import.meta.url`
    // resolves to `…/packages/agent/dist/sync-verify-worker.js` and the
    // sibling `.js` is present. In dev / vitest source-mode it points
    // into `…/packages/agent/src/`, where only `.ts` exists — Node's
    // `Worker` cannot load bare `.ts`, and `tsx`'s ESM hooks intentionally
    // do not auto-register inside worker threads (see
    // `node_modules/tsx/dist/esm/index.mjs` — `isMainThread && register()`).
    //
    // Resolution (Codex round-3 + round-4 hardening):
    //   1. sibling `.js`       — production / consumed via dist/
    //   2. parallel dist/*.js  — source-mode AFTER `pnpm build`
    //
    // We compute the parallel dist path RELATIVE to this file's directory
    // (Codex round-4 #1: a global string-replace of `/src/` → `/dist/`
    // matches the wrong segment when the checkout itself lives under a
    // path containing `/src/`, e.g. `~/src/dkg/...`). And we refuse to
    // load a stale dist (Codex round-4 #2: if `sync-verify-worker-impl.ts`
    // has been edited since the last `pnpm build` we'd otherwise execute
    // an obsolete artifact and silently green-light a regression).
    const here = fileURLToPath(import.meta.url);
    const hereDir = dirname(here);
    const sibJsPath = join(hereDir, 'sync-verify-worker-impl.js');
    const sibTsPath = join(hereDir, 'sync-verify-worker-impl.ts');

    const isSourceMode = hereDir.endsWith(`${sep}src`);
    const distJsPath = isSourceMode
      ? join(dirname(hereDir), 'dist', 'sync-verify-worker-impl.js')
      : sibJsPath;

    let workerPath: string;

    if (!isSourceMode && existsSync(sibJsPath)) {
      workerPath = sibJsPath;
    } else if (existsSync(distJsPath)) {
      // Stale-build guard. We only enforce this when BOTH:
      //   a) we're loaded from `src/` (vitest source-mode); AND
      //   b) `tsconfig.tsbuildinfo` is present in this checkout.
      //
      // (a) is obvious. (b) is what makes the check robust in CI: the
      // shared `Build packages` job tars only `dist/`, `dist-ui/`, and
      // `network/` directories — NOT the buildinfo — and each test job
      // checks out source fresh (mtime ≈ test-job start) before
      // untarring the build artifact (dist mtime = build-job time). In
      // that environment src always looks "newer" than dist, but the
      // dist artifact is trusted by construction (it was emitted from
      // the same git ref). Anchoring on the buildinfo's existence
      // limits the check to local developer machines, where editing
      // `src/.ts` and running vitest without `pnpm build` is the actual
      // failure mode the bot review on PR #792 flagged.
      //
      // tsc with `composite: true` only re-emits an OUTPUT file when
      // its bytes change but ALWAYS refreshes the buildinfo, so the
      // buildinfo mtime is the canonical "last successful build" anchor.
      const tsbuildinfoPath = join(dirname(hereDir), 'tsconfig.tsbuildinfo');
      if (
        isSourceMode &&
        existsSync(sibTsPath) &&
        existsSync(tsbuildinfoPath)
      ) {
        const tsMtime = statSync(sibTsPath).mtimeMs;
        const buildinfoMtime = statSync(tsbuildinfoPath).mtimeMs;
        if (tsMtime > buildinfoMtime) {
          throw new Error(
            `[SyncVerifyWorker] Stale build detected.\n` +
              `  Source: ${sibTsPath} (modified ${new Date(tsMtime).toISOString()})\n` +
              `  Build:  ${tsbuildinfoPath} (last built ${new Date(buildinfoMtime).toISOString()})\n\n` +
              `Node's Worker cannot load TypeScript directly, so vitest's\n` +
              `source-mode delegates to the compiled artifact. The .ts file\n` +
              `is newer than the last successful build, which would silently\n` +
              `run the previous build's behaviour. Recompile before re-running\n` +
              `tests:\n\n` +
              `  pnpm --filter @origintrail-official/dkg-agent build\n`,
          );
        }
      }
      workerPath = distJsPath;
    } else {
      throw new Error(
        `[SyncVerifyWorker] Compiled worker not found.\n` +
          `  Looked for: ${sibJsPath}\n` +
          `              ${distJsPath}\n\n` +
          `Node's Worker cannot load TypeScript directly, and tsx's loader\n` +
          `intentionally does not register inside worker threads. Build the\n` +
          `agent package first:\n\n` +
          `  pnpm --filter @origintrail-official/dkg-agent build\n\n` +
          `(CI's "Build packages" stage already does this; this error only\n` +
          `triggers in a fresh checkout where vitest is invoked before the\n` +
          `package has been compiled.)`,
      );
    }

    this.worker = new Worker(workerPath);
    this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
    });
  }

  verify(dataQuads: Quad[], metaQuads: Quad[], acceptUnverified: boolean): Promise<SyncVerifyResult> {
    const id = this.nextId++;
    return new Promise<SyncVerifyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'verify', args: [dataQuads, metaQuads, acceptUnverified] });
    });
  }

  parseAndFilter(nquadsText: string, graphUri: string, contextGraphId: string): Promise<SyncParseResult> {
    const id = this.nextId++;
    return new Promise<SyncParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'parseAndFilter', args: [nquadsText, graphUri, contextGraphId] });
    });
  }

  processSharedMemory(wsDataQuads: Quad[], wsMetaQuads: Quad[]): Promise<SharedMemoryProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processSharedMemory', args: [wsDataQuads, wsMetaQuads] });
    });
  }

  /**
   * Array membership and order are snapshotted before dispatch. Callers must
   * keep the Quad objects themselves immutable until the returned promise
   * settles so the caller-owned references still match the worker snapshot.
   */
  processDurableBatch(
    dataQuads: readonly Quad[],
    metaQuads: readonly Quad[],
    acceptUnverified: boolean,
    mode: DurableBatchVerificationMode = { kind: 'fullSnapshot' },
  ): Promise<DurableBatchProcessResult> {
    // Preserve the array membership/order that the worker verifies without
    // cloning the Quad object graph on the caller side. Callers may resize or
    // reorder their arrays once this method returns.
    const stableDataQuads = dataQuads.slice();
    const stableMetaQuads = metaQuads.slice();
    const id = this.nextId++;
    return new Promise<DurableBatchProcessWireResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        method: 'processDurableBatch',
        args: [
          stableDataQuads,
          stableMetaQuads,
          acceptUnverified,
          mode,
        ],
      });
    }).then((wireResult) => {
      const {
        verifiedDataIndexes,
        verifiedMetaIndexes,
        ...summary
      } = wireResult;
      return {
        ...summary,
        verifiedData: selectQuadReferences(stableDataQuads, verifiedDataIndexes, 'data'),
        verifiedMeta: selectQuadReferences(stableMetaQuads, verifiedMetaIndexes, 'meta'),
      };
    });
  }

  processSharedMemoryBatch(
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ): Promise<SharedMemoryBatchProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryBatchProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        method: 'processSharedMemoryBatch',
        args: [wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames, excludedSubGraphNames],
      });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

function selectQuadReferences(
  source: Quad[],
  indexes: readonly number[],
  phase: 'data' | 'meta',
): Quad[] {
  const selected = new Array<Quad>(indexes.length);
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i];
    if (!Number.isSafeInteger(index) || index < 0 || index >= source.length) {
      throw new Error(`Sync verify worker returned an invalid ${phase} quad index: ${index}`);
    }
    selected[i] = source[index];
  }
  return selected;
}
