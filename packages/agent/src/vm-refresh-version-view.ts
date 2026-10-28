// SPDX-License-Identifier: Apache-2.0

/**
 * The pinned version view a VM refresh attempt settles from, read together
 * with the reason when there is none.
 *
 * Without a view the attempt is retried after backoff, as it always was. The
 * chain adapter reports why it had none: each endpoint it asked, by position
 * and host, with a closed class. The retry carries that report in words after
 * its detail, for the lane's one log line per attempt, and as a field, so
 * nothing has to take the detail apart. Nothing decides from it.
 */

import type {
  ChainAdapter,
  KnowledgeAssetVersionSnapshot,
  KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';
import { versionViewCause } from './named-ka-recovery-diagnostics.js';
import type { VmRefreshAttempt } from './vm-refresh.js';

export type VmRefreshVersionView =
  | { readonly view: KnowledgeAssetVersionSnapshot }
  /** No view: `retry` is the attempt to settle with. */
  | { readonly view: null; readonly retry: VmRefreshAttempt };

/** Read the coherent version view of `kaId` through the adapter's own `read`. */
export async function readVmRefreshVersionView(
  read: NonNullable<ChainAdapter['readKnowledgeAssetVersionSnapshot']>,
  kaId: bigint,
  signal: AbortSignal | undefined,
): Promise<VmRefreshVersionView> {
  const versionRead: { unavailable?: KnowledgeAssetVersionSnapshotUnavailable } = {};
  const view = await read(kaId, {
    signal,
    onUnavailable: (report) => { versionRead.unavailable = report; },
  });
  if (view !== null) return { view };
  return {
    view: null,
    retry: {
      outcome: 'retry',
      detail: `no coherent chain view confirms the copy${versionViewCause(versionRead.unavailable)}`,
      ...(versionRead.unavailable === undefined ? {} : { versionViewUnavailable: versionRead.unavailable }),
    },
  };
}
