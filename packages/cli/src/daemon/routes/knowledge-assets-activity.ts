// SPDX-License-Identifier: Apache-2.0
import type { RequestContext } from "./context.js";
import { recordAssertionActivity, recordConvictionCostCovered } from "../activity-notification.js";

// Best-effort assertion-activity row + notification SSE for a lifecycle event.
// Never throws — activity tracking must not break a write/publish path.
export function recordActivityAndNotify(
  ctx: RequestContext,
  input: {
    contextGraphId: string;
    kind: "created" | "promoted" | "published";
    actorAgentAddress: string;
    subGraphName?: string;
    tripleCount?: number;
  },
): void {
  try {
    recordAssertionActivity(ctx.dashDb, {
      contextGraphId: input.contextGraphId,
      kind: input.kind,
      actorAgentAddress: input.actorAgentAddress,
      subGraphName: input.subGraphName,
      ...(typeof input.tripleCount === "number" ? { tripleCount: input.tripleCount } : {}),
    });
    ctx.emitNotification?.({ contextGraphId: input.contextGraphId, type: "assertion_activity" });
  } catch {
    /* activity/notification is advisory — never block the lifecycle op */
  }
}
export function recordPcaDiscount(ctx: RequestContext, contextGraphId: string, onChain: any): void {
  const cc = onChain?.convictionCostCovered;
  const publisher = onChain?.publisherAddress;
  if (!cc || !publisher) return;
  try {
    recordConvictionCostCovered(ctx.dashDb, {
      contextGraphId,
      publisherAddress: publisher,
      accountId: cc.accountId,
      epoch: cc.epoch,
      baseCost: cc.baseCost,
      discountedCost: cc.discountedCost,
      drawnFromEpoch: cc.drawnFromEpoch,
      drawnFromTopUp: cc.drawnFromTopUp,
    });
    ctx.emitNotification?.({ contextGraphId, type: "pca_cost_covered" });
  } catch {
    /* confirmed-discount notification is advisory */
  }
}
