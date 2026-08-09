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

  terminating(): boolean {
    return this.#terminating;
  }

  beginTermination(): void {
    this.#terminating = true;
  }

  handoffPhase(): OxigraphSupervisorHandoffPhaseV1 {
    return this.#handoffPhase;
  }

  beginRevive(): void {
    this.#assertOperational('revive');
    this.#assertHandoffPhase('none', 'revive');
    this.#lifecycle = 'reviving';
  }

  beginRecovery(): void {
    this.#assertOperational('recover');
    this.#assertHandoffPhase('none', 'recover');
    this.#lifecycle = 'recovering';
  }

  beginHandoffRetirement(): void {
    this.#assertOperational('retire the current generation');
    this.#assertHandoffPhase('none', 'retire the current generation');
    this.#lifecycle = 'recovering';
  }

  markHandoffRetired(): void {
    this.#assertOperational('mark the current generation retired');
    this.#assertHandoffPhase('none', 'mark the current generation retired');
    if (this.#lifecycle !== 'recovering') {
      throw new Error('Managed Oxigraph handoff retirement requires recovery state');
    }
    this.#handoffPhase = 'retired';
  }

  beginCleanGeneration(): void {
    this.#assertOperational('start a clean generation');
    this.#assertHandoffPhase('retired', 'start a clean generation');
    this.#lifecycle = 'recovering';
  }

  resumeRetiredHandoff(): void {
    this.#assertOperational('resume an abandoned handoff');
    this.#assertHandoffPhase('retired', 'resume an abandoned handoff');
    this.#handoffPhase = 'none';
    this.#lifecycle = 'recovering';
  }

  cancelCleanGeneration(): void {
    if (this.#handoffPhase !== 'retired'
      && !(this.#handoffPhase === 'none' && this.#lifecycle === 'ready')) {
      throw new Error(
        `Managed Oxigraph supervisor cannot cancel a clean generation while lifecycle is ` +
          `${this.#lifecycle} and handoff phase is ${this.#handoffPhase}`,
      );
    }
    this.#handoffPhase = 'none';
    if (this.#lifecycle !== 'closed') this.#lifecycle = 'recovering';
  }

  bindReadyGeneration(): void {
    this.#assertOperational('bind a ready generation');
    this.#handoffPhase = 'none';
    this.#lifecycle = 'ready';
  }

  beginStopping(): void {
    if (this.#lifecycle === 'closed') return;
    this.#terminating = true;
    this.#handoffPhase = 'none';
    this.#lifecycle = 'stopping';
  }

  markClosed(): void {
    this.#terminating = true;
    this.#handoffPhase = 'none';
    this.#lifecycle = 'closed';
  }

  #assertOperational(intent: string): void {
    if (this.#terminating || this.#lifecycle === 'stopping' || this.#lifecycle === 'closed') {
      throw new Error(`Managed Oxigraph supervisor cannot ${intent} after shutdown began`);
    }
  }

  #assertHandoffPhase(expected: OxigraphSupervisorHandoffPhaseV1, intent: string): void {
    if (this.#handoffPhase !== expected) {
      throw new Error(
        `Managed Oxigraph supervisor cannot ${intent} while handoff phase is ` +
          `${this.#handoffPhase}`,
      );
    }
  }
}
