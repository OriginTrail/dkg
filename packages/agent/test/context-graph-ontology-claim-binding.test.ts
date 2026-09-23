/**
 * Base-mainnet Context Graph #33 on a fresh edge that synced the `ontology`
 * system graph on connect (phase-0 run, 2026-09-23, tip da9249960).
 *
 * The ontology graph is shared by every network and deployment, and each
 * creator writes a `dkg:ContextGraphOnChainId` claim into it. On that edge
 * three definitions claimed #33 ("PR68 Open Test", "baseball" and the real
 * graph) and others claimed ids Base does not have. Store discovery bound
 * every claim without checking it against this chain, so:
 *  - `dkg context-graph list` showed #33 three times;
 *  - the real graph was bound by its claim, without the slot's name hash,
 *    before storage enumeration reached #33. Enumeration then took it as
 *    already bound and never recorded the hash, so the hash resolved to
 *    nothing: `dkg subscribe <hash>` printed no note, kept a row keyed by the
 *    hash, and RFC-64 rejected that row's evidence as an "invalid identity".
 *
 * A claim now binds only when this chain's committed name hash for the
 * claimed id is keccak256(utf8(id)).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { MOCK_DEFAULT_SIGNER, MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent } from '../src/index.js';

const keccak = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();

/** The live graph: its cleartext id and the name hash Base #33 commits. */
const REAL_ID = '0x64529c023d853371228923B4FdA5FB22F929bf51/bb-open-20260923-9c3f0';
const REAL_NAME = 'open run open-20260923-9c3f0';
const NAME_HASH = '0x69a1d4a3500548577083af0be5c4376dcf171907ab7da012d25dc778ced894e3';
const SHORT_HASH = '0x69a1d4a3…94e3';
const PRIVATE_34 = 'curated-graph-34';

const otherGraph = (id: number) => `other-graph-${id}`;

/**
 * The claims the live edge's ontology held, reduced to one of each kind:
 * the graph this chain's #33 commits, two other deployments' #33, a claim on
 * the curated #34, an id Base does not have, a correct claim, and a real graph
 * claimed under the wrong id.
 */
const CLAIMS = [
  { id: 'pr68-open-test', name: 'PR68 Open Test', onChainId: '33' },
  { id: REAL_ID, name: REAL_NAME, onChainId: '33' },
  { id: 'baseball', name: 'baseball', onChainId: '33' },
  { id: '0x983587836e8F8C1831b5051582689851aE86A802/mega', name: 'mega', onChainId: '34' },
  { id: 'gnosis-only-graph', name: 'Gnosis #91', onChainId: '91' },
  { id: otherGraph(1), name: 'Other graph 1', onChainId: '1' },
  { id: otherGraph(5), name: 'Other graph 5', onChainId: '7' },
] as const;
const REFUTED = ['pr68-open-test', 'baseball', '0x983587836e8F8C1831b5051582689851aE86A802/mega', 'gnosis-only-graph'];

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

/**
 * Base as of 2026-09-23: #1..#32 are other graphs, #33 is the public graph
 * under test and #34 is curated. All predate the node's live event tail.
 */
async function baseShapedChain(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  // A real RPC reports a head, so the live lane seeds near it instead of
  // replaying from genesis.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (let id = 1; id <= 32; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: keccak(otherGraph(id)),
    } as never);
  }
  const real = await chain.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 0,
    nameHash: NAME_HASH,
  } as never);
  expect(real.contextGraphId).toBe(33n);
  const curated = await chain.createOnChainContextGraph({
    accessPolicy: 1,
    publishPolicy: 0,
    nameHash: keccak(PRIVATE_34),
  } as never);
  expect(curated.contextGraphId).toBe(34n);
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (agents.length > 0) await agents.pop()!.stop().catch(() => {});
});

async function startAgent(
  chain: MockChainAdapter,
  nodeRole: 'edge' | 'core' = 'edge',
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `OntologyClaims${nodeRole}`,
    listenHost: '127.0.0.1',
    nodeRole,
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
  });
  agents.push(agent);
  await agent.start();
  await agent.awaitInitialChainPoll();
  return agent;
}

/** What `DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT=1` left in the local store. */
async function syncOntologyClaims(agent: DKGAgent): Promise<void> {
  const graph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  await agent.store.insert(CLAIMS.flatMap(({ id, name, onChainId }) => {
    const subject = contextGraphDataGraphUri(id);
    return [
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
      { subject, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: JSON.stringify(name), graph },
      { subject, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId}"`, graph },
    ];
  }));
}

/**
 * The agent calls `POST /api/context-graph/subscribe` makes for a name hash,
 * in its order (packages/cli/src/daemon/routes/context-graph.ts). `identity`
 * is what `dkg subscribe` prints as its note.
 */
