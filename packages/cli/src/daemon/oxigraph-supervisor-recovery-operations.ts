import {
  parseOxigraphGenerationV1,
} from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import type { OxigraphSupervisorGenerationV1 } from './oxigraph-supervisor-generation.js';
import type { OxigraphSupervisorTimersV1 } from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorOwnershipControllerV1 } from './oxigraph-supervisor-ownership.js';
import type { OxigraphSupervisorReviveBackoffV1 } from './oxigraph-supervisor-revive.js';
import type { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';

interface OxigraphSupervisorRecoveryDependenciesV1 {
  readonly state: OxigraphSupervisorStateV1;
  readonly ownership: OxigraphSupervisorOwnershipControllerV1;
  readonly child: Pick<OxigraphSupervisorChildV1, 'signal'>;
  readonly generation: OxigraphSupervisorGenerationV1;
  readonly timers: Pick<OxigraphSupervisorTimersV1, 'armRevive' | 'clearRevive'>;
  readonly reviveBackoff: Pick<OxigraphSupervisorReviveBackoffV1, 'next'>;
  readonly bind: string;
  readonly log: (message: string) => void;
  readonly markStoreDown: () => void;
  readonly runExclusive: <T>(section: () => Promise<T>) => Promise<T>;
}

/** Automatic revive and caller-driven recovery for one supervisor state owner. */
export class OxigraphSupervisorRecoveryOperationsV1 {
  readonly #dependencies: OxigraphSupervisorRecoveryDependenciesV1;
  #inFlightRecovery: { expected: string; promise: Promise<string> } | null = null;

  constructor(dependencies: OxigraphSupervisorRecoveryDependenciesV1) {
    this.#dependencies = dependencies;
  }

  scheduleRevive(reason: string): void {
    const { state, reviveBackoff, log, timers } = this.#dependencies;
    if (state.terminating() || state.lifecycle() === 'closed') return;
    const { attempt, delayMs } = reviveBackoff.next();
    log(`[oxigraph] ${reason}; restart #${attempt} in ${delayMs}ms`);
    state.beginRevive();
    timers.armRevive(delayMs, () => {
      if (state.terminating() || state.lifecycle() === 'closed') return;
      void this.#dependencies.runExclusive(() => this.reviveLocked()).catch((error: unknown) => {
        log(`[oxigraph] restart attempt failed: ${(error as Error).message}`);
      });
    });
  }

  async reviveLocked(): Promise<void> {
    const {
      state,
      ownership,
      child,
      generation,
      bind,
      log,
      markStoreDown,
    } = this.#dependencies;
    if (state.terminating() || state.lifecycle() === 'closed' || state.lifecycle() === 'ready') {
      return;
    }
    ownership.invalidate('child-revive');
    markStoreDown();
    child.signal('SIGKILL');
    const result = await generation.spawnAndProve();
    if (result.status === 'ready') {
      log(
        `[oxigraph] server restarted and healthy on ${bind} ` +
          `(generation ${result.generation}).`,
      );
      return;
    }
    if (result.status === 'terminated' || state.terminating()) return;
    child.signal('SIGKILL');
    this.scheduleRevive(`respawned server did not become ready on ${bind}`);
  }

  recoverGeneration(expectedGeneration: string): Promise<string> {
    let expected: bigint;
    try {
      expected = parseOxigraphGenerationV1(expectedGeneration);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const snapshot = this.#dependencies.ownership.snapshot();
    if (snapshot.terminal) {
      return Promise.reject(new Error(
        `Managed Oxigraph ownership is terminal (${snapshot.lastInvalidation}); ` +
          `generation ${expectedGeneration} cannot be recovered`,
      ));
    }
    const current = BigInt(snapshot.childGeneration);
    if (expected > current) {
      return Promise.reject(new Error(
        `Managed Oxigraph child generation ${expectedGeneration} was never bound ` +
          `(current generation is ${snapshot.childGeneration})`,
      ));
    }
    if (expected < current) return Promise.resolve(snapshot.childGeneration);
    if (snapshot.ready) return Promise.resolve(snapshot.childGeneration);
    const existing = this.#inFlightRecovery;
    if (existing !== null && existing.expected === expectedGeneration) return existing.promise;
    const promise = this.#dependencies.runExclusive(
      () => this.#recoverLocked(expectedGeneration),
    ).finally(() => {
      if (this.#inFlightRecovery?.promise === promise) this.#inFlightRecovery = null;
    });
    this.#inFlightRecovery = { expected: expectedGeneration, promise };
    return promise;
  }

  async #recoverLocked(expectedGeneration: string): Promise<string> {
    const { state, ownership, timers, bind } = this.#dependencies;
    if (state.terminating() || state.lifecycle() === 'closed') {
      throw new Error(
        `Managed Oxigraph supervisor is shutting down; generation ${expectedGeneration} ` +
          'cannot be recovered',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          `generation ${expectedGeneration} cannot be recovered`,
      );
    }
    if (before.childGeneration !== expectedGeneration || before.ready) {
      return before.childGeneration;
    }
    if (state.handoffPhase() === 'retired') {
      throw new Error(
        `Managed Oxigraph is mid clean-generation handoff; generation ` +
          `${expectedGeneration} cannot be recovered until the replacement binds`,
      );
    }
    state.beginRecovery();
    timers.clearRevive();
    await this.reviveLocked();
    const after = ownership.snapshot();
    if (!after.ready || after.childGeneration === expectedGeneration) {
      throw new Error(
        `Managed Oxigraph could not bind a child generation newer than ` +
          `${expectedGeneration} on ${bind}`,
      );
    }
    return after.childGeneration;
  }
}
