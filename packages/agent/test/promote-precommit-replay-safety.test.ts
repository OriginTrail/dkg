import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChainRpcTransportError,
  MockChainAdapter,
  type ChainRpcTransportCode,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  getAgentPromoteReplaySafeErrorDiagnostic,
  isAgentPromotePreCommitReplaySafeError,
} from '../src/promote-precommit-replay-safety.js';

const CG = 'registered-promote-rpc-outage';

describe('agent promote pre-commit chain replay boundary', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
    agent = null;
  });

  async function makeAgent(options: { stubRegistration?: boolean } = {}) {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PromotePreCommitReplaySafety',
      chainAdapter: chain,
    });
    await agent.start();
    vi.spyOn(agent, 'prepareAtomicAssertionShare').mockResolvedValue(undefined);
    if (options.stubRegistration !== false) {
      vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
        kind: 'registered',
        onChainId: 7n,
        provenance: 'numeric-id',
      });
    }
    const publisherPromote = vi.spyOn(agent.publisher, 'assertionPromote');
    return { agent, chain, publisherPromote };
  }

  async function capturePromoteError(current: DKGAgent): Promise<unknown> {
    try {
      await current.assertion.promote(CG, 'asset');
      throw new Error('expected promote to reject');
    } catch (error) {
      return error;
    }
  }

  it.each([
    'RPC_ENDPOINTS_EXHAUSTED',
    'RPC_RECEIPT_LOOKUP_FAILED',
    'RPC_TIMEOUT',
  ] as const)('certifies an access-policy %s outage before publisher mutation', async (code) => {
    const fixture = await makeAgent();
    vi.spyOn(fixture.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(
      new ChainRpcTransportError(code, 'access-policy transport outage'),
    );

    const error = await capturePromoteError(fixture.agent);

    expect(isAgentPromotePreCommitReplaySafeError(error)).toBe(true);
    expect(getAgentPromoteReplaySafeErrorDiagnostic(error)).toEqual({
      name: 'PromoteReplaySafeError',
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
    });
    expect(error).toMatchObject({ code });
    expect(fixture.publisherPromote).not.toHaveBeenCalled();
  });

  it.each([
    'RPC_ENDPOINTS_EXHAUSTED',
    'RPC_RECEIPT_LOOKUP_FAILED',
    'RPC_TIMEOUT',
  ] as const)('certifies a registration-binding %s outage before publisher mutation', async (code) => {
    const fixture = await makeAgent({ stubRegistration: false });
    vi.spyOn(fixture.chain, 'resolveContextGraphIdByNameHash').mockRejectedValue(
      new ChainRpcTransportError(code, 'registration transport outage'),
    );

    const error = await capturePromoteError(fixture.agent);

    expect(isAgentPromotePreCommitReplaySafeError(error)).toBe(true);
    expect(error).toMatchObject({ code });
    expect(fixture.publisherPromote).not.toHaveBeenCalled();
  });

  it.each([
    'RPC_ENDPOINTS_EXHAUSTED',
    'RPC_RECEIPT_LOOKUP_FAILED',
    'RPC_TIMEOUT',
  ] as const)('certifies a private participant-roster %s outage before publisher mutation', async (code: ChainRpcTransportCode) => {
    const fixture = await makeAgent();
    vi.spyOn(fixture.agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(fixture.chain, 'getContextGraphParticipantAgents').mockRejectedValue(
      new ChainRpcTransportError(code, 'participant-roster transport outage'),
    );

    const error = await capturePromoteError(fixture.agent);

    expect(isAgentPromotePreCommitReplaySafeError(error)).toBe(true);
    expect(error).toMatchObject({ code });
    expect(fixture.publisherPromote).not.toHaveBeenCalled();
  });

  it('does not certify an untyped authority failure', async () => {
    const fixture = await makeAgent();
    vi.spyOn(fixture.agent, 'readLiveOnChainAccessPolicy').mockRejectedValue(
      new Error('authorization failed'),
    );

    const error = await capturePromoteError(fixture.agent);

    expect(isAgentPromotePreCommitReplaySafeError(error)).toBe(false);
    expect(fixture.publisherPromote).not.toHaveBeenCalled();
  });
});
