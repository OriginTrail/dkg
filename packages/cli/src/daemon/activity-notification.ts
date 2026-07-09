/**
 * Shared emitter for `assertion_activity` notification rows (ADR-002,
 * notifications-pane redesign).
 *
 * Activity (assertion created / promoted / published) is recorded as a
 * first-class notification row at WRITE TIME, where the actor is a member of
 * the context graph by construction — so the row is born membership-scoped
 * with no read-time join and no per-CG SPARQL fan-out. Three call sites use
 * this one helper so the row shape stays identical across them:
 *   - `routes/assertion.ts`  → `created`, `promoted`   (local writes)
 *   - `routes/memory.ts`     → `published`             (local SWM→VM publish)
 *   - `daemon/lifecycle.ts`  → `published` (REMOTE-ONLY, membership-gated)
 *     for cross-node activity gossiped/synced from a collaborator's node.
 *
 * What's stored vs derived:
 *   - The ATOMIC row carries the single actor that produced it
 *     (`actorAgentDid`) + the lifecycle `kind` + raw counts. One row per
 *     event.
 *   - `count`, `soleAuthor`, and display names (`contextGraphName`,
 *     `actorAgentName`) are DERIVED on read by the scoped digest-collapse
 *     in `GET /api/notifications` (A4) — they are NOT stored here. This
 *     keeps the persisted row truthful (one event = one row) and lets the
 *     read path group `(contextGraphId, kind, windowBucket)` and decide
 *     self-suppression/sole-author against the *reading* agent.
 */

import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { ASSERTION_ACTIVITY_TYPE, PCA_COST_COVERED_TYPE, type AssertionActivityKind } from '@origintrail-official/dkg-node-ui';

/**
 * Cheap local membership gate for the cross-node (gossip) activity emitter
 * (CR-2). A REMOTE publish overheard via gossip should only become an
 * activity row when this node is genuinely involved in the CG — not for
 * every CG it merely overhears. "Involved" = the local membership cache has
 * at least one ACTIVE membership row for the CG (this node and/or a local
 * agent participant). This is an O(rows-for-cg) read against the indexed
 * `context_graph_memberships` table, not a SPARQL fan-out.
 *
 * Defense-in-depth only: `GET /api/notifications` (A4) re-filters every row
 * against the *caller's* member set, so a too-permissive gate here cannot
 * leak a row to a non-member reader — it would just store an unread row that
 * the scoped read drops. We still gate to keep the table from accumulating
 * activity for unrelated CGs.
 */
export function localNodeInvolvedInContextGraph(
  dashDb: Pick<DashboardDB, 'listContextGraphMembers'>,
  contextGraphId: string,
): boolean {
  const cg = contextGraphId?.trim();
  if (!cg) return false;
  const members = dashDb.listContextGraphMembers(cg);
  return members.some((m) => m.status === 'active');
}

const AGENT_DID_PREFIX = 'did:dkg:agent:';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Coerce an actor identity (an EVM address, a bare `did:dkg:agent:…` DID, or
 * a peer-id-based DID) into the canonical `did:dkg:agent:<id>` form the rest
 * of the UI resolves agent profiles against. Returns undefined for an
 * empty/whitespace actor so the caller can omit the field.
 */
export function toActorAgentDid(actor: string | null | undefined): string | undefined {
  if (actor == null) return undefined;
  const trimmed = actor.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(AGENT_DID_PREFIX)) {
    const rest = trimmed.slice(AGENT_DID_PREFIX.length);
    return EVM_ADDRESS_RE.test(rest) ? `${AGENT_DID_PREFIX}${rest.toLowerCase()}` : trimmed;
  }
  if (EVM_ADDRESS_RE.test(trimmed)) return `${AGENT_DID_PREFIX}${trimmed.toLowerCase()}`;
  // Peer-id-based or other identifier — wrap so it's still an agent DID.
  return `${AGENT_DID_PREFIX}${trimmed}`;
}

