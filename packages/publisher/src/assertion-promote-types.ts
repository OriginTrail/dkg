import type { PublishOptions } from './publisher.js';
import { validatePromoteRecoveryBinding, type PromoteRecoveryBinding } from './promote-recovery-binding.js';
import type { WorkspaceAgentRecipientResolver } from './workspace-agent-recipients.js';
import type { ConfirmWorkspaceGossipBeforeCommit, EncodedWorkspaceGossipPayload } from './workspace-gossip-payload.js';

/** Publisher-owned contract for assertion promotion after agent prerequisites resolve. */
export type PublisherAssertionPromoteOptions = {
  recoveryBinding?: PromoteRecoveryBinding;
  entities?: readonly string[] | 'all';
  subGraphName?: string;
  publisherPeerId?: string;
  senderAgentAddress?: string;
  /** Do not encrypt or emit a network-ready payload for a local capture. */
  localOnly?: boolean;
  /** Immutable access envelope persisted with the graph-scoped share. */
  accessPolicy?: PublishOptions['accessPolicy'];
  allowedPeers?: readonly string[];
  trustedNonManifestCatalogTriples?: PublishOptions['trustedNonManifestCatalogTriples'];
  onChainContextGraphId?: string | bigint;
  /**
   * Strict curator-ack gate (OT-RFC-49 curator-leader), the same contract as
   * `ShareOptions.confirmBeforeCommit`: called with the gossip payload once it is
   * built and BEFORE the WM→SWM mutation. `applied: false` aborts the promote
   * (CuratorUnconfirmedError / CuratorRejectedError) leaving WM intact.
   */
  confirmBeforeCommit?: ConfirmWorkspaceGossipBeforeCommit;
  /** Promote-scoped authority resolver; defaults to the configured workspace resolver. */
  resolveWorkspaceRecipients?: WorkspaceAgentRecipientResolver;
};

export type AssertionPromoteResult = {
  promotedCount: number;
  gossipPayload?: EncodedWorkspaceGossipPayload;
  /** @deprecated Use gossipPayload.message. */
  gossipMessage?: Uint8Array;
  promotedAllRoots: boolean;
  shareOperationId?: string;
};

/** Snapshot caller-owned collections before waiting on the lifecycle lock. */
export function snapshotPublisherPromoteOptions(opts?: PublisherAssertionPromoteOptions): PublisherAssertionPromoteOptions | undefined {
  return opts ? { ...opts,
    ...(opts.recoveryBinding ? { recoveryBinding: validatePromoteRecoveryBinding(opts.recoveryBinding) } : {}),
    ...(Array.isArray(opts.entities) ? { entities: [...opts.entities] } : {}),
    ...(opts.allowedPeers ? { allowedPeers: [...opts.allowedPeers] } : {}),
    ...(opts.trustedNonManifestCatalogTriples ? { trustedNonManifestCatalogTriples: new Set(opts.trustedNonManifestCatalogTriples) } : {}),
  } : undefined;
}
