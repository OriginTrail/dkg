// SPDX-License-Identifier: Apache-2.0

import {
  RpcEndpointsExhaustedError,
  type ChainReadOptions,
  type ContextGraphAuthorityProjectionServedEvidence,
  type ContextGraphAuthorityIndexId,
  type ContextGraphAuthorityIndexRevisionReader,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';

import {
  createRfc64CatalogAuthorityRefreshOwnerV1,
  createRfc64CatalogAuthorityRevisionSourceV1,
} from '../src/rfc64/catalog-authority-refresh-binding-v1.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';
import { Rfc64CatalogAuthorityRevisionReadFailureV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import type { Rfc64CatalogExecutionPlanV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';

const REVISION_9 = `0x${'09'.repeat(32)}`;

async function runAuthorityRead<T>(
  signal: AbortSignal,
  read: (options: ChainReadOptions) => Promise<T>,
): Promise<T> {
  return read({
    signal,
    onContextGraphAuthorityProjectionServed: () => undefined,
  });
}

function executionPlan(
  selectedAuthority: Readonly<Record<string, never>> = {},
): Rfc64CatalogExecutionPlanV1 {
  return {
    killSwitchActive: false,
    responsibilityDefaultMode: 'catalog',
    contextGraphModes: {},
    legacyContextGraphs: [],
    track2ContextGraphs: [],
    selectedAuthority,
    selectedAuthorityByWireId: {},
    standaloneTrack2Enabled: true,
  };
}

describe('RFC-64 catalog authority refresh construction binding', () => {
  it('filters lifecycle work and projects one shared revision read', async () => {
    const readRevisions = vi.fn(async function (this: { label: string }) {
      expect(this.label).toBe('authority-index-reader');
      return new Map<ContextGraphAuthorityIndexId, string>([
        ['9' as ContextGraphAuthorityIndexId, REVISION_9],
      ]);
    });
    const reader: ContextGraphAuthorityIndexRevisionReader & { label: string } = {
      label: 'authority-index-reader',
      readContextGraphAuthorityIndexRevisions: readRevisions,
      whenIdle: vi.fn(async () => undefined),
    };
    const refresh = vi.fn(async () => 'committed' as const);
    const loop = createRfc64CatalogAuthorityRefreshOwnerV1({
      executionPlan: executionPlan({ manifest: {} as never }),
      readResponsibilities: () => [
        { contextGraphId: 'mapped-a', active: true, mode: 'catalog' },
        { contextGraphId: 'mapped-b', active: true, mode: 'catalog' },
        { contextGraphId: 'unbound', active: true, mode: 'catalog' },
        { contextGraphId: 'legacy', active: true, mode: 'legacy' },
        { contextGraphId: 'inactive', active: false, mode: 'catalog' },
        { contextGraphId: 'manifest', active: true, mode: 'catalog' },
      ],
      revisionSource: {
        revisionReader: reader,
        resolveBinding: (contextGraphId) => (
          contextGraphId.startsWith('mapped') ? '9' : undefined
        ),
        runAuthorityRead,
      },
      refreshContextGraph: refresh,
      onActiveContextGraphIdsReadFailure: vi.fn(),
      onAuthorityRevisionsReadFailure: vi.fn(),
      onRefreshFailure: vi.fn(),
      scheduler: {
        setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
        clearInterval: vi.fn(),
      },
    });

    loop.start();
    await loop.whenIdle();
    expect(readRevisions).toHaveBeenCalledWith(['9'], {
      onContextGraphAuthorityProjectionServed: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(refresh.mock.calls.map(([contextGraphId]) => contextGraphId).sort())
      .toEqual(['mapped-a', 'mapped-b', 'unbound']);

    loop.trigger();
    await loop.whenIdle();
    expect(refresh.mock.calls.map(([contextGraphId]) => contextGraphId).sort())
      .toEqual(['mapped-a', 'mapped-b', 'unbound', 'unbound']);
    await loop.close();
    expect(reader.whenIdle).toHaveBeenCalled();
  });

  it('returns no source for unsupported adapters', () => {
    expect(createRfc64CatalogAuthorityRevisionSourceV1({
      resolveBinding: () => undefined,
      runAuthorityRead,
    })).toBeUndefined();
  });

  it('preserves the local fallback projection when the shared read fails', async () => {
    const failure = new Error('authority index unavailable');
    const source = createRfc64CatalogAuthorityRevisionSourceV1({
      revisionReader: {
        whenIdle: vi.fn(async () => undefined),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => { throw failure; }),
      },
      resolveBinding: (contextGraphId) => contextGraphId === 'mapped' ? '9' : undefined,
      runAuthorityRead,
    });

    await expect(source!.read(
      ['mapped', 'unbound'],
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: Rfc64CatalogAuthorityRevisionReadFailureV1.name,
      cause: failure,
      fallbackContextGraphIds: ['unbound'],
    });
  });

  it('does not release the authority lane until a detached physical scan is idle', async () => {
    const coordinator = new Rfc64AuthorityReadCoordinatorV1();
    const controller = new AbortController();
    const cancellation = new Error('caller cancelled authority refresh');
    let releasePhysicalScan!: () => void;
    let markFirstReadStarted!: () => void;
    const physicalScan = new Promise<void>((resolve) => { releasePhysicalScan = resolve; });
    const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve; });
    let calls = 0;
    const reader: ContextGraphAuthorityIndexRevisionReader = {
      readContextGraphAuthorityIndexRevisions: vi.fn(async (_ids, options) => {
        calls += 1;
        if (calls > 1) {
          return new Map<ContextGraphAuthorityIndexId, string>([
            ['9' as ContextGraphAuthorityIndexId, REVISION_9],
          ]);
        }
        markFirstReadStarted();
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          const onAbort = () => reject(signal?.reason ?? cancellation);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }),
      whenIdle: vi.fn(async () => { await physicalScan; }),
    };
    const source = createRfc64CatalogAuthorityRevisionSourceV1({
      revisionReader: reader,
      resolveBinding: () => '9',
      runAuthorityRead: (signal, read) => coordinator.run(
        signal,
        (readSignal, evidence) => read(evidence.chainReadOptions(readSignal)),
      ),
    })!;

    const first = source.read(['first'], controller.signal);
    await firstReadStarted;
    controller.abort(cancellation);
    await expect(first).rejects.toBe(cancellation);

    const second = source.read(['second'], new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);

    releasePhysicalScan();
    await expect(second).resolves.toEqual(new Map([['second', REVISION_9]]));
    expect(calls).toBe(2);
    await coordinator.close();
  });

  it('forwards projection evidence so stale scheduled reads cannot close the circuit', async () => {
    let now = 0;
    let source: ContextGraphAuthorityProjectionServedEvidence['source'] = 'stale-cache';
    const coordinator = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      jitterRatio: 0,
      now: () => now,
    });
    const reader: ContextGraphAuthorityIndexRevisionReader = {
      readContextGraphAuthorityIndexRevisions: vi.fn(async (_ids, options) => {
        options?.onContextGraphAuthorityProjectionServed?.({
          source,
          ageMs: source === 'scan' ? 0 : 20,
        });
        return new Map<ContextGraphAuthorityIndexId, string>([
          ['9' as ContextGraphAuthorityIndexId, REVISION_9],
        ]);
      }),
      whenIdle: vi.fn(async () => undefined),
    };
    const revisionSource = createRfc64CatalogAuthorityRevisionSourceV1({
      revisionReader: reader,
      resolveBinding: () => '9',
      runAuthorityRead: (signal, read) => coordinator.run(
        signal,
        (readSignal, evidence) => read(evidence.chainReadOptions(readSignal)),
      ),
    })!;

    await expect(coordinator.run(undefined, async () => {
      throw new RpcEndpointsExhaustedError('authority pool exhausted', {
        exhaustionKind: 'mixed',
        retryAfterMs: 10,
      });
    })).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    now = 10;

    await expect(revisionSource.read(['local'], new AbortController().signal))
      .resolves.toEqual(new Map([['local', REVISION_9]]));
    expect(coordinator.snapshot()).toMatchObject({
      state: 'half-open',
      consecutiveExhaustions: 1,
    });

    source = 'scan';
    await expect(revisionSource.read(['local'], new AbortController().signal))
      .resolves.toEqual(new Map([['local', REVISION_9]]));
    expect(coordinator.snapshot()).toMatchObject({
      state: 'closed',
      consecutiveExhaustions: 0,
    });
    await coordinator.close();
  });
});
