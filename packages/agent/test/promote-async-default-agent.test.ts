import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
} from '@origintrail-official/dkg-publisher';
import { ContextGraphAuthorityUnavailableError } from
  '../src/context-graph-agent-gate-authority.js';
import { DKGAgent } from '../src/dkg-agent.js';

function promoteBoundaryAgent(): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.defaultAgentAddress = `0x${'11'.repeat(20)}`;
  agent.node = {
    peerId: { toString: () => '12D3KooWBoundary' },
  };
  agent.prepareAtomicAssertionShare = async () => undefined;
  agent.buildCuratorAckConfirmer = async () => undefined;
  return agent;
}

describe('DKGAgent assertion promote boundary', () => {
  it('enqueues omitted agentAddress as the effective default agent lane', async () => {
    const defaultAgentAddress = `0x${'11'.repeat(20)}`;
    const enqueued: unknown[] = [];
    const agent = Object.create(DKGAgent.prototype) as any;

    agent.defaultAgentAddress = defaultAgentAddress;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent._promoteQueue = {
      enqueue: async (request: unknown) => {
        enqueued.push(request);
        return 'job-1';
      },
    };

    const result = await agent.assertion.promoteAsync('cg-1', 'asset-1');

    expect(result).toEqual({ jobId: 'job-1' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      contextGraphId: 'cg-1',
      assertionName: 'asset-1',
      entities: 'all',
      agentAddress: defaultAgentAddress,
    });
  });

  it('translates a signer authority outage into the generic queue retry contract', async () => {
    const authorityFailure = new ContextGraphAuthorityUnavailableError(
      'chain roster read failed with domain detail',
      { reason: 'chain-participant-authority-unavailable' },
    );
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => { throw authorityFailure; };

    const failure = await agent.assertion.promote('cg-1', 'asset-1')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ cause: authorityFailure });
    expect(getPromoteFailureDisposition(failure)).toEqual({
      classification: 'transient',
      retryable: true,
      diagnostic: {
        name: 'PromoteRetryableFailureError',
        code: 'PROMOTE_RETRYABLE_FAILURE',
      },
    });
  });

  it('translates recipient authority outages returned by the publisher boundary', async () => {
    const authorityFailure = new ContextGraphAuthorityUnavailableError(
      'recipient authority is temporarily unavailable',
      { reason: 'chain-participant-authority-unavailable' },
    );
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
    agent.publisher = {
      assertionPromote: async () => { throw authorityFailure; },
    };

    const failure = await agent.assertion.promote('cg-1', 'asset-1', {
      accessPolicy: 'ownerOnly',
    }).catch((error: unknown) => error);

    expect(getPromoteFailureDisposition(failure)).toMatchObject({
      classification: 'transient',
      retryable: true,
    });
    expect(failure).toMatchObject({ cause: authorityFailure });
  });

  it('translates authority outages from pre-commit policy preparation', async () => {
    const authorityFailure = new ContextGraphAuthorityUnavailableError(
      'policy authority is temporarily unavailable',
      { reason: 'chain-access-policy-unavailable' },
    );
    const assertionPromote = vi.fn();
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
    agent.getContextGraphOnChainPolicy = async () => { throw authorityFailure; };
    agent.publisher = { assertionPromote };

    const failure = await agent.assertion.promote('cg-1', 'asset-1')
      .catch((error: unknown) => error);

    expect(getPromoteFailureDisposition(failure)).toMatchObject({
      classification: 'transient',
      retryable: true,
    });
    expect(failure).toMatchObject({ cause: authorityFailure });
    expect(assertionPromote).not.toHaveBeenCalled();
  });

  it('forces a retry-marked post-commit observer failure to remain terminal', async () => {
    const retryableCause = createPromoteRetryableFailure(new Error('observer failed'));
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
    agent.publisher = {
      assertionPromote: async () => ({
        promotedCount: 1,
        gossipPayload: undefined,
        promotedAllRoots: true,
        shareOperationId: 'share-operation-1',
      }),
    };
    agent.afterDurableSwmPromotionV1 = async () => { throw retryableCause; };

    const failure = await agent.assertion.promote('cg-1', 'asset-1', {
      accessPolicy: 'ownerOnly',
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ cause: retryableCause });
    expect(getPromoteFailureDisposition(failure)).toEqual({
      classification: 'fatal',
      retryable: false,
      diagnostic: {
        name: 'PromotePostCommitFailureError',
        code: 'PROMOTE_POST_COMMIT_FAILURE',
      },
    });
  });

  it('leaves an authoritative empty signing roster terminal and unmarked', async () => {
    const emptyRoster = new Error('authoritative signing roster is empty');
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => { throw emptyRoster; };

    const failure = await agent.assertion.promote('cg-1', 'asset-1')
      .catch((error: unknown) => error);

    expect(failure).toBe(emptyRoster);
    expect(getPromoteFailureDisposition(failure)).toBeUndefined();
  });
});
