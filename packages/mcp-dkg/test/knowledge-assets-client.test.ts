import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DkgClient, DkgHttpError, DkgOutcomeUnknownError } from '../src/client.js';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { FakeClient, FakeServer, makeConfig } from './harness.js';

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

  it('knowledgeAssetFinalize rejects the retired SWM write bridge before HTTP', async () => {
    const { client, calls } = makeClient();
    await expect(
      client.knowledgeAssetFinalize({ contextGraphId: 'cg-1', name: 'f', layer: 'swm' }),
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetFinalize omits the layer key when not passed', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetFinalize({ contextGraphId: 'cg-1', name: 'f' });
    expect(calls[0].body).not.toHaveProperty('layer');
  });

  it('knowledgeAssetFinalize accepts legacy layer:wm but omits it from the wire', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetFinalize({ contextGraphId: 'cg-1', name: 'f', layer: 'wm' });
    expect(calls[0].body).toEqual({ contextGraphId: 'cg-1' });
  });

  it('knowledgeAssetShare rejects unsealed sharing before HTTP', async () => {
    const { client, calls } = makeClient();
    await expect(
      client.knowledgeAssetShare({ contextGraphId: 'cg-1', name: 'f', skipSeal: true }),
    ).rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetShare rejects root selection and emits no legacy fields for atomic share', async () => {
    const rejected = makeClient();
    await expect(
      rejected.client.knowledgeAssetShare({ contextGraphId: 'cg-1', name: 'f', entities: ['urn:x'] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    await expect(
      rejected.client.knowledgeAssetShare({ contextGraphId: 'cg-1', name: 'f', entities: 'urn:not-all' as any }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    await expect(
      rejected.client.knowledgeAssetShare({ contextGraphId: 'cg-1', name: 'f', skipSeal: 'yes' as any }),
    ).rejects.toThrow('skipSeal must be false or omitted');
    expect(rejected.calls).toHaveLength(0);

    const { client, calls } = makeClient();
    await client.knowledgeAssetShare({
      contextGraphId: 'cg-1', name: 'f', entities: 'all', skipSeal: false,
    });
    expect(calls[0].body).toEqual({ contextGraphId: 'cg-1' });
    expect(calls[0].body).not.toHaveProperty('skipSeal');
    expect(calls[0].body).not.toHaveProperty('entities');
  });

  it('keeps promoteAssertion as a deprecated alias for complete atomic sharing', async () => {
    const { client, calls } = makeClient();
    await client.promoteAssertion({
      contextGraphId: 'cg-1', assertionName: 'legacy', subGraphName: 'sg', entities: 'all',
    });
    await client.promoteAssertion({ contextGraphId: 'cg-1', assertionName: 'legacy-default' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: expect.stringContaining('/api/knowledge-assets/legacy/swm/share'),
      body: { contextGraphId: 'cg-1', subGraphName: 'sg' },
    });
    expect(calls[1]).toEqual({
      url: expect.stringContaining('/api/knowledge-assets/legacy-default/swm/share'),
      body: { contextGraphId: 'cg-1' },
    });
  });

  it('makes legacy promoteAssertion subsets fail through the atomic share guard before HTTP', async () => {
    const { client, calls } = makeClient();
    await expect(client.promoteAssertion({
      contextGraphId: 'cg-1', assertionName: 'legacy', entities: ['urn:x'],
    })).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
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

  it('createKnowledgeAsset omits finalize when unspecified, but defaults alsoShareSwm:true (seal+share)', async () => {
    // #1116 D5: quads present + finalize unspecified ⇒ the draft seals (server
    // default), so the combined CLIENT function also defaults alsoShareSwm to
    // true. `finalize` is still omitted (the server defaults it to seal).
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
    });
    expect(calls[0].body).not.toHaveProperty('finalize');
    expect(calls[0].body.alsoShareSwm).toBe(true);
  });

  it('createKnowledgeAsset does NOT default alsoShareSwm when finalize:false (no seal ⇒ no share)', async () => {
    // #1116 D5: an unsealed draft can't be shared, so the client must NOT
    // default-on alsoShareSwm — the route guard would otherwise reject it.
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      finalize: false,
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
    });
    expect(calls[0].body).not.toHaveProperty('alsoShareSwm');
  });

  it('createKnowledgeAsset does NOT default alsoShareSwm without quads', async () => {
    // No quads ⇒ nothing to seal ⇒ no auto-share default.
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({ contextGraphId: 'cg-1', name: 'f' });
    expect(calls[0].body).not.toHaveProperty('alsoShareSwm');
  });

  it('createKnowledgeAsset honors an explicit alsoShareSwm:false over the seal-default', async () => {
    // An explicit false must win — stop at a sealed WM draft.
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: 'urn:g' }],
      alsoShareSwm: false,
    });
    expect(calls[0].body.alsoShareSwm).toBe(false);
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
});

