// SPDX-License-Identifier: Apache-2.0

// The agent gate decision and the one revision it fences on (GH#3069). This file is
// also compiled by the package's type tests, so the `@ts-expect-error` below is checked.
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import {
  resolveContextGraphAgentGateAuthorityDecision,
  type ContextGraphAgentGateAuthorityInput,
} from '../src/internal/context-graph-authority/context-graph-agent-gate-authority.js';

const CG = '0xabc/proj';
const address = (byte: string): string => ethers.getAddress(`0x${byte.repeat(20)}`);
const MEMBER = address('11');
const OTHER_MEMBER = address('22');
const JOINER = address('33');

interface Roster {
  allowedAgents: string[];
  participantAgents: string[];
  revokedAgents: string[];
}

/**
 * A graph's roster, its revision, and the gate's asynchronous reads in order:
 * three per attempt (transport, roster, transport again). `during[n]` runs
 * while read `n` is in flight. A roster read has taken its snapshot by then,
 * so a write that lands during it is in the store and not in what was read.
 */
function gate(roster: Roster, options: { revision?: () => number | string } = {}) {
  let writes = 0;
  let reads = 0;
  const during: Array<(() => void) | undefined> = [];
  const inFlight = (): void => {
    const act = during[reads];
    reads += 1;
    act?.();
  };
  const subscription: string[] = [];
  const getLegacyMeta = vi.fn(async () => {
    const snapshot = {
      allowedAgents: [...roster.allowedAgents],
      participantAgents: [...roster.participantAgents],
      revokedAgents: [...roster.revokedAgents],
    };
    inFlight();
    return snapshot;
  });
  const getTransportAuthority = vi.fn(async () => {
    inFlight();
    return { kind: 'legacy-unregistered' as const };
  });
  const input: ContextGraphAgentGateAuthorityInput = {
    contextGraphId: CG,
    getTransportAuthority,
    readRosterRevision: options.revision ?? (() => writes),
    getLegacyMeta,
    getSubscriptionAgents: () => subscription,
  };
  return {
    input,
    during,
    subscription,
    getLegacyMeta,
    getTransportAuthority,
    /** A write to this graph's roster: the store changes and the revision moves. */
    write(change: (roster: Roster) => void): void {
      change(roster);
      writes += 1;
    },
    resolve: () => resolveContextGraphAgentGateAuthorityDecision(input),
  };
}

const roster = (allowedAgents: string[] = [MEMBER, OTHER_MEMBER]): Roster => ({
  allowedAgents,
  participantAgents: [],
  revokedAgents: [],
});

describe('agent gate decision: the revision it reads (GH#3069)', () => {
  it('takes the roster revision and no other', async () => {
    const world = gate(roster());
    let unrelated = 0;
    const readMetadataRevision = vi.fn(() => { unrelated += 1; return unrelated; });
    const withUnrelatedRevision: ContextGraphAgentGateAuthorityInput = {
      ...world.input,
      // @ts-expect-error -- a revision that other writes move is not an input of the gate
      readMetadataRevision,
    };

    await expect(resolveContextGraphAgentGateAuthorityDecision(withUnrelatedRevision))
      .resolves.toEqual({ kind: 'available', agentAddresses: [MEMBER, OTHER_MEMBER] });
    expect(readMetadataRevision).not.toHaveBeenCalled();
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(1);
  });

  it('answers from one read while the roster revision holds', async () => {
    const world = gate(roster());
    await expect(world.resolve()).resolves.toEqual({ kind: 'available', agentAddresses: [MEMBER, OTHER_MEMBER] });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(1);
    expect(world.getTransportAuthority).toHaveBeenCalledTimes(2);
  });

  it('answers ungated for a graph without a roster', async () => {
    const world = gate(roster([]));
    await expect(world.resolve()).resolves.toEqual({ kind: 'ungated' });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a number', (writes: () => number) => writes()],
    ['a per-graph string', (writes: () => number) => `0:${writes()}`],
  ])('compares the revision by value when it is %s', async (_label, render) => {
    let writes = 0;
    const world = gate(roster(), { revision: () => render(() => writes) });
    await expect(world.resolve()).resolves.toEqual({ kind: 'available', agentAddresses: [MEMBER, OTHER_MEMBER] });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(1);

    const moved = gate(roster(), { revision: () => render(() => writes) });
    moved.during[2] = () => { writes += 1; };
    await moved.resolve();
    expect(moved.getLegacyMeta).toHaveBeenCalledTimes(2);
  });
});

