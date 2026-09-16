import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DkgSemanticRuntimeProjector,
  SemanticRuntimeStore,
  TrustedStrategyActivationService,
  hashCanonicalPlan,
  type EffectRecord,
  type AdmittedPlanSummary,
  type StrategyActivationMetadata,
  type TriggerCandidate,
} from '../src/index.js';

const canonicalPlan = Uint8Array.from([0x83, 0x01, 0x02, 0x03]);
const artifactHash = hashCanonicalPlan(canonicalPlan);

const admittedPlan: AdmittedPlanSummary = {
  canonicalPlan,
  canonicalHash: Uint8Array.from(Buffer.from(artifactHash, 'hex')),
  strategyRef: 'sre/keep-network-healthy@0.4.0',
  scope: 'urn:dkg:network:testnet',
  goal: 'keep-network-healthy',
  requiredCapabilities: ['logs.read', 'infra.node.drain'],
  effectUpperBound: ['read', 'infrastructure-change'],
  approvalRequirements: ['infrastructure-change'],
  adapterVersions: new Map([['infra/drain-node', 1]]),
  resourceBounds: { processes: 8, hostCommands: 4, retryAttempts: 0, depth: 4 },
};

const candidate: TriggerCandidate = {
  triggerId: 'urn:trigger:latency-1',
  triggerType: 'sre:LatencyIncident',
  triggerDigest: '11'.repeat(32),
  strategyId: 'sre/keep-network-healthy',
  strategyVersion: '0.4.0',
  graphRevision: '22'.repeat(32),
  policyEpoch: 41n,
  activationPrincipal: 'did:dkg:operator-1',
  eventTime: 100,
};

const metadata: StrategyActivationMetadata = {
  strategyId: candidate.strategyId,
  version: candidate.strategyVersion,
  strategyType: 'sre:IncidentStrategy',
  artifactHash,
  authorPrincipal: 'did:dkg:sre-team',
  authorKeyId: 'did:dkg:sre-team#strategy-signing-1',
  signature: new Uint8Array(64).fill(7),
  reviewState: 'approved',
  activationScope: 'urn:dkg:network:testnet',
  declaredEffects: ['read', 'infrastructure-change'],
  requiredCapabilities: ['logs.read', 'infra.node.drain'],
};

function temporaryStore(): { directory: string; store: SemanticRuntimeStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-semantic-activation-'));
  return {
    directory,
    store: new SemanticRuntimeStore(path.join(directory, 'semantic-runtime.sqlite')),
  };
}

