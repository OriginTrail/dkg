// SPDX-License-Identifier: Apache-2.0

// The agent side of the shared-memory write gate's second look: the canonical
// gate read fresh, a curator metadata refresh when that gate still excludes the
// signer, one deadline over all of it, and what the publisher is told in each
// case (`swm-write-gate-refresh.ts`).
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import type { ContextGraphAgentGateAuthority } from '../src/internal/context-graph-authority/context-graph-authority.js';
import {
  createSwmWriteGateRefreshOracle,
  SWM_WRITE_GATE_REFRESH_FAILED_REASON,
  SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON,
  type SwmWriteGateRefreshHost,
} from '../src/internal/context-graph-authority/swm-write-gate-refresh.js';

const CG = 'did:dkg:context-graph:write-gate-refresh';
const address = (byte: string): string => ethers.getAddress(`0x${byte.repeat(20)}`);
const CURATOR = address('11');
const MEMBER = address('22');
const JOINER = address('33');

const available = (...agentAddresses: string[]): ContextGraphAgentGateAuthority =>
  ({ kind: 'available', agentAddresses });

/**
 * A receiver whose canonical gate answers from `gates` in order (the last answer
 * repeats), and whose curator refresh answers `refresh`.
 */
function host(
  gates: ContextGraphAgentGateAuthority[],
  refresh: () => Promise<boolean> = async () => false,
) {
  let reads = 0;
  const resolveAgentGate = vi.fn<SwmWriteGateRefreshHost['resolveAgentGate']>(async () => {
    const gate = gates[Math.min(reads, gates.length - 1)];
    reads += 1;
    if (gate === undefined) throw new Error('no gate answer prepared');
    return gate;
  });
  const refreshMetaFromCurator = vi.fn<SwmWriteGateRefreshHost['refreshMetaFromCurator']>(refresh);
  return { resolveAgentGate, refreshMetaFromCurator };
}

describe('SWM write gate refresh oracle', () => {
  it('a member added to the chain roster after the receiver last refreshed: the canonical gate admits it without a refresh', async () => {
    const receiver = host([available(CURATOR, MEMBER, JOINER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER.toLowerCase())).resolves.toEqual({
      kind: 'available',
      agentAddresses: [CURATOR, MEMBER, JOINER],
    });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
    expect(receiver.refreshMetaFromCurator).not.toHaveBeenCalled();
  });

  it('a gate resting on stale local metadata: refreshes from the curator and reads once more', async () => {
    const receiver = host([available(CURATOR, MEMBER), available(CURATOR, MEMBER, JOINER)], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({
      kind: 'available',
      agentAddresses: [CURATOR, MEMBER, JOINER],
    });
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(1);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['chain-participant-authority-unavailable', true],
    ['chain-access-policy-timeout', true],
    ['chain-participant-authority-unsupported', false],
  ] as const)('an unavailable authority (%s) is reported as such, retryable=%s, and nothing is refreshed', async (reason, retryable) => {
    const receiver = host([{ kind: 'unavailable', reason }]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({ kind: 'unavailable', reason, retryable });
    expect(receiver.refreshMetaFromCurator).not.toHaveBeenCalled();
  });

  it('a signer a fresh gate still excludes is answered from memory for a while, then read again', async () => {
    let clock = 1_000;
    const receiver = host([available(CURATOR, MEMBER)], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { now: () => clock, excludedSignerTtlMs: 5_000 });

    const excluded = { kind: 'available', agentAddresses: [CURATOR, MEMBER] };
    await expect(oracle(CG, JOINER)).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(1);

    clock += 4_999;
    await expect(oracle(CG, JOINER.toLowerCase())).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);

    clock += 1;
    await expect(oracle(CG, JOINER)).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
  });

  it('remembers only so many excluded signers, forgetting the oldest first', async () => {
    const receiver = host([available(CURATOR)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { excludedSignerCacheMax: 2 });
    const signers = ['44', '55', '66'].map(address);

    for (const signer of signers) await oracle(CG, signer);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);

    await oracle(CG, signers[2]!);
    await oracle(CG, signers[1]!);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
    await oracle(CG, signers[0]!);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
  });

  it('an unavailable answer and an admitted signer are not remembered', async () => {
    const receiver = host([
      { kind: 'unavailable', reason: 'chain-participant-authority-unavailable' },
      available(CURATOR, JOINER),
      available(CURATOR, JOINER),
    ]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(oracle(CG, JOINER)).resolves.toMatchObject({ kind: 'available' });
    await expect(oracle(CG, JOINER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
  });

  it('a refresh the cooldown refuses leaves the first fresh gate as the answer', async () => {
    const receiver = host([available(CURATOR, MEMBER)], async () => false);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({ kind: 'available', agentAddresses: [CURATOR, MEMBER] });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
  });

  it('a refresh that fails is no refresh', async () => {
    const receiver = host([available(CURATOR, MEMBER)], async () => { throw new Error('catalog transport overloaded'); });
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({ kind: 'available', agentAddresses: [CURATOR, MEMBER] });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
  });

  it('a graph without any agent roster stays ungated', async () => {
    const receiver = host([{ kind: 'ungated' }], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({ kind: 'ungated' });
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(1);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
  });

  it('a read that does not return inside the deadline answers unavailable and retryable, and aborts the work', async () => {
    let seen: AbortSignal | undefined;
    const receiver: SwmWriteGateRefreshHost = {
      resolveAgentGate: (_cg, { signal }) => new Promise((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      refreshMetaFromCurator: async () => false,
    };
    const oracle = createSwmWriteGateRefreshOracle(receiver, { timeoutMs: 20 });

    await expect(oracle(CG, JOINER)).resolves.toEqual({
      kind: 'unavailable',
      reason: SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON,
      retryable: true,
    });
    expect(seen?.aborted).toBe(true);
  });

  it('a refresh that outlives the deadline is cut off and answered as retryable', async () => {
    const receiver: SwmWriteGateRefreshHost = {
      resolveAgentGate: async () => available(CURATOR, MEMBER),
      refreshMetaFromCurator: (_cg, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    };
    const oracle = createSwmWriteGateRefreshOracle(receiver, { timeoutMs: 20 });

    await expect(oracle(CG, JOINER)).resolves.toEqual({
      kind: 'unavailable',
      reason: SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON,
      retryable: true,
    });
  });

  it('a gate read that throws answers unavailable and retryable with the failure', async () => {
    const receiver = host([]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER)).resolves.toEqual({
      kind: 'unavailable',
      reason: `${SWM_WRITE_GATE_REFRESH_FAILED_REASON}: no gate answer prepared`,
      retryable: true,
    });
  });

  it('concurrent misses by one signer on one graph share one second look', async () => {
    let release: (() => void) | undefined;
    const gateRead = new Promise<void>((resolve) => { release = resolve; });
    const receiver: SwmWriteGateRefreshHost = {
      resolveAgentGate: vi.fn(async () => {
        await gateRead;
        return available(CURATOR, JOINER);
      }),
      refreshMetaFromCurator: async () => false,
    };
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    const first = oracle(CG, JOINER);
    const second = oracle(CG, JOINER.toLowerCase());
    const other = oracle(CG, MEMBER);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'available', agentAddresses: [CURATOR, JOINER] },
      { kind: 'available', agentAddresses: [CURATOR, JOINER] },
    ]);
    await other;
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);

    // The shared look is over: the next miss reads again.
    await oracle(CG, JOINER);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
  });
});
