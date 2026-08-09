import type { ChildProcess } from 'node:child_process';

import type {
  OxigraphSupervisorOperationContextV1,
} from './oxigraph-supervisor-operation-context.js';

const UNBOUND_GENERATION = '0';

/** Terminal shutdown and managed-port release proof. */
export class OxigraphSupervisorShutdownOperationsV1 {
  readonly #context: OxigraphSupervisorOperationContextV1;

  constructor(context: OxigraphSupervisorOperationContextV1) {
    this.#context = context;
  }

  beginTermination(): void {
    this.#context.state.beginTermination();
    this.#context.timers.clearRevive();
    this.#context.timers.clearHandoffAbandon();
  }

  async proveManagedPortRelease(
    exited: ChildProcess | null,
    absoluteDeadlineMs?: number,
  ): Promise<boolean> {
    const { probes, bind, log, ownership } = this.#context;
    const result = await probes.provePortRelease(exited, absoluteDeadlineMs);
    if (result.released) return true;
    log(
      `[oxigraph] ${bind} release could not be proven after the managed child exited ` +
        `(last probe: ${result.last}).`,
    );
    log(
      `[oxigraph] ${bind} is still served after the managed child exited ` +
        `(${result.owner === null
          ? 'listener is NOT attributable to a process we spawned'
          : `listener still owned by pid ${result.owner}`}). ` +
        'Port release could not be proven; managed-store ownership is now terminal.',
    );
    ownership.invalidate('port-release-unproven');
    return false;
  }

  async stopLocked(): Promise<void> {
    const { state, ownership, markStoreDown, timers, child, log } = this.#context;
    if (state.lifecycle() === 'closed') return;
    state.transition('stopping');
    ownership.invalidate('stop');
    markStoreDown();
    timers.clearRevive();
    const current = child.current();
    if (current) child.detach(current);
    const provedOwnership = ownership.snapshot().childGeneration !== UNBOUND_GENERATION;
    if (current && current.exitCode === null && current.signalCode === null) {
      await child.awaitExit(current);
      log('[oxigraph] server stopped');
    }
    if (provedOwnership) await this.proveManagedPortRelease(current);
    if (!ownership.snapshot().terminal) ownership.invalidate('shutdown');
    state.transition('closed');
  }

  async stop(): Promise<void> {
    this.beginTermination();
    await this.#context.runExclusive(() => this.stopLocked());
  }

  killSync(): void {
    this.beginTermination();
    this.#context.markStoreDown();
    if (!this.#context.ownership.snapshot().terminal) {
      this.#context.ownership.invalidate('stop');
    }
    this.#context.child.signal('SIGTERM');
  }
}
