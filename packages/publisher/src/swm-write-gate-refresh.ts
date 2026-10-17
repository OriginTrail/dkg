// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

/**
 * Roster admission of an authenticated shared-memory writer, and the second
 * look it gets when the receiver's projected gate did not contain it.
 *
 * The projected gate is the receiver's local view of the roster. For a member
 * it is the curator's metadata as of its last refresh, so a writer approved
 * after that refresh is absent from it until the next one lands, and that one
 * can lag or fail while the writer's first share is already in flight.
 * Rejecting on the stale view alone was a permanent rejection: the sender's
 * fan-out never retried and the write was lost. The sync-authorization path
 * already refreshes the metadata and re-reads its gate on the same miss; this
 * module gives the write path the same second look.
 *
 * The oracle is injected by the agent. It reads the canonical gate fresh (the
 * chain roster for a registered graph, after a curator metadata refresh where
 * the gate rests on local metadata), rationed per graph and per sending peer
 * so a peer cannot buy chain reads by rotating signing keys. Nothing of its
 * answer is cached or shared: every miss that the ration admits is judged from
 * a read of its own. The whole admission is then re-run on that fresh answer:
 * an explicit local revocation stands, the signer must be in the fresh gate,
 * the local node must hold an agent of it, and the sender must pass the peer
 * allowlist of the metadata the refresh may have installed. An authority that
 * could not be read is a retryable rejection, so the sender's fan-out tries
 * again on its watchdog instead of dropping the share.
 */

/**
 * One envelope verification. `invalid` is anything a fresh gate cannot change
 * (shape, freshness, signature, claimed/recovered mismatch, local membership);
 * `gate-miss` is the one verdict that may: an authenticated signer the gate
 * did not contain.
 */
export type AgentEnvelopeVerdict =
  | { readonly kind: 'verified' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'gate-miss'; readonly signer: string };

export const AGENT_ENVELOPE_VERIFIED: AgentEnvelopeVerdict = Object.freeze({ kind: 'verified' });
export const AGENT_ENVELOPE_INVALID: AgentEnvelopeVerdict = Object.freeze({ kind: 'invalid' });

export type LocalAgentAddressesSource = () => readonly string[] | Promise<readonly string[]>;

export interface AdmitAgentSignerInput {
  /** The recovered signer, already proven equal to the envelope's claimed agent. */
  signer: string;
  contextGraphId: string;
  agentGateAddresses: readonly string[];
  /** Whether the local node itself must hold an agent of the gate (false for host-mode ingest). */
  requireLocalMembership: boolean;
  localAgentAddresses: LocalAgentAddressesSource | undefined;
  logWarn: (message: string) => void;
}

/** Roster admission of an authenticated signer: the gate, then the local node's own membership. */
export async function admitAgentSigner(input: AdmitAgentSignerInput): Promise<AgentEnvelopeVerdict> {
  const { signer, contextGraphId, agentGateAddresses, requireLocalMembership, localAgentAddresses, logWarn } = input;
  const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
  if (!agentGateSet.has(signer.toLowerCase())) {
    logWarn(`SWM write rejected: agent ${signer} is not allowed for context graph "${contextGraphId}"`);
    return { kind: 'gate-miss', signer };
  }
  if (requireLocalMembership && localAgentAddresses !== undefined) {
    const localAgents = await localAgentAddresses();
    if (!localAgents.some((agent) => agentGateSet.has(agent.toLowerCase()))) {
      logWarn(`SWM write rejected: local node has no allowed agent for context graph "${contextGraphId}"`);
      return AGENT_ENVELOPE_INVALID;
    }
  }
  return AGENT_ENVELOPE_VERIFIED;
}

export type SwmAgentGateRefreshResult =
  | { readonly kind: 'available'; readonly agentAddresses: readonly string[] }
  | { readonly kind: 'ungated' }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      /** Whether the authority can heal on its own, so the sender may retry. */
      readonly retryable: boolean;
    };

/**
 * Fresh agent gate for one authenticated signer the projected gate lacked,
 * sent by `fromPeerId`. Called at most once per rejected envelope, only after
 * the envelope's signature verified, the signer was found not to be revoked
 * locally and the peer allowlist admitted the sender, so only such a sender
 * can make the receiver read; the oracle bounds how often per graph and peer.
 */
export type SwmAgentGateRefreshOracle = (
  contextGraphId: string,
  signerAddress: string,
  fromPeerId: string,
) => Promise<SwmAgentGateRefreshResult>;

export type AgentEnvelopeRetryVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly retryable: boolean };

/** The local metadata facts the admission re-runs after a refresh, from one projected read. */
export interface AdmissionMetadata {
  /** Explicitly revoked agents, lowercased. */
  readonly revokedAgents: ReadonlySet<string>;
  /** The peer allowlist (null: no allowlist). */
  readonly allowedPeers: readonly string[] | null;
}

