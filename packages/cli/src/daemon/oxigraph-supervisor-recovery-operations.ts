import {
  parseOxigraphGenerationV1,
  sleepOxigraphSupervisorV1,
} from './oxigraph-supervisor-lifecycle.js';
import {
  bindProvenOxigraphGenerationV1,
  type OxigraphSupervisorOperationContextV1,
} from './oxigraph-supervisor-operation-context.js';

/** Automatic revive and caller-driven recovery for one supervisor state owner. */
export class OxigraphSupervisorRecoveryOperationsV1 {
  readonly #context: OxigraphSupervisorOperationContextV1;
  #inFlightRecovery: { expected: string; promise: Promise<string> } | null = null;

  constructor(context: OxigraphSupervisorOperationContextV1) {
    this.#context = context;
  }

  scheduleRevive(reason: string): void {
    const { state, reviveBackoff, log, timers } = this.#context;
    if (state.terminating() || state.lifecycle() === 'closed') return;
    const { attempt, delayMs } = reviveBackoff.next();
    log(`[oxigraph] ${reason}; restart #${attempt} in ${delayMs}ms`);
    state.transition('reviving');
    timers.armRevive(delayMs, () => {
      if (state.terminating() || state.lifecycle() === 'closed') return;
      void this.#context.runExclusive(() => this.reviveLocked()).catch((error: unknown) => {
        log(`[oxigraph] restart attempt failed: ${(error as Error).message}`);
      });
    });
  }

  async reviveLocked(): Promise<void> {
    const {
      state,
      ownership,
      child,
      probes,
      bind,
      readyTimeoutMs,
      readyIntervalMs,
      log,
      markStoreDown,
    } = this.#context;
    if (state.terminating() || state.lifecycle() === 'closed' || state.lifecycle() === 'ready') {
      return;
    }
    ownership.invalidate('child-revive');
    markStoreDown();
    child.signal('SIGKILL');
    child.spawn();

    const reviveDeadline = Date.now() + readyTimeoutMs;
    while (Date.now() < reviveDeadline) {
      if (state.terminating()) return;
      if (!child.alive()) break;
      const listenerPid = await probes.probeReady();
      if (listenerPid !== null && child.alive()) {
        const generation = bindProvenOxigraphGenerationV1(
          this.#context,
          child.current()!,
          listenerPid,
        );
        log(`[oxigraph] server restarted and healthy on ${bind} (generation ${generation}).`);
        return;
      }
      await sleepOxigraphSupervisorV1(readyIntervalMs);
    }
    if (state.terminating()) return;
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
    const snapshot = this.#context.ownership.snapshot();
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
    const promise = this.#context.runExclusive(
      () => this.#recoverLocked(expectedGeneration),
    ).finally(() => {
      if (this.#inFlightRecovery?.promise === promise) this.#inFlightRecovery = null;
    });
    this.#inFlightRecovery = { expected: expectedGeneration, promise };
    return promise;
  }

  async #recoverLocked(expectedGeneration: string): Promise<string> {
    const { state, ownership, timers, bind } = this.#context;
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
    state.transition('recovering');
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
