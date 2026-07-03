// SPDX-License-Identifier: Apache-2.0

// PCA register-agent confirmation outcome model. The bounded-probe retry state
// machine + the facade live in dkg-agent-registry.ts (the retry loop is a
// module-private facade detail); this module is the public home for the outcome
// type, re-exported via src/index.ts.

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
