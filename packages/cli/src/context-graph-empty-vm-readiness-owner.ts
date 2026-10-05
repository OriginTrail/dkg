// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import { withContextGraphReadinessMutationLock, type ContextGraphSubscriptionStatePatch } from './context-graph-readiness.js';
import { mergeContextGraphPlaneEvidence, type ContextGraphReadinessPatch } from './context-graph-readiness-policy.js';

type FencedProof<T> = { readonly proven: false } | { readonly proven: true; readonly value: T };
const UNPROVEN = { proven: false } as const;

/** Observe late completion while allowing an abandoned lock task to settle. */
function settleOnAbort<T>(pending: Promise<FencedProof<T>>, signal: AbortSignal): Promise<FencedProof<T>> {
  if (signal.aborted) {
    // A rejection from a backend that ignored cancellation must stay observed.
    void pending.catch(() => undefined);
    return Promise.resolve(UNPROVEN);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(UNPROVEN); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pending.then(
      (result) => { signal.removeEventListener('abort', onAbort); resolve(result); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** A finalized zero-VM proof grants durable readiness only, never SWM. */
export function classifyEmptyPrivateVmReadiness(
  previous: ContextGraphReadinessProvenance,
): { statePatch: ContextGraphSubscriptionStatePatch; readinessPatch: ContextGraphReadinessPatch } {
  const readinessPatch = mergeContextGraphPlaneEvidence(previous, {
    durableVerified: true, sharedMemoryVerified: false,
  });
  return {
    readinessPatch,
    statePatch: {
      synced: true,
      sharedMemorySynced: readinessPatch.sharedMemoryVerified,
      metaSynced: true,
      pendingMeta: false,
    },
  };
}

/** The caller supplies the synchronous readiness commit inside the agent fence. */
export async function withProvenEmptyPrivateVmReadiness<T>(input: {
  agent: DKGAgent;
  contextGraphId: string;
  callerAgentAddress: string;
  commit: () => T;
  signal: AbortSignal;
}): Promise<FencedProof<T>> {
  if (input.signal.aborted) return UNPROVEN;
  const locked = withContextGraphReadinessMutationLock(input.agent, input.contextGraphId, () => {
    if (input.signal.aborted) return Promise.resolve(UNPROVEN);
    const proof = input.agent.proveRegisteredPrivateEmptyVmV1(
      input.contextGraphId,
      input.callerAgentAddress,
      () => {
        // A backend may ignore its abort signal and invoke this much later.
        // Never let that abandoned operation persist readiness.
        if (input.signal.aborted) throw new Error('Private empty-VM readiness proof expired');
        return input.commit();
      },
      input.signal,
    );
    return settleOnAbort(proof, input.signal);
  });
  // Also bound time spent waiting behind an earlier readiness mutation. The
  // queued task becomes a no-op when its turn eventually arrives.
  return settleOnAbort(locked, input.signal);
}