async function subscribeByNameHash(agent: DKGAgent, requested: string) {
  let contextGraphId = agent.resolveContextGraphIdAlias(requested) ?? requested;
  const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
    callerAgentAddress: agent.getDefaultAgentAddress(),
    allowSubscriptionFallback: false,
  });
  expect(authority.outcome).toBe('allowed');
  if (agent.contextGraphNameTargetFor(contextGraphId)) {
    const resolved = await agent.resolveContextGraphNameHashNow(contextGraphId, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (resolved) contextGraphId = resolved;
  }
  const identity = agent.describeContextGraphIdentity(requested);
  agent.subscribeToContextGraph(contextGraphId, {
    syncMode: 'always-on',
    ...(authority.onChainId === undefined ? {} : { onChainId: authority.onChainId.toString(10) }),
  });
  return { contextGraphId, identity };
}

/** Finalized RFC-64 authority evidence for on-chain #33, as the scheduled batch builds it. */
function finalizedEvidenceFor33() {
  return {
    kind: 'finalized-evidence' as const,
    evidence: {
      contextGraphAuthorityIndexId: '33',
      batchTargetIds: ['33'],
      snapshot: {
        chainId: 'mock:31337',
        governanceContract: `0x${'c6'.repeat(20)}`,
        contextGraphId: '33',
        owner: MOCK_DEFAULT_SIGNER,
        active: true,
        accessPolicy: 0,
        publishPolicy: 0,
        publishAuthority: null,
        publishAuthorityAccountId: '0',
        participantAgents: [],
        nameHash: NAME_HASH,
        ownershipEra: '0',
        policyVersion: '1',
        rosterVersion: '1',
        sourceBlockNumber: '1',
        sourceBlockHash: `0x${'ab'.repeat(32)}`,
      },
    },
  } as never;
}

async function rfc64IdentityOutcome(agent: DKGAgent, contextGraphId: string): Promise<string> {
  return agent.reconcileRfc64CatalogResponsibilityCoreV1(contextGraphId, new AbortController().signal, {
    authorityRequest: finalizedEvidenceFor33(),
  }).then(() => 'accepted', (error: unknown) => String(error));
}

function row(agent: DKGAgent, id: string) {
  return agent.getSubscribedContextGraphs().get(id);
}

/** Every claim this chain refutes stays unbound; the proven ones bind with their hash. */
function expectOnlyProvenBindings(agent: DKGAgent): void {
  for (const id of REFUTED) {
    expect(row(agent, id), id).toBeDefined();
    expect(row(agent, id)?.onChainId, id).toBeUndefined();
  }
  expect(row(agent, REAL_ID)).toMatchObject({ onChainId: '33', onChainHash: NAME_HASH });
  expect(row(agent, otherGraph(1))).toMatchObject({ onChainId: '1', onChainHash: keccak(otherGraph(1)) });
  // The real graph behind #5 binds to #5, whatever id its claim named.
  expect(row(agent, otherGraph(5))).toMatchObject({ onChainId: '5', onChainHash: keccak(otherGraph(5)) });
}

