import type { ChildProcess } from 'node:child_process';

import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import type {
  OxigraphSupervisorReviveBackoffV1,
} from './oxigraph-supervisor-revive.js';
import type {
  OxigraphSupervisorOwnershipControllerV1,
} from './oxigraph-supervisor-ownership.js';
import type { OxigraphSupervisorProbesV1 } from './oxigraph-supervisor-probes.js';
import type { OxigraphSupervisorTimersV1 } from './oxigraph-supervisor-lifecycle.js';
import type { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';

export interface OxigraphSupervisorOperationContextV1 {
  readonly state: OxigraphSupervisorStateV1;
  readonly ownership: OxigraphSupervisorOwnershipControllerV1;
  readonly child: OxigraphSupervisorChildV1;
  readonly probes: OxigraphSupervisorProbesV1;
  readonly timers: OxigraphSupervisorTimersV1;
  readonly reviveBackoff: OxigraphSupervisorReviveBackoffV1;
  readonly bind: string;
  readonly readyTimeoutMs: number;
  readonly readyIntervalMs: number;
  readonly log: (message: string) => void;
  readonly markStoreDown: () => void;
  readonly runExclusive: <T>(section: () => Promise<T>) => Promise<T>;
}

/** The only operation that binds a proven child generation. */
export function bindProvenOxigraphGenerationV1(
  context: OxigraphSupervisorOperationContextV1,
  child: ChildProcess,
  listenerPid: number,
): string {
  context.child.captureOomSnapshot(child, listenerPid);
  context.state.transition('ready');
  context.reviveBackoff.reset();
  return context.ownership.bindReadyGeneration();
}
