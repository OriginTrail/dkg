import { describe, it, expect } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  contextGraphMetaUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

/**
 * GH#1778 — a curator publishes a rootless named KA authored by a MEMBER and
 * received over SWM. The seal lives in the curator's `_meta` under the member's
 * author coordinate. Publish routes carry only the caller's (curator's) token
 * address, so the author must be resolved from stored `_meta`, never claimed by
 * the caller. These tests pin `resolveAssertionAuthor` and the end-to-end
 * auto-resolution in `publishFromFinalizedAssertion`.
 */

const CG = 'construction';
const MEMBER = '0xA32f1cc125401B55911678847426759094055B2d';
const CURATOR = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const NAME = 'justTriplets';
const KA_UAL = `did:dkg:hardhat:31337/${MEMBER}/7`;
const RESERVED_KA_ID = (BigInt(MEMBER) << 96n) | 7n;
const PUBLIC_QUAD: Quad = {
  subject: 'urn:justTriplets:subject1',
  predicate: 'urn:justTriplets:predicate1',
  object: '"value1"',
  graph: '',
};
const MERKLE = computeFlatKCRootV10([PUBLIC_QUAD], []);

function sealAt(cg: string, author: string, name = NAME, subGraphName?: string): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(cg, author, name, subGraphName),
    metaGraph: contextGraphMetaUri(cg),
    merkleRoot: MERKLE,
    authorAddress: author,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: '0x1234567890123456789012345678901234567890',
    reservedKaId: (BigInt(author) << 96n) | 7n,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:hardhat:31337/${author}/7`,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
  }) as Quad[];
}

function sealFor(author: string, name = NAME): Quad[] {
  return sealAt(CG, author, name);
}

function makeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function stubAgent(store: OxigraphStore, defaultAgentAddress: string) {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.store = store;
  agent.log = makeLog();
  agent.defaultAgentAddress = defaultAgentAddress;
  Object.defineProperty(agent, 'peerId', {
    value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    configurable: true,
  });
  return agent;
}

describe('GH#1778 resolveAssertionAuthor', () => {
  it('resolves the sole (member) author when the caller (curator) is not the author', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR);
    expect(resolved).toBe(MEMBER); // exact stored (checksum) case
  });

  it('prefers the caller when the caller is one of several authors (self-publish unchanged)', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(CURATOR)]);
    const agent = stubAgent(store, CURATOR);
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR);
    expect(resolved).toBe(CURATOR);
  });

  it('throws AMBIGUOUS_ASSERTION_AUTHOR when several non-caller authors share the name', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    await expect(agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR)).rejects.toMatchObject({
      code: 'AMBIGUOUS_ASSERTION_AUTHOR',
    });
    try {
      await agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR);
    } catch (e: any) {
      expect(e.candidates).toHaveLength(2);
    }
  });

  it('tokenless self-publish still prefers the node\'s OWN KA when a same-named member seal is also resident', async () => {
    // The node's default identity (CURATOR) self-authored NAME, and it also
    // curates MEMBER's same-named KA (both seals resident). A tokenless publish
    // passes no explicit agentAddress; the caller hint must be the effective
    // identity so the node still self-publishes its own KA (no false 409).
    const store = new OxigraphStore();
    await store.insert([...sealFor(CURATOR), ...sealFor(MEMBER)]);
    const agent = stubAgent(store, CURATOR);
    // Simulate the effective-identity caller hint the publish sites now pass.
    const effectiveCaller = CURATOR; // opts?.agentAddress ?? defaultAgentAddress
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, undefined, effectiveCaller);
    expect(resolved).toBe(CURATOR);
  });

  it('returns undefined when no author has finalized this name', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, 'no-such-name', undefined, CURATOR)).toBeUndefined();
  });

  it('resolves the subgraph member and does NOT fall back to a same-named root seal', async () => {
    // Member seal in sub-graph 'wing-a' AND a same-named root seal by a different
    // author as a guard: the requested sub-graph scope must resolve the wing-a
    // member, never the root author.
    const store = new OxigraphStore();
    await store.insert([...sealAt(CG, MEMBER, NAME, 'wing-a'), ...sealAt(CG, OTHER, NAME)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, 'wing-a', CURATOR)).toBe(MEMBER);
    // ...and the root scope resolves the root author, not the wing-a member.
    expect(await agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR)).toBe(OTHER);
  });

  it('resolves a foreign author for a slash-containing (wallet-scoped) context graph id', async () => {
    // GH#1778 review: validateContextGraphId permits '/'. The from-the-right
    // parser must not mis-split the cg id into a subgraph.
    const slashCg = `0x${'11'.repeat(20)}/project`;
    const store = new OxigraphStore();
    await store.insert(sealAt(slashCg, MEMBER, NAME));
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(slashCg, NAME, undefined, CURATOR)).toBe(MEMBER);
  });

  it('does not cross-match a name that is a suffix of another', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER, 'triplets'), ...sealFor(MEMBER, 'justTriplets')]);
    const agent = stubAgent(store, CURATOR);
    // 'triplets' must not match '.../justTriplets' (segment-anchored suffix).
    expect(await agent.resolveAssertionAuthor(CG, 'triplets', undefined, CURATOR)).toBe(MEMBER);
    const kaUri = contextGraphAssertionUri(CG, MEMBER, 'triplets');
    expect(kaUri.endsWith('/triplets')).toBe(true);
  });
});

describe('GH#1778 an explicit agentAddress is an authoritative author selector', () => {
  it('does NOT substitute a different sole resident author when an explicit agentAddress is requested', async () => {
    // Only MEMBER has a seal for NAME. A direct caller explicitly requesting
    // OTHER (an author selector, e.g. a programmatic caller) must FAIL as
    // not-finalized — never silently publish MEMBER's same-named KA.
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    agent.chain = {};
    agent.publisher = {
      hasSwmShareComplete: async () => true,
      clearSwmShareComplete: async () => {},
      clearRemainingSharedMemory: async () => {},
    };
    await expect(agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: OTHER }))
      .rejects.toThrow(/is not finalized/);
  });

  it('resolveFinalizedAssertionPublishAuthor returns an explicit agentAddress verbatim', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    // Explicit selector wins over resolution, even when MEMBER is the sole seal.
    expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, { agentAddress: OTHER })).toBe(OTHER);
    // A caller hint (no explicit selector) resolves the sole member author.
    expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBe(MEMBER);
  });

  it('rejects supplying both agentAddress (selector) and callerAgentAddress (hint)', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    await expect(
      agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, { agentAddress: OTHER, callerAgentAddress: CURATOR }),
    ).rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_SELECTION_CONFLICT' });
  });
});

describe('GH#1778 resolveFinalizedAssertionVmPublishIntent (async) auto-resolves the member author', () => {
  it('resolves the member author from _meta when the caller (curator) is not the author', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR); // curator is NOT the author
    let historyAgent: string | undefined;
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async (_cg: string, _n: string, o: { agentAddress: string }) => {
          historyAgent = o.agentAddress;
          return null; // force the early exit after author resolution
        },
      },
      configurable: true,
    });
    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME))
      .rejects.toThrow(/is not finalized or does not exist/);
    // The async intent path resolved the MEMBER author before touching history.
    expect(historyAgent).toBe(MEMBER);
  });
});

describe('GH#1778 publishFromFinalizedAssertion auto-resolves the member author', () => {
  it('a curator publishing a member-authored KA (no agentAddress) reaches the member seal', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, MEMBER, NAME);
    const exactGraph = `${contextGraphSharedMemoryUri(CG)}/${MEMBER}/7`;
    await store.insert([
      ...sealFor(MEMBER),
      { ...PUBLIC_QUAD, graph: exactGraph },
    ]);

    const publishCalls: Array<{ contextGraphId: string; selection: any; opts: any }> = [];
    const markerCalls: Array<{ agentAddress: string }> = [];
    const agent = stubAgent(store, CURATOR); // curator is NOT the author
    agent.chain = {};
    agent.publisher = {
      hasSwmShareComplete: async (_cg: string, _n: string, agentAddress: string) => {
        markerCalls.push({ agentAddress });
        return agentAddress === MEMBER;
      },
      clearSwmShareComplete: async () => {},
      clearRemainingSharedMemory: async () => {},
    };
    agent.publishFromSharedMemory = async (contextGraphId: string, selection: any, opts: any) => {
      publishCalls.push({ contextGraphId, selection, opts });
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/31337/7',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [],
      };
    };

    // No agentAddress passed — the curator (default) is not the author. Before
    // #1778 this threw "is not finalized"; now it resolves MEMBER.
    const result = await agent.publishFromFinalizedAssertion(CG, NAME);
    expect(result.assertionUri).toBe(assertionUri);
    expect(markerCalls.every((c) => c.agentAddress === MEMBER)).toBe(true);
    expect(publishCalls).toHaveLength(1);
    // The forwarded seal carries the MEMBER's attestation (never re-signed by
    // the curator). kaUal is canonicalised to lowercase by the scope helper.
    expect(publishCalls[0]?.opts).toMatchObject({
      kaUal: KA_UAL.toLowerCase(),
      precomputedAttestation: { authorAddress: MEMBER, reservedKaId: RESERVED_KA_ID },
    });
  });
});
