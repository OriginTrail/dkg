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

  it('createKnowledgeAsset forwards finalize:false for a draft-only write', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      finalize: false,
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
    });
    expect(calls[0].url).toContain('/api/knowledge-assets');
    expect(calls[0].body).toMatchObject({ contextGraphId: 'cg-1', name: 'f', finalize: false });
  });

  it('createKnowledgeAsset omits finalize when unspecified (server default seals)', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
    });
    expect(calls[0].body).not.toHaveProperty('finalize');
  });

  it('createKnowledgeAsset rejects finalize-only fields when finalize:false (parity with daemon)', async () => {
    const { client, calls } = makeClient();
    await expect(client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      authorAgentAddress: '0xauthor',
      finalize: false,
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
    })).rejects.toThrow(/require non-empty quads and finalize !== false/);
    expect(calls).toHaveLength(0);
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

  // A sequenced fetcher: returns responses[i] for the i-th call.
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

  it('publishQuads posts explicit quads to the direct publish route', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 200, body: { mode: 'direct', kaId: '1', kas: [], txHash: '0x1' } },
    ]);

    const result = await client.publishQuads({
      contextGraphId: 'cg-1',
      quads: [{ subject: 's', predicate: 'p', object: 'o' }],
    });

    expect(result).toMatchObject({ mode: 'direct', kaId: '1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/knowledge-assets/publish');
    expect(calls[0].url).not.toContain('/api/shared-memory/publish');
    expect(calls[0].body).toEqual({
      contextGraphId: 'cg-1',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
    });
  });

  it('publishQuads preserves explicit quad graph values for the direct publish payload', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 200, body: { mode: 'direct', kaId: '2', kas: [] } },
    ]);

    await client.publishQuads({
      contextGraphId: 'cg-1',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:graph' }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      contextGraphId: 'cg-1',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:graph' }],
    });
  });

  it('publishQuads surfaces direct publish failures without creating hidden assertion state', async () => {
    const { client, calls } = makeSequencedClient([
      { status: 502, body: { error: 'NO_DATA_IN_SWM' } },
    ]);

    const err = await client.publishQuads({
      contextGraphId: 'cg-1',
      quads: [{ subject: 's', predicate: 'p', object: 'o' }],
    }).catch((e) => e);

    expect(err.message).toMatch(/NO_DATA_IN_SWM/);
    expect(err.assertionName).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/knowledge-assets/publish');
  });
});
