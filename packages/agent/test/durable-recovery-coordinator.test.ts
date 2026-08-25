import { describe, expect, it, vi } from 'vitest';
import {
  DurableRecoveryCoordinator,
  classifyDurableRecoverySlice,
  rankDurableRecoveryPeers,
  selectCanonicalDurableRecoveryManifest,
  type DurableRecoveryPeerCandidate,
} from '../src/sync/durable-recovery-coordinator.js';

const MANIFEST_A = `sha256:${'a'.repeat(64)}` as const;
const MANIFEST_B = `sha256:${'b'.repeat(64)}` as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DurableRecoveryCoordinator', () => {
  it('coalesces unbound and manifest-bound triggers into one graph owner', async () => {
    const coordinator = new DurableRecoveryCoordinator<string>();
    const ownerResult = deferred<string>();
    const started = deferred<void>();
    const runOwner = vi.fn(async (owner) => {
      owner.bindManifest(MANIFEST_A);
      started.resolve();
      return ownerResult.promise;
    });

    const onConnect = coordinator.join({
      contextGraphId: 'cg',
      runOwner,
    });
    await started.promise;
    const explicit = coordinator.join({
      contextGraphId: 'cg',
      manifestDigest: MANIFEST_A,
      runOwner: vi.fn(async () => 'duplicate'),
    });
    const reconciler = coordinator.join({
      contextGraphId: 'cg',
      manifestDigest: MANIFEST_B,
      runOwner: vi.fn(async () => 'duplicate'),
    });

    expect(runOwner).toHaveBeenCalledTimes(1);
    ownerResult.resolve('terminal');
    await expect(Promise.all([onConnect, explicit, reconciler]))
      .resolves.toEqual(['terminal', 'terminal', 'terminal']);
  });

  it('creates a new owner only after the terminal owner settles', async () => {
    const coordinator = new DurableRecoveryCoordinator<number>();
    await expect(coordinator.join({
      contextGraphId: 'cg',
      manifestDigest: MANIFEST_A,
      runOwner: async () => 1,
    })).resolves.toBe(1);
    await expect(coordinator.join({
      contextGraphId: 'cg',
      manifestDigest: MANIFEST_A,
      runOwner: async () => 2,
    })).resolves.toBe(2);
  });
});

describe('durable recovery slice outcomes', () => {
  const classify = (overrides: Partial<Parameters<typeof classifyDurableRecoverySlice>[0]>) => (
    classifyDurableRecoverySlice({
      terminalPersisted: false,
      checkpointAdvanced: false,
      manifestRebound: false,
      deniedPhases: 0,
      rejectedKcs: 0,
      dataRejectedMissingMeta: 0,
      ...overrides,
    })
  );

  it('distinguishes terminal, partial progress, no progress and incompatibility', () => {
    expect(classify({ terminalPersisted: true })).toBe('terminal');
    expect(classify({ checkpointAdvanced: true })).toBe('partial-progress');
    expect(classify({ manifestRebound: true, deniedPhases: 1 })).toBe('partial-progress');
    expect(classify({ deniedPhases: 1 })).toBe('incompatible');
    expect(classify({})).toBe('no-progress');
  });
});

describe('durable recovery peer ranking', () => {
  const candidate = (
    peerId: string,
    input: {
      manifestDigest?: typeof MANIFEST_A | typeof MANIFEST_B;
      offset?: number;
      updatedAtMs?: number;
      lastSuccessfulTransportAtMs?: number;
      attempts?: number;
      timeouts?: number;
      resets?: number;
      discoveryRank?: number;
    },
  ): DurableRecoveryPeerCandidate => ({
    peer: peerId,
    peerId,
    discoveryRank: input.discoveryRank ?? 0,
    ...(input.offset === undefined
      ? {}
      : {
          checkpoint: {
            offset: input.offset,
            updatedAtMs: input.updatedAtMs ?? 0,
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            ...(input.manifestDigest ? { manifestDigest: input.manifestDigest } : {}),
          },
        }),
    health: {
      attempts: input.attempts ?? 0,
      successfulSlices: 0,
      recentTimeouts: input.timeouts ?? 0,
      recentTransportResets: input.resets ?? 0,
      ...(input.lastSuccessfulTransportAtMs === undefined
        ? {}
        : { lastSuccessfulTransportAtMs: input.lastSuccessfulTransportAtMs }),
    },
  });

  it('prefers the canonical manifest and greatest safe prefix before transport history', () => {
    const peers = [
      candidate('zero', {
        manifestDigest: MANIFEST_A,
        offset: 0,
        lastSuccessfulTransportAtMs: 500,
      }),
      candidate('wrong-generation', {
        manifestDigest: MANIFEST_B,
        offset: 5_000_000,
        lastSuccessfulTransportAtMs: 900,
      }),
      candidate('y1s97WVs', {
        manifestDigest: MANIFEST_A,
        offset: 4_191_706,
        lastSuccessfulTransportAtMs: 100,
        attempts: 4,
        timeouts: 2,
      }),
    ];

    expect(rankDurableRecoveryPeers(peers, MANIFEST_A).map(({ peerId }) => peerId))
      .toEqual(['y1s97WVs', 'zero', 'wrong-generation']);
  });

  it('uses success recency then failure rate when safe prefixes tie', () => {
    const peers = [
      candidate('unstable', {
        manifestDigest: MANIFEST_A,
        offset: 100,
        lastSuccessfulTransportAtMs: 10,
        attempts: 4,
        resets: 3,
      }),
      candidate('recent', {
        manifestDigest: MANIFEST_A,
        offset: 100,
        lastSuccessfulTransportAtMs: 20,
        attempts: 4,
        timeouts: 3,
      }),
      candidate('stable', {
        manifestDigest: MANIFEST_A,
        offset: 100,
        lastSuccessfulTransportAtMs: 10,
        attempts: 4,
        timeouts: 1,
      }),
    ];

    expect(rankDurableRecoveryPeers(peers, MANIFEST_A).map(({ peerId }) => peerId))
      .toEqual(['recent', 'stable', 'unstable']);
  });

  it('selects the manifest attached to the greatest verified prefix', () => {
    expect(selectCanonicalDurableRecoveryManifest([
      candidate('old', { manifestDigest: MANIFEST_A, offset: 90, updatedAtMs: 20 }),
      candidate('new', { manifestDigest: MANIFEST_B, offset: 100, updatedAtMs: 10 }),
    ])).toBe(MANIFEST_B);
  });
});