export interface RetryAgentEnvelopeInput {
  /** The verdict of the verification against the projected gate. */
  verdict: AgentEnvelopeVerdict;
  oracle: SwmAgentGateRefreshOracle | undefined;
  contextGraphId: string;
  fromPeerId: string;
  /** Host catch-up replay: the relaying host need not be in the peer allowlist. */
  trustedReplay: boolean;
  /** The peer allowlist the envelope was first judged by (null: no allowlist). */
  allowedPeers: readonly string[] | null;
  localAgentAddresses: LocalAgentAddressesSource | undefined;
  /** Explicitly revoked agents, lowercased, from the snapshot the envelope was first judged by. */
  revokedAgents: ReadonlySet<string>;
  /** The metadata as it is after the look, from one fresh projected read. */
  readRefreshedMetadata: () => Promise<AdmissionMetadata>;
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
}

const PERMANENT: AgentEnvelopeRetryVerdict = Object.freeze({ accepted: false, retryable: false });

/**
 * The second look, owning everything from the gate miss to the final
 * admission. Only a `gate-miss` verdict from a sender the peer allowlist admits
 * asks the oracle, and never for a signer the local metadata explicitly
 * revoked; the fresh gate then admits the signer under the same checks as the
 * first verification, plus the peer allowlist of the current metadata.
 */
export async function retryAgentEnvelopeWithRefreshedGate(
  input: RetryAgentEnvelopeInput,
): Promise<AgentEnvelopeRetryVerdict> {
  const {
    verdict, oracle, contextGraphId, fromPeerId, trustedReplay, allowedPeers,
    localAgentAddresses, revokedAgents, readRefreshedMetadata, logWarn, logInfo,
  } = input;
  if (verdict.kind === 'verified') return { accepted: true };
  if (verdict.kind === 'invalid' || oracle === undefined) return PERMANENT;
  const peerAdmits = (peers: readonly string[] | null): boolean =>
    trustedReplay || peers === null || peers.includes(fromPeerId);
  if (!peerAdmits(allowedPeers)) return PERMANENT;
  const signer = ethers.getAddress(verdict.signer);
  const signerKey = signer.toLowerCase();
  // A signer the local metadata explicitly revoked is not a signer the
  // metadata has not heard of: no authority read can lift a tombstone.
  if (revokedAgents.has(signerKey)) {
    logWarn(`SWM write by ${signer} to context graph "${contextGraphId}" rejected: the agent is revoked locally`);
    return PERMANENT;
  }

  let fresh: SwmAgentGateRefreshResult;
  try {
    fresh = await oracle(contextGraphId, signer, fromPeerId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(
      `SWM write by ${signer} to context graph "${contextGraphId}" deferred: agent gate refresh failed (${detail})`,
    );
    return { accepted: false, retryable: true };
  }
  if (fresh.kind === 'unavailable') {
    logWarn(
      `SWM write by ${signer} to context graph "${contextGraphId}" ${fresh.retryable ? 'deferred' : 'rejected'}: `
        + `agent gate authority is unavailable (${fresh.reason})`,
    );
    return { accepted: false, retryable: fresh.retryable };
  }
  if (fresh.kind === 'ungated') {
    logWarn(
      `SWM write by ${signer} to context graph "${contextGraphId}" rejected: the refreshed gate has no agent roster`,
    );
    return PERMANENT;
  }

  // The look may have installed new metadata: every local check is re-run on
  // the metadata as it is now, not on the snapshot the envelope was first judged
  // by. Local tombstones are subtracted from the fresh roster before admission,
  // as the projected gate subtracts them, so a revoked signer and a receiver
  // whose only agent is revoked are both refused whatever the authority lists.
  const refreshed = await readRefreshedMetadata();
  const admitted = await admitAgentSigner({
    signer,
    contextGraphId,
    agentGateAddresses: fresh.agentAddresses.filter((agent) => !refreshed.revokedAgents.has(agent.toLowerCase())),
    requireLocalMembership: true,
    localAgentAddresses,
    logWarn,
  });
  if (admitted.kind !== 'verified') return PERMANENT;
  if (!peerAdmits(refreshed.allowedPeers)) {
    logWarn(
      `SWM write by ${signer} to context graph "${contextGraphId}" rejected: `
        + `peer "${fromPeerId}" is not in the refreshed peer allowlist`,
    );
    return PERMANENT;
  }
  logInfo(
    `SWM write by ${signer} to context graph "${contextGraphId}" accepted after an agent gate refresh `
      + `(gateCount=${fresh.agentAddresses.length})`,
  );
  return { accepted: true };
}
