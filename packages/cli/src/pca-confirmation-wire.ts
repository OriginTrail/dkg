import type { PcaConfirmationOutcome } from '@origintrail-official/dkg-agent';

// #1346 — the daemon/CLI response contract for the register-agent advisory
// confirmation, DERIVED at this boundary from the agent's domain
// `PcaConfirmationOutcome`. The wire representation lives in the CLI layer (not
// the agent facade) — the agent owns chain/domain semantics, this owns one
// route's JSON shape.

/**
 * The WIRE shape of the advisory confirmation. A discriminated union so the
 * illegal `{adapterSupported:false, verified:false|true}` combos stay
 * unrepresentable for wire/client consumers:
 *   - `{ adapterSupported: false; verified: null }` — unsupported (no probe surface).
 *   - `{ adapterSupported: true; verified: boolean | null }` — surface exists;
 *     `verified` is true (confirmed) | false (not observed / lag) | null (inconclusive).
 */
export type PcaAgentConfirmation =
  | { adapterSupported: false; verified: null }
  | { adapterSupported: true; verified: boolean | null };

/** Derive the wire advisory fields from the agent's single confirmation outcome. */
export function pcaConfirmationToWire(outcome: PcaConfirmationOutcome): PcaAgentConfirmation {
  switch (outcome) {
    case 'confirmed':    return { adapterSupported: true, verified: true };
    case 'not_observed': return { adapterSupported: true, verified: false };
    case 'inconclusive': return { adapterSupported: true, verified: null };
    case 'unsupported':  return { adapterSupported: false, verified: null };
  }
}
