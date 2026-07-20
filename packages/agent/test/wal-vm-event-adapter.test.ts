import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WAL_V1_ENUMS,
  type ProtocolTuple,
} from '@origintrail-official/dkg-wal';
import {
  moveTierCommitmentV1,
  type CurrentVmFinalityPolicyV1,
} from '@origintrail-official/dkg-wal/vm';
import {
  DkgSemanticCore,
  type DkgSemanticCoreDelegates,
  type DkgSemanticCoreTraceEvent,
} from '../src/semantic/dkg-semantic-core.js';
import type { DkgVmChainValidationResultV1 } from '../src/semantic/vm-chain-validator.js';
import type { DkgWalSemanticProjectionOutcomeV1 } from '../src/wal/projection-materializer.js';
import {
  CurrentDkgVmSemanticCoreAdapterV1,
  DkgWalVmEventAdapterV1,
  type DkgVmSemanticEvidenceV1,
  type DkgWalVmEventInputV1,
} from '../src/wal/vm-event-adapter.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update('agent-wal-vm-event-v1\0' + label).digest().subarray(0, length),
  );
}

function bigintBytes(value: bigint): Uint8Array {
  const output = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

function chainBinding(): ProtocolTuple<'ChainBindingV1'> {
  return [
    2043n,
    bytes('contract', 20),
    bigintBytes(7n),
    bigintBytes(9n),
    bytes('author', 20),
    1n,
    bytes('root'),
    bytes('tx'),
    100n,
    bytes('block'),
    0n,
    0n,
    BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH),
    64n,
  ];
}

function mutation(): ProtocolTuple<'DkgMutationV1'> {
  return [
    1n,
    BigInt(WAL_V1_ENUMS.mutationOperation.MOVE_TIER_TARGET),
    bytes('logical-key'),
    [],
    [],
    bytes('policy'),
    [
      1n,
      BigInt(WAL_V1_ENUMS.mutationMode.PATCH),
      bytes('base-state'),
      bytes('target-state'),
      [],
      [],
      new Uint8Array(),
      new TextEncoder().encode('<urn:s> <urn:p> "vm" <urn:g> .\n'),
      [bytes('touched')],
      null,
    ],
    chainBinding(),
    null,
  ];
}

function transition(): DkgWalVmEventInputV1 {
  const sourceNamespaceId = bytes('source-namespace');
  const sourceWalObjectId = bytes('source-object');
  const targetNamespaceId = bytes('target-namespace');
  const targetWalObjectId = bytes('target-object');
  const targetMutation = mutation();
  const nonce = bytes('nonce');
  const sourceState = bytes('source-state');
  const sourceResult = bytes('source-result');
  const commitment = moveTierCommitmentV1({
    transitionNonce: nonce,
    sourceNamespaceId,
    targetNamespaceId,
    targetMutation,
    sourceStateDigest: sourceState,
    sourceResultDigest: sourceResult,
  });
  return {
    trigger: 'wal-replay',
    sourceNamespaceId,
    sourceWalObjectId,
    targetNamespaceId,
    targetWalObjectId,
    currentCuratorVectorId: bytes('vector'),
    source: [
      1n,
      nonce,
      commitment,
      targetNamespaceId,
      targetWalObjectId,
      [bytes('source-head')],
      sourceState,
      sourceResult,
    ],
    target: [1n, commitment, targetMutation],
    receipt: [
      1n,
      commitment,
      targetNamespaceId,
      targetWalObjectId,
      targetMutation[5],
      bytes('vector'),
      2_000n,
      bytes('authority'),
      [[bytes('curator', 20), new Uint8Array(65).fill(1)]],
    ],
    privateSourceValues: [new TextEncoder().encode('urn:private-source')],
  };
}

function finalityPolicy(policyObjectId = bytes('policy')): CurrentVmFinalityPolicyV1 {
  return {
    policyObjectId,
    minimumBlocks: 64n,
    maximumBlocks: 256n,
  };
}

function chainResult(
  status: DkgVmChainValidationResultV1['status'] = 'FINALIZED',
): DkgVmChainValidationResultV1 {
  if (status === 'FINALIZED') {
    return {
      status,
      reason: 'VERIFIED_FINAL',
      effectiveFinalityBlocks: 64n,
      confirmations: 64n,
      verifiedFrontier: [2043n, 100n, bytes('block')],
    };
  }
  if (status === 'PENDING') {
    return {
      status,
      reason: 'INSUFFICIENT_FINALITY',
      effectiveFinalityBlocks: 64n,
      confirmations: 63n,
    };
  }
  if (status === 'REORG') {
    return {
      status,
      reason: 'BLOCK_REORG',
      effectiveFinalityBlocks: 64n,
      confirmations: 64n,
    };
  }
  return {
    status,
    reason: 'MERKLE_ROOT_MISMATCH',
    effectiveFinalityBlocks: 64n,
    confirmations: 64n,
  };
}

function projection(): DkgWalSemanticProjectionOutcomeV1 {
  return {
    commit: {
      adapterVersion: 1,
      mode: 'CAS',
      namespaceId: bytes('projection-namespace'),
      logicalKey: bytes('projection-key'),
      expectedActiveHeadsDigest: null,
      replaceGraphs: [],
      replaceSubjects: [],
      deleteQuads: [],
      insertQuads: [],
      conflictGraphs: [],
      newActiveHeadsDigest: bytes('active'),
      newConflictHeadsDigest: bytes('conflict'),
      newStateDigest: bytes('state'),
      sourceVectorId: bytes('vector'),
    },
  };
}

