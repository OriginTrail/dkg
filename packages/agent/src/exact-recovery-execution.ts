// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { type DurableRecoveryAuthority } from './durable-recovery-authority.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import type { ExactAssetFetchSessionPolicy } from './sync/requester/exact-durable-fetch.js';
import { VM_RECOVERY_SYNC_PRIORITY } from './sync/catchup-policy.js';
import type { ExactRecoveryOptions, ExactKnowledgeAssetSyncResult } from './durable-recovery-types.js';
import { runDurableRecovery } from './durable-recovery-execution.js';

export interface ExactRecoveryRequest {
  readonly host: DurableRecoveryHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly policy: ExactAssetFetchSessionPolicy;
  readonly options: ExactRecoveryOptions;
}

export async function runExactRecovery(request: ExactRecoveryRequest): Promise<ExactKnowledgeAssetSyncResult> {
  const { host, authority, ctx, remotePeerId, contextGraphId, policy, options } = request;

  const detailed = await runDurableRecovery({
    host, authority, ctx, remotePeerId, contextGraphIds: [contextGraphId],
    options: {
      ...options,
      exactAssetFetchPolicy: policy,
      exactRecoveryTransportMode: options.exactRecoveryTransportMode,
      ...(options.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: options.totalTimeoutMs }),
      stopOnBackoffWorthyFailure: true,
      priority: VM_RECOVERY_SYNC_PRIORITY,
      source: 'vm-recovery',
      onWorkStarted: options.onWorkStarted,
      signal: options.signal,
      isCurrent: options.isCurrent,
    },
  });
  return {
    admission: detailed.admission,
    result: detailed.result,
    disposition: detailed.exactFetchDisposition ?? 'incomplete',
    ...(detailed.exactResponderCapability === undefined
      ? {}
      : { responderCapability: detailed.exactResponderCapability }),
    ...(detailed.authenticatedExactAssets === undefined
      ? {}
      : { authenticatedAssets: detailed.authenticatedExactAssets }),
    ...(detailed.committedExactAssetUals === undefined
      ? {}
      : { committedExactAssetUals: detailed.committedExactAssetUals }),
    ...(detailed.exactStreamOutcome === undefined
      ? {}
      : { streamOutcome: detailed.exactStreamOutcome }),
  };
}
