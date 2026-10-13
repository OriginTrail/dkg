import type { AuthenticatedGraphScopedAsset, VerifiedGraphScopedAsset } from './sync/requester/graph-scoped-materialization.js';

/** One policy owns public transport admission and authentication of recovered assets.
 * Exchange policy retains VM-pass freshness/revocation; a snapshot job is pinned
 * to its observation and ownership, and is never disguised as revocable VM evidence.
 */
export interface DurableRecoveryAuthority {
  readonly lifetime: 'exchange' | 'snapshot-job';
  isRegisteredPublic(contextGraphId: string, signal?: AbortSignal): boolean | Promise<boolean>;
  authenticate(asset: VerifiedGraphScopedAsset, deadline: number, signal?: AbortSignal):
    AuthenticatedGraphScopedAsset | Promise<AuthenticatedGraphScopedAsset>;
}
