import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TRUST_LEVEL_PREDICATE,
  TrustLevel,
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';
import type { PublishResult } from '../src/publisher.js';
import { generateShareMetadata } from '../src/metadata.js';

const CONTEXT_GRAPH = 'publish-boundary';
const SWM_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
const SWM_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
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

describe('publishFromSharedMemory selection boundary', () => {
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

  it('rejects selection "all" when shared memory resolves to multiple independent roots', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all'))
      .rejects.toMatchObject({ code: 'MULTI_ROOT_PUBLISH_NOT_ATOMIC' });

    expect(publishSpy).not.toHaveBeenCalled();
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

  it('allows explicit multi-root selection when roots match one share-operation boundary', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    const roots = ['urn:test:root:one', 'urn:test:root:two'];
    await store.insert([
      q(roots[0]),
      q(roots[1]),
      ...generateShareMetadata({
        contextGraphId: CONTEXT_GRAPH,
        shareOperationId: 'op-design-b',
        rootEntities: roots,
        publisherPeerId: 'peer-a',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      }, SWM_META_GRAPH),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: roots,
      }),
    ).resolves.toMatchObject({ status: 'tentative' });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const publishArgs = publishSpy.mock.calls[0][0];
    expect(publishArgs.quads).toHaveLength(2);
    expect(new Set(publishArgs.quads.map((qq) => qq.subject))).toEqual(new Set(roots));
  });

  it('rejects explicit multi-root selection when roots do not match one share-operation boundary', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
    ]);

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: ['urn:test:root:one', 'urn:test:root:two'],
      }),
    ).rejects.toMatchObject({ code: 'MULTI_ROOT_PUBLISH_NOT_ATOMIC' });

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
