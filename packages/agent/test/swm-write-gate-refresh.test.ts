// SPDX-License-Identifier: Apache-2.0

// The agent side of the shared-memory write gate's second look: the canonical
// gate read fresh, a curator metadata refresh when that gate still excludes the
// signer, one deadline over all of it, the ration of looks per graph and per
// sending peer, and what the publisher is told in each case
// (`swm-write-gate-refresh.ts`).
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import type { ContextGraphAgentGateAuthority } from '../src/internal/context-graph-authority/context-graph-authority.js';
import {
  createSwmWriteGateRefreshOracle,
  SWM_WRITE_GATE_REFRESH_FAILED_REASON,
  SWM_WRITE_GATE_REFRESH_RATIONED_REASON,
  SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON,
  type SwmWriteGateRefreshHost,
} from '../src/internal/context-graph-authority/swm-write-gate-refresh.js';

const CG = 'did:dkg:context-graph:write-gate-refresh';
const PEER = '12D3KooWWriteGateRefreshPeer';
const OTHER_PEER = '12D3KooWWriteGateRefreshOtherPeer';
const address = (byte: string): string => ethers.getAddress(`0x${byte.repeat(20)}`);
const CURATOR = address('11');
const MEMBER = address('22');
const JOINER = address('33');

const available = (...agentAddresses: string[]): ContextGraphAgentGateAuthority =>
  ({ kind: 'available', agentAddresses });
const RATIONED = { kind: 'unavailable', reason: SWM_WRITE_GATE_REFRESH_RATIONED_REASON, retryable: true };

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

