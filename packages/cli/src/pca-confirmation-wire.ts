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

type RegisterPcaAgentResponseBase = {
  accountId: string;
  agent: string;
  txHash: string;
  blockNumber: number;
};

/**
 * What the CURRENT daemon EMITS — STRICT. The mined tx is authoritative AND a
 * `success:false` tx is rejected upstream (502), so `registered` is literally
 * `true`, and the advisory is the coherent `PcaAgentConfirmation`. The route
 * helper (`resolveRegisterPcaAgent`) returns this: a future edit that drops the
 * invariant — `registered:false`, or a missing `verified`/`adapterSupported` —
 * fails to compile.
 */
export type RegisterPcaAgentResponse = RegisterPcaAgentResponseBase & { registered: true } & PcaAgentConfirmation;

/** Derive the wire advisory fields from the agent's single confirmation outcome. */
export function pcaConfirmationToWire(outcome: PcaConfirmationOutcome): PcaAgentConfirmation {
  switch (outcome) {
    case 'confirmed':    return { adapterSupported: true, verified: true };
    case 'not_observed': return { adapterSupported: true, verified: false };
    case 'inconclusive': return { adapterSupported: true, verified: null };
    case 'unsupported':  return { adapterSupported: false, verified: null };
  }
}

/** The register-agent advisory confirmation status, for display. `legacy-unverified`
 *  = a pre-#1346 daemon that could not confirm and whose success we cannot assert. */
export type RegisterAgentAdvisoryStatus = 'confirmed' | 'pending' | 'unsupported' | 'legacy-unverified';

/** A register-agent response normalized into a coherent display. */
export type RegisterAgentDisplay = {
  /** Whether the agent is registered. */
  registered: boolean;
  /** The on-chain confirmation status. */
  advisory: RegisterAgentAdvisoryStatus;
};

/**
 * The stable, CLI-facing result of `ApiClient.registerPcaAgent` — the
 * current/legacy version-skew rules are already normalized into
 * `{ registered, advisory }` at the client boundary, so callers render directly
 * without re-deriving the wire shapes.
 */
export type RegisterPcaAgentResult = {
  accountId: string;
  agent: string;
  registered: boolean;
  advisory: RegisterAgentAdvisoryStatus;
  txHash: string;
  blockNumber: number;
};

/**
 * #1346 — decode a register-agent response (current OR pre-#1346 legacy) into one
 * coherent display, so consumers don't each re-derive the wire rules.
 *   - CURRENT daemon (`verified` present): the mined tx is authoritative AND a
 *     failed tx was rejected upstream (502), so `registered:true`. Advisory:
 *     verified===true → confirmed; adapterSupported===false → unsupported; else pending.
 *   - LEGACY daemon (`verified` absent): its `registered` = old (verified===true).
 *     If the old read OBSERVED the agent registered (registered:true +
 *     adapterSupported:true), the tx succeeded → confirmed (registered:true).
 *     Otherwise the old read did not confirm, and a pre-#1346 daemon had NO
 *     `success:false` guard, so we CANNOT assert the tx succeeded — surface
 *     `registered` AS-IS (do NOT force `true`) with `legacy-unverified`, so a
 *     failed/unconfirmed legacy registration is never reported as success.
 */
/**
 * The register-agent fields the decoder needs, kept as strict as the response
 * model: CURRENT (`registered:true` + coherent advisory) OR LEGACY
 * (`registered:boolean`, `verified` absent). Rejects incoherent shapes such as
 * `{ registered:false, verified:true }` that are neither a valid current nor a
 * legacy response.
 */
export type DecodableRegisterAgentResponse =
  | ({ registered: true } & PcaAgentConfirmation)
  | { registered: boolean; adapterSupported: boolean; verified?: undefined };

export function decodeRegisterAgentAdvisory(
  resp: DecodableRegisterAgentResponse,
): RegisterAgentDisplay {
  if (resp.verified !== undefined) {
    const advisory: RegisterAgentAdvisoryStatus =
      resp.verified === true ? 'confirmed'
        : resp.adapterSupported === false ? 'unsupported'
          : 'pending';
    return { registered: true, advisory };
  }
  // Legacy: the old read observed it registered ⇒ the tx succeeded, confirmed.
  if (resp.registered === true && resp.adapterSupported === true) {
    return { registered: true, advisory: 'confirmed' };
  }
  // Legacy: old read did not confirm — cannot assert the tx succeeded.
  return { registered: resp.registered, advisory: 'legacy-unverified' };
}

/**
 * Parse a RAW register-agent JSON response into a stable {@link RegisterPcaAgentResult},
 * VALIDATING the wire shape at the boundary rather than trusting a cast. Throws
 * on a missing/mistyped field or an incoherent advisory (e.g. no probe surface —
 * `adapterSupported:false` — with a non-null `verified`). Accepts the current
 * coherent shape and the legacy shape (`verified` absent).
 */
export function parseRegisterPcaAgentResult(raw: unknown): RegisterPcaAgentResult {
  const reject = (why: string): never => {
    throw new Error(`Malformed register-agent response from daemon: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) return reject('not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.accountId !== 'string') return reject('accountId');
  if (typeof r.agent !== 'string') return reject('agent');
  if (typeof r.txHash !== 'string') return reject('txHash');
  if (typeof r.blockNumber !== 'number') return reject('blockNumber');
  if (typeof r.registered !== 'boolean') return reject('registered');
  if (typeof r.adapterSupported !== 'boolean') return reject('adapterSupported');

  let input: DecodableRegisterAgentResponse;
  if ('verified' in r && r.verified !== undefined) {
    // A valid CURRENT response must have registered:true (the mined-tx invariant;
    // a success:false tx is rejected upstream). A verified-present registered:false
    // is neither a current nor a legacy shape — reject it rather than promoting
    // it to a successful registration.
    if (r.registered !== true) return reject('current response with registered:false');
    if (typeof r.verified !== 'boolean' && r.verified !== null) return reject('verified');
    // No probe surface can only be inconclusive: adapterSupported:false ⟹ verified:null.
    if (r.adapterSupported === false && r.verified !== null) return reject('incoherent verified/adapterSupported');
    // Coherent now — build the exact PcaAgentConfirmation union member (no cast).
    input = r.adapterSupported
      ? { registered: true, adapterSupported: true, verified: r.verified }
      : { registered: true, adapterSupported: false, verified: null };
  } else {
    input = { registered: r.registered, adapterSupported: r.adapterSupported };
  }
  const { registered, advisory } = decodeRegisterAgentAdvisory(input);
  return {
    accountId: r.accountId,
    agent: r.agent,
    registered,
    advisory,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
  };
}
