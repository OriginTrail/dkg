import type { SharedModelInvokeResponse } from './types.js';

export interface AuthorizationInputs {
  /** Per-CG grant is enabled in `_meta`. */
  enabled: boolean;
  /** This node has a usable provider AND the master switch is on. */
  providerConfigured: boolean;
  /** Requester is a member of the CG. */
  isMember: boolean;
  /** Requester is under their daily quota. */
  quotaOk: boolean;
  /** Prompt is within the curator's size cap. */
  promptOk: boolean;
}

/**
 * Pure authorization decision, shared by the live P2P handler and the unit
 * tests. Order is deliberate: configuration/grant problems first (so an
 * operator sees a clear reason), then membership, then abuse limits.
 */
export function decideSharedModelAuthorization(
  i: AuthorizationInputs,
): { ok: true } | { ok: false; denied: string } {
  if (!i.providerConfigured) return { ok: false, denied: 'curator node has no shared model configured' };
  if (!i.enabled) return { ok: false, denied: 'model sharing is not enabled for this context graph' };
  if (!i.isMember) return { ok: false, denied: 'requester is not a member of this context graph' };
  if (!i.promptOk) return { ok: false, denied: 'prompt exceeds the curator size limit' };
  if (!i.quotaOk) return { ok: false, denied: 'daily request quota exceeded for this member' };
  return { ok: true };
}

export function deniedResponse(reason: string): SharedModelInvokeResponse {
  return { ok: false, denied: reason };
}
