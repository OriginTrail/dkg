import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  createPromoteRetryableFailure,
  DKGPublisher,
  getPromoteFailureDisposition,
} from '@origintrail-official/dkg-publisher';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { ContextGraphAuthorityUnavailableError } from
  '../src/context-graph-agent-gate-authority.js';
import { DKGAgent } from '../src/dkg-agent.js';
import type { AssertionPromoteOptions } from '../src/index.js';

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
  it.each([
    ['explicit allow-list', { accessPolicy: 'allowList', allowedPeers: ['peer-a'] }, 0, 0, 'allowList'],
    ['chain public', {}, 0, 1, 'public'],
    ['chain private', {}, 1, 0, 'ownerOnly'],
    ['local private fallback', {}, undefined, 1, 'ownerOnly'],
    ['unspecified local public', {}, undefined, 0, undefined],
  ] satisfies [string, AssertionPromoteOptions, number | undefined, number, string | undefined][])(
    'forwards the exact %s access envelope, signer, and confirmer',
    async (_label, accessOptions, chainPolicy, localPolicy, expectedPolicy) => {
      const agent = promoteBoundaryAgent();
      const signer = { agentAddress: `0x${'22'.repeat(20)}` };
      const confirmer = vi.fn(async () => ({ applied: true }));
      agent.resolveWorkspaceGossipSigningAgent = vi.fn(async () => signer);
      agent.buildCuratorAckConfirmer = vi.fn(async () => confirmer);
      agent.getContextGraphOnChainPolicy = vi.fn(async () => ({ accessPolicy: chainPolicy }));
      agent.readLocalAccessPolicyEnum = vi.fn(async () => localPolicy);
      agent.afterDurableSwmPromotionV1 = vi.fn(async () => undefined);
      const assertionPromote = vi.fn(async (..._args: Parameters<DKGPublisher['assertionPromote']>) => ({
        promotedCount: 1, promotedAllRoots: true, shareOperationId: 'share-operation-1',
      }));
      agent.publisher = { assertionPromote };
      const options: AssertionPromoteOptions = {
        ...accessOptions,
        subGraphName: 'documents',
        awaitCuratorAck: true,
        curatorAckTimeoutMs: 4_000,
      };

      await expect(agent.assertion.promote('cg-1', 'asset-1', options)).resolves.toEqual({
        promotedCount: 1, sealed: true, publishReady: true, shareOperationId: 'share-operation-1',
      });
      expect(agent.resolveWorkspaceGossipSigningAgent).toHaveBeenCalledWith('cg-1');
      expect(agent.buildCuratorAckConfirmer).toHaveBeenCalledWith(
        'cg-1', signer, { awaitCuratorAck: true, curatorAckTimeoutMs: 4_000 }, expect.anything(),
      );
      expect(assertionPromote).toHaveBeenCalledExactlyOnceWith(
        'cg-1', 'asset-1', agent.defaultAgentAddress, {
          subGraphName: 'documents',
          publisherPeerId: '12D3KooWBoundary',
          senderAgentAddress: signer.agentAddress,
          confirmBeforeCommit: expect.any(Function),
          resolveWorkspaceRecipients: expect.any(Function),
          ...(expectedPolicy === undefined ? {} : { accessPolicy: expectedPolicy }),
          ...(options.allowedPeers === undefined ? {} : { allowedPeers: ['peer-a'] }),
        },
      );
      const message = new Uint8Array([1, 2, 3]);
      await expect(assertionPromote.mock.calls[0]?.[3]?.confirmBeforeCommit?.(message))
        .resolves.toEqual({ applied: true });
      expect(confirmer).toHaveBeenCalledExactlyOnceWith(message);
      if (options.allowedPeers !== undefined) {
        expect(assertionPromote.mock.calls[0]?.[3]?.allowedPeers).not.toBe(options.allowedPeers);
      }
      expect(agent.getContextGraphOnChainPolicy)
        .toHaveBeenCalledTimes(options.accessPolicy === undefined ? 1 : 0);
      expect(agent.readLocalAccessPolicyEnum)
        .toHaveBeenCalledTimes(options.accessPolicy === undefined && chainPolicy === undefined ? 1 : 0);
    },
  );

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

  it('certifies recipient outages in the concrete agent callback', async () => {
    const authorityFailure = new ContextGraphAuthorityUnavailableError(
      'recipient authority is temporarily unavailable',
      { reason: 'chain-participant-authority-unavailable' },
    );
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
    agent.resolveWorkspaceRecipientsGated = vi.fn(async () => { throw authorityFailure; });
    agent.publisher = {
      assertionPromote: async (_cg: string, _name: string, _agent: string, opts: {
        resolveWorkspaceRecipients: (input: { contextGraphId: string }) => Promise<unknown>;
      }) => {
        await opts.resolveWorkspaceRecipients({ contextGraphId: 'cg-1' });
      },
    };

    const failure = await agent.assertion.promote('cg-1', 'asset-1', {
      accessPolicy: 'ownerOnly',
    }).catch((error: unknown) => error);

    expect(getPromoteFailureDisposition(failure)).toMatchObject({
      classification: 'transient',
      retryable: true,
    });
    expect(failure).toMatchObject({ cause: authorityFailure });
    expect(agent.resolveWorkspaceRecipientsGated)
      .toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'cg-1' });
  });

  it('does not certify an authority error escaping the committing publisher call', async () => {
    const authorityFailure = new ContextGraphAuthorityUnavailableError(
      'authority lookup failed inside the committing publisher',
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

    expect(failure).toBe(authorityFailure);
    expect(getPromoteFailureDisposition(failure)).toBeUndefined();
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

  it('preserves a typed terminal authority failure without adding a queue disposition', async () => {
    const terminalAuthorityFailure = new ContextGraphAuthorityUnavailableError(
      'registered authority is unsupported',
      { reason: 'chain-participant-authority-unsupported' },
    );
    const agent = promoteBoundaryAgent();
    agent.resolveWorkspaceGossipSigningAgent = async () => {
      throw terminalAuthorityFailure;
    };

    const failure = await agent.assertion.promote('cg-1', 'asset-1')
      .catch((error: unknown) => error);

    expect(terminalAuthorityFailure.retryable).toBe(false);
    expect(failure).toBe(terminalAuthorityFailure);
    expect(getPromoteFailureDisposition(failure)).toBeUndefined();
  });
});

describe('concrete promote authority callbacks with the real publisher', () => {
  it.each([
    ['recipient', 'transient'], ['recipient', 'terminal'], ['recipient', 'ordinary'],
    ['curator', 'transient'], ['curator', 'terminal'], ['curator', 'ordinary'],
  ] as const)('preserves the %s callback %s disposition before SWM mutation', async (stage, kind) => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const agent = promoteBoundaryAgent();
    agent.publisher = publisher;
    agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
    agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
    const failure = kind === 'ordinary'
      ? new Error('untyped prerequisite failure')
      : new ContextGraphAuthorityUnavailableError('authority unavailable', {
        reason: kind === 'transient'
          ? 'chain-participant-authority-unavailable'
          : 'chain-participant-authority-unsupported',
      });
    const prerequisite = vi.fn(async () => { throw failure; });
    if (stage === 'recipient') agent.resolveWorkspaceRecipientsGated = prerequisite;
    else agent.buildCuratorAckConfirmer = async () => prerequisite;

    await publisher.assertionCreate('cg-1', 'asset-1', agent.defaultAgentAddress);
    await publisher.assertionWrite('cg-1', 'asset-1', agent.defaultAgentAddress, [{
      subject: 'urn:test:prerequisite', predicate: 'http://schema.org/name', object: '"Prepared"',
    }]);
    const finalized = await finalizeRootlessAssertionForTest({
      publisher, store, contextGraphId: 'cg-1', name: 'asset-1',
      agentAddress: agent.defaultAgentAddress,
    });
    const caught = await agent.assertion.promote('cg-1', 'asset-1', { accessPolicy: 'public' })
      .catch((error: unknown) => error);

    expect(prerequisite).toHaveBeenCalledTimes(1);
    if (kind === 'transient') {
      expect(caught).toMatchObject({ cause: failure });
      expect(getPromoteFailureDisposition(caught)).toMatchObject({
        classification: 'transient', retryable: true,
      });
    } else {
      expect(caught).toBe(failure);
      expect(getPromoteFailureDisposition(caught)).toBeUndefined();
    }
    expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(false);
    expect(await publisher.assertionQuery('cg-1', 'asset-1', agent.defaultAgentAddress))
      .toHaveLength(1);
  });
});
