/**
 * Worker-thread-backed proof builder.
 *
 * Spawns a single long-lived `worker_threads.Worker` running
 * `proof-worker-entry.js`. The host serializes builds (one in flight
 * at a time) — this is fine for v1 because the prover orchestrator
 * itself only ticks once per period and a period is many seconds.
 *
 * Crash semantics: if the worker crashes mid-build, the in-flight
 * `build()` promise rejects with `WorkerCrashedError` and the next
 * call lazy-respawns. The orchestrator's WAL already records that
 * the period had a `built` transition pending, so on recovery the
 * prover decides whether to retry or skip.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  V10ProofRootMismatchError,
  V10ProofLeafCountMismatchError,
  V10ProofChunkOutOfRangeError,
  type V10ProofMaterial,
} from '@origintrail-official/dkg-core';
import type { ProofBuilder, ProofBuilderRequest } from './proof-builder.js';

export class WorkerCrashedError extends Error {
  readonly name = 'WorkerCrashedError';
  constructor(readonly exitCode: number | null, message: string) {
    super(message);
  }
}

interface PendingTask {
  taskId: number;
  resolve: (material: V10ProofMaterial) => void;
  reject: (err: Error) => void;
}

interface WorkerResponseOk {
  taskId: number;
  ok: true;
  leaf: Uint8Array;
  proof: Uint8Array[];
  merkleRoot: Uint8Array;
  leafCount: number;
}

/**
 * Mirrors `proof-worker-entry.ts` `BuildErrorFields`. Carrying the structured
 * fields across the worker → host boundary lets us reconstruct typed errors
 * with their actual computed/expected values, so WAL/log diagnostics on
 * mismatch surface real numbers instead of zeroed placeholders.
 */
type WorkerErrorFields =
  | { kind: 'rootMismatch'; computedMerkleRoot: Uint8Array; expectedMerkleRoot: Uint8Array }
  | { kind: 'leafCountMismatch'; computedLeafCount: number; expectedLeafCount: number }
  | { kind: 'chunkOutOfRange'; chunkId: number; leafCount: number };

interface WorkerResponseErr {
  taskId: number;
  ok: false;
  errorName:
    | 'V10ProofRootMismatchError'
    | 'V10ProofLeafCountMismatchError'
    | 'V10ProofChunkOutOfRangeError'
    | 'Error';
  message: string;
  fields?: WorkerErrorFields;
}

type WorkerResponse = WorkerResponseOk | WorkerResponseErr;

export interface WorkerThreadProofBuilderOptions {
  /**
   * Override the resolved path to `proof-worker-entry.js`. Tests use
   * this to point at the source `.ts` via a tsx-aware loader; prod
   * uses the default which resolves alongside this file's
   * compiled `.js`.
   */
  entryPath?: string;
}

const DEFAULT_ENTRY_RELATIVE = './proof-worker-entry.js';

export class WorkerThreadProofBuilder implements ProofBuilder {
  private worker: Worker | null = null;
  private nextTaskId = 1;
  private pending = new Map<number, PendingTask>();
  private readonly entryPath: string;

  constructor(opts: WorkerThreadProofBuilderOptions = {}) {
    if (opts.entryPath) {
      this.entryPath = opts.entryPath;
    } else {
      const here = dirname(fileURLToPath(import.meta.url));
      this.entryPath = resolve(here, DEFAULT_ENTRY_RELATIVE);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.entryPath);
    w.on('message', (msg: WorkerResponse) => {
      const task = this.pending.get(msg.taskId);
      if (!task) return; // stale: already cancelled / errored out
      this.pending.delete(msg.taskId);
      if (msg.ok) {
        task.resolve({
          leaf: msg.leaf,
          proof: msg.proof,
          merkleRoot: msg.merkleRoot,
          leafCount: msg.leafCount,
        });
      } else {
        task.reject(this.reconstructError(msg));
      }
    });
    w.on('error', (err) => {
      this.failAll(new WorkerCrashedError(null, `worker error: ${err.message}`));
      this.worker = null;
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        this.failAll(new WorkerCrashedError(code, `worker exited with code ${code}`));
      }
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private reconstructError(msg: WorkerResponseErr): Error {
    // Prefer structured fields from the worker so WAL/log records the real
    // computed-vs-expected values. Fall back to zeroed placeholders only when
    // the wire downgrades (e.g. a pre-fields worker payload during rollout) —
    // the orchestrator still branches correctly on `name` either way.
    switch (msg.errorName) {
      case 'V10ProofRootMismatchError': {
        if (msg.fields?.kind === 'rootMismatch') {
          return new V10ProofRootMismatchError(msg.fields.computedMerkleRoot, msg.fields.expectedMerkleRoot);
        }
        return new V10ProofRootMismatchError(new Uint8Array(32), new Uint8Array(32));
      }
      case 'V10ProofLeafCountMismatchError': {
        if (msg.fields?.kind === 'leafCountMismatch') {
          return new V10ProofLeafCountMismatchError(msg.fields.computedLeafCount, msg.fields.expectedLeafCount);
        }
        return new V10ProofLeafCountMismatchError(0, 0);
      }
      case 'V10ProofChunkOutOfRangeError': {
        if (msg.fields?.kind === 'chunkOutOfRange') {
          return new V10ProofChunkOutOfRangeError(msg.fields.chunkId, msg.fields.leafCount);
        }
        return new V10ProofChunkOutOfRangeError(0, 0);
      }
      default: {
        const e = new Error(msg.message);
        return e;
      }
    }
  }

  private failAll(err: Error): void {
    for (const task of this.pending.values()) task.reject(err);
    this.pending.clear();
  }

  build(req: ProofBuilderRequest): Promise<V10ProofMaterial> {
    const worker = this.ensureWorker();
    const taskId = this.nextTaskId++;
    return new Promise<V10ProofMaterial>((resolve, reject) => {
      this.pending.set(taskId, { taskId, resolve, reject });
      worker.postMessage(
        {
          taskId,
          leaves: req.leaves,
          chunkId: req.chunkId,
          expected: req.expected,
        },
        // We don't transfer ArrayBuffers (cheaper structuredClone is
        // fine for v1; transfer adds complexity around lifetime
        // tracking). Revisit if profiling shows leaf marshalling as
        // the bottleneck.
      );
    });
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    this.failAll(new Error('proof builder closed'));
    await this.worker.terminate();
    this.worker = null;
  }
}
