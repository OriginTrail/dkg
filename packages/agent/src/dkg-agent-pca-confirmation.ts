// SPDX-License-Identifier: Apache-2.0

// PCA register-agent confirmation: the advisory outcome model + the bounded-probe
// retry state machine. The DKGAgent facade delegates to
// confirmPcaAgentRegistration; only PcaConfirmationOutcome is public API (via
// src/index.ts) — the helper is package-internal.

/**
 * Outcomes reachable once the probe surface is known to exist — the retry state
 * machine's result. `unsupported` (a static adapter-capability gap) is decided by
 * the facade before the loop, so it is not one of these.
 */
export type ProbedConfirmationOutcome = 'confirmed' | 'not_observed' | 'inconclusive';

/**
 * The advisory outcome of confirming a just-mined PCA agent registration; the
 * receipt is already authoritative for `registered:true`, this only refines the
 * advisory picture:
 *   confirmed    — an on-chain read observed the agent registered.
 *   not_observed — the probe read but did not (yet) observe it (follower-RPC lag).
 *   inconclusive — the probe surface exists but every read threw.
 *   unsupported  — no on-chain probe surface (the chain adapter lacks the read).
 * The daemon/CLI boundary derives the wire { verified, adapterSupported } from it.
 */
export type PcaConfirmationOutcome = ProbedConfirmationOutcome | 'unsupported';

const PCA_CONFIRM_ATTEMPTS = 3;
const PCA_CONFIRM_BACKOFF_MS = 300;

/**
 * Bounded-probe retry state machine. `probe` yields the registration read: true
 * (registered) | false (not yet — retry) | throws (RPC read failure). A
 * definitive not_observed (a false read) is never downgraded by a later throw;
 * only a later true upgrades it to confirmed.
 */
export async function confirmPcaAgentRegistration(
  probe: () => Promise<boolean>,
): Promise<ProbedConfirmationOutcome> {
  let sawNotObserved = false;
  for (let i = 0; i < PCA_CONFIRM_ATTEMPTS; i++) {
    try {
      if (await probe()) return 'confirmed';
      sawNotObserved = true;
    } catch {
      // An RPC read failure does not downgrade a prior not_observed.
    }
    if (i < PCA_CONFIRM_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, PCA_CONFIRM_BACKOFF_MS));
  }
  return sawNotObserved ? 'not_observed' : 'inconclusive';
}
