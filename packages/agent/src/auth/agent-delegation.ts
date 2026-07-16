import { ethers } from 'ethers';

/**
 * Agent-signed delegation: a credential authorising one or more node
 * identifiers (libp2p peer-id and/or ethereum operational key) to act on
 * an agent's behalf within a named scope, optionally bounded by an
 * expiration timestamp.
 *
 * Conceptually this primitive separates the two layers of V10:
 *   - **Agents** are the principals (humans / AI / users). They own
 *     primary signing keys and authorise things by signing.
 *   - **Nodes** are infrastructure that hosts agents and runs the wire
 *     protocols. A node never *claims* a relationship to an agent;
 *     instead the agent *signs* a delegation that names the node.
 *
 * Scope is opaque to this module — each consumer defines its own scope
 * grammar, e.g. `"sync:cgId"` for sync auth, `"message:from=A1"` for
 * agent-to-agent messaging. The primitive's only job is to bind
 * (agent, delegatee(s), scope, validity) into a verifiable signature.
 *
 * Both delegatee fields are optional individually but at least one
 * MUST be present. Verifiers may then accept either: the operational
 * signer of the eventual carrier message matching `delegateeOpKey`, OR
 * the carrier libp2p peer-id matching `delegateePeerId`. Including both
 * lets the agent recover from rotation of either key without having to
 * re-issue the delegation.
 */

export interface AgentDelegationPayload {
  /** Principal — the agent issuing the delegation. Recovered signer must equal this. */
  agentAddress: string;
  /** Free-form scope string. Per-consumer grammar. */
  scope: string;
  /** Issuance timestamp in milliseconds since epoch. */
  issuedAtMs: number;
  /** Optional expiration in milliseconds since epoch. Omit / zero for non-expiring. */
  expiresAtMs?: number;
  /** libp2p peer-id authorised to act on the agent's behalf within `scope`. */
  delegateePeerId?: string;
  /** Ethereum operational key (address) authorised to sign carrier requests within `scope`. */
  delegateeOpKey?: string;
}

export interface SignedAgentDelegation extends AgentDelegationPayload {
  /** EIP-191 signature over `computeDelegationDigest(payload)` by `agentAddress`. */
  signature: string;
}

/**
 * Canonical digest used for both signing and verification.
 *
 * Uses `AbiCoder.encode` (length-prefixed ABI encoding) rather than
 * `solidityPacked` so adjacent dynamic-string fields can't collide
 * (with packed encoding, moving bytes between e.g. `delegateePeerId`
 * and `delegateeOpKey` would yield the same digest for two different
 * payloads). The version tag is part of the digest so we can extend
 * the schema later via a clean cut without ambiguity.
 *
 * Both delegatee fields are present in the digest as empty strings when
 * absent — this means the same payload always produces the same digest
 * regardless of which delegatee shape was chosen.
 */
export function computeDelegationDigest(payload: AgentDelegationPayload): Uint8Array {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'address', 'string', 'string', 'uint256', 'uint256'],
    [
      'dkg.agent-delegation.v2',
      payload.scope,
      payload.agentAddress.toLowerCase(),
      payload.delegateePeerId ?? '',
      payload.delegateeOpKey ? payload.delegateeOpKey.toLowerCase() : '',
      Math.trunc(payload.issuedAtMs),
      Math.trunc(payload.expiresAtMs ?? 0),
    ],
  );
  return ethers.getBytes(ethers.keccak256(encoded));
}

export interface SignAgentDelegationParams extends AgentDelegationPayload {
  /** Agent's primary private key (hex, 0x-prefixed). Held only by the agent / their daemon. */
  agentPrivateKey: string;
}

/**
 * Sign a delegation with the agent's primary key. Validates that
 * `agentPrivateKey` matches `agentAddress` so callers don't accidentally
 * mint a delegation that's structurally valid but signed by the wrong
 * key (this is a catch-it-at-origin check; verifiers reject the
 * mismatch independently).
 */
