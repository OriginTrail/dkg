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
  clear(id: string): void;
  retire(id: string, reason: ContextGraphDormancyReason): void;
  capped(id: string): void;
  /** The activation owner atomically checks/reserves capacity before asynchronous preparation. */
  activate(row: ContextGraphSubscriptionRecord, onChainId: string | undefined, revision: number,
    isCurrent: () => boolean): Promise<void>;
}

function hasIntent(row: ContextGraphSubscriptionRecord | null): row is ContextGraphSubscriptionRecord {
  return row !== null && (row.subscribed || row.coreHosted === true);
}

/** One authority observation may commit only to the exact durable intent it checked. */
export async function recoverUnavailableSubscriptionRow(
  id: string, ports: SubscriptionRecoveryRowPorts, signal: AbortSignal,
  snapshot?: { row: ContextGraphSubscriptionRecord | null; revision: number },
): Promise<SubscriptionRecoveryOutcome> {
  const current = () => !signal.aborted && ports.isCurrent() && ports.dormancy(id) === 'authorityUnavailable';
  if (!current()) return { kind: 'done' };
  const revision = snapshot?.revision ?? ports.revision(id);
  const row = snapshot ? snapshot.row : await ports.load(id);
  if (!current()) return { kind: 'done' };
  if (!hasIntent(row)) { ports.clear(id); return { kind: 'done' }; }
  const authority = await ports.resolveAuthority(row, signal);
  if (!current()) return { kind: 'done' };
  const fresh = await ports.load(id);
  if (!current()) return { kind: 'done' };
  if (!hasIntent(fresh)) { ports.clear(id); return { kind: 'done' }; }
  if (ports.revision(id) !== revision || !sameDurableSubscriptionIntent(row, fresh)) return { kind: 'again' };
  // Another activation may own a provisional row. Its owner alone commits or rolls it back.
  const live = ports.subscription(id);
  if (live?.subscribed || live?.coreHosted) return { kind: 'done' };
  if (authority.outcome !== 'allowed') {
    const reason = contextGraphDormancyAfterAuthority(authority);
    if (reason === 'authorityUnavailable') {
      return { kind: 'retry', why: `${authority.outcome} by ${authority.source} (${authority.reason})` };
    }
    ports.retire(id, reason);
    return { kind: 'done' };
  }
  try {
    await ports.activate(fresh, authority.onChainId?.toString() ?? fresh.onChainId, revision, current);
  } catch (error) {
    if (!current()) return { kind: 'done' };
    if (error instanceof SubscriptionActivationCapacityError) { ports.capped(id); return { kind: 'done' }; }
    return { kind: 'retry', why: error instanceof Error ? error.message : String(error), activationFailed: true };
  }
  return { kind: 'activated' };
}
