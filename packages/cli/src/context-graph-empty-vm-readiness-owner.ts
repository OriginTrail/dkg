// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent, SynchronousReadinessCommitResult } from '@origintrail-official/dkg-agent';
import { resolveWithinAbort } from '@origintrail-official/dkg-core';
import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import { withContextGraphReadinessMutationLock, type ContextGraphSubscriptionStatePatch } from './context-graph-readiness.js';
import { reduceContextGraphPlaneEvidence, type ContextGraphReadinessPatch } from './context-graph-readiness-policy.js';

type FencedProof<T> =
  | { readonly proven: false; readonly retryable?: boolean }
  | { readonly proven: true; readonly value: T };
const UNPROVEN = { proven: false } as const;

/** A finalized zero-VM proof grants durable readiness only, never SWM. */
export function classifyEmptyPrivateVmReadiness(
  previous: ContextGraphReadinessProvenance,
): { statePatch: ContextGraphSubscriptionStatePatch; readinessPatch: ContextGraphReadinessPatch } {
  const reduced = reduceContextGraphPlaneEvidence(previous, {
    durable: { ready: true, persistable: true },
    sharedMemory: { ready: false, persistable: false },
  });
  return {
    readinessPatch: reduced.persisted,
    statePatch: {
      synced: reduced.writeReady,
      sharedMemorySynced: reduced.persisted.sharedMemoryVerified,
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
  commit: () => SynchronousReadinessCommitResult<T>;
  signal: AbortSignal;
}): Promise<FencedProof<T>> {
  // Also bound time spent waiting behind an earlier readiness mutation. The
  // queued task becomes a no-op when its turn eventually arrives.
  return await resolveWithinAbort(() => withContextGraphReadinessMutationLock(
    input.agent, input.contextGraphId, async () => {
      if (input.signal.aborted) return UNPROVEN;
      const proof = await resolveWithinAbort(() => input.agent.proveRegisteredPrivateEmptyVmV1(
        input.contextGraphId,
        input.callerAgentAddress,
        () => {
          // A backend may ignore its abort signal and invoke this much later.
          // Never let that abandoned operation persist readiness.
          if (input.signal.aborted) throw new Error('Private empty-VM readiness proof expired');
          return input.commit();
        },
        input.signal,
      ), input.signal);
      return proof ?? UNPROVEN;
    },
  ), input.signal) ?? UNPROVEN;
}
