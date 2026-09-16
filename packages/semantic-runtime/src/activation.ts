import { createHash } from 'node:crypto';

import {
  SemanticRuntimeStore,
  type ExecutionRecord,
  type StrategyArtifactRecord,
} from './persistence.js';
import type { AdmittedPlanSummary } from './codec.js';

export interface TriggerCandidate {
  triggerId: string;
  triggerType: string;
  triggerDigest: string;
  strategyId: string;
  strategyVersion: string;
  graphRevision: string;
  policyEpoch: bigint;
  activationPrincipal: string;
  eventTime: number;
}

export interface StrategyActivationMetadata {
  strategyId: string;
  version: string;
  strategyType: string;
  artifactHash: string;
  authorPrincipal: string;
  authorKeyId: string;
  signature: Uint8Array;
  reviewState: 'draft' | 'reviewed' | 'approved' | 'revoked';
  activationScope: string;
  declaredEffects: string[];
  requiredCapabilities: string[];
}

export interface StrategyMetadataLookup {
  resolve(candidate: Readonly<TriggerCandidate>): Promise<StrategyActivationMetadata | null>;
}

export interface ImmutableStrategyArtifactProvider {
  get(artifactHash: string): Promise<{
    canonicalPlan: Uint8Array;
    sourceRef: string;
    createdAt: number;
  } | null>;
}

export interface StrategySignatureVerifier {
  verify(input: {
    artifactHash: string;
    signature: Uint8Array;
    authorPrincipal: string;
    authorKeyId: string;
  }): Promise<boolean>;
}

export interface StrategyPlanAdmission {
  admitPlan(canonicalPlan: Uint8Array): Promise<AdmittedPlanSummary>;
}

export interface TrustedActivationPolicy {
  allowedStrategyTypes: ReadonlySet<string>;
  allowedStrategyIds: ReadonlySet<string>;
  trustedAuthors: ReadonlySet<string>;
  requiredReviewState: 'reviewed' | 'approved';
  currentPolicyEpoch(): bigint;
  acceptsScope(scope: string, candidate: Readonly<TriggerCandidate>): boolean;
}

export interface ActivationResult {
  execution: ExecutionRecord;
  metadata: StrategyActivationMetadata;
  artifact: StrategyArtifactRecord;
}

export class TrustedStrategyActivationService {
  constructor(
    private readonly store: SemanticRuntimeStore,
    private readonly metadata: StrategyMetadataLookup,
    private readonly artifacts: ImmutableStrategyArtifactProvider,
    private readonly signatures: StrategySignatureVerifier,
    private readonly admission: StrategyPlanAdmission,
    private readonly policy: TrustedActivationPolicy,
  ) {}

  async activate(candidate: TriggerCandidate): Promise<ActivationResult> {
    validateCandidate(candidate);
    if (candidate.policyEpoch !== this.policy.currentPolicyEpoch()) {
      throw new Error('trigger candidate policy epoch is stale');
    }
    const metadata = await this.metadata.resolve(Object.freeze({ ...candidate }));
    if (!metadata) throw new Error('strategy metadata was not found for trigger candidate');
    this.validateMetadata(candidate, metadata);
    const artifactContent = await this.artifacts.get(metadata.artifactHash);
    if (!artifactContent) throw new Error('immutable strategy artifact was not found locally');
    const artifactHash = hashCanonicalPlan(artifactContent.canonicalPlan);
    if (artifactHash !== metadata.artifactHash) {
      throw new Error('strategy artifact bytes do not match graph-pinned hash');
    }
    if (!await this.signatures.verify({
      artifactHash,
      signature: metadata.signature,
      authorPrincipal: metadata.authorPrincipal,
      authorKeyId: metadata.authorKeyId,
    })) {
      throw new Error('strategy artifact signature is invalid or untrusted');
    }
    const admitted = await this.admission.admitPlan(artifactContent.canonicalPlan);
    if (
      Buffer.from(admitted.canonicalHash).toString('hex') !== artifactHash
      || admitted.strategyRef !== `${metadata.strategyId}@${metadata.version}`
      || admitted.scope !== metadata.activationScope
      || !sameStrings(admitted.effectUpperBound, metadata.declaredEffects)
      || !sameStrings(admitted.requiredCapabilities, metadata.requiredCapabilities)
    ) {
      throw new Error('graph strategy metadata does not match Wasm-admitted plan semantics');
    }
    const artifact: StrategyArtifactRecord = {
      artifactHash,
      strategyId: metadata.strategyId,
      version: metadata.version,
      canonicalPlan: Uint8Array.from(artifactContent.canonicalPlan),
      sourceRef: artifactContent.sourceRef,
      signature: Uint8Array.from(metadata.signature),
      reviewState: metadata.reviewState,
      createdAt: artifactContent.createdAt,
    };
    this.store.registerStrategyArtifact(artifact);
    const executionId = activationExecutionId(candidate, artifactHash);
    const existing = this.store.execution(executionId);
    if (!existing) {
      this.store.createExecution({
        executionId,
        planId: artifactHash,
        partitionId: partitionId(candidate.graphRevision, candidate.policyEpoch),
        status: 'active',
        graphRevision: candidate.graphRevision,
        policyEpoch: candidate.policyEpoch,
        rootProcessId: rootProcessId(executionId),
        leaseEpoch: 0n,
      });
    }
    const execution = this.store.execution(executionId);
    if (!execution) throw new Error('trusted activation intent did not persist');
    return { execution, metadata, artifact };
  }

