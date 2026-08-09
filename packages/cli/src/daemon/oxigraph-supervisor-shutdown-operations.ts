import type { ChildProcess } from 'node:child_process';

import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import type { OxigraphSupervisorTimersV1 } from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorOwnershipControllerV1 } from './oxigraph-supervisor-ownership.js';
import type { OxigraphSupervisorProbesV1 } from './oxigraph-supervisor-probes.js';
import type { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';

const UNBOUND_GENERATION = '0';

interface OxigraphSupervisorShutdownDependenciesV1 {
  readonly state: OxigraphSupervisorStateV1;
  readonly ownership: OxigraphSupervisorOwnershipControllerV1;
  readonly child: Pick<
    OxigraphSupervisorChildV1,
    'current' | 'detach' | 'awaitExit' | 'signal'
  >;
  readonly probes: Pick<OxigraphSupervisorProbesV1, 'provePortRelease'>;
  readonly timers: Pick<OxigraphSupervisorTimersV1, 'clearRevive' | 'clearHandoffAbandon'>;
  readonly bind: string;
  readonly log: (message: string) => void;
  readonly markStoreDown: () => void;
  readonly runExclusive: <T>(section: () => Promise<T>) => Promise<T>;
}

/** Terminal shutdown and managed-port release proof. */
export class OxigraphSupervisorShutdownOperationsV1 {
  readonly #dependencies: OxigraphSupervisorShutdownDependenciesV1;

  constructor(dependencies: OxigraphSupervisorShutdownDependenciesV1) {
    this.#dependencies = dependencies;
  }

  beginTermination(): void {
    this.#dependencies.state.beginTermination();
    this.#dependencies.timers.clearRevive();
    this.#dependencies.timers.clearHandoffAbandon();
  }

  async proveManagedPortRelease(
    exited: ChildProcess | null,
    absoluteDeadlineMs?: number,
  ): Promise<boolean> {
    const { probes, bind, log, ownership } = this.#dependencies;
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
    const { state, ownership, markStoreDown, timers, child, log } = this.#dependencies;
    if (!state.beginStopping()) return;
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
    state.markClosed();
  }

  async stop(): Promise<void> {
    this.beginTermination();
    await this.#dependencies.runExclusive(() => this.stopLocked());
  }

  killSync(): void {
    this.beginTermination();
    this.#dependencies.markStoreDown();
    if (!this.#dependencies.ownership.snapshot().terminal) {
      this.#dependencies.ownership.invalidate('stop');
    }
    this.#dependencies.child.signal('SIGTERM');
  }
}
