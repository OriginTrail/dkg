// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import type { ChainAdapter, ContextGraphAuthoritySnapshot } from '../src/chain-adapter.js';
import { bindContextGraphAuthorityReader } from '../src/context-graph-authority-reader.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

const SNAPSHOT = Object.freeze({
  chainId: '20430',
  governanceContract: '0x1111111111111111111111111111111111111111',
  contextGraphId: '9',
  owner: '0x2222222222222222222222222222222222222222',
  active: true,
  accessPolicy: 0,
  publishPolicy: 1,
  publishAuthority: '0x2222222222222222222222222222222222222222',
  publishAuthorityAccountId: '0',
  participantAgents: Object.freeze([]),
  nameHash: `0x${'33'.repeat(32)}`,
  ownershipEra: '0',
  policyVersion: '0',
  rosterVersion: '0',
  sourceBlockNumber: '42',
  sourceBlockHash: `0x${'44'.repeat(32)}`,
}) satisfies ContextGraphAuthoritySnapshot;

describe('ContextGraphAuthorityReader capability', () => {
  it('binds a supported adapter once and preserves its receiver', async () => {
    const read = vi.fn(function (
      this: { snapshot: ContextGraphAuthoritySnapshot },
      contextGraphId: bigint,
    ) {
      expect(this).toBe(adapter);
      expect(contextGraphId).toBe(9n);
      return Promise.resolve(this.snapshot);
    });
    const adapter = Object.assign(new NoChainAdapter(), {
      snapshot: SNAPSHOT,
      getContextGraphAuthoritySnapshot: read,
    }) as ChainAdapter;

    const capability = bindContextGraphAuthorityReader(adapter);

    expect(capability.status).toBe('supported');
    if (capability.status !== 'supported') throw new Error('unreachable');
    await expect(capability.reader.getContextGraphAuthoritySnapshot(9n))
      .resolves.toBe(SNAPSHOT);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.reader)).toBe(true);
  });

  it('classifies NoChain as unsupported without making construction fail', () => {
    const adapter: ChainAdapter = new NoChainAdapter();

    expect(bindContextGraphAuthorityReader(adapter)).toEqual({
      status: 'unsupported',
      reason: 'get-context-graph-authority-snapshot-unavailable',
    });
  });
});
