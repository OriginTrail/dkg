import { beforeEach, describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  encodeKAUpdateRequest,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  UpdateHandler,
  computeFlatKCRootV10,
  computePrivateRootV10,
} from '../src/index.js';

const CG = 'rootless-update';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const META = `did:dkg:context-graph:${CG}/_meta`;
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function nquads(quads: readonly Quad[], graph: string): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `<${quad.subject}> <${quad.predicate}> ${quad.object.startsWith('"') ? quad.object : `<${quad.object}>`} <${graph}> .`,
  ).join('\n'));
}

describe('UpdateHandler graph-scoped updates', () => {
  let store: OxigraphStore;
  let events: TypedEventBus;
  let chainRoot: Uint8Array;
  let chainRootCount: bigint;
  let handler: UpdateHandler;
  const scope = createGraphKnowledgeAssetScope(UAL, '2');
  const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
  const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);

  beforeEach(() => {
    store = new OxigraphStore();
    events = new TypedEventBus();
    chainRoot = new Uint8Array(32);
    chainRootCount = 2n;
    const chain = {
      chainId: 'otp:20430',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: chainRoot,
        blockNumber: 20,
        txIndex: 3,
        merkleRootCount: chainRootCount,
      }),
      getKAContextGraphId: async () => 42n,
    } as unknown as ChainAdapter;
    handler = new UpdateHandler(store, chain, events, {
      knownBatchContextGraphs: new Map([[KA_ID.toString(), CG]]),
      resolveOnChainCgId: async (name) => name === CG ? '42' : null,
    });
  });

  async function seedPriorMetadata(options: {
    accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
    subGraphName?: string;
  } = {}): Promise<void> {
    const accessPolicy = options.accessPolicy ?? 'allowList';
    await store.insert([
      { subject: UAL, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD}integer>`, graph: META },
      { subject: UAL, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD}integer>`, graph: META },
      { subject: UAL, predicate: `${DKG}accessPolicy`, object: `"${accessPolicy}"`, graph: META },
      ...(accessPolicy === 'allowList'
        ? [{ subject: UAL, predicate: `${DKG}allowedPeer`, object: '"peer-a"', graph: META }]
        : []),
      ...(options.subGraphName
        ? [{ subject: UAL, predicate: `${DKG}subGraphName`, object: `"${options.subGraphName}"`, graph: META }]
        : []),
      { subject: UAL, predicate: `${DKG}publisherPeerId`, object: '"original-peer"', graph: META },
      { subject: UAL, predicate: `${PROV}wasAttributedTo`, object: `did:dkg:agent:${AUTHOR}`, graph: META },
    ]);
  }

  function message(
    publicQuads: readonly Quad[],
    privateQuads: readonly Quad[] = [],
    overrides: Record<string, unknown> = {},
  ): Uint8Array {
    const privateMerkleRoot = computePrivateRootV10(privateQuads);
    chainRoot = computeFlatKCRootV10(
      publicQuads.map((quad) => ({ ...quad, graph: '' })),
      privateMerkleRoot ? [privateMerkleRoot] : [],
    );
    return encodeKAUpdateRequest({
      contextGraphId: CG,
      batchId: KA_ID,
      nquads: nquads(publicQuads, vmGraph),
      manifest: [],
      publisherPeerId: 'replay-peer',
      publisherAddress: PUBLISHER,
      txHash: `0x${'ab'.repeat(32)}`,
      blockNumber: 20,
      newMerkleRoot: chainRoot,
      timestampMs: Date.now(),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: publicQuads.length,
      ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
      privateTripleCount: privateQuads.length,
      ...overrides,
    });
  }

  it('atomically replaces the exact VM graph and preserves KA access metadata', async () => {
    await seedPriorMetadata();
    await store.insert([
      { subject: 'urn:stale', predicate: 'urn:p:value', object: '"old"', graph: vmGraph },
      { subject: 'urn:new:a', predicate: 'urn:p:value', object: '"a"', graph: swmGraph },
    ]);
    const publicQuads: Quad[] = [
      { subject: 'urn:new:a', predicate: 'urn:p:value', object: '"a"', graph: '' },
      { subject: 'urn:other:b', predicate: 'urn:p:value', object: '"b"', graph: '' },
    ];
    const privateQuads: Quad[] = [
      { subject: 'urn:secret', predicate: 'urn:p:value', object: '"hidden"', graph: '' },
    ];

    await handler.handle(message(publicQuads, privateQuads), 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const state = await store.query(
      `ASK { GRAPH <${META}> {
        <${UAL}> <${DKG}assertionVersion> "2"^^<${XSD}integer> ;
          <${DKG}accessPolicy> "allowList" ;
          <${DKG}allowedPeer> "peer-a" ;
          <${DKG}publisherPeerId> "original-peer" ;
          <${PROV}wasAttributedTo> <did:dkg:agent:${AUTHOR}> ;
          <${DKG}status> "confirmed" .
      } }`,
    );
    expect(state).toMatchObject({ type: 'boolean', value: true });
    const legacyRoots = await store.query(
      `ASK { GRAPH <${META}> { <${UAL}> <${DKG}rootEntity> ?root } }`,
    );
    expect(legacyRoots).toMatchObject({ type: 'boolean', value: false });
  });

  it('supports a fully private update with no public placeholder triple', async () => {
    await seedPriorMetadata();
    await store.insert([{
      subject: 'urn:stale',
      predicate: 'urn:p:value',
      object: '"old"',
      graph: vmGraph,
    }]);
    const privateQuads: Quad[] = [{
      subject: 'urn:secret',
      predicate: 'urn:p:value',
      object: '"new"',
      graph: '',
    }];

    await handler.handle(message([], privateQuads), 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(0);
    const state = await store.query(
      `ASK { GRAPH <${META}> {
        <${UAL}> <${DKG}publicTripleCount> "0"^^<${XSD}integer> ;
          <${DKG}privateTripleCount> "1"^^<${XSD}integer> ;
          <${DKG}status> "confirmed" .
      } }`,
    );
    expect(state).toMatchObject({ type: 'boolean', value: true });
  });

  it('preserves owner-only access without minting a public policy row', async () => {
    await seedPriorMetadata({ accessPolicy: 'ownerOnly' });
    const update: Quad[] = [{
      subject: 'urn:new', predicate: 'urn:p:value', object: '"new"', graph: '',
    }];

    await handler.handle(message(update), 'forwarding-peer');

    const policies = await store.query(
      `SELECT ?policy WHERE { GRAPH <${META}> { <${UAL}> <${DKG}accessPolicy> ?policy } }`,
    );
    expect(policies).toMatchObject({
      type: 'bindings',
      bindings: [{ policy: '"ownerOnly"' }],
    });
  });

  it('rejects either direction of root/sub-graph identity movement', async () => {
    const update: Quad[] = [{
      subject: 'urn:new', predicate: 'urn:p:value', object: '"new"', graph: '',
    }];
    await seedPriorMetadata();
    await store.insert([{
      subject: 'urn:stale', predicate: 'urn:p:value', object: '"root"', graph: vmGraph,
    }]);

    const nestedVmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
      'nested',
    );
    await handler.handle(message(update, [], {
      subGraphName: 'nested',
      nquads: nquads(update, nestedVmGraph),
    }), 'forwarding-peer');
    expect(await store.countQuads(vmGraph)).toBe(1);

    store = new OxigraphStore();
    const subScopeGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
      'nested',
    );
    const chain = {
      chainId: 'otp:20430',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: chainRoot,
        blockNumber: 20,
        txIndex: 3,
        merkleRootCount: 2n,
      }),
      getKAContextGraphId: async () => 42n,
    } as unknown as ChainAdapter;
    handler = new UpdateHandler(store, chain, events, {
      knownBatchContextGraphs: new Map([[KA_ID.toString(), CG]]),
      resolveOnChainCgId: async () => '42',
    });
    await seedPriorMetadata({ subGraphName: 'nested' });
    await store.insert([{
      subject: 'urn:stale', predicate: 'urn:p:value', object: '"sub"', graph: subScopeGraph,
    }]);

    await handler.handle(message(update), 'forwarding-peer');
    expect(await store.countQuads(subScopeGraph)).toBe(1);
  });

  it('fails closed when the receipt root differs from the wire payload root', async () => {
    await seedPriorMetadata();
    await store.insert([{
      subject: 'urn:stale', predicate: 'urn:p:value', object: '"old"', graph: vmGraph,
    }]);
    const update: Quad[] = [{
      subject: 'urn:new', predicate: 'urn:p:value', object: '"new"', graph: '',
    }];
    const encoded = message(update);
    chainRoot = new Uint8Array(32).fill(0xff);

    await handler.handle(encoded, 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(1);
    const old = await store.query(`ASK { GRAPH <${vmGraph}> { <urn:stale> ?p ?o } }`);
    expect(old).toMatchObject({ type: 'boolean', value: true });
  });

  it('commits VM, metadata, and version atomically and replays after a failed transaction', async () => {
    await seedPriorMetadata();
    await store.insert([{
      subject: 'urn:stale', predicate: 'urn:p:value', object: '"old"', graph: vmGraph,
    }]);
    const update: Quad[] = [{
      subject: 'urn:new', predicate: 'urn:p:value', object: '"new"', graph: '',
    }];
    const encoded = message(update);
    const realUpdate = store.update.bind(store);
    let fail = true;
    store.update = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('injected atomic materialization failure');
      }
      return realUpdate(...args);
    };

    await handler.handle(encoded, 'forwarding-peer');
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.query(
      `ASK { GRAPH <${META}> { <${UAL}> <${DKG}assertionVersion> "1"^^<${XSD}integer> } }`,
    )).toMatchObject({ type: 'boolean', value: true });

    await handler.handle(encoded, 'forwarding-peer');
    expect(await store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:new> <urn:p:value> "new" } }`,
    )).toMatchObject({ type: 'boolean', value: true });
    expect(await store.query(
      `ASK { GRAPH <${META}> { <${UAL}> <${DKG}assertionVersion> "2"^^<${XSD}integer> } }`,
    )).toMatchObject({ type: 'boolean', value: true });
  });

  it('rejects non-canonical receiver RDF before materialization', async () => {
    await seedPriorMetadata();
    const update: Quad[] = [{
      subject: 'urn:new', predicate: 'urn:p:value', object: '"new"', graph: '',
    }];
    const wrongGraph = 'did:dkg:context-graph:attacker/_verifiable_memory';

    await handler.handle(message(update, [], {
      nquads: nquads(update, wrongGraph),
    }), 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(0);
  });

  it('rejects mixed legacy roots and a chain-inconsistent assertion version', async () => {
    await seedPriorMetadata();
    await store.insert([{
      subject: 'urn:stale',
      predicate: 'urn:p:value',
      object: '"old"',
      graph: vmGraph,
    }]);
    const update: Quad[] = [{
      subject: 'urn:new',
      predicate: 'urn:p:value',
      object: '"new"',
      graph: '',
    }];

    await handler.handle(message(update, [], {
      manifest: [{ rootEntity: 'urn:legacy:root', privateTripleCount: 0 }],
    }), 'forwarding-peer');
    expect(await store.countQuads(vmGraph)).toBe(1);

    chainRootCount = 3n;
    await handler.handle(message(update), 'forwarding-peer');
    expect(await store.countQuads(vmGraph)).toBe(1);
  });

  it('defers an update until authoritative graph metadata has synced', async () => {
    const update: Quad[] = [{
      subject: 'urn:new',
      predicate: 'urn:p:value',
      object: '"new"',
      graph: '',
    }];

    await handler.handle(message(update), 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(0);
  });

  it('rejects a UAL from a different chain namespace', async () => {
    await seedPriorMetadata();
    const update: Quad[] = [{
      subject: 'urn:new',
      predicate: 'urn:p:value',
      object: '"new"',
      graph: '',
    }];

    await handler.handle(message(update, [], {
      kaUal: `did:dkg:other:1/${AUTHOR}/7`,
    }), 'forwarding-peer');

    expect(await store.countQuads(vmGraph)).toBe(0);
  });
});
