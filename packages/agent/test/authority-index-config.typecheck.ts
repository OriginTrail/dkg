// SPDX-License-Identifier: Apache-2.0

import {
  planAuthorityIndexBootstrap,
  resolveAuthorityIndexConfig,
  type AuthorityIndexBootstrapPlan,
  type DKGAgentConfig,
  type ResolvedAuthorityIndexConfig,
} from '../src/index.js';

declare const rawConfig: unknown;

resolveAuthorityIndexConfig(rawConfig, 'edge');
resolveAuthorityIndexConfig(rawConfig, 'core');
// @ts-expect-error The caller must supply a role so core nodes cannot silently default to edge.
resolveAuthorityIndexConfig(rawConfig);

// The daemon plans from the very config it hands DKGAgent.create.
declare const agentConfig: DKGAgentConfig;
const plan: AuthorityIndexBootstrapPlan = planAuthorityIndexBootstrap(agentConfig);
if (plan.source !== 'local-history') {
  const seeded: ResolvedAuthorityIndexConfig = plan.config;
  void seeded;
} else {
  const reason: string | undefined = plan.skipReason;
  void reason;
}
// @ts-expect-error Only a local-history plan can explain a skipped default.
void plan.skipReason;
