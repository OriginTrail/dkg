import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type {
  ContextGraphReadinessProvenance,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';

export const CONTEXT_GRAPH_READINESS_VERSION = 1;

export type ContextGraphReadinessStore = Pick<
  DashboardDB,
  'getContextGraphReadinessProvenance' | 'setContextGraphReadinessProvenance'
>;

export interface CatchupPlaneDiagnostics {
  timedOutPhases?: number;
  completedPhases?: number;
  failedPeers?: number;
  failedPhases?: number;
  deniedPhases?: number;
}

export function catchupPlaneCompletedWithoutFailure(
  diagnostics: CatchupPlaneDiagnostics | null | undefined,
): boolean {
  return diagnostics != null
    && (diagnostics.completedPhases ?? 0) > 0
    && (diagnostics.timedOutPhases ?? 0) === 0
    && (diagnostics.failedPeers ?? 0) === 0
    && (diagnostics.failedPhases ?? 0) === 0
    && (diagnostics.deniedPhases ?? 0) === 0;
}

export function readContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
): ContextGraphReadinessProvenance {
  const stored = store.getContextGraphReadinessProvenance?.(contextGraphId);
  return stored ?? {
    version: 0,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 0,
  };
}

export function writeContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  readiness: Pick<ContextGraphReadinessProvenance, 'durableVerified' | 'sharedMemoryVerified'>,
): void {
  store.setContextGraphReadinessProvenance?.(contextGraphId, {
    version: CONTEXT_GRAPH_READINESS_VERSION,
    durableVerified: readiness.durableVerified,
    sharedMemoryVerified: readiness.sharedMemoryVerified,
  });
}

/**
 * One-time migration for subscription flags written before readiness carried
 * durable per-plane proof. Private/unconfirmed rows fail closed and must
 * complete a new catch-up. Confirmed public rows retain historical clean-empty
 * compatibility and receive provenance matching their already-persisted bits.
 */
export async function migrateLegacyContextGraphReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  log: (message: string) => void;
  durableJoinApprovedContextGraphIds?: ReadonlySet<string>;
}): Promise<void> {
  const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

  for (const [contextGraphId, subscription] of input.agent.getSubscribedContextGraphs()) {
    if (systemContextGraphs.has(contextGraphId)) continue;
    const stored = readContextGraphReadiness(input.store, contextGraphId);
    if (stored.version >= CONTEXT_GRAPH_READINESS_VERSION) continue;

    // Locally curated graphs and memberships admitted by the new durable
    // join-approved flow have an authoritative source for their persisted
    // readiness bits. Resetting either class would strand a curator's own
    // private graph, or throw away a clean post-approval recovery merely
    // because the daemon restarted before the HTTP route could observe it.
    const locallyCurated = typeof input.agent.isCuratorOf === 'function'
      ? await input.agent.isCuratorOf(contextGraphId).catch(() => false)
      : false;
    const durablyJoinApproved = input.durableJoinApprovedContextGraphIds?.has(contextGraphId) === true;
    if (locallyCurated || durablyJoinApproved) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(
        `Preserved ${locallyCurated ? 'locally curated' : 'durably join-approved'} ` +
        `context-graph readiness during provenance migration: ${contextGraphId}`,
      );
      continue;
    }

    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(contextGraphId)
      .catch(() => false);
    const locallyPrivate = hasConfirmedMeta
      ? await input.agent.isPrivateContextGraph(contextGraphId).catch(() => true)
      : true;
    const onChainPolicy = typeof input.agent.getContextGraphOnChainPolicy === 'function'
      ? await input.agent.getContextGraphOnChainPolicy(contextGraphId).catch(() => ({}))
      : {};
    const chainPrivate = (onChainPolicy as { accessPolicy?: number }).accessPolicy === 1;
    const confirmedPublic = !chainPrivate && hasConfirmedMeta && !locallyPrivate;

    if (confirmedPublic) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(`Preserved confirmed public context-graph readiness during provenance migration: ${contextGraphId}`);
      continue;
    }

    const authoritativePrivateMeta = hasConfirmedMeta && locallyPrivate;
    input.agent.markContextGraphSubscriptionState(contextGraphId, {
      synced: false,
      sharedMemorySynced: false,
      metaSynced: authoritativePrivateMeta,
      pendingMeta: !authoritativePrivateMeta,
    });
    writeContextGraphReadiness(input.store, contextGraphId, {
      durableVerified: false,
      sharedMemoryVerified: false,
    });
    input.log(`Reset legacy unproven context-graph readiness: ${contextGraphId}`);
  }
}
