import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { encodeFinalizationMessage, type FinalizationMessageMsg, encodePublishRequest, createOperationContext } from '@origintrail-official/dkg-core';
import { FinalizationHandler } from '../src/finalization-handler.js';

const PARANET = 'test-paranet';

function makeFinalizationMsg(overrides?: Partial<FinalizationMessageMsg>): FinalizationMessageMsg {
  return {
    ual: 'did:dkg:evm:31337/0xABC/1',
    contextGraphId: PARANET,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 2,
    publisherAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    rootEntities: ['urn:test:entity'],
    timestampMs: Date.now(),
    operationId: 'test-op-1',
    ...overrides,
  };
}


describe('FinalizationHandler', () => {
  let store: OxigraphStore;
  let handler: FinalizationHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    handler = new FinalizationHandler(store, undefined);
  });

  it('deduplicates messages with same UAL and txHash', async () => {
    const msg = makeFinalizationMsg();
    const data = encodeFinalizationMessage(msg);

    let insertCallCount = 0;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCallCount++; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, PARANET);
    const callsAfterFirst = insertCallCount;
    await handler.handleFinalizationMessage(data, PARANET);
    expect(insertCallCount).toBe(callsAfterFirst);
  });

  it('processes messages with different UALs separately (not deduped)', async () => {
    const msg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    const msg2 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/2', txHash: '0x' + 'cd'.repeat(32) });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg1), PARANET);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg2), PARANET);

    // Now send msg1 again — it should be deduped (no extra processing)
    // But msg2 should not have been blocked by msg1's dedup entry
    // Verify both processed without error; dedup test covers the blocking case
    const dedupMsg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(encodeFinalizationMessage(dedupMsg1), PARANET);
    // msg1 is deduped so no insert should happen
    expect(insertCalled).toBe(false);
  });

  it('silently skips non-finalization protobuf messages (wrong wire type)', async () => {
    const wrongTypeData = encodePublishRequest({
      ual: 'did:dkg:test/1',
      nquads: new TextEncoder().encode('<urn:s> <urn:p> <urn:o> .'),
      contextGraphId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'urn:s', privateTripleCount: 0, privateMerkleRoot: new Uint8Array(0) }],
      txHash: '',
      blockNumber: 0,
    });

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(wrongTypeData, PARANET);
    expect(insertCalled).toBe(false);
  });

  it('silently skips random binary data', async () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0x01, 0x02, 0x03]);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(garbage, PARANET);
    expect(insertCalled).toBe(false);
  });

  it('ignores messages with mismatched contextGraphId', async () => {
    const msg = makeFinalizationMsg({ contextGraphId: 'wrong-paranet' });
    const data = encodeFinalizationMessage(msg);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, PARANET);
    expect(insertCalled).toBe(false);
  });

  it('rejects messages with incomplete fields', async () => {
    const msg = makeFinalizationMsg({ rootEntities: [] });
    const data = encodeFinalizationMessage(msg);

    let insertCalled = false;
    const origInsert = store.insert.bind(store);
    store.insert = async (...args: any[]) => { insertCalled = true; return (origInsert as any)(...args); };

    await handler.handleFinalizationMessage(data, PARANET);
    expect(insertCalled).toBe(false);
  });

  it('refuses to promote when no chain adapter is wired even if local merkle matches', async () => {
    // Regression guard: a finalization message whose merkle root matches
    // the local SWM contents MUST still be rejected when the handler was
    // constructed without a chain adapter (`new FinalizationHandler(store,
    // undefined)` in `beforeEach`). On-chain verification is NOT optional
    // — trusting a matching local merkle without checking the KCCreated
    // event would let any peer forge finalizations for their own forged
    // SWM state. The canonical data graph must stay empty.
    //
    // The positive "merkle matches AND chain verification passes →
    // promotes" path is covered by `agent-audit-extra.test.ts [A-4]` and
    // the e2e-publish-protocol round-trip, both of which wire in a real
    // EVMChainAdapter against the shared Hardhat node.
    const entity = 'urn:test:entity';
    const wsGraph = `did:dkg:context-graph:${PARANET}/_shared_memory`;
    const dataGraph = `did:dkg:context-graph:${PARANET}`;

    await store.insert([
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: wsGraph },
    ]);

    const { computeFlatKCRootV10: computeRoot } = await import('@origintrail-official/dkg-publisher');
    const merkleRoot = computeRoot(
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
      [],
    );

    const msg = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [entity],
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), PARANET);

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('does not promote when merkle root mismatches workspace data', async () => {
    const entity = 'urn:test:entity';
    const wsGraph = `did:dkg:context-graph:${PARANET}/_shared_memory`;
    const dataGraph = `did:dkg:context-graph:${PARANET}`;

    await store.insert([
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: wsGraph },
    ]);

    const msg = makeFinalizationMsg({
      kcMerkleRoot: new Uint8Array(32).fill(0xFF),
      rootEntities: [entity],
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), PARANET);

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('backfills full sub-graph registration metadata during finalization promotion', async () => {
    const entity = 'urn:test:entity';
    const subGraphName = 'code';
    const publisherAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    const subGraphUri = `did:dkg:context-graph:${PARANET}/${subGraphName}`;

    await (handler as any).promoteSharedMemoryToCanonical(
      PARANET,
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
      'did:dkg:evm:31337/0xABC/1',
      [entity],
      publisherAddress,
      '0x' + 'ab'.repeat(32),
      100,
      1n,
      1n,
      1n,
      createOperationContext('system'),
      undefined,
      subGraphName,
    );

    const registration = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${subGraphUri}> a <http://dkg.io/ontology/SubGraph> ;
          <http://schema.org/name> "code" ;
          <http://dkg.io/ontology/createdBy> <did:dkg:agent:${publisherAddress}> .
      } }`,
    );
    expect(registration.type).toBe('boolean');
    if (registration.type === 'boolean') expect(registration.value).toBe(true);

    const canonical = await store.query(
      `ASK { GRAPH <${subGraphUri}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(canonical.type).toBe('boolean');
    if (canonical.type === 'boolean') expect(canonical.value).toBe(true);
  });
});
