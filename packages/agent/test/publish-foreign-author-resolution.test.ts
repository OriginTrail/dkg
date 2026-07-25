import { describe, it, expect } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  contextGraphMetaUri,
  ASSERTION_SEAL_PREDICATES,
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
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR });
    expect(resolved).toBe(MEMBER); // exact stored (checksum) case
  });

  it('prefers the caller when the caller is one of several authors (self-publish unchanged)', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(CURATOR)]);
    const agent = stubAgent(store, CURATOR);
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR });
    expect(resolved).toBe(CURATOR);
  });

  it('throws AMBIGUOUS_ASSERTION_AUTHOR when several non-caller authors share the name', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    await expect(agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).rejects.toMatchObject({
      code: 'AMBIGUOUS_ASSERTION_AUTHOR',
    });
    try {
      await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR });
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
    const resolved = await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: effectiveCaller });
    expect(resolved).toBe(CURATOR);
  });

  it('returns undefined when no author has finalized this name', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, 'no-such-name', { callerAgentAddress: CURATOR })).toBeUndefined();
  });

  it('resolves the subgraph member and does NOT fall back to a same-named root seal', async () => {
    // Member seal in sub-graph 'wing-a' AND a same-named root seal by a different
    // author as a guard: the requested sub-graph scope must resolve the wing-a
    // member, never the root author.
    const store = new OxigraphStore();
    await store.insert([...sealAt(CG, MEMBER, NAME, 'wing-a'), ...sealAt(CG, OTHER, NAME)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, { subGraphName: 'wing-a', callerAgentAddress: CURATOR })).toBe(MEMBER);
    // ...and the root scope resolves the root author, not the wing-a member.
    expect(await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBe(OTHER);
  });

  it('resolves a foreign author for a slash-containing (wallet-scoped) context graph id', async () => {
    // GH#1778 review: validateContextGraphId permits '/'. The from-the-right
    // parser must not mis-split the cg id into a subgraph.
    const slashCg = `0x${'11'.repeat(20)}/project`;
    const store = new OxigraphStore();
    await store.insert(sealAt(slashCg, MEMBER, NAME));
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(slashCg, NAME, { callerAgentAddress: CURATOR })).toBe(MEMBER);
  });

  // A subject with ONLY dkg:assertionMerkleRoot (a stale/partial/peer-supplied
  // fragment) must NOT count as a publishable author candidate.
  function partialSealOnly(author: string, name = NAME): Quad {
    return {
      subject: contextGraphAssertionUri(CG, author, name),
      predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
      object: `"${'ab'.repeat(32)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`,
      graph: contextGraphMetaUri(CG),
    };
  }

  it('does NOT count a partial (merkleRoot-only) subject — resolves the sole complete seal', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), partialSealOnly(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    // The partial OTHER subject must not create false ambiguity.
    expect(await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBe(MEMBER);
  });

  it('treats a partial-only name as not finalized (returns undefined, no unusable author)', async () => {
    const store = new OxigraphStore();
    await store.insert([partialSealOnly(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBeUndefined();
  });

  // A complete seal at MEMBER's coordinate but whose authorAddress/kaUal name a
  // DIFFERENT author must NOT be trusted from the URI — the resolver reads the
  // author from the seal identity, not the subject alone.
  function mismatchedSeal(coordAuthor: string, sealAuthor: string, name = NAME): Quad[] {
    return buildAssertionSealQuads({
      assertionUri: contextGraphAssertionUri(CG, coordAuthor, name),
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot: MERKLE,
      authorAddress: sealAuthor,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: '0x1234567890123456789012345678901234567890',
      reservedKaId: (BigInt(sealAuthor) << 96n) | 7n,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: `did:dkg:hardhat:31337/${sealAuthor}/7`,
      assertionVersion: 1,
      publicTripleCount: 1,
      privateTripleCount: 0,
    }) as Quad[];
  }

  it('ignores a complete seal whose authorAddress/kaUal disagree with the subject coordinate', async () => {
    const store = new OxigraphStore();
    // Subject coordinate = MEMBER, but the seal names OTHER.
    await store.insert(mismatchedSeal(MEMBER, OTHER));
    const agent = stubAgent(store, CURATOR);
    // Neither MEMBER (URI) nor OTHER (seal) is resolved — the subject is not a
    // self-consistent candidate, so it is treated as not finalized.
    expect(await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBeUndefined();
  });

  it('resolves the aligned seal and ignores a coordinate-mismatched one at the same name', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...mismatchedSeal(OTHER, `0x${'33'.repeat(20)}`)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, { callerAgentAddress: CURATOR })).toBe(MEMBER);
  });

  it('does not cross-match a name that is a suffix of another (different authors make it observable)', async () => {
    // MEMBER authors 'asset'; OTHER authors 'myasset' (which ends with 'asset').
    // Anchored `/asset` suffix + exact-name check must resolve MEMBER alone. An
    // UNANCHORED suffix match would pull OTHER in and make 'asset' ambiguous —
    // so an accidental regression changes the observable result (throws) instead
    // of silently passing.
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER, 'asset'), ...sealFor(OTHER, 'myasset')]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, 'asset', { callerAgentAddress: CURATOR })).toBe(MEMBER);
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

