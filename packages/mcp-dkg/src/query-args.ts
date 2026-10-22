// SPDX-License-Identifier: Apache-2.0

/** Public arguments accepted by the MCP daemon query client. */
export interface QueryArgs {
  sparql: string;
  contextGraphId?: string;
  subGraphName?: string;
  graphSuffix?: '_shared_memory' | '_shared_memory_meta';
  includeSharedMemory?: boolean;
  includeContextGraphPartitions?: boolean;
  includeSharedMemoryMeta?: boolean;
  view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
  verifiedGraph?: string;
  assertionName?: string;
  /**
   * Required for `view: "working-memory"` reads. The daemon scopes WM
   * assertion-graph URIs to the agent's raw peer ID — DID-form values
   * route to a non-existent namespace and silently return empty
   * results. Pass the bare peer ID (strip any `did:dkg:agent:` prefix
   * at the boundary; see `dkg_memory_search` for an example).
   */
  agentAddress?: string;
  /**
   * P-13: minimum trust level to admit into results. Only meaningful for
   * `view: "verifiable-memory"`; silently ignored on WM/SWM views.
   *
   * The daemon currently implements only `SelfAttested` (0) and
   * `Endorsed` (1) — the higher tiers are tracked by Q-1 (per-graph
   * trust tagging) and will be accepted once that ships. Until then
   * the daemon returns HTTP 400 on `PartiallyVerified` / `ConsensusVerified`,
   * so the public client type only advertises the two values the
   * server actually honours to avoid documented-yet-failing inputs.
   */
  minTrust?: 'SelfAttested' | 'Endorsed' | 0 | 1;
}