export interface AssertionActivityInput {
  contextGraphId: string;
  kind: AssertionActivityKind;
  /** Actor EVM address or DID. Omitted-resolution → row with null actor. */
  actorAgentAddress?: string | null;
  /** Sub-graph slug if the assertion is sub-graph-scoped. */
  subGraphName?: string;
  /** Triples written/published, when known. */
  tripleCount?: number;
  /** Root entities in a promoted/published bundle, when known. */
  entityCount?: number;
}

/**
 * Build + insert one atomic `assertion_activity` notification row. Resilient:
 * a malformed `contextGraphId` is a no-op (returns null) and any DB error is
 * swallowed by the caller's surrounding try/catch — activity notifications
 * must never break a write/publish/gossip path.
 *
 * Returns the inserted row id, or null when nothing was written.
 */
export function recordAssertionActivity(
  dashDb: Pick<DashboardDB, 'insertNotification'>,
  input: AssertionActivityInput,
): number | null {
  const contextGraphId = input.contextGraphId?.trim();
  if (!contextGraphId) return null;
  const actorAgentDid = toActorAgentDid(input.actorAgentAddress);
  const meta: Record<string, unknown> = {
    contextGraphId,
    kind: input.kind,
  };
  if (actorAgentDid) meta.actorAgentDid = actorAgentDid;
  if (input.subGraphName) meta.subGraph = input.subGraphName;
  if (typeof input.tripleCount === 'number') meta.tripleCount = input.tripleCount;
  if (typeof input.entityCount === 'number') meta.entityCount = input.entityCount;

  return dashDb.insertNotification({
    ts: Date.now(),
    type: ASSERTION_ACTIVITY_TYPE,
    // title/message are not the pane's display source (the pane renders from
    // the typed `meta` digest), but the schema requires them and they remain
    // useful for any generic log/inspection of the table.
    title: 'Assertion activity',
    message: `Assertion ${input.kind} in ${contextGraphId}`,
    source: 'activity',
    contextGraphId,
    meta: JSON.stringify(meta),
  });
}

export interface ConvictionCostCoveredInput {
  contextGraphId: string;
  /** The publishing wallet (publish msg.sender) — the bell is scoped to it. */
  publisherAddress: string;
  accountId: bigint | string;
  epoch: number;
  baseCost: bigint | string;
  discountedCost: bigint | string;
  drawnFromEpoch: bigint | string;
  drawnFromTopUp: bigint | string;
}

/**
 * B8 confirmed-discount bell — record one `pca_cost_covered` row when a publish
 * drew on a Publishing Conviction Account (the adapter decoded the on-chain
 * CostCovered event). Wallet-scoped: the read path (`scopeNotifications`) only
 * surfaces it to the publishing wallet (the discount is that wallet's business,
 * not the whole CG's — invariant 3), upgrading the P0 predictive alert to a
 * server-confirmed one. Resilient: a malformed CG / non-address publisher is a
 * no-op (null) and the caller's try/catch swallows DB errors — the bell must
 * never break a publish. Returns the inserted row id, or null.
 */
export function recordConvictionCostCovered(
  dashDb: Pick<DashboardDB, 'insertNotification'>,
  input: ConvictionCostCoveredInput,
): number | null {
  const contextGraphId = input.contextGraphId?.trim();
  if (!contextGraphId) return null;
  const publisher = input.publisherAddress?.trim();
  if (!publisher || !EVM_ADDRESS_RE.test(publisher)) return null;
  const accountId = String(input.accountId);
  const meta = {
    publisherAddress: publisher.toLowerCase(),
    accountId,
    epoch: input.epoch,
    baseCost: String(input.baseCost),
    discountedCost: String(input.discountedCost),
    drawnFromEpoch: String(input.drawnFromEpoch),
    drawnFromTopUp: String(input.drawnFromTopUp),
  };
  return dashDb.insertNotification({
    ts: Date.now(),
    type: PCA_COST_COVERED_TYPE,
    // Display is rendered from the typed meta; title/message satisfy the schema
    // and remain useful for generic log inspection.
    title: 'Publishing discount applied',
    message: `Publish to ${contextGraphId} drew on PCA #${accountId}`,
    source: 'pca',
    contextGraphId,
    meta: JSON.stringify(meta),
  });
}
