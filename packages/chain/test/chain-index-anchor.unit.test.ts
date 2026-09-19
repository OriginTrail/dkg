// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { resolveChainIndexAuthorityAnchor } from '../src/chain-index/chain-index-anchor.js';
import type { ChainEventLogState } from '../src/chain-index/chain-event-log.js';

const STORAGE = `0x${'cd'.repeat(20)}`;
const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

function state(overrides: {
  settled?: number;
  coveredFrom?: number;
  coveredThrough?: number;
  floor?: number;
} = {}): ChainEventLogState {
  const settled = overrides.settled ?? 100;
  return {
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: 10,
      settledBlockNumber: settled,
      settledBlockHash: hash(settled),
      head: {
        number: settled + 5,
        hash: hash(settled + 5),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    coverage: [{
      family: 'context-graph-authority',
      address: STORAGE,
      coveredFromBlock: overrides.coveredFrom ?? 10,
      coveredThroughBlock: overrides.coveredThrough ?? settled,
      floorBlock: overrides.floor ?? 10,
    }],
  };
}

const resolve = (
  input: Partial<Parameters<typeof resolveChainIndexAuthorityAnchor>[0]> = {},
) => resolveChainIndexAuthorityAnchor({
  state: state(),
  contractAddress: STORAGE,
  deploymentBlockNumber: 10,
  ...input,
});

describe('resolveChainIndexAuthorityAnchor', () => {
  it('anchors on the settled cursor and carries the head CHAIN time', () => {
    const { anchor } = resolve();

    expect(anchor?.finalized).toEqual({ number: 100, hash: hash(100) });
    expect(anchor?.head.timestampSeconds).toBe(1_700_000_000);
    expect(anchor?.complete).toBe(true);
  });

  it('refuses when the tick has stored nothing for this scope', () => {
    expect(resolve({ state: undefined }).refusal).toBe('no-cursor');
  });

  it('refuses a contract the coverage record does not mention', () => {
    expect(resolve({ contractAddress: `0x${'ef'.repeat(20)}` }).refusal).toBe('no-coverage');
  });

  it('refuses while history below the cursor is still being backfilled', () => {
    // The anchor would otherwise be served from a prefix nobody has walked.
    const result = resolveChainIndexAuthorityAnchor({
      state: state({ coveredFrom: 60 }),
      contractAddress: STORAGE,
      deploymentBlockNumber: 10,
    });

    expect(result.anchor).toBeUndefined();
    expect(result.refusal).toBe('no-coverage');
  });

  it('reports an incomplete family rather than letting it answer absent', () => {
    const result = resolveChainIndexAuthorityAnchor({
      state: state({ coveredFrom: 10, floor: 1 }),
      contractAddress: STORAGE,
      deploymentBlockNumber: 10,
    });

    expect(result.anchor).toBeDefined();
    expect(result.anchor?.complete).toBe(false);
  });

  it('S6: refuses an answer below this node own just-written block', () => {
    expect(resolve({ requiredBlockNumber: 140 }).refusal).toBe('below-required-block');
    expect(resolve({ requiredBlockNumber: 90 }).anchor).toBeDefined();
  });

  it('refuses before the log has settled anything at all', () => {
    const result = resolveChainIndexAuthorityAnchor({
      state: state({ settled: 9 }),
      contractAddress: STORAGE,
      deploymentBlockNumber: 10,
    });

    expect(result.refusal).toBe('nothing-settled');
  });
});
