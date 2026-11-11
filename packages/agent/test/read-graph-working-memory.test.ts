/**
 * Working-memory read graphs end to end, on embedded Oxigraph. With
 * `query.readGraphs` serving working and shared working memory, the node's
 * builder keeps one working-memory read graph per local agent: its own drafts,
 * and for the default agent also the drafts written under the node's peer ID.
 * A merged working-memory query is answered from the asking agent's read
 * graph, as the per-asset query is from the drafts. A promotion moves a draft
 * out of one read graph and into the shared-memory one, and the layer keeps
 * both. A restart under the same identity keeps them ready.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MemoryLayer, createOperationContext, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { forgetReadGraphBackendRuntimeForTesting, readGraphRuntimeOf, recordedWorkingMemoryIdentity, type ReadGraphModes } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { ReadGraphWorkloadOwnerV1 } from '../src/read-graph-runtime.js';
import { LocallySignedMockChain, silentLog } from './_helpers/external-signers.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const CG = 'working-memory-read-graphs';
const NOTE = 'urn:wm:note';
const MODES: ReadGraphModes = { layers: { [MemoryLayer.WorkingMemory]: 'serve', [MemoryLayer.SharedWorkingMemory]: 'serve' } };
const wm = (agentAddress: string) => readGraphIri({ scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: agentAddress.toLowerCase() });
const SWM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory });

const dirs: string[] = [];
let node: DKGAgent | undefined;
afterEach(async () => {
  await node?.stop().catch(() => undefined);
  node = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A node over embedded Oxigraph in `dataDir`, in the worker thread a node runs by default, serving working and shared
 * working memory from read graphs. The KA number allocator is the daemon's, which is durable: a restart shares it.
 */
async function startNode(dataDir: string, wallet: ethers.Wallet, kaNumberAllocator: ReturnType<typeof makeTestKaNumberAllocator>): Promise<DKGAgent> {
  const started = await DKGAgent.create({
    name: 'ReadGraphWorkingMemory', dataDir, listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge', kaNumberAllocator,
    chainAdapter: new LocallySignedMockChain(wallet) as never,
    storeConfig: { backend: 'oxigraph-worker', options: { path: join(dataDir, 'store.nq') }, readGraphs: { modes: MODES } },
  });
  await started.start();
  return started;
}

const stateOf = (agent: DKGAgent, readGraph: string) => readGraphRuntimeOf(agent.store)?.mirror.get(readGraph)?.state;

/** Run the node's read-graph builder, as the agent runs it but on a short interval, until `readGraphs` are ready. */
async function build(agent: DKGAgent, readGraphs: readonly string[]): Promise<void> {
  const owner = new ReadGraphWorkloadOwnerV1(agent, { logger: silentLog(), intervalMs: 20 });
  owner.start(createOperationContext('system'));
  try {
    await vi.waitFor(() => expect(readGraphs.map((readGraph) => stateOf(agent, readGraph))).toEqual(readGraphs.map(() => 'ready')),
      { timeout: 30_000, interval: 50 });
  } finally {
    await owner.close();
  }
}

async function notes(agent: DKGAgent, agentAddress: string, semantics: 'merged' | 'per-asset'): Promise<string[]> {
  const result = await agent.query(`SELECT ?o WHERE { ?s <${NOTE}> ?o }`, { contextGraphId: CG, view: 'working-memory', agentAddress, semantics });
  return result.bindings.map((row) => row.o!).sort();
}

describe('working-memory read graphs on embedded Oxigraph', () => {
  it('keep each agent\'s drafts, follow a promotion into shared memory, and survive a restart under the same identity', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-read-graph-wm-'));
    dirs.push(dataDir);
    const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    const allocator = makeTestKaNumberAllocator();
    node = await startNode(dataDir, wallet, allocator);
    const a = node.getDefaultAgentAddress()!;
    const b = (await node.registerAgent('second-agent')).agentAddress;
    await node.createContextGraph({ id: CG, name: CG, description: 'working-memory read graphs' });

    await node.assertion.create(CG, 'a-notes');
    await node.assertion.write(CG, 'a-notes', [{ subject: 'urn:wm:a', predicate: NOTE, object: '"a"' }]);
    await node.assertion.create(CG, 'b-notes', { agentAddress: b });
    await node.assertion.write(CG, 'b-notes', [{ subject: 'urn:wm:b', predicate: NOTE, object: '"b"' }], { agentAddress: b });
    // A draft written under the node's peer ID, as a node writes before it has a default agent: it is the default agent's.
    await node.store.insert([{
      subject: 'urn:wm:peer', predicate: NOTE, object: '"peer"', graph: `did:dkg:context-graph:${CG}/_working_memory/${node.peerId}/1`,
    }]);

    await build(node, [wm(a), wm(b), SWM]);
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ defaultAgentAddress: a, peerId: node.peerId });
    for (const semantics of ['merged', 'per-asset'] as const) {
      expect(await notes(node, a, semantics), semantics).toEqual(['"a"', '"peer"']);
      expect(await notes(node, b, semantics), semantics).toEqual(['"b"']);
    }

    // The promotion writes both read graphs' members; the layer maintains both, so neither goes out of service.
    await node.assertion.promote(CG, 'a-notes');
    expect([stateOf(node, wm(a)), stateOf(node, SWM)]).toEqual(['ready', 'ready']);
    expect(await notes(node, a, 'merged')).toEqual(['"peer"']);
    const shared = await node.query(`SELECT ?o WHERE { ?s <${NOTE}> ?o }`, { contextGraphId: CG, view: 'shared-working-memory', semantics: 'merged' });
    expect(shared.bindings.map((row) => row.o)).toEqual(['"a"']);

    // Restarted under the same identity, as a new process with nothing of the old one's read-graph runtime, the read graphs
    // load from the store and the data directory, stay ready and answer at once.
    const before = readGraphRuntimeOf(node.store)!;
    await node.stop();
    forgetReadGraphBackendRuntimeForTesting(before.backend!);
    node = await startNode(dataDir, wallet, allocator);
    expect(readGraphRuntimeOf(node.store)).not.toBe(before);
    expect([stateOf(node, wm(a)), stateOf(node, wm(b)), stateOf(node, SWM)]).toEqual(['ready', 'ready', 'ready']);
    expect(await notes(node, a, 'merged')).toEqual(['"peer"']);
    expect(await notes(node, b, 'merged')).toEqual(['"b"']);
  }, 120_000);
});
