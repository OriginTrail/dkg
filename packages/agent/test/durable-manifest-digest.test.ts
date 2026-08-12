import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  createGraphScopedDurableManifestPlan,
  DURABLE_MANIFEST_DIGEST_DOMAIN,
  DURABLE_MANIFEST_DIGEST_VERSION,
  encodeGraphScopedDurableManifest,
  graphScopedDurableManifestPrefixAtOffset,
  type GraphScopedDescriptor,
} from '../src/sync/durable-integrity.js';

const CONTEXT_GRAPH_ID = 'manifest-digest-test';

function asset(
  kaNumber: number,
  options: { tripleCount?: number; valuePrefix?: string; subGraphName?: string } = {},
): { payload: Quad[]; meta: Quad[] } {
  const tripleCount = options.tripleCount ?? 2;
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000dd/${kaNumber}`;
  const scope = createGraphKnowledgeAssetScope(ual, '1');
  const graph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    scope,
    options.subGraphName,
  );
  const payload = Array.from({ length: tripleCount }, (_, index): Quad => ({
    subject: `urn:manifest:${kaNumber}:${index}`,
    predicate: 'urn:manifest:value',
    object: `"${options.valuePrefix ?? 'value'}-${index}"`,
    graph,
  }));
  const privateQuads: Quad[] = [];
  const privateMerkleRoot = computePrivateRootV10(privateQuads);
  return {
    payload,
    meta: generateGraphKnowledgeAssetMetadata({
      ual,
      contextGraphId: CONTEXT_GRAPH_ID,
      merkleRoot: computeFlatKCRootV10(
        payload,
        privateMerkleRoot ? [privateMerkleRoot] : [],
      ),
      publisherPeerId: 'publisher-peer',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: payload.length,
      privateTripleCount: 0,
      assertionGraph: graph,
      ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
    }, { status: 'tentative' }),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function descriptor(overrides: Partial<GraphScopedDescriptor> = {}): GraphScopedDescriptor {
  return {
    ual: 'did:dkg:test/asset',
    contentScopeVersion: '2',
    assertionVersion: '1',
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionGraph: 'did:dkg:context-graph:test/_verifiable_memory/a',
    publicTripleCount: 2,
    privateTripleCount: 0,
    claimedRootHex: '11'.repeat(32),
    metadataDigestHex: '44'.repeat(32),
    ...overrides,
  };
}

describe('canonical durable manifest digest', () => {
  it('is deterministic and independent of raw META RDF row order', () => {
    const meta = [asset(1), asset(2), asset(3)].flatMap((entry) => entry.meta);
    const forward = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID);
    const reordered = createGraphScopedDurableManifestPlan([...meta].reverse(), CONTEXT_GRAPH_ID);

    expect(forward).not.toBeNull();
    expect(reordered?.manifestDigest).toBe(forward?.manifestDigest);
    expect(reordered?.descriptors).toEqual(forward?.descriptors);
  });

  it('changes for equal-width replacement and append generations', () => {
    const x = createGraphScopedDurableManifestPlan(
      [asset(1), asset(3), asset(5)].flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    );
    const replacement = createGraphScopedDurableManifestPlan(
      [asset(1), asset(2), asset(5)].flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    );
    const appended = createGraphScopedDurableManifestPlan(
      [asset(1), asset(3), asset(5), asset(7)].flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    );

    expect(replacement?.manifestRowCount).toBe(x?.manifestRowCount);
    expect(replacement?.manifestDigest).not.toBe(x?.manifestDigest);
    expect(appended?.manifestDigest).not.toBe(x?.manifestDigest);
  });

  it('uses unambiguous length-prefixed fields', () => {
    const left = encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [descriptor({
      ual: 'a|b',
      assertionGraph: 'c',
    })]);
    const right = encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [descriptor({
      ual: 'a',
      assertionGraph: 'b|c',
    })]);

    expect(left).not.toEqual(right);
    expect(sha256(left)).not.toBe(sha256(right));
  });

  it('is sensitive to every DATA-plan and integrity field', () => {
    const base = descriptor();
    const baseDigest = sha256(encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [base]));
    const mutations: GraphScopedDescriptor[] = [
      descriptor({ ual: `${base.ual}:other` }),
      descriptor({ contentScopeVersion: '3' }),
      descriptor({ assertionVersion: '2' }),
      descriptor({ contextGraphId: `${CONTEXT_GRAPH_ID}:other` }),
      descriptor({ subGraphName: 'private' }),
      descriptor({ assertionGraph: `${base.assertionGraph}:other` }),
      descriptor({ publicTripleCount: 3 }),
      descriptor({ claimedRootHex: '22'.repeat(32) }),
      descriptor({ privateTripleCount: 1, privateRootHex: '33'.repeat(32) }),
      descriptor({ metadataDigestHex: '55'.repeat(32) }),
    ];

    for (const mutation of mutations) {
      expect(sha256(encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [mutation])))
        .not.toBe(baseDigest);
    }
  });

  it('changes when receipt or materialization metadata changes without changing DATA', () => {
    const original = asset(1);
    const transactionHash = `0x${'ab'.repeat(32)}`;
    const withReceipt: Quad[] = [
      ...original.meta,
      {
        subject: original.meta[0]!.subject,
        predicate: 'http://dkg.io/ontology/transactionHash',
        object: `"${transactionHash}"`,
        graph: original.meta[0]!.graph,
      },
    ];

    const before = createGraphScopedDurableManifestPlan(original.meta, CONTEXT_GRAPH_ID);
    const after = createGraphScopedDurableManifestPlan(withReceipt, CONTEXT_GRAPH_ID);

    expect(after?.manifestRowCount).toBe(before?.manifestRowCount);
    expect(after?.descriptors[0]?.claimedRootHex).toBe(before?.descriptors[0]?.claimedRootHex);
    expect(after?.manifestDigest).not.toBe(before?.manifestDigest);
  });

  it('is order-sensitive using the same ordered descriptors as the DATA plan', () => {
    const first = descriptor({ ual: 'first', assertionGraph: 'graph:a' });
    const second = descriptor({ ual: 'second', assertionGraph: 'graph:b' });
    const forward = sha256(encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [first, second]));
    const reversed = sha256(encodeGraphScopedDurableManifest(CONTEXT_GRAPH_ID, [second, first]));

    expect(reversed).not.toBe(forward);
  });

  it('separates the digest domain and encoding version', () => {
    const fields = [descriptor()];
    const current = sha256(encodeGraphScopedDurableManifest(
      CONTEXT_GRAPH_ID,
      fields,
      DURABLE_MANIFEST_DIGEST_DOMAIN,
      DURABLE_MANIFEST_DIGEST_VERSION,
    ));
    const otherDomain = sha256(encodeGraphScopedDurableManifest(
      CONTEXT_GRAPH_ID,
      fields,
      `${DURABLE_MANIFEST_DIGEST_DOMAIN}.other`,
      DURABLE_MANIFEST_DIGEST_VERSION,
    ));
    const otherVersion = sha256(encodeGraphScopedDurableManifest(
      CONTEXT_GRAPH_ID,
      fields,
      DURABLE_MANIFEST_DIGEST_DOMAIN,
      DURABLE_MANIFEST_DIGEST_VERSION + 1,
    ));

    expect(otherDomain).not.toBe(current);
    expect(otherVersion).not.toBe(current);
  });

  it('reuses only an unchanged canonical graph prefix across generations', () => {
    const original = createGraphScopedDurableManifestPlan(
      [asset(1), asset(3)].flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    )!;
    const appended = createGraphScopedDurableManifestPlan(
      [asset(1), asset(3), asset(5)].flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    )!;
    const changedPrefix = createGraphScopedDurableManifestPlan(
      [asset(1, { valuePrefix: 'changed' }), asset(3), asset(5)]
        .flatMap((entry) => entry.meta),
      CONTEXT_GRAPH_ID,
    )!;

    const boundary = original.descriptors[0]!.publicTripleCount;
    const originalPrefix = graphScopedDurableManifestPrefixAtOffset(original, boundary);
    const appendedPrefix = graphScopedDurableManifestPrefixAtOffset(appended, boundary);
    const changed = graphScopedDurableManifestPrefixAtOffset(changedPrefix, boundary);

    expect(appended.manifestDigest).not.toBe(original.manifestDigest);
    expect(appendedPrefix?.prefixDigest).toBe(originalPrefix?.prefixDigest);
    expect(changed?.prefixDigest).not.toBe(originalPrefix?.prefixDigest);
    expect(graphScopedDurableManifestPrefixAtOffset(appended, boundary - 1)).toBeNull();
  });
});
