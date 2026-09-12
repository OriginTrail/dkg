import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { swmKaWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { CG, META, WS, stopTrackedSwmExpiryAgents, trackSwmExpiryAgent, type SwmExpiryTestInternals } from './_helpers/swm-expiry-cleanup.js';

afterEach(async () => {
  await stopTrackedSwmExpiryAgents();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([undefined, 'research'])('waits for a real entity share to commit fresh metadata in subgraph %s', async subGraphName => {
  const ws = `did:dkg:context-graph:${CG}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory`;
  const meta = `${ws}_meta`;
  const agent = trackSwmExpiryAgent(await DKGAgent.create({
    name: 'expiry-real-entity-share', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000,
  }));
  const { store, publisher } = agent as unknown as SwmExpiryTestInternals;
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  const cgUri = `did:dkg:context-graph:${CG}`;
  await store.insert([{ subject: cgUri, predicate: rdfType, object: `${dkg}ContextGraph`, graph: `${cgUri}/_meta` }]);
  if (subGraphName) {
    await store.insert([
      { subject: `${cgUri}/${subGraphName}`, predicate: rdfType, object: `${dkg}SubGraph`, graph: `${cgUri}/_meta` },
      { subject: `${cgUri}/${subGraphName}`, predicate: 'http://schema.org/name', object: `"${subGraphName}"`, graph: `${cgUri}/_meta` },
      { subject: `${cgUri}/${subGraphName}`, predicate: `${dkg}createdBy`, object: 'urn:expiry:publisher', graph: `${cgUri}/_meta` },
    ]);
  }
  const root = 'urn:expiry:real-entity';
  const share = (value: string) => publisher.share(CG, [
    { subject: root, predicate: 'urn:value', object: `"${value}"`, graph: '' },
  ], { publisherPeerId: 'expiry-publisher', subGraphName, localOnly: true });
  const old = await share('old');
  const query = store.query.bind(store);
  const oldMetadata = await query(`SELECT ?op WHERE { GRAPH <${meta}> {
    ?op a <${dkg}WorkspaceOperation> ; <${dkg}shareOperationId> "${old.shareOperationId}" .
  } }`);
  expect(oldMetadata).toMatchObject({ type: 'bindings', bindings: [{ op: expect.any(String) }] });
  if (oldMetadata.type !== 'bindings') throw new Error('Expected operation metadata');
  const oldOp = oldMetadata.bindings[0]!.op;
  await store.deleteByPattern({ graph: meta, subject: oldOp, predicate: `${dkg}publishedAt` });
  await store.insert([{ subject: oldOp, predicate: `${dkg}publishedAt`, graph: meta,
    object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }]);

  let selected!: () => void, releaseSelection!: () => void;
  const atSelection = new Promise<void>(resolve => { selected = resolve; });
  const selectionGate = new Promise<void>(resolve => { releaseSelection = resolve; });
  let inserted!: () => void, releaseWriter!: () => void;
  const atFreshInsert = new Promise<void>(resolve => { inserted = resolve; });
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
  let heldSelection = false;
  const reads = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (!heldSelection && options?.source === 'agent.swmCleanup.expiredOperations'
      && result.type === 'bindings' && result.bindings.some(row => row.op === oldOp)) {
      heldSelection = true;
      selected();
      await selectionGate;
    }
    return result;
  });
  const insert = store.insert.bind(store);
  vi.spyOn(store, 'insert').mockImplementation(async (quads, options) => {
    await insert(quads, options);
    if (quads.some(quad => quad.graph === ws && quad.subject === root && quad.object === '"fresh"')) {
      // The real writer has replaced the entity but has not committed its new
      // operation metadata. Cleanup must wait for the whole share transaction.
      inserted();
      await writerGate;
    }
  });

  const cleanup = agent.cleanupExpiredSharedMemory();
  let writer: ReturnType<typeof share> | undefined;
  try {
    await Promise.race([atSelection, cleanup.then(() => { throw new Error('Cleanup did not select the expired operation'); })]);
    writer = share('fresh');
    await Promise.race([atFreshInsert, writer.then(() => { throw new Error('Share did not reach the store gate'); })]);
    expect(await query(`SELECT ?value WHERE { GRAPH <${ws}> { <${root}> <urn:value> ?value } }`))
      .toMatchObject({ bindings: [{ value: '"fresh"' }] });
    releaseSelection();
    await new Promise(resolve => setImmediate(resolve));
    expect(reads.mock.calls.filter(([, options]) => options?.source === 'agent.swmCleanup.revalidateOperation')).toHaveLength(0);
    releaseWriter();
    const [fresh] = await Promise.all([writer, cleanup]);
    expect(reads.mock.calls.some(([, options]) => options?.source === 'agent.swmCleanup.revalidateOperation')).toBe(true);
    expect(await query(`SELECT ?value WHERE { GRAPH <${ws}> { <${root}> <urn:value> ?value } }`))
      .toMatchObject({ bindings: [{ value: '"fresh"' }] });
    expect(await query(`SELECT ?op WHERE { GRAPH <${meta}> {
      ?op a <${dkg}WorkspaceOperation> ; <${dkg}shareOperationId> "${fresh.shareOperationId}" ;
        <${dkg}rootEntity> <${root}> ; <${dkg}publishedAt> ?timestamp .
    } }`)).toMatchObject({ bindings: [{ op: expect.any(String) }] });
    expect(await query(`SELECT ?p WHERE { GRAPH <${meta}> { <${oldOp}> ?p ?o } }`))
      .toMatchObject({ bindings: [] });
  } finally {
    releaseSelection();
    releaseWriter();
    await Promise.allSettled([cleanup, writer]);
  }
});

it('does not let one blocked operation hold an unrelated writer behind the cleanup page', async () => {
  const agent = await DKGAgent.create({
    name: 'expiry-independent-operation-locks',
    chainAdapter: new MockChainAdapter(),
    sharedMemoryTtlMs: 60_000,
  });
  trackSwmExpiryAgent(agent);
  const { store, writeLocks } = agent as unknown as SwmExpiryTestInternals;
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  const roots = ['urn:expiry:independent:a', 'urn:expiry:independent:b'];
  await store.insert(roots.flatMap((root, index) => [
    { subject: `urn:expiry:independent:op:${index}`, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
    { subject: `urn:expiry:independent:op:${index}`, predicate: `${dkg}publishedAt`, object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
    { subject: `urn:expiry:independent:op:${index}`, predicate: `${dkg}rootEntity`, object: root, graph: META },
    { subject: root, predicate: 'urn:value', object: '"expired"', graph: WS },
  ]));

  let releaseBlockedWriter!: () => void;
  const blockedWriterGate = new Promise<void>(resolve => { releaseBlockedWriter = resolve; });
  let blockedWriterEntered!: () => void;
  const blockedWriterHasLock = new Promise<void>(resolve => { blockedWriterEntered = resolve; });
  const blockedWriter = withKeyedLocks(writeLocks, [`${CG}\0${roots[0]}`], async () => {
    blockedWriterEntered();
    await blockedWriterGate;
  });
  await blockedWriterHasLock;

  let pageSelected!: () => void;
  const selected = new Promise<void>(resolve => { pageSelected = resolve; });
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations') pageSelected();
    return result;
  });
  const cleanup = agent.cleanupExpiredSharedMemory();
  await selected;

  let unrelatedWriterCompleted = false;
  const unrelatedWriter = withKeyedLocks(writeLocks, [`${CG}\0${roots[1]}`], async () => {
    unrelatedWriterCompleted = true;
  });
  try {
    await vi.waitFor(() => expect(unrelatedWriterCompleted).toBe(true));
    expect(await query(`SELECT ?p WHERE { GRAPH <${WS}> { <${roots[1]}> ?p ?o } }`))
      .toMatchObject({ bindings: [] });
  } finally {
    releaseBlockedWriter();
    await Promise.all([blockedWriter, unrelatedWriter, cleanup]);
  }
});


it.each([undefined, 'research'])('serializes V2 expiry with the real KA staging writer in subgraph %s', async subGraphName => {
  const agent = await DKGAgent.create({ name: 'expiry-ka-race', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  const { store, publisher } = agent as unknown as SwmExpiryTestInternals;
  await store.insert([{ subject: `did:dkg:context-graph:${CG}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ContextGraph', graph: `did:dkg:context-graph:${CG}/_meta` }]);
  const kaUal = 'did:dkg:hardhat1:31337/0x1111111111111111111111111111111111111111/1';
  const stage = (id: string, version: number, timestamp: Date) => publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
    contextGraphId: CG, kaUal, shareOperationId: id, assertionVersion: version, subGraphName,
    quads: [{ subject: 'urn:expiry:ka-root', predicate: 'urn:value', object: `"${id}"`, graph: '' }], timestamp,
  });
  const old = await stage('old', 1, new Date('2020-01-01T00:00:00Z'));
  const query = store.query.bind(store);
  let entered!: () => void, release!: () => void;
  const atOwnerRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (!held && options?.source === 'agent.swmCleanup.currentHeadOwner') {
      held = true; entered(); await gate;
    }
    return result;
  });
  const cleanup = agent.cleanupExpiredSharedMemory();
  let writer: ReturnType<typeof stage> | undefined;
  try {
    await atOwnerRead;
    writer = stage('fresh', 2, new Date());
    await new Promise(resolve => setImmediate(resolve));
    release();
    await Promise.all([cleanup, writer]);
    expect(await query(`SELECT ?value WHERE { GRAPH <${old.swmGraph}> { <urn:expiry:ka-root> <urn:value> ?value } }`))
      .toMatchObject({ bindings: [{ value: '"fresh"' }] });
    const meta = subGraphName ? `did:dkg:context-graph:${CG}/${subGraphName}/_shared_memory_meta` : META;
    expect(await query(`SELECT ?id WHERE { GRAPH <${meta}> { <${kaUal}#dkg-swm-head> <http://dkg.io/ontology/shareOperationId> ?id } }`))
      .toMatchObject({ bindings: [{ id: '"fresh"' }] });
  } finally { release(); await Promise.allSettled([cleanup, writer]); }
});


it.each([undefined, 'research'])('preserves a V2 writer holding the canonical KA lock in subgraph %s', async subGraphName => {
  const agent = await DKGAgent.create({ name: 'expiry-held-ka-writer', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  const { store, publisher, writeLocks } = agent as unknown as SwmExpiryTestInternals;
  await store.insert([{ subject: `did:dkg:context-graph:${CG}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ContextGraph', graph: `did:dkg:context-graph:${CG}/_meta` }]);
  const kaUal = 'did:dkg:hardhat1:31337/0x1111111111111111111111111111111111111111/1';
  const stage = (id: string, version: number, timestamp: Date) => publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
    contextGraphId: CG, kaUal, shareOperationId: id, assertionVersion: version, subGraphName,
    quads: [{ subject: 'urn:expiry:held-ka-root', predicate: 'urn:value', object: `"${id}"`, graph: '' }], timestamp,
  });
  const old = await stage('old', 1, new Date('2020-01-01T00:00:00Z'));
  const meta = `did:dkg:context-graph:${CG}/${subGraphName ? `${subGraphName}/` : ''}_shared_memory_meta`;
  const query = store.query.bind(store);
  const oldMetadata = await query(`SELECT ?op ?snapshot WHERE { GRAPH <${meta}> {
    ?op a <http://dkg.io/ontology/WorkspaceOperation> ;
      <http://dkg.io/ontology/shareOperationId> "old" ;
      <http://dkg.io/ontology/publicSnapshotGraph> ?snapshot .
  } }`);
  expect(oldMetadata).toMatchObject({ type: 'bindings', bindings: [expect.objectContaining({ op: expect.any(String), snapshot: expect.any(String) })] });
  if (oldMetadata.type !== 'bindings') throw new Error('Expected operation metadata');
  const oldReference = oldMetadata.bindings[0]!;
  let writerEntered!: () => void, selected!: () => void, release!: () => void;
  const atWriterMutation = new Promise<void>(resolve => { writerEntered = resolve; });
  const atSelection = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const replace = store.replaceGraph!.bind(store);
  vi.spyOn(store, 'replaceGraph').mockImplementation(async (graph, quads, options) => {
    await replace(graph, quads, options);
    if (graph === old.swmGraph) {
      // New bytes are visible while the old head still owns the graph. The real
      // staging writer must retain this exact lock until it commits the new head.
      expect(writeLocks.has(swmKaWriteLockKey(CG, subGraphName, kaUal))).toBe(true);
      writerEntered(); await gate;
    }
  });
  const reads = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations' && result.type === 'bindings' && result.bindings.length > 0) selected();
    return result;
  });
  const writer = stage('fresh', 2, new Date());
  let cleanup: Promise<number> | undefined;
  try {
    await atWriterMutation;
    cleanup = agent.cleanupExpiredSharedMemory();
    await atSelection;
    await new Promise(resolve => setImmediate(resolve));
    expect(reads.mock.calls.filter(([, options]) => options?.source === 'agent.swmCleanup.currentHeadOwner')).toHaveLength(0);
    release();
    await Promise.all([writer, cleanup]);
    expect(await query(`SELECT ?value WHERE { GRAPH <${old.swmGraph}> { <urn:expiry:held-ka-root> <urn:value> ?value } }`))
      .toMatchObject({ bindings: [{ value: '"fresh"' }] });
    expect(await query(`SELECT ?id WHERE { GRAPH <${meta}> { <${kaUal}#dkg-swm-head> <http://dkg.io/ontology/shareOperationId> ?id } }`))
      .toMatchObject({ bindings: [{ id: '"fresh"' }] });
    expect(await query(`SELECT ?p WHERE { GRAPH <${meta}> { <${oldReference.op}> ?p ?o } }`))
      .toMatchObject({ bindings: [] });
    expect(await query(`SELECT ?s WHERE { GRAPH <${oldReference.snapshot}> { ?s ?p ?o } }`))
      .toMatchObject({ bindings: [] });
  } finally { release(); await Promise.allSettled([writer, cleanup]); }
});
