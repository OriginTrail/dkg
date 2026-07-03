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

/**
 * The advisory portion of a register-agent response on the wire: a CURRENT
 * coherent `PcaAgentConfirmation`, or the pre-#1346 legacy shape
 * (`adapterSupported` present, `verified` absent — the old route emitted
 * `adapterSupported: verified !== null` with no `verified` field). This is the
 * CONSUMER-side tolerance (decoder / client), NOT what a current daemon emits.
 */
export type RegisterPcaAgentAdvisory =
  | PcaAgentConfirmation
  | { adapterSupported: boolean; verified?: undefined };

type RegisterPcaAgentResponseBase = {
  accountId: string;
  agent: string;
  registered: boolean;
  txHash: string;
  blockNumber: number;
};

/**
 * What the CURRENT daemon EMITS — STRICT: the coherent `PcaAgentConfirmation`
 * advisory is required. The daemon route (`registerPcaAgentResponse`) returns
 * this, so a future edit that drops `verified`/`adapterSupported` fails to
 * compile — the producer keeps type pressure to emit the coherent wire shape.
 */
export type RegisterPcaAgentResponse = RegisterPcaAgentResponseBase & PcaAgentConfirmation;

/** The pre-#1346 legacy wire shape (adapterSupported present, verified absent). */
export type LegacyRegisterPcaAgentResponse = RegisterPcaAgentResponseBase & {
  adapterSupported: boolean;
  verified?: undefined;
};

/**
 * What a CLIENT must TOLERATE under CLI/daemon version skew — current OR legacy.
 * `ApiClient.registerPcaAgent` returns this wider union; the strict
 * `RegisterPcaAgentResponse` stays the producer's contract.
 */
export type AnyRegisterPcaAgentResponse = RegisterPcaAgentResponse | LegacyRegisterPcaAgentResponse;

/** Derive the wire advisory fields from the agent's single confirmation outcome. */
export function pcaConfirmationToWire(outcome: PcaConfirmationOutcome): PcaAgentConfirmation {
  switch (outcome) {
    case 'confirmed':    return { adapterSupported: true, verified: true };
    case 'not_observed': return { adapterSupported: true, verified: false };
    case 'inconclusive': return { adapterSupported: true, verified: null };
    case 'unsupported':  return { adapterSupported: false, verified: null };
  }
}

/** The register-agent advisory confirmation status, for display. */
export type RegisterAgentAdvisoryStatus = 'confirmed' | 'pending' | 'unsupported';

/** A register-agent response normalized into a coherent display. */
export type RegisterAgentDisplay = {
  /** Whether the agent is registered — driven by the MINED-TX authority. */
  registered: boolean;
  /** The on-chain confirmation status. */
  advisory: RegisterAgentAdvisoryStatus;
};

/**
 * #1346 — decode a register-agent response (current OR pre-#1346 legacy wire
 * shape) into ONE coherent display, so consumers don't each re-derive the wire
 * rules — especially under CLI/daemon version skew. A returned (non-error)
 * response means the register tx MINED, so the agent IS registered; that is the
 * authoritative signal for `registered`. Advisory decoding:
 *   - current daemon: `verified` present — true → confirmed; false/null → pending;
 *     adapterSupported:false → unsupported.
 *   - pre-#1346 legacy daemon: `verified` ABSENT. Its own `registered` field was
 *     the OLD probe-derived confirmation (registered = verified===true), NOT the
 *     mined-tx authority — so it is NOT echoed as final (echoing a legacy
 *     `registered:false` alongside "authoritative via the mined tx" is the
 *     contradiction this fixes). Legacy `registered:true` + adapterSupported:true
 *     → confirmed; adapterSupported:false → unsupported; else pending.
 */
export function decodeRegisterAgentAdvisory(
  resp: { registered: boolean } & RegisterPcaAgentAdvisory,
): RegisterAgentDisplay {
  const legacy = resp.verified === undefined;
  // A successful response = the register tx mined = the agent is registered.
  const registered = legacy ? true : resp.registered;
  let advisory: RegisterAgentAdvisoryStatus;
  if (resp.verified === true || (legacy && resp.registered === true && resp.adapterSupported === true)) {
    advisory = 'confirmed';
  } else if (resp.adapterSupported === false) {
    advisory = 'unsupported';
  } else {
    advisory = 'pending';
  }
  return { registered, advisory };
}
