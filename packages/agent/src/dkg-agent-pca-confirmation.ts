// SPDX-License-Identifier: Apache-2.0

// #1346 — PCA register-agent confirmation: the advisory outcome model + the
// bounded-probe state machine, in a focused module (extracted from the
// dkg-agent-registry catch-all). The DKGAgent facade
// (`confirmPublishingConvictionAgentRegistration`) is a thin delegate over
// `confirmPcaAgentRegistration`; only `PcaConfirmationOutcome` is re-exported as
// public API through `src/index.ts` — `confirmPcaAgentRegistration` is
// package-internal (imported by the facade, not exported from the index).

/**
 * The advisory outcome of confirming a just-mined PCA agent registration, as a
 * SINGLE discriminant (no coupled boolean/null fields to keep in lock-step).
 * The mined receipt is already authoritative for `registered:true`; this only
 * refines the ADVISORY picture:
 *   - `confirmed`    — an on-chain read observed the agent registered.
 *   - `not_observed` — the probe read but did not (yet) observe it (follower-RPC lag).
 *   - `inconclusive` — the probe surface exists but every read threw.
 *   - `unsupported`  — no on-chain probe surface (the chain adapter lacks the read).
 * This is the agent's DOMAIN result; the daemon/CLI boundary derives the wire
 * `{ verified, adapterSupported }` from it (see the cli `pca-confirmation-wire`
 * module) — the wire representation deliberately does not live in the agent.
 */
export type PcaConfirmationOutcome = 'confirmed' | 'not_observed' | 'inconclusive' | 'unsupported';

// Production confirmation policy: a bounded post-mine probe. Fixed domain
// constants, NOT caller-tunable knobs (implementation detail of the advisory
// read, never a public facade option).
const PCA_CONFIRM_ATTEMPTS = 3;
const PCA_CONFIRM_BACKOFF_MS = 300;

/**
 * Advisory-confirmation state machine. `probe` yields the typed registration
 * read: `true` (registered) | `false` (not yet — follower-RPC lag → retry) |
 * `null` (no probe surface → `unsupported`, short-circuit). `null` is a
 * per-adapter-STABLE capability signal (the facade returns it iff the chain
 * method is absent), so it legitimately halts regardless of earlier reads.
 *
 * A definitive `not_observed` (`false`) is NEVER downgraded by a later throw:
 * once the surface has reported not-yet-registered, an RPC blip on a subsequent
 * attempt leaves the outcome `not_observed` (not `inconclusive`) — only a later
 * `true` upgrades it to `confirmed`. The retry policy is a fixed internal
 * constant (no caller-tunable knobs). The full matrix is exercised through the
 * facade in pca-v10-facade.test.ts.
 */
export async function confirmPcaAgentRegistration(
  probe: () => Promise<boolean | null>,
): Promise<PcaConfirmationOutcome> {
  let sawNotObserved = false; // a read returned `false` at least once
  for (let i = 0; i < PCA_CONFIRM_ATTEMPTS; i++) {
    try {
      const result = await probe();
      if (result === null) return 'unsupported'; // no probe surface — short-circuit
      if (result === true) return 'confirmed';
      sawNotObserved = true; // a definitive `false` read (follower-RPC lag) — retry
    } catch {
      // The read surface exists; a throw is an RPC read failure, not a gap, and
      // does NOT downgrade a prior definitive `not_observed`.
    }
    if (i < PCA_CONFIRM_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, PCA_CONFIRM_BACKOFF_MS));
  }
  return sawNotObserved ? 'not_observed' : 'inconclusive';
}
