// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphAuthorityIndexId,
  ContextGraphAuthorityIndexRevisionReader,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';

import {
  createRfc64CatalogAuthorityRefreshOwnerV1,
  createRfc64CatalogAuthorityRevisionSourceV1,
} from '../src/rfc64/catalog-authority-refresh-binding-v1.js';
import { Rfc64CatalogAuthorityRevisionReadFailureV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import type { Rfc64CatalogExecutionPlanV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';

const REVISION_9 = `0x${'09'.repeat(32)}`;

async function runAuthorityRead<T>(
  signal: AbortSignal,
  read: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  return read(signal);
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
});
