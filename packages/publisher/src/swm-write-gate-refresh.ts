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
 * The oracle is injected by the agent. It refreshes the graph's metadata from
 * the curator and re-resolves the canonical gate (the chain roster for a
 * registered graph), under admission limits per graph and per sending peer so
 * a peer cannot buy chain reads by rotating signing keys. Its answer separates
 * three cases the projected gate could not tell apart: the fresh gate contains
 * the signer (admitted again against it), the fresh gate excludes the signer
 * (permanent rejection), or no fresh gate could be obtained (a retryable
 * rejection, so the sender's fan-out tries again on its watchdog instead of
 * dropping the share).
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
 * the envelope's signature verified and the peer allowlist admitted the sender,
 * so only an authenticated, peer-admitted sender can make the receiver read;
 * the oracle bounds how often per graph and per peer.
 */
export type SwmAgentGateRefreshOracle = (
  contextGraphId: string,
  signerAddress: string,
  fromPeerId: string,
) => Promise<SwmAgentGateRefreshResult>;

export type AgentEnvelopeRetryVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly retryable: boolean };

export interface RetryAgentEnvelopeInput {
  /** The verdict of the verification against the projected gate. */
  verdict: AgentEnvelopeVerdict;
  oracle: SwmAgentGateRefreshOracle | undefined;
  contextGraphId: string;
  fromPeerId: string;
  /** Whether the graph's peer allowlist admits the sender (a peer it excludes is refused without a read). */
  peerAdmitted: boolean;
  localAgentAddresses: LocalAgentAddressesSource | undefined;
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
}

/**
 * The second look. Only a `gate-miss` verdict from a peer-admitted sender asks
 * the oracle; the signer is then admitted against the fresh gate, with the
 * local-membership check of the first verification.
 */
export async function retryAgentEnvelopeWithRefreshedGate(
  input: RetryAgentEnvelopeInput,
): Promise<AgentEnvelopeRetryVerdict> {
  const { verdict, oracle, contextGraphId, fromPeerId, peerAdmitted, localAgentAddresses, logWarn, logInfo } = input;
  if (verdict.kind === 'verified') return { accepted: true };
  if (verdict.kind === 'invalid' || oracle === undefined || !peerAdmitted) {
    return { accepted: false, retryable: false };
  }
  const signer = ethers.getAddress(verdict.signer);
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
  switch (fresh.kind) {
    case 'unavailable':
      logWarn(
        `SWM write by ${signer} to context graph "${contextGraphId}" ${fresh.retryable ? 'deferred' : 'rejected'}: `
          + `agent gate authority is unavailable (${fresh.reason})`,
      );
      return { accepted: false, retryable: fresh.retryable };
    case 'ungated':
      logWarn(
        `SWM write by ${signer} to context graph "${contextGraphId}" rejected: the refreshed gate has no agent roster`,
      );
      return { accepted: false, retryable: false };
    case 'available': {
      const admitted = await admitAgentSigner({
        signer,
        contextGraphId,
        agentGateAddresses: fresh.agentAddresses,
        requireLocalMembership: true,
        localAgentAddresses,
        logWarn,
      });
      if (admitted.kind !== 'verified') return { accepted: false, retryable: false };
      logInfo(
        `SWM write by ${signer} to context graph "${contextGraphId}" accepted after an agent gate refresh `
          + `(gateCount=${fresh.agentAddresses.length})`,
      );
      return { accepted: true };
    }
  }
}
