import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  MockChainAdapter,
  type ChainAdapter,
  type ContextGraphAuthorityProjectionServedEvidence,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS,
  CHAIN_POLICY_READ_TIMEOUT_MS,
} from '../src/dkg-agent-constants.js';
import {
  CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
  ContextGraphReadAuthorityUnavailableError,
} from '../src/context-graph-read-authority.js';
import { finalizedAuthorityColdResolutionOf } from
  '../src/finalized-authority-cold-resolution.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

const MEMBER = '0x0000000000000000000000000000000000000001';
const NON_MEMBER = '0x00000000000000000000000000000000000000ff';

const registeredBinding = (onChainId: bigint) => ({
  kind: 'registered' as const,
  onChainId,
  provenance: 'numeric-id' as const,
});

const authoritativeBinding = (onChainId: bigint) => ({
  kind: 'registered' as const,
  onChainId,
  provenance: 'authoritative' as const,
});

const mockLivePolicy = (agent: DKGAgent, accessPolicy: 0 | 1) =>
  vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
    kind: 'available',
    accessPolicy,
  });

/** What the reader rejects with when every provider failed: it trips the shared circuit. */
const exhaustedAuthorityPool = () => Object.assign(
  new Error('readContextGraphAuthorityIndexSnapshots failed on all endpoints'),
  { code: 'RPC_ENDPOINTS_EXHAUSTED' },
);

function finalizedAuthoritySnapshot(
  contextGraphId: bigint,
  nameHash: string,
  overrides: Partial<ContextGraphAuthoritySnapshot> = {},
): ContextGraphAuthoritySnapshot {
  return {
    chainId: '20430',
    governanceContract: `0x${'11'.repeat(20)}`,
    contextGraphId: contextGraphId.toString(10),
    owner: `0x${'22'.repeat(20)}`,
    active: true,
    accessPolicy: 0,
    publishPolicy: 0,
    publishAuthority: `0x${'22'.repeat(20)}`,
    publishAuthorityAccountId: '1',
    participantAgents: [],
    nameHash,
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '1',
    sourceBlockNumber: '100',
    sourceBlockHash: `0x${'33'.repeat(32)}`,
    ...overrides,
  };
}

type FinalizedAuthorityReaderMock = Mock<(
  contextGraphIds: readonly string[],
  options?: { signal?: AbortSignal },
) => Promise<Map<string, ContextGraphAuthoritySnapshot>>>;

/**
 * The agent's finalized-evidence lane captures the adapter's reader once, so a
 * later call swaps the projection behind the same mock instead of installing
 * a second reader object the agent would never consult. Like the EVM reader,
 * the mock reports how the projection was served; a fresh cache hit unless the
 * test says otherwise (`served: null` models an adapter that reports nothing).
 */
function installFinalizedAuthorityReader(
  chain: MockChainAdapter,
  snapshot: ContextGraphAuthoritySnapshot | undefined,
  served: ContextGraphAuthorityProjectionServedEvidence | null = { source: 'cache', ageMs: 0 },
): FinalizedAuthorityReaderMock {
  const projection = async (
    contextGraphIds: readonly string[],
    options?: { signal?: AbortSignal } & {
      onContextGraphAuthorityProjectionServed?: (
        report: ContextGraphAuthorityProjectionServedEvidence,
      ) => void;
    },
  ) => {
    if (served !== null) options?.onContextGraphAuthorityProjectionServed?.(served);
    return new Map(snapshot !== undefined && contextGraphIds.includes(snapshot.contextGraphId)
      ? [[snapshot.contextGraphId, snapshot]]
      : []);
  };
  const installed = Reflect.get(chain, 'contextGraphAuthorityIndexRevisionReader') as
    { readContextGraphAuthorityIndexSnapshots?: FinalizedAuthorityReaderMock } | undefined;
  const existing = installed?.readContextGraphAuthorityIndexSnapshots;
  if (existing !== undefined && vi.isMockFunction(existing)) {
    existing.mockReset();
    existing.mockImplementation(projection);
    return existing;
  }
  const readContextGraphAuthorityIndexSnapshots: FinalizedAuthorityReaderMock = vi.fn(projection);
  Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
    readContextGraphAuthorityIndexSnapshots,
    readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
    whenIdle: vi.fn(async () => undefined),
  });
  return readContextGraphAuthorityIndexSnapshots;
}