describe('ontology Context Graph claims on a node that synced the ontology graph', () => {
  it('binds only the claims this chain proves, in the live order (ontology, then enumeration)', async () => {
    expect(keccak(REAL_ID)).toBe(NAME_HASH);
    const agent = await startAgent(await baseShapedChain());
    await syncOntologyClaims(agent);

    await agent.discoverContextGraphsFromStore();
    await agent.discoverContextGraphsFromStorage();

    expectOnlyProvenBindings(agent);
    // Enumeration bound the cleartext it already knew: no second, hash-keyed row.
    expect(row(agent, NAME_HASH)).toBeUndefined();
    await expect(agent.getContextGraphOnChainId(REAL_ID)).resolves.toBe('33');
    for (const id of REFUTED) await expect(agent.getContextGraphOnChainId(id), id).resolves.toBeNull();
  });

  it('binds only the claims this chain proves when enumeration ran first', async () => {
    const agent = await startAgent(await baseShapedChain());
    await agent.discoverContextGraphsFromStorage();
    expect(row(agent, NAME_HASH)).toMatchObject({ onChainId: '33', onChainHash: NAME_HASH });

    await syncOntologyClaims(agent);
    await agent.discoverContextGraphsFromStore();

    expectOnlyProvenBindings(agent);
    // The verified definition adopted the hash-only row.
    expect(row(agent, NAME_HASH)).toBeUndefined();
  });

  it('subscribes the verified cleartext for `dkg subscribe <hash>`, with a note and a valid RFC-64 identity', async () => {
    const agent = await startAgent(await baseShapedChain());
    await syncOntologyClaims(agent);
    await agent.discoverContextGraphsFromStore();
    await agent.discoverContextGraphsFromStorage();

    const { contextGraphId, identity } = await subscribeByNameHash(agent, NAME_HASH);

    expect(identity).toEqual({
      state: 'resolved',
      nameHash: NAME_HASH,
      onChainId: '33',
      contextGraphId: REAL_ID,
      message: `Context Graph ${SHORT_HASH} resolves to "${REAL_ID}" (verified against the on-chain name hash); `
        + 'it syncs under that id.',
    });
    expect(contextGraphId).toBe(REAL_ID);
    expect(row(agent, NAME_HASH)).toBeUndefined();
    expect(row(agent, REAL_ID)).toMatchObject({ subscribed: true, onChainId: '33', onChainHash: NAME_HASH });
    expect(await rfc64IdentityOutcome(agent, REAL_ID)).not.toMatch(/invalid identity/);
  });

  it('lists one row per on-chain id, named only when this chain proves the name', async () => {
    const agent = await startAgent(await baseShapedChain());
    await syncOntologyClaims(agent);
    await agent.discoverContextGraphsFromStore();
    await agent.discoverContextGraphsFromStorage();

    const rows = await agent.listContextGraphs({ callerAgentAddress: null });
    const onChain = (id: string) => rows.filter((r) => r.onChainId === id);
    expect(onChain('33')).toEqual([expect.objectContaining({
      id: REAL_ID,
      name: REAL_NAME,
      nameKnown: true,
      onChain: expect.objectContaining({ id: '33', nameHash: NAME_HASH }),
    })]);
    expect(onChain('34')).toEqual([expect.objectContaining({ id: keccak(PRIVATE_34), nameKnown: false })]);
    expect(onChain('91')).toEqual([]);
    expect(onChain('7')).toEqual([expect.objectContaining({ id: keccak(otherGraph(7)) })]);
    for (const id of REFUTED) {
      const listed = rows.find((r) => r.id === id);
      expect(listed?.onChainId, id).toBeUndefined();
      expect(listed?.onChain, id).toBeUndefined();
    }
  });

  it('still resolves a hash-only graph through a peer when the node holds no ontology (control)', async () => {
    const agent = await startAgent(await baseShapedChain());
    await agent.discoverContextGraphsFromStorage();

    // A peer that knows the graph reveals its cleartext id.
    vi.spyOn(agent, 'contextGraphNameResolutionPeers').mockReturnValue(['12D3KooWHolderK92Xapyy']);
    vi.spyOn(agent, 'peerAdvertisesProtocol').mockResolvedValue(true);
    const asked = vi.spyOn(agent, 'askPeerForContextGraphName').mockResolvedValue(REAL_ID);

    const { contextGraphId, identity } = await subscribeByNameHash(agent, NAME_HASH);

    expect(asked).toHaveBeenCalled();
    expect(contextGraphId).toBe(REAL_ID);
    expect(identity).toMatchObject({ state: 'resolved', nameHash: NAME_HASH, contextGraphId: REAL_ID });
    expect(agent.getContextGraphNameResolutionStatus()).toContainEqual(expect.objectContaining({
      state: 'resolved',
      nameHash: NAME_HASH,
      contextGraphId: REAL_ID,
      source: 'peer-protocol',
    }));
    expect(row(agent, NAME_HASH)).toBeUndefined();
    expect(row(agent, REAL_ID)).toMatchObject({ subscribed: true, onChainId: '33', onChainHash: NAME_HASH });
    expect(await rfc64IdentityOutcome(agent, REAL_ID)).not.toMatch(/invalid identity/);
  });

  it('keeps refuted claims off a Core, and still nudges host mode for the curated graph they claimed', async () => {
    const agent = await startAgent(await baseShapedChain(), 'core');
    await syncOntologyClaims(agent);
    await agent.discoverContextGraphsFromStore();
    const nudge = vi.spyOn(agent, 'reconcileSwmHostModeSubscription').mockResolvedValue(undefined as never);

    await agent.discoverContextGraphsFromStorage();

    // A Core still auto-subscribes what it discovers (#1611 bridge), but a
    // refuted claim binds nothing, so neither RFC-64 nor hosting pairs these
    // rows with another graph's slot.
    expectOnlyProvenBindings(agent);
    expect(row(agent, 'baseball')).toMatchObject({ subscribed: true });
    for (const id of REFUTED) await expect(agent.getContextGraphOnChainId(id), id).resolves.toBeNull();
    // The claim on #34 no longer makes the curated slot look already known.
    expect(nudge).toHaveBeenCalledWith(keccak(PRIVATE_34), expect.anything());
  });
});
