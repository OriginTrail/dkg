// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { contextGraphAssertionUri, contextGraphMetaUri, parseAssertionSealQuads, TypedEventBus,
  generateEd25519Keypair } from '../../../core/dist/index.js';
import { DKGPublisher } from '../../../publisher/dist/index.js';
import { MockChainAdapter } from '../../../chain/dist/index.js';
import { DKGAgent } from '../../dist/dkg-agent.js';
import { KaNumberAllocator } from '../../dist/allocator.js';
import { OxigraphWorkerStore } from '../../../storage/dist/index.js';
import { NamedKaVmLifecycleRepair } from '../../dist/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleExecutionCapabilities } from '../../dist/named-ka-vm-lifecycle-executor.js';
import { confirmedNamedKaVmLifecycleInput } from '../../dist/named-ka-vm-lifecycle-evidence.js';
const newerDraft = process.argv[2] === 'newer-draft';
const path = process.env.DKG_TEST_SNAPSHOT_PATH, dataDir = process.env.DKG_TEST_REPAIR_DIR, flag = process.env.DKG_TEST_SNAPSHOT_FAULT;
const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`), author = wallet.address;
const contextGraphId = 'worker-named-recovery', name = 'named-asset';
const publicQuads = [{ subject: 'urn:payload', predicate: 'urn:value', object: '"original public payload"', graph: '' }];
const draftQuads = [{ subject: 'urn:newer-draft', predicate: 'urn:value', object: '"preserve newer draft"', graph: '' }];
const chain = new MockChainAdapter();
let next = 1n, now = 1000, input, reopened, second, first, agent;
const allocator = new KaNumberAllocator({ allocate: () => next++, peekNext: () => next,
  reconcileFloor: (_author, floor) => { if (floor > next) next = floor; } });
const store = new OxigraphWorkerStore(path);
const owner = () => new NamedKaVmLifecycleRepair({ dataDir, now: () => now, warn: () => {},
  ...confirmedLifecycleExecutionCapabilities({ store, chain, writeLocks: agent.writeLocks, dataDir, readTimeoutMs: 1000 }) });
const entries = async () => JSON.parse(await readFile(join(dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries;
try {
  agent = await DKGAgent.create({ name: 'worker-recovery', store, chainAdapter: chain,
    kaNumberAllocator: allocator, rfc64CatalogActivation: { enabled: false } });
  Object.defineProperty(agent, 'peerId', { value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6' });
  agent.getContextGraphOnChainId = async () => '1';
  await store.insert([{ subject: 'urn:unrelated', predicate: 'urn:value', object: '"keep"', graph: 'urn:unrelated' }]);
  await store.commitment.capture()();
  if (!newerDraft) await writeFile(flag, 'block graph-store snapshots only');
  // Real named APIs allocate the identity, write the draft, and produce its signed seal.
  await agent.assertion.create(contextGraphId, name, { agentAddress: author });
  await agent.assertion.write(contextGraphId, name, publicQuads, { agentAddress: author });
  await agent.assertion.finalize(contextGraphId, name, { agentAddress: author, authorAgentAddress: author,
    authorSignTypedData: async data => {
      const signature = ethers.Signature.from(await wallet.signTypedData(data.domain, data.types, data.message));
      return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
    } });
  const assertion = contextGraphAssertionUri(contextGraphId, author, name), meta = contextGraphMetaUri(contextGraphId);
  const sealRows = await store.query(`CONSTRUCT { <${assertion}> ?p ?o } WHERE { GRAPH <${meta}> { <${assertion}> ?p ?o } }`);
  const seal = parseAssertionSealQuads(sealRows.quads, assertion); assert.ok(seal);
  const publication = { status: 'confirmed', seal, ual: seal.kaUal, merkleRoot: seal.merkleRoot,
    onChainResult: { txHash: '0x' + '34'.repeat(32), blockNumber: 12, txIndex: 3,
      blockTimestamp: 1767225600, publisherAddress: author } };
  input = confirmedNamedKaVmLifecycleInput(publication, { contextGraphId, name, agentAddress: author,
    packedKaId: seal.reservedKaId }, { publicQuads, publisherPeerId: agent.peerId,
    accessPolicy: 'allowList', allowedPeers: ['test-reader'] });
  chain.readKnowledgeAssetVersionSnapshot = async () => ({ rootCount: BigInt(input.assertionVersion), latestRoot: input.merkleRoot });
  // Any attempted second publication is a test failure; retries use only the original confirmation.
  chain.publishKnowledgeAssets = async () => { throw new Error('unexpected publication during recovery'); };
  if (newerDraft) {
    await agent.assertion.discard(contextGraphId, name, { agentAddress: author });
    await agent.assertion.create(contextGraphId, name, { agentAddress: author });
    await agent.assertion.write(contextGraphId, name, draftQuads, { agentAddress: author });
    await store.commitment.capture()();
    await writeFile(flag, 'block recovery writes after the newer draft was durable');
  }
  const graph = input.materialization.metadataQuads.find(q => q.predicate === 'http://dkg.io/ontology/assertionGraph').object;
  await store.insert([...input.materialization.metadataQuads, ...publicQuads.map(q => ({ ...q, graph }))]);
  first = owner();
  assert.equal(await first.submit(input), 'pending'); assert.equal((await entries()).length, 1);
  await store.worker.terminate(); await unlink(flag); await first.stop();
  assert.equal(await store.countQuads(graph), 0, 'real replacement worker lost acknowledged payload');
  second = owner(); now = 6000; await second.runDue();
  assert.equal((await entries()).length, 0);
  // Reopen BEFORE any close can flush the original owner's memory.
  reopened = new OxigraphWorkerStore(path);
  assert.equal(await reopened.countQuads(graph), 1);
  const result = await reopened.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  assert.deepEqual(result.quads, publicQuads);
  assert.equal(await reopened.countQuads('urn:unrelated'), 1);
  assert.equal((await reopened.query(`ASK { GRAPH <${meta}> { <${input.publishedUal}> <http://dkg.io/ontology/transactionHash> "${publication.onChainResult.txHash}" } }`)).value, true);
  const recovered = Object.create(DKGAgent.prototype);
  recovered.store = reopened; recovered.chain = chain; recovered.defaultAgentAddress = author;
  recovered.writeLocks = new Map(); recovered.log = { debug() {}, info() {}, warn() {}, error() {} };
  Object.defineProperty(recovered, 'peerId', { value: agent.peerId });
  recovered.publisher = new DKGPublisher({ store: reopened, chain, eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(), writeLocks: recovered.writeLocks });
  if (newerDraft) {
    const draft = await recovered.publisher.assertionQuery(contextGraphId, name, author);
    assert.ok(draft.some(q => q.subject === 'urn:newer-draft' && q.object === draftQuads[0].object));
    assert.ok(!draft.some(q => q.subject === 'urn:payload'));
    assert.equal((await recovered.assertion.history(contextGraphId, name)).state, 'created');
  }
  await recovered.assertion.create(contextGraphId, name);
  await recovered.assertion.pullFrom(contextGraphId, name, 'vm', { onConflict: 'replace' });
  await recovered.assertion.write(contextGraphId, name, [{ subject: 'urn:edited', predicate: 'urn:value', object: '"edited after crash"', graph: '' }]);
  const edited = await recovered.publisher.assertionQuery(contextGraphId, name, author);
  assert.ok(edited.some(q => q.subject === 'urn:edited'));
  assert.equal(await reopened.countQuads(graph), 1, 'editing leaves confirmed VM content intact');
  console.log(JSON.stringify({ recoveredOriginalPayload: true, durableBeforeClose: true,
    unrelatedPreserved: true, namedReopenedAndEdited: true, newerDraftPreserved: newerDraft }));
} catch (error) { console.error(error); throw error; } finally {
  await unlink(flag).catch(() => {}); await first?.stop(); await second?.stop();
  await reopened?.close(); await agent?.stop(); await store.close();
}
