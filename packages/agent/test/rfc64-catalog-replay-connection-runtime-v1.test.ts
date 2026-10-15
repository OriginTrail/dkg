import { describe, expect, it, vi } from 'vitest';
import {
  Rfc64CatalogReplayConnectionRuntimeV1,
  type Rfc64CatalogConnectionReplayResultV1,
  type Rfc64CatalogReplayConnectionRuntimePortsV1,
} from '../src/rfc64/catalog-replay-connection-runtime-v1.js';
import {
  Rfc64CatalogReplayRecoveryRuntimeV1,
  type Rfc64CatalogReplayPeerResultV1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { Rfc64PublicCatalogTransportErrorV1 } from '../src/rfc64/public-catalog-transport-v1.js';

const CG = 'public-cg';
const POLICY = 'policy';

function ports(overrides: Partial<Rfc64CatalogReplayConnectionRuntimePortsV1> = {}) {
  return {
    selectContextGraphIds: () => [CG],
    acquireFence: (_contextGraphId: string, peerId: string) => ({
      peerId,
      generation: 1,
      release: vi.fn(),
    }),
    reannounce: vi.fn(async () => undefined),
    replay: vi.fn(async (): Promise<Rfc64CatalogConnectionReplayResultV1> => ({ failed: 0 })),
    replayStatus: vi.fn(() => ({ failed: false, unresolvedPeerCount: 0 })),
    log: vi.fn(),
    ...overrides,
  };
}

/** Let every replay settle, and the line about it be logged. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function lines(log: { mock: { calls: readonly (readonly unknown[])[] } }, level: 'warn' | 'debug') {
  return log.mock.calls.filter(([logged]) => logged === level).map(([, message]) => String(message));
}

describe('RFC-64 catalog replay connection debounce', () => {
  it('evicts only the oldest peer when the debounce table reaches capacity', () => {
    const connection = ports();
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1(connection, 100, 2);

    runtime.prepare('peer-a', 0)?.admit();
    runtime.prepare('peer-b', 1)?.admit();
    runtime.prepare('peer-c', 2)?.admit();

    expect(runtime.prepare('peer-b', 3)).toBeNull();
    const retriedA = runtime.prepare('peer-a', 3);
    expect(retriedA).not.toBeNull();
    retriedA?.reject();
    expect(connection.replay).toHaveBeenCalledWith(CG, {
      peerId: 'peer-a',
      generation: 1,
      release: expect.any(Function),
    });

    runtime.reset();
    expect(runtime.prepare('peer-b', 4)).not.toBeNull();
  });
});

describe('RFC-64 catalog replay after a connection: what an unfinished run says', () => {
  it('says nothing for a run that finished', async () => {
    const connection = ports();
    new Rfc64CatalogReplayConnectionRuntimeV1(connection).prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    expect(connection.log).not.toHaveBeenCalled();
    expect(connection.replayStatus).not.toHaveBeenCalled();
  });

  it('logs at debug a run that only could not replay from some peers', async () => {
    const connection = ports({
      replay: vi.fn(async () => ({ requested: 1, failed: 2 })),
      replayStatus: vi.fn(() => ({ failed: false, unresolvedPeerCount: 2 })),
    });
    new Rfc64CatalogReplayConnectionRuntimeV1(connection).prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    expect(connection.replayStatus).toHaveBeenCalledWith(CG);
    expect(lines(connection.log, 'warn')).toEqual([]);
    expect(lines(connection.log, 'debug')).toEqual([
      `RFC-64 catalog replay for "${CG}" after peerAAAA connected could not replay from every peer `
        + '(busy, no answer, or no local catalog service); later replays ask again '
        + '(1 peer(s) answered, 2 failed, 2 retried later)',
    ]);
  });

  it('keeps a warning, with its reason and counts, while the graph may lack heads its peers hold', async () => {
    const connection = ports({
      replay: vi.fn(async () => ({ requested: 2, failed: 1 })),
      replayStatus: vi.fn(() => ({ failed: true, unresolvedPeerCount: 0 })),
    });
    new Rfc64CatalogReplayConnectionRuntimeV1(connection).prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    expect(lines(connection.log, 'debug')).toEqual([]);
    expect(lines(connection.log, 'warn')).toEqual([
      `RFC-64 catalog replay incomplete for "${CG}" after peerAAAA connected: this node may lack `
        + 'catalog heads its peers hold until a full replay passes '
        + '(2 peer(s) answered, 1 failed, 0 retried later)',
    ]);
  });

  it('keeps a warning when the graph has no replay status to tell the two apart', async () => {
    const connection = ports({
      replay: vi.fn(async () => ({ failed: 1 })),
      replayStatus: vi.fn(() => null),
    });
    new Rfc64CatalogReplayConnectionRuntimeV1(connection).prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    expect(lines(connection.log, 'warn')).toEqual([
      `RFC-64 catalog replay incomplete for "${CG}" after peerAAAA connected: its replay status is `
        + 'not available (0 peer(s) answered, 1 failed, unknown retried later)',
    ]);
  });

  it('says a run shared by several connecting peers once', async () => {
    const shared = Object.freeze({ requested: 0, failed: 3 });
    const connection = ports({
      replay: vi.fn(async () => shared),
      replayStatus: vi.fn(() => ({ failed: true, unresolvedPeerCount: 3 })),
    });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1(connection);
    for (const peerId of ['12D3KooWpeerAAAA', '12D3KooWpeerBBBB', '12D3KooWpeerCCCC']) {
      runtime.prepare(peerId)?.admit();
    }
    await settled();
    expect(connection.replay).toHaveBeenCalledTimes(3);
    expect(lines(connection.log, 'warn')).toHaveLength(1);
    expect(lines(connection.log, 'warn')[0]).toContain('after peerAAAA connected');
  });

  it('still warns when a replay fails outright', async () => {
    const connection = ports({ replay: vi.fn(async () => { throw new Error('replay unavailable'); }) });
    new Rfc64CatalogReplayConnectionRuntimeV1(connection).prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    expect(lines(connection.log, 'warn')).toEqual([
      'RFC-64 catalog replay failed after peerAAAA connected: replay unavailable',
    ]);
  });
});

/**
 * The same, with the production replay recovery runtime behind the
 * connection runtime: only the peers' answers and this node's applied heads
 * (the parity read) are scripted.
 */
describe('RFC-64 catalog replay after a connection, with the replay recovery runtime', () => {
  interface Target { readonly id: string }

  function wired(options: {
    requestPeer: (contextGraphId: string, peerId: string) => Promise<Rfc64CatalogReplayPeerResultV1<Target>>;
    parityFailed?: () => Promise<boolean>;
  }) {
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: vi.fn(options.requestPeer),
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: options.parityFailed ?? (async () => false),
    });
    const log = vi.fn();
    const connection = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => [CG],
      acquireFence: (contextGraphId, peerId) => recovery.markPeerPending(contextGraphId, POLICY, peerId),
      reannounce: async () => undefined,
      replay: (contextGraphId, demand) => recovery.request({
        contextGraphId, policyDigest: POLICY, kind: 'connection-demand', demand,
      }),
      replayStatus: (contextGraphId) => recovery.status(contextGraphId, POLICY),
      log,
    });
    return { recovery, connection, log };
  }

  const completed = (targets: readonly Target[] = []) => Object.freeze({
    status: 'completed' as const,
    targets: Object.freeze([...targets]),
  });
  const busy = () => new Rfc64PublicCatalogTransportErrorV1(
    'catalog-transport-overloaded',
    'remote peer remained busy after 4 catalog-head replay attempt(s)',
  );

  it('keeps a peer that stayed busy out of the warnings, and asks it again later', async () => {
    const { recovery, connection, log } = wired({ requestPeer: async () => { throw busy(); } });
    connection.prepare('12D3KooWbusyPEER')?.admit();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(lines(log, 'warn')).toEqual([]);
    expect(lines(log, 'debug')).toEqual([expect.stringContaining('(0 peer(s) answered, 1 failed, 1 retried later)')]);
    // Not evidence about this node's rows: the graph is not failed, the peer is retained.
    expect(recovery.status(CG, POLICY)).toMatchObject({ failed: false, unresolvedPeerCount: 1 });
  });

  it('says nothing about a peer that does not serve the graph', async () => {
    const { connection, log } = wired({ requestPeer: async () => ({ status: 'not-provider' as const }) });
    connection.prepare('12D3KooWnotSERVE')?.admit();
    await settled();
    await settled();
    expect(log).not.toHaveBeenCalled();
  });

  it('warns when a peer promised a head this node has not applied', async () => {
    const { recovery, connection, log } = wired({
      requestPeer: async () => completed([{ id: 'head-v2' }]),
      parityFailed: async () => true,
    });
    connection.prepare('12D3KooWheadPEER')?.admit();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(lines(log, 'debug')).toEqual([]);
    expect(lines(log, 'warn')).toEqual([
      `RFC-64 catalog replay incomplete for "${CG}" after headPEER connected: this node may lack `
        + 'catalog heads its peers hold until a full replay passes (1 peer(s) answered, 1 failed, 0 retried later)',
    ]);
    expect(recovery.status(CG, POLICY)).toMatchObject({ failed: true });
  });

  it('says once for a run that peers connecting together share', async () => {
    let answer!: () => void;
    const firstAnswer = new Promise<void>((resolve) => { answer = resolve; });
    const { connection, log } = wired({
      requestPeer: async (_contextGraphId, peerId) => {
        if (peerId === '12D3KooWpeerAAAA') await firstAnswer;
        throw busy();
      },
    });
    // The second peer connects while the first one's replay is still out, and
    // joins that run.
    connection.prepare('12D3KooWpeerAAAA')?.admit();
    await settled();
    connection.prepare('12D3KooWpeerBBBB')?.admit();
    answer();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await settled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(lines(log, 'debug')).toEqual([expect.stringContaining('(0 peer(s) answered, 2 failed, 2 retried later)')]);
  });
});
