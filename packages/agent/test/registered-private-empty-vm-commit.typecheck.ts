import type { DKGAgent } from '../src/dkg-agent.js';
import type {
  InspectedContextGraphReadinessV1,
  ProvenRegisteredPrivateEmptyVmInspectionV1,
} from '../src/dkg-agent-registered-private-empty-vm.js';

declare const agent: DKGAgent;
declare const signal: AbortSignal;

const inspection = { contextGraphId: 'graph', inspectMetadata: true, signal };
const proofInspection = {
  ...inspection,
  attemptPrivateEmptyVm: true,
  callerAgentAddress: 'caller',
};

agent.inspectAndCommitContextGraphReadinessV1(inspection, () => 'written');
agent.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1(
  proofInspection, () => 'written',
);
agent.proveRegisteredPrivateEmptyVmV1('graph', 'caller', () => 'written', signal);

agent.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1(proofInspection, (completion) => {
  if (completion.proven) {
    const validated: ProvenRegisteredPrivateEmptyVmInspectionV1 = completion.inspection;
    const current: 'current' = validated.kind;
    const privatePolicy: 'private' = validated.metadata.accessPolicy;
    const allowed: 'allowed' = validated.authority.outcome;
    const registered: 'registered-chain' = validated.authority.source;
    const onChainId: bigint = validated.authority.onChainId;
    const unregistered: undefined = validated.authority.registration;
    return { current, privatePolicy, allowed, registered, onChainId, unregistered };
  }
  // @ts-expect-error an unproven completion cannot provide validated prerequisites
  const unvalidated: ProvenRegisteredPrivateEmptyVmInspectionV1 = completion.inspection;
  return unvalidated;
});

agent.proveRegisteredPrivateEmptyVmV1('graph', 'caller', (validated) => {
  const current: 'current' = validated.kind;
  const allowed: 'allowed' = validated.authority.outcome;
  return { current, allowed };
}, signal);

const incompleteAuthority: InspectedContextGraphReadinessV1 = {
  kind: 'invalidated',
  // @ts-expect-error unavailable authority must carry its canonical diagnostics
  authority: { outcome: 'unavailable' },
};
void incompleteAuthority;

// A promise could persist after the final metadata/authority revision fence.
// @ts-expect-error asynchronous readiness commits are forbidden
agent.inspectAndCommitContextGraphReadinessV1(inspection, async () => 'late');
agent.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1(
  proofInspection,
  // @ts-expect-error asynchronous readiness commits are forbidden
  async () => 'late',
);
// @ts-expect-error asynchronous readiness commits are forbidden
agent.proveRegisteredPrivateEmptyVmV1('graph', 'caller', async () => 'late', signal);

const promiseLike: PromiseLike<string> = Promise.resolve('late');
// @ts-expect-error PromiseLike readiness commits are forbidden
agent.inspectAndCommitContextGraphReadinessV1(inspection, () => promiseLike);
