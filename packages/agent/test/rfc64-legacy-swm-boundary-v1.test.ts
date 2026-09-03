// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TripleStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeRfc64LegacySwmBoundaryV1,
  markRfc64LegacySwmRepublishedV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/legacy-boundary';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory_meta`;
const SUBGRAPH_META_GRAPH =
  `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/private-lane/_shared_memory_meta`;
const UAL_ONE = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const UAL_TWO = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2';

describe('RFC-64 10.0.16 legacy SWM boundary', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })));
  });

  it('captures once, remains private by count, and retires only after explicit republish', async () => {
    const root = await secureTempRoot(roots);
    const heads = new Map<string, string[]>([
      [META_GRAPH, [UAL_ONE]],
      [SUBGRAPH_META_GRAPH, []],
    ]);
    const store = fakeStore(heads);
    const firstOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(firstOwner, root, store);

    expect(readRfc64LegacySwmBoundaryCountV1(firstOwner, CONTEXT_GRAPH_ID)).toBe(1);

    // A later restart must load the immutable first-upgrade capture instead of
    // silently classifying a new 10.0.16 share as historical.
    heads.set(SUBGRAPH_META_GRAPH, [UAL_TWO]);
    const restartedOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(restartedOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);

    // A non-captured UAL is a no-op; the captured UAL is cleared only after the
    // caller has already committed its exact catalog projection.
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [UAL_TWO],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [UAL_ONE],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(0);

    const secondRestartOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(secondRestartOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(secondRestartOwner, CONTEXT_GRAPH_ID)).toBe(0);
    expect(store.listGraphs).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a head subject and its canonical UAL differ', async () => {
    const root = await secureTempRoot(roots);
    const store = fakeStore(new Map([[META_GRAPH, [UAL_ONE]]]), `${UAL_TWO}#dkg-swm-head`);

    await expect(initializeRfc64LegacySwmBoundaryV1({}, root, store)).rejects.toThrow(
      `RFC-64 legacy SWM head identity differs for ${UAL_ONE}`,
    );
  });
});

async function secureTempRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dkg-rfc64-legacy-boundary-'));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function fakeStore(
  headsByGraph: Map<string, string[]>,
  forcedHead?: string,
): TripleStore {
  return {
    listGraphs: vi.fn(async () => [...headsByGraph.keys()]),
    query: vi.fn(async (sparql: string) => {
      const graph = [...headsByGraph.keys()].find((candidate) => (
        sparql.includes(`GRAPH <${candidate}>`)
      ));
      return {
        type: 'bindings' as const,
        bindings: (graph === undefined ? [] : headsByGraph.get(graph) ?? []).map((ual) => ({
          head: forcedHead ?? `${ual}#dkg-swm-head`,
          ual,
          contextGraphId: `"${CONTEXT_GRAPH_ID}"`,
        })),
      };
    }),
  } as unknown as TripleStore;
}
