import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { canonicalProgramInputs } from './semantic-runtime-bound-invocation.js';
import { assertExecutionCapabilityAuthorized } from './semantic-runtime-invocation-policy.js';
import { assertChildApprovalsAuthorized } from './semantic-runtime-child-authority.js';
import { programBindingDigest } from './semantic-runtime-program-bindings.js';
import { typeScriptInvocationIdentity } from './semantic-runtime-typescript-identity.js';
import { SemanticProgramError, type ConfiguredSemanticRuntimeService } from './semantic-runtime-types.js';

interface NativeCallbackAuthority {
  kind: 'bound-typescript-v1';
  executionId: string;
  operationIri: string;
  bindingDigest: string;
  requestIdentity: string;
}

/** Companion callbacks retain the original signed invocation's authority. A
 * current approval for identical source cannot replace this durable snapshot.
 * The runtime remains the owner of capability and execution-status policy.
 */
export function createNativeCallbackAuthority({ agent, runtime, config, graphId, caller }: {
  agent: DKGAgent; runtime: () => ConfiguredSemanticRuntimeService | null | undefined;
  config: SemanticRuntimeConfig; graphId: string; caller: string;
}) {
  const denied = () => new SemanticProgramError('PROGRAM_AUTHORITY_REVOKED', 'Original Program invocation authority is unavailable', 403);
  const bindingFor = (operationIri: string) => config.programBindings?.find(b => b.contextGraphId === graphId && b.operationIri === operationIri);
  return {
    capture(workflow: { kaRef: string; sourceHash: string }, invocationId: string, input: unknown): NativeCallbackAuthority {
      const binding = bindingFor(workflow.kaRef);
      if (!runtime() || !binding?.enabled || !binding.typescript || !binding.n8n?.result
        || binding.program.sourceHash !== workflow.sourceHash
        || !binding.allowedCallerAgentAddresses.some(a => a.toLowerCase() === caller.toLowerCase())) throw denied();
      const digest = programBindingDigest(binding);
      return { kind: 'bound-typescript-v1', executionId: `urn:sr:execution:${invocationId}`, operationIri: workflow.kaRef,
        bindingDigest: digest, requestIdentity: typeScriptInvocationIdentity(digest, caller, canonicalProgramInputs([input])) };
    },
    async assert(snapshot: NativeCallbackAuthority | null, effectId: string, { readbackOnly = false } = {}): Promise<() => void> {
      const check = () => {
        if (!snapshot || snapshot.kind !== 'bound-typescript-v1') throw denied();
        const host = runtime(), binding = bindingFor(snapshot.operationIri);
        if (!host || !binding?.enabled || programBindingDigest(binding) !== snapshot.bindingDigest) throw denied();
        assertChildApprovalsAuthorized(binding, config, caller);
        const execution = host.store.execution(snapshot.executionId), effect = host.store.effect(effectId);
        if (!execution || execution.graphRevision !== snapshot.requestIdentity || !effect
          || effect.executionId !== snapshot.executionId || effect.adapterId !== 'n8n/workflow'
          || effect.resource !== binding.n8n?.toolIri
          || effect.capabilityId !== snapshot.executionId.replace('urn:sr:execution:', 'urn:sr:capability:')) throw denied();
        // A completed parent permits only retained results or reconciliation of
        // an already journalled write. It can never admit a new component effect.
        assertExecutionCapabilityAuthorized(host, snapshot.executionId,
          readbackOnly && execution.status === 'completed' ? 'completed' : 'active');
        return binding;
      };
      const binding = check();
      for (const graph of new Set([graphId, binding.program.contextGraphId])) {
        if (!await agent.canReadContextGraph(graph, { callerAgentAddress: binding.executorAgentAddress, allowSubscriptionFallback: false })) throw denied();
      }
      check();
      // The effect dispatcher runs this synchronous fence after awaiting all
      // asynchronous checks, in the same turn as the transport call itself.
      return () => { check(); };
    },
  };
}
