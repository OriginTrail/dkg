// SPDX-License-Identifier: Apache-2.0
import type { AuthorAttestationTypedData, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type { PromoteExecutionAuthority } from '@origintrail-official/dkg-publisher';
import type { PreSignedAuthorAttestation } from './dkg-agent-types.js';
import type { FinalizeGuard } from './finalize-guard.js';

export interface AssertionFinalizeOptions {
  guard?: FinalizeGuard;
  subGraphName?: string;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestation;
  authorSignTypedData?: (
    typedData: AuthorAttestationTypedData,
  ) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
  schemeVersion?: number;
}

export interface InternalFinalizeOptions extends AssertionFinalizeOptions {
  executionAuthority?: PromoteExecutionAuthority;
}

export type FinalizeOutcome = 'sealed' | 'already_sealed';
export type WithFinalizeGuard = { guard: FinalizeGuard };
export type WithFinalizeOutcome = { guardedOutcome: FinalizeOutcome };

export interface PublicFinalizeOptions extends AssertionFinalizeOptions {
  agentAddress?: string;
  /** @deprecated SWM is recognized only to return the legacy read-only error. */
  layer?: 'wm' | 'swm';
}

export interface PublicFinalizeResult {
  guardedOutcome?: FinalizeOutcome;
  assertionUri: string;
  merkleRoot: Uint8Array;
  authorAddress: string;
  kaUal: string;
  assertionVersion: string;
  publicTripleCount: number;
  privateTripleCount: number;
  schemeVersion: number;
  chainId: bigint;
  kav10Address: string;
  eip712Digest: string;
}

export interface AssertionFinalizeResult extends PublicFinalizeResult {
  /** Internal lifecycle identity used by seal-in-SWM migration. */
  reservedKaId: bigint;
  /** Internal exact payload boundary used by seal-in-SWM migration. */
  rootEntities: string[];
  contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  privateMerkleRoot?: Uint8Array;
}
