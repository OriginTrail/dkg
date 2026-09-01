import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DkgSemanticRuntimeProjector,
  RuntimeAdapterRegistry,
  RuntimeEffectBroker,
  SemanticRuntimeStore,
  TrustedStrategyActivationService,
  WasmStrategyAdmissionClient,
  admittedPlanAuthority,
  computeEffectRequestDigest,
  encodeCapabilityMetadata,
  type EffectProposal,
  type StrategyActivationMetadata,
  type TriggerCandidate,
} from '../src/index.js';

const workerUrl = new URL('../dist/component-worker.js', import.meta.url);

const source = `
  (strategy sre/keep-network-healthy
    (version "0.4.0")
    (scope network:testnet)
    (goal p95-latency-below-500ms)
    (sequence
      (supervise one-for-one (max-restarts 4) (window-ms 60000)
        (parallel (max 3)
          (delegate log-investigator
            (grant logs.read)
            (observe logs/read@1 affected-nodes 50m))
          (delegate network-investigator
            (grant dkg.query)
            (query dkg/query@1 network-topology))
          (delegate history-investigator
            (grant agent.invoke.investigator)
            (call agent/investigate@1 prior-incidents))))
      (approve infrastructure-change)
      (delegate remediation-worker
        (grant infra.node.drain)
        (call infra/drain-node@1 node-17))
      (emit incident-trace)))
`;