describe('GH#1786 selectedAuthorAgentAddress (resident-candidate selection)', () => {
  it('resolves an ambiguous coordinate to the selected candidate', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    // Without a selector this same fixture throws AMBIGUOUS_ASSERTION_AUTHOR.
    expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: OTHER,
    })).toBe(OTHER);
  });

  it('returns the STORED case even when the selector is supplied lowercased', async () => {
    const store = new OxigraphStore();
    // Two candidates, so the single-author rule cannot be what returns the
    // checksummed address — only the selector can. MEMBER is the mixed-case constant.
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    const resolved = await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER.toLowerCase(),
    });
    // Stored case, NOT the caller's lowercased input: contextGraphAssertionUri does
    // not canonicalise address case, so a lowercased author would miss the seal.
    expect(resolved).toBe(MEMBER);
    expect(resolved).not.toBe(MEMBER.toLowerCase());
  });

  it('outranks the caller-own preference so a curator can publish a member KA', async () => {
    const store = new OxigraphStore();
    // The curator ALSO owns a same-named KA: rule 1 then silently returns the
    // curator's own and no ambiguity is ever reported to the client.
    await store.insert([...sealFor(CURATOR), ...sealFor(MEMBER)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
    })).toBe(CURATOR);
    expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER,
    })).toBe(MEMBER);
  });

  it('fails closed when the selected author has no finalized KA at this name', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: `0x${'99'.repeat(20)}`,
    })).rejects.toMatchObject({ code: 'ASSERTION_AUTHOR_NOT_RESIDENT' });
  });

  it('fails closed when NO author is resident (never silently ignored)', async () => {
    const store = new OxigraphStore();
    // A seal exists, but under a different assertion name.
    await store.insert(sealFor(MEMBER, 'some-other-name'));
    const agent = stubAgent(store, CURATOR);
    await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER,
    })).rejects.toMatchObject({ code: 'ASSERTION_AUTHOR_NOT_RESIDENT', candidates: [] });
  });

  // The route maps PUBLISH_AUTHOR_NOT_CUSTODIAL to an actionable 409, but that mapping
  // is only meaningful if the PRODUCTION update path actually attaches the code. This
  // pins the emitter, so a regression to a bare Error (HTTP 500) is caught here rather
  // than passing because a route test stubbed the code in.
  it('codes a foreign-author update refusal as PUBLISH_AUTHOR_NOT_CUSTODIAL', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    // No custodial key for MEMBER, and the publisher EOA is somebody else.
    // (Synchronous by contract — an async stub would resolve to a truthy Promise.)
    agent.getCustodialAgentPrivateKey = () => undefined;
    const publisherOverride = {
      publisherFallbackAuthorAddress: async () => CURATOR,
      signAuthorAttestationAsPublisher: async () => ({
        r: `0x${'34'.repeat(32)}`,
        vs: `0x${'56'.repeat(32)}`,
      }),
    } as any;
    const seal = {
      chainId: 31337n,
      kav10Address: '0x1234567890123456789012345678901234567890',
      authorAddress: MEMBER,
      merkleRoot: MERKLE,
      authorSchemeVersion: 1,
      assertionVersion: 2,
    } as any;

    await expect(
      agent._buildPrecomputedUpdateAttestationForSeal(RESERVED_KA_ID, seal, publisherOverride),
    ).rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_NOT_CUSTODIAL' });
  });

  // The async lane resolves the intent BEFORE enqueueing, and the worker only discovers
  // a non-custodial update after the job is accepted. This pins that the intent path
  // refuses up front, so a curator gets the 409 instead of a 202 + doomed job.
  it('refuses to enqueue a foreign-author UPDATE it cannot re-sign, before accepting the job', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    agent.getCustodialAgentPrivateKey = () => undefined;
    agent.publisher = {
      // The publisher EOA is the curator, not the selected member.
      publisherFallbackAuthorAddress: async () => CURATOR,
      hasSwmShareComplete: async () => true,
    };
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async () => ({
          // Already on VM ⇒ the next publish is an UPDATE.
          vmCurrentAssertion: `0x${'ab'.repeat(32)}`,
          swmCurrentAssertion: `0x${'cd'.repeat(32)}`,
        }),
      },
      configurable: true,
    });

    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER,
    })).rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_NOT_CUSTODIAL' });
  });

  // The pre-enqueue gate must not over-refuse: a selected foreign author whose key IS
  // custodial here is a valid update, and a regression that ignored custodial keys would
  // turn working updates into 409s with no other test catching it.
  it('still enqueues a selected foreign-author UPDATE when the author key is custodial here', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealFor(MEMBER), ...sealFor(OTHER)]);
    const agent = stubAgent(store, CURATOR);
    // MEMBER's key IS held by this node.
    agent.getCustodialAgentPrivateKey = (addr: string) =>
      (addr?.toLowerCase() === MEMBER.toLowerCase() ? `0x${'ab'.repeat(32)}` : undefined);
    let historyAgent: string | undefined;
    // A distinctive marker thrown at the FIRST boundary after the preflight. If the gate
    // wrongly refused we would see PUBLISH_AUTHOR_NOT_CUSTODIAL instead, so asserting the
    // marker proves the custodial key was honoured and execution got past the gate.
    // (A `history: null` fixture would NOT prove this: the intent throws "not finalized"
    // BEFORE the preflight runs, so the gate would never be exercised at all.)
    const PAST_THE_GATE = new Error('reached the share-marker check past the re-sign gate');
    agent.publisher = {
      publisherFallbackAuthorAddress: async () => CURATOR,
      hasSwmShareComplete: async () => { throw PAST_THE_GATE; },
    };
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async (_cg: string, _n: string, o: { agentAddress: string }) => {
          historyAgent = o.agentAddress;
          // Already on VM ⇒ the next publish is an UPDATE, which is what arms the gate.
          return {
            vmCurrentAssertion: `0x${'ab'.repeat(32)}`,
            swmCurrentAssertion: `0x${'cd'.repeat(32)}`,
          };
        },
      },
      configurable: true,
    });

    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER,
    })).rejects.toBe(PAST_THE_GATE);
    expect(historyAgent).toBe(MEMBER);
  });

  // GH#1786 review round 2 — `resolveAssertionAuthor` is on the exported DKGAgent
  // surface, so the legacy positional form must keep resolving identically; otherwise an
  // untyped caller silently loses both the sub-graph scope and the caller preference.
  it('accepts the legacy positional (subGraphName, callerAgentAddress) form', async () => {
    const store = new OxigraphStore();
    await store.insert([...sealAt(CG, MEMBER, NAME, 'wing-a'), ...sealAt(CG, OTHER, NAME)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, 'wing-a', CURATOR)).toBe(MEMBER);
    expect(await agent.resolveAssertionAuthor(CG, NAME, undefined, CURATOR)).toBe(OTHER);
    // ...and the named form is equivalent.
    expect(await agent.resolveAssertionAuthor(CG, NAME, {
      subGraphName: 'wing-a', callerAgentAddress: CURATOR,
    })).toBe(MEMBER);
  });

  it('keeps the caller hint when a legacy positional call passes null for subGraphName', async () => {
    // `null` is the common JS placeholder for an omitted positional argument. Reading it
    // as an options object would drop the caller hint that follows it and turn a
    // caller-preferred resolution into an ambiguity error for the same inputs.
    const store = new OxigraphStore();
    await store.insert([...sealFor(CURATOR), ...sealFor(MEMBER)]);
    const agent = stubAgent(store, CURATOR);
    expect(await agent.resolveAssertionAuthor(CG, NAME, null, CURATOR)).toBe(CURATOR);
  });

  it('fails closed on a present-but-empty selector from a direct agent caller', async () => {
    // The HTTP boundary 400s this, but the agent API is public too: an explicitly
    // supplied empty selector must not degrade into "no selector" and let the
    // caller-own preference publish a different author.
    const store = new OxigraphStore();
    await store.insert([...sealFor(CURATOR), ...sealFor(MEMBER)]);
    const agent = stubAgent(store, CURATOR);
    for (const empty of ['', null] as const) {
      await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
        callerAgentAddress: CURATOR,
        selectedAuthorAgentAddress: empty as unknown as string,
      })).rejects.toMatchObject({ code: 'ASSERTION_AUTHOR_NOT_RESIDENT' });
    }
  });

  it('rejects supplying both agentAddress (override) and selectedAuthorAgentAddress (selection)', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
      agentAddress: OTHER,
      selectedAuthorAgentAddress: MEMBER,
    })).rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_SELECTION_CONFLICT' });
  });

  it('rejects a PRESENT-but-malformed selector even when agentAddress would short-circuit', async () => {
    // The conflict guard runs before the `agentAddress` fast path and tests PRESENCE, so a
    // contradictory request cannot be silently resolved under the authoritative override
    // just because the selector happens to be falsy.
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    for (const malformed of ['', null, 'not-an-address'] as const) {
      await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
        agentAddress: OTHER,
        selectedAuthorAgentAddress: malformed as unknown as string,
      })).rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_SELECTION_CONFLICT' });
    }
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

  // GH#1786 — acceptance criterion proven at the layer where money is spent: the
  // seal actually forwarded to the publisher is the SELECTED member's. Also covers
  // the rule-1 override (the curator owns a same-named KA) and the stored-case trap
  // (the selector is supplied lowercased) in the same run.
  it('a selected member author is the one whose seal reaches the publisher, over the curator own KA', async () => {
    const store = new OxigraphStore();
    const exactGraph = `${contextGraphSharedMemoryUri(CG)}/${MEMBER}/7`;
    await store.insert([
      ...sealFor(CURATOR), // the curator ALSO owns this name — rule 1 would win
      ...sealFor(MEMBER),
      { ...PUBLIC_QUAD, graph: exactGraph },
    ]);

    const publishCalls: Array<{ opts: any }> = [];
    const agent = stubAgent(store, CURATOR);
    agent.chain = {};
    agent.publisher = {
      hasSwmShareComplete: async (_cg: string, _n: string, agentAddress: string) =>
        agentAddress === MEMBER,
      clearSwmShareComplete: async () => {},
      clearRemainingSharedMemory: async () => {},
    };
    agent.publishFromSharedMemory = async (_cg: string, _sel: any, opts: any) => {
      publishCalls.push({ opts });
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/31337/7',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [],
      };
    };

    const result = await agent.publishFromFinalizedAssertion(CG, NAME, {
      callerAgentAddress: CURATOR,
      selectedAuthorAgentAddress: MEMBER.toLowerCase(),
    });

    // The MEMBER's coordinate + the MEMBER's own attestation — not the curator's.
    expect(result.assertionUri).toBe(contextGraphAssertionUri(CG, MEMBER, NAME));
    expect(result.seal.authorAddress).toBe(MEMBER);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.opts).toMatchObject({
      kaUal: KA_UAL.toLowerCase(),
      precomputedAttestation: { authorAddress: MEMBER, reservedKaId: RESERVED_KA_ID },
    });
  });
});
