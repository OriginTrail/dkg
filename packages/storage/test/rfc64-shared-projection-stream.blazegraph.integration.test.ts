/**
 * Live Blazegraph oracle for the RFC-64 exact shared-projection stream.
 * CI supplies BLAZEGRAPH_TEST_URL; ordinary local runs skip this cell.
 */
import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  compileRfc64SharedProjectionStreamOperationV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BlazegraphStore,
  SyncSharedProjectionStoreV1,
} from '../src/index.js';
import type { Quad } from '../src/triple-store.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const AUTHOR = '0x3333333333333333333333333333333333333333';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const CONTEXT_GRAPH = `0x0123456789abcdef0123456789abcdef01234567/${Date.now()}`;
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const PROJECTION_BYTES = new TextEncoder().encode(LINE_A + LINE_Z);
const SCOPE = validScope({
  networkId: 'otp:20430',
  contextGraphId: CONTEXT_GRAPH,
  governanceChainId: '20430',
  governanceContractAddress: '0x5555555555555555555555555555555555555555',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});
const PROFILE = {
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
} as CatalogSealDeploymentProfileV1;
const SEAL = validSeal({
  assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'11'.repeat(32)}`,
  authorAttestationVS: `0x${'22'.repeat(32)}`,
  authorSchemeVersion: '1',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
  reservedKaId: KA_ID,
  assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
  contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  assertionVersion: '2',
  publicTripleCount: '2',
  privateTripleCount: '0',
  privateMerkleRoot: null,
});
const PROJECTION_DIGEST = computeKaProjectionDigestV1(PROJECTION_BYTES);
const ROW = validRow({
  kaId: KA_ID,
  assertionCoordinate: 'live-blazegraph',
  assertionVersion: '2',
  projectionId: 'cg-shared-v1',
  projectionDigest: PROJECTION_DIGEST,
  sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(SEAL),
  transfer: {
    codec: 'dkg-ka-bundle-v1',
    projectionId: 'cg-shared-v1',
    projectionDigest: PROJECTION_DIGEST,
    byteLength: '4096',
    chunkSize: '262144',
    chunkCount: '1',
    blobDigest: `0x${'11'.repeat(32)}`,
    chunkTreeRoot: `0x${'22'.repeat(32)}`,
  },
});
const REQUEST = Object.freeze({
  sealBinding: verifyCatalogSealBindingV1(
    SCOPE,
    ROW,
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
    PROFILE,
  ),
});
const OPERATION = compileRfc64SharedProjectionStreamOperationV1(REQUEST);
const UNRELATED_GRAPHS = Array.from(
  { length: 4 },
  (_, index) => `urn:rfc64-live-blazegraph:${Date.now()}:${index}`,
);

describe.skipIf(!BLAZEGRAPH_URL)('RFC-64 shared-projection stream (live Blazegraph)', () => {
  let store: BlazegraphStore;

  beforeAll(async () => {
    store = new BlazegraphStore(BLAZEGRAPH_URL as string, { timeout: 10_000 });
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    await cleanup();
    await store.close();
  });

  it('returns exact verified bytes at 1x and with 10x unrelated named-graph state', async () => {
    await store.insert([
      quad('urn:z', '"zeta"', OPERATION.graphIri),
      quad('urn:a', '"alpha"', OPERATION.graphIri),
    ]);
    const gateway = new SyncSharedProjectionStoreV1(store);

    const oneX = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
    });
    expect(await collect(oneX.bytes)).toEqual(PROJECTION_BYTES);

    await store.insert(Array.from({ length: 20 }, (_, index) => (
      quad(`urn:unrelated:${index}`, `"${index}"`, UNRELATED_GRAPHS[index % 4])
    )));
    const tenX = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
    });
    expect(await collect(tenX.bytes)).toEqual(PROJECTION_BYTES);
    expect(await store.countQuads(OPERATION.graphIri)).toBe(2);
  }, 30_000);

  it('honors pre-dispatch caller cancellation through the public gateway', async () => {
    const abort = new AbortController();
    const reason = new DOMException('live caller cancelled', 'AbortError');
    abort.abort(reason);
    const result = await new SyncSharedProjectionStoreV1(store).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
      signal: abort.signal,
    });

    await expect(collect(result.bytes)).rejects.toBe(reason);
  });

  async function cleanup(): Promise<void> {
    await Promise.all([
      store.dropGraph(OPERATION.graphIri).catch(() => undefined),
      ...UNRELATED_GRAPHS.map((graph) => store.dropGraph(graph).catch(() => undefined)),
    ]);
  }
});

function quad(subject: string, object: string, graph: string): Quad {
  return Object.freeze({ subject, predicate: 'urn:p', object, graph });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}