describe('Listener Boy vertical slice', () => {
  it('pins DKG metadata to Wasm admission and reconciles an ambiguous one-shot effect', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-boy-v1-'));
    const store = new SemanticRuntimeStore(path.join(directory, 'semantic-runtime.sqlite'));
    const admission = new WasmStrategyAdmissionClient({ workerUrl });
    try {
      const compilation = await admission.compileAndAdmit(source);
      expect(compilation.ok).toBe(true);
      if (!compilation.ok) return;
      const plan = compilation.plan;
      const artifactHash = Buffer.from(plan.canonicalHash).toString('hex');
      const candidate: TriggerCandidate = {
        triggerId: 'urn:sr:trigger:listener-boy-latency-1',
        triggerType: 'sre:LatencyIncident',
        triggerDigest: '11'.repeat(32),
        strategyId: 'sre/keep-network-healthy',
        strategyVersion: '0.4.0',
        graphRevision: '22'.repeat(32),
        policyEpoch: 41n,
        activationPrincipal: 'did:dkg:operator-1',
        eventTime: 1_000,
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
        activationScope: plan.scope,
        declaredEffects: plan.effectUpperBound,
        requiredCapabilities: plan.requiredCapabilities,
      };
      const activation = new TrustedStrategyActivationService(
        store,
        { resolve: async () => metadata },
        {
          get: async () => ({
            canonicalPlan: plan.canonicalPlan,
            sourceRef: `artifact:sha256:${artifactHash}`,
            createdAt: 900,
          }),
        },
        { verify: async () => true },
        admission,
        {
          allowedStrategyTypes: new Set([metadata.strategyType]),
          allowedStrategyIds: new Set([metadata.strategyId]),
          trustedAuthors: new Set([metadata.authorPrincipal]),
          requiredReviewState: 'approved',
          currentPolicyEpoch: () => 41n,
          acceptsScope: (scope) => scope === 'network:testnet',
        },
      );
      const activated = await activation.activate(candidate);
      expect(activated.execution).toMatchObject({
        planId: artifactHash,
        graphRevision: candidate.graphRevision,
        policyEpoch: 41n,
        status: 'active',
      });

      const effectInput = { node: 'node-17', evidenceRef: 'urn:sr:evidence:latency-8841' };
      const requestDigest = computeEffectRequestDigest(
        'infra/drain-node',
        '1',
        'drain',
        'node/node-17',
        effectInput,
      );
      store.putCapability({
        capabilityId: 'cap-listener-boy-remediation',
        executionId: activated.execution.executionId,
        metadataCbor: encodeCapabilityMetadata({
          subject: candidate.activationPrincipal,
          audience: 'dkg-semantic-runtime',
          executionId: activated.execution.executionId,
          verbs: ['drain'],
          resources: ['node/node-17'],
          delegationDepth: 0,
          oneShot: true,
          budgetMicros: 1_000n,
        }),
        hostBindingKey: 'infra/node-drainer',
        policyEpoch: 41n,
        notBefore: 1_000,
        expiresAt: 2_000,
        oneShot: true,
        consumedAt: null,
        revokedAt: null,
      });
      store.putApproval({
        approvalId: 'approval-listener-boy-drain',
        executionId: activated.execution.executionId,
        effectClass: 'infrastructure-change',
        principal: candidate.activationPrincipal,
        requestDigest,
        notBefore: 1_000,
        expiresAt: 2_000,
        oneShot: true,
        consumedAt: null,
      });

      let dispatchCount = 0;
      const adapters = new RuntimeAdapterRegistry();
      adapters.register({
        id: 'infra/drain-node',
        version: '1',
        effectClass: 'infrastructure-change',
        verb: 'drain',
        idempotencyClass: 'non_repeatable',
        reconciliationRule: 'query-node-drain-state',
        compensationRule: 'restore-node-service',
        validateInput(value) {
          if (typeof value !== 'object' || value === null || !('node' in value)) {
            throw new Error('INVALID_INPUT');
          }
          return value as typeof effectInput;
        },
        dispatch: async () => {
          dispatchCount += 1;
          return {
            status: 'succeeded' as const,
            output: { drained: true },
            evidenceRef: 'urn:sr:evidence:drain-accepted',
          };
        },
        reconcile: async () => ({
          status: 'applied',
          evidenceRef: 'urn:sr:evidence:drain-state-confirmed',
          output: { drained: true },
        }),
        couldHaveReachedTarget: () => true,
      });
      const broker = new RuntimeEffectBroker(
        store,
        {
          evaluate: async () => ({
            decision: 'allow',
            policyId: 'ccl:listener-boy-effects@1',
            policyEpoch: 41n,
            factsDigest: new Uint8Array(32).fill(9),
            reasonCode: 'POLICY_ALLOW',
          }),
        },
        adapters,
        admittedPlanAuthority(plan),
        {
          boundary: (boundary) => {
            if (boundary === 'adapter-returned') throw new Error('SIMULATED_WORKER_CRASH');
          },
        },
      );
      const proposal: EffectProposal = {
        effectId: 'urn:sr:effect:listener-boy-drain-1',
        executionId: activated.execution.executionId,
        processId: activated.execution.rootProcessId,
        stepId: 'remediation/drain-node-17',
        attemptId: 'attempt-1',
        principal: candidate.activationPrincipal,
        adapterId: 'infra/drain-node',
        adapterVersion: '1',
        verb: 'drain',
        resource: 'node/node-17',
        normalizedInput: effectInput,
        capabilityId: 'cap-listener-boy-remediation',
        approvalId: 'approval-listener-boy-drain',
        idempotencyKey: 'listener-boy:drain-node-17:once',
        budgetReservation: 100n,
        now: 1_100,
      };
      await broker.prepareEffect(proposal);
      expect((await broker.dispatchPrepared(proposal.effectId, 1_101)).state).toBe('unknown');
      await expect(broker.dispatchPrepared(proposal.effectId, 1_102)).rejects.toThrow(/unknown/);
      const reconciled = await broker.reconcileUnknown(proposal.effectId, 1_103);
      expect(reconciled.state).toBe('succeeded');
      expect(dispatchCount).toBe(1);
      expect(store.effectTransitions(proposal.effectId).map((entry) => entry.state)).toContain(
        'reconciled',
      );

      const insert = vi.fn().mockResolvedValue(undefined);
      const projector = new DkgSemanticRuntimeProjector(
        { insert },
        'urn:dkg:context-graph:listener-boy:swm',
      );
      await projector.projectExecutionSummary({
        execution: activated.execution,
        strategyId: candidate.strategyId,
        strategyVersion: candidate.strategyVersion,
        traceHash: '33'.repeat(32),
        affectedResourceRefs: ['urn:dkg:node:17'],
        evidenceRefs: ['urn:sr:evidence:latency-8841'],
      });
      await projector.projectEffectSummary(reconciled, [
        'urn:sr:evidence:drain-state-confirmed',
      ]);
      const projection = JSON.stringify(insert.mock.calls);
      expect(projection).toContain('Succeeded');
      expect(projection).not.toContain('cap-listener-boy-remediation');
      expect(projection).not.toContain('evidenceRef');
    } finally {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