function environment(status: DkgVmChainValidationResultV1['status'] = 'FINALIZED') {
  const trace: DkgSemanticCoreTraceEvent[] = [];
  const validate = vi.fn(async () => chainResult(status));
  const core = new DkgSemanticCore({
    observer: event => trace.push(event),
    delegates: {
      validateCurrentDkgVmChainEvidenceV1:
        validate as DkgSemanticCoreDelegates['validateCurrentDkgVmChainEvidenceV1'],
    },
  });
  const semanticImplementation = {
    applyVmEvidence: vi.fn(async () => projection()),
  };
  const materializer = {
    apply: vi.fn(async () => ({
      status: 'APPLIED' as const,
      marker: {} as never,
    })),
  };
  const options = {
    chain: {} as ChainAdapter,
    semanticCore: core,
    semanticImplementation,
    materializer,
    isWalObjectAdmitted: vi.fn(async () => true),
    authorizeSourceView: vi.fn(async () => true),
    verifyTierReceiptAuthority: vi.fn(async () => undefined),
    resolveCurrentFinalityPolicy: vi.fn(async () => finalityPolicy()),
    now: () => 1_000,
  };
  return { trace, validate, core, semanticImplementation, materializer, options };
}

describe('WAL VM/finality/reorg adapter over the shared semantic core', () => {
  it.each(['FINALIZED', 'PENDING', 'REJECTED', 'REORG'] as const)(
    'feeds %s chain evidence through one semantic implementation and WAL-015',
    async status => {
      const env = environment(status);
      const adapter = new DkgWalVmEventAdapterV1(env.options);
      const input = transition();
      const result = await adapter.apply(input);

      expect(result.chainValidation.status).toBe(status);
      expect(result.materialization.status).toBe('APPLIED');
      expect(env.validate).toHaveBeenCalledOnce();
      expect(env.semanticImplementation.applyVmEvidence).toHaveBeenCalledOnce();
      expect(env.semanticImplementation.applyVmEvidence.mock.calls[0]![0]).toMatchObject({
        trigger: 'wal-replay',
        sourceNamespaceId: input.sourceNamespaceId,
        targetNamespaceId: input.targetNamespaceId,
        chainValidation: { status },
      });
      expect(env.materializer.apply).toHaveBeenCalledWith(projection());
      expect(env.trace.map(item => [item.entryPoint, item.phase])).toEqual([
        ['vm-chain-evidence-validation', 'enter'],
        ['vm-chain-evidence-validation', 'return'],
        ['vm-evidence-application', 'enter'],
        ['vm-evidence-application', 'return'],
      ]);
    },
  );

  it('uses the identical semantic implementation for legacy, chain, and WAL drivers', async () => {
    const trace: DkgSemanticCoreTraceEvent[] = [];
    const implementation = { applyVmEvidence: vi.fn(async () => projection()) };
    const core = new DkgSemanticCore({ observer: event => trace.push(event) });
    const bridge = new CurrentDkgVmSemanticCoreAdapterV1(implementation, core);
    const input = {
      marker: 'same normalized evidence',
    } as unknown as DkgVmSemanticEvidenceV1;

    await bridge.apply('legacy-sync', input);
    await bridge.apply('chain-event', input);
    await bridge.apply('wal-sync', input);

    expect(implementation.applyVmEvidence.mock.calls).toEqual([[input], [input], [input]]);
    expect(trace.filter(item => item.phase === 'enter').map(item => item.driver)).toEqual([
      'legacy-sync',
      'chain-event',
      'wal-sync',
    ]);
  });

  it('fails closed before semantics for missing admission or private authorization', async () => {
    for (const configure of [
      (env: ReturnType<typeof environment>) =>
        env.options.isWalObjectAdmitted.mockResolvedValueOnce(false),
      (env: ReturnType<typeof environment>) =>
        env.options.authorizeSourceView.mockResolvedValueOnce(false),
    ]) {
      const env = environment();
      configure(env);
      const adapter = new DkgWalVmEventAdapterV1(env.options);
      await expect(adapter.apply(transition())).rejects.toBeInstanceOf(Error);
      expect(env.validate).not.toHaveBeenCalled();
      expect(env.semanticImplementation.applyVmEvidence).not.toHaveBeenCalled();
      expect(env.materializer.apply).not.toHaveBeenCalled();
    }
  });

  it('reuses current receipt authority and exact signed finality policy', async () => {
    const authorityFailure = environment();
    authorityFailure.options.verifyTierReceiptAuthority.mockRejectedValueOnce(
      new Error('threshold rejected'),
    );
    await expect(new DkgWalVmEventAdapterV1(authorityFailure.options).apply(transition()))
      .rejects.toThrow('threshold rejected');

    const policyFailure = environment();
    policyFailure.options.resolveCurrentFinalityPolicy.mockResolvedValueOnce(
      finalityPolicy(bytes('other-policy')),
    );
    await expect(new DkgWalVmEventAdapterV1(policyFailure.options).apply(transition()))
      .rejects.toMatchObject({ code: 'WAL_VM_POLICY_MISMATCH' });
    expect(policyFailure.validate).not.toHaveBeenCalled();
  });

  it('re-evaluates restart and policy-change triggers without a WAL-only VM table', async () => {
    const env = environment('REORG');
    const adapter = new DkgWalVmEventAdapterV1(env.options);
    const input = transition();
    await adapter.apply({ ...input, trigger: 'restart-revalidation' });
    await adapter.apply({ ...input, trigger: 'policy-reconfiguration' });
    expect(env.validate).toHaveBeenCalledTimes(2);
    expect(env.semanticImplementation.applyVmEvidence.mock.calls.map(call => call[0].trigger))
      .toEqual(['restart-revalidation', 'policy-reconfiguration']);
  });
});
