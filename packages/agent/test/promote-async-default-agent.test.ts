import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  getPromoteRetryableFailureDiagnostic,
  isPromoteRetryableFailure,
} from '@origintrail-official/dkg-publisher';
import { ContextGraphAuthorityUnavailableError } from
  '../src/context-graph-authority-unavailable-error.js';
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

    expect(isPromoteRetryableFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: authorityFailure });
    expect(getPromoteRetryableFailureDiagnostic(failure)).toEqual({
      name: 'PromoteRetryableFailureError',
      code: 'PROMOTE_RETRYABLE_FAILURE',
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

    expect(isPromoteRetryableFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: authorityFailure });
  });

  it('leaves an authoritative empty signing roster terminal and unmarked', async () => {
    const emptyRoster = new Error('authoritative signing roster is empty');
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => { throw emptyRoster; };

    const failure = await agent.assertion.promote('cg-1', 'asset-1')
      .catch((error: unknown) => error);

    expect(failure).toBe(emptyRoster);
    expect(isPromoteRetryableFailure(failure)).toBe(false);
  });
});
