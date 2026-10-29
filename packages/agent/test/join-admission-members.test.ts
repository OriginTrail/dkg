// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { joinAdmissionActiveMembers } from '../src/internal/context-graph-authority/join-admission-members.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';

const CONTEXT_GRAPH = 'join-admission-members';
const MEMBER = '0x00000000000000000000000000000000000000a1';
const PARTICIPANT = '0x00000000000000000000000000000000000000a2';
const REVOKED = '0x00000000000000000000000000000000000000a3';

interface OwnFacts {
  allowedAgents: string[];
  participantAgents: string[];
  revokedAgents: string[];
}

/** The agent surface the roster reads, with the roster sources it falls back between. */
function curator(input: {
  recoveryRoster: string[] | null;
  registered: RegisteredContextGraphAuthority;
  ownFacts?: Partial<OwnFacts>;
  /** Called during the metadata read, to change an authority fact meanwhile. */
  duringMetadataRead?: () => void;
}) {
  let revision = 0;
  const agent = {
    contextGraphMetaProjection: {
      readContextGraphAuthorityFactsRevision: vi.fn(() => `rev-${revision}`),
    },
    getMemberRecoveryRosterSource: vi.fn(async () => input.recoveryRoster),
    resolveSwmRegisteredAuthority: vi.fn(async () => input.registered),
    getOwnCgMetaFacts: vi.fn(async (): Promise<OwnFacts> => {
      input.duringMetadataRead?.();
      return { allowedAgents: [], participantAgents: [], revokedAgents: [], ...input.ownFacts };
    }),
  };
  return { agent, bumpRevision: () => { revision += 1; } };
}

describe('the members a curator\'s join admission recognises (#3421)', () => {
  it('reads a registered public graph\'s members from the graph\'s own metadata, revoked ones left out', async () => {
    const { agent } = curator({
      recoveryRoster: null,
      registered: { kind: 'public', onChainId: 7n },
      ownFacts: {
        allowedAgents: [MEMBER, REVOKED, 'not-an-address'],
        participantAgents: [PARTICIPANT, MEMBER.toUpperCase().replace('0X', '0x')],
        revokedAgents: [REVOKED],
      },
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH))
      .resolves.toEqual([ethers.getAddress(MEMBER), ethers.getAddress(PARTICIPANT)]);
    expect(agent.getOwnCgMetaFacts).toHaveBeenCalledWith(CONTEXT_GRAPH);
  });

  it('has no members for a registered public graph whose own metadata lists none', async () => {
    const { agent } = curator({ recoveryRoster: null, registered: { kind: 'public', onChainId: 7n } });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toBeNull();
  });

  it('keeps the member recovery roster of private and unregistered graphs', async () => {
    const { agent } = curator({
      recoveryRoster: [MEMBER],
      registered: { kind: 'private', onChainId: 7n, participantAgents: [MEMBER] },
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toEqual([MEMBER]);
    expect(agent.resolveSwmRegisteredAuthority).not.toHaveBeenCalled();
    expect(agent.getOwnCgMetaFacts).not.toHaveBeenCalled();
  });

  it('has no members when the registration cannot be read', async () => {
    const { agent } = curator({
      recoveryRoster: null,
      registered: { kind: 'unavailable', reason: 'authority-circuit-open' },
      ownFacts: { allowedAgents: [MEMBER] },
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toBeNull();
    expect(agent.getOwnCgMetaFacts).not.toHaveBeenCalled();
  });

  it('refuses members read while an authority fact changed', async () => {
    const fixture = curator({
      recoveryRoster: null,
      registered: { kind: 'public', onChainId: 7n },
      ownFacts: { allowedAgents: [MEMBER] },
      duringMetadataRead: () => fixture.bumpRevision(),
    });

    await expect(joinAdmissionActiveMembers(fixture.agent, CONTEXT_GRAPH)).resolves.toBeNull();
  });
});
