// SPDX-License-Identifier: Apache-2.0
/**
 * Adding a participant agent to a registration roster validates the roster
 * with the addition before anything is stored.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { addRegistrationParticipantAgent, type RegistrationRoster } from '../src/context-graph-registration-roster.js';
import { MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS } from '../src/dkg-agent-constants.js';

const CONTEXT_GRAPH = 'roster-under-test';

function address(index: number): string {
  return ethers.getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);
}

/** A roster held in memory, recording what is stored and invalidated. */
function memoryRoster(initial: readonly string[]) {
  const stored = [...initial];
  const inserts: number[] = [];
  const invalidated: string[] = [];
  const roster: RegistrationRoster = {
    insert: async (quads) => {
      inserts.push(quads.length);
      for (const quad of quads) {
        const participant = JSON.parse(quad.object) as string;
        // Like RDF triples, a fact already stored is not stored twice.
        if (!stored.some((address) => address.toLowerCase() === participant.toLowerCase())) stored.push(participant);
      }
    },
    markDirty: (contextGraphId) => { invalidated.push(contextGraphId); },
    participantAgents: async () => [...stored],
  };
  return { roster, stored, inserts, invalidated };
}

describe('adding a participant agent to a registration roster', () => {
  it('refuses an addition beyond the cap without storing anything', async () => {
    const full = Array.from({ length: MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS }, (_, index) => address(index));
    const { roster, stored, inserts, invalidated } = memoryRoster(full);

    await expect(addRegistrationParticipantAgent(roster, CONTEXT_GRAPH, address(MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS), 'adding the curator'))
      .rejects.toThrow(`participantAgents cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after adding the curator`);
    expect(stored).toEqual(full);
    expect(inserts).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it('stores a new participant once, checksummed, and invalidates the projection with it', async () => {
    const { roster, stored, inserts, invalidated } = memoryRoster([address(0)]);
    const added = address(1);

    await expect(addRegistrationParticipantAgent(roster, CONTEXT_GRAPH, added.toLowerCase(), 'adding the curator'))
      .resolves.toEqual([address(0), added]);
    expect(stored).toEqual([address(0), added]);
    expect(inserts).toEqual([1]);
    expect(invalidated).toEqual([CONTEXT_GRAPH]);
  });

  it('adds an agent the roster already lists idempotently, even at the cap', async () => {
    const full = Array.from({ length: MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS }, (_, index) => address(index));
    const { roster, stored } = memoryRoster(full);

    await expect(addRegistrationParticipantAgent(roster, CONTEXT_GRAPH, address(7).toLowerCase(), 'adding the curator'))
      .resolves.toEqual(full);
    expect(stored).toEqual(full);
  });
});
