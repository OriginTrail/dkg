import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSERTION_SEAL_PREDICATES,
  MemoryLayer,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { assertionScopedGraphUri } from '@origintrail-official/dkg-publisher';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const agents: DKGAgent[] = [];

afterEach(async () => {
  for (const agent of agents) {
    try {
      await agent.stop();
    } catch {
      // best-effort test cleanup
    }
  }
  agents.length = 0;
});

async function createAgent(): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'RootlessFinalizeRecovery',
    listenPort: 0,
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    kaNumberAllocator: makeTestKaNumberAllocator(),
    nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

async function hasSeal(agent: DKGAgent, contextGraphId: string, name: string): Promise<boolean> {
  const author = agent.defaultAgentAddress ?? agent.peerId;
  const assertion = contextGraphAssertionUri(contextGraphId, author, name);
  const meta = contextGraphMetaUri(contextGraphId);
  const result = await agent.store.query(
    `ASK { GRAPH <${meta}> { <${assertion}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root } }`,
  );
  return result.type === 'boolean' && result.value;
}

async function assertCanonicalFinalizedGraph(
  agent: DKGAgent,
  contextGraphId: string,
  result: { kaUal: string; assertionVersion: string; publicTripleCount: number },
): Promise<void> {
  const target = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.WorkingMemory,
    createGraphKnowledgeAssetScope(result.kaUal, result.assertionVersion),
  );
  expect(await agent.store.countQuads(target)).toBe(result.publicTripleCount);
  const rows = await agent.store.query(
    `SELECT ?s ?o WHERE { GRAPH <${target}> { ?s ?p ?o } }`,
  );
  expect(rows.type).toBe('bindings');
  if (rows.type !== 'bindings') throw new Error('expected bindings');
  expect(rows.bindings.some((row) => row['s']?.startsWith('_:'))).toBe(false);
  expect(rows.bindings.some((row) => row['o']?.startsWith('_:'))).toBe(false);
}

