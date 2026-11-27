import { describe, expect, it } from 'vitest';
import {
  createAllowedHttpAuthentication,
} from '../src/auth.js';

describe('request authentication invariants', () => {
  it.each([
    { mode: 'public' as const, presentedToken: 'agent-token' },
    { mode: 'disabled' as const, presentedToken: 'agent-token' },
    { mode: 'authenticated' as const, presentedToken: undefined },
  ])('classifies an accepted agent bearer in $mode mode', ({ mode, presentedToken }) => {
    const authentication = createAllowedHttpAuthentication({
      mode,
      presentedToken,
      acceptedToken: 'agent-token',
      resolveAgentByToken: () => 'did:dkg:agent:alice',
    });

    expect(authentication).toMatchObject({
      mode,
      acceptedToken: 'agent-token',
      principal: { kind: 'agent', agentAddress: 'did:dkg:agent:alice' },
    });
  });

  it('classifies an accepted bearer with no agent binding as the node operator', () => {
    expect(createAllowedHttpAuthentication({
      mode: 'authenticated',
      acceptedToken: 'node-token',
      resolveAgentByToken: () => undefined,
    })).toMatchObject({
      acceptedToken: 'node-token',
      principal: { kind: 'nodeOperator' },
    });
  });
});
