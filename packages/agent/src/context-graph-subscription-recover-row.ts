import { sameDurableSubscriptionIntent } from './context-graph-subscription-policy.js';
// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import { SubscriptionActivationCapacityError } from './context-graph-subscription-activation-capacity.js';
import { contextGraphDormancyAfterAuthority, type ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';

export type SubscriptionRecoveryOutcome =
  | { kind: 'activated' }
  | { kind: 'retry'; why: string; activationFailed?: true }
  | { kind: 'again' }
  | { kind: 'done' };

/** Row policy is shared by the periodic and startup-name-binding schedulers. */
export interface SubscriptionRecoveryRowPorts {
  isCurrent(): boolean;
  dormancy(id: string): ContextGraphDormancyReason | undefined;
  revision(id: string): number;
  subscription(id: string): ContextGraphSub | undefined;
  load(id: string): Promise<ContextGraphSubscriptionRecord | null>;
  resolveAuthority(row: ContextGraphSubscriptionRecord, signal: AbortSignal): Promise<ContextGraphReadAuthorityDecision>;
  clear(id: string, revoked?: boolean): void;
  retire(id: string, reason: ContextGraphDormancyReason, authority?: Exclude<ContextGraphReadAuthorityDecision, { outcome: 'allowed' }>): void;
  unavailable?(id: string, authority: Exclude<ContextGraphReadAuthorityDecision, { outcome: 'allowed' }>): void;
  canActivate?(): boolean;
  capped(id: string): void;
  /** The activation owner atomically checks/reserves capacity before asynchronous preparation. */
  activate(row: ContextGraphSubscriptionRecord, onChainId: string | undefined, revision: number,
    isCurrent: () => boolean): Promise<void>;
}

function hasIntent(row: ContextGraphSubscriptionRecord | null): row is ContextGraphSubscriptionRecord {
  return row !== null && (row.subscribed || row.coreHosted === true);
}

/** One authority observation may commit only to the exact durable intent it checked. */
export async function recoverPersistedSubscriptionRow(
  id: string, ports: SubscriptionRecoveryRowPorts, signal: AbortSignal,
  options: { snapshot?: { row: ContextGraphSubscriptionRecord | null; revision: number };
    reason?: ContextGraphDormancyReason; verifiedOnChainId?: string } = {},
): Promise<SubscriptionRecoveryOutcome> {
  const { snapshot, reason = 'authorityUnavailable', verifiedOnChainId } = options;
  const current = () => !signal.aborted && ports.isCurrent() && ports.dormancy(id) === reason;
  if (!current()) return { kind: 'done' };
  const revision = snapshot?.revision ?? ports.revision(id);
  const row = snapshot ? snapshot.row : await ports.load(id);
  if (!current()) return { kind: 'done' };
  if (!hasIntent(row)) { ports.clear(id, row !== null); return { kind: 'done' }; }
  if (verifiedOnChainId !== undefined && row.onChainId !== undefined && row.onChainId !== verifiedOnChainId) return { kind: 'done' };
  const bound = verifiedOnChainId === undefined || row.onChainId !== undefined ? row : { ...row, onChainId: verifiedOnChainId };
  const authority = await ports.resolveAuthority(bound, signal);
  if (!current()) return { kind: 'done' };
  const fresh = await ports.load(id);
  if (!current()) return { kind: 'done' };
  if (!hasIntent(fresh)) { ports.clear(id, fresh !== null); return { kind: 'done' }; }
  if (ports.revision(id) !== revision || !sameDurableSubscriptionIntent(row, fresh)) return { kind: 'again' };
  // Another activation may own a provisional row. Its owner alone commits or rolls it back.
  const live = ports.subscription(id);
  if (live?.subscribed || live?.coreHosted) return { kind: 'again' };
  if (authority.outcome !== 'allowed') {
    const reason = contextGraphDormancyAfterAuthority(authority);
    if (reason === 'authorityUnavailable') {
      ports.unavailable?.(id, authority);
      return { kind: 'retry', why: `${authority.outcome} by ${authority.source} (${authority.reason})` };
    }
    ports.retire(id, reason, authority);
    return { kind: 'done' };
  }
  if (ports.canActivate && !ports.canActivate()) return { kind: 'again' };
  const valid = () => current() && ports.revision(id) === revision;
  try {
    await ports.activate(fresh, authority.onChainId?.toString() ?? bound.onChainId, revision, valid);
  } catch (error) {
    if (!current()) return { kind: 'done' };
    if (error instanceof SubscriptionActivationCapacityError) { ports.capped(id); return { kind: 'done' }; }
    return { kind: 'retry', why: error instanceof Error ? error.message : String(error), activationFailed: true };
  }
  return { kind: 'activated' };
}
