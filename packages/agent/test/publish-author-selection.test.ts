import { it, expect, expectTypeOf, vi } from 'vitest';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { readPublishIdentityPlan, type PublishAuthorSelectionOptions } from '../src/publish-author-selection.js';
import { CG, MEMBER, CURATOR, OTHER, NAME, KA_UAL, RESERVED_KA_ID, PUBLIC_QUAD, MERKLE, sealFor, stubAgent } from './_helpers/finalized-author.js';

it.each([
  { authorSelection: null },
  { authorSelection: { mode: 'unknown' } },
  { authorSelection: { mode: 'default' } },
  { authorSelection: { mode: 'callerHint' } },
  { authorSelection: { mode: 'residentAuthor', callerAgentAddress: CURATOR } },
  { authorSelection: { mode: 'callerHint', callerAgentAddress: CURATOR }, callerAgentAddress: CURATOR },
  { callerAgentAddress: 7 },
  { callerAgentAddress: 7, selectedAuthorAgentAddress: MEMBER },
  { subGraphName: 'research', agentAddress: OTHER, callerAgentAddress: CURATOR },
])('rejects malformed or contradictory untyped author selection before looking up an author: %j', async options => {
  const store = new OxigraphStore();
  const query = vi.spyOn(store, 'query');
  const agent = stubAgent(store, CURATOR);
  await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, options as never))
    .rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_SELECTION_CONFLICT' });
  expect(query).not.toHaveBeenCalled();
});

it.each([null, 42, {}])('represents a malformed resident selector explicitly in the immutable plan: %j', selectedAuthorAgentAddress => {
  const plan = readPublishIdentityPlan({ authorSelection: { mode: 'residentAuthor', selectedAuthorAgentAddress } } as never, CURATOR);
  expect(plan.author.mode).toBe('resolve');
  if (plan.author.mode === 'resolve') {
    const selection = plan.author.residentSelection;
    expect(selection).toEqual({ kind: 'malformed', displayValue: String(selectedAuthorAgentAddress) });
    if (selection?.kind === 'malformed') expectTypeOf(selection.displayValue).toEqualTypeOf<string>();
    expect(Object.isFrozen(selection)).toBe(true);
  }
  expect(Object.isFrozen(plan.author)).toBe(true);
  expect(Object.isFrozen(plan)).toBe(true);
});

it.each<{ options: PublishAuthorSelectionOptions; enqueueCaller?: string }>([
  { options: { agentAddress: MEMBER, callerAgentAddress: '' } },
  { options: { agentAddress: MEMBER }, enqueueCaller: MEMBER },
  { options: { authorSelection: { mode: 'author', agentAddress: MEMBER } }, enqueueCaller: MEMBER },
])('captures the complete caller decision beside an authoritative author: $options', ({ options, enqueueCaller }) => {
  expect(readPublishIdentityPlan(options, CURATOR)).toEqual({
    author: { mode: 'author', agentAddress: MEMBER }, enqueueCaller,
  });
});

it('treats undefined legacy optional fields as the default selection', async () => {
  const store = new OxigraphStore();
  await store.insert(sealFor(MEMBER));
  const agent = stubAgent(store, CURATOR);
  expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, {
    agentAddress: undefined, callerAgentAddress: undefined, selectedAuthorAgentAddress: undefined,
  })).toBe(MEMBER);
});

/** Real seals and operation heads; only the chain submission and history facade are stubbed. */
async function publishableAgent() {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  for (const author of [MEMBER, CURATOR]) {
    const kaUal = `did:dkg:hardhat:31337/${author}/7`;
    const scope = { store, graphManager, contextGraphId: CG, kaUal, assertionVersion: 1, shareOperationId: `share-${author}` };
    await store.insert([...sealFor(author), { ...PUBLIC_QUAD, graph: `${contextGraphSharedMemoryUri(CG)}/${author.toLowerCase()}/7` }]);
    await storeKnowledgeAssetWorkspaceHead(scope);
    await storeKnowledgeAssetOperationPublicQuads({ ...scope, quads: [PUBLIC_QUAD], accessPolicy: 'public' });
  }
  const agent = stubAgent(store, CURATOR);
  agent.chain = {};
  agent.publisher = { hasSwmShareComplete: async () => true, clearSwmShareComplete: async () => {}, clearRemainingSharedMemory: async () => {} };
  Object.defineProperty(agent, 'assertion', {
    value: { history: async (_cg: string, _name: string, options: { agentAddress: string }) => ({ events: [], currentShareOperationId: `share-${options.agentAddress}` }) },
  });
  agent.publishFromSharedMemory = vi.fn(async () => ({ kaId: RESERVED_KA_ID, ual: KA_UAL, merkleRoot: MERKLE, kaManifest: [], status: 'confirmed', publicQuads: [] }));
  return { agent, store };
}

