import { describe, expect, it } from 'vitest';
import type {
  GraphWriteRevision,
  GraphWriteRevisionSource,
} from '@origintrail-official/dkg-storage';
import { ScopedContentGraphDiscoveryMemo } from '../src/scoped-content-graph-discovery-memo.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function revisionSource(
  coverage: GraphWriteRevisionSource['writeRevisionCoverage'],
  read: () => GraphWriteRevision,
): GraphWriteRevisionSource {
  return { writeRevisionCoverage: coverage, getWriteRevision: read };
}

const REQUEST = {
  contentKey: 'parent',
  laneKey: 'normal',
  graphPrefix: 'did:dkg:context-graph:parent',
};

describe('ScopedContentGraphDiscoveryMemo', () => {
  it('reuses completed values across lanes only under an all-writers revision', async () => {
    let revision = { generation: 1, stable: true };
    let now = 0;
    let loads = 0;
    const memo = new ScopedContentGraphDiscoveryMemo(
      revisionSource('all-writers', () => revision),
      { ttlMs: 10, now: () => now },
    );
    const load = async () => [`urn:graph:${++loads}`];

    await expect(memo.get({ ...REQUEST, load })).resolves.toEqual(['urn:graph:1']);
    await expect(memo.get({ ...REQUEST, laneKey: 'ack', load })).resolves.toEqual([
      'urn:graph:1',
    ]);
    expect(loads).toBe(1);

    now = 11;
    await expect(memo.get({ ...REQUEST, load })).resolves.toEqual(['urn:graph:2']);
    expect(loads).toBe(2);

    revision = { generation: 2, stable: true };
    await expect(memo.get({ ...REQUEST, load })).resolves.toEqual(['urn:graph:3']);
    expect(loads).toBe(3);
  });

  it('never reuses authorization discovery under a process-local revision', async () => {
    const stale = deferred<readonly string[]>();
    let loads = 0;
    const memo = new ScopedContentGraphDiscoveryMemo(
      revisionSource('process-local', () => ({ generation: 1, stable: true })),
    );

    const first = memo.get({ ...REQUEST, load: () => { loads += 1; return stale.promise; } });
    const second = memo.get({
      ...REQUEST,
      load: async () => { loads += 1; return ['urn:graph:fresh']; },
    });
    await expect(second).resolves.toEqual(['urn:graph:fresh']);
    expect(loads).toBe(2);
    stale.resolve(['urn:graph:stale']);
    await expect(first).resolves.toEqual(['urn:graph:stale']);
  });

  it('does not reuse or admit values while the revision is unstable', async () => {
    let revision = { generation: 7, stable: true };
    let loads = 0;
    const memo = new ScopedContentGraphDiscoveryMemo(
      revisionSource('all-writers', () => revision),
    );
    const load = async () => [`urn:graph:${++loads}`];

    await memo.get({ ...REQUEST, load });
    revision = { generation: 7, stable: false };
    await expect(memo.get({ ...REQUEST, load })).resolves.toEqual(['urn:graph:2']);
    expect(loads).toBe(2);

    const crossed = deferred<readonly string[]>();
    revision = { generation: 8, stable: true };
    const crossing = memo.get({ ...REQUEST, load: () => { loads += 1; return crossed.promise; } });
    revision = { generation: 8, stable: false };
    crossed.resolve(['urn:graph:crossed']);
    await crossing;
    revision = { generation: 8, stable: true };
    await memo.get({ ...REQUEST, load });
    expect(loads).toBe(4);
  });

  it('shares only same-generation, same-lane flights and keeps abort caller-local', async () => {
    const gate = deferred<readonly string[]>();
    let loads = 0;
    const memo = new ScopedContentGraphDiscoveryMemo(
      revisionSource('all-writers', () => ({ generation: 1, stable: true })),
    );
    const controller = new AbortController();
    const load = () => { loads += 1; return gate.promise; };

    const aborted = memo.get({ ...REQUEST, signal: controller.signal, load });
    const shared = memo.get({ ...REQUEST, load });
    const otherLane = memo.get({ ...REQUEST, laneKey: 'ack', load });
    expect(loads).toBe(2);
    controller.abort(new Error('caller stopped'));
    await expect(aborted).rejects.toThrow('caller stopped');
    gate.resolve(['urn:graph:ok']);
    await expect(shared).resolves.toEqual(['urn:graph:ok']);
    await expect(otherLane).resolves.toEqual(['urn:graph:ok']);
  });
});
