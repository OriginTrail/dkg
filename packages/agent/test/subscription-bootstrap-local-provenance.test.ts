// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import { selectedFixture } from './context-graph-registration-binding.fixture.js';

const CG_ID = 'newly-registered-private-graph';

function admissionAgent() {
  const agent = selectedFixture(null).agent as unknown as DKGAgent;
  vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'unregistered' });
  vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);
  return agent;
}

describe('subscription bootstrap local provenance', () => {
  it('does not persist a remote graph through a temporary legacy-public fallback', async () => {
    const agent = admissionAgent();

    await expect(agent.resolveContextGraphSubscriptionBootstrapAuthority(CG_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'legacy-local',
      reason: 'remote-local-authority-unaccepted',
      dependency: 'local-state',
    });
  });

  it('preserves the local creator path while the graph is unregistered', async () => {
    const agent = admissionAgent();
    agent.localContextGraphProvenance.recordLocalCreate(CG_ID);

    await expect(agent.resolveContextGraphSubscriptionBootstrapAuthority(CG_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'legacy-local',
      reason: 'local-public',
    });
  });

  it('admits the remote graph once registered chain authority proves it public', async () => {
    const agent = admissionAgent();
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({
      kind: 'public',
      onChainId: 22n,
    });

    await expect(agent.resolveContextGraphSubscriptionBootstrapAuthority(CG_ID, {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      onChainId: 22n,
    });
  });
});
