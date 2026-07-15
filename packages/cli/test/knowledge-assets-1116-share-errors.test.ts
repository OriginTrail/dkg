/**
 * #1116 (review C + A1) — route error→HTTP mapping for the seal-by-default
 * share contract, driven over real HTTP against `handleKnowledgeAssetsRoutes`
 * with a MINIMAL fake agent (same proven pattern as
 * `promote-route-not-persisted.test.ts`). The ENGINE outcomes (fail-closed +
 * WM-preserved + subset-not-sealable) are pinned at the agent e2e level
 * (`packages/agent/test/e2e-memory-layers.test.ts`, #1116 block); this pins the
 * ROUTE's catch branches so the HTTP surface can't silently drift:
 *
 *   - swm/share: a default full share whose internal seal fails with a residual
 *     capability gap throws `code:'UNSEALED_SHARE_BLOCKED'` → route 409
 *     `{ code, error, recovery }`. The live-daemon suite explicitly can NOT
 *     reach this (it always has a signing key + V10 chain), so it's covered
 *     here with a fake agent.
 *   - wm/finalize (layer:swm): a subset-shared asset throws
 *     `code:'SWM_SUBSET_NOT_SEALABLE'` → route 409 `{ code, error }`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  generateEd25519Keypair,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MAX_UINT72_DECIMAL,
} from '@origintrail-official/dkg-core';
import {
  AsyncLiftJobConflictError,
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
  resolveLiftWorkspaceSlice,
  storeKnowledgeAssetOperationPublicQuads,
  validateLiftPublishPayload,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { daemonState } from '../src/daemon/state.js';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherRuntimeFromAgent, type AsyncPublisherAvailability } from '../src/publisher-runner.js';
import { createKnowledgeAssetVmPublishHandler } from '../src/daemon/lifecycle.js';

const CG_ID = 'issue-1116-cg';
const ASSERTION_NAME = 'seal-asset';
const UINT72_OVERFLOW_DECIMAL = '4722366482869645213696';
const ROOTLESS_AUTHOR = '0x1111111111111111111111111111111111111111';

async function seedRootlessPublicSnapshot(
  store: TripleStore,
  input: { shareOperationId: string; subject: string; object: string; kaNumber?: bigint },
): Promise<{ shareOperationId: string; kaUal: string; kaNumber: string; publicTripleCount: number }> {
  const kaNumber = input.kaNumber ?? 7n;
  const kaUal = `did:dkg:31337/${ROOTLESS_AUTHOR}/${kaNumber}`;
  const quads = [{
    subject: input.subject,
    predicate: 'http://schema.org/name',
    object: input.object,
    graph: '',
  }];
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager: new GraphManager(store),
    contextGraphId: CG_ID,
    shareOperationId: input.shareOperationId,
    kaUal,
    assertionVersion: '1',
    quads,
    publisherPeerId: 'peer-1',
    accessPolicy: 'public',
  });
  return {
    shareOperationId: input.shareOperationId,
    kaUal,
    kaNumber: kaNumber.toString(),
    publicTripleCount: quads.length,
  };
}

describe('#1116 share/seal route error mapping (fake agent)', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  async function startWith(
    assertion: Record<string, unknown>,
    agentOverrides: Record<string, unknown> = {},
    routeOverrides: { requestToken?: string; requestAgentAddress?: string } = {},
    publisherControl: Record<string, unknown> = {},
    publisherRuntime: unknown = {
      walletIds: ['0x1111111111111111111111111111111111111111'],
      wallets: [{ address: '0x1111111111111111111111111111111111111111' }],
    },
    config: Record<string, unknown> = {},
    publisherAvailability: AsyncPublisherAvailability = { available: true },
  ) {
    const publisherState = publisherAvailability.available
      ? {
          runtime: publisherRuntime,
          availability: publisherAvailability,
        }
      : {
          runtime: null,
          availability: publisherAvailability,
          ...(publisherAvailability.reason === 'publisher_startup_failed'
            ? { error: new Error('test publisher startup failure') }
            : {}),
        };
    const agent = {
      async listContextGraphs() {
        return [{
          id: CG_ID,
          uri: `did:dkg:context-graph:${CG_ID}`,
          name: CG_ID,
          subscribed: true,
          synced: true,
        }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      assertion,
      // Agent-level methods (e.g. publishFromFinalizedAssertion /
      // ensureRegisteredForPublish for the vm/publish path) — opt-in per test.
      ...agentOverrides,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl,
          publisherState,
          config,
          startedAt: Date.now(),
          dashDb: { insertNotification: () => 1 },
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          url,
          path: url.pathname,
          requestToken: routeOverrides.requestToken,
          requestAgentAddress: routeOverrides.requestAgentAddress ?? 'did:dkg:agent:test',
          emitMemoryGraphChanged: () => {},
          emitNotification: () => {},
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unhandled: ${err?.message ?? err}` }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async function post(pathSuffix: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${ASSERTION_NAME}/${pathSuffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  async function postRoot(body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  it('swm/share: UNSEALED_SHARE_BLOCKED → 409 { code, error, recovery }', async () => {
    await startWith({
      promote: async () => {
        throw Object.assign(
          new Error('Cannot seal "seal-asset" for sharing to Shared Memory — the asset would be left unpublishable and Working Memory was NOT emptied. no local signing key'),
          {
            code: 'UNSEALED_SHARE_BLOCKED',
            recovery: 'Resolve the signing capability, then retry.',
          },
        );
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNSEALED_SHARE_BLOCKED');
    expect(String(res.body.error)).toContain('Working Memory was NOT emptied');
    expect(String(res.body.recovery)).toContain('retry');
  });

  it('swm/share: KA_NAMED_GRAPH_SHARE_UNSUPPORTED → 409 { code, error, namedGraphs }', async () => {
    await startWith({
      promote: async () => {
        throw Object.assign(
          new Error('Knowledge Asset contains RDF named-graph quads'),
          {
            code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
            namedGraphs: ['urn:test:graph:one'],
          },
        );
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('KA_NAMED_GRAPH_SHARE_UNSUPPORTED');
    expect(String(res.body.error)).toContain('named-graph');
    expect(res.body.namedGraphs).toEqual(['urn:test:graph:one']);
  });

  it.each([
    {
      label: 'root selection',
      body: { entities: ['urn:test:root'] },
      code: 'KA_ATOMIC_SHARE_REQUIRED',
    },
    {
      label: 'empty root selection',
      body: { entities: [] },
      code: 'KA_ATOMIC_SHARE_REQUIRED',
    },
    {
      label: 'malformed root selection',
      body: { entities: [123] },
      code: 'KA_ATOMIC_SHARE_REQUIRED',
    },
    {
      label: 'null selector',
      body: { entities: null },
      message: 'must be omitted or "all"',
    },
    {
      label: 'unsealed sharing',
      body: { skipSeal: true },
      code: 'UNSEALED_SHARE_UNSUPPORTED',
    },
  ])('swm/share rejects $label before lifecycle mutation', async ({ body, code, message }) => {
    let promoteCalls = 0;
    await startWith({
      promote: async () => {
        promoteCalls += 1;
        return { promotedCount: 1 };
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID, ...body });

    expect(res.status).toBe(400);
    if (code) expect(res.body.code).toBe(code);
    if (message) expect(String(res.body.error)).toContain(message);
    expect(promoteCalls).toBe(0);
  });

  it.each([
    { label: 'omitted selector', body: {} },
    { label: 'legacy all selector', body: { entities: 'all' } },
  ])('swm/share translates $label to the legacy whole-KA selector only at the engine edge', async ({ body }) => {
    const promoteOptions: Array<Record<string, unknown>> = [];
    await startWith({
      promote: async (_contextGraphId: string, _name: string, options: Record<string, unknown>) => {
        promoteOptions.push(options);
        return { promotedCount: 1 };
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID, ...body });

    expect(res.status).toBe(200);
    expect(promoteOptions).toHaveLength(1);
    expect(promoteOptions[0]?.entities).toBe('all');
  });

  it('wm/finalize (layer:swm): forwards layer:"swm" to the engine AND maps SWM_SUBSET_NOT_SEALABLE → 409', async () => {
    // Round 10 (reviewer 🟡): CAPTURE the finalize call args so we prove the route
    // threaded `layer:"swm"` through resolveFinalizeOptions into
    // agent.assertion.finalize — a fake that ignored its args would let a route
    // that dropped `layer` (always finalizing WM) pass this test silently.
    const finalizeCalls: Array<{ contextGraphId: unknown; name: unknown; opts: any }> = [];
    await startWith({
      finalize: async (contextGraphId: unknown, name: unknown, opts: any) => {
        finalizeCalls.push({ contextGraphId, name, opts });
        throw Object.assign(
          new Error('Cannot seal-in-SWM: this asset was not fully shared to SWM — subset shares are not publishable. Share the full asset (entities:"all") first, then finalize(layer:"swm").'),
          { code: 'SWM_SUBSET_NOT_SEALABLE' },
        );
      },
    });

    const res = await post('wm/finalize', { contextGraphId: CG_ID, layer: 'swm' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SWM_SUBSET_NOT_SEALABLE');
    expect(String(res.body.error)).toContain('subset shares are not publishable');

    // The route actually forwarded layer:"swm" (not dropped, not defaulted to WM).
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]?.opts?.layer).toBe('swm');
    expect(finalizeCalls[0]?.contextGraphId).toBe(CG_ID);
  });

  it('wm/finalize: uses the token-canonical storage lane and author when body author differs only by case', async () => {
    const token = 'agent-token-finalize-case';
    const tokenAgentAddress = `0x${'cd'.repeat(20)}`;
    const mixedCaseAuthor = `0x${'CD'.repeat(20)}`;
    const finalizeCalls: Array<{ contextGraphId: unknown; name: unknown; opts: any }> = [];

    await startWith(
      {
        finalize: async (contextGraphId: unknown, name: unknown, opts: any) => {
          finalizeCalls.push({ contextGraphId, name, opts });
          return {
            assertionUri: 'did:dkg:assertion:case-finalize',
            merkleRoot: new Uint8Array(32),
            authorAddress: tokenAgentAddress,
            schemeVersion: 1,
            chainId: 1n,
            kav10Address: `0x${'ef'.repeat(20)}`,
            eip712Digest: `0x${'12'.repeat(32)}`,
          };
        },
      },
      {
        resolveAgentByToken: (t?: string) => (t === token ? tokenAgentAddress : undefined),
      },
      { requestToken: token, requestAgentAddress: tokenAgentAddress },
    );

    const res = await post('wm/finalize', {
      contextGraphId: CG_ID,
      authorAgentAddress: mixedCaseAuthor,
    });

    expect(res.status).toBe(200);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.opts?.agentAddress).toBe(tokenAgentAddress);
    expect(finalizeCalls[0]?.opts?.authorAgentAddress).toBe(tokenAgentAddress);
  });

  it('wm/finalize: node/admin author signer does not change the storage lane', async () => {
    const authorAgentAddress = `0x${'ab'.repeat(20)}`;
    const finalizeCalls: Array<{ contextGraphId: unknown; name: unknown; opts: any }> = [];

    await startWith({
      finalize: async (contextGraphId: unknown, name: unknown, opts: any) => {
        finalizeCalls.push({ contextGraphId, name, opts });
        return {
          assertionUri: 'did:dkg:assertion:admin-author-finalize',
          merkleRoot: new Uint8Array(32),
          authorAddress: authorAgentAddress,
          schemeVersion: 1,
          chainId: 1n,
          kav10Address: `0x${'ef'.repeat(20)}`,
          eip712Digest: `0x${'12'.repeat(32)}`,
        };
      },
    });

    const res = await post('wm/finalize', {
      contextGraphId: CG_ID,
      authorAgentAddress,
    });

    expect(res.status).toBe(200);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.opts?.agentAddress).toBeUndefined();
    expect(finalizeCalls[0]?.opts?.authorAgentAddress).toBe(authorAgentAddress);
  });

  it('wm/finalize: node/admin pre-signed author does not change the storage lane', async () => {
    const preSignedAuthor = `0x${'ab'.repeat(20)}`;
    const finalizeCalls: Array<{ contextGraphId: unknown; name: unknown; opts: any }> = [];

    await startWith({
      finalize: async (contextGraphId: unknown, name: unknown, opts: any) => {
        finalizeCalls.push({ contextGraphId, name, opts });
        return {
          assertionUri: 'did:dkg:assertion:presigned-finalize',
          merkleRoot: new Uint8Array(32),
          authorAddress: preSignedAuthor,
          schemeVersion: 1,
          chainId: 1n,
          kav10Address: `0x${'ef'.repeat(20)}`,
          eip712Digest: `0x${'12'.repeat(32)}`,
        };
      },
    });

    const res = await post('wm/finalize', {
      contextGraphId: CG_ID,
      preSignedAuthorAttestation: {
        address: preSignedAuthor,
        reservedKaId: '1',
        signature: {
          r: `0x${'01'.repeat(32)}`,
          vs: `0x${'02'.repeat(32)}`,
        },
      },
    });

    expect(res.status).toBe(200);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]?.opts?.agentAddress).toBeUndefined();
    expect(finalizeCalls[0]?.opts?.preSignedAuthorAttestation?.address).toBe(preSignedAuthor);
  });

  it('swm/share: an unrelated promote error still propagates (not silently 409ed)', async () => {
    // Guard: the new 409 branch must only catch UNSEALED_SHARE_BLOCKED. Any
    // other error rethrows to the outer handler (→ 500 here).
    await startWith({
      promote: async () => {
        throw new Error('some unrelated engine failure');
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('vm/publish-async preflights the immutable share snapshot before enqueue', async () => {
    let enqueueCalls = 0;
    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => ({
        contextGraphId: CG_ID,
        name: ASSERTION_NAME,
        shareOperationId: 'missing-share-op',
        roots: ['urn:test:root'],
        seal: {
          merkleRoot: `0x${'12'.repeat(32)}`,
          authorAddress: '0x1111111111111111111111111111111111111111',
          signature: {
            r: `0x${'34'.repeat(32)}`,
            vs: `0x${'56'.repeat(32)}`,
          },
          schemeVersion: 1,
        },
        sealChainId: '31337',
        sealKav10Address: '0x2222222222222222222222222222222222222222',
        sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
        sealMerkleRoot: `0x${'12'.repeat(32)}`,
        intentKey: `sha256:${'ab'.repeat(32)}`,
      }),
      preflightKnowledgeAssetVmPublishSnapshot: async () => {
        throw Object.assign(
          new Error('share snapshot missing; re-share before enqueue'),
          { code: 'PUBLISH_INTENT_STALE' },
        );
      },
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => {
        enqueueCalls += 1;
        return 'job-should-not-exist';
      },
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PUBLISH_INTENT_STALE');
    expect(String(res.body.error)).toContain('re-share');
    expect(enqueueCalls).toBe(0);
  });

  it('vm/publish-async returns the complete private graph content envelope', async () => {
    const privateMerkleRoot = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const intent = {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      shareOperationId: 'private-share-op',
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: `did:dkg:31337/${ROOTLESS_AUTHOR}/7`,
      assertionVersion: '3',
      publicTripleCount: 1,
      privateMerkleRoot,
      privateTripleCount: 2,
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}`,
        authorAddress: ROOTLESS_AUTHOR,
        signature: {
          r: `0x${'34'.repeat(32)}`,
          vs: `0x${'56'.repeat(32)}`,
        },
        schemeVersion: 1,
      },
      sealChainId: '31337',
      sealKav10Address: '0x2222222222222222222222222222222222222222',
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}`,
      intentKey: `sha256:${'cd'.repeat(32)}`,
    };
    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => intent,
      preflightKnowledgeAssetVmPublishSnapshot: async () => {},
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => 'private-job',
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      jobId: 'private-job',
      status: 'accepted',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: intent.kaUal,
      assertionVersion: '3',
      publicTripleCount: 1,
      privateMerkleRoot,
      privateTripleCount: 2,
      rootsCount: 0,
    });
  });

  it('vm/publish-async rejects before persisting when no runtime can claim jobs', async () => {
    let resolved = 0;
    let enqueued = 0;
    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => { resolved += 1; },
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => { enqueued += 1; },
    }, null, {}, {
      available: false,
      reason: 'publisher_disabled',
      retryable: false,
      operatorActionRequired: true,
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'async_publisher_unavailable',
      reason: 'publisher_disabled',
      retryable: false,
      operatorActionRequired: true,
    });
    expect(resolved).toBe(0);
    expect(enqueued).toBe(0);
  });

  it('vm/publish-async treats an empty-wallet runtime as operator-actionable', async () => {
    let enqueued = 0;
    await startWith({}, {}, {}, {
      enqueueKnowledgeAssetVmPublish: async () => { enqueued += 1; },
    }, { walletIds: [], wallets: [] }, { publisher: { enabled: true } }, {
      available: false,
      reason: 'no_publisher_wallets',
      retryable: false,
      operatorActionRequired: true,
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'async_publisher_unavailable',
      reason: 'no_publisher_wallets',
      retryable: false,
      operatorActionRequired: true,
    });
    expect(enqueued).toBe(0);
  });

  it('vm/publish-async uses lifecycle no-wallet state when the runtime is null', async () => {
    let enqueued = 0;
    await startWith({}, {}, {}, {
      enqueueKnowledgeAssetVmPublish: async () => { enqueued += 1; },
    }, null, { publisher: { enabled: true } }, {
      available: false,
      reason: 'no_publisher_wallets',
      retryable: false,
      operatorActionRequired: true,
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      reason: 'no_publisher_wallets', retryable: false, operatorActionRequired: true,
    });
    expect(enqueued).toBe(0);
  });

  it.each([
    {
      reason: 'publisher_starting' as const,
      retryable: true,
      operatorActionRequired: false,
    },
    {
      reason: 'publisher_startup_failed' as const,
      retryable: false,
      operatorActionRequired: true,
    },
  ])('vm/publish-async honors lifecycle $reason before intent resolution', async (availability) => {
    let resolved = 0;
    let enqueued = 0;
    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => { resolved += 1; },
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => { enqueued += 1; },
    }, null, { publisher: { enabled: true } }, {
      available: false,
      ...availability,
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'async_publisher_unavailable',
      ...availability,
    });
    expect(resolved).toBe(0);
    expect(enqueued).toBe(0);
  });

  it('vm/publish-async reports lifecycle startup failure as operator-actionable', async () => {
    await startWith({}, {}, {}, {}, null, { publisher: { enabled: true } }, {
      available: false,
      reason: 'publisher_startup_failed',
      retryable: false,
      operatorActionRequired: true,
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      reason: 'publisher_startup_failed', retryable: false, operatorActionRequired: true,
    });
  });

  it('vm/publish-async rejects a missing real share snapshot before enqueue', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    let enqueueCalls = 0;
    const intent = {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      shareOperationId: 'missing-real-share-op',
      roots: ['urn:test:missing-root'],
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
        authorAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        signature: {
          r: `0x${'34'.repeat(32)}` as `0x${string}`,
          vs: `0x${'56'.repeat(32)}` as `0x${string}`,
        },
        schemeVersion: 1,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
      intentKey: `sha256:${'ef'.repeat(32)}`,
    };

    try {
      await startWith({}, {
        resolveFinalizedAssertionVmPublishIntent: async () => intent,
        preflightKnowledgeAssetVmPublishSnapshot: async (request: unknown) => {
          const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request as any);
          const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request as any);
          try {
            const resolved = await resolveLiftWorkspaceSlice({
              store,
              graphManager: new GraphManager(store),
              request: snapshot,
            });
            validateLiftPublishPayload({ request: snapshot, metadata: snapshotMetadata, resolved });
          } catch (err) {
            throw Object.assign(
              new Error(
                `Cannot enqueue VM publish for "${ASSERTION_NAME}" because share snapshot ` +
                  `missing-real-share-op is unavailable or stale. Re-share the knowledge asset before enqueueing: ` +
                  (err instanceof Error ? err.message : String(err)),
              ),
              { code: 'PUBLISH_INTENT_STALE' },
            );
          }
        },
      }, {}, {
        enqueueKnowledgeAssetVmPublish: async () => {
          enqueueCalls += 1;
          return 'job-should-not-exist';
        },
      });

      const res = await post('vm/publish-async', { contextGraphId: CG_ID });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLISH_INTENT_STALE');
      expect(String(res.body.error)).toContain('Re-share');
      expect(enqueueCalls).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('vm/publish-async accepts uint72 publisher identity overrides into the immutable intent', async () => {
    const seenResolveOptions: any[] = [];
    const enqueuedIntents: any[] = [];

    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async (_contextGraphId: string, _name: string, opts: any) => {
        seenResolveOptions.push(opts);
        return {
          contextGraphId: CG_ID,
          name: ASSERTION_NAME,
          shareOperationId: 'share-with-options',
          roots: ['urn:test:options-root'],
          seal: {
            merkleRoot: `0x${'12'.repeat(32)}`,
            authorAddress: '0x1111111111111111111111111111111111111111',
            signature: {
              r: `0x${'34'.repeat(32)}`,
              vs: `0x${'56'.repeat(32)}`,
            },
            schemeVersion: 1,
          },
          sealChainId: '31337',
          sealKav10Address: '0x2222222222222222222222222222222222222222',
          sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
          sealMerkleRoot: `0x${'12'.repeat(32)}`,
          intentKey: `sha256:${'bc'.repeat(32)}`,
          publishEpochs: opts.publishEpochs,
          clearSharedMemoryAfter: opts.clearSharedMemoryAfter,
          publisherNodeIdentityIdOverride: opts.publisherNodeIdentityIdOverride?.toString(),
        };
      },
      preflightKnowledgeAssetVmPublishSnapshot: async () => {},
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async (intent: unknown) => {
        enqueuedIntents.push(intent);
        return 'job-options';
      },
    });

    const zeroRes = await post('vm/publish-async', {
      contextGraphId: CG_ID,
      options: {
        publishEpochs: 2,
        clearSharedMemoryAfter: true,
        publisherNodeIdentityIdOverride: '0',
      },
    });

    expect(zeroRes.status).toBe(202);
    expect(zeroRes.body.jobId).toBe('job-options');
    expect(seenResolveOptions).toHaveLength(1);
    expect(seenResolveOptions[0]).toMatchObject({
      publishEpochs: 2,
      clearSharedMemoryAfter: true,
      publisherNodeIdentityIdOverride: 0n,
    });
    expect(enqueuedIntents[0]).toMatchObject({
      publishEpochs: 2,
      clearSharedMemoryAfter: true,
      publisherNodeIdentityIdOverride: '0',
    });

    const maxRes = await post('vm/publish-async', {
      contextGraphId: CG_ID,
      options: {
        publishEpochs: 2,
        clearSharedMemoryAfter: true,
        publisherNodeIdentityIdOverride: MAX_UINT72_DECIMAL,
      },
    });

    expect(maxRes.status).toBe(202);
    expect(maxRes.body.jobId).toBe('job-options');
    expect(seenResolveOptions).toHaveLength(2);
    expect(seenResolveOptions[1]).toMatchObject({
      publishEpochs: 2,
      clearSharedMemoryAfter: true,
      publisherNodeIdentityIdOverride: BigInt(MAX_UINT72_DECIMAL),
    });
    expect(enqueuedIntents[1]).toMatchObject({
      publishEpochs: 2,
      clearSharedMemoryAfter: true,
      publisherNodeIdentityIdOverride: MAX_UINT72_DECIMAL,
    });
  });

  it('vm/publish-async rejects publisher identity overrides above uint72 before enqueue', async () => {
    let resolveCalls = 0;
    let enqueueCalls = 0;

    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => {
        resolveCalls += 1;
        throw new Error('resolve should not be called');
      },
      preflightKnowledgeAssetVmPublishSnapshot: async () => {
        throw new Error('preflight should not be called');
      },
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => {
        enqueueCalls += 1;
        return 'job-should-not-exist';
      },
    });

    const res = await post('vm/publish-async', {
      contextGraphId: CG_ID,
      options: {
        publisherNodeIdentityIdOverride: UINT72_OVERFLOW_DECIMAL,
      },
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('publisherNodeIdentityIdOverride');
    expect(String(res.body.error)).toContain('uint72');
    expect(resolveCalls).toBe(0);
    expect(enqueueCalls).toBe(0);
  });

  it('vm/publish-async maps incompatible duplicate jobs to 409 with existingJobId', async () => {
    const intent = {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      shareOperationId: 'share-conflict',
      roots: ['urn:test:conflict-root'],
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
        authorAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        signature: {
          r: `0x${'34'.repeat(32)}` as `0x${string}`,
          vs: `0x${'56'.repeat(32)}` as `0x${string}`,
        },
        schemeVersion: 1,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
      intentKey: `sha256:${'cf'.repeat(32)}`,
    };

    await startWith({}, {
      resolveFinalizedAssertionVmPublishIntent: async () => intent,
      preflightKnowledgeAssetVmPublishSnapshot: async () => {},
    }, {}, {
      enqueueKnowledgeAssetVmPublish: async () => {
        throw new AsyncLiftJobConflictError('conflict', 'job-existing');
      },
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'conflict',
      existingJobId: 'job-existing',
    });
  });

  it('vm/publish-async binds the queued intent to the bearer-token agent namespace', async () => {
    const token = 'alice-token';
    const tokenAgentAddress = '0x00000000000000000000000000000000000000a2';
    const seenResolveOptions: any[] = [];
    const enqueuedIntents: any[] = [];

    await startWith({}, {
      resolveAgentByToken: (t?: string) => (t === token ? tokenAgentAddress : undefined),
      resolveFinalizedAssertionVmPublishIntent: async (_contextGraphId: string, _name: string, opts: any) => {
        seenResolveOptions.push(opts);
        return {
          contextGraphId: CG_ID,
          name: ASSERTION_NAME,
          agentAddress: opts.agentAddress,
          shareOperationId: 'share-token-agent',
          roots: ['urn:test:token-agent-root'],
          seal: {
            merkleRoot: `0x${'12'.repeat(32)}`,
            authorAddress: tokenAgentAddress,
            signature: {
              r: `0x${'34'.repeat(32)}`,
              vs: `0x${'56'.repeat(32)}`,
            },
            schemeVersion: 1,
          },
          sealChainId: '31337',
          sealKav10Address: '0x2222222222222222222222222222222222222222',
          sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
          sealMerkleRoot: `0x${'12'.repeat(32)}`,
          intentKey: `sha256:${'ca'.repeat(32)}`,
        };
      },
      preflightKnowledgeAssetVmPublishSnapshot: async (intent: unknown) => {
        expect(intent).toMatchObject({ agentAddress: tokenAgentAddress });
      },
    }, { requestToken: token, requestAgentAddress: tokenAgentAddress }, {
      enqueueKnowledgeAssetVmPublish: async (intent: unknown) => {
        enqueuedIntents.push(intent);
        return 'job-token-agent';
      },
    });

    const res = await post('vm/publish-async', { contextGraphId: CG_ID });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('job-token-agent');
    expect(seenResolveOptions).toHaveLength(1);
    expect(seenResolveOptions[0]).toMatchObject({ agentAddress: tokenAgentAddress });
    expect(enqueuedIntents[0]).toMatchObject({ agentAddress: tokenAgentAddress });
  });

  it('rejects the retired create promote flag before mutation', async () => {
    for (const promote of [true, false]) {
      let mutations = 0;
      await startWith({
        create: async () => { mutations += 1; },
        write: async () => { mutations += 1; },
        finalize: async () => { mutations += 1; },
        promote: async () => { mutations += 1; },
      });

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: `legacy-promote-${promote}`,
        quads: [{ subject: 'urn:test:legacy', predicate: 'http://schema.org/name', object: '"Legacy"' }],
        finalize: true,
        promote,
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('promote');
      expect(mutations).toBe(0);

      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  it('vm/publish-async enqueue is processable by createPublisherRuntimeFromAgent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-ka-vm-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    await addPublisherWallet(dataDir, wallet.privateKey);

    const rootless = await seedRootlessPublicSnapshot(store, {
      shareOperationId: 'share-runtime-rootless',
      subject: 'urn:test:runtime-subject',
      object: '"Runtime Rootless"',
    });

    const intent = {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      shareOperationId: rootless.shareOperationId,
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: rootless.kaUal,
      assertionVersion: '1',
      publicTripleCount: rootless.publicTripleCount,
      privateTripleCount: 0,
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
        authorAddress: ROOTLESS_AUTHOR as `0x${string}`,
        signature: {
          r: `0x${'34'.repeat(32)}` as `0x${string}`,
          vs: `0x${'56'.repeat(32)}` as `0x${string}`,
        },
        schemeVersion: 1,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
      intentKey: `sha256:${'cd'.repeat(32)}`,
      kaNumber: rootless.kaNumber,
      reservedUal: rootless.kaUal,
    };
    const executorCalls: any[] = [];
    const preflighted: any[] = [];
    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          executorCalls.push(input);
          return {
            status: 'tentative',
            ual: 'did:dkg:local/runtime-route',
            merkleRoot: ethers.getBytes(input.request.sealMerkleRoot),
            kaManifest: [],
          } as any;
        },
      },
    });

    try {
      await startWith({}, {
        resolveFinalizedAssertionVmPublishIntent: async () => intent,
        preflightKnowledgeAssetVmPublishSnapshot: async (request: unknown) => {
          preflighted.push(request);
        },
      }, {}, runtime.publisher as any);

      const res = await post('vm/publish-async', { contextGraphId: CG_ID });
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('accepted');
      expect(res.body.shareOperationId).toBe(rootless.shareOperationId);
      expect(preflighted).toEqual([intent]);

      const processed = await runtime.publisher.processNext(wallet.address);
      expect(processed?.jobId).toBe(res.body.jobId);
      expect(processed?.status).toBe('finalized');
      expect(executorCalls).toHaveLength(1);
      expect(executorCalls[0].request).toMatchObject({
        contextGraphId: CG_ID,
        name: ASSERTION_NAME,
        shareOperationId: rootless.shareOperationId,
        roots: [],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: rootless.kaUal,
      });
      expect(typeof executorCalls[0].publisher.publish).toBe('function');
    } finally {
      await runtime.stop();
      await store.close();
    }
  });

  it('queued vm/publish-async execution auto-registers once and retries the same job', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-ka-vm-runtime-register-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    await addPublisherWallet(dataDir, wallet.privateKey);

    const rootless = await seedRootlessPublicSnapshot(store, {
      shareOperationId: 'share-auto-register-rootless',
      subject: 'urn:test:auto-register-subject',
      object: '"Auto Register Rootless"',
    });

    const intent = {
      contextGraphId: CG_ID,
      name: ASSERTION_NAME,
      agentAddress: '0x00000000000000000000000000000000000000b2',
      shareOperationId: rootless.shareOperationId,
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: rootless.kaUal,
      assertionVersion: '1',
      publicTripleCount: rootless.publicTripleCount,
      privateTripleCount: 0,
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
        authorAddress: ROOTLESS_AUTHOR as `0x${string}`,
        signature: {
          r: `0x${'34'.repeat(32)}` as `0x${string}`,
          vs: `0x${'56'.repeat(32)}` as `0x${string}`,
        },
        schemeVersion: 1,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
      intentKey: `sha256:${'ef'.repeat(32)}`,
      kaNumber: rootless.kaNumber,
      reservedUal: rootless.kaUal,
    };
    const calls: string[] = [];
    const publisherOverrides: unknown[] = [];
    let publishAttempts = 0;
    const fakeAgent = {
      getDefaultAgentAddress: () => '0x00000000000000000000000000000000000000a1',
      async ensureRegisteredForPublish(_cg: string, opts: Record<string, unknown>) {
        calls.push(`register:${opts.callerAgentAddress}`);
      },
      async publishQueuedKnowledgeAssetVmPublish(request: typeof intent, _publishOptions: unknown, opts: Record<string, unknown>) {
        publishAttempts += 1;
        calls.push(`publish#${publishAttempts}`);
        expect(request.agentAddress).toBe('0x00000000000000000000000000000000000000b2');
        expect(opts.publisherOverride).toBeDefined();
        publisherOverrides.push(opts.publisherOverride);
        if (publishAttempts === 1) {
          throw Object.assign(
            new Error(`Context graph "${request.contextGraphId}" is not registered on-chain.`),
            { code: 'CG_NOT_REGISTERED' },
          );
        }
        return {
          status: 'confirmed' as const,
          kaId: 42n,
          ual: 'did:dkg:test/1/42',
          merkleRoot: ethers.getBytes(request.sealMerkleRoot),
          kaManifest: [],
          onChainResult: {
            batchId: 42n,
            startKAId: 42n,
            endKAId: 42n,
            txHash: `0x${'ab'.repeat(32)}`,
            blockNumber: 7,
            blockTimestamp: 1700000007,
            publisherAddress: wallet.address,
          },
        };
      },
    };

    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
      knowledgeAssetVmPublishHandler: {
        execute: createKnowledgeAssetVmPublishHandler(fakeAgent as unknown as DKGAgent).execute,
      },
    });

    try {
      const jobId = await runtime.publisher.enqueueKnowledgeAssetVmPublish(intent);
      const processed = await runtime.publisher.processNext(wallet.address);

      expect(processed?.jobId).toBe(jobId);
      expect(processed?.status).toBe('finalized');
      expect(calls).toEqual([
        'publish#1',
        'register:0x00000000000000000000000000000000000000b2',
        'publish#2',
      ]);
      expect(publishAttempts).toBe(2);
      expect(publisherOverrides).toHaveLength(2);
      expect(publisherOverrides[0]).toBe(publisherOverrides[1]);
      expect(typeof (publisherOverrides[0] as { publish?: unknown }).publish).toBe('function');
      expect(String((publisherOverrides[0] as { publisherAddress?: string }).publisherAddress).toLowerCase()).toBe(
        wallet.address.toLowerCase(),
      );
    } finally {
      await runtime.stop();
      await store.close();
    }
  });

  it.each([
    ['UNSEALED_PULL_FROM_BLOCKED', 'Cannot pull an unsealed Knowledge Asset into WM'],
    ['PULL_FROM_EMPTY_SOURCE', 'Cannot pull from an empty source layer'],
    ['LEGACY_KA_READ_ONLY', 'Legacy Knowledge Assets are read-only'],
  ])('wm/pull-from: %s → 409 { code, error }', async (code, message) => {
    await startWith({
      pullFrom: async () => {
        throw Object.assign(new Error(message), { code });
      },
    });

    const res = await post('wm/pull-from', { contextGraphId: CG_ID, layer: 'swm' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toBe(message);
  });

  it('wm/pull-from: an unrelated pull error still propagates (not silently 409ed)', async () => {
    // Guard: only the explicit lifecycle conflict codes map to 409. Any other
    // error rethrows to the outer handler (→ 500).
    await startWith({
      pullFrom: async () => {
        throw new Error('some unrelated pull failure');
      },
    });

    const res = await post('wm/pull-from', { contextGraphId: CG_ID, layer: 'swm' });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  // #1116 (round 5, FIX 5): the async swm/share queue ALWAYS seals (the safe
  // default) and can't carry skipSeal through the job — it used to silently drop
  // it. The route now rejects a non-boolean skipSeal (parity with the sync route)
  // and a truthy boolean outright (rather than honoring it differently).
  describe('swm/share-async skipSeal validation', () => {
    afterEach(() => {
      daemonState.promoteWorkerAvailable = false;
    });

    it.each([
      {
        label: 'a non-boolean skipSeal',
        body: { skipSeal: 'false' },
        message: 'skipSeal',
      },
      {
        label: 'skipSeal:true',
        body: { skipSeal: true },
        message: 'not supported',
      },
      {
        label: 'root selection',
        body: { entities: ['urn:test:root'] },
        message: 'atomically',
        code: 'KA_ATOMIC_SHARE_REQUIRED',
      },
      {
        label: 'empty root selection',
        body: { entities: [] },
        message: 'atomically',
        code: 'KA_ATOMIC_SHARE_REQUIRED',
      },
      {
        label: 'malformed root selection',
        body: { entities: [123] },
        message: 'atomically',
        code: 'KA_ATOMIC_SHARE_REQUIRED',
      },
      {
        label: 'null selector',
        body: { entities: null },
        message: 'must be omitted or "all"',
      },
    ])('rejects $label before enqueue', async ({ body, message, code }) => {
      daemonState.promoteWorkerAvailable = true;
      let promoteAsyncCalls = 0;
      await startWith({
        promoteAsync: async () => {
          promoteAsyncCalls += 1;
          return { jobId: 'should-not-reach' };
        },
      });
      const res = await post('swm/share-async', { contextGraphId: CG_ID, ...body });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain(message);
      if (code) expect(res.body.code).toBe(code);
      expect(promoteAsyncCalls).toBe(0);
    });

    it('accepts skipSeal:false (the seal-always default) and enqueues', async () => {
      daemonState.promoteWorkerAvailable = true;
      let promoteAsyncCalls = 0;
      await startWith({
        promoteAsync: async () => {
          promoteAsyncCalls += 1;
          return { jobId: 'job-123' };
        },
      });
      const res = await post('swm/share-async', { contextGraphId: CG_ID, skipSeal: false });
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('job-123');
      expect(promoteAsyncCalls).toBe(1);
    });
  });

  // #1116 follow-up (reviewer 🟡 #2): the /vm/publish auto-register branch must
  // complete the register-then-RETRY sequence — publishFromFinalizedAssertion
  // throws CG_NOT_REGISTERED, the route registers ONCE, then RE-CALLS
  // publishFromFinalizedAssertion and returns THAT result. The live-daemon test
  // can only assert "5xx + not 'not registered'", which a regression that
  // registers then fails-before-retry would still pass. This pins the exact
  // call order with a fake agent.
  describe('vm/publish auto-register retry sequence', () => {
    it('atomic create+alsoPublishVm forces the token-scoped storage lane over caller publish options', async () => {
      const token = 'agent-token-atomic';
      const tokenAgentAddress = `0x${'cd'.repeat(20)}`;
      const attackerAgentAddress = `0x${'aa'.repeat(20)}`;
      const seenOpts: unknown[] = [];

      await startWith(
        {
          create: async () => 'did:dkg:assertion:atomic-agent-publish',
          write: async () => undefined,
          finalize: async () => ({
            assertionUri: 'did:dkg:assertion:atomic-agent-publish',
            merkleRoot: new Uint8Array(32),
            authorAddress: tokenAgentAddress,
            schemeVersion: 1,
            chainId: 1n,
            kav10Address: `0x${'ef'.repeat(20)}`,
            eip712Digest: `0x${'12'.repeat(32)}`,
          }),
        },
        {
          resolveAgentByToken: (t?: string) => (t === token ? tokenAgentAddress : undefined),
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            seenOpts.push(opts);
            return {
              status: 'confirmed',
              ual: 'did:dkg:test/1/44',
              kaId: '44',
              seal: { authorAddress: tokenAgentAddress },
            };
          },
        },
        { requestToken: token, requestAgentAddress: tokenAgentAddress },
      );

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-agent-publish',
        quads: [{
          subject: 'did:dkg:test:AtomicAgentPublish',
          predicate: 'http://schema.org/name',
          object: '"Atomic"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          agentAddress: attackerAgentAddress,
          clearAfter: false,
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('vm-confirmed');
      expect(seenOpts).toHaveLength(1);
      expect(seenOpts[0]).toMatchObject({
        agentAddress: tokenAgentAddress,
        clearSharedMemoryAfter: false,
      });
    });

    it('atomic create+alsoPublishVm strips caller storage-lane overrides on default-lane requests', async () => {
      const attackerAgentAddress = `0x${'aa'.repeat(20)}`;
      const seenOpts: Record<string, unknown>[] = [];

      await startWith(
        {
          create: async () => 'did:dkg:assertion:atomic-default-publish',
          write: async () => undefined,
          finalize: async () => ({
            assertionUri: 'did:dkg:assertion:atomic-default-publish',
            merkleRoot: new Uint8Array(32),
            authorAddress: `0x${'ef'.repeat(20)}`,
            schemeVersion: 1,
            chainId: 1n,
            kav10Address: `0x${'ef'.repeat(20)}`,
            eip712Digest: `0x${'34'.repeat(32)}`,
          }),
        },
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: Record<string, unknown>) {
            seenOpts.push(opts);
            return {
              status: 'confirmed',
              ual: 'did:dkg:test/1/45',
              kaId: '45',
              seal: { authorAddress: `0x${'ef'.repeat(20)}` },
            };
          },
        },
      );

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-default-publish',
        subGraphName: 'real-subgraph',
        quads: [{
          subject: 'did:dkg:test:AtomicDefaultPublish',
          predicate: 'http://schema.org/name',
          object: '"Atomic default"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          agentAddress: attackerAgentAddress,
          subGraphName: 'evil-subgraph',
          epochs: '2',
          clearAfter: false,
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('vm-confirmed');
      expect(seenOpts).toHaveLength(1);
      expect(seenOpts[0]).toMatchObject({
        subGraphName: 'real-subgraph',
        publishEpochs: 2,
        clearSharedMemoryAfter: false,
      });
      expect(Object.prototype.hasOwnProperty.call(seenOpts[0], 'agentAddress')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(seenOpts[0], 'authorAgentAddress')).toBe(false);
    });

    it('atomic create+alsoPublishVm rejects forbidden finalized-publish shape before mutation', async () => {
      const createCalls: unknown[] = [];

      await startWith({
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return 'did:dkg:assertion:should-not-create';
        },
        write: async () => undefined,
        finalize: async () => {
          throw new Error('finalize should not be called');
        },
      });

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-invalid-publish-shape',
        quads: [{
          subject: 'did:dkg:test:InvalidPublishShape',
          predicate: 'http://schema.org/name',
          object: '"Invalid shape"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          authorAgentAddress: `0x${'aa'.repeat(20)}`,
          selection: { rootEntities: ['urn:only-this'] },
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('authorAgentAddress');
      expect(createCalls).toHaveLength(0);
    });

    it('atomic create+alsoPublishVm rejects partial selection before mutation', async () => {
      const createCalls: unknown[] = [];

      await startWith({
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return 'did:dkg:assertion:should-not-create';
        },
        write: async () => undefined,
        finalize: async () => {
          throw new Error('finalize should not be called');
        },
      });

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-invalid-publish-selection',
        quads: [{
          subject: 'did:dkg:test:InvalidPublishSelection',
          predicate: 'http://schema.org/name',
          object: '"Invalid selection"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          selection: { rootEntities: ['urn:only-this'] },
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('selection');
      expect(createCalls).toHaveLength(0);
    });

    it('atomic create+alsoPublishVm rejects assertionName before mutation', async () => {
      const createCalls: unknown[] = [];

      await startWith({
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return 'did:dkg:assertion:should-not-create';
        },
        write: async () => undefined,
        finalize: async () => {
          throw new Error('finalize should not be called');
        },
      });

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-invalid-publish-assertion-name',
        quads: [{
          subject: 'did:dkg:test:InvalidPublishAssertionName',
          predicate: 'http://schema.org/name',
          object: '"Invalid assertionName"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          assertionName: 'other-assertion',
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('assertionName');
      expect(createCalls).toHaveLength(0);
    });

    it('atomic create+alsoPublishVm rejects malformed publish controls before mutation', async () => {
      const createCalls: unknown[] = [];

      await startWith({
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return 'did:dkg:assertion:should-not-create';
        },
        write: async () => undefined,
        finalize: async () => {
          throw new Error('finalize should not be called');
        },
      });

      const res = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-invalid-publish-controls',
        quads: [{
          subject: 'did:dkg:test:InvalidPublishControls',
          predicate: 'http://schema.org/name',
          object: '"Invalid controls"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          publishEpochs: [2],
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('publishEpochs');
      expect(createCalls).toHaveLength(0);

      const identityRes = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-invalid-publish-identity',
        quads: [{
          subject: 'did:dkg:test:InvalidPublishIdentity',
          predicate: 'http://schema.org/name',
          object: '"Invalid identity"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          publisherNodeIdentityIdOverride: [0],
        },
      });

      expect(identityRes.status).toBe(400);
      expect(String(identityRes.body.error)).toContain('publisherNodeIdentityIdOverride');
      expect(createCalls).toHaveLength(0);

      const unsafeNumericIdentityRes = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-unsafe-numeric-publish-identity',
        quads: [{
          subject: 'did:dkg:test:UnsafeNumericPublishIdentity',
          predicate: 'http://schema.org/name',
          object: '"Unsafe numeric identity"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1,
        },
      });

      expect(unsafeNumericIdentityRes.status).toBe(400);
      expect(String(unsafeNumericIdentityRes.body.error)).toContain('publisherNodeIdentityIdOverride');
      expect(String(unsafeNumericIdentityRes.body.error)).toContain('safe integer');
      expect(createCalls).toHaveLength(0);

      const unsafeIdentityRes = await postRoot({
        contextGraphId: CG_ID,
        name: 'atomic-unsafe-publish-identity',
        quads: [{
          subject: 'did:dkg:test:UnsafePublishIdentity',
          predicate: 'http://schema.org/name',
          object: '"Unsafe identity"',
          graph: '',
        }],
        finalize: true,
        alsoPublishVm: {
          publisherNodeIdentityIdOverride: UINT72_OVERFLOW_DECIMAL,
        },
      });

      expect(unsafeIdentityRes.status).toBe(400);
      expect(String(unsafeIdentityRes.body.error)).toContain('publisherNodeIdentityIdOverride');
      expect(String(unsafeIdentityRes.body.error)).toContain('uint72');
      expect(createCalls).toHaveLength(0);
    });

    it('passes the token-scoped storage lane into finalized publish calls', async () => {
      const token = 'agent-token-a';
      const tokenAgentAddress = `0x${'ab'.repeat(20)}`;
      const seenOpts: unknown[] = [];

      await startWith(
        {},
        {
          resolveAgentByToken: (t?: string) => (t === token ? tokenAgentAddress : undefined),
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            seenOpts.push(opts);
            return {
              status: 'confirmed',
              ual: 'did:dkg:test/1/43',
              kaId: '43',
              seal: { authorAddress: tokenAgentAddress },
            };
          },
        },
        { requestToken: token, requestAgentAddress: tokenAgentAddress },
      );

      const res = await post('vm/publish', { contextGraphId: CG_ID });

      expect(res.status).toBe(200);
      expect(seenOpts).toHaveLength(1);
      expect(seenOpts[0]).toMatchObject({ agentAddress: tokenAgentAddress });
    });

    it('standalone vm/publish accepts uint72 publisher identity overrides into publish options', async () => {
      const seenOpts: unknown[] = [];

      await startWith(
        {},
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            seenOpts.push(opts);
            return { status: 'confirmed', ual: 'did:dkg:test/1/46', kaId: '46' };
          },
        },
      );

      const res = await post('vm/publish', {
        contextGraphId: CG_ID,
        options: {
          publisherNodeIdentityIdOverride: '0',
        },
      });

      expect(res.status).toBe(200);
      expect(seenOpts).toHaveLength(1);
      expect(seenOpts[0]).toMatchObject({
        publisherNodeIdentityIdOverride: 0n,
      });
    });

    it('standalone vm/publish rejects publisher identity overrides above uint72 before publish', async () => {
      const publishCalls: unknown[] = [];

      await startWith(
        {},
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            publishCalls.push(opts);
            throw new Error('publish should not be called');
          },
        },
      );

      const res = await post('vm/publish', {
        contextGraphId: CG_ID,
        options: {
          publisherNodeIdentityIdOverride: UINT72_OVERFLOW_DECIMAL,
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('publisherNodeIdentityIdOverride');
      expect(String(res.body.error)).toContain('uint72');
      expect(publishCalls).toHaveLength(0);
    });

    it('standalone vm/publish rejects malformed conflicting clear-memory aliases before publish', async () => {
      const publishCalls: unknown[] = [];

      await startWith(
        {},
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            publishCalls.push(opts);
            throw new Error('publish should not be called');
          },
        },
      );

      const res = await post('vm/publish', {
        contextGraphId: CG_ID,
        options: {
          clearAfter: false,
          clearSharedMemoryAfter: 'true',
        },
      });

      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('clearSharedMemoryAfter');
      expect(String(res.body.error)).toContain('boolean');
      expect(publishCalls).toHaveLength(0);
    });

    it('standalone vm/publish rejects partial selection before publish', async () => {
      const publishCalls: unknown[] = [];

      await startWith(
        {},
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, opts: unknown) {
            publishCalls.push(opts);
            return { status: 'confirmed', ual: 'did:dkg:test/1/45', kaId: '45' };
          },
        },
      );

      const cases = [
        { contextGraphId: CG_ID, selection: { rootEntities: ['urn:only-this'] } },
        { contextGraphId: CG_ID, options: { selection: { rootEntities: ['urn:only-this'] } } },
      ];

      for (const body of cases) {
        const res = await post('vm/publish', body);
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toContain('selection');
      }
      expect(publishCalls).toHaveLength(0);
    });

    it('on CG_NOT_REGISTERED: registers ONCE between TWO publish calls and returns the retry result', async () => {
      const calls: string[] = [];
      let publishCount = 0;

      await startWith(
        {}, // no `assertion` methods needed for vm/publish
        {
          async publishFromFinalizedAssertion(_cg: string, _name: string, _opts: unknown) {
            publishCount += 1;
            calls.push(`publish#${publishCount}`);
            if (publishCount === 1) {
              // First attempt: the CG isn't registered on-chain yet.
              throw Object.assign(
                new Error(`Context graph "${CG_ID}" is not registered on-chain. Run 'dkg context-graph register' first.`),
                { code: 'CG_NOT_REGISTERED' },
              );
            }
            // Retry (after register): confirmed publish.
            return { status: 'confirmed', ual: 'did:dkg:test/1/42', kaId: '42', seal: { authorAddress: '0x00000000000000000000000000000000000000a1' } };
          },
          async ensureRegisteredForPublish(_cg: string, _opts: unknown) {
            calls.push('register');
            // success — the CG is now registered.
          },
        },
      );

      const res = await post('vm/publish', { contextGraphId: CG_ID });

      // Exact call order: publish (throws) → register (once) → publish (succeeds).
      expect(calls).toEqual(['publish#1', 'register', 'publish#2']);
      expect(publishCount).toBe(2);
      expect(calls.filter((c) => c === 'register').length).toBe(1);

      // The response reflects the SECOND (success) call, NOT the first 409.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');
      expect(res.body.ual).toBe('did:dkg:test/1/42');
      expect(String(res.body.error ?? '')).not.toMatch(/not registered on-chain/i);
    });

    it('if auto-register itself fails, returns 400 and does NOT retry the publish', async () => {
      const calls: string[] = [];
      let publishCount = 0;

      await startWith(
        {},
        {
          async publishFromFinalizedAssertion() {
            publishCount += 1;
            calls.push(`publish#${publishCount}`);
            throw Object.assign(new Error(`Context graph "${CG_ID}" is not registered on-chain.`), { code: 'CG_NOT_REGISTERED' });
          },
          async ensureRegisteredForPublish() {
            calls.push('register');
            throw new Error('insufficient TRAC to register context graph');
          },
        },
      );

      const res = await post('vm/publish', { contextGraphId: CG_ID });

      // Only ONE publish attempt — no retry after a failed register.
      expect(calls).toEqual(['publish#1', 'register']);
      expect(publishCount).toBe(1);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/could not be auto-registered on-chain/i);
    });
  });
});
