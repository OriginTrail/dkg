import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { describe, expect, it } from 'vitest';
import {
  ContextGraphReadAuthorityUnavailableError,
  contextGraphReadAuthorityDependencyOf,
  resolveContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityInput,
} from '../src/context-graph-read-authority.js';

function storeRecovering(): StoreOperationTimeoutError {
  return new StoreOperationTimeoutError({
    backend: 'oxigraph-server',
    operation: 'query',
    outcome: 'not_started',
    message: 'Managed Oxigraph is recovering; query was not started',
  });
}

function rpcExhausted(): ChainRpcTransportError {
  return new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', 'all RPC endpoints failed');
}

/** A resolver input for an unregistered, private legacy-local graph; each case overrides one source. */
function input(overrides: Partial<ContextGraphReadAuthorityInput> = {}): ContextGraphReadAuthorityInput {
  return {
    contextGraphId: 'cg-2834',
    allowSubscriptionFallback: false,
    isSystemContextGraph: false,
    getPeerId: () => 'peer-local',
    getAllowedPeers: async () => null,
    getRegisteredAuthority: async () => ({ kind: 'unregistered' }),
    isAgentAllowed: () => false,
    hasLocalAgentInRoster: () => false,
    resolveRfc64PrivateRoster: () => undefined,
    hasAcceptedRfc64PublicPolicy: false,
    isPendingMetadata: false,
    isPrivateLocalGraph: async () => true,
    getLocalAgentGate: async () => null,
    getLegacyParticipants: async () => null,
    hasLegacySubscription: false,
    getLocalIdentityId: async () => 0n,
    ...overrides,
  };
}

describe('read-authority dependency attribution (#2834)', () => {
  it('attributes a registration-status store failure to the store', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => { throw storeRecovering(); },
    }))).resolves.toEqual({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'registered-authority-error',
      metadataBootstrap: 'eligible',
      dependency: 'store',
    });
  });

  it('attributes a chain-authority RPC failure to the chain, through a wrapping error', async () => {
    const wrapped = new Error('authority read failed', { cause: rpcExhausted() });

    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => { throw wrapped; },
    }))).resolves.toMatchObject({ source: 'registered-chain', reason: 'registered-authority-error', dependency: 'chain' });
  });

  it('maps typed registered-authority reasons to their dependency', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => ({ kind: 'unavailable', reason: 'local-existence-unavailable', detail: 'raw' }),
    }))).resolves.toMatchObject({ reason: 'local-existence-unavailable', dependency: 'store' });
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => ({ kind: 'unavailable', reason: 'chain-access-policy-timeout', onChainId: 7n }),
    }))).resolves.toMatchObject({ reason: 'chain-access-policy-timeout', dependency: 'chain', onChainId: 7n });
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => ({ kind: 'unavailable', reason: 'local-chain-binding-unavailable' }),
    }))).resolves.toMatchObject({ reason: 'local-chain-binding-unavailable', dependency: 'local-state' });
  });

  it('attributes failed legacy-local metadata reads by their errors', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      isPrivateLocalGraph: async () => { throw storeRecovering(); },
    }))).resolves.toMatchObject({ source: 'legacy-local', reason: 'local-access-policy-unavailable', dependency: 'store' });
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getAllowedPeers: async () => { throw new Error('peer metadata read failed'); },
    }))).resolves.toMatchObject({ source: 'legacy-local', reason: 'peer-authority-unavailable', dependency: 'unknown' });
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getLocalAgentGate: async () => { throw rpcExhausted(); },
    }))).resolves.toMatchObject({ source: 'legacy-local', reason: 'local-agent-authority-unavailable', dependency: 'chain' });
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getLegacyParticipants: async () => { throw storeRecovering(); },
    }))).resolves.toMatchObject({ source: 'legacy-local', reason: 'legacy-participant-authority-unavailable', dependency: 'store' });
    await expect(resolveContextGraphReadAuthorityDecision(input({ isPendingMetadata: true })))
      .resolves.toMatchObject({ reason: 'pending-authoritative-metadata', dependency: 'local-state' });
  });

  it('attributes a failed peer-allowlist read for a chain-registered private graph', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      callerAgentAddress: '0xabc',
      getRegisteredAuthority: async () => ({ kind: 'private', onChainId: 5n, participantAgents: ['0xabc'] }),
      isAgentAllowed: () => true,
      getAllowedPeers: async () => { throw storeRecovering(); },
    }))).resolves.toMatchObject({
      source: 'registered-chain',
      reason: 'peer-authority-unavailable',
      dependency: 'store',
      onChainId: 5n,
    });
  });

  it('classifies only stable store and chain codes, and survives hostile errors', () => {
    expect(contextGraphReadAuthorityDependencyOf(storeRecovering())).toBe('store');
    expect(contextGraphReadAuthorityDependencyOf(new StoreSchedulerBusyError('queue_full', 'normal', 'query')))
      .toBe('store');
    expect(contextGraphReadAuthorityDependencyOf(new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'query')))
      .toBe('store');
    expect(contextGraphReadAuthorityDependencyOf(rpcExhausted())).toBe('chain');
    expect(contextGraphReadAuthorityDependencyOf(new Error('Managed Oxigraph is recovering'))).toBe('unknown');
    expect(contextGraphReadAuthorityDependencyOf(undefined)).toBe('unknown');
    const hostile = {};
    Object.defineProperty(hostile, 'code', { get() { throw new Error('hostile getter'); } });
    expect(contextGraphReadAuthorityDependencyOf(hostile)).toBe('unknown');
  });

  it('carries the dependency on the scoped-query error', () => {
    const error = new ContextGraphReadAuthorityUnavailableError('cg-2834', {
      source: 'registered-chain',
      reason: 'registered-authority-error',
      dependency: 'store',
    });

    expect(error).toMatchObject({ source: 'registered-chain', reason: 'registered-authority-error', dependency: 'store' });
    expect(error.message).toContain('(registered-chain/registered-authority-error/store)');
  });

  it('attributes store admission shedding to the store', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => { throw new StoreSchedulerBusyError('queue_full', 'normal', 'query'); },
    }))).resolves.toMatchObject({ reason: 'registered-authority-error', dependency: 'store' });
  });

  it('prefers the dependency a registered-authority result records over its reason', async () => {
    await expect(resolveContextGraphReadAuthorityDecision(input({
      getRegisteredAuthority: async () => ({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
        dependency: 'store',
      }),
    }))).resolves.toMatchObject({ reason: 'local-chain-binding-unavailable', dependency: 'store' });
  });
});
