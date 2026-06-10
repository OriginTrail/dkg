import { describe, it, expect } from 'vitest';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

// ── OT-RFC-43 §10.5 — knowledge-assets client contract ──────────────────────
// Pins the request body shapes for the VM-publish / finalize options the daemon
// supports, mirroring the cli ApiClient reference. Regression for the review on
// PR #978: these options were dropped, so external-signer / publish-control
// flows were unreachable through the MCP KA surface.
describe('DkgClient knowledge-assets — publish/finalize option serialization', () => {
  const makeClient = () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, calls };
  };

  it('knowledgeAssetPublish nests finalized-publish controls under `options`', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      subGraphName: 'sg',
      clearAfter: true,
      publishEpochs: 3,
      publisherNodeIdentityIdOverride: '42',
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/vm/publish');
    // `clearAfter` is the SDK spelling; the daemon expects `clearSharedMemoryAfter`.
    // JSON-facing callers send the uint64 override as a decimal string.
    expect(calls[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      subGraphName: 'sg',
      options: {
        clearSharedMemoryAfter: true,
        publishEpochs: 3,
        publisherNodeIdentityIdOverride: '42',
      },
    });
  });

  it('knowledgeAssetPublish omits `options` when no controls are passed', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f', subGraphName: 'sg' });
    expect(calls[0].body).toEqual({ contextGraphId: 'cg-1', subGraphName: 'sg' });
  });

  it('knowledgeAssetPublish rejects numeric publisher identity overrides before HTTP serialization', async () => {
    const { client, calls } = makeClient();
    await expect(client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1,
    } as any)).rejects.toThrow(/decimal string/);
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPublish rejects malformed decimal-string publisher identity overrides', async () => {
    const { client, calls } = makeClient();
    await expect(client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      publisherNodeIdentityIdOverride: 'abc',
    })).rejects.toThrow(/decimal string/);
    await expect(client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      publisherNodeIdentityIdOverride: '-1',
    })).rejects.toThrow(/decimal string/);
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPublish rejects unknown finalized-publish option keys', async () => {
    const { client, calls } = makeClient();
    await expect(client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      publishEpoch: 3,
    } as any)).rejects.toThrow(/Unsupported finalized publish option\(s\): publishEpoch/);
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetWrite strips any per-quad `graph` at the client (CONTRACT §A)', async () => {
    const { client, calls } = makeClient();
    // Even a NON-EMPTY graph must be dropped before the POST — the daemon pins
    // every quad to the per-KA WM graph, so the write wire shape is
    // {subject,predicate,object} only. Stripping at the client (not just the
    // tool schema) defends a hand-built or normalizer-emitted `graph`.
    await client.knowledgeAssetWrite({
      contextGraphId: 'cg-1',
      name: 'f',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:my-graph:forged' }],
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/wm/write');
    const quads = calls[0].body.quads as Array<Record<string, unknown>>;
    expect(quads).toHaveLength(1);
    expect(quads[0]).not.toHaveProperty('graph');
    expect(quads[0]).toEqual({ subject: 's', predicate: 'p', object: 'o' });
  });

  it('knowledgeAssetFinalize forwards authorAgentAddress', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetFinalize({
      contextGraphId: 'cg-1',
      name: 'f',
      authorAgentAddress: '0xauthor',
      schemeVersion: 1,
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/wm/finalize');
    expect(calls[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      authorAgentAddress: '0xauthor',
      schemeVersion: 1,
    });
  });

  it('knowledgeAssetFinalize forwards preSignedAuthorAttestation', async () => {
    const { client, calls } = makeClient();
    const preSignedAuthorAttestation = { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } };
    await client.knowledgeAssetFinalize({
      contextGraphId: 'cg-1',
      name: 'f',
      preSignedAuthorAttestation,
      schemeVersion: 1,
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/wm/finalize');
    expect(calls[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      preSignedAuthorAttestation,
      schemeVersion: 1,
    });
  });

  it('knowledgeAssetFinalize rejects mutually exclusive authorship fields before HTTP serialization', async () => {
    const { client, calls } = makeClient();
    await expect(client.knowledgeAssetFinalize({
      contextGraphId: 'cg-1',
      name: 'f',
      authorAgentAddress: '0xauthor',
      preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
    })).rejects.toThrow(/mutually exclusive/);
    expect(calls).toHaveLength(0);
  });

  it('createKnowledgeAsset translates an alsoPublishVm options object', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: { clearAfter: true, publishEpochs: 2, publisherNodeIdentityIdOverride: '7' },
    });
    expect(calls[0].body.alsoPublishVm).toEqual({
      clearSharedMemoryAfter: true,
      publishEpochs: 2,
      publisherNodeIdentityIdOverride: '7',
    });
  });

  it('createKnowledgeAsset passes a boolean alsoPublishVm through unchanged', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({ contextGraphId: 'cg-1', name: 'f', alsoPublishVm: true });
    expect(calls[0].body.alsoPublishVm).toBe(true);
  });

  it('createKnowledgeAsset rejects null alsoPublishVm before HTTP serialization', async () => {
    const { client, calls } = makeClient();
    await expect(client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: null,
    } as any)).rejects.toThrow(/alsoPublishVm must be a boolean or publish-options object/);
    expect(calls).toHaveLength(0);
  });

  it('createKnowledgeAsset treats an empty alsoPublishVm options object as default publish', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: {},
    });
    expect(calls[0].body.alsoPublishVm).toEqual({});
  });

  it('createKnowledgeAsset rejects unknown alsoPublishVm option objects', async () => {
    const { client, calls } = makeClient();
    await expect(client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: { unknown: true },
    } as any)).rejects.toThrow(/Unsupported finalized publish option\(s\): unknown/);
    await expect(client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: { publishEpoch: 3 },
    } as any)).rejects.toThrow(/Unsupported finalized publish option\(s\): publishEpoch/);
    expect(calls).toHaveLength(0);
  });

  it('createKnowledgeAsset rejects finalize-only fields without quads before HTTP serialization', async () => {
    const { client, calls } = makeClient();
    await expect(client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      authorAgentAddress: '0xauthor',
    })).rejects.toThrow(/require non-empty quads/);
    expect(calls).toHaveLength(0);
  });

  // A sequenced fetcher: returns responses[i] for the i-th call (create, then publish).
  const makeSequencedClient = (responses: Array<{ status: number; body: unknown }>) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let i = 0;
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        const r = responses[i++] ?? { status: 200, body: {} };
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, calls };
  };

  // FIX A — publishQuads aborts (no publish) on a create 207 share-phase failure.
  it('publishQuads aborts without publishing when create returns a 207 share-phase partial-failure', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 207, body: { created: true, name: 'mcp-publish-x', assertionUri: 'urn:assertion:x', status: 'wm-sealed', errors: [{ phase: 'swm-share', error: 'gossip peer unreachable' }] } },
    ]);
    await expect(
      client.publishQuads({ contextGraphId: 'cg-1', quads: [{ subject: 's', predicate: 'p', object: 'o' }] }),
    ).rejects.toThrow(/gossip peer unreachable/);
    // re-run to inspect the structured error fields + that publish was never called.
    const { client: c2, calls: calls2 } = makeSequencedClient([
      { status: 207, body: { created: true, name: 'mcp-publish-x', assertionUri: 'urn:assertion:x', status: 'wm-sealed', errors: [{ phase: 'swm-share', error: 'gossip peer unreachable' }] } },
    ]);
    const err = await c2.publishQuads({ contextGraphId: 'cg-1', quads: [{ subject: 's', predicate: 'p', object: 'o' }] }).catch((e) => e);
    expect(err.assertionName).toMatch(/mcp-publish-/);
    expect(err.message).toMatch(/do not recreate/i);
    // only the create call was made — /api/shared-memory/publish was NEVER called.
    expect(calls2).toHaveLength(1);
    expect(calls2[0].url).toContain('/api/knowledge-assets');
    void calls;
  });

  // FIX B — publishQuads carries the assertionName when the publish call fails.
  it('publishQuads surfaces the created assertionName when the publish call fails after a successful create', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 201, body: { assertionUri: 'urn:assertion:y', status: 'swm-shared' } }, // create OK
      { status: 502, body: { error: 'on-chain revert' } },                              // publish fails
    ]);
    const err = await client.publishQuads({ contextGraphId: 'cg-1', quads: [{ subject: 's', predicate: 'p', object: 'o' }] }).catch((e) => e);
    expect(err.assertionName).toMatch(/mcp-publish-/);
    expect(err.message).toMatch(/do not recreate/i);
    expect(err.message).toMatch(/retry the publish/i);
    // both calls were made — the failure was the publish (2nd) call.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/api/shared-memory/publish');
  });

  // FIX W — create HARD failure surfaces the generated assertionName for recovery.
  it('publishQuads surfaces the generated assertionName when the create call HARD-fails', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 500, body: { error: 'daemon timeout after commit' } }, // create fails (may have committed)
    ]);
    const err = await client.publishQuads({ contextGraphId: 'cg-1', quads: [{ subject: 's', predicate: 'p', object: 'o' }] }).catch((e) => e);
    expect(err.assertionName).toMatch(/mcp-publish-/);
    expect(err.phase).toBe('create');
    expect(err.message).toMatch(/dkg_knowledge_asset_history|dkg_knowledge_asset_query/i); // check-before-recreate
    expect(err.message).toMatch(/duplicate/i);
    // only the create call was made — no publish.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/knowledge-assets');
  });
});
