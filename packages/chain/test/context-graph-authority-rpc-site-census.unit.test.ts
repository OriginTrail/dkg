// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// The handover prose says "eleven", but its concrete file:line census names
// fourteen references. The explicit census is the release gate.
const residualCensus = [
  ['packages/publisher/src/workspace-handler.ts', 'workspaceApply', 'this.getContextGraphAgentGateAddresses'],
  ['packages/publisher/src/workspace-handler.ts', 'hostEnvelope', 'this.getContextGraphAgentGateAddresses'],
  ['packages/agent/src/dkg-agent-query.ts', 'readRegistered', 'this.resolveRegisteredContextGraphAuthority'],
  ['packages/agent/src/dkg-agent-query.ts', 'readLocalGate', 'this.getContextGraphAgentGateAddresses'],
  ['packages/agent/src/dkg-agent-lifecycle.ts', 'remoteQuery', 'this.isContextGraphPublicOnChain'],
  ['packages/agent/src/dkg-agent-lifecycle.ts', 'joinResume', 'this.resolveContextGraphReadAuthority'],
  ['packages/agent/src/dkg-agent-lifecycle.ts', 'sharedMemoryRead', 'this.canReadContextGraph'],
  ['packages/agent/src/dkg-agent-cg-registry.ts', 'samplingBinding', 'this.readLiveOnChainAccessPolicy'],
  ['packages/agent/src/dkg-agent-join.ts', 'joinPolicyRoster', 'this.getMemberRecoveryGate'],
  ['packages/agent/src/dkg-agent-join.ts', 'joinAdmissionRoster', 'this.getMemberRecoveryGate'],
  ['packages/agent/src/dkg-agent-context-graph.ts', 'memberAdd', 'this.resolveRegisteredContextGraphAuthority'],
  ['packages/agent/src/dkg-agent-context-graph.ts', 'memberRemove', 'this.resolveRegisteredContextGraphAuthority'],
  ['packages/cli/src/daemon/routes/query-catalog.ts', 'queryCatalog', 'agent.canReadContextGraph'],
  ['packages/cli/src/daemon/routes/memory.ts', 'memorySearch', 'agent.resolveContextGraphReadAuthority'],
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Context Graph authority RPC residual-site census', () => {
  it.each(residualCensus)(
    '%s: %s labels %s',
    (relativePath, site, callee) => {
      const source = readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8');
      expect(source).toMatch(new RegExp(
        `withRpcUsageSite\\(\\s*CG_AUTH_RPC_SITES\\.${site},\\s*\\(\\) => ${escapeRegExp(callee)}\\(`,
      ));
    },
  );
});
