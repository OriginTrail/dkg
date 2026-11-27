// SPDX-License-Identifier: Apache-2.0

/**
 * The participant-roster mutation's idempotence filter.
 *
 * This function had no tests, and it is the one consumer of the chain roster
 * whose answer decides whether a TRANSACTION IS SENT rather than merely when a
 * decision is taken. The filter is the idempotence check: an `add` is skipped
 * when the agent already appears, a `remove` is skipped when it does not. So a
 * roster that is behind the chain does not delay the mutation here — it
 * cancels it, permanently, because nothing re-runs this.
 *
 * These tests pin that behaviour in both directions before any work routes
 * authority reads through a projection.
 */

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import {
  prepareRegisteredParticipantMutation,
} from '../src/registered-context-graph-participant-mutation.js';
import type { RegisteredContextGraphAuthority } from
  '../src/registered-context-graph-authority.js';

const AGENT_A = ethers.getAddress(`0x${'11'.repeat(20)}`);
const AGENT_B = ethers.getAddress(`0x${'22'.repeat(20)}`);
const CG = 'cg-under-test';

function chainStub() {
  return {
    addContextGraphParticipantAgent: vi.fn(async () => ({ hash: '0xadd' })),
    removeContextGraphParticipantAgent: vi.fn(async () => ({ hash: '0xrm' })),
  } as unknown as Parameters<typeof prepareRegisteredParticipantMutation>[0]['chain'];
}

function privateAuthority(participantAgents: readonly string[]): RegisteredContextGraphAuthority {
  return {
    kind: 'private',
    onChainId: 298n,
    participantAgents: [...participantAgents],
  } as RegisteredContextGraphAuthority;
}

function prepare(
  operation: 'add' | 'remove',
  agentAddresses: readonly string[],
  authority: RegisteredContextGraphAuthority,
) {
  return prepareRegisteredParticipantMutation({
    operation,
    contextGraphId: CG,
    agentAddresses,
    chain: chainStub(),
    rosterFreshness: 'live',
    resolveAuthority: async () => authority,
  });
}

describe('prepareRegisteredParticipantMutation', () => {
  describe('idempotence filter', () => {
    it('adds only agents the roster does not already carry', async () => {
      const prepared = await prepare('add', [AGENT_A, AGENT_B], privateAuthority([AGENT_A]));

      expect(prepared.kind).toBe('registered-private');
      expect(prepared.agentAddresses).toEqual([AGENT_B]);
    });

    it('removes only agents the roster actually carries', async () => {
      const prepared = await prepare('remove', [AGENT_A, AGENT_B], privateAuthority([AGENT_A]));

      expect(prepared.agentAddresses).toEqual([AGENT_A]);
    });

    it('matches roster entries regardless of address casing', async () => {
      const prepared = await prepare(
        'remove', [AGENT_A], privateAuthority([AGENT_A.toLowerCase()]),
      );

      expect(prepared.agentAddresses).toEqual([AGENT_A]);
    });

    it('de-duplicates repeated candidates', async () => {
      const prepared = await prepare('add', [AGENT_A, AGENT_A], privateAuthority([]));

      expect(prepared.agentAddresses).toEqual([AGENT_A]);
    });
  });

  describe('why the roster must be live', () => {
    // These two tests do not assert a bug. They pin the CONSEQUENCE of a stale
    // roster, so that anyone routing this read through a projection sees what
    // it costs and has to change these tests deliberately.

    it('sends NOTHING when a stale roster has not yet seen the agent added', async () => {
      // Agent A was added on chain; this roster predates that event. The
      // removal is filtered out as "not present" and never reaches the chain,
      // so A stays a participant indefinitely.
      const prepared = await prepare('remove', [AGENT_A], privateAuthority([]));

      expect(prepared.agentAddresses).toEqual([]);
    });

    it('sends NOTHING when a stale roster still shows a removed agent', async () => {
      // Agent A was removed on chain; this roster predates that event. The
      // re-add is filtered out as "already present" and silently does nothing.
      const prepared = await prepare('add', [AGENT_A], privateAuthority([AGENT_A]));

      expect(prepared.agentAddresses).toEqual([]);
    });
  });

  describe('non-private graphs', () => {
    it.each([
      ['public', { kind: 'public', onChainId: 298n }],
      ['unregistered', { kind: 'unregistered' }],
    ])('keeps %s graphs on the local-only path', async (_label, authority) => {
      const prepared = await prepare(
        'add', [AGENT_A], authority as RegisteredContextGraphAuthority,
      );

      expect(prepared.kind).toBe('local-only');
      expect(prepared.agentAddresses).toEqual([]);
    });

    it('refuses when the authority could not be resolved', async () => {
      await expect(prepare('add', [AGENT_A], {
        kind: 'unavailable',
        onChainId: 298n,
        reason: 'chain-participant-authority-unavailable',
      } as RegisteredContextGraphAuthority)).rejects.toThrow(/authority is unavailable/);
    });
  });

  it('refuses a graph whose chain cannot govern participants', async () => {
    await expect(prepareRegisteredParticipantMutation({
      operation: 'add',
      contextGraphId: CG,
      agentAddresses: [AGENT_A],
      chain: {} as Parameters<typeof prepareRegisteredParticipantMutation>[0]['chain'],
      rosterFreshness: 'live',
      resolveAuthority: async () => privateAuthority([]),
    })).rejects.toThrow(/participant-governance support/);
  });
});
