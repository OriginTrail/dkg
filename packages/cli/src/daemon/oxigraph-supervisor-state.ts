import type { OxigraphLifecycleStateV1 } from './oxigraph-supervisor-lifecycle.js';

export type OxigraphSupervisorHandoffPhaseV1 = 'none' | 'retired';

/** Single owner for mutable supervisor lifecycle and handoff state. */
export class OxigraphSupervisorStateV1 {
  #lifecycle: OxigraphLifecycleStateV1 = 'starting';
  #terminating = false;
  #handoffPhase: OxigraphSupervisorHandoffPhaseV1 = 'none';

  lifecycle(): OxigraphLifecycleStateV1 {
    return this.#lifecycle;
  }

  transition(next: OxigraphLifecycleStateV1): void {
    this.#lifecycle = next;
  }

  terminating(): boolean {
    return this.#terminating;
  }

  beginTermination(): void {
    this.#terminating = true;
  }

  handoffPhase(): OxigraphSupervisorHandoffPhaseV1 {
    return this.#handoffPhase;
  }

  setHandoffPhase(next: OxigraphSupervisorHandoffPhaseV1): void {
    this.#handoffPhase = next;
  }
}