describe('agent gate decision: a roster that changes while it is read (GH#3069)', () => {
  it.each([
    ['its roster read', 1],
    ['the transport check after it', 2],
  ])('reads again when a member is added during %s', async (_label, read) => {
    const world = gate(roster());
    world.during[read] = () => world.write((current) => { current.allowedAgents.push(JOINER); });

    await expect(world.resolve()).resolves.toEqual({
      kind: 'available',
      agentAddresses: [MEMBER, OTHER_MEMBER, JOINER],
    });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(2);
  });

  it('reads again when a member is removed during the read', async () => {
    const world = gate(roster());
    world.during[1] = () => world.write((current) => {
      current.allowedAgents = current.allowedAgents.filter((agent) => agent !== MEMBER);
    });

    await expect(world.resolve()).resolves.toEqual({ kind: 'available', agentAddresses: [OTHER_MEMBER] });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(2);
  });

  // Nine reads: three attempts of three. Whichever one a revocation lands in,
  // the member is not in the answer.
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('never returns a member revoked during read %i', async (read) => {
    const world = gate(roster());
    // Another roster change spends each earlier attempt, so the revocation can meet a later one.
    for (let attempt = 0; attempt < Math.floor(read / 3); attempt += 1) {
      world.during[attempt * 3 + 1] = () => world.write((current) => { current.participantAgents.push(JOINER); });
    }
    world.during[read] = () => world.write((current) => { current.revokedAgents.push(MEMBER); });

    const authority = await world.resolve();

    // After the last attempt has taken its revision there is no read left to answer with.
    expect(authority.kind).toBe(read > 6 ? 'unavailable' : 'available');
    if (authority.kind === 'available') {
      expect(authority.agentAddresses).not.toContain(MEMBER);
      expect(authority.agentAddresses).toContain(OTHER_MEMBER);
    } else {
      expect(authority).toMatchObject({ kind: 'unavailable', reason: 'local-existence-unavailable' });
    }
  });

  it('does not fall back to the roster it read before a revocation when the next read fails', async () => {
    const world = gate(roster());
    world.during[1] = () => world.write((current) => { current.revokedAgents.push(MEMBER); });
    world.getLegacyMeta
      .mockImplementationOnce(world.getLegacyMeta.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('store unavailable'));

    await expect(world.resolve()).rejects.toThrow('store unavailable');
  });

  it('refuses after three reads when the roster moves in each of them', async () => {
    const world = gate(roster());
    for (const read of [1, 4, 7]) {
      world.during[read] = () => world.write((current) => { current.participantAgents.push(address(`a${read}`)); });
    }

    const authority = await world.resolve();

    expect(authority).toEqual({
      kind: 'unavailable',
      reason: 'local-existence-unavailable',
      // The promote worker recognises this refusal by the end of its detail.
      detail: `Context graph "${CG}" metadata authority changed while resolving its agent gate`,
    });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(3);
    expect(world.getTransportAuthority).toHaveBeenCalledTimes(6);
  });

  it('answers on the third read when the roster moved in the first two', async () => {
    const world = gate(roster());
    world.during[1] = () => world.write((current) => { current.participantAgents.push(JOINER); });
    world.during[5] = () => world.write((current) => { current.revokedAgents.push(JOINER); });

    await expect(world.resolve()).resolves.toEqual({ kind: 'available', agentAddresses: [MEMBER, OTHER_MEMBER] });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(3);
  });

  it('takes the subscription roster after its last read, and applies the revocations it read to it', async () => {
    const world = gate({ allowedAgents: [MEMBER], participantAgents: [], revokedAgents: [OTHER_MEMBER] });
    world.during[2] = () => { world.subscription.push(JOINER, OTHER_MEMBER); };

    await expect(world.resolve()).resolves.toEqual({ kind: 'available', agentAddresses: [JOINER, MEMBER] });
    expect(world.getLegacyMeta).toHaveBeenCalledTimes(1);
  });
});
