// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { type DurableRecoveryAuthority, type DurableRecoveryInput } from './durable-recovery-authority.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { createUalOnlyExactAssetSelection, requireExactAssetSelection, type ExactAssetSelection } from './sync/exact-assets.js';
import { normalizeExactAssetFetchPolicy } from './sync/requester/durable-sync-compat.js';
import { exactAssetFetchSessionPolicy, requireUalOnlyExactAssetSelection } from './sync/requester/exact-durable-fetch.js';
import { VM_RECOVERY_SYNC_PRIORITY } from './sync/catchup-policy.js';
import type { ExactKnowledgeAssetRefreshSyncOptions, ExactKnowledgeAssetSyncResult } from './durable-recovery-types.js';
import { runDurableRecovery } from './durable-recovery-execution.js';

export interface ExactRecoveryRequest {
  readonly host: DurableRecoveryHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly selectionInput: ExactAssetSelection | readonly string[];
  readonly options: Omit<ExactKnowledgeAssetRefreshSyncOptions, keyof DurableRecoveryInput>;
}

export async function runExactRecovery(request: ExactRecoveryRequest): Promise<ExactKnowledgeAssetSyncResult> {
  const { host, authority, ctx, remotePeerId, contextGraphId, selectionInput, options } = request;

  const selection: ExactAssetSelection = Array.isArray(selectionInput)
    ? createUalOnlyExactAssetSelection(selectionInput)
    : requireExactAssetSelection(selectionInput);
  const detailed = await runDurableRecovery({
    host, authority, ctx, remotePeerId, contextGraphIds: [contextGraphId],
    options: {
      ...options,
      exactAssetFetchPolicy: options.exactFetchPurpose === 'vm-update-refresh'
        ? exactAssetFetchSessionPolicy(requireUalOnlyExactAssetSelection(selection), 'vm-update-refresh')
        : normalizeExactAssetFetchPolicy(undefined, () => selection, options.forceFreshExactSession),
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
