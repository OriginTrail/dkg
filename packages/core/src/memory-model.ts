/**
 * V10 Memory Model Types
 *
 * Formalizes the three-layer memory hierarchy and transition semantics
 * for the DKG V10 protocol.
 *
 * Memory layers (ordered by trust/permanence):
 *   WM  → Working Memory: local agent assertions, not shared
 *   SWM → Shared Working Memory: published to peers, not anchored
 *   VM  → Verified Memory: anchored on-chain and M-of-N verified
 */

export enum MemoryLayer {
  WorkingMemory = 'WM',
  SharedWorkingMemory = 'SWM',
  VerifiedMemory = 'VM',
}

/**
 * Trust levels for Verified Memory triples, ordered by ascending trust.
 * Used with `minTrust` on verified-memory queries to filter results.
 */
export enum TrustLevel {
  SelfAttested = 0,
  Endorsed = 1,
  PartiallyVerified = 2,
  ConsensusVerified = 3,
}

export enum TransitionType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
}

export interface MemoryTransition {
  from: MemoryLayer;
  to: MemoryLayer;
  type: TransitionType;
  contextGraphId: string;
  agentAddress: string;
  timestamp: string;
}

export interface AssertionDescriptor {
  contextGraphId: string;
  agentAddress: string;
  name: string;
  createdAt: string;
}


export interface ShareRecord {
  contextGraphId: string;
  agentAddress: string;
  operationId: string;
  entities: string[];
  tripleCount: number;
  timestamp: string;
}

export interface PublicationRequest {
  contextGraphId: string;
  triples?: Array<{ subject: string; predicate: string; object: string; graph?: string }>;
  constructQuery?: string;
  transitionType: TransitionType;
  authority: {
    type: 'owner' | 'multisig' | 'quorum' | 'capability';
    proofRef: string;
  };
  swmOperationId?: string;
  priorVersion?: string;
  convictionAccountId?: number;
  namespace?: string;
}

export type PublicationState =
  | 'accepted'
  | 'claimed'
  | 'validated'
  | 'broadcast'
  | 'included'
  | 'finalized'
  | 'failed';

export interface Publication {
  publicationId: string;
  request: PublicationRequest;
  status: PublicationState;
  createdAt: string;
  updatedAt: string;
  claim?: { walletId: string; claimedAt: string };
  validation?: { tripleCount: number; merkleRoot: string; validatedAt: string };
  broadcast?: { txHash: string; broadcastAt: string };
  inclusion?: { blockNumber: number; blockTimestamp: string; includedAt: string };
  finalization?: { ual: string; batchId: string; finalizedAt: string };
  failure?: {
    failedFromState: PublicationState;
    phase: 'validation' | 'broadcast' | 'confirmation' | 'recovery';
    code: string;
    message: string;
    retryable: boolean;
    failedAt: string;
  };
}

/**
 * V10 GET view selectors — each declares which memory layer(s) a query targets.
 *
 *   working-memory        → WM  (agent's own assertion graphs, local-only)
 *   shared-working-memory → SWM (provisional, gossip-replicated)
 *   verified-memory       → VM  (on-chain anchored, M-of-N quorum verified)
 */
export type GetView =
  | 'working-memory'
  | 'shared-working-memory'
  | 'verified-memory';

/** @deprecated Legacy V9 views removed in V10. Listed here for migration error messages. */
export const REMOVED_VIEWS: readonly string[] = ['long-term-memory', 'authoritative'] as const;

/**
 * Valid memory layer transitions. The protocol enforces a strict
 * forward-only progression: WM → SWM → VM.
 */
export const VALID_TRANSITIONS: ReadonlyMap<MemoryLayer, readonly MemoryLayer[]> = new Map([
  [MemoryLayer.WorkingMemory, [MemoryLayer.SharedWorkingMemory] as const],
  [MemoryLayer.SharedWorkingMemory, [MemoryLayer.VerifiedMemory] as const],
]);

export function isValidTransition(from: MemoryLayer, to: MemoryLayer): boolean {
  return VALID_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/**
 * All seven valid publication states, ordered by pipeline progression.
 */
export const PUBLICATION_STATES: readonly PublicationState[] = [
  'accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized', 'failed',
] as const;

/**
 * All three GET views, ordered by trust level (ascending).
 */
export const GET_VIEWS: readonly GetView[] = [
  'working-memory', 'shared-working-memory', 'verified-memory',
] as const;