describe('private read authorization uses the on-chain participant roster', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('serves a scoped public read from finalized authority without a live RPC', async () => {
    const contextGraphId = 'finalized-public';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedPublicReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-public', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 8n,
      provenance: 'authoritative',
    });
    const readIndex = installFinalizedAuthorityReader(
      chain,
      finalizedAuthoritySnapshot(8n, agent.contextGraphNameCommitment(contextGraphId)),
    );
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockImplementation(() => new Promise(() => undefined));

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledWith(
      ['8'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(live).not.toHaveBeenCalled();
  });

  it('falls back to the bounded current-state read when the finalized lane faults', async () => {
    const contextGraphId = 'finalized-faulted';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedFaultedReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-faulted', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 9n,
      provenance: 'authoritative',
    });
    const readIndex = installFinalizedAuthorityReader(chain, undefined)
      .mockRejectedValue(new Error('authority index backend head probe timed out'));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue({ kind: 'available', accessPolicy: 0 });

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledWith(
      ['9'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(live).toHaveBeenCalledTimes(1);

    // An absent snapshot is no evidence either: the registration is already
    // proven, so the projection has simply not reached its block yet.
    installFinalizedAuthorityReader(chain, undefined);
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(live).toHaveBeenCalledTimes(2);
  });

  it('uses the atomic finalized private roster and rejects mismatched name evidence', async () => {
    const contextGraphId = 'finalized-private';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedPrivateReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-private', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 7n,
      provenance: 'authoritative',
    });
    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    ));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();

    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      `0x${'44'.repeat(32)}`,
      { accessPolicy: 1, participantAgents: [MEMBER] },
    ));
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).rejects.toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      contextGraphId,
      source: 'registered-chain',
      reason: 'chain-access-policy-unknown',
    });
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('binds a wire-id-keyed placeholder row to its finalized snapshot instead of re-hashing the wire id', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedWireIdPlaceholderReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-wire-id', configurable: true });
    // A cold Edge learns the commitment from `ContextGraphCreated` before any
    // cleartext arrives: the row is keyed by the wire id, is not admitted, and
    // carries the commitment itself as `onChainHash`.
    const wireId = `0x${'ab'.repeat(32)}`;
    expect(agent.stageOnChainContextGraphBindingFromNameHash(wireId, '7')).toBe(wireId);
    const subscriptions = Reflect.get(agent, 'subscribedContextGraphs') as Map<string, {
      subscribed: boolean;
      pendingMeta?: boolean;
      onChainHash?: string;
    }>;
    expect(subscriptions.get(wireId)).toMatchObject({
      subscribed: false,
      pendingMeta: true,
      onChainHash: wireId,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const readIndex = installFinalizedAuthorityReader(
      chain,
      finalizedAuthoritySnapshot(7n, wireId),
    );
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');

    await expect(agent.resolveContextGraphReadAuthority(wireId, {
      authorityReadMode: 'finalized-index',
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      onChainId: 7n,
    });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: wireId,
    })).resolves.toBeDefined();
    // The placeholder is an unscoped candidate as well; one such row must not
    // turn every unscoped query on the node into an empty result.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }')).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(2);
    expect(readIndex).toHaveBeenCalledWith(['7'], expect.anything());
    expect(live).not.toHaveBeenCalled();
  });

  it('denies a non-member from the finalized private roster without a live roster read', async () => {
    const contextGraphId = 'finalized-private-denied';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedPrivateReadDenied',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-private-denied', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    ));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');

    await expect(agent.resolveContextGraphReadAuthority(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
      authorityReadMode: 'finalized-index',
    })).resolves.toMatchObject({
      outcome: 'denied',
      source: 'registered-chain',
      reason: 'agent-not-in-chain-roster',
      onChainId: 7n,
    });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: NON_MEMBER,
    })).resolves.toMatchObject({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('fails closed on an inactive finalized snapshot without consulting current state', async () => {
    const contextGraphId = 'finalized-inactive';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedInactiveReadAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { active: false },
    ));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).rejects.toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      source: 'registered-chain',
      reason: 'chain-access-policy-unknown',
    });
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('falls back to the bounded current-state read when the finalized lane outlives the policy deadline', async () => {
    const contextGraphId = 'finalized-slow';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedSlowReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-slow', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const readIndex = installFinalizedAuthorityReader(chain, undefined)
      .mockImplementation((_contextGraphIds, options) => new Promise((resolve, reject) => {
        const settle = setTimeout(() => resolve(new Map()), CHAIN_POLICY_READ_TIMEOUT_MS * 4);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(settle);
          reject(options.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      }));
    const live = mockLivePolicy(agent, 0);
    vi.useFakeTimers();

    const read = agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId });
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

    await expect(read).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    // The deadline bounded only this request's wait: the detached cold flight
    // keeps running unaborted, so a retry is answered from its projection.
    expect(readIndex.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(finalizedAuthorityColdResolutionOf(agent).inFlightKeys)
      .toEqual(['finalized-authority-snapshot:7']);
  });

  it('keeps a projection answering scoped reads while the shared circuit cools down', async () => {
    const contextGraphId = 'finalized-circuit';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedCircuitReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-circuit', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const readIndex = installFinalizedAuthorityReader(chain, undefined)
      .mockRejectedValue(exhaustedAuthorityPool());
    const live = mockLivePolicy(agent, 0);

    // The exhaustion trips the shared circuit; the live read answers.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'open', consecutiveExhaustions: 1 });

    // Refusing the next read would only send it to the live read of the same
    // pool, so it is admitted as a probe. Its exhaustion joins the open round.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(2);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'open', consecutiveExhaustions: 1 });

    // A projection fetched before the trip still answers without a live read,
    // and it is no evidence that the pool recovered.
    installFinalizedAuthorityReader(
      chain,
      finalizedAuthoritySnapshot(7n, agent.contextGraphNameCommitment(contextGraphId)),
      { source: 'cache', ageMs: 5_000 },
    );
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(live).toHaveBeenCalledTimes(2);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'open', consecutiveExhaustions: 1 });
  });

  it('reports the scoped read\'s projection evidence to both the circuit and the roster gate', async () => {
    const contextGraphId = 'finalized-circuit-evidence';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedCircuitEvidenceReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-circuit-evidence', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const privateSnapshot = finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    );
    installFinalizedAuthorityReader(chain, undefined).mockRejectedValue(exhaustedAuthorityPool());
    const live = mockLivePolicy(agent, 0);
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'open', consecutiveExhaustions: 1 });

    // Building the read's options marks an RPC attempt, and only the circuit's
    // own observer can void it: a log fold reached no endpoint. Were the lane
    // to take the report for itself, this answer would close the circuit over
    // an exhausted pool. The roster gate must see the same report, or the
    // private roster would go to the live read.
    installFinalizedAuthorityReader(chain, privateSnapshot, { source: 'log', ageMs: 0 });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'open', consecutiveExhaustions: 1 });

    // A completed scan reached the pool: it closes the circuit.
    installFinalizedAuthorityReader(chain, privateSnapshot, { source: 'scan', ageMs: 0 });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(3);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1())
      .toMatchObject({ state: 'closed', consecutiveExhaustions: 0 });
  });

  it('does not hold a projection hit behind unrelated authority-index activity', async () => {
    const contextGraphId = 'finalized-busy-index';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedBusyIndexReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-busy-index', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    installFinalizedAuthorityReader(
      chain,
      finalizedAuthoritySnapshot(7n, agent.contextGraphNameCommitment(contextGraphId)),
    );
    // A bulk catalog scan, or one a timed-out read left behind, is still
    // running, so the reader's global drain never settles. That work belongs
    // to the reader's lifecycle, not to this read's policy budget.
    const reader = Reflect.get(chain, 'contextGraphAuthorityIndexRevisionReader') as {
      whenIdle: Mock<() => Promise<void>>;
    };
    reader.whenIdle.mockImplementation(() => new Promise<void>(() => undefined));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(live).not.toHaveBeenCalled();
    reader.whenIdle.mockResolvedValue(undefined);
  });

  it('reports the scoped lane\'s served provenance to the shared circuit: a stale answer keeps it half-open, a scan closes it', async () => {
    const contextGraphId = 'finalized-circuit-recovery';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedCircuitRecoveryReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-circuit-recovery', configurable: true });
    // The agent's own circuit reads wall time and backs off for a minute; a
    // deterministic clock lets the test reach the half-open probe.
    let now = 1_000;
    Object.defineProperty(agent, 'rfc64AuthorityReadCoordinatorV1', {
      value: new Rfc64AuthorityReadCoordinatorV1({
        baseBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        now: () => now,
      }),
      configurable: true,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const publicSnapshot = finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
    );
    const readIndex = installFinalizedAuthorityReader(chain, undefined)
      .mockRejectedValue(Object.assign(
        new Error('readContextGraphAuthorityIndexSnapshots failed on all endpoints'),
        { code: 'RPC_ENDPOINTS_EXHAUSTED' },
      ));
    const live = mockLivePolicy(agent, 0);

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 1_100,
    });

    // Past the backoff the next scoped read is admitted as the probe. The
    // reader answers from a projection it could not refresh: the public
    // snapshot still answers the read, but the lane marked an RPC attempt and
    // the served `stale-cache` report voids it, so the circuit stays half-open.
    now = 1_100;
    installFinalizedAuthorityReader(chain, publicSnapshot, { source: 'stale-cache', ageMs: 5_000 });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'half-open',
      consecutiveExhaustions: 1,
      retryAtMs: null,
    });

    // An answer the reader scanned from the pool is recovery evidence: the
    // circuit closes for every consumer.
    installFinalizedAuthorityReader(chain, publicSnapshot, { source: 'scan', ageMs: 0 });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });
  });

  it('answers both finalized lanes from the retained snapshot while the circuit cools down', async () => {
    const contextGraphId = 'finalized-or-live-open-circuit';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedOrLiveOpenCircuit',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-or-live-circuit', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const readIndex = installFinalizedAuthorityReader(chain, undefined)
      .mockRejectedValue(Object.assign(
        new Error('readContextGraphAuthorityIndexSnapshots failed on all endpoints'),
        { code: 'RPC_ENDPOINTS_EXHAUSTED' },
      ));
    const live = mockLivePolicy(agent, 0);
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    // A scoped read exhausts the pool and trips the shared circuit.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toMatchObject({
      state: 'open',
      consecutiveExhaustions: 1,
    });

    // The reader still answers from its retained projection. The host-mode
    // gossip oracle reads it outside the circuit, so the open circuit does not
    // refuse it: the fresh private roster decides with no live read.
    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    ));
    await expect(agent.resolveOnChainParticipantAgents(contextGraphId)).resolves.toEqual([MEMBER]);
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    expect(pointRoster).not.toHaveBeenCalled();
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toMatchObject({ state: 'open' });

    // The scoped lane is admitted during the cooldown too, as one probe behind
    // the foreground permit: it answers from the same retained projection
    // instead of walking the exhausted pool through the live read.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('keeps current-state reads when the adapter exposes no finalized authority index', async () => {
    const contextGraphId = 'legacy-adapter-public';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'LegacyAdapterReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-legacy-adapter', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    // A legacy adapter binds no finalized index, so the finalized lane has
    // nothing to read and must not take the circuit's foreground permit.
    expect(Reflect.get(chain, 'contextGraphAuthorityIndexRevisionReader')).toBeUndefined();
    const foreground = vi.spyOn(
      Reflect.get(agent, 'rfc64AuthorityReadCoordinatorV1') as Rfc64AuthorityReadCoordinatorV1,
      'runForeground',
    );
    const live = mockLivePolicy(agent, 0);

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(foreground).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('authorizes unscoped candidates from the finalized index without live policy or roster reads', async () => {
    const contextGraphId = 'unscoped-finalized-private';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'UnscopedFinalizedReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-unscoped-finalized', configurable: true });
    agent.setContextGraphSubscription(contextGraphId, {
      syncMode: 'on-demand',
      subscribed: true,
      synced: true,
    }, { persist: false });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockImplementation(
      async (id) => (id === contextGraphId ? authoritativeBinding(9n) : { kind: 'unregistered' }),
    );
    const readIndex = installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      9n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    ));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');
    const pointRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(1);
    expect(readIndex).toHaveBeenCalledWith(['9'], expect.anything());

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      callerAgentAddress: NON_MEMBER,
    })).resolves.toMatchObject({ bindings: [] });
    expect(queryExecution).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
    expect(pointRoster).not.toHaveBeenCalled();
  });

  it('reads current chain state when the finalized index has no snapshot for a proven registration', async () => {
    const contextGraphId = 'finalized-lagging';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedLaggingReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-lagging', configurable: true });
    // A durable numeric binding proves the registration without the index; the
    // projection's anchor has not reached the registration block yet.
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const readIndex = installFinalizedAuthorityReader(chain, undefined);
    const live = mockLivePolicy(agent, 0);

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);

    // The live read still owns the fail-closed answer for that window.
    live.mockResolvedValue({ kind: 'unavailable', reason: 'chain-access-policy-unknown' });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
    })).rejects.toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      source: 'registered-chain',
      reason: 'chain-access-policy-unknown',
    });
  });

  it('takes a private roster to the live read only when the reader could not refresh the projection, and keeps serving a public one', async () => {
    const contextGraphId = 'finalized-stale-roster';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedStaleRosterReadAuthority',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-stale-roster', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    const nameHash = agent.contextGraphNameCommitment(contextGraphId);
    const privateSnapshot = finalizedAuthoritySnapshot(7n, nameHash, {
      accessPolicy: 1,
      participantAgents: [MEMBER],
    });
    // MEMBER was removed on chain after the retained projection was fetched.
    const live = mockLivePolicy(agent, 1);
    const liveRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([]);
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');

    // `stale-cache` is the reader saying a refresh failed and the projection
    // is at least one tick old; an unreported provenance proves nothing.
    const notFresh: Array<ContextGraphAuthorityProjectionServedEvidence | null> = [
      { source: 'stale-cache', ageMs: 5_000 },
      null,
    ];
    for (const [index, served] of notFresh.entries()) {
      installFinalizedAuthorityReader(chain, privateSnapshot, served);
      await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
        contextGraphId,
        callerAgentAddress: MEMBER,
      })).resolves.toMatchObject({ bindings: [] });
      expect(live).toHaveBeenCalledTimes(index + 1);
      expect(liveRoster).toHaveBeenCalledTimes(index + 1);
    }
    expect(queryExecution).not.toHaveBeenCalled();

    // A fold the reader admitted decides at whatever age the reader reports:
    // the age bound is the reader's stale window (min(max(3T, 15s), 5m)), and a
    // 45s-old fold is a fresh answer on a 15s tick. No live read.
    installFinalizedAuthorityReader(chain, privateSnapshot, {
      source: 'log',
      ageMs: 45_000,
    });
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(notFresh.length);

    // The policy bit is immutable on chain: a public snapshot is served at any provenance.
    installFinalizedAuthorityReader(
      chain,
      finalizedAuthoritySnapshot(7n, nameHash),
      { source: 'stale-cache', ageMs: 600_000 },
    );
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: NON_MEMBER,
    })).resolves.toBeDefined();
    expect(queryExecution).toHaveBeenCalledTimes(2);
    expect(live).toHaveBeenCalledTimes(notFresh.length);
  });

  it('fails closed on a malformed finalized snapshot without consulting current state', async () => {
    const contextGraphId = 'finalized-malformed';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedMalformedReadAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(authoritativeBinding(7n));
    installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
      7n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 2 as unknown as 0 },
    ));
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState');

    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).rejects.toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      source: 'registered-chain',
      reason: 'chain-access-policy-unavailable',
    });
    expect(live).not.toHaveBeenCalled();
  });

  it('allows a chain participant and rejects a non-member without local metadata fallback', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadChainAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([MEMBER]);
    const localGate = vi.spyOn(agent, 'getContextGraphAgentGateAddresses')
      .mockResolvedValue([NON_MEMBER]);

    await expect(agent.canReadContextGraph('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    await expect(agent.canReadContextGraph('registered-private', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(chainRoster).toHaveBeenCalledTimes(2);
    expect(localGate).not.toHaveBeenCalled();
  });

  it('discovers a cold non-selected private CG by name hash and rejects a non-member', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadColdNameHashAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(7n);
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);

    await expect(agent.canReadContextGraph('cold-private', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(resolveByNameHash).toHaveBeenCalledWith(
      agent.contextGraphNameCommitment('cold-private'),
      { signal: expect.any(AbortSignal) },
    );
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['cold', false, 'chain-name-binding-unavailable'],
    ['locally indexed', true, 'local-chain-binding-unavailable'],
  ] as const)(
    'bounds a never-settling %s name binding and fails read admission closed',
    async (_label, locallyIndexed, reason) => {
      const contextGraphId = locallyIndexed ? 'indexed-hung-binding' : 'cold-hung-binding';
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({
        name: locallyIndexed ? 'PrivateReadIndexedHungBinding' : 'PrivateReadColdHungBinding',
        chainAdapter: chain,
      });
      const nameHash = agent.contextGraphNameCommitment(contextGraphId);
      if (locallyIndexed) {
        agent.setContextGraphSubscription(contextGraphId, {
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          onChainHash: nameHash,
        }, { persist: false });
      }
      const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
        .mockReturnValue(new Promise<bigint | null>(() => undefined));
      const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);
      vi.useFakeTimers();

      const read = agent.resolveContextGraphReadAuthority(contextGraphId, {
        callerAgentAddress: MEMBER,
        allowSubscriptionFallback: false,
      });
      await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

      await expect(read).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason,
      });
      expect(resolveByNameHash).toHaveBeenCalledWith(
        nameHash,
        { signal: expect.any(AbortSignal) },
      );
      const operationSignal = resolveByNameHash.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(true);
      expect(localPolicy).not.toHaveBeenCalled();
    },
  );

  it('allows a cold registered graph only after fresh chain policy proves it public', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicReadColdNameHashAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(8n);
    mockLivePolicy(agent, 0);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);

    await expect(agent.canReadContextGraph('cold-public', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    expect(chainRoster).not.toHaveBeenCalled();
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it('does not expose a numeric local graph through an unrelated public chain slot', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'NumericLocalGraphChainSlotCollision',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'contextGraphExists').mockResolvedValue(true);
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(null);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);
    vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue([MEMBER]);
    const chainPolicy = mockLivePolicy(agent, 0);

    await expect(agent.resolveContextGraphReadAuthority('42', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'denied',
      source: 'legacy-local',
      reason: 'local-agent-not-allowed',
    });
    expect(chainPolicy).not.toHaveBeenCalled();
  });

  it('does not make a chain-proven public graph depend on legacy peer metadata', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicReadIndependentOfLegacyPeerMetadata',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(8n));
    mockLivePolicy(agent, 0);
    const legacyPeers = vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockRejectedValue(new Error('local metadata store unavailable'));

    await expect(agent.resolveContextGraphReadAuthority('registered-public', {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      onChainId: 8n,
    });
    expect(legacyPeers).not.toHaveBeenCalled();
  });

  it('denies a chain-authorized private participant when this peer is not allowed', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadPeerMismatch',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockResolvedValue(['12D3KooWAnotherAuthorizedPeer']);
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWLocalPeer');

    await expect(agent.resolveContextGraphReadAuthority('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'denied',
      source: 'registered-chain',
      reason: 'local-peer-not-allowed',
      onChainId: 7n,
    });
  });

  it('reports unavailable authority when private peer metadata cannot be read', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadPeerAuthorityUnavailable',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockRejectedValue(new Error('peer metadata unavailable'));

    await expect(agent.resolveContextGraphReadAuthority('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'peer-authority-unavailable',
      onChainId: 7n,
    });
  });

  it('surfaces unavailable scoped query authority instead of returning an empty result', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'ScopedQueryAuthorityUnavailable',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(8n));
    vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
      kind: 'unavailable',
      reason: 'chain-access-policy-timeout',
    });
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');

    const error = await agent.query(
      'SELECT ?s WHERE { ?s ?p ?o }',
      {
        contextGraphId: 'registered-public',
        callerAgentAddress: MEMBER,
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ContextGraphReadAuthorityUnavailableError);
    expect(error).toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      retryable: true,
      contextGraphId: 'registered-public',
      source: 'registered-chain',
      reason: 'chain-access-policy-timeout',
    });
    expect(queryExecution).not.toHaveBeenCalled();
  });

  it('uses cold name-hash discovery for recovery and sender-key agent gates', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateColdRecoveryAgentGate',
      chainAdapter: chain,
    });
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(9n);
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    const rfc64Roster = vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1')
      .mockReturnValue([NON_MEMBER]);
    const localMeta = vi.spyOn(agent, 'getCgMeta');

    await expect(agent.getContextGraphAgentGateAddresses('cold-private-gate'))
      .resolves.toEqual([MEMBER]);
    await expect(agent.getMemberRecoveryGate('cold-private-gate'))
      .resolves.toEqual([MEMBER]);
    expect(resolveByNameHash).toHaveBeenCalledTimes(2);
    expect(rfc64Roster).not.toHaveBeenCalled();
    expect(localMeta).not.toHaveBeenCalled();
  });

  it('does not reinterpret a registered public graph participant roster as its local publisher gate', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicRegisteredAgentGate',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(8n));
    mockLivePolicy(agent, 0);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([NON_MEMBER]);
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'getCgMeta').mockResolvedValue({
      allowedAgents: [MEMBER],
      participantAgents: [],
      revokedAgents: [],
    } as Awaited<ReturnType<DKGAgent['getCgMeta']>>);

    await expect(agent.getContextGraphAgentGateAddresses('registered-public'))
      .resolves.toEqual([MEMBER]);
    expect(chainRoster).not.toHaveBeenCalled();
  });

  it('keeps registered-public publisher invitations out of the private read roster', async () => {
    const contextGraphId = 'registered-public-publisher-invite';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicRegisteredPublisherInvite',
      chainAdapter: chain,
    });
    const ownerRecord = await agent.registerAgent('Public graph owner');
    const publisherRecord = await agent.registerAgent('Public graph publisher');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Registered public publisher invite',
      accessPolicy: 0,
      publishPolicy: 0,
      callerAgentAddress: ownerRecord.agentAddress,
    });
    const registration = await agent.registerContextGraph(contextGraphId, {
      callerAgentAddress: ownerRecord.agentAddress,
    });
    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');

    await agent.inviteAgentToContextGraph(
      contextGraphId,
      publisherRecord.agentAddress,
      ownerRecord.agentAddress,
    );

    expect(addParticipant).not.toHaveBeenCalled();
    await expect(chain.getContextGraphParticipantAgents(BigInt(registration.onChainId)))
      .resolves.not.toContain(publisherRecord.agentAddress);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(publisherRecord.agentAddress);
  });

  it('does not treat a failed local chain binding read as proof of an unregistered graph', async () => {
    const chain = new MockChainAdapter();
    // Model an older adapter without the independent name-hash reverse lookup:
    // a failed local binding read must remain unavailable, never fall through
    // to a permissive local-public projection.
    (chain as unknown as { resolveContextGraphIdByNameHash?: unknown })
      .resolveContextGraphIdByNameHash = undefined;
    agent = await DKGAgent.create({
      name: 'PrivateReadBindingUnavailable',
      chainAdapter: chain,
    });
    agent.setContextGraphSubscription('possibly-registered', {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
    }, { persist: false });
    vi.spyOn(agent.store, 'query')
      .mockRejectedValue(new Error('local mapping store unavailable'));
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);

    await expect(agent.resolveContextGraphReadAuthority('possibly-registered', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'local-chain-binding-unavailable',
    });
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it.each(['empty', 'error'] as const)(
    'denies when registered chain authority is %s instead of falling back to stale local metadata',
    async (mode) => {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({
        name: `PrivateReadChainAuthority-${mode}`,
        chainAdapter: chain,
      });
      vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
      vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
      vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
        .mockResolvedValue(registeredBinding(7n));
      mockLivePolicy(agent, 1);
      vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue([MEMBER]);
      const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
      if (mode === 'empty') chainRoster.mockResolvedValue([]);
      else chainRoster.mockRejectedValue(new Error('RPC unavailable'));

      await expect(agent.canReadContextGraph('registered-private', {
        callerAgentAddress: MEMBER,
        allowSubscriptionFallback: false,
      })).resolves.toBe(false);
    },
  );

  it('bounds a never-settling registered participant roster and fails read admission closed', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadHungRoster',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    vi.useFakeTimers();

    const read = agent.resolveContextGraphReadAuthority('hung-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    });
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

    await expect(read).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('propagates caller abort to a stalled registered participant lookup', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadAbortedRoster',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    const controller = new AbortController();
    vi.useFakeTimers();
    const startedAt = Date.now();

    let settled = false;
    const gate = agent.getContextGraphAgentGateAddresses('aborted-private', {
      signal: controller.signal,
    }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    controller.abort(new Error('caller stopped'));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(Date.now()).toBe(startedAt);
    await expect(gate).resolves.toEqual([]);
  });

  it('requires every chain sender-key recipient to advertise an allowed peer when a peer gate exists', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadSenderKeyPeerGate',
      chainAdapter: chain,
    });
    const member = await agent.registerAgent('Sender-key peer-gated member');
    const advertisedPeer = '12D3KooWSenderKeyAuthorizedPeer';
    await agent.store.insert([{
      subject: `did:dkg:agent:${member.agentAddress}`,
      predicate: 'https://dkg.network/ontology#peerId',
      object: `"${advertisedPeer}"`,
      graph: 'did:dkg:system/agents',
    }]);
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({
      kind: 'private',
      onChainId: 7n,
      participantAgents: [member.agentAddress],
    });
    const allowedPeers = vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockResolvedValue(null);

    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).resolves.toMatchObject({
      requiresEncryption: true,
      recipients: [expect.objectContaining({
        agentAddress: member.agentAddress,
        peerId: advertisedPeer,
      })],
    });

    allowedPeers.mockResolvedValue([advertisedPeer]);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).resolves.toMatchObject({
      requiresEncryption: true,
      recipients: [expect.objectContaining({ peerId: advertisedPeer })],
    });

    allowedPeers.mockResolvedValue(['12D3KooWAnotherAuthorizedPeer']);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).rejects.toThrow(/has no recipient key advertised by a peer in the context graph allowlist/);
  });

  it('does not let a never-settling registered roster block subscription rehydration', async () => {
    const contextGraphId = 'persisted-hung-roster';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadHungRosterRehydration',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
          onChainId: '7',
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    mockLivePolicy(agent, 1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      agent.start(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('daemon startup exceeded the roster-read deadline')),
          CHAIN_POLICY_READ_TIMEOUT_MS + 1_500,
        );
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [contextGraphId],
      },
    });
  }, CHAIN_POLICY_READ_TIMEOUT_MS + 3_500);

  it('does not let cold name-binding discovery block subscription rehydration', async () => {
    const contextGraphId = 'persisted-hung-name-binding';
    const chain = new MockChainAdapter();
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockReturnValue(new Promise<bigint | null>(() => undefined));
    agent = await DKGAgent.create({
      name: 'PrivateReadHungNameBindingRehydration',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      agent.start(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('daemon startup exceeded the name-binding deadline')),
          CHAIN_POLICY_READ_TIMEOUT_MS + 1_500,
        );
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    expect(resolveByNameHash).toHaveBeenCalledWith(
      agent.contextGraphNameCommitment(contextGraphId),
      { signal: expect.any(AbortSignal) },
    );
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [contextGraphId],
      },
    });
  }, CHAIN_POLICY_READ_TIMEOUT_MS + 3_500);


  it('leaves a persisted subscription dormant when startup cannot prove current read authority', async () => {
    const contextGraphId = 'persisted-private-poison';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadRehydrationAuthority',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
          onChainId: '7',
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const readAuthority = vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockResolvedValue({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'test-chain-unavailable',
      metadataBootstrap: 'eligible',
    });
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');

    await agent.rehydrateContextGraphsFromDurableState();

    expect(readAuthority).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
      signal: expect.any(AbortSignal),
      durableSubscriptionBinding: {
        contextGraphId,
        onChainId: '7',
      },
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 1,
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        activationCap: [],
        authorityDenied: [],
        authorityUnavailable: [contextGraphId],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });

    const mutableSnapshot = agent.getContextGraphSubscriptionRehydrationStatus();
    expect(mutableSnapshot).not.toBeNull();
    mutableSnapshot!.hostedActivatedIds.push('mutated-hosted');
    mutableSnapshot!.dormantIds.length = 0;
    for (const ids of Object.values(mutableSnapshot!.dormantReasons)) {
      ids.push('mutated-reason');
    }
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      hostedActivatedIds: [],
      dormantIds: [contextGraphId],
      dormantReasons: {
        activationCap: [],
        authorityDenied: [],
        authorityUnavailable: [contextGraphId],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });
  });

  it('uses the real no-caller chain decision when rehydrating member and non-member rows', async () => {
    const nonMemberContextGraphId = 'recovery-a-denied';
    const memberContextGraphId = 'recovery-b-member';
    const capContextGraphId = 'recovery-z-cap';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadRealRehydrationAuthority',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [memberContextGraphId, nonMemberContextGraphId, capContextGraphId].map((id) => ({
          id,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        })),
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      maxRehydratedContextGraphSubscriptions: 1,
    });
    const localAgentRecord = await agent.registerAgent('Recovery member');
    await agent.markDefaultAgent(localAgentRecord.agentAddress);
    const localAgent = localAgentRecord.agentAddress;
    const memberGraph = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [localAgent],
    });
    const nonMemberGraph = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [NON_MEMBER],
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id) => {
      if (id === memberContextGraphId) return registeredBinding(memberGraph.contextGraphId);
      if (id === nonMemberContextGraphId) return registeredBinding(nonMemberGraph.contextGraphId);
      return { kind: 'unregistered' };
    });
    // start() drives the real background recovery entry point after the local
    // agent and chain rosters have both been seeded.
    await agent.start();

    expect(agent.getSubscribedContextGraphs().has(memberContextGraphId)).toBe(true);
    expect(agent.getSubscribedContextGraphs().has(nonMemberContextGraphId)).toBe(false);
    expect(agent.getSubscribedContextGraphs().has(capContextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 3,
      activated: 1,
      dormant: 2,
      dormantIds: [nonMemberContextGraphId, capContextGraphId],
      dormantReasons: {
        activationCap: [capContextGraphId],
        authorityDenied: [nonMemberContextGraphId],
        authorityUnavailable: [],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });
  });

  it('keeps restarted join approvals metadata-only until ordinary read authority is proven', async () => {
    const contextGraphId = 'restart-pending-join-approval';
    const curatorPeerId = '12D3KooWRestartPendingCurator';
    agent = await DKGAgent.create({
      name: 'PendingJoinApprovalRecovery',
      chainAdapter: new MockChainAdapter(),
    });
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWRestartPendingMember',
      configurable: true,
    });
    const local = await agent.registerAgent('Pending approval member');
    await agent.markDefaultAgent(local.agentAddress);
    (agent as unknown as {
      localApprovedAgentByCG: Map<string, string>;
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).localApprovedAgentByCG.set(contextGraphId, local.agentAddress.toLowerCase());
    (agent as unknown as {
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    });

    const refreshMeta = vi.spyOn(agent, 'refreshMetaFromCurator')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const hasConfirmedMeta = vi.spyOn(agent, 'hasConfirmedMetaState').mockResolvedValue(true);
    const readAuthority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: 'allowed',
      source: 'legacy-local',
      reason: 'local-agent-allowlist',
      metadataBootstrap: 'eligible',
    });
    const refreshFlags = vi.spyOn(agent, 'refreshMetaSyncedFlags').mockResolvedValue(undefined);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph').mockImplementation(
      () => (agent as DKGAgent).getSubscribedContextGraphs().get(contextGraphId)!,
    );
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership')
      .mockImplementation(() => undefined);
    const catchUp = vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);
    expect(readAuthority).not.toHaveBeenCalled();
    expect(refreshFlags).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(persistMembership).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);
    expect(refreshMeta).toHaveBeenLastCalledWith(contextGraphId, expect.objectContaining({
      trustedCuratorPeerId: curatorPeerId,
      force: true,
      memberProof: expect.objectContaining({
        approvedAgentAddress: local.agentAddress.toLowerCase(),
      }),
    }));
    expect(hasConfirmedMeta).toHaveBeenCalledWith(contextGraphId);
    expect(readAuthority).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
    });
    expect(refreshFlags).toHaveBeenCalledWith([contextGraphId]);
    expect(subscribe).toHaveBeenCalledWith(contextGraphId, {
      persist: false,
      syncMode: 'always-on',
    });
    expect(persistMembership).toHaveBeenCalledWith(
      contextGraphId,
      'rehydrated-subscription',
    );
    expect(catchUp).toHaveBeenCalledWith(contextGraphId, curatorPeerId);
  });

  it.each([
    { outcome: 'denied' as const, metadataBootstrap: 'forbidden' as const },
    { outcome: 'unavailable' as const, metadataBootstrap: 'eligible' as const },
  ])('keeps every data lane closed when post-refresh authority is $outcome', async (decision) => {
    const contextGraphId = `post-refresh-${decision.outcome}`;
    const curatorPeerId = '12D3KooWPostRefreshAuthorityCurator';
    agent = await DKGAgent.create({
      name: `PostRefreshAuthority-${decision.outcome}`,
      chainAdapter: new MockChainAdapter(),
    });
    Object.defineProperty(agent, 'peerId', {
      value: `12D3KooWPostRefresh${decision.outcome}`,
      configurable: true,
    });
    const local = await agent.registerAgent(`Post-refresh ${decision.outcome} member`);
    (agent as unknown as { localApprovedAgentByCG: Map<string, string> })
      .localApprovedAgentByCG.set(contextGraphId, local.agentAddress.toLowerCase());
    (agent as unknown as {
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    });

    vi.spyOn(agent, 'refreshMetaFromCurator').mockResolvedValue(true);
    vi.spyOn(agent, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: decision.outcome,
      source: 'registered-chain',
      reason: `test-${decision.outcome}`,
      metadataBootstrap: decision.metadataBootstrap,
    });
    const refreshFlags = vi.spyOn(agent, 'refreshMetaSyncedFlags').mockResolvedValue(undefined);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership');
    const catchUp = vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);

    expect(refreshFlags).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(persistMembership).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('keeps a restarted approval with no local metadata out of every data lane', async () => {
    const contextGraphId = 'restart-approval-no-metadata';
    const curatorPeerId = '12D3KooWRestartNoMetadataCurator';
    let localAgentAddress = MEMBER;
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PendingJoinApprovalNoMetadata',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphMembershipStore: {
        loadAll: async () => [{
          contextGraphId,
          principalType: 'agent' as const,
          principalId: localAgentAddress,
          role: 'participant',
          status: 'active' as const,
          source: 'join-approved',
          metadata: { curatorPeerId },
          updatedAt: 1,
        }],
        upsert: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const local = await agent.registerAgent('Restart no-metadata member');
    localAgentAddress = local.agentAddress;
    await agent.markDefaultAgent(localAgentAddress);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const resume = vi.spyOn(agent, 'resumePendingJoinApprovalMetadata')
      .mockResolvedValue(undefined);

    await agent.rehydrateContextGraphsFromDurableState();

    expect(subscribe).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(contextGraphId, curatorPeerId);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    await expect(agent.resolveContextGraphReadAuthority(contextGraphId, {
      allowSubscriptionFallback: true,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'legacy-local',
      reason: 'pending-authoritative-metadata',
    });
    await expect(agent.canReadContextGraph(contextGraphId)).resolves.toBe(false);
  });

  it('does not let a stale durable approval override a current chain denial', async () => {
    const contextGraphId = 'restart-stale-approval-chain-denied';
    const curatorPeerId = '12D3KooWRestartRevokedCurator';
    let localAgentAddress = MEMBER;
    const chain = new MockChainAdapter();
    await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [NON_MEMBER],
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    });
    agent = await DKGAgent.create({
      name: 'StaleJoinApprovalChainDenied',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphMembershipStore: {
        loadAll: async () => [{
          contextGraphId,
          principalType: 'agent' as const,
          principalId: localAgentAddress,
          role: 'participant',
          status: 'active' as const,
          source: 'join-approved',
          metadata: { curatorPeerId },
          updatedAt: 1,
        }],
        upsert: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const local = await agent.registerAgent('Revoked restart member');
    localAgentAddress = local.agentAddress;
    await agent.markDefaultAgent(localAgentAddress);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const resume = vi.spyOn(agent, 'resumePendingJoinApprovalMetadata')
      .mockResolvedValue(undefined);

    await agent.rehydrateContextGraphsFromDurableState();

    expect(subscribe).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityDenied: [contextGraphId],
      },
    });
  });

  it('keeps registered invite and removal synchronized with chain read authority', async () => {
    const contextGraphId = 'registered-private-membership-mutation';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadMembershipMutation',
      chainAdapter: chain,
    });
    const ownerRecord = await agent.registerAgent('Membership owner');
    const memberRecord = await agent.registerAgent('Membership participant');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    const owner = ownerRecord.agentAddress;
    const member = memberRecord.agentAddress;
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Registered private membership mutation',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const registration = await agent.registerContextGraph(contextGraphId, {
      callerAgentAddress: owner,
    });
    const onChainId = BigInt(registration.onChainId);

    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);

    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');
    addParticipant.mockRejectedValueOnce(new Error('chain add failed'));
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('chain add failed');
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);

    const participantRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    addParticipant.mockResolvedValueOnce({
      hash: '0xunsuccessful',
      blockNumber: 0,
      success: false,
    });
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow(/Failed to add/);
    const rosterReadsAfterUnsuccessfulResult = participantRoster.mock.calls.length;
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(participantRoster.mock.calls.length).toBeGreaterThan(rosterReadsAfterUnsuccessfulResult);

    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    expect(await chain.getContextGraphParticipantAgents(onChainId)).toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({ contextGraphId }))
      .resolves.toMatchObject({
        requiresEncryption: true,
        recipients: expect.arrayContaining([
          expect.objectContaining({ agentAddress: member }),
        ]),
      });

    const removeParticipant = vi.spyOn(chain, 'removeContextGraphParticipantAgent');
    removeParticipant.mockRejectedValueOnce(new Error('chain remove failed'));
    await expect(agent.removeAgentFromContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('chain remove failed');
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(member);

    // The authoritative chain mutation can succeed before a local store write
    // fails. Stale local metadata must not keep recovery or sender-key access
    // alive during that retry window (or after a restart).
    vi.spyOn(agent.store, 'deleteByPatternWithoutCount')
      .mockRejectedValueOnce(new Error('local membership delete failed'));
    await expect(agent.removeAgentFromContextGraph(contextGraphId, member.toLowerCase(), owner))
      .rejects.toThrow('local membership delete failed');
    expect(await chain.getContextGraphParticipantAgents(onChainId)).not.toContain(member);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.getContextGraphAgentGateAddresses(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.getMemberRecoveryGate(contextGraphId))
      .resolves.not.toContain(member);
    const postRemovalRecipients = await agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId,
    });
    expect(postRemovalRecipients.requiresEncryption).toBe(true);
    if (postRemovalRecipients.requiresEncryption) {
      expect(postRemovalRecipients.recipients.map((recipient) => recipient.agentAddress))
        .not.toContain(member);
    }
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);

    // Retry completes the stale local half without repeating the already-done
    // chain removal. Use different address casing across removal/re-invite to
    // prove exact RDF literal matching cannot strand the tombstone.
    await agent.removeAgentFromContextGraph(contextGraphId, member.toLowerCase(), owner);

    // The inverse split can also happen: chain addition succeeds, then the
    // replacement local allowlist insert fails. The tombstone must remain
    // effective and a retry must complete locally without a duplicate tx.
    const addCallsBeforeRetryWindow = addParticipant.mock.calls.length;
    vi.spyOn(agent.store, 'insert').mockRejectedValueOnce(
      new Error('local membership insert failed'),
    );
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('local membership insert failed');
    expect(addParticipant).toHaveBeenCalledTimes(addCallsBeforeRetryWindow + 1);
    expect(await chain.getContextGraphParticipantAgents(onChainId)).toContain(member);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);

    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    expect(addParticipant).toHaveBeenCalledTimes(addCallsBeforeRetryWindow + 1);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
  });

  // The roster a registered participant mutation reads is its idempotence
  // filter: a `remove` of an agent it does not list and an `add` of one it
  // does send no transaction. Each lane installs a roster source that lags the
  // chain, and proves through a read allowed to consume that source that the
  // lag is really installed; the mutation must still send exactly what the
  // chain roster calls for.
  it.each<readonly [
    string,
    Parameters<DKGAgent['resolveRegisteredContextGraphAuthority']>[1],
    (input: {
      agent: DKGAgent;
      chain: MockChainAdapter;
      contextGraphId: string;
      onChainId: bigint;
    }) => (roster: readonly string[]) => void,
  ]>([
    ['the roster cache', { allowCachedRoster: true }, ({ agent: target, chain, onChainId }) => {
      // Without the single live read the policy read carries no roster, so a
      // resolver allowed to use the cache answers from it.
      const liveRead: Pick<ChainAdapter, 'getContextGraphLiveAuthority'> = chain;
      liveRead.getContextGraphLiveAuthority = undefined;
      const { onChainParticipantAgentsCache: cache } = target as unknown as {
        onChainParticipantAgentsCache: Map<string, string[]>;
      };
      return (roster) => {
        cache.set(onChainId.toString(), [...roster]);
      };
    }],
    [
      'the finalized authority projection',
      { authorityReadMode: 'finalized-index' },
      ({ agent: target, chain, contextGraphId, onChainId }) => (roster) => {
        installFinalizedAuthorityReader(chain, finalizedAuthoritySnapshot(
          onChainId,
          target.contextGraphNameCommitment(contextGraphId),
          { accessPolicy: 1, participantAgents: [...roster] },
        ));
      },
    ],
    ['a bounded (index-served) live read', { freshness: 'bounded' }, ({ chain }) => {
      let indexedRoster: readonly string[] | undefined;
      const readLiveAuthority = chain.getContextGraphLiveAuthority.bind(chain);
      vi.spyOn(chain, 'getContextGraphLiveAuthority').mockImplementation(async (id, options) => {
        const current = await readLiveAuthority(id, options);
        return options?.freshness === 'bounded' && current !== null && indexedRoster !== undefined
          ? { ...current, participantAgents: [...indexedRoster] }
          : current;
      });
      return (roster) => {
        indexedRoster = roster;
      };
    }],
  ])('sends the participant transactions the chain roster calls for when %s lags it', async (
    _lane,
    laggingRead,
    installLaggingRoster,
  ) => {
    const contextGraphId = 'registered-private-live-mutation-roster';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'LiveMutationRoster',
      chainAdapter: chain,
    });
    const ownerRecord = await agent.registerAgent('Mutation owner');
    const memberRecord = await agent.registerAgent('Mutation participant');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    const owner = ownerRecord.agentAddress;
    const member = memberRecord.agentAddress;
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Live mutation roster',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const registration = await agent.registerContextGraph(contextGraphId, {
      callerAgentAddress: owner,
    });
    const onChainId = BigInt(registration.onChainId);
    const setLaggingRoster = installLaggingRoster({ agent, chain, contextGraphId, onChainId });
    const laggingRosterHasMember = async (target: DKGAgent): Promise<boolean> => {
      const authority = await target.resolveRegisteredContextGraphAuthority(
        contextGraphId,
        laggingRead,
      );
      if (authority.kind !== 'private') {
        throw new Error(`lagging read returned a ${authority.kind} authority`);
      }
      return authority.participantAgents
        .some((address) => address.toLowerCase() === member.toLowerCase());
    };

    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    const rosterWithMember = await chain.getContextGraphParticipantAgents(onChainId);
    expect(rosterWithMember).toContain(member);
    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');
    const removeParticipant = vi.spyOn(chain, 'removeContextGraphParticipantAgent');

    // The lagging source has not seen the addition: read from it, the member
    // is "not present" and the removal is silently dropped.
    setLaggingRoster(rosterWithMember.filter((address) => address !== member));
    expect(await laggingRosterHasMember(agent)).toBe(false);
    await agent.removeAgentFromContextGraph(contextGraphId, member, owner);
    expect(removeParticipant).toHaveBeenCalledTimes(1);
    expect(removeParticipant).toHaveBeenCalledWith(onChainId, member);
    const rosterWithoutMember = await chain.getContextGraphParticipantAgents(onChainId);
    expect(rosterWithoutMember).not.toContain(member);

    // Nor the removal: read from it, the member is "already present" and the
    // re-add is silently dropped.
    setLaggingRoster([...rosterWithoutMember, member]);
    expect(await laggingRosterHasMember(agent)).toBe(true);
    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    expect(addParticipant).toHaveBeenCalledTimes(1);
    expect(addParticipant).toHaveBeenCalledWith(onChainId, member);
    expect(await chain.getContextGraphParticipantAgents(onChainId)).toContain(member);
  });

  it('completes a cold finalized authority resolution after the request deadline and answers the retry from the retained projection', async () => {
    const contextGraphId = 'finalized-cold-snapshot';
    const COLD_SCAN_MS = 10_000;
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedColdSnapshotResolution',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-cold', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 9n,
      provenance: 'authoritative',
    });
    const snapshot = finalizedAuthoritySnapshot(
      9n,
      agent.contextGraphNameCommitment(contextGraphId),
      { accessPolicy: 1, participantAgents: [MEMBER] },
    );
    // Model the chain reader: the first read of this graph walks the event
    // log (one slow, abortable scan). Once that scan completes WITHOUT an
    // abort the projection is retained and later reads cost no RPC. Like the
    // EVM reader it reports how it served the projection (the completed walk
    // is a `scan`, a retained answer a fresh `cache` hit), which is what lets
    // the private roster decide.
    let projection: ContextGraphAuthoritySnapshot | undefined;
    let scans = 0;
    const scanSignals: AbortSignal[] = [];
    const readIndex = vi.fn(async (
      ids: readonly string[],
      options?: {
        signal?: AbortSignal;
        onContextGraphAuthorityProjectionServed?: (
          report: ContextGraphAuthorityProjectionServedEvidence,
        ) => void;
      },
    ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> => {
      if (projection !== undefined) {
        options?.onContextGraphAuthorityProjectionServed?.({ source: 'cache', ageMs: 0 });
        return new Map(ids.includes(projection.contextGraphId) ? [[projection.contextGraphId, projection]] : []);
      }
      scans += 1;
      const signal = options?.signal;
      if (signal !== undefined) scanSignals.push(signal);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, COLD_SCAN_MS);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('scan aborted'));
        }, { once: true });
      });
      projection = snapshot;
      options?.onContextGraphAuthorityProjectionServed?.({ source: 'scan', ageMs: 0 });
      return new Map([[snapshot.contextGraphId, snapshot]]);
    });
    Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
      readContextGraphAuthorityIndexSnapshots: readIndex,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    });
    // The finalized deadline is no evidence: the request falls back to the
    // bounded current-state read, which on this slow pool times out as well.
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue({ kind: 'unavailable', reason: 'chain-access-policy-timeout' });
    const coldResolution = finalizedAuthorityColdResolutionOf(agent);
    vi.useFakeTimers();

    // 1. The request fails closed at its own deadline...
    const first = agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
    const error = await first;
    expect(error).toBeInstanceOf(ContextGraphReadAuthorityUnavailableError);
    expect(error).toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      retryable: true,
      reason: 'chain-access-policy-timeout',
    });
    expect(live).toHaveBeenCalledTimes(1);
    // ...while the resolution it started keeps running, unaborted.
    expect(scans).toBe(1);
    expect(scanSignals[0]?.aborted).toBe(false);
    expect(coldResolution.inFlightKeys).toEqual(['finalized-authority-snapshot:9']);

    // 2. A retry inside the flight window attaches to the same flight.
    await vi.advanceTimersByTimeAsync(COLD_SCAN_MS - CHAIN_POLICY_READ_TIMEOUT_MS - 2_000);
    const retry = agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retry).resolves.toBeDefined();
    expect(scans).toBe(1);
    expect(scanSignals[0]?.aborted).toBe(false);
    expect(coldResolution.inFlightKeys).toEqual([]);

    // 3. After the flight, the reader answers from its projection: no scan.
    // The retry above never reached the reader at all (it shared the flight),
    // so this is only the second read the reader has ever seen.
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: MEMBER,
    })).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(scans).toBe(1);
    // Only the timed-out first request ever needed the current-state read.
    expect(live).toHaveBeenCalledTimes(1);

    // The finalized roster still denies a non-member without any RPC: the
    // scoped query is refused before execution and answered empty.
    const queryExecution = vi.spyOn(agent.queryEngine, 'query');
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId,
      callerAgentAddress: NON_MEMBER,
    })).resolves.toMatchObject({ bindings: [] });
    expect(queryExecution).not.toHaveBeenCalled();
    expect(scans).toBe(1);
  });

  it('bounds a never-settling cold finalized resolution at the cold budget and restarts it afresh', async () => {
    const contextGraphId = 'finalized-cold-hung';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedColdHungResolution',
      chainAdapter: chain,
    });
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-hung', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 10n,
      provenance: 'authoritative',
    });
    const scanSignals: AbortSignal[] = [];
    const readIndex = vi.fn((
      _ids: readonly string[],
      options?: { signal?: AbortSignal },
    ) => new Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal !== undefined) {
        scanSignals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }
    }));
    Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
      readContextGraphAuthorityIndexSnapshots: readIndex,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    });
    const live = vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockResolvedValue({ kind: 'unavailable', reason: 'chain-access-policy-timeout' });
    vi.useFakeTimers();

    const first = agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
    expect(await first).toMatchObject({ reason: 'chain-access-policy-timeout' });
    expect(live).toHaveBeenCalledTimes(1);
    expect(scanSignals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(
      CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS - CHAIN_POLICY_READ_TIMEOUT_MS - 1,
    );
    expect(scanSignals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scanSignals[0]?.aborted).toBe(true);
    expect(scanSignals[0]?.reason).toMatchObject({
      message: `readFinalizedContextGraphAuthority(10) cold resolution timed out after ${CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS}ms`,
    });

    // The retired flight does not pin the graph: the next request starts anew.
    const second = agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
    expect(await second).toMatchObject({ reason: 'chain-access-policy-timeout' });
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(scanSignals[1]?.aborted).toBe(false);
  });

  it('completes a cold finalized name-binding resolution after the request deadline and answers the retry without a new scan', async () => {
    const contextGraphId = 'finalized-cold-name-binding';
    const COLD_SCAN_MS = 10_000;
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'FinalizedColdNameBindingResolution',
      chainAdapter: chain,
    });
    const nameHash = agent.contextGraphNameCommitment(contextGraphId);
    const snapshot = finalizedAuthoritySnapshot(11n, nameHash);
    let projection: ContextGraphAuthoritySnapshot | undefined;
    let scans = 0;
    const scanSignals: AbortSignal[] = [];
    const resolveByNameHashes = vi.fn(async (
      nameHashes: readonly string[],
      options?: { signal?: AbortSignal },
    ): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>> => {
      if (projection !== undefined) {
        return new Map(nameHashes.includes(projection.nameHash) ? [[projection.nameHash, projection]] : []);
      }
      scans += 1;
      const signal = options?.signal;
      if (signal !== undefined) scanSignals.push(signal);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, COLD_SCAN_MS);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('scan aborted'));
        }, { once: true });
      });
      projection = snapshot;
      return new Map([[snapshot.nameHash, snapshot]]);
    });
    const whenIdle = vi.fn(async () => undefined);
    Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveByNameHashes,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle,
    });
    const legacyResolve = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    mockLivePolicy(agent, 0);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);
    vi.useFakeTimers();

    const first = agent.resolveContextGraphReadAuthority(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    });
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-name-binding-unavailable',
    });
    expect(resolveByNameHashes).toHaveBeenCalledWith(
      [nameHash],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(scans).toBe(1);
    expect(scanSignals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(COLD_SCAN_MS - CHAIN_POLICY_READ_TIMEOUT_MS - 2_000);
    const retry = agent.resolveContextGraphReadAuthority(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retry).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      onChainId: 11n,
    });
    expect(scans).toBe(1);
    expect(scanSignals[0]?.aborted).toBe(false);
    // The physical index fence ran for the completed flight exactly once.
    expect(whenIdle).toHaveBeenCalledTimes(1);

    await expect(agent.resolveContextGraphReadAuthority(contextGraphId, {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({ outcome: 'allowed', onChainId: 11n });
    expect(scans).toBe(1);
    expect(legacyResolve).not.toHaveBeenCalled();
  });

  it('honors a configured request deadline for the finalized authority read', async () => {
    const contextGraphId = 'finalized-configured-deadline';
    const previous = process.env.DKG_CHAIN_AUTHORITY_READ_TIMEOUT_MS;
    process.env.DKG_CHAIN_AUTHORITY_READ_TIMEOUT_MS = '7000';
    const chain = new MockChainAdapter();
    try {
      agent = await DKGAgent.create({
        name: 'FinalizedConfiguredDeadline',
        chainAdapter: chain,
      });
    } finally {
      if (previous === undefined) delete process.env.DKG_CHAIN_AUTHORITY_READ_TIMEOUT_MS;
      else process.env.DKG_CHAIN_AUTHORITY_READ_TIMEOUT_MS = previous;
    }
    Object.defineProperty(agent, 'peerId', { value: 'peer-finalized-configured', configurable: true });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockResolvedValue({
      kind: 'registered',
      onChainId: 12n,
      provenance: 'authoritative',
    });
    const snapshot = finalizedAuthoritySnapshot(12n, agent.contextGraphNameCommitment(contextGraphId));
    const readIndex = vi.fn((ids: readonly string[]) => new Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>>(
      (resolve) => {
        setTimeout(() => resolve(new Map(ids.includes('12') ? [['12', snapshot]] : [])), 5_000);
      },
    ));
    Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
      readContextGraphAuthorityIndexSnapshots: readIndex,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    });
    vi.useFakeTimers();

    const read = agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId });
    // The package default (2.5s) would have failed this read closed.
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(5_000 - CHAIN_POLICY_READ_TIMEOUT_MS);
    await expect(read).resolves.toBeDefined();
    expect(readIndex).toHaveBeenCalledTimes(1);
  });
});
