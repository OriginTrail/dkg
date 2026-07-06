// E2E round-trip for the `/api/kc/:id/author` daemon route.
//
// This test exercises the full chain of plumbing introduced in
// Phase 1–3 of the agent-provenance work:
//
//   1. A real ethers wallet signs an EIP-712 author attestation built
//      via `buildAuthorAttestationTypedData` from `@origintrail-official/dkg-core`.
//   2. `MockChainAdapter.createKnowledgeAssets` ingests the signed
//      params and persists `params.author.address` on its internal
//      collection record (mirroring what `KnowledgeCollectionStorage`
//      now does on-chain in the `MerkleRoot.author` field).
//   3. A minimal `DKGAgent` shim delegates `getKnowledgeCollectionAuthor`
//      to `chain.getLatestMerkleRootAuthor` — same one-line passthrough
//      the real `DKGAgent` exposes.
//   4. The actual `handleAssertionRoutes` route handler is invoked
//      with a stub `RouteRequestContext`, and we assert the wire-format
//      response matches the route contract: `{ kaId, author, attested }`.
//
// The route's three error modes are also covered:
//
//   - 503 when the chain adapter does not implement the view (e.g. a
//     pre-V10.1 adapter copy or `NoChainAdapter`).
//   - 404 when the kaId is unknown to the chain.
//   - `attested: false` when the chain returned `address(0)` (legacy
//     write paths that pre-date author attestation, including the
//     current V10.1 update path).

import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type V10PublishParams,
} from '@origintrail-official/dkg-chain';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import { handleKcChainMetadataRoutes } from '../src/daemon/routes/kc-chain-metadata.js';
import type { RouteRequestContext } from '../src/daemon/routes/context.js';

const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const ZERO = '0x0000000000000000000000000000000000000000';