describe('SWM write gate refresh oracle: the second look', () => {
  it('a member added to the chain roster after the receiver last refreshed: the canonical gate admits it without a refresh', async () => {
    const receiver = host([available(CURATOR, MEMBER, JOINER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER.toLowerCase(), PEER)).resolves.toEqual({
      kind: 'available',
      agentAddresses: [CURATOR, MEMBER, JOINER],
    });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
    expect(receiver.refreshMetaFromCurator).not.toHaveBeenCalled();
  });

  it('a gate resting on stale local metadata: refreshes from the curator and reads once more', async () => {
    const receiver = host([available(CURATOR, MEMBER), available(CURATOR, MEMBER, JOINER)], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({
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

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({ kind: 'unavailable', reason, retryable });
    expect(receiver.refreshMetaFromCurator).not.toHaveBeenCalled();
  });

  it('a refresh the cooldown refuses leaves the first fresh gate as the answer', async () => {
    const receiver = host([available(CURATOR, MEMBER)], async () => false);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({ kind: 'available', agentAddresses: [CURATOR, MEMBER] });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
  });

  it('a refresh that fails is no refresh', async () => {
    const receiver = host([available(CURATOR, MEMBER)], async () => { throw new Error('catalog transport overloaded'); });
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({ kind: 'available', agentAddresses: [CURATOR, MEMBER] });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
  });

  it('a graph without any agent roster stays ungated', async () => {
    const receiver = host([{ kind: 'ungated' }], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({ kind: 'ungated' });
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

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({
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

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({
      kind: 'unavailable',
      reason: SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON,
      retryable: true,
    });
  });

  it('a gate read that throws answers unavailable and retryable with the failure', async () => {
    const receiver = host([]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual({
      kind: 'unavailable',
      reason: `${SWM_WRITE_GATE_REFRESH_FAILED_REASON}: no gate answer prepared`,
      retryable: true,
    });
  });
});

describe('SWM write gate refresh oracle: what one window remembers', () => {
  it('the last fresh gate of a graph admits every signer it contains without a read, then expires', async () => {
    let clock = 1_000;
    const receiver = host([available(CURATOR, MEMBER, JOINER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { now: () => clock, windowMs: 5_000 });

    await expect(oracle(CG, JOINER, PEER)).resolves.toMatchObject({ kind: 'available' });
    // The same member again, and another member the same gate contains.
    await expect(oracle(CG, JOINER.toLowerCase(), PEER)).resolves.toMatchObject({ kind: 'available' });
    await expect(oracle(CG, MEMBER, OTHER_PEER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);

    clock += 5_000;
    await expect(oracle(CG, JOINER, PEER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
  });

  it('a signer a fresh gate excluded is answered from memory for the window, then read again', async () => {
    let clock = 1_000;
    const receiver = host([available(CURATOR, MEMBER)], async () => true);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { now: () => clock, windowMs: 5_000 });

    const excluded = { kind: 'available', agentAddresses: [CURATOR, MEMBER] };
    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(1);

    clock += 4_999;
    await expect(oracle(CG, JOINER.toLowerCase(), PEER)).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);

    clock += 1;
    await expect(oracle(CG, JOINER, PEER)).resolves.toEqual(excluded);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
  });

  it('an unavailable answer is not remembered', async () => {
    const receiver = host([
      { kind: 'unavailable', reason: 'chain-participant-authority-unavailable' },
      available(CURATOR, JOINER),
    ]);
    const oracle = createSwmWriteGateRefreshOracle(receiver);

    await expect(oracle(CG, JOINER, PEER)).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(oracle(CG, JOINER, PEER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
  });

  it('remembers only so many signers, forgetting the oldest first', async () => {
    const receiver = host([available(CURATOR)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { memoryMax: 2, looksPerPeer: 10, looksPerGraph: 10 });
    const signers = ['44', '55', '66'].map(address);

    for (const signer of signers) await oracle(CG, signer, PEER);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);

    await oracle(CG, signers[2]!, PEER);
    await oracle(CG, signers[1]!, PEER);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
    await oracle(CG, signers[0]!, PEER);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
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

    const first = oracle(CG, JOINER, PEER);
    const second = oracle(CG, JOINER.toLowerCase(), PEER);
    const other = oracle(CG, MEMBER, OTHER_PEER);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'available', agentAddresses: [CURATOR, JOINER] },
      { kind: 'available', agentAddresses: [CURATOR, JOINER] },
    ]);
    await other;
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);
  });
});

describe('SWM write gate refresh oracle: the ration of looks', () => {
  it('a peer the roster excludes cannot buy a chain read per fresh key: its looks on a graph are rationed per window', async () => {
    let clock = 1_000;
    const receiver = host([available(CURATOR, MEMBER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, {
      now: () => clock, windowMs: 10_000, looksPerPeer: 2, looksPerGraph: 10,
    });
    const freshKey = () => ethers.Wallet.createRandom().address;

    await expect(oracle(CG, freshKey(), PEER)).resolves.toMatchObject({ kind: 'available' });
    await expect(oracle(CG, freshKey(), PEER)).resolves.toMatchObject({ kind: 'available' });
    for (let n = 0; n < 20; n += 1) {
      await expect(oracle(CG, freshKey(), PEER)).resolves.toEqual(RATIONED);
    }
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(2);

    // A member approved meanwhile, writing from another peer, still gets its look.
    receiver.resolveAgentGate.mockResolvedValue(available(CURATOR, MEMBER, JOINER));
    await expect(oracle(CG, JOINER, OTHER_PEER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);

    // The next window gives the rationed peer its looks back.
    clock += 10_000;
    await expect(oracle(CG, freshKey(), PEER)).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
  });

  it('all peers together are rationed per graph, and a rationed miss is answered as retryable without a read', async () => {
    const receiver = host([available(CURATOR, MEMBER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { looksPerPeer: 10, looksPerGraph: 3 });
    const freshKey = () => ethers.Wallet.createRandom().address;

    for (let n = 0; n < 3; n += 1) {
      await expect(oracle(CG, freshKey(), `peer-${n}`)).resolves.toMatchObject({ kind: 'available' });
    }
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(3);
    await expect(oracle(CG, freshKey(), 'peer-99')).resolves.toEqual(RATIONED);
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(3);
    expect(receiver.refreshMetaFromCurator).toHaveBeenCalledTimes(3);

    // Another graph has its own ration.
    await expect(oracle(`${CG}-other`, freshKey(), 'peer-99')).resolves.toMatchObject({ kind: 'available' });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(4);
  });

  it('a member the remembered fresh gate contains is admitted even when the ration is spent', async () => {
    const receiver = host([available(CURATOR, MEMBER, JOINER)]);
    const oracle = createSwmWriteGateRefreshOracle(receiver, { looksPerPeer: 1, looksPerGraph: 1 });

    await expect(oracle(CG, ethers.Wallet.createRandom().address, OTHER_PEER)).resolves.toMatchObject({ kind: 'available' });
    await expect(oracle(CG, ethers.Wallet.createRandom().address, PEER)).resolves.toEqual(RATIONED);
    await expect(oracle(CG, JOINER, PEER)).resolves.toMatchObject({ kind: 'available', agentAddresses: [CURATOR, MEMBER, JOINER] });
    expect(receiver.resolveAgentGate).toHaveBeenCalledTimes(1);
  });
});