  private validateMetadata(
    candidate: TriggerCandidate,
    metadata: StrategyActivationMetadata,
  ): void {
    if (
      metadata.strategyId !== candidate.strategyId
      || metadata.version !== candidate.strategyVersion
      || !this.policy.allowedStrategyTypes.has(metadata.strategyType)
      || !this.policy.allowedStrategyIds.has(metadata.strategyId)
      || !this.policy.trustedAuthors.has(metadata.authorPrincipal)
      || !this.policy.acceptsScope(metadata.activationScope, candidate)
    ) {
      throw new Error('strategy metadata is outside trusted activation policy');
    }
    if (
      metadata.reviewState === 'revoked'
      || metadata.reviewState === 'draft'
      || (this.policy.requiredReviewState === 'approved' && metadata.reviewState !== 'approved')
    ) {
      throw new Error('strategy review state is insufficient for activation');
    }
    if (!/^[0-9a-f]{64}$/.test(metadata.artifactHash)) {
      throw new Error('strategy metadata artifact hash is invalid');
    }
    if (!(metadata.signature instanceof Uint8Array) || metadata.signature.byteLength === 0) {
      throw new Error('strategy metadata signature is missing');
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function hashCanonicalPlan(canonicalPlan: Uint8Array): string {
  return createHash('sha256')
    .update('DKG-STRATEGY-PLAN-V1\0')
    .update(canonicalPlan)
    .digest('hex');
}

function validateCandidate(candidate: TriggerCandidate): void {
  if (
    !candidate.triggerId
    || !candidate.triggerType
    || !/^[0-9a-f]{64}$/.test(candidate.triggerDigest)
    || !candidate.strategyId
    || !/^\d+\.\d+\.\d+$/.test(candidate.strategyVersion)
    || !/^[0-9a-f]{64}$/.test(candidate.graphRevision)
    || !candidate.activationPrincipal
    || !Number.isSafeInteger(candidate.eventTime)
    || candidate.eventTime < 0
  ) {
    throw new Error('typed trigger candidate is malformed');
  }
}

function activationExecutionId(candidate: TriggerCandidate, artifactHash: string): string {
  return `urn:sr:execution:${hashHex(
    'DKG-SEMANTIC-RUNTIME-ACTIVATION-V1\0',
    candidate.triggerId,
    candidate.triggerDigest,
    artifactHash,
    candidate.graphRevision,
    candidate.policyEpoch.toString(),
  )}`;
}

function partitionId(graphRevision: string, policyEpoch: bigint): string {
  return `urn:sr:partition:${hashHex(
    'DKG-SEMANTIC-RUNTIME-PARTITION-V1\0',
    graphRevision,
    policyEpoch.toString(),
  )}`;
}

function rootProcessId(executionId: string): string {
  return `urn:sr:process:${hashHex('DKG-SEMANTIC-RUNTIME-ROOT-PROCESS-V1\0', executionId)}`;
}

function hashHex(domain: string, ...values: string[]): string {
  const hash = createHash('sha256').update(domain);
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}
