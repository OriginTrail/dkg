import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import type { OnChainContextGraphFacts } from '../src/context-graph-storage-discovery.js';
import type { ListContextGraphsRow } from '../src/context-graph-list-authority-enrichment.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

const CALLER_ADDRESS = '0x1111111111111111111111111111111111111111';
/** A graph the node knows only by the name hash the chain committed. */
const WIRE_ONLY_ID = `0x${'bb'.repeat(32)}`;
/** A user-chosen cleartext id that merely looks like a hash. */
const HASH_LIKE_CLEARTEXT_ID = `0x${'aa'.repeat(32)}`;
const PUBLIC_ID = 'public-cleartext';

const FACTS: OnChainContextGraphFacts = {
  onChainId: '9',
  nameHash: WIRE_ONLY_ID,
  owner: `0x${'22'.repeat(20)}`,
  accessPolicy: 1,
  publishPolicy: 0,
  publishAuthority: `0x${'33'.repeat(20)}`,
  createdAt: 1_790_000_000,
  active: true,
  observedAtBlock: 700,
};

/** Every row is declared private except PUBLIC_ID, with local-only fields. */
function projectedMeta(id: string) {
  return {
    id,
    uri: contextGraphDataUri(id),
    declared: true,
    isSystem: false,
    name: `local name of ${id}`,
    description: `local description of ${id}`,
    curator: 'did:dkg:agent:0x4444444444444444444444444444444444444444',
    creators: [],
    curators: [],
    allowedPeers: [],
    allowedAgents: [],
    participantAgents: [],
    participantIdentityIds: [],
    revokedAgents: [],
    subGraphs: [],
    hasAgentGate: false,
    hasPeerGate: false,
    hasLegacyParticipantGate: false,
    accessPolicy: id === PUBLIC_ID ? 'public' : 'private',
  };
}

function fakeAgent() {
  const ids = [PUBLIC_ID, HASH_LIKE_CLEARTEXT_ID, WIRE_ONLY_ID];
  const allowlistLookups: string[] = [];
  const agent = {
    rfc64AuthorityReadCoordinatorV1: new Rfc64AuthorityReadCoordinatorV1(),
    subscribedContextGraphs: new Map<string, Record<string, unknown>>([
      // The canonical setter's placeholder: it claims its own hash, and the
      // reverse index points back at it.
      [WIRE_ONLY_ID, { onChainHash: WIRE_ONLY_ID, onChainId: '9', subscribed: false, synced: false }],
      // A cleartext row whose id happens to be hash-shaped: its commitment is
      // a different hash, and the reverse index does not point at it.
      [HASH_LIKE_CLEARTEXT_ID, { onChainHash: `0x${'cc'.repeat(32)}`, subscribed: true, synced: true }],
    ]),
    wireIdToLocalCgId: new Map([
      [WIRE_ONLY_ID, WIRE_ONLY_ID],
      [`0x${'cc'.repeat(32)}`, HASH_LIKE_CLEARTEXT_ID],
    ]),
    onChainContextGraphFacts: new Map([['9', FACTS]]),
    contextGraphMetaProjection: {
      listDeclaredContextGraphIds: async () => ids,
    },
    store: {
      query: async () => ({
        type: 'bindings' as const,
        bindings: ids.map((id) => ({
          ctxGraph: contextGraphDataUri(id),
          name: `"local name of ${id}"`,
          access: id === PUBLIC_ID ? '"public"' : '"private"',
        })),
      }),
      listGraphsByPrefix: async () => [],
    },
    getCgMeta: async (id: string) => projectedMeta(id),
    resolveFinalizedContextGraphAuthorityTargetsV1: async () => ({ kind: 'legacy-current' as const }),
    readLocalContextGraphRegistrationStatus: async () => null,
    getContextGraphOnChainId: async () => undefined,
    getContextGraphCurator: async () => undefined,
    isPrivateContextGraph: async (id: string) => id !== PUBLIC_ID,
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async (id: string) => {
      allowlistLookups.push(id);
      return false;
    },
  };
  return { agent, allowlistLookups };
}

async function listUncached(callerAgentAddress: string | null): Promise<ListContextGraphsRow[]> {
  const { agent } = fakeAgent();
  const result = await (ContextGraphResolveMethods.prototype as any)
    .listContextGraphsUncached.call(agent, callerAgentAddress, true);
  return result.rows;
}

async function listProjection(callerAgentAddress: string | null): Promise<ListContextGraphsRow[]> {
  const { agent } = fakeAgent();
  return (ContextGraphResolveMethods.prototype.listContextGraphsFromProjection as any)
    .call(agent, { callerAgentAddress });
}

const WIRE_ONLY_ROW: ListContextGraphsRow = {
  id: WIRE_ONLY_ID,
  uri: contextGraphDataUri(WIRE_ONLY_ID),
  name: WIRE_ONLY_ID,
  isSystem: false,
  subscribed: false,
  synced: false,
  onChainId: '9',
  nameKnown: false,
  onChain: {
    id: '9',
    access: 'private',
    publishPolicy: 'curated',
    publishAuthority: `0x${'33'.repeat(20)}`,
    owner: `0x${'22'.repeat(20)}`,
    createdAt: new Date(1_790_000_000 * 1_000).toISOString(),
    active: true,
    nameHash: WIRE_ONLY_ID,
    observedAtBlock: 700,
  },
};

describe('context graph listing of rows known only by their on-chain name hash', () => {
  for (const [mode, list] of [['legacy', listUncached], ['projection', listProjection]] as const) {
    for (const caller of [null, CALLER_ADDRESS]) {
      it(`lists the wire-only row for every caller, reduced to chain facts (${mode}, ${caller ? 'wallet' : 'no wallet'})`, async () => {
        const rows = await list(caller);

        expect(rows.map((row) => row.id)).toEqual([PUBLIC_ID, WIRE_ONLY_ID]);
        // Private locally, yet listed; no local name, description, curator,
        // access policy or caller annotation survives.
        expect(rows.find((row) => row.id === WIRE_ONLY_ID)).toEqual(WIRE_ONLY_ROW);
        // A hash-shaped cleartext id is an ordinary private row, hidden here.
        expect(rows.some((row) => row.id === HASH_LIKE_CLEARTEXT_ID)).toBe(false);
        expect(rows.find((row) => row.id === PUBLIC_ID)).toMatchObject({
          name: `local name of ${PUBLIC_ID}`,
          nameKnown: true,
        });
      });
    }
  }

  it('annotates only local rows with the caller', async () => {
    const { agent, allowlistLookups } = fakeAgent();
    await (ContextGraphResolveMethods.prototype as any)
      .listContextGraphsUncached.call(agent, CALLER_ADDRESS, true);
    expect(allowlistLookups).not.toContain(WIRE_ONLY_ID);
    expect(allowlistLookups).toContain(HASH_LIKE_CLEARTEXT_ID);
  });
});
