// SPDX-License-Identifier: Apache-2.0
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core';

/** Options of `DkgDaemonClient.query`, forwarded to the daemon's `/api/query`. */
export interface DkgQueryOptions {
  contextGraphId?: string;
  graphSuffix?: string;
  includeSharedMemory?: boolean;
  view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
  /** How a view query matches its patterns: `merged` across the view's assets, or `per-asset`. */
  semantics?: ViewQuerySemantics;
  agentAddress?: string;
  assertionName?: string;
  subGraphName?: string;
  verifiedGraph?: string;
  /**
   * P-13: minimum trust level. Only meaningful for
   * `view: "verifiable-memory"`; ignored (silently) on WM/SWM views.
   *
   * The daemon implements only `SelfAttested` / `Endorsed` today --
   * higher tiers (Q-1 follow-up) are rejected with HTTP 400, so the
   * public client surface only advertises the implementable values.
   * See `packages/query/src/query-engine.ts QueryOptions.minTrust`.
   */
  minTrust?: 'SelfAttested' | 'Endorsed' | 0 | 1;
}
