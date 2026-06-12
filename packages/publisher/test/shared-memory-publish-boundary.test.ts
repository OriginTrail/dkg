import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TRUST_LEVEL_PREDICATE,
  TrustLevel,
  TypedEventBus,
  generateEd25519Keypair,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';
import type { PublishResult } from '../src/publisher.js';

const CONTEXT_GRAPH = 'publish-boundary';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const SWM_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
const SWM_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
const PER_KA_SWM_GRAPH = `${SWM_GRAPH}/0x1111111111111111111111111111111111111111/1`;
const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

function q(subject: string, predicate = 'http://schema.org/name', object = '"value"', graph = SWM_GRAPH): Quad {
  return { subject, predicate, object, graph };
}

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const publishResult: PublishResult = {
    kaId: 1n,
    ual: 'did:dkg:0x0000000000000000000000000000000000000001/1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [
      {
        tokenId: 1n,
        rootEntity: 'urn:test:root:one',
        privateTripleCount: 0,
      },
    ],
    status: 'tentative',
    publicQuads: [],
  };
  const publishSpy = vi.spyOn(publisher, 'publish').mockResolvedValue(publishResult);
  return { publisher, store, publishSpy };
}

describe('publishFromSharedMemory multi-root selection (OT-RFC-44 / Design B: one KA, N entities)', () => {
  it('allows selection "all" when shared memory resolves to one payload root', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:one', WORKSPACE_OWNER_PREDICATE, '"peer-a"'),
      q('urn:test:root:one', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
      q('urn:test:root:metadata-only', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:metadata-only', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all')).resolves.toMatchObject({
      status: 'tentative',
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const publishArgs = publishSpy.mock.calls[0][0];
    expect(publishArgs.quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
    ]);
  });

  it('selection "all" reads promoted per-KA SWM graphs', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"promoted"', PER_KA_SWM_GRAPH),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all')).resolves.toMatchObject({
      status: 'tentative',
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0].quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"promoted"', graph: '' },
    ]);
  });

  it('publishes ALL payload roots as one KA when selection "all" resolves to multiple roots (OT-RFC-44)', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    // OT-RFC-44 / Design B: multiple payload roots publish as ONE Knowledge
    // Asset in a single transaction (formerly rejected as "not atomic"). The
    // publish proceeds once and carries both roots' (trust/owner-filtered) quads.
    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all'))
      .resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const subjects = new Set(publishSpy.mock.calls[0][0].quads.map((qq: any) => qq.subject));
    expect(subjects.has('urn:test:root:one')).toBe(true);
    expect(subjects.has('urn:test:root:two')).toBe(true);
  });

  it('scopes an explicit single-root selection to that root and excludes co-resident SWM roots', async () => {
    // Regression guard for the "named publish bundled all SWM" bug
    // (v10-stress FINDINGS Bug 1, fixed in 26c38350). When a caller does
    // NOT drain shared memory between batches, two fully-formed payload roots
    // coexist in SWM. `publishFromFinalizedAssertion` scopes the SWM CONSTRUCT
    // to the seal's `rootEntities`; a regression back to `'all'` (or a leaky
    // VALUES clause) would bundle root:two into root:one's KC, the publisher's
    // merkle recompute would then disagree with the seal, and the publish would
    // flip to `tentative kaId:"0"` for end users. The devnet suite's SWM-drain
    // workaround hides exactly this, so pin it at the publisher seam instead.
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:one', 'http://schema.org/description', '"one-desc"'),
      // A SECOND, unrelated payload root left behind in SWM.
      q('urn:test:root:two'),
      q('urn:test:root:two', 'http://schema.org/description', '"two-desc"'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: ['urn:test:root:one'] }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const publishArgs = publishSpy.mock.calls[0][0];
    // GREEDY: assert the EXACT payload, not just a count. Every quad must
    // belong to root:one and NONE may belong to the co-resident root:two.
    // (CONSTRUCT order isn't guaranteed, so match set-wise, not positionally.)
    expect(publishArgs.quads).toHaveLength(2);
    expect(publishArgs.quads).toEqual(
      expect.arrayContaining([
        { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
        { subject: 'urn:test:root:one', predicate: 'http://schema.org/description', object: '"one-desc"', graph: '' },
      ]),
    );
    expect(publishArgs.quads.every((qq) => qq.subject === 'urn:test:root:one')).toBe(true);
  });

  it('explicit rootEntities selection reads promoted per-KA SWM graphs', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one', 'http://schema.org/name', '"promoted"', PER_KA_SWM_GRAPH),
      q('urn:test:root:two', 'http://schema.org/name', '"bare"'),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: ['urn:test:root:one'] }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0].quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"promoted"', graph: '' },
    ]);
  });

  it('publishes both explicit rootEntities as one KA when they resolve to multiple payload roots (OT-RFC-44)', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
    ]);

    // OT-RFC-44 / Design B: an explicit multi-root selection publishes as ONE
    // KA whose member entities are both roots — a single atomic transaction.
    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: ['urn:test:root:one', 'urn:test:root:two'],
      }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const subjects = new Set(publishSpy.mock.calls[0][0].quads.map((qq: any) => qq.subject));
    expect(subjects.has('urn:test:root:one')).toBe(true);
    expect(subjects.has('urn:test:root:two')).toBe(true);
  });
});

describe('shared-memory metadata cleanup during predicate rename', () => {
  it('removes stale dkg:entity links when upserting one root from a multi-root share', async () => {
    const { publisher, store } = await makePublisher();
    const rootA = 'urn:test:cleanup:a';
    const rootB = 'urn:test:cleanup:b';

    await publisher.share(CONTEXT_GRAPH, [
      q(rootA, 'http://schema.org/name', '"A"', CONTEXT_GRAPH_URI),
      q(rootB, 'http://schema.org/name', '"B"', CONTEXT_GRAPH_URI),
    ], { publisherPeerId: 'peer-a' });

    await publisher.share(CONTEXT_GRAPH, [
      q(rootA, 'http://schema.org/name', '"A updated"', CONTEXT_GRAPH_URI),
    ], { publisherPeerId: 'peer-a' });

    const rootAOps = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ENTITY}> <${rootA}> } }`,
    );
    expect(rootAOps.type).toBe('bindings');
    if (rootAOps.type === 'bindings') {
      expect(rootAOps.bindings).toHaveLength(1);
    }

    const rootBMeta = await store.query(
      `ASK { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ENTITY}> <${rootB}> } }`,
    );
    expect(rootBMeta.type).toBe('boolean');
    if (rootBMeta.type === 'boolean') {
      expect(rootBMeta.value).toBe(true);
    }

    const rootALegacyOps = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${SWM_META_GRAPH}> { ?op <${DKG_ROOT_ENTITY_LEGACY}> <${rootA}> } }`,
    );
    expect(rootALegacyOps.type).toBe('bindings');
    if (rootALegacyOps.type === 'bindings') {
      expect(rootALegacyOps.bindings).toHaveLength(1);
    }
  });
});
