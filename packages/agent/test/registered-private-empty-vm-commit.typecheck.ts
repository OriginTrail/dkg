import type { DKGAgent } from '../src/dkg-agent.js';

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
