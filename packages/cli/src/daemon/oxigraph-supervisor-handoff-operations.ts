import { performance } from 'node:perf_hooks';

import type { ManagedOxigraphSupervisorHandoffV1 } from '@origintrail-official/dkg-storage';

import {
  boundedOxigraphPhaseDelayMsV1,
  sleepOxigraphSupervisorV1,
} from './oxigraph-supervisor-lifecycle.js';
import {
  bindProvenOxigraphGenerationV1,
  type OxigraphSupervisorOperationContextV1,
} from './oxigraph-supervisor-operation-context.js';
import type {
  OxigraphSupervisorRecoveryOperationsV1,
} from './oxigraph-supervisor-recovery-operations.js';
import type {
  OxigraphSupervisorShutdownOperationsV1,
} from './oxigraph-supervisor-shutdown-operations.js';

interface OxigraphSupervisorHandoffDependenciesV1 {
  readonly context: OxigraphSupervisorOperationContextV1;
  readonly recovery: OxigraphSupervisorRecoveryOperationsV1;
  readonly shutdown: OxigraphSupervisorShutdownOperationsV1;
  readonly abandonMs: number;
}

/** Two-phase clean-generation handoff and its abandoned-handoff backstop. */
export class OxigraphSupervisorHandoffOperationsV1 {
  readonly #context: OxigraphSupervisorOperationContextV1;
  readonly #recovery: OxigraphSupervisorRecoveryOperationsV1;
  readonly #shutdown: OxigraphSupervisorShutdownOperationsV1;
  readonly #abandonMs: number;

  constructor(dependencies: OxigraphSupervisorHandoffDependenciesV1) {
    this.#context = dependencies.context;
    this.#recovery = dependencies.recovery;
    this.#shutdown = dependencies.shutdown;
    this.#abandonMs = dependencies.abandonMs;
  }

  publicView(): ManagedOxigraphSupervisorHandoffV1 {
    return Object.freeze({
      stopAndProveOwnedChildDead: (absoluteDeadlineMs?: number) =>
        this.#context.runExclusive(() => this.#retireOwnedChildLocked(absoluteDeadlineMs)),
      startAndProveCleanGeneration: (absoluteDeadlineMs?: number) =>
        this.#context.runExclusive(() => this.#startCleanGenerationLocked(absoluteDeadlineMs)),
    });
  }

  #armAbandonBackstop(): void {
    const { state, timers, bind, log, runExclusive } = this.#context;
    timers.armHandoffAbandon(this.#abandonMs, () => {
      if (state.handoffPhase() !== 'retired'
        || state.terminating()
        || state.lifecycle() === 'closed') return;
      log(
        `[oxigraph] no clean generation was bound within ${this.#abandonMs}ms of retiring ` +
          `the child on ${bind}; resuming ordinary supervision.`,
      );
      state.setHandoffPhase('none');
      void runExclusive(() => this.#recovery.reviveLocked()).catch((error: unknown) => {
        log(`[oxigraph] abandoned-handoff recovery failed: ${(error as Error).message}`);
      });
    });
  }

  async #retireOwnedChildLocked(absoluteDeadlineMs?: number): Promise<void> {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    const { state, ownership, timers, markStoreDown, child, bind, log } = this.#context;
    if (state.terminating() || state.lifecycle() === 'closed') {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; the owned child cannot be retired',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'the owned child cannot be retired for a clean generation',
      );
    }
    state.transition('recovering');
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
      state.transition('closed');
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
    state.setHandoffPhase('retired');
    this.#armAbandonBackstop();
  }

  async #startCleanGenerationLocked(absoluteDeadlineMs?: number): Promise<void> {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
    const {
      state,
      ownership,
      timers,
      child,
      probes,
      bind,
      readyTimeoutMs,
      readyIntervalMs,
      log,
    } = this.#context;
    if (state.terminating() || state.lifecycle() === 'closed') {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; no clean generation can be bound',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'no clean generation can be bound',
      );
    }
    if (state.handoffPhase() !== 'retired') {
      throw new Error(
        'Managed Oxigraph clean-generation start requires a proven-dead predecessor; ' +
          'stopAndProveOwnedChildDead() has not completed',
      );
    }
    state.transition('recovering');
    timers.clearHandoffAbandon();
    try {
      child.spawn();
      const deadline = Math.min(
        performance.now() + readyTimeoutMs,
        absoluteDeadlineMs ?? Number.POSITIVE_INFINITY,
      );
      while (performance.now() < deadline) {
        if (state.terminating() || !child.alive()) break;
        const listenerPid = await probes.probeReady(absoluteDeadlineMs);
        if (listenerPid !== null && child.alive()) {
          const generation = bindProvenOxigraphGenerationV1(
            this.#context,
            child.current()!,
            listenerPid,
          );
          state.setHandoffPhase('none');
          log(`[oxigraph] clean child generation ${generation} bound on ${bind}.`);
          return;
        }
        await sleepOxigraphSupervisorV1(
          boundedOxigraphPhaseDelayMsV1(readyIntervalMs, deadline),
        );
      }
      throw new Error(
        `Managed Oxigraph could not prove a clean child generation on ${bind} ` +
          'before the clean-generation recovery deadline',
      );
    } catch (error) {
      child.signal('SIGKILL');
      state.setHandoffPhase('none');
      this.#recovery.scheduleRevive(`clean-generation start failed on ${bind}`);
      throw error;
    }
  }
}
