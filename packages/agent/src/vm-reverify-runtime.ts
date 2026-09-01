// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE runtime owner of chain-triggered re-verification (#2435, review r2).
 *
 * Activation, store ownership, worker construction/start/stop and ordered
 * teardown live HERE, as explicit lifecycle transitions on one object —
 * previously they were nullable fields spread across the agent mixins, whose
 * legal combinations existed only in comments and call ordering. The agent
 * keeps thin delegating accessors so its public surface (and every wiring
 * test that proves the invariants through it) is unchanged.
 *
 * Invariants this class owns:
 *  - **Kill switch**: `prepare` runs the effective gate before ANY store is
 *    accepted — an injected store substitutes for the durable file only.
 *  - **No file when disabled**: the SQLite open happens only on an effective
 *    activation with a data directory (ADR-W2R-6 rollback property).
 *  - **Loud-not-fatal open**: a failed open records `store-open-failed`,
 *    reports at ERROR level, and the node boots without the feature.
 *  - **Latched activation** (r1): what THIS process armed is what the status
 *    resolver reports; the latch clears only on `close`, the restart boundary.
 *  - **Worker-before-store teardown**: the drain is the store's only writer,
 *    so `close` stops it first — a property of this method, not of callers.
 *  - **Borrowed stores are never closed**: an injected store belongs to
 *    whoever injected it; `close` detaches it and nothing more.
 */
import { join } from 'node:path';

import { VM_REVERIFY_INTENTS_DATABASE_FILENAME } from './vm-reverify-intent-store.js';
import { openSqliteVmReverifyIntentStore } from './vm-reverify-intent-sqlite-store.js';
import { VmReverifyWorker, type VmReverifyWorkerDependencies } from './vm-reverify-worker.js';
import type { VmReverifyIntentStore } from './vm-reverify-intent-store.js';

export interface VmReverifyActivation {
  effective: boolean;
  reason?: string;
}

export interface VmReverifyPrepareInput {
  dataDir?: string;
  /** The config-injected store, when the embedder supplied one. */
  injected?: VmReverifyIntentStore;
  /** The agent's ONE effective-state resolver (gate + capability probe). */
  resolveState(): Promise<VmReverifyActivation>;
  /** ERROR-level reporting for the loud-not-fatal open failure. */
  logError(message: string): void;
}

export class VmReverifyRuntime {
  #store: VmReverifyIntentStore | undefined;
  #worker: VmReverifyWorker | undefined;
  #activation: VmReverifyActivation | undefined;
  #openFailure: string | undefined;

  get store(): VmReverifyIntentStore | undefined {
    return this.#store;
  }

  /** Test/lifecycle seam: assigning a store arms the feature directly. */
  set store(store: VmReverifyIntentStore | undefined) {
    this.#store = store;
  }

  get worker(): VmReverifyWorker | undefined {
    return this.#worker;
  }

  /** Test/lifecycle seam: fake workers stand in for the real drain. */
  set worker(worker: VmReverifyWorker | undefined) {
    this.#worker = worker;
  }

  get activation(): VmReverifyActivation | undefined {
    return this.#activation;
  }

  set activation(activation: VmReverifyActivation | undefined) {
    this.#activation = activation;
  }

  get openFailure(): string | undefined {
    return this.#openFailure;
  }

  set openFailure(failure: string | undefined) {
    this.#openFailure = failure;
  }

  /**
   * Decide activation and, when effective, arm the store. Every path records
   * the latch; none throws — a failed open must never take the boot down.
   */
  async prepare(input: VmReverifyPrepareInput): Promise<void> {
    if (this.#store) return;
    // No durable backing of either kind means the feature CANNOT arm, and the
    // answer must not cost a capability probe: agents without a chain adapter
    // (synthetic lifecycle tests, chainless tooling) prepare too, and the
    // reconcile gate inside the resolver reads the adapter directly.
    if (!input.dataDir && !input.injected) {
      this.#activation = { effective: false, reason: 'no-data-dir' };
      return;
    }
    // The effective gate runs FIRST, before an injected store is accepted
    // (review r1): injection substitutes for the durable FILE, not for the
    // operator flag, the reconciler, or the adapter capability set — an
    // injected store with the switch off must wire neither lane nor worker.
    const state = await input.resolveState();
    if (!state.effective) {
      this.#activation = state;
      return;
    }
    if (input.injected) {
      this.#store = input.injected;
      this.#activation = { effective: true };
      return;
    }
    // Unreachable at RUNTIME — the effective gate above already returned
    // without a dataDir or an injected substitute — kept because it narrows
    // the type for the open call.
    if (!input.dataDir) return;
    const databasePath = join(input.dataDir, VM_REVERIFY_INTENTS_DATABASE_FILENAME);
    // SCOPE: this catch covers the intent-store open and NOTHING else, so it
    // cannot soften the boot-fatal contract of the startup block that calls
    // prepare — `prepareFinalizationRecoveryStore()` and every sibling there
    // keep failing the boot, which is right for core durability.
    try {
      this.#store = await openSqliteVmReverifyIntentStore(input.dataDir);
      this.#openFailure = undefined;
      this.#activation = { effective: true };
    } catch (error) {
      this.#openFailure = error instanceof Error ? error.message : String(error);
      this.#activation = { effective: false, reason: 'store-open-failed' };
      input.logError(
        'DKG_VM_UPDATE_CONVERGENCE_ENABLED is on but the re-verification intent '
        + `store could not be opened at ${databasePath}: `
        + `${this.#openFailure}. Chain-triggered re-verification `
        + 'is DISABLED for this process; the node continues without it.',
      );
    }
  }

  /** Construct the drain once the store exists; started separately, at readiness. */
  constructWorker(dependencies: VmReverifyWorkerDependencies): void {
    if (!this.#store || this.#worker) return;
    this.#worker = new VmReverifyWorker(dependencies);
  }

  /**
   * Start the drain at the readiness boundary (review r1): `start()`'s
   * immediate first run drains intents recorded before readiness promptly
   * after it. Returns whether a start actually happened, so the caller logs
   * exactly once.
   */
  startWorkerAtReadiness(): boolean {
    if (!this.#worker || this.#worker.running) return false;
    this.#worker.start();
    return true;
  }

  /**
   * Ordered teardown: stop the drain FIRST (the store's only writer), then
   * close the store unless it is the BORROWED `configInjected` instance, then
   * clear the activation latch so a same-object restart re-probes.
   */
  async close(configInjected: VmReverifyIntentStore | undefined): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    let stopFailed = false;
    let stopFailure: unknown;
    try {
      await worker?.stop();
    } catch (error) {
      // A throwing stop is a broken worker, not a reason to leave the store
      // and the latch ATTACHED (review r4: the audit boundary depends on
      // close detaching even mid-failure). Detach everything, then report.
      stopFailed = true;
      stopFailure = error;
    }
    const store = this.#store;
    this.#store = undefined;
    this.#activation = undefined;
    try {
      if (store && store !== configInjected) await store.close();
    } catch (closeFailure) {
      if (stopFailed) {
        throw new AggregateError([stopFailure, closeFailure], 'VM re-verify teardown failed');
      }
      throw closeFailure;
    }
    if (stopFailed) throw stopFailure;
  }
}
