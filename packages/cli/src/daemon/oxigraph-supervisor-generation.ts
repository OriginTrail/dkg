import { performance } from 'node:perf_hooks';

import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import { sleepOxigraphSupervisorV1 } from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorOwnershipControllerV1 } from './oxigraph-supervisor-ownership.js';
import type { OxigraphSupervisorProbesV1 } from './oxigraph-supervisor-probes.js';
import type { OxigraphSupervisorReviveBackoffV1 } from './oxigraph-supervisor-revive.js';
import type { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';

interface OxigraphSupervisorGenerationOptionsV1 {
  readonly state: Pick<OxigraphSupervisorStateV1, 'terminating' | 'bindReadyGeneration'>;
  readonly ownership: Pick<OxigraphSupervisorOwnershipControllerV1, 'bindReadyGeneration'>;
  readonly child: Pick<
    OxigraphSupervisorChildV1,
    'spawn' | 'alive' | 'current' | 'captureOomSnapshot'
  >;
  readonly probes: Pick<OxigraphSupervisorProbesV1, 'probeReady'>;
  readonly reviveBackoff: Pick<OxigraphSupervisorReviveBackoffV1, 'reset'>;
  readonly readyTimeoutMs: number;
  readonly readyIntervalMs: number;
}

export type OxigraphProvenGenerationResultV1 =
  | { readonly status: 'ready'; readonly generation: string; readonly attempts: number }
  | { readonly status: 'child-exited' | 'terminated' | 'deadline'; readonly attempts: number };

/** One owner for spawn, readiness, listener attribution, and generation binding. */
export class OxigraphSupervisorGenerationV1 {
  readonly #options: OxigraphSupervisorGenerationOptionsV1;

  constructor(options: OxigraphSupervisorGenerationOptionsV1) {
    this.#options = options;
  }

  async spawnAndProve(
    absoluteDeadlineMs?: number,
  ): Promise<OxigraphProvenGenerationResultV1> {
    const { state, ownership, child, probes, reviveBackoff } = this.#options;
    child.spawn();
    const deadline = Math.min(
      performance.now() + this.#options.readyTimeoutMs,
      absoluteDeadlineMs ?? Number.POSITIVE_INFINITY,
    );
    let attempts = 0;
    while (performance.now() < deadline) {
      if (state.terminating()) return { status: 'terminated', attempts };
      if (!child.alive()) return { status: 'child-exited', attempts };
      attempts += 1;
      const listenerPid = await probes.probeReady(absoluteDeadlineMs);
      if (listenerPid !== null && child.alive()) {
        const current = child.current();
        if (current === null) return { status: 'child-exited', attempts };
        child.captureOomSnapshot(current, listenerPid);
        state.bindReadyGeneration();
        reviveBackoff.reset();
        return {
          status: 'ready',
          generation: ownership.bindReadyGeneration(),
          attempts,
        };
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await sleepOxigraphSupervisorV1(
        Math.max(1, Math.ceil(Math.min(this.#options.readyIntervalMs, remainingMs))),
      );
    }
    return { status: 'deadline', attempts };
  }
}
