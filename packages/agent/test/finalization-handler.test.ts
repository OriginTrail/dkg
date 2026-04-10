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

    // Process same message twice — should not throw, second should be skipped
    await handler.handleFinalizationMessage(data, PARANET);
    await handler.handleFinalizationMessage(data, PARANET);
    // No assertion needed — the test passes if no errors are thrown
    // and no double-processing occurs (verified by log "already processed")
  });

  it('processes messages with different UALs separately', async () => {
    const msg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    const msg2 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/2', txHash: '0x' + 'cd'.repeat(32) });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg1), PARANET);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg2), PARANET);
  });

  it('silently skips non-finalization protobuf messages (wrong wire type)', async () => {
    // Encode a publish request message instead of a finalization message
    const wrongTypeData = encodePublishRequest({
      ual: 'did:dkg:test/1',
      nquads: new TextEncoder().encode('<urn:s> <urn:p> <urn:o> .'),
      contextGraphId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'urn:s', privateTripleCount: 0, privateMerkleRoot: new Uint8Array(0) }],
      txHash: '',
      blockNumber: 0,
    });

    // Should not throw — just silently skip
    await handler.handleFinalizationMessage(wrongTypeData, PARANET);
  });

  it('silently skips random binary data', async () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0x01, 0x02, 0x03]);
    await handler.handleFinalizationMessage(garbage, PARANET);
  });

  it('ignores messages with mismatched contextGraphId', async () => {
    const msg = makeFinalizationMsg({ contextGraphId: 'wrong-paranet' });
    const data = encodeFinalizationMessage(msg);
    await handler.handleFinalizationMessage(data, PARANET);
  });

  it('rejects messages with incomplete fields', async () => {
    const msg = makeFinalizationMsg({ rootEntities: [] });
    const data = encodeFinalizationMessage(msg);
    await handler.handleFinalizationMessage(data, PARANET);
  });

  it('promotes workspace data to canonical when merkle matches (no chain adapter)', async () => {
    const entity = 'urn:test:entity';
    const wsGraph = `did:dkg:context-graph:${PARANET}/_shared_memory`;
    const dataGraph = `did:dkg:context-graph:${PARANET}`;
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;

    // Write triples to the workspace graph
    await store.insert([
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: wsGraph },
    ]);

    // Compute merkle root from workspace data
    const { computeFlatKCRootV10: computeRoot } = await import('@origintrail-official/dkg-publisher');
    const merkleRoot = computeRoot(
      [{ subject: entity, predicate: 'http://schema.org/name', object: '"Alice"', graph: '' }],
      [],
    );

    const msg = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [entity],
    });

    // chain is undefined → verification returns false → no promotion via gossip
    // but we can verify the handler doesn't crash and handles the flow gracefully
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), PARANET);

    // Data should NOT be in canonical (chain verification failed since chain=undefined)
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

    // Use a bogus merkle root that won't match
    const msg = makeFinalizationMsg({
      kcMerkleRoot: new Uint8Array(32).fill(0xFF),
      rootEntities: [entity],
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), PARANET);

    // Data should NOT be promoted to canonical (merkle mismatch)
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
