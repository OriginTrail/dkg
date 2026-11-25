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

export interface AssertionFinalizeResult {
  guardedOutcome?: 'sealed' | 'already_sealed';
  assertionUri: string;
  merkleRoot: Uint8Array;
  authorAddress: string;
  /** Internal lifecycle identity used by seal-in-SWM migration. */
  reservedKaId: bigint;
  /** Internal exact payload boundary used by seal-in-SWM migration. */
  rootEntities: string[];
  contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  kaUal: string;
  assertionVersion: string;
  publicTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount: number;
  schemeVersion: number;
  chainId: bigint;
  kav10Address: string;
  eip712Digest: string;
}

export type PublicFinalizeResult = Omit<AssertionFinalizeResult, 'reservedKaId' | 'rootEntities' | 'contentScopeVersion' | 'privateMerkleRoot'>;
