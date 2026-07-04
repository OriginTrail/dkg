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
type PcaAgentConfirmation =
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
 * `true`, and the advisory is the coherent `PcaAgentConfirmation`. The
 * register-agent route assembles this: a future edit that drops the invariant —
 * `registered:false`, or a missing `verified`/`adapterSupported` — fails to
 * compile.
 */
export type RegisterPcaAgentResponse = RegisterPcaAgentResponseBase & { registered: true } & PcaAgentConfirmation;

/** Derive the wire advisory fields from the agent's single confirmation outcome.
 *  The `never` default makes this compiler-exhaustive: a future
 *  `PcaConfirmationOutcome` member must add a case here (compile error otherwise)
 *  rather than falling through to an undefined wire shape. */
export function pcaConfirmationToWire(outcome: PcaConfirmationOutcome): PcaAgentConfirmation {
  switch (outcome) {
    case 'confirmed':    return { adapterSupported: true, verified: true };
    case 'not_observed': return { adapterSupported: true, verified: false };
    case 'inconclusive': return { adapterSupported: true, verified: null };
    case 'unsupported':  return { adapterSupported: false, verified: null };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** The register-agent advisory confirmation status, for display. `legacy-unverified`
 *  = a pre-#1346 daemon that could not confirm and whose success we cannot assert. */
export type RegisterAgentAdvisoryStatus = 'confirmed' | 'pending' | 'unsupported' | 'legacy-unverified';

/**
 * The stable, CLI-facing result of `ApiClient.registerPcaAgent` — the
 * current/legacy version-skew rules are normalized into `{ registered, advisory }`
 * at the client boundary, so callers render directly without re-deriving the
 * wire shapes.
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

  let registered: boolean;
  let advisory: RegisterAgentAdvisoryStatus;
  if ('verified' in r && r.verified !== undefined) {
    // CURRENT daemon. A valid current response has registered:true (the mined-tx
    // invariant; a success:false tx is rejected upstream). A verified-present
    // registered:false is neither a current nor a legacy shape — reject it rather
    // than promoting it to a successful registration.
    if (r.registered !== true) return reject('current response with registered:false');
    if (typeof r.verified !== 'boolean' && r.verified !== null) return reject('verified');
    // No probe surface can only be inconclusive: adapterSupported:false ⟹ verified:null.
    if (r.adapterSupported === false && r.verified !== null) return reject('incoherent verified/adapterSupported');
    registered = true;
    advisory = r.verified === true ? 'confirmed' : r.adapterSupported === false ? 'unsupported' : 'pending';
  } else {
    // LEGACY daemon (verified absent). If the old read OBSERVED it registered
    // (registered:true + adapterSupported:true) the tx succeeded → confirmed.
    // Otherwise a pre-#1346 daemon had no success:false guard, so we cannot
    // assert the tx succeeded — surface `registered` AS-IS (never force true)
    // with legacy-unverified, so a failed/unconfirmed legacy registration is
    // never reported as success.
    if (r.registered === true && r.adapterSupported === true) {
      registered = true;
      advisory = 'confirmed';
    } else {
      registered = r.registered;
      advisory = 'legacy-unverified';
    }
  }
  return {
    accountId: r.accountId,
    agent: r.agent,
    registered,
    advisory,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
  };
}