it.each([null, 42, {}])('preserves candidate diagnostics for malformed selectors across public APIs: %j', async selectedAuthorAgentAddress => {
  const { agent } = await publishableAgent();
  const expected = {
    code: 'ASSERTION_AUTHOR_NOT_RESIDENT',
    candidates: expect.arrayContaining([MEMBER, CURATOR]),
  };
  await expect(agent.resolveAssertionAuthor(CG, NAME, { selectedAuthorAgentAddress }))
    .rejects.toMatchObject(expected);
  for (const options of [
    { selectedAuthorAgentAddress, callerAgentAddress: CURATOR },
    { authorSelection: { mode: 'residentAuthor', selectedAuthorAgentAddress, callerAgentAddress: CURATOR } },
  ]) {
    await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, options))
      .rejects.toMatchObject(expected);
    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, options))
      .rejects.toMatchObject(expected);
    await expect(agent.publishFromFinalizedAssertion(CG, NAME, options))
      .rejects.toMatchObject(expected);
  }
  expect(agent.publishFromSharedMemory).not.toHaveBeenCalled();
});

it.each<{ options: PublishAuthorSelectionOptions; author: string; caller?: string }>([
  { options: { agentAddress: MEMBER }, author: MEMBER, caller: MEMBER },
  { options: { callerAgentAddress: MEMBER }, author: MEMBER, caller: MEMBER },
  { options: { selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR }, author: MEMBER, caller: CURATOR },
  { options: { selectedAuthorAgentAddress: MEMBER }, author: MEMBER },
  { options: { agentAddress: '', callerAgentAddress: MEMBER }, author: MEMBER, caller: MEMBER },
  { options: { agentAddress: MEMBER, callerAgentAddress: '' }, author: MEMBER },
  { options: { agentAddress: '' }, author: CURATOR },
  { options: {}, author: CURATOR },
])('preserves released flat-option behavior across all three public methods: $options', async ({ options, author, caller }) => {
  const { agent } = await publishableAgent();
  expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, options)).toBe(author);
  const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, options);
  expect(intent.agentAddress).toBe(author);
  expect(intent.callerAgentAddress).toBe(caller);
  const published = await agent.publishFromFinalizedAssertion(CG, NAME, options);
  expect(published.seal.authorAddress).toBe(author);
  expect(agent.publishFromSharedMemory).toHaveBeenCalledWith(CG, expect.anything(), expect.objectContaining({ precomputedAttestation: expect.objectContaining({ authorAddress: author }) }));
});

it.each(['callerHint', 'residentAuthor', 'legacy'] as const)('snapshots %s author and caller across an awaited lookup', async mode => {
  const { agent, store } = await publishableAgent();
  const authorSelection = { mode: 'residentAuthor' as const, selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR };
  const callerSelection = { mode: 'callerHint' as const, callerAgentAddress: MEMBER };
  const legacy = { callerAgentAddress: MEMBER };
  const options = mode === 'residentAuthor' ? { authorSelection } : mode === 'callerHint' ? { authorSelection: callerSelection } : legacy;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const lookupStarted = new Promise<void>(resolve => { entered = resolve; });
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    return query(...args);
  });
  const pending = agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, options);
  await lookupStarted;
  authorSelection.selectedAuthorAgentAddress = CURATOR;
  authorSelection.callerAgentAddress = OTHER;
  callerSelection.callerAgentAddress = CURATOR;
  legacy.callerAgentAddress = CURATOR;
  release();
  const intent = await pending;
  expect(intent.agentAddress).toBe(MEMBER);
  expect(intent.seal.authorAddress.toLowerCase()).toBe(MEMBER.toLowerCase());
  expect(intent.callerAgentAddress).toBe(mode === 'residentAuthor' ? CURATOR : MEMBER);
});


  it('snapshots author selection before an asynchronous author lookup', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const graphManager = new GraphManager(store);
    const shareOperationId = 'selection-snapshot';
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId,
      kaUal: KA_UAL,
      assertionVersion: 1,
      quads: [PUBLIC_QUAD],
      privateTripleCount: 0,
      publisherPeerId: 'publisher-peer',
      accessPolicy: 'ownerOnly',
      agentAddress: MEMBER,
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId,
      kaUal: KA_UAL,
      assertionVersion: 1,
    });

    const agent = stubAgent(store, CURATOR);
    agent.publisher = { hasSwmShareComplete: async () => true };
    agent.getCustodialAgentPrivateKey = () => undefined;
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async () => ({ events: [], currentShareOperationId: shareOperationId }),
      },
      configurable: true,
    });

    let beginLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { beginLookup = resolve; });
    let finishLookup!: () => void;
    const lookupReleased = new Promise<void>((resolve) => { finishLookup = resolve; });
    const query = store.query.bind(store);
    let deferred = false;
    vi.spyOn(store, 'query').mockImplementation((async (sparql: string, ...args: unknown[]) => {
      if (!deferred && sparql.includes('SELECT DISTINCT ?s')) {
        deferred = true;
        beginLookup();
        await lookupReleased;
      }
      return query(sparql, ...args as never[]);
    }) as typeof store.query);

    const options = {
      authorSelection: {
        mode: 'residentAuthor' as const,
        callerAgentAddress: CURATOR,
        selectedAuthorAgentAddress: MEMBER,
      },
    };
    const pending = agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, options);
    await lookupStarted;
    options.authorSelection.callerAgentAddress = OTHER;
    options.authorSelection.selectedAuthorAgentAddress = OTHER;
    finishLookup();

    const intent = await pending;
    expect(intent.agentAddress).toBe(MEMBER);
    expect(intent.callerAgentAddress).toBe(CURATOR);
  });