function createResponse() {
  const response = {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
  return response;
}

interface AgentShimOpts {
  /** When true, the shim implements `getKnowledgeCollectionAuthor` by
   *  delegating to the chain adapter. When false, the route should map
   *  to 503 (chain adapter doesn't expose the view). */
  withChain: boolean;
  chain?: MockChainAdapter;
}

function createAgentShim(opts: AgentShimOpts) {
  if (!opts.withChain) {
    return {
      getKnowledgeCollectionAuthor: async () => null,
    } as unknown as RouteRequestContext['agent'];
  }
  const chain = opts.chain!;
  return {
    getKnowledgeCollectionAuthor: async (kaId: bigint) => {
      return chain.getLatestMerkleRootAuthor(kaId);
    },
  } as unknown as RouteRequestContext['agent'];
}

function createContext(args: {
  kcIdPath: string;
  agent: RouteRequestContext['agent'];
}): RouteRequestContext {
  const fullPath = `/api/kc/${args.kcIdPath}/author`;
  const url = new URL(`http://127.0.0.1${fullPath}`);
  const request = {
    method: 'GET',
    url: fullPath,
  };
  return {
    req: request as RouteRequestContext['req'],
    res: createResponse() as unknown as ServerResponse,
    agent: args.agent,
    publisherControl: {} as RouteRequestContext['publisherControl'],
    publisherRuntime: null,
    config: {} as RouteRequestContext['config'],
    startedAt: 0,
    dashDb: {} as RouteRequestContext['dashDb'],
    opWallets: {
      adminWallet: { address: '0x0', privateKey: '0x0' },
      wallets: [],
    } as RouteRequestContext['opWallets'],
    network: null as RouteRequestContext['network'],
    tracker: {} as RouteRequestContext['tracker'],
    memoryManager: {} as RouteRequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RouteRequestContext['catchupTracker'],
    extractionRegistry: {} as RouteRequestContext['extractionRegistry'],
    fileStore: {} as RouteRequestContext['fileStore'],
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RouteRequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: '0x0',
  };
}

function responseBody(ctx: RouteRequestContext): Record<string, unknown> {
  return JSON.parse(
    (ctx.res as unknown as { body: string }).body,
  ) as Record<string, unknown>;
}

async function publishWithSignedAttestation(args: {
  chain: MockChainAdapter;
  signer: ethers.Wallet;
  contextGraphId: bigint;
  merkleRoot: Uint8Array;
}): Promise<bigint> {
  const chainId = BigInt(await args.chain.getEvmChainId());
  // §F2 — the AuthorAttestation digest binds the packed reservedKaId, and the
  // mock mints exactly it (kaId === reservedKaId). Allocate number 1 for this author.
  const reservedKaId = (BigInt(ethers.getAddress(args.signer.address)) << 96n) | 1n;
  const typedData = buildAuthorAttestationTypedData({
    chainId,
    kav10Address: TEST_KAV10_ADDR,
    // #1116: AuthorAttestation no longer binds contextGraphId.
    merkleRoot: args.merkleRoot,
    authorAddress: args.signer.address,
    reservedKaId,
  });
  const sigHex = await args.signer.signTypedData(
    typedData.domain as ethers.TypedDataDomain,
    typedData.types,
    typedData.message,
  );
  const sig = ethers.Signature.from(sigHex);
  const publishParams: V10PublishParams = {
    publishOperationId: 'op-' + Date.now(),
    contextGraphId: args.contextGraphId,
    publisherAddress: args.signer.address,
    merkleRoot: args.merkleRoot,
    reservedKaId,
    knowledgeAssetsAmount: 1,
    byteSize: 100n,
    epochs: 1,
    tokenAmount: 0n,
    isImmutable: true,
    merkleLeafCount: 1,
    publisherNodeIdentityId: 1n,
    author: {
      address: args.signer.address,
      schemeVersion: 1,
      signature: {
        r: ethers.getBytes(sig.r),
        vs: ethers.getBytes(sig.yParityAndS),
      },
    },
    ackSignatures: [],
  };
  const result = await args.chain.createKnowledgeAssets(publishParams);
  expect(result.authorAddress).toBeDefined();
  expect(result.authorAddress!.toLowerCase()).toBe(
    args.signer.address.toLowerCase(),
  );
  return result.batchId;
}

describe('GET /api/kc/:id/author E2E round-trip', () => {
  it('round-trips a signed publish: signer → chain → route response', async () => {
    const signer = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', signer.address);
    chain.minimumRequiredSignatures = 0;

    const merkleRoot = ethers.getBytes(
      ethers.keccak256(ethers.toUtf8Bytes('round-trip-test')),
    );
    const kaId = await publishWithSignedAttestation({
      chain,
      signer,
      contextGraphId: 42n,
      merkleRoot,
    });

    const ctx = createContext({
      kcIdPath: kaId.toString(),
      agent: createAgentShim({ withChain: true, chain }),
    });
    await handleKcChainMetadataRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(responseBody(ctx)).toEqual({
      kaId: kaId.toString(),
      author: signer.address,
      attested: true,
    });
  });

  it('returns attested:false for un-attested writes (mock __registerKC bridge)', async () => {
    const chain = new MockChainAdapter();
    const kaId = 99n;
    chain.__registerKC({
      kaId,
      contextGraphId: 7n,
      merkleRootHex:
        '0x' + '00'.repeat(32),
      chunks: [{ chunkId: 0n, chunk: 'fixture-chunk' }],
    });

    const author = await chain.getLatestMerkleRootAuthor(kaId);
    expect(author).toBe(ZERO);

    const ctx = createContext({
      kcIdPath: kaId.toString(),
      agent: createAgentShim({ withChain: true, chain }),
    });
    await handleKcChainMetadataRoutes(ctx);

    expect(ctx.res.statusCode).toBe(200);
    expect(responseBody(ctx)).toEqual({
      kaId: kaId.toString(),
      author: null,
      attested: false,
    });
  });

  it('returns 404 when kaId is unknown to the chain', async () => {
    const chain = new MockChainAdapter();
    const ctx = createContext({
      kcIdPath: '999999',
      agent: createAgentShim({ withChain: true, chain }),
    });
    await handleKcChainMetadataRoutes(ctx);
    expect(ctx.res.statusCode).toBe(404);
    expect(responseBody(ctx)).toMatchObject({
      error: expect.stringContaining('Unknown kaId'),
    });
  });

  it('returns 503 when chain adapter does not implement getLatestMerkleRootAuthor', async () => {
    const ctx = createContext({
      kcIdPath: '1',
      agent: createAgentShim({ withChain: false }),
    });
    await handleKcChainMetadataRoutes(ctx);
    expect(ctx.res.statusCode).toBe(503);
    expect(responseBody(ctx)).toMatchObject({
      error: expect.stringContaining('Chain adapter does not expose'),
    });
  });

  it('returns 400 on non-numeric kaId', async () => {
    const chain = new MockChainAdapter();
    const ctx = createContext({
      kcIdPath: 'not-a-number',
      agent: createAgentShim({ withChain: true, chain }),
    });
    await handleKcChainMetadataRoutes(ctx);
    expect(ctx.res.statusCode).toBe(400);
    expect(responseBody(ctx)).toMatchObject({
      error: expect.stringContaining('Invalid kaId'),
    });
  });
});
