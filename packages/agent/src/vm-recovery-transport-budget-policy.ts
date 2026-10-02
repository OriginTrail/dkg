// SPDX-License-Identifier: Apache-2.0

import type { VmRecoveryProviderAttemptKind } from './vm-recovery-provider-policy.js';

/** The budget is per exact probe and its full-scan fallback, not per wire request. */
const MIXED_LEGACY_TIMEOUT_MS = 120_000;
const FULL_BUDGET_EVERY = 4;
const MAX_HISTORY_ENTRIES = 16_384;

export interface VmRecoveryTransportBudgetTarget {
  readonly localCgId: string;
  readonly onChainCgId: string;
  readonly ordinal: number;
  readonly ual: string;
  readonly merkleRoot: string;
}

interface BudgetSelection {
  readonly target: VmRecoveryTransportBudgetTarget;
  readonly peerId: string;
  readonly providerAttemptKind: VmRecoveryProviderAttemptKind;
  readonly registeredPublicAccess: boolean;
  readonly competingStreamAvailable: boolean;
  readonly streamEligible: boolean;
}

/** Process-local physical-attempt history; it never creates asset or absence evidence. */
export class VmRecoveryTransportBudgetPolicy {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly maxEntries = MAX_HISTORY_ENTRIES) {}

  attemptOrdinal(target: VmRecoveryTransportBudgetTarget, peerId: string): number {
    return this.attempts.get(this.key(target, peerId)) ?? 0;
  }

  timeoutFor(selection: BudgetSelection): number | undefined {
    if (selection.providerAttemptKind !== 'probe' || !selection.registeredPublicAccess
      || !selection.competingStreamAvailable || selection.streamEligible) return undefined;
    return this.attemptOrdinal(selection.target, selection.peerId) === FULL_BUDGET_EVERY - 1
      ? undefined : MIXED_LEGACY_TIMEOUT_MS;
  }

  recordAdmitted(target: VmRecoveryTransportBudgetTarget, peerId: string): void {
    const key = this.key(target, peerId);
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.delete(key);
    this.attempts.set(key, next % FULL_BUDGET_EVERY);
    if (this.attempts.size > this.maxEntries) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
  }

  forgetContextGraph(localCgId: string): void {
    const prefix = `${localCgId}\0`;
    for (const key of this.attempts.keys()) {
      if (key.startsWith(prefix)) this.attempts.delete(key);
    }
  }

  clear(): void {
    this.attempts.clear();
  }

  private key(target: VmRecoveryTransportBudgetTarget, peerId: string): string {
    return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}\0`
      + `${target.ual}\0${target.merkleRoot.toLowerCase()}\0${peerId}`;
  }
}