describe('TrustedStrategyActivationService', () => {
  it('persists a graph/policy-pinned execution only after local artifact and signature checks', async () => {
    const temporary = temporaryStore();
    const signatureVerify = vi.fn().mockResolvedValue(true);
    try {
      const service = new TrustedStrategyActivationService(
        temporary.store,
        { resolve: async () => metadata },
        {
          get: async () => ({
            canonicalPlan,
            sourceRef: 'artifact:sha256:source',
            createdAt: 90,
          }),
        },
        { verify: signatureVerify },
        { admitPlan: async () => admittedPlan },
        {
          allowedStrategyTypes: new Set(['sre:IncidentStrategy']),
          allowedStrategyIds: new Set([candidate.strategyId]),
          trustedAuthors: new Set([metadata.authorPrincipal]),
          requiredReviewState: 'approved',
          currentPolicyEpoch: () => 41n,
          acceptsScope: (scope) => scope === metadata.activationScope,
        },
      );
      const first = await service.activate(candidate);
      const duplicate = await service.activate(candidate);
      expect(first.execution.executionId).toBe(duplicate.execution.executionId);
      expect(first.execution).toMatchObject({
        planId: artifactHash,
        graphRevision: candidate.graphRevision,
        policyEpoch: 41n,
        nextEventSeq: 1n,
      });
      expect(signatureVerify).toHaveBeenCalledTimes(2);
      expect(temporary.store.strategyArtifact(artifactHash)?.canonicalPlan).toEqual(canonicalPlan);
    } finally {
      temporary.store.close();
      fs.rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it('rejects graph-selected bytes, stale policy epochs, and unapproved metadata', async () => {
    const temporary = temporaryStore();
    try {
      const policy = {
        allowedStrategyTypes: new Set(['sre:IncidentStrategy']),
        allowedStrategyIds: new Set([candidate.strategyId]),
        trustedAuthors: new Set([metadata.authorPrincipal]),
        requiredReviewState: 'approved' as const,
        currentPolicyEpoch: () => 41n,
        acceptsScope: () => true,
      };
      const tampered = new TrustedStrategyActivationService(
        temporary.store,
        { resolve: async () => metadata },
        {
          get: async () => ({
            canonicalPlan: Uint8Array.from([9, 9, 9]),
            sourceRef: 'untrusted-graph-attachment',
            createdAt: 90,
          }),
        },
        { verify: async () => true },
        { admitPlan: async () => admittedPlan },
        policy,
      );
      await expect(tampered.activate(candidate)).rejects.toThrow(/bytes do not match/);
      await expect(tampered.activate({ ...candidate, policyEpoch: 40n })).rejects.toThrow(/stale/);

      const draft = new TrustedStrategyActivationService(
        temporary.store,
        { resolve: async () => ({ ...metadata, reviewState: 'draft' }) },
        { get: async () => ({ canonicalPlan, sourceRef: 'local', createdAt: 90 }) },
        { verify: async () => true },
        { admitPlan: async () => admittedPlan },
        policy,
      );
      await expect(draft.activate(candidate)).rejects.toThrow(/review state/);
    } finally {
      temporary.store.close();
      fs.rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});

describe('DkgSemanticRuntimeProjector', () => {
  it('projects selected provenance summaries and excludes private runtime state', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const projector = new DkgSemanticRuntimeProjector(
      { insert },
      'urn:dkg:context-graph:incident-1:wm',
    );
    const execution = {
      executionId: 'urn:sr:execution:abc',
      planId: artifactHash,
      partitionId: 'urn:sr:partition:abc',
      status: 'completed' as const,
      graphRevision: candidate.graphRevision,
      policyEpoch: 41n,
      rootProcessId: 'urn:sr:process:root',
      nextEventSeq: 8n,
      snapshotSeq: 7n,
      leaseEpoch: 1n,
      stateDigest: new Uint8Array(32).fill(4),
    };
    await projector.projectExecutionSummary({
      execution,
      strategyId: candidate.strategyId,
      strategyVersion: candidate.strategyVersion,
      traceHash: '33'.repeat(32),
      affectedResourceRefs: ['urn:dkg:node:17'],
      evidenceRefs: ['urn:sr:evidence:latency-1'],
    });
    const effect: EffectRecord = {
      effectId: 'effect-drain-1',
      executionId: execution.executionId,
      processId: 'urn:sr:process:remediation',
      stepId: 'drain',
      attemptId: 'attempt-1',
      idempotencyKey: 'drain-once',
      idempotencyClass: 'conditionally_idempotent',
      state: 'reconciled',
      requestDigest: new Uint8Array(32).fill(5),
      normalizedInput: new TextEncoder().encode('PRIVATE RAW INPUT'),
      capabilityId: 'opaque-capability-id',
      policyDecisionId: 'policy-decision-1',
      approvalId: 'approval-1',
      adapterId: 'infra/drain-node',
      adapterVersion: '1',
      verb: 'drain',
      resource: 'node/node-17',
      reconciliationRule: 'query-drain-state',
      compensationRule: 'restore-node-service',
      budgetReservation: 10n,
      journalVersion: 7n,
    };
    await projector.projectEffectSummary(effect, ['urn:sr:evidence:drain-state-1']);

    const serialized = JSON.stringify(insert.mock.calls);
    expect(serialized).toContain('strategyHash');
    expect(serialized).toContain('effectState');
    expect(serialized).not.toContain('PRIVATE RAW INPUT');
    expect(serialized).not.toContain('opaque-capability-id');
    expect(serialized).not.toContain('normalizedInput');
  });
});
