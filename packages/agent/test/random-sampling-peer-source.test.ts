import { describe, expect, it, vi } from 'vitest';
import type { CorePeerDirectoryEntry } from '../src/p2p/core-peer-discovery.js';
import {
  createRandomSamplingPeerSource,
  prepareRandomSamplingPeer,
  renderRandomSamplingCandidateLedger,
  resolveRandomSamplingCandidatePeers,
  type RandomSamplingPeerSourcePorts,
} from '../src/sync/recovery/random-sampling-peer-source.js';

const CG = 'food-safety';

function makePorts(
  overrides: Partial<RandomSamplingPeerSourcePorts> = {},
): RandomSamplingPeerSourcePorts {
  return {
    selfPeerId: 'self',
    maxRosterPeerIds: 64,
    coreEligibilityConcurrency: 4,
    // Far longer than any hermetic case needs, so only the budget cases below
    // observe the bound.
    coreDiscoveryBudgetMs: 60_000,
    isStarted: () => true,
    resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: [] as string[] })),
    findCoreAgents: vi.fn(async () => [] as CorePeerDirectoryEntry[]),
    authenticateCorePeerAddress: vi.fn(async () => true),
    classifyCoreMembership: vi.fn(async () => 'member' as const),
    observedCandidatePeerIds: vi.fn(() => [] as string[]),
    preferredPeerId: vi.fn(() => undefined),
    connectedPeerIds: vi.fn(() => [] as string[]),
    ensurePeerAdmitted: vi.fn(async () => true),
    ensurePeerConnected: vi.fn(async () => undefined),
    hasSyncProtocol: vi.fn(async () => true),
    logInfo: vi.fn(),
    ...overrides,
  };
}

function resolve(ports: RandomSamplingPeerSourcePorts, signal = new AbortController().signal) {
  return resolveRandomSamplingCandidatePeers(ports, CG, signal);
}