// ── Per-route timeout classes ───────────────────────────────────────────────
// Real, small deadlines: a 20 ms read class and a 1 s long class. The stub daemon
// answers after `latencyMs` unless the request's signal aborts first, in which
// case it rejects with the abort reason, as fetch does.
describe('DkgClient per-route timeout classes', () => {
  const quads = [{ subject: 's', predicate: 'p', object: 'o', graph: '' }];
  const slowDaemon = (latencyMs: number, status = 200, body: unknown = { kaId: '7', status: 'confirmed' }) =>
    ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })), latencyMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      }, { once: true });
    })) as typeof fetch;
  const timed = (latencyMs: number, longTimeoutMs = 1_000, status?: number, body?: unknown) => new DkgClient({
    config: makeConfig(),
    fetcher: slowDaemon(latencyMs, status, body),
    readTimeoutMs: 20,
    longTimeoutMs,
  });

  it('a publish that outlasts the read timeout is not reported as failed', async () => {
    await expect(timed(80).knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f' }))
      .resolves.toEqual({ kaId: '7', status: 'confirmed' });
  });

  it('a GET read with the same latency still times out (control)', async () => {
    await expect(timed(80).getStatus()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('share, import-file, a sharing create and other writes take the long class', async () => {
    const client = timed(80);
    await expect(client.knowledgeAssetShare({ contextGraphId: 'cg-1', name: 'f' })).resolves.toBeDefined();
    await expect(client.importAssertionFile({
      contextGraphId: 'cg-1',
      assertionName: 'f',
      fileBuffer: Buffer.from('# doc'),
      fileName: 'doc.md',
    })).resolves.toBeDefined();
    await expect(client.createKnowledgeAsset({ contextGraphId: 'cg-1', name: 'f', quads })).resolves.toBeDefined();
    // Chain-bound writes (registration) must not inherit the read deadline either.
    await expect(client.registerContextGraph({ id: 'cg-1' })).resolves.toBeDefined();
  });

  it('a long mutation past its deadline reports outcome unknown, pointing at the history tool', async () => {
    const err = await timed(400, 100).knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DkgOutcomeUnknownError);
    expect(err).toMatchObject({ code: 'OUTCOME_UNKNOWN', method: 'POST', route: '/api/knowledge-assets/f/vm/publish' });
    expect((err as Error).message).toContain('dkg_knowledge_asset_history');
    const importErr = await timed(400, 100).importAssertionFile({
      contextGraphId: 'cg-1',
      assertionName: 'f',
      fileBuffer: Buffer.from('# doc'),
      fileName: 'doc.md',
    }).catch((e: unknown) => e);
    expect(importErr).toBeInstanceOf(DkgOutcomeUnknownError);
  });

  it('other writes past the long deadline keep the plain timeout error', async () => {
    // A bare create neither shares nor publishes: nothing long is in flight.
    const err = await timed(400, 100).createKnowledgeAsset({ contextGraphId: 'cg-1', name: 'f' })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DkgOutcomeUnknownError);
    expect(err).toMatchObject({ name: 'TimeoutError' });
  });

  it('a daemon answer on a long mutation keeps its HTTP error', async () => {
    const err = await timed(0, 1_000, 409, { code: 'VM_PUBLISH_PRECONDITION', error: 'not shared' })
      .knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DkgHttpError);
    expect(err).toMatchObject({ status: 409 });
  });

  it.each([
    ['headers', 'fetch failed', 'UND_ERR_HEADERS_TIMEOUT'],
    ['body', 'terminated', 'UND_ERR_BODY_TIMEOUT'],
  ])("treats Node fetch's own %s timeout on a long mutation as outcome unknown", async (_phase, message, code) => {
    // Node's fetch (undici) stops waiting on its own after 300 s without headers or
    // body progress; that surfaces as a TypeError whose cause carries the undici code.
    const undiciTimeout = Object.assign(new TypeError(message), { cause: { code } });
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async () => { throw undiciTimeout; }) as typeof fetch,
      readTimeoutMs: 20,
      longTimeoutMs: 1_000,
    });
    await expect(client.knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f' }))
      .rejects.toBeInstanceOf(DkgOutcomeUnknownError);
    // Outside the long mutations it stays the raw transport error.
    await expect(client.getStatus()).rejects.toBe(undiciTimeout);
  });

  it('passes a hostile transport error on a long mutation through untouched', async () => {
    const hostileCause = new Proxy({}, { get: () => { throw new Error('hostile getter'); } });
    const transportError = Object.assign(new TypeError('unclassified transport error'), { cause: hostileCause });
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async () => { throw transportError; }) as typeof fetch,
    });
    await expect(client.knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f' })).rejects.toBe(transportError);
  });

  it('a daemon answer on import-file keeps its HTTP error', async () => {
    const err = await timed(0, 1_000, 413, { error: 'file too large' }).importAssertionFile({
      contextGraphId: 'cg-1',
      assertionName: 'f',
      fileBuffer: Buffer.from('# doc'),
      fileName: 'doc.md',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DkgHttpError);
    expect(err).toMatchObject({ status: 413, body: { error: 'file too large' } });
    expect((err as Error).message).toContain('POST /api/knowledge-assets/f/wm/import-file → 413');
  });

  it.each([
    ['dkg_knowledge_asset_publish', 'knowledgeAssetPublish', { name: 'doc' }],
    ['dkg_knowledge_asset_share', 'knowledgeAssetShare', { name: 'doc' }],
    ['dkg_knowledge_asset_create', 'createKnowledgeAsset', {
      name: 'doc',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
      alsoShareSwm: true,
    }],
  ] as const)('%s reports an unknown outcome as a non-error result', async (tool, method, input) => {
    const unknown = new DkgOutcomeUnknownError('POST', '/api/knowledge-assets/doc/vm/publish', 300_000);
    const server = new FakeServer();
    const client = new FakeClient({ [method]: async () => { throw unknown; } });
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const res = await server.call(tool, input);

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('outcome unknown');
    expect(res.content[0].text).toContain('dkg_knowledge_asset_history');
  });

  it('dkg_knowledge_asset_import_file reports an unknown outcome as a non-error result', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'dkg-mcp-timeouts-'));
    try {
      const filePath = path.join(tempDir, 'notes.md');
      await writeFile(filePath, '# Notes', 'utf-8');
      const unknown = new DkgOutcomeUnknownError('POST', '/api/knowledge-assets/doc/wm/import-file', 300_000);
      const server = new FakeServer();
      const client = new FakeClient({ importAssertionFile: async () => { throw unknown; } });
      registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

      const res = await server.call('dkg_knowledge_asset_import_file', { name: 'doc', filePath });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Import of 'notes.md' into knowledge asset 'doc'");
      expect(res.content[0].text).toContain('outcome unknown');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a list read that outlasts the read timeout is not cut short', async () => {
    const client = timed(80, 1_000, 200, { contextGraphs: [], subGraphs: [] });
    await expect(client.listProjects()).resolves.toEqual([]);
    await expect(client.listSubGraphs('cg-1')).resolves.toEqual([]);
  });

  describe('deadline values', () => {
    let deadlines: number[];

    beforeEach(() => {
      deadlines = [];
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        return timeout(ms);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const client = (opts: { readTimeoutMs?: number; longTimeoutMs?: number } = {}) =>
      new DkgClient({ config: makeConfig(), fetcher: slowDaemon(0, 200, {}), ...opts });
    const readAll = async (c: DkgClient) => {
      // The client has no PCA or publisher-job method yet; the route classes
      // still cover them, as in the CLI client.
      const request = (c as unknown as {
        request(method: 'GET', route: string): Promise<unknown>;
      }).request.bind(c);
      await c.listProjects();
      await c.listSubGraphs('cg-1');
      await request('GET', '/api/pca');
      await request('GET', '/api/publisher/jobs?status=queued');
      await request('GET', '/api/pca/1');
      await c.getStatus();
      await c.registerContextGraph({ id: 'cg-1' });
    };

    // The shared policy's own tests (packages/core) cover its values, floors
    // and validation; these check the client routes every request through it.
    it('gives the graph, PCA and publisher-job lists 60 s, other reads 30 s and writes 240 s', async () => {
      vi.stubEnv('DKG_API_READ_TIMEOUT_MS', '');
      vi.stubEnv('DKG_API_LONG_TIMEOUT_MS', '');
      await readAll(client());
      expect(deadlines).toEqual([60_000, 60_000, 60_000, 60_000, 30_000, 30_000, 240_000]);
    });

    it('takes the deadlines from the environment unless explicit options win', async () => {
      vi.stubEnv('DKG_API_READ_TIMEOUT_MS', '45000');
      vi.stubEnv('DKG_API_LONG_TIMEOUT_MS', ' 600000 ');
      await readAll(client());
      expect(deadlines).toEqual([60_000, 60_000, 60_000, 60_000, 45_000, 45_000, 600_000]);
      deadlines.length = 0;
      await readAll(client({ readTimeoutMs: 20, longTimeoutMs: 1_000 }));
      expect(deadlines).toEqual([60_000, 60_000, 60_000, 60_000, 20, 20, 1_000]);
    });

    it('refuses to construct with an invalid timeout override', () => {
      vi.stubEnv('DKG_API_READ_TIMEOUT_MS', '30s');
      expect(() => client()).toThrow(/DKG_API_READ_TIMEOUT_MS must be a whole number of milliseconds/);
      vi.stubEnv('DKG_API_READ_TIMEOUT_MS', '');
      vi.stubEnv('DKG_API_LONG_TIMEOUT_MS', '0');
      expect(() => client()).toThrow(/DKG_API_LONG_TIMEOUT_MS must be a whole number of milliseconds/);
    });
  });
});
