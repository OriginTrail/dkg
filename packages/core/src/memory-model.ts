/**
 * V10 Memory Model Types
 *
 * Formalizes the four-layer memory hierarchy and transition semantics
 * for the DKG V10 protocol.
 *
 * Memory layers (ordered by trust/permanence):
 *   WM  → Working Memory: local agent drafts, not shared
 *   SWM → Shared Working Memory: published to peers, not anchored
 *   LTM → Long-term Memory: anchored on-chain via PUBLISH
 *   VM  → Verified Memory: M-of-N verified via VERIFY
 */

export enum MemoryLayer {
  WorkingMemory = 'WM',
  SharedWorkingMemory = 'SWM',
  LongTermMemory = 'LTM',
  VerifiedMemory = 'VM',
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

export interface DraftDescriptor {
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
 *   working-memory        → WM  (agent's own draft graphs, local-only)
 *   shared-working-memory → SWM (provisional, gossip-replicated)
 *   long-term-memory      → LTM (chain-confirmed, published)
 *   verified-memory       → VM  (M-of-N quorum verified)
 *   authoritative         → LTM ∪ VM (VM wins on conflict)
 */
export type GetView =
  | 'working-memory'
  | 'shared-working-memory'
  | 'long-term-memory'
  | 'verified-memory'
  | 'authoritative';

/**
 * Valid memory layer transitions. The protocol enforces a strict
 * forward-only progression: WM → SWM → LTM → VM.
 */
export const VALID_TRANSITIONS: ReadonlyMap<MemoryLayer, readonly MemoryLayer[]> = new Map([
  [MemoryLayer.WorkingMemory, [MemoryLayer.SharedWorkingMemory] as const],
  [MemoryLayer.SharedWorkingMemory, [MemoryLayer.LongTermMemory] as const],
  [MemoryLayer.LongTermMemory, [MemoryLayer.VerifiedMemory] as const],
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
 * All five GET views, ordered by trust level (ascending).
 */
export const GET_VIEWS: readonly GetView[] = [
  'working-memory', 'shared-working-memory', 'long-term-memory', 'verified-memory', 'authoritative',
] as const;