describe('Random Sampling proof-time peer source', () => {
  it('orders every source, drops this node, and reports each source separately', async () => {
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      observedCandidatePeerIds: vi.fn(() => ['peer-observed', 'peer-curator']),
      preferredPeerId: vi.fn(() => 'peer-preferred'),
      connectedPeerIds: vi.fn(() => ['peer-connected', 'self']),
      findCoreAgents: vi.fn(async () => [
        { peerId: 'core-b', nodeRole: 'core' },
        { peerId: 'core-a', nodeRole: 'core' },
        { peerId: 'edge-a', nodeRole: 'edge' },
        { peerId: 'self', nodeRole: 'core' },
      ]),
    });

    await expect(resolve(ports)).resolves.toEqual({
      localContextGraphId: CG,
      curatorPeerIds: ['peer-curator'],
      observedPeerIds: ['peer-observed', 'peer-curator'],
      preferredPeerId: 'peer-preferred',
      connectedPeerIds: ['peer-connected', 'self'],
      corePeerIds: ['core-a', 'core-b'],
      candidatePeerIds: [
        'peer-curator',
        'peer-observed',
        'peer-preferred',
        'peer-connected',
        'core-a',
        'core-b',
      ],
    });
    expect(ports.resolveCuratorPeerIds).toHaveBeenCalledWith(CG, expect.objectContaining({
      maxPeerIds: 64,
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(ports.findCoreAgents).toHaveBeenCalledWith({
      nodeRole: 'core',
      limit: 64,
      signal: expect.any(AbortSignal),
    });
  });

  it('records a null preferred peer when the graph has no sticky provider', async () => {
    const ledger = await resolve(makePorts({
      observedCandidatePeerIds: vi.fn(() => ['peer-observed']),
    }));

    expect(ledger.preferredPeerId).toBeNull();
    expect(ledger.candidatePeerIds).toEqual(['peer-observed']);
  });

  it('starts curator and Core discovery concurrently', async () => {
    let releaseCurator!: (value: { peerIds: string[] }) => void;
    let releaseRegistry!: (value: CorePeerDirectoryEntry[]) => void;
    const curatorPromise = new Promise<{ peerIds: string[] }>((r) => { releaseCurator = r; });
    const registryPromise = new Promise<CorePeerDirectoryEntry[]>((r) => { releaseRegistry = r; });
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(() => curatorPromise),
      findCoreAgents: vi.fn(() => registryPromise),
    });

    const pending = resolve(ports);
    await vi.waitFor(() => {
      expect(ports.resolveCuratorPeerIds).toHaveBeenCalledOnce();
      expect(ports.findCoreAgents).toHaveBeenCalledOnce();
    });
    releaseRegistry([{ peerId: 'core-a', nodeRole: 'core' }]);
    releaseCurator({ peerIds: ['peer-curator'] });

    await expect(pending).resolves.toMatchObject({
      candidatePeerIds: ['peer-curator', 'core-a'],
    });
  });

  it('keeps graph-specific providers and logs why the Core roster is missing', async () => {
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      findCoreAgents: vi.fn(async () => { throw new Error('registry unavailable'); }),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      corePeerIds: [],
      candidatePeerIds: ['peer-curator'],
    });
    expect(ports.logInfo).toHaveBeenCalledWith(
      `Random Sampling Core-roster discovery failed for ${CG}: registry unavailable`,
    );
  });

  it('renders a non-Error Core discovery rejection without losing its detail', async () => {
    const ports = makePorts({
      // A transport adapter may reject with a bare string; the ledger log must
      // still name it rather than printing "[object Object]".
      findCoreAgents: vi.fn(() => Promise.reject('registry offline' as unknown as Error)),
    });

    await expect(resolve(ports)).resolves.toMatchObject({ corePeerIds: [] });
    expect(ports.logInfo).toHaveBeenCalledWith(
      `Random Sampling Core-roster discovery failed for ${CG}: registry offline`,
    );
  });

  it('abandons a Core lane that outlasts its budget instead of holding back a known provider', async () => {
    const hangingAuthentications: CorePeerDirectoryEntry[] = [];
    const ports = makePorts({
      coreDiscoveryBudgetMs: 5,
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      observedCandidatePeerIds: vi.fn(() => ['peer-observed']),
      findCoreAgents: vi.fn(async () => [
        { peerId: 'core-stale-a', nodeRole: 'core', agentAddress: '0xaa' },
        { peerId: 'core-stale-b', nodeRole: 'core', agentAddress: '0xbb' },
      ]),
      // A stale directory row whose live identity handshake never answers and
      // never observes the cancellation it was handed.
      authenticateCorePeerAddress: vi.fn((agent: CorePeerDirectoryEntry) => {
        hangingAuthentications.push(agent);
        return new Promise<boolean>(() => {});
      }),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      corePeerIds: [],
      candidatePeerIds: ['peer-curator', 'peer-observed'],
    });
    expect(hangingAuthentications).not.toHaveLength(0);
    expect(ports.logInfo).toHaveBeenCalledWith(
      'Random Sampling Core-roster discovery exceeded its 5ms budget for '
        + `${CG}; continuing with graph-specific providers and 0 Core(s) proven in time`,
    );
  });

  it('keeps the Cores proven before the budget expires when a later Core hangs', async () => {
    const ports = makePorts({
      coreDiscoveryBudgetMs: 20,
      coreEligibilityConcurrency: 1,
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      findCoreAgents: vi.fn(async () => [
        { peerId: 'core-proven', nodeRole: 'core', agentAddress: '0xaa' },
        { peerId: 'core-stale', nodeRole: 'core', agentAddress: '0xbb' },
      ]),
      // The first Core authenticates and passes membership at once; the stale
      // row behind it never answers, so only the budget can end the lane.
      authenticateCorePeerAddress: vi.fn((agent: CorePeerDirectoryEntry) => (
        agent.peerId === 'core-proven'
          ? Promise.resolve(true)
          : new Promise<boolean>(() => {})
      )),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      corePeerIds: ['core-proven'],
      candidatePeerIds: ['peer-curator', 'core-proven'],
    });
    expect(ports.classifyCoreMembership).toHaveBeenCalledTimes(1);
    expect(ports.logInfo).toHaveBeenCalledWith(
      'Random Sampling Core-roster discovery exceeded its 20ms budget for '
        + `${CG}; continuing with graph-specific providers and 1 Core(s) proven in time`,
    );
  });

  it('keeps a Core roster that resolves inside its budget', async () => {
    const ports = makePorts({
      coreDiscoveryBudgetMs: 5_000,
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      findCoreAgents: vi.fn(async () => [
        { peerId: 'core-a', nodeRole: 'core', agentAddress: '0xaa' },
      ]),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      corePeerIds: ['core-a'],
      candidatePeerIds: ['peer-curator', 'core-a'],
    });
    expect(ports.logInfo).not.toHaveBeenCalled();
  });

  it('prefers the repair cancellation reason over its own discovery budget', async () => {
    const controller = new AbortController();
    const reason = new Error('prover stopped');
    const ports = makePorts({
      coreDiscoveryBudgetMs: 5,
      findCoreAgents: vi.fn(async () => {
        controller.abort(reason);
        return new Promise<CorePeerDirectoryEntry[]>(() => {});
      }),
    });

    await expect(resolve(ports, controller.signal)).rejects.toBe(reason);
    expect(ports.logInfo).not.toHaveBeenCalled();
  });

  it('keeps the Core roster when curator discovery fails', async () => {
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(async () => { throw new Error('curator lookup failed'); }),
      findCoreAgents: vi.fn(async () => [{ peerId: 'core-a', nodeRole: 'core' }]),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      curatorPeerIds: [],
      candidatePeerIds: ['core-a'],
    });
  });

  it('re-throws the cancellation reason instead of degrading either source', async () => {
    for (const failing of ['curator', 'core'] as const) {
      const controller = new AbortController();
      const reason = new Error(`prover stopped before ${failing}`);
      const fail = async () => {
        controller.abort(reason);
        throw new Error('source rejected because the operation was cancelled');
      };
      const ports = makePorts(failing === 'curator'
        ? { resolveCuratorPeerIds: vi.fn(fail) }
        : { findCoreAgents: vi.fn(fail) });

      await expect(resolve(ports, controller.signal), failing).rejects.toBe(reason);
      expect(ports.logInfo).not.toHaveBeenCalled();
    }
  });

  it('surfaces the signal reason when the traversal is cancelled during discovery', async () => {
    const controller = new AbortController();
    const reason = new Error('prover stopped');
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(async () => {
        controller.abort(reason);
        return { peerIds: ['peer-curator'] };
      }),
    });

    await expect(resolve(ports, controller.signal)).rejects.toBe(reason);
    expect(ports.connectedPeerIds).not.toHaveBeenCalled();
  });

  it('fails closed as an abort when the agent stops between discovery and selection', async () => {
    const ports = makePorts({ isStarted: () => false });

    await expect(resolve(ports)).rejects.toMatchObject({
      name: 'AbortError',
      message: `Random Sampling provider discovery for ${CG} is no longer current`,
    });
  });

  it('excludes a Core whose live peer cannot authenticate the directory wallet', async () => {
    const ports = makePorts({
      authenticateCorePeerAddress: vi.fn(async (agent: CorePeerDirectoryEntry) =>
        agent.peerId === 'core-authenticated'),
      findCoreAgents: vi.fn(async () => [
        { peerId: 'core-borrowed', nodeRole: 'core', agentAddress: '0xaa' },
        { peerId: 'core-authenticated', nodeRole: 'core', agentAddress: '0xbb' },
      ]),
    });

    await expect(resolve(ports)).resolves.toMatchObject({
      corePeerIds: ['core-authenticated'],
    });
    expect(ports.classifyCoreMembership).toHaveBeenCalledOnce();
  });

  it('always requires positive chain membership, whatever the caller wires', async () => {
    const findCoreAgents = vi.fn(async () => [
      { peerId: 'core-legacy', nodeRole: 'core' },
    ] as CorePeerDirectoryEntry[]);

    // The warm-core path accepts `unavailable` evidence; proof-time discovery is
    // not a policy choice, so the same profile can never reach a proof roster.
    for (const evidence of ['unavailable', 'indeterminate', 'non-member'] as const) {
      await expect(resolve(makePorts({
        findCoreAgents,
        classifyCoreMembership: vi.fn(async () => evidence),
      })), evidence).resolves.toMatchObject({ corePeerIds: [] });
    }

    await expect(resolve(makePorts({
      findCoreAgents,
      classifyCoreMembership: vi.fn(async () => 'member' as const),
    }))).resolves.toMatchObject({ corePeerIds: ['core-legacy'] });
  });

  it('reports admission and sync-protocol gaps as skips, not failures', async () => {
    const signal = new AbortController().signal;
    const ports = makePorts({
      ensurePeerAdmitted: vi.fn(async (peerId: string) => peerId !== 'peer-rejected'),
      hasSyncProtocol: vi.fn(async (peerId: string) => peerId !== 'peer-legacy'),
    });

    await expect(prepareRandomSamplingPeer(ports, 'peer-rejected', signal))
      .resolves.toEqual({ kind: 'skipped', reason: 'not-admitted' });
    await expect(prepareRandomSamplingPeer(ports, 'peer-legacy', signal))
      .resolves.toEqual({ kind: 'skipped', reason: 'sync-protocol-unavailable' });
    await expect(prepareRandomSamplingPeer(ports, 'peer-holder', signal))
      .resolves.toEqual({ kind: 'ready' });

    // A peer that never passed admission is not dialled.
    expect(vi.mocked(ports.ensurePeerConnected).mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-legacy', 'peer-holder']);
    expect(vi.mocked(ports.hasSyncProtocol).mock.calls.map(([, peerSignal]) => peerSignal))
      .toEqual([signal, signal]);
  });

  it('logs the ledger and hands the traversal only the candidate peer IDs', async () => {
    const ports = makePorts({
      resolveCuratorPeerIds: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      findCoreAgents: vi.fn(async () => [{ peerId: 'core-a', nodeRole: 'core' }]),
    });
    const source = createRandomSamplingPeerSource(ports);
    const signal = new AbortController().signal;

    await expect(source.resolveCandidatePeerIds(CG, signal))
      .resolves.toEqual(['peer-curator', 'core-a']);

    const ledgerMessage = vi.mocked(ports.logInfo).mock.calls
      .map(([message]) => message)
      .find((message) => message.startsWith('[rs.tick.kc-repair-candidates] '));
    expect(ledgerMessage).toBeDefined();
    expect(JSON.parse(ledgerMessage!.split('] ')[1]!)).toEqual({
      localContextGraphId: CG,
      curatorPeerIds: ['peer-curator'],
      observedPeerIds: [],
      preferredPeerId: null,
      connectedPeerIds: [],
      corePeerIds: ['core-a'],
      candidatePeerIds: ['peer-curator', 'core-a'],
    });
    expect(ledgerMessage).toBe(renderRandomSamplingCandidateLedger(
      await resolveRandomSamplingCandidatePeers(ports, CG, signal),
    ));

    await expect(source.preparePeer('peer-curator', signal)).resolves.toEqual({ kind: 'ready' });
    expect(ports.ensurePeerAdmitted).toHaveBeenCalledWith('peer-curator', signal);
  });
});
