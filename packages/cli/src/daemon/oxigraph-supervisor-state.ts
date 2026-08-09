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

  maySpawnChild(): boolean {
    return this.#isOperational();
  }

  mayHandleChildExit(): boolean {
    return this.#isOperational();
  }

  shouldReviveExitedChild(): boolean {
    return this.#isOperational() && this.#lifecycle === 'ready';
  }

  mayContinueGenerationProbe(): boolean {
    return !this.#terminating;
  }

  handoffPhase(): OxigraphSupervisorHandoffPhaseV1 {
    return this.#handoffPhase;
  }

  tryBeginRevive(): boolean {
    if (!this.#isOperational()) return false;
    this.#assertHandoffPhase('none', 'revive');
    this.#lifecycle = 'reviving';
    return true;
  }

  mayRunRevive(): boolean {
    return this.#isOperational()
      && this.#handoffPhase === 'none'
      && this.#lifecycle !== 'ready';
  }

  beginRecovery(): void {
    this.assertRecoveryRequestAllowed();
    this.#lifecycle = 'recovering';
  }

  assertRecoveryRequestAllowed(): void {
    this.#assertOperational('recover');
    this.#assertHandoffPhase('none', 'recover');
  }

  beginHandoffRetirement(): void {
    this.assertHandoffRetirementAllowed();
    this.#lifecycle = 'recovering';
  }

  assertHandoffRetirementAllowed(): void {
    if (!this.#isOperational()) {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; the owned child cannot be retired',
      );
    }
    this.#assertHandoffPhase('none', 'retire the current generation');
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
    if (!this.#isOperational()) {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; no clean generation can be bound',
      );
    }
    if (this.#handoffPhase !== 'retired') {
      throw new Error(
        'Managed Oxigraph clean-generation start requires a proven-dead predecessor; ' +
          'stopAndProveOwnedChildDead() has not completed',
      );
    }
    this.#lifecycle = 'recovering';
  }

  tryResumeRetiredHandoff(): boolean {
    if (!this.#isOperational() || this.#handoffPhase !== 'retired') return false;
    this.#handoffPhase = 'none';
    this.#lifecycle = 'recovering';
    return true;
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

  beginStopping(): boolean {
    if (this.#lifecycle === 'closed') return false;
    this.#terminating = true;
    this.#handoffPhase = 'none';
    this.#lifecycle = 'stopping';
    return true;
  }

  markClosed(): void {
    this.#terminating = true;
    this.#handoffPhase = 'none';
    this.#lifecycle = 'closed';
  }

  #assertOperational(intent: string): void {
    if (!this.#isOperational()) {
      throw new Error(`Managed Oxigraph supervisor cannot ${intent} after shutdown began`);
    }
  }

  #isOperational(): boolean {
    return !this.#terminating && this.#lifecycle !== 'stopping' && this.#lifecycle !== 'closed';
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