export async function signAgentDelegation(params: SignAgentDelegationParams): Promise<SignedAgentDelegation> {
  const { agentPrivateKey, ...payload } = params;
  if (!payload.delegateePeerId && !payload.delegateeOpKey) {
    throw new Error('signAgentDelegation: at least one of delegateePeerId / delegateeOpKey is required');
  }
  if (!payload.scope) {
    throw new Error('signAgentDelegation: scope is required');
  }
  const wallet = new ethers.Wallet(agentPrivateKey);
  if (wallet.address.toLowerCase() !== payload.agentAddress.toLowerCase()) {
    throw new Error(
      `signAgentDelegation: agentPrivateKey does not match agentAddress (key=${wallet.address}, claimed=${payload.agentAddress})`,
    );
  }
  const signature = await wallet.signMessage(computeDelegationDigest(payload));
  return { ...payload, signature };
}

export interface VerifyAgentDelegationOptions {
  /**
   * Expected scope string. If provided, the delegation's scope must match exactly.
   * Pass undefined to accept any scope (e.g. when the verifier is a generic
   * router that does its own scope dispatch downstream).
   */
  expectedScope?: string;
  /** Override "now" for tests. Defaults to `Date.now()`. */
  nowMs?: number;
  /**
   * Allowed clock skew in milliseconds for `issuedAtMs` (i.e. how far in the
   * "future" a delegation is allowed to claim it was issued, to tolerate
   * cross-machine clock drift). Defaults to 5_000ms.
   */
  clockSkewMs?: number;
}

/**
 * Verify a signed delegation's signature, scope, and validity window.
 * Returns the verified payload on success; throws on any failure.
 *
 * What this function checks:
 *   1. Signature recovers to `agentAddress` (the principal).
 *   2. At least one delegatee identifier is present.
 *   3. Scope matches `options.expectedScope` if provided.
 *   4. `issuedAtMs` is not absurdly in the future (clock skew tolerance).
 *   5. `expiresAtMs`, if set and non-zero, is in the future.
 *
 * What this function does NOT check (consumer's responsibility):
 *   - Whether the principal is allowed to act on a particular resource.
 *   - Whether the carrier of the delegation matches one of the delegatees.
 *     (Verifiers should compare `recoveredOperationalSigner` and/or
 *     `transportPeerId` against `delegateeOpKey` / `delegateePeerId`
 *     themselves, since the carrier-binding policy is per-consumer.)
 */
export function verifyAgentDelegation(
  delegation: SignedAgentDelegation,
  options?: VerifyAgentDelegationOptions,
): AgentDelegationPayload {
  if (!delegation.delegateePeerId && !delegation.delegateeOpKey) {
    throw new Error('verifyAgentDelegation: at least one delegatee identifier is required');
  }
  if (!delegation.scope) {
    throw new Error('verifyAgentDelegation: scope is required');
  }
  if (options?.expectedScope !== undefined && delegation.scope !== options.expectedScope) {
    throw new Error(
      `verifyAgentDelegation: scope mismatch (expected "${options.expectedScope}", got "${delegation.scope}")`,
    );
  }

  const now = options?.nowMs ?? Date.now();
  const skew = options?.clockSkewMs ?? 5_000;
  if (delegation.issuedAtMs - now > skew) {
    throw new Error(`verifyAgentDelegation: issuedAtMs is in the future beyond clock-skew tolerance`);
  }
  if (delegation.expiresAtMs && delegation.expiresAtMs > 0 && delegation.expiresAtMs <= now) {
    throw new Error(`verifyAgentDelegation: delegation expired at ${delegation.expiresAtMs} (now=${now})`);
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(computeDelegationDigest(delegation), delegation.signature);
  } catch (err) {
    throw new Error(`verifyAgentDelegation: failed to recover signer (${err instanceof Error ? err.message : String(err)})`);
  }
  if (recovered.toLowerCase() !== delegation.agentAddress.toLowerCase()) {
    throw new Error(
      `verifyAgentDelegation: signer mismatch (recovered ${recovered}, claimed ${delegation.agentAddress})`,
    );
  }

  const { signature: _signature, ...payload } = delegation;
  return payload;
}