describe('graph-scoped assertion finalization recovery', () => {
  it('converges after failures before swap, after swap, after seal, and during source cleanup', async () => {
    const agent = await createAgent();
    const contextGraphId = `rootless-finalize-recovery-${Date.now()}`;
    await agent.createContextGraph({ id: contextGraphId, name: 'Rootless finalize recovery' });
    const author = agent.defaultAgentAddress ?? agent.peerId;

    // Failure before the atomic target swap: the writable draft remains intact.
    const beforeSwap = 'before-swap';
    await agent.assertion.create(contextGraphId, beforeSwap);
    await agent.assertion.write(contextGraphId, beforeSwap, [
      { subject: 'urn:before:swap', predicate: 'urn:predicate:value', object: '"draft"' },
    ]);
    const realReplace = agent.store.replaceGraph?.bind(agent.store);
    agent.store.replaceGraph = async () => {
      throw new Error('injected before-swap failure');
    };
    await expect(agent.assertion.finalize(contextGraphId, beforeSwap)).rejects.toThrow(
      'injected before-swap failure',
    );
    expect(await agent.assertion.query(contextGraphId, beforeSwap)).toHaveLength(1);
    expect(await hasSeal(agent, contextGraphId, beforeSwap)).toBe(false);
    agent.store.replaceGraph = realReplace;
    const beforeSwapRecovered = await agent.assertion.finalize(contextGraphId, beforeSwap) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    await assertCanonicalFinalizedGraph(agent, contextGraphId, beforeSwapRecovered);

    // Failure immediately after the swap, when the seal insert begins. The
    // canonical graph is durable, no seal is exposed, and retry seals it.
    const afterSwap = 'after-swap';
    await agent.assertion.create(contextGraphId, afterSwap);
    await agent.assertion.write(contextGraphId, afterSwap, [
      { subject: 'urn:after:swap', predicate: 'urn:predicate:child', object: '_:child' },
      { subject: '_:child', predicate: 'urn:predicate:value', object: '"canonical"' },
    ]);
    const afterSwapWm = await agent.publisher.wmGraphUri(contextGraphId, author, afterSwap);
    const realInsert = agent.store.insert.bind(agent.store);
    let stoppedBeforeSeal = false;
    agent.store.insert = async (quads, options) => {
      if (
        !stoppedBeforeSeal &&
        quads.some((quad) => quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT)
      ) {
        stoppedBeforeSeal = true;
        throw new Error('injected after-swap failure');
      }
      return realInsert(quads, options);
    };
    await expect(agent.assertion.finalize(contextGraphId, afterSwap)).rejects.toThrow(
      'injected after-swap failure',
    );
    expect(await hasSeal(agent, contextGraphId, afterSwap)).toBe(false);
    const swappedRows = await agent.store.query(
      `SELECT ?s ?o WHERE { GRAPH <${afterSwapWm}> { ?s ?p ?o } }`,
    );
    expect(swappedRows.type).toBe('bindings');
    if (swappedRows.type !== 'bindings') throw new Error('expected bindings');
    expect(swappedRows.bindings.some((row) => row['s']?.startsWith('_:'))).toBe(false);
    expect(swappedRows.bindings.some((row) => row['o']?.startsWith('_:'))).toBe(false);
    agent.store.insert = realInsert;
    const afterSwapRecovered = await agent.assertion.finalize(contextGraphId, afterSwap) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    await assertCanonicalFinalizedGraph(agent, contextGraphId, afterSwapRecovered);

    // Failure after the seal, while lifecycle version repair starts. The seal
    // makes the next finalize enter its idempotent repair branch.
    const afterSeal = 'after-seal';
    await agent.assertion.create(contextGraphId, afterSeal);
    await agent.assertion.write(contextGraphId, afterSeal, [
      { subject: 'urn:after:seal', predicate: 'urn:predicate:value', object: '"sealed"' },
    ]);
    const lifecycle = assertionLifecycleUri(contextGraphId, author, afterSeal);
    const realDeleteByPattern = agent.store.deleteByPattern.bind(agent.store);
    let stoppedAfterSeal = false;
    agent.store.deleteByPattern = async (pattern, options) => {
      if (
        !stoppedAfterSeal &&
        pattern.subject === lifecycle &&
        pattern.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION
      ) {
        stoppedAfterSeal = true;
        throw new Error('injected after-seal failure');
      }
      return realDeleteByPattern(pattern, options);
    };
    await expect(agent.assertion.finalize(contextGraphId, afterSeal)).rejects.toThrow(
      'injected after-seal failure',
    );
    expect(await hasSeal(agent, contextGraphId, afterSeal)).toBe(true);
    agent.store.deleteByPattern = realDeleteByPattern;
    const afterSealRecovered = await agent.assertion.finalize(contextGraphId, afterSeal) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    await assertCanonicalFinalizedGraph(agent, contextGraphId, afterSealRecovered);
    const lifecycleVersion = await agent.store.query(
      `SELECT ?v WHERE { GRAPH <${contextGraphMetaUri(contextGraphId)}> {
        <${lifecycle}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION}> ?v
      } }`,
    );
    expect(lifecycleVersion.type).toBe('bindings');
    if (lifecycleVersion.type !== 'bindings') throw new Error('expected bindings');
    expect(lifecycleVersion.bindings).toHaveLength(1);

    // Failure during cleanup: canonical content and seal survive; retry removes
    // an encoded descendant containing only filtered WM bookkeeping. New KAs
    // reject user RDF named graphs, but recovery must still clean protocol-only
    // graph artifacts without duplicating the default-graph payload.
    const duringCleanup = 'during-cleanup';
    await agent.assertion.create(contextGraphId, duringCleanup);
    await agent.assertion.write(contextGraphId, duringCleanup, [
      {
        subject: 'urn:during:cleanup',
        predicate: 'urn:predicate:value',
        object: '"cleanup"',
      },
    ]);
    const cleanupWm = await agent.publisher.wmGraphUri(contextGraphId, author, duringCleanup);
    const bookkeepingDraftDescendant = assertionScopedGraphUri(cleanupWm, 'urn:obsolete:bookkeeping-draft-graph');
    await agent.store.insert([{
      subject: 'urn:dkg:file:stale-cleanup-marker',
      predicate: 'urn:predicate:value',
      object: '"filtered"',
      graph: bookkeepingDraftDescendant,
    }]);
    expect(await agent.store.hasGraph(bookkeepingDraftDescendant)).toBe(true);
    const realDropGraph = agent.store.dropGraph.bind(agent.store);
    let stoppedDuringCleanup = false;
    agent.store.dropGraph = async (graphUri, options) => {
      if (!stoppedDuringCleanup && graphUri === bookkeepingDraftDescendant) {
        stoppedDuringCleanup = true;
        throw new Error('injected cleanup failure');
      }
      return realDropGraph(graphUri, options);
    };
    await expect(agent.assertion.finalize(contextGraphId, duringCleanup)).rejects.toThrow(
      'injected cleanup failure',
    );
    expect(await hasSeal(agent, contextGraphId, duringCleanup)).toBe(true);
    expect(await agent.store.hasGraph(bookkeepingDraftDescendant)).toBe(true);
    agent.store.dropGraph = realDropGraph;
    const cleanupRecovered = await agent.assertion.finalize(contextGraphId, duringCleanup) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    await assertCanonicalFinalizedGraph(agent, contextGraphId, cleanupRecovered);
    expect(await agent.store.hasGraph(bookkeepingDraftDescendant)).toBe(false);

    // WM->SWM uses the same atomic exact-graph primitive. A failed swap leaves
    // both canonical WM and the prior complete SWM graph untouched; retry then
    // replaces SWM exactly and removes WM only after the swap succeeds.
    const promoteRetry = 'promote-retry';
    await agent.assertion.create(contextGraphId, promoteRetry);
    await agent.assertion.write(contextGraphId, promoteRetry, [
      { subject: 'urn:promote:new:1', predicate: 'urn:predicate:value', object: '"one"' },
      { subject: 'urn:promote:new:2', predicate: 'urn:predicate:value', object: '"two"' },
    ]);
    const promoteSeal = await agent.assertion.finalize(
      contextGraphId,
      promoteRetry,
    ) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    const promoteScope = createGraphKnowledgeAssetScope(
      promoteSeal.kaUal,
      promoteSeal.assertionVersion,
    );
    const swmTarget = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      promoteScope,
    );
    await agent.store.insert([{
      subject: 'urn:promote:prior',
      predicate: 'urn:predicate:value',
      object: '"prior"',
      graph: swmTarget,
    }]);
    const replaceBeforePromote = agent.store.replaceGraph?.bind(agent.store);
    agent.store.replaceGraph = async (graphUri, quads, options) => {
      if (graphUri === swmTarget) throw new Error('injected SWM swap failure');
      if (!replaceBeforePromote) throw new Error('replaceGraph unavailable');
      return replaceBeforePromote(graphUri, quads, options);
    };
    await expect(agent.assertion.promote(contextGraphId, promoteRetry)).rejects.toThrow(
      'injected SWM swap failure',
    );
    expect(await agent.assertion.query(contextGraphId, promoteRetry)).toHaveLength(2);
    const priorSwm = await agent.store.query(
      `SELECT ?s WHERE { GRAPH <${swmTarget}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(priorSwm.type).toBe('bindings');
    if (priorSwm.type !== 'bindings') throw new Error('expected bindings');
    expect(priorSwm.bindings).toEqual([{ s: 'urn:promote:prior' }]);

    agent.store.replaceGraph = replaceBeforePromote;
    const promoted = await agent.assertion.promote(contextGraphId, promoteRetry);
    expect(promoted.promotedCount).toBe(2);
    expect(await agent.assertion.query(contextGraphId, promoteRetry)).toHaveLength(0);
    const currentSwm = await agent.store.query(
      `SELECT ?s WHERE { GRAPH <${swmTarget}> { ?s <urn:predicate:value> ?o } } ORDER BY ?s`,
    );
    expect(currentSwm.type).toBe('bindings');
    if (currentSwm.type !== 'bindings') throw new Error('expected bindings');
    expect(currentSwm.bindings).toEqual([
      { s: 'urn:promote:new:1' },
      { s: 'urn:promote:new:2' },
    ]);

    const leakedInternalGraphs = (await agent.store.listGraphs()).filter((graph) =>
      graph.startsWith('urn:dkg:internal:atomic-graph-replace:'),
    );
    expect(leakedInternalGraphs).toEqual([]);
  }, 60_000);

  it('publishes only the exact sealed SWM graph and fails before chain work on tampering', async () => {
    const agent = await createAgent();
    const contextGraphId = `rootless-vm-boundary-${Date.now()}`;
    await agent.createContextGraph({ id: contextGraphId, name: 'Rootless VM boundary' });
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const name = 'exact-vm-boundary';
    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, [
      { subject: 'urn:vm:one', predicate: 'urn:predicate:child', object: '_:child' },
      { subject: '_:child', predicate: 'urn:predicate:value', object: '"canonical"' },
      { subject: 'urn:vm:two', predicate: 'urn:predicate:value', object: '"ordinary"' },
    ]);
    const finalized = await agent.assertion.finalize(contextGraphId, name) as never as {
      kaUal: string;
      assertionVersion: string;
      publicTripleCount: number;
      merkleRoot: Uint8Array;
    };
    await agent.assertion.promote(contextGraphId, name);
    const scope = createGraphKnowledgeAssetScope(
      finalized.kaUal,
      finalized.assertionVersion,
    );
    const swmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );

    // A sibling KA graph must never widen the named publish boundary.
    const siblingScope = createGraphKnowledgeAssetScope(
      `did:dkg:${scope.chainId}/${scope.agentAddress}/${BigInt(scope.kaNumber) + 1n}`,
      1,
    );
    await agent.store.insert([{
      subject: 'urn:sibling:must-not-publish',
      predicate: 'urn:predicate:value',
      object: '"sibling"',
      graph: knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.SharedWorkingMemory,
        siblingScope,
      ),
    }]);

    const tamperQuad = {
      subject: 'urn:tamper:extra',
      predicate: 'urn:predicate:value',
      object: '"tampered"',
      graph: swmGraph,
    };
    await agent.store.insert([tamperQuad]);
    await expect(
      agent.publishFromFinalizedAssertion(contextGraphId, name),
    ).rejects.toThrow(/SWM triple count mismatch/);
    await agent.store.delete([tamperQuad]);

    let captured: {
      selection: unknown;
      options: Record<string, unknown>;
    } | undefined;
    const packedKaId =
      (BigInt(scope.agentAddress) << 96n)
      | BigInt(scope.kaNumber);
    const originalPublishFromSharedMemory = agent.publishFromSharedMemory.bind(agent);
    (agent as unknown as {
      publishFromSharedMemory: (...args: unknown[]) => Promise<unknown>;
    }).publishFromSharedMemory = async (...args: unknown[]) => {
      const [, selection, options] = args;
      captured = { selection, options: options as Record<string, unknown> };
      return {
        kaId: packedKaId,
        ual: scope.ual,
        merkleRoot: finalized.merkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: [],
      };
    };
    try {
      const result = await agent.publishFromFinalizedAssertion(contextGraphId, name);
      expect(result.ual).toBe(scope.ual);
      expect(captured?.selection).toBe('all');
      expect(captured?.options).toMatchObject({
        contentScopeVersion: 2,
        kaUal: scope.ual,
        assertionVersion: scope.assertionVersion,
        publicTripleCount: finalized.publicTripleCount,
        reservedKaId: packedKaId,
        sharedMemoryScope: {
          kind: 'named-lifecycle',
          identity: {
            agentAddress: scope.agentAddress,
            kaNumber: BigInt(scope.kaNumber),
          },
        },
      });
    } finally {
      (agent as unknown as {
        publishFromSharedMemory: typeof originalPublishFromSharedMemory;
      }).publishFromSharedMemory = originalPublishFromSharedMemory;
    }
  }, 60_000);

  it('rejects public and private RDF named graphs before their identity can be flattened', async () => {
    const agent = await createAgent();
    const contextGraphId = `rootless-named-graph-rejection-${Date.now()}`;
    await agent.createContextGraph({ id: contextGraphId, name: 'Rootless named-graph rejection' });
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const name = 'named-graph-payload';
    const publicNamedGraph = 'urn:input:public-named-graph';
    const privateNamedGraph = 'urn:input:private-named-graph';

    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, [
      {
        subject: 'urn:named:public',
        predicate: 'urn:predicate:value',
        object: '"public"',
        graph: publicNamedGraph,
      },
    ]);
    await expect(agent.publisher.assertionWritePrivate(contextGraphId, name, author, [
      {
        subject: 'urn:named:private',
        predicate: 'urn:predicate:value',
        object: '"private"',
        graph: privateNamedGraph,
      },
    ])).rejects.toMatchObject({
      code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
      namedGraphs: [privateNamedGraph],
    });

    await expect(agent.assertion.finalize(contextGraphId, name)).rejects.toMatchObject({
      code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
      namedGraphs: [publicNamedGraph],
    });
    expect(await hasSeal(agent, contextGraphId, name)).toBe(false);
    expect(await agent.assertion.query(contextGraphId, name)).toEqual([
      expect.objectContaining({ graph: publicNamedGraph }),
    ]);
    expect(await agent.assertion.queryPrivate(contextGraphId, name)).toEqual([]);
  }, 60_000);

  it('recovers a promotion that fails between the SWM swap and its durable writes', async () => {
    const agent = await createAgent();
    const contextGraphId = `rootless-promote-recovery-${Date.now()}`;
    await agent.createContextGraph({ id: contextGraphId, name: 'Rootless promote recovery' });
    const name = 'promote-crash';
    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, [
      { subject: 'urn:promote:crash', predicate: 'urn:predicate:value', object: '"promoted"' },
    ]);
    const finalized = await agent.assertion.finalize(contextGraphId, name) as never as {
      kaUal: string; assertionVersion: string; publicTripleCount: number;
    };
    const scope = createGraphKnowledgeAssetScope(finalized.kaUal, finalized.assertionVersion);
    const wmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.WorkingMemory, scope);
    const swmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope);
    expect(await agent.store.countQuads(wmGraph)).toBe(1);

    // Crash inside the post-swap tail: the memory-layer meta rewrite is the
    // first durable write after the SWM replacement.
    const realInsert = agent.store.insert.bind(agent.store);
    let crashed = false;
    agent.store.insert = async (quads, options) => {
      if (
        !crashed
        && quads.some((quad) =>
          quad.predicate === 'http://dkg.io/ontology/memoryLayer' && quad.object === '"SWM"')
      ) {
        crashed = true;
        throw new Error('injected post-swap promote failure');
      }
      return realInsert(quads, options);
    };
    try {
      await expect(agent.assertion.promote(contextGraphId, name)).rejects.toThrow(
        'injected post-swap promote failure',
      );
    } finally {
      agent.store.insert = realInsert;
    }

    // The WM source must survive the failed tail: dropping it before the
    // durable writes strands the promotion — a retry then reads empty working
    // memory and aborts instead of converging.
    expect(await agent.store.countQuads(wmGraph)).toBe(1);

    const retried = await agent.assertion.promote(contextGraphId, name);
    expect(retried).toMatchObject({ promotedCount: 1 });
    expect(await agent.store.countQuads(swmGraph)).toBe(1);
    expect(await agent.store.countQuads(wmGraph)).toBe(0);
  }, 60_000);

  it('commits, promotes, and republishes a fully private KA without a synthetic public root', async () => {
    const agent = await createAgent();
    const contextGraphId = `rootless-private-only-${Date.now()}`;
    await agent.createContextGraph({ id: contextGraphId, name: 'Rootless private-only lifecycle' });
    const name = 'private-only';
    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, {
      private: {
        '@context': { secret: 'urn:predicate:secret' },
        '@id': 'urn:private:subject',
        secret: 'hidden',
      },
    });

    expect(await agent.assertion.query(contextGraphId, name)).toEqual([]);
    expect(await agent.assertion.queryPrivate(contextGraphId, name)).toHaveLength(1);
    const finalized = await agent.assertion.finalize(contextGraphId, name) as never as {
      kaUal: string;
      assertionVersion: string;
      publicTripleCount: number;
      privateMerkleRoot: Uint8Array;
      privateTripleCount: number;
      merkleRoot: Uint8Array;
    };
    expect(finalized.publicTripleCount).toBe(0);
    expect(finalized.privateTripleCount).toBe(1);
    expect(finalized.privateMerkleRoot).toHaveLength(32);
    expect(await agent.assertion.queryPrivate(contextGraphId, name)).toEqual([]);

    const scope = createGraphKnowledgeAssetScope(finalized.kaUal, finalized.assertionVersion);
    const privateStore = new PrivateContentStore(agent.store, new GraphManager(agent.store));
    expect(await privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, scope)).toHaveLength(1);

    const promoted = await agent.assertion.promote(contextGraphId, name);
    expect(promoted).toMatchObject({ promotedCount: 1, sealed: true, publishReady: true });
    expect(await agent.store.countQuads(knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
    ))).toBe(0);

    let capturedOptions: Record<string, unknown> | undefined;
    const originalPublishFromSharedMemory = agent.publishFromSharedMemory.bind(agent);
    (agent as unknown as {
      publishFromSharedMemory: (...args: unknown[]) => Promise<unknown>;
    }).publishFromSharedMemory = async (...args: unknown[]) => {
      capturedOptions = args[2] as Record<string, unknown>;
      return {
        kaId: (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber),
        ual: scope.ual,
        merkleRoot: finalized.merkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: [],
      };
    };
    try {
      await agent.publishFromFinalizedAssertion(contextGraphId, name);
      expect(capturedOptions).toMatchObject({
        contentScopeVersion: 2,
        kaUal: scope.ual,
        assertionVersion: scope.assertionVersion,
        publicTripleCount: 0,
        privateTripleCount: 1,
      });
      expect(capturedOptions?.privateMerkleRoot).toEqual(finalized.privateMerkleRoot);
    } finally {
      (agent as unknown as {
        publishFromSharedMemory: typeof originalPublishFromSharedMemory;
      }).publishFromSharedMemory = originalPublishFromSharedMemory;
    }
  }, 60_000);
});
