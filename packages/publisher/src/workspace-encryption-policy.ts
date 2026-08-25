/**
 * The SWM encryption policy for one context graph, as a single pure decision.
 * This module is the CANONICAL home of the must-vs-may rationale; call sites
 * keep only the sequencing notes that affect their local code.
 *
 * Two DIFFERENT questions, and conflating them turns a public+agent-gated CG
 * into a permanent failure in whichever direction the local chain probe happens
 * to disagree with the sender's:
 *
 *   requiresEncryptedPayload  MUST it be encrypted?  policy, chain-derived
 *   supportsEncryptedPayload  MAY it be encrypted?   structure, local
 *
 * A public CG's allowlist governs PUBLISH AUTHORITY, not READ ACCESS, so a CG
 * proven public on-chain stops REQUIRING encryption — but an agent-gated CG must
 * still ACCEPT it, because a sender whose chain probe failed will fail closed
 * and encrypt. The two probes legitimately diverge during an RPC flake, a stale
 * mapping, rollout skew, or an older client; admitting both encodings during
 * any skew window is what makes those survivable instead of silently dropped.
 * Structural fact (is this CG gated at all?) governs what is ACCEPTABLE;
 * chain-proven policy governs only what is REQUIRED — hence the invariant that
 * a CG never REQUIRES encryption without also SUPPORTING it.
 *
 * `provenPublicOnChain` must be true ONLY on a live public proof. An absent
 * oracle, `false`, or a thrown lookup all mean "not proven public" and keep the
 * encryption requirement — the same fail-closed discipline the sender uses
 * (`resolveWorkspaceRecipientsGated`), so a stale mapping or an RPC flake can
 * never become a plaintext-acceptance hole. The field is consumed exclusively
 * behind `isAgentGated`, so callers may (and the handler does) skip the chain
 * probe entirely for ungated CGs.
 */

export interface WorkspaceEncryptionPolicyInput {
  readonly hasPrivateAccessPolicy: boolean;
  readonly agentGateAddresses: readonly string[] | null;
  readonly provenPublicOnChain: boolean;
}

export interface WorkspaceEncryptionRequirement {
  requiresEncryptedPayload: boolean;
  supportsEncryptedPayload: boolean;
}

export function resolveWorkspaceEncryptionRequirement(
  params: WorkspaceEncryptionPolicyInput,
): WorkspaceEncryptionRequirement {
  const isAgentGated = params.agentGateAddresses !== null;
  const gateRequiresEncryption = isAgentGated && !params.provenPublicOnChain;
  return {
    requiresEncryptedPayload: params.hasPrivateAccessPolicy || gateRequiresEncryption,
    supportsEncryptedPayload: params.hasPrivateAccessPolicy || isAgentGated,
  };
}
