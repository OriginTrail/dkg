import type { ManagedOxigraphSupervisorHandoffV1 } from '@origintrail-official/dkg-storage';

import {
  boundedOxigraphPhaseDelayMsV1,
} from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import type { OxigraphSupervisorGenerationV1 } from './oxigraph-supervisor-generation.js';
import type { OxigraphSupervisorTimersV1 } from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorOwnershipControllerV1 } from './oxigraph-supervisor-ownership.js';
import type {
  OxigraphSupervisorRecoveryOperationsV1,
} from './oxigraph-supervisor-recovery-operations.js';
import type {
  OxigraphSupervisorShutdownOperationsV1,
} from './oxigraph-supervisor-shutdown-operations.js';
import type { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';

interface OxigraphSupervisorHandoffDependenciesV1 {
  readonly state: OxigraphSupervisorStateV1;
  readonly ownership: OxigraphSupervisorOwnershipControllerV1;
  readonly child: Pick<
    OxigraphSupervisorChildV1,
    'current' | 'markHandoffRetiring' | 'awaitExit' | 'detach' | 'signal'
  >;
  readonly generation: OxigraphSupervisorGenerationV1;
  readonly timers: Pick<
    OxigraphSupervisorTimersV1,
    'armHandoffAbandon' | 'clearHandoffAbandon' | 'clearRevive'
  >;
  readonly recovery: OxigraphSupervisorRecoveryOperationsV1;
  readonly shutdown: OxigraphSupervisorShutdownOperationsV1;
  readonly abandonMs: number;
  readonly bind: string;
  readonly log: (message: string) => void;
  readonly markStoreDown: () => void;
  readonly runExclusive: <T>(section: () => Promise<T>) => Promise<T>;
}

/** Two-phase clean-generation handoff and its abandoned-handoff backstop. */
export class OxigraphSupervisorHandoffOperationsV1 {
  readonly #dependencies: OxigraphSupervisorHandoffDependenciesV1;
  readonly #recovery: OxigraphSupervisorRecoveryOperationsV1;
  readonly #shutdown: OxigraphSupervisorShutdownOperationsV1;
  readonly #abandonMs: number;

  constructor(dependencies: OxigraphSupervisorHandoffDependenciesV1) {
    this.#dependencies = dependencies;
    this.#recovery = dependencies.recovery;
    this.#shutdown = dependencies.shutdown;
    this.#abandonMs = dependencies.abandonMs;
  }

  publicView(): ManagedOxigraphSupervisorHandoffV1 {
    return Object.freeze({
      stopAndProveOwnedChildDead: (absoluteDeadlineMs?: number) =>
        this.#dependencies.runExclusive(() => this.#retireOwnedChildLocked(absoluteDeadlineMs)),
      startAndProveCleanGeneration: (absoluteDeadlineMs?: number) =>
        this.#dependencies.runExclusive(() => this.#startCleanGenerationLocked(absoluteDeadlineMs)),
    });
  }

  #armAbandonBackstop(): void {
    const { state, timers, bind, log, runExclusive } = this.#dependencies;
    timers.armHandoffAbandon(this.#abandonMs, () => {
      if (!state.tryResumeRetiredHandoff()) return;
      log(
        `[oxigraph] no clean generation was bound within ${this.#abandonMs}ms of retiring ` +
          `the child on ${bind}; resuming ordinary supervision.`,
      );
      void runExclusive(() => this.#recovery.reviveLocked()).catch((error: unknown) => {
        log(`[oxigraph] abandoned-handoff recovery failed: ${(error as Error).message}`);
      });
    });
  }

  async #retireOwnedChildLocked(absoluteDeadlineMs?: number): Promise<void> {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    const { state, ownership, timers, markStoreDown, child, bind, log } = this.#dependencies;
    state.assertHandoffRetirementAllowed();
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'the owned child cannot be retired for a clean generation',
      );
    }
    state.beginHandoffRetirement();
    timers.clearRevive();
    ownership.invalidate('stop');
    markStoreDown();
    const current = child.current();
    if (current && current.exitCode === null && current.signalCode === null) {
      child.markHandoffRetiring(current);
      await child.awaitExit(current, absoluteDeadlineMs);
    }
    if (current) child.detach(current);
    if (!(await this.#shutdown.proveManagedPortRelease(current, absoluteDeadlineMs))) {
      this.#shutdown.beginTermination();
      state.markClosed();
      log(
        `[oxigraph] FATAL: could not prove ${bind} was released after retiring the managed ` +
          'child. The supervisor is now closed and will never start another child. Writes to ' +
          'that endpoint are refused from here on, but READS are still routed to it and may ' +
          'reach a listener this node cannot account for — restart the node.',
      );
      throw new Error(
        `Managed Oxigraph could not prove ${bind} was released after retiring the child; ` +
          'managed-store capability is now terminal',
      );
    }
    state.markHandoffRetired();
    this.#armAbandonBackstop();
  }

  async #startCleanGenerationLocked(absoluteDeadlineMs?: number): Promise<void> {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    const {
      state,
      ownership,
      timers,
      child,
      generation,
      bind,
      log,
    } = this.#dependencies;
    state.beginCleanGeneration();
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'no clean generation can be bound',
      );
    }
    timers.clearHandoffAbandon();
    let generationId: string;
    try {
      const result = await generation.spawnAndProve(absoluteDeadlineMs);
      if (result.status === 'ready') {
        generationId = result.generation;
      } else {
        throw new Error(
          `Managed Oxigraph could not prove a clean child generation on ${bind} ` +
            'before the clean-generation recovery deadline',
        );
      }
    } catch (error) {
      child.signal('SIGKILL');
      state.cancelCleanGeneration();
      this.#recovery.scheduleRevive(`clean-generation start failed on ${bind}`);
      throw error;
    }
    log(`[oxigraph] clean child generation ${generationId} bound on ${bind}.`);
  }
}
