import { it, expect, vi } from 'vitest';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import type { PublishAuthorSelectionOptions } from '../src/publish-author-selection.js';
import { resolveFinalizedPublishIdentity } from '../src/internal/finalized-publish-identity.js';
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
  { agentAddress: OTHER, selectedAuthorAgentAddress: MEMBER },
  { agentAddress: OTHER, selectedAuthorAgentAddress: '' },
  { agentAddress: OTHER, selectedAuthorAgentAddress: null },
])('rejects malformed or contradictory untyped author selection before looking up an author: %j', async options => {
  const store = new OxigraphStore();
  const query = vi.spyOn(store, 'query');
  const agent = stubAgent(store, CURATOR);
  await expect(agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, options as never))
    .rejects.toMatchObject({ code: 'PUBLISH_AUTHOR_SELECTION_CONFLICT' });
  expect(query).not.toHaveBeenCalled();
});

it.each<{ options: PublishAuthorSelectionOptions; enqueueCaller?: string }>([
  { options: { agentAddress: MEMBER, callerAgentAddress: '' } },
  { options: { agentAddress: MEMBER }, enqueueCaller: MEMBER },
  { options: { authorSelection: { mode: 'author', agentAddress: MEMBER } }, enqueueCaller: MEMBER },
])('resolves the complete caller decision beside an authoritative author: $options', async ({ options, enqueueCaller }) => {
  const store = new OxigraphStore();
  const query = vi.spyOn(store, 'query');
  try {
    await expect(resolveFinalizedPublishIdentity(store, { contextGraphId: CG, name: NAME }, options, CURATOR))
      .resolves.toEqual({ agentAddress: MEMBER, enqueueCaller });
    expect(query).not.toHaveBeenCalled();
  } finally { await store.close(); }
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

it.each<PublishAuthorSelectionOptions>([
  { selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR },
  { authorSelection: { mode: 'residentAuthor', selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR } },
])('rejects an invalid resident coordinate before lookup or publication: %j', async options => {
  const { agent, store } = await publishableAgent();
  const query = vi.spyOn(store, 'query');
  for (const resolve of [
    () => agent.resolveFinalizedAssertionPublishAuthor(CG, 'invalid/name', options),
    () => agent.resolveFinalizedAssertionVmPublishIntent(CG, 'invalid/name', options),
    () => agent.publishFromFinalizedAssertion(CG, 'invalid/name', options),
  ]) {
    await expect(resolve()).rejects.toThrow('is not finalized or does not exist');
  }
  expect(query).not.toHaveBeenCalled();
  expect(agent.publishFromSharedMemory).not.toHaveBeenCalled();
});

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
  { options: { authorSelection: { mode: 'author', agentAddress: MEMBER } }, author: MEMBER, caller: MEMBER },
  { options: { authorSelection: { mode: 'callerHint', callerAgentAddress: MEMBER } }, author: MEMBER, caller: MEMBER },
  { options: { authorSelection: { mode: 'residentAuthor', selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR } }, author: MEMBER, caller: CURATOR },
  { options: { authorSelection: { mode: 'residentAuthor', selectedAuthorAgentAddress: MEMBER } }, author: MEMBER },
])('preserves nested and released flat-option behavior across all three public methods: $options', async ({ options, author, caller }) => {
  const { agent } = await publishableAgent();
  expect(await agent.resolveFinalizedAssertionPublishAuthor(CG, NAME, options)).toBe(author);
  const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, options);
  expect(intent.agentAddress).toBe(author);
  expect(intent.callerAgentAddress).toBe(caller);
  const published = await agent.publishFromFinalizedAssertion(CG, NAME, options);
  expect(published.seal.authorAddress).toBe(author);
  expect(agent.publishFromSharedMemory).toHaveBeenCalledWith(CG, expect.anything(), expect.objectContaining({ precomputedAttestation: expect.objectContaining({ authorAddress: author }) }));
});

it.each(['callerHint', 'residentAuthor', 'legacy', 'scope'] as const)('snapshots %s identity and coordinate across an awaited lookup', async mode => {
  const { agent, store } = await publishableAgent();
  const authorSelection = { mode: 'residentAuthor' as const, selectedAuthorAgentAddress: MEMBER, callerAgentAddress: CURATOR };
  const callerSelection = { mode: 'callerHint' as const, callerAgentAddress: MEMBER };
  const legacy = { callerAgentAddress: MEMBER };
  const scope: { callerAgentAddress: string; subGraphName?: string } = { callerAgentAddress: MEMBER };
  const options = mode === 'residentAuthor' ? { authorSelection }
    : mode === 'callerHint' ? { authorSelection: callerSelection }
      : mode === 'scope' ? scope : legacy;
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
  scope.subGraphName = 'mutated-during-lookup';
  release();
  const intent = await pending;
  expect(intent.agentAddress).toBe(MEMBER);
  expect(intent.seal.authorAddress.toLowerCase()).toBe(MEMBER.toLowerCase());
  expect(intent.callerAgentAddress).toBe(mode === 'residentAuthor' ? CURATOR : MEMBER);
  expect(intent.subGraphName).toBeUndefined();
});
