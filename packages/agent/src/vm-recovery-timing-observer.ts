// SPDX-License-Identifier: Apache-2.0
import { VmRecoveryPhaseRecorder, markVmRecoveryRpc, describeVmRecoveryRpcSince,
  formatVmRecoveryPhases, observeVmRecoveryTiming } from './vm-recovery-phase-timing.js';
import type { VmRecoveryFootprintObservation } from './vm-recovery-footprint.js';
import { formatVmRecoveryPreparationStats, type VmRecoveryPreparationStats } from './vm-recovery-preparation.js';

const NO_SIZING: VmRecoveryFootprintObservation = Object.freeze({
  elapsedMs: 0, requested: 0, prepared: 0, resolved: 0, timedOut: 0, aborted: 0, invalid: 0, failed: 0,
});

export interface VmRecoveryBatchTimingMetadata {
  readonly peerId: string;
  readonly assets: number;
  readonly candidates: number;
  readonly kind: string;
  readonly transport: string;
  readonly streamAdvertised: number;
  readonly streamPeers: number;
  readonly registeredAuthority: string;
}

/** Observation-only owner of per-batch marks, sizing, counters and log formatting. */
export class VmRecoveryTimingObserver {
  readonly phases = new VmRecoveryPhaseRecorder();
  readonly #startedAt = performance.now();
  #batches = 0;
  #assets = 0;

  constructor(private readonly localCgId: string, private readonly log: (message: string) => void) {}

  beginBatch() {
    const startedAt = performance.now();
    const rpcMark = markVmRecoveryRpc();
    let sizing = NO_SIZING;
    return {
      observeSizing: (observation: VmRecoveryFootprintObservation): void => { sizing = observation; },
      complete: (metadata: VmRecoveryBatchTimingMetadata): void => {
        this.#batches += 1;
        this.#assets += metadata.assets;
        observeVmRecoveryTiming(() => this.log(
          `VM recovery batch timing for "${this.localCgId}" from ${metadata.peerId.slice(-8)}: `
            + `assets=${metadata.assets} candidates=${metadata.candidates} kind=${metadata.kind} `
            + `transport=${metadata.transport} streamAdvertised=${metadata.streamAdvertised} `
            + `streamPeers=${metadata.streamPeers} registeredAuthority=${metadata.registeredAuthority} `
            + `totalMs=${Math.round(performance.now() - startedAt)} `
            + `${formatVmRecoveryPhases(this.phases.take())} `
            + `sizingRequested=${sizing.requested} sizingPrepared=${sizing.prepared} sizingResolved=${sizing.resolved} sizingTimedOut=${sizing.timedOut} `
            + `sizingAborted=${sizing.aborted} sizingInvalid=${sizing.invalid} sizingFailed=${sizing.failed} `
            + `${describeVmRecoveryRpcSince(rpcMark)}`,
        ));
      },
    };
  }

  finish(eligible: number, preparation?: () => VmRecoveryPreparationStats): void {
    if (this.#batches === 0) return;
    observeVmRecoveryTiming(() => this.log(
      `VM recovery pass timing for "${this.localCgId}": batches=${this.#batches} assets=${this.#assets} `
        + `eligible=${eligible} totalMs=${Math.round(performance.now() - this.#startedAt)} `
        + `${formatVmRecoveryPhases(this.phases.cumulative())}`
        + (preparation ? ` ${formatVmRecoveryPreparationStats(preparation())}` : ''),
    ));
  }
}
