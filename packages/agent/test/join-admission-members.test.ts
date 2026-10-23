// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { joinAdmissionActiveMembers } from '../src/internal/context-graph-authority/join-admission-members.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';

const CONTEXT_GRAPH = 'join-admission-members';
const MEMBER = '0x00000000000000000000000000000000000000a1';

/** The agent surface the roster reads, with the roster sources it falls back between. */
function curator(input: {
  recoveryRoster: string[] | null;
  registered: RegisteredContextGraphAuthority;
  metadataMembers?: string[] | null;
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
    getLocalMetadataMemberRecoveryGate: vi.fn(async () => {
      input.duringMetadataRead?.();
      return input.metadataMembers ?? null;
    }),
  };
  return { agent, bumpRevision: () => { revision += 1; } };
}

describe('the members a curator\'s join admission recognises (#3421)', () => {
  it('reads a registered public graph\'s members from the curator\'s own metadata', async () => {
    const { agent } = curator({
      recoveryRoster: null,
      registered: { kind: 'public', onChainId: 7n },
      metadataMembers: [MEMBER],
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toEqual([MEMBER]);
    expect(agent.getLocalMetadataMemberRecoveryGate).toHaveBeenCalledWith(CONTEXT_GRAPH);
  });

  it('keeps the member recovery roster of private and unregistered graphs', async () => {
    const { agent } = curator({
      recoveryRoster: [MEMBER],
      registered: { kind: 'private', onChainId: 7n, participantAgents: [MEMBER] },
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toEqual([MEMBER]);
    expect(agent.resolveSwmRegisteredAuthority).not.toHaveBeenCalled();
    expect(agent.getLocalMetadataMemberRecoveryGate).not.toHaveBeenCalled();
  });

  it('has no members when the registration cannot be read', async () => {
    const { agent } = curator({
      recoveryRoster: null,
      registered: { kind: 'unavailable', reason: 'authority-circuit-open' },
      metadataMembers: [MEMBER],
    });

    await expect(joinAdmissionActiveMembers(agent, CONTEXT_GRAPH)).resolves.toBeNull();
    expect(agent.getLocalMetadataMemberRecoveryGate).not.toHaveBeenCalled();
  });

  it('refuses metadata members read while an authority fact changed', async () => {
    const fixture = curator({
      recoveryRoster: null,
      registered: { kind: 'public', onChainId: 7n },
      metadataMembers: [MEMBER],
      duringMetadataRead: () => fixture.bumpRevision(),
    });

    await expect(joinAdmissionActiveMembers(fixture.agent, CONTEXT_GRAPH)).resolves.toBeNull();
  });
});
