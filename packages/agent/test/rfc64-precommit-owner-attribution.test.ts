import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type ContextGraphPolicyV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  acquireFinalizedChainRead,
  finalizedChainReadRegistryDepth,
  type FinalizedChainReadOwnerV1,
} from '@origintrail-official/dkg-chain';
import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import type { Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  RFC64_VM_AUTHOR,
  RFC64_VM_BLOCK_HASH,
  RFC64_VM_CG_STORAGE,
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KAV10,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_NETWORK_ID,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
} from './support/rfc64-finalized-vm-placement-fixture.js';

/**
 * The production RFC64 precommit passes `owner: 'rfc64'` into the shared
 * finalized-read factory. Until now nothing observed that line: the merge-
 * readiness review showed the label could be changed to `foreground` and the
 * focused precommit and runtime suites stayed 10/10 green, because they fail
 * before the real factory or inject mocks.
 *
 * This drives the REAL `createRfc64FinalizedVmAgentPrecommitV1` against an RPC
 * endpoint that accepts the connection and never answers, so the precommit
 * genuinely takes and holds the process-wide permit. While it is held, another
 * owner probes the registry and is told who the holder is — which is both proof
 * that the production path uses the shared registry at all, and the only test
 * that fails if the label changes.
 */
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

/** Accepts, then never responds. The permit stays held until we abort. */
async function hangingRpcEndpoint(): Promise<string> {
  const server = createServer(() => {
    /* deliberately no response */
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function acceptedPolicy(): AcceptedRfc64CatalogAccessSnapshotV1 {
  // Same canonical shape the existing precommit suite uses; a thinner fake is
  // rejected by `snapshotFinalizedVmRuntimeRequest` before the chain is touched.
  const policy = Object.freeze({
    networkId: RFC64_VM_NETWORK_ID,
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    governanceChainId: RFC64_VM_CHAIN_ID,
    governanceContractAddress: RFC64_VM_CG_STORAGE,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: RFC64_VM_CHAIN_ID,
      contractAddress: RFC64_VM_CG_STORAGE,
      blockNumber: '123',
      blockHash: RFC64_VM_BLOCK_HASH,
    },
    effectiveAt: '1700000000000',
    issuedAt: '1700000000000',
  } satisfies ContextGraphPolicyV1);
  return Object.freeze({
    policy,
    policyDigest: RFC64_VM_POLICY_DIGEST,
    // Explicitly null, not omitted: the runtime rejects a non-null roster, and
    // `undefined !== null` fails that guard.
    roster: null,
  }) as unknown as AcceptedRfc64CatalogAccessSnapshotV1;
}

function plan(): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 {
  return Object.freeze({
    catalogScope: Object.freeze({
      networkId: RFC64_VM_NETWORK_ID,
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      governanceChainId: RFC64_VM_CHAIN_ID,
      governanceContractAddress: RFC64_VM_CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: RFC64_VM_AUTHOR,
      era: '0',
      bucketCount: '1',
    }),
    catalogHeadDigest: `0x${'91'.repeat(32)}`,
    inventoryDigest: `0x${'92'.repeat(32)}`,
    rows: Object.freeze([]),
  }) as unknown as Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1;
}

async function options(endpoint: string) {
  return {
    acceptedPolicySnapshotForCatalogScope: () => acceptedPolicy(),
    rpcEndpoints: [endpoint],
    getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    getEvmChainId: async () => BigInt(RFC64_VM_CHAIN_ID),
    getKnowledgeAssetStorageAddress: async () => RFC64_VM_KA_STORAGE,
    getKnowledgeAssetsLifecycleAddress: async () => RFC64_VM_KAV10,
    store: new OxigraphStore(),
  } as const;
}

async function waitForPermit(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('production precommit never took the shared finalized-read permit');
}

describe('RFC-64 production precommit owner attribution', () => {
  it('takes the SHARED permit and holds it as `rfc64`', async () => {
    const endpoint = await hangingRpcEndpoint();
    const handler = createRfc64FinalizedVmAgentPrecommitV1(await options(endpoint));
    const abort = new AbortController();

    // Not awaited: the precommit parks inside the pinned read while we observe.
    const running = handler(plan(), abort.signal).catch(() => undefined);
    await waitForPermit();

    let holder: FinalizedChainReadOwnerV1 | undefined;
    await expect(
      acquireFinalizedChainRead(
        { chainId: RFC64_VM_CHAIN_ID, owner: 'w2-page' },
        async () => 'must-not-run',
        (active, seen) => {
          holder = seen;
          return new Error(`saturated:${active}:${seen}`);
        },
      ),
    ).rejects.toThrow('saturated:1:rfc64');

    // THE assertion the review asked for: the production line, observed.
    expect(holder).toBe('rfc64');

    abort.abort();
    await running;
  }, 40_000);

  it('releases the shared permit when the precommit is aborted', async () => {
    // A production path that leaked the permit would wedge every other caller
    // on that chain for the life of the process.
    const endpoint = await hangingRpcEndpoint();
    const handler = createRfc64FinalizedVmAgentPrecommitV1(await options(endpoint));
    const abort = new AbortController();

    const running = handler(plan(), abort.signal).catch(() => undefined);
    await waitForPermit();
    abort.abort();
    await running;

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID) !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID)).toBe(0);

    // …and the lane is genuinely reusable afterwards.
    await expect(
      acquireFinalizedChainRead(
        { chainId: RFC64_VM_CHAIN_ID, owner: 'w2-page' },
        async () => 'reusable',
        (active) => new Error(`saturated:${active}`),
      ),
    ).resolves.toBe('reusable');
  }, 40_000);
});
