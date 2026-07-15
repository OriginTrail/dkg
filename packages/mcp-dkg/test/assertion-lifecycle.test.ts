import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { DkgHttpError } from '../src/client.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('assertion CRUD quintet — round-trip with @en literal preservation', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers all thirteen knowledge-asset-family tools (rc.17 rename + 3 new verbs)', () => {
    const expected = [
      'dkg_knowledge_asset_create',
      'dkg_knowledge_asset_write',
      'dkg_knowledge_asset_finalize',
      'dkg_knowledge_asset_share',
      'dkg_knowledge_asset_publish',
      'dkg_knowledge_asset_pull_from',
      'dkg_knowledge_asset_discard',
      'dkg_knowledge_asset_query',
      'dkg_knowledge_asset_import_artifact_resolve',
      'dkg_knowledge_asset_import_artifact_read_markdown',
      'dkg_knowledge_asset_semantic_enrichment_write',
      'dkg_knowledge_asset_import_file',
      'dkg_knowledge_asset_history',
    ];
    for (const name of expected) {
      expect(server.tools.has(name)).toBe(true);
    }
    // No dkg_assertion_* / dkg_import_artifact_* / dkg_semantic_enrichment_*
    // back-compat names survive the clean cut (CONTRACT §2).
    for (const legacy of [
      'dkg_assertion_create',
      'dkg_assertion_promote',
      'dkg_import_artifact_resolve',
      'dkg_semantic_enrichment_write',
    ]) {
      expect(server.tools.has(legacy)).toBe(false);
    }
  });

  it('documents canonical context graph ids for knowledge-asset write tools', () => {
    for (const name of [
      'dkg_knowledge_asset_create',
      'dkg_knowledge_asset_write',
      'dkg_knowledge_asset_finalize',
      'dkg_knowledge_asset_share',
      'dkg_knowledge_asset_publish',
      'dkg_knowledge_asset_pull_from',
      'dkg_knowledge_asset_discard',
      'dkg_knowledge_asset_query',
    ]) {
      const projectId = server.get(name).config.inputSchema?.projectId;
      expect(projectId?.description).toContain('dkg_list_context_graphs');
      expect(projectId?.description).toContain('local-notes');
      expect(projectId?.description).toContain('<curatorAddress>/<slug>');
      expect(projectId?.description).toContain('Do not guess');
    }
  });

  it('exposes imported attachment resolve/read/enrichment helpers without promoting', async () => {
    const assertionUri = 'did:dkg:context-graph:test-cg/assertion/peer-test/imported-doc';

    const resolved = await server.call('dkg_knowledge_asset_import_artifact_resolve', {
      assertionUri,
    });
    expect(resolved.isError).toBeFalsy();
    expect(resolved.content[0].text).toContain('"canReadMarkdown": true');

    const markdown = await server.call('dkg_knowledge_asset_import_artifact_read_markdown', {
      assertionUri,
      maxBytes: 1024,
    });
    expect(markdown.isError).toBeFalsy();
    expect(markdown.content[0].text).toContain('# Imported');

    const enrichment = await server.call('dkg_knowledge_asset_semantic_enrichment_write', {
      assertionUri,
      semanticQuads: [
        { subject: 'urn:dkg:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
    });
    expect(enrichment.isError).toBeFalsy();
    expect(enrichment.content[0].text).toContain(`"assertionUri": "${assertionUri}"`);
    expect(enrichment.content[0].text).toContain('"sourceAssertionUri": "did:dkg:context-graph:test-cg/assertion/peer-test/imported-doc"');
    expect(enrichment.content[0].text).toContain('"promoted": false');
    expect(enrichment.content[0].text).toContain('"published": false');
  });

  it('does not expose a target assertion name on the semantic enrichment schema', () => {
    const tool = server.tools.get('dkg_knowledge_asset_semantic_enrichment_write');
    expect(tool).toBeTruthy();
    expect(tool!.config.description).toMatch(/Append model-derived semantic triples/);
    expect(tool!.config.description).not.toMatch(/separate Working Memory assertion/);
    expect(tool!.config.inputSchema).not.toHaveProperty('name');
  });

  it('rejects semantic enrichment quads that try to set a graph at the MCP layer', async () => {
    const assertionUri = 'did:dkg:context-graph:test-cg/assertion/peer-test/imported-doc';

    await expect(
      server.call('dkg_knowledge_asset_semantic_enrichment_write', {
        assertionUri,
        semanticQuads: [
          {
            subject: 'urn:dkg:doc:imported',
            predicate: 'http://schema.org/about',
            object: '"Semantic topic"',
            graph: 'urn:dkg:graph:forged',
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('round-trips create → write → share → query, preserving @en language tags on literals', async () => {
    const created = await server.call('dkg_knowledge_asset_create', { name: 'session-2026' });
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toMatch(/Created assertion 'session-2026'/);

    const langTagged = '"hello world"@en';
    const written = await server.call('dkg_knowledge_asset_write', {
      name: 'session-2026',
      quads: [
        { subject: 'urn:x:1', predicate: 'urn:p:label', object: langTagged },
        { subject: 'urn:x:1', predicate: 'urn:p:type', object: 'urn:Note' },
      ],
    });
    expect(written.isError).toBeFalsy();
    expect(written.content[0].text).toMatch(/Wrote 2 quad\(s\)/);

    // Dump the WM draft BEFORE sharing — `dkg_knowledge_asset_query` reads the
    // WM draft, and production promote MOVES the shared quads to SWM and DELETES
    // them from WM (`dkg-publisher.ts:4665-4669`), so the @en round-trip must be
    // verified on the WM draft pre-share.
    const queried = await server.call('dkg_knowledge_asset_query', { name: 'session-2026' });
    expect(queried.isError).toBeFalsy();
    expect(queried.content[0].text).toMatch(/2 quad\(s\)/);
    // @en lang-tag must round-trip byte-for-byte through the JSON dump.
    // The dump uses JSON.stringify so inner double-quotes are escaped to
    // \" — assert against the encoded form here, and against the
    // unescaped form on the raw stored quad below.
    expect(queried.content[0].text).toContain('\\"hello world\\"@en');

    const cellBeforeShare = client.assertions.get('test-cg::session-2026');
    expect(cellBeforeShare).toBeDefined();
    expect(cellBeforeShare!.quads).toHaveLength(2);
    // Object stored verbatim — language-tagged literal is preserved in WM.
    expect(cellBeforeShare!.quads[0].object).toBe(langTagged);

    const shared = await server.call('dkg_knowledge_asset_share', { name: 'session-2026' });
    expect(shared.isError).toBeFalsy();
    expect(shared.content[0].text).toMatch(/Shared complete knowledge asset/);

    // After sharing `urn:x:1`, BOTH quads (both have subject `urn:x:1`) move
    // WM → SWM and are deleted from the WM draft — so a post-share WM query
    // returns 0 quads. (This is the lifecycle reality the harness now models;
    // SWM is the layer that holds the shared content.)
    const cell = client.assertions.get('test-cg::session-2026');
    expect(cell).toBeDefined();
    expect(cell!.promotedRoots.has('urn:x:1')).toBe(true);
    expect(cell!.quads).toHaveLength(0);
    const queriedAfter = await server.call('dkg_knowledge_asset_query', { name: 'session-2026' });
    expect(queriedAfter.content[0].text).toMatch(/0 quad\(s\)/);
  });

  it('create is idempotent: a duplicate name reports alreadyExists rather than erroring', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'dupe' });
    const second = await server.call('dkg_knowledge_asset_create', { name: 'dupe' });
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toMatch(/already exists/);
  });

  it('create accepts any valid (IRI-safe) assertion name, not just a lowercase-hyphen slug (FIX P)', async () => {
    // The daemon's real rule (validateAssertionName) accepts mixed-case, dots,
    // and underscores — the old /^[a-z0-9-]+$/ slug regex was artificially strict.
    for (const name of ['My_Asset.v2', 'Session2026', 'urn-ish_NAME.1']) {
      const res = await server.call('dkg_knowledge_asset_create', { name });
      expect(res.isError).toBeFalsy();
    }
  });

  it('create rejects IRI-unsafe assertion names at the schema layer (FIX P)', async () => {
    // Whitespace, "/", and >256 chars are rejected (validateAssertionName).
    await expect(
      server.call('dkg_knowledge_asset_create', { name: 'Invalid Name With Spaces' }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_knowledge_asset_create', { name: 'has/slash' }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_knowledge_asset_create', { name: 'a'.repeat(257) }),
    ).rejects.toThrow();
  });

  // ── [D3] one-shot create→write→seal→share via dkg_knowledge_asset_create ──
  it('[D3] create with NO quads uses the bare create path (no createKnowledgeAsset call)', async () => {
    const res = await server.call('dkg_knowledge_asset_create', { name: 'mode-draft' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Created assertion 'mode-draft'/);
    // The combined one-shot helper must NOT fire for the no-quads draft mode.
    expect(client.createKnowledgeAssetCalls).toHaveLength(0);
  });

  it('[D3] create with quads (no alsoShareSwm) seals a WM draft and passes alsoShareSwm:false EXPLICITLY', async () => {
    const res = await server.call('dkg_knowledge_asset_create', {
      name: 'mode-sealed',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"hello"' }],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/sealed in a private Working Memory draft/);
    expect(res.content[0].text).toContain('"status": "wm-sealed"');
    expect(client.createKnowledgeAssetCalls).toHaveLength(1);
    const call = client.createKnowledgeAssetCalls[0];
    // Regression guard: the tool MUST forward an explicit alsoShareSwm:false so the
    // client helper's internal seal-true default cannot leak and silently auto-share.
    expect(call.alsoShareSwm).toBe(false);
    expect(call).toHaveProperty('alsoShareSwm');
    // It must NEVER expose/forward alsoPublishVm (no direct-publish bypass).
    expect(call.alsoPublishVm).toBeUndefined();
    // Quads forwarded with an empty per-KA graph (daemon pins to the per-KA WM graph).
    expect(call.quads).toEqual([{ subject: 'urn:s', predicate: 'urn:p', object: '"hello"', graph: '' }]);
  });

  it('[D3] create with quads + alsoShareSwm:true runs the full one-shot to SWM (publish-ready)', async () => {
    const res = await server.call('dkg_knowledge_asset_create', {
      name: 'mode-shared',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"hi"' }],
      alsoShareSwm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/shared to Shared Working Memory \(publish-ready\)/);
    expect(res.content[0].text).toContain('"status": "swm-shared"');
    expect(res.content[0].text).toContain('"publishReady": true');
    expect(client.createKnowledgeAssetCalls).toHaveLength(1);
    expect(client.createKnowledgeAssetCalls[0].alsoShareSwm).toBe(true);
  });

  it('[D3] create with alsoShareSwm:true surfaces a 207 share failure as an ERROR (not publish-ready)', async () => {
    // The daemon returns 207 + errors when create+seal lands but the opt-in SWM share
    // fails; DkgClient treats 207 as success, so the tool must judge from the OUTCOME,
    // not the requested flag — otherwise it sends the agent to publish a non-SWM asset.
    const localClient = new FakeClient({
      createKnowledgeAsset: async () => ({
        created: true,
        status: 'wm-sealed',
        sealed: true,
        errors: [{ phase: 'swm-share', error: 'shared memory write rejected' }],
      }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_create', {
      name: 'share-failed',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"hi"' }],
      alsoShareSwm: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Shared Working Memory share FAILED/);
    expect(res.content[0].text).toContain('shared memory write rejected');
    expect(res.content[0].text).toContain('NOT publish-ready');
    // Must NOT claim publish-ready, and must steer to the share retry.
    expect(res.content[0].text).not.toMatch(/\(publish-ready\)/);
    expect(res.content[0].text).toContain('dkg_knowledge_asset_share');
  });

  it('[D3] create strips angle brackets from subject/predicate/object (a bracketed URI stays a URI)', async () => {
    await server.call('dkg_knowledge_asset_create', {
      name: 'mode-strip',
      quads: [{ subject: '<urn:s>', predicate: '<urn:p>', object: '<urn:o>' }],
    });
    // The object strip runs BEFORE normalize, so `<urn:o>` → `urn:o` is recognized
    // as a URI and passed through (NOT treated as a literal and quoted).
    expect(client.createKnowledgeAssetCalls[0].quads).toEqual([
      { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: '' },
    ]);
  });

  it('[D3] create AUTO-TYPES object terms identically to OpenClaw/Hermes (bare literal → quoted, URI/blank/quoted pass through)', async () => {
    await server.call('dkg_knowledge_asset_create', {
      name: 'mode-normalize',
      quads: [
        // bare literal → wrapped in quotes (the cross-adapter parity fix)
        { subject: 'urn:s', predicate: 'urn:p1', object: 'hello world' },
        // http/urn/did URIs → passed through unquoted
        { subject: 'urn:s', predicate: 'urn:p2', object: 'https://example.org/x' },
        { subject: 'urn:s', predicate: 'urn:p3', object: 'did:dkg:agent/abc' },
        // already-quoted literal → kept as-is (NOT double-quoted)
        { subject: 'urn:s', predicate: 'urn:p4', object: '"already"' },
        // blank node → kept as-is
        { subject: 'urn:s', predicate: 'urn:p5', object: '_:b0' },
        // literal needing N-Triples escaping (quote + newline)
        { subject: 'urn:s', predicate: 'urn:p6', object: 'a"b\nc' },
      ],
    });
    expect(client.createKnowledgeAssetCalls[0].quads).toEqual([
      { subject: 'urn:s', predicate: 'urn:p1', object: '"hello world"', graph: '' },
      { subject: 'urn:s', predicate: 'urn:p2', object: 'https://example.org/x', graph: '' },
      { subject: 'urn:s', predicate: 'urn:p3', object: 'did:dkg:agent/abc', graph: '' },
      { subject: 'urn:s', predicate: 'urn:p4', object: '"already"', graph: '' },
      { subject: 'urn:s', predicate: 'urn:p5', object: '_:b0', graph: '' },
      { subject: 'urn:s', predicate: 'urn:p6', object: '"a\\"b\\nc"', graph: '' },
    ]);
  });

  it('[D3] create does NOT expose alsoPublishVm on its tool schema (no VM-mint bypass)', () => {
    const schema = server.get('dkg_knowledge_asset_create').config.inputSchema!;
    expect(schema).toHaveProperty('quads');
    expect(schema).toHaveProperty('alsoShareSwm');
    expect(schema).not.toHaveProperty('alsoPublishVm');
  });

  it('write requires a non-empty quads array', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'empty' });
    await expect(
      server.call('dkg_knowledge_asset_write', { name: 'empty', quads: [] }),
    ).rejects.toThrow();
  });

  it('share rejects the retired entities field', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'rollback' });
    await server.call('dkg_knowledge_asset_write', {
      name: 'rollback',
      quads: [{ subject: 'urn:r', predicate: 'urn:p', object: '"v"' }],
    });
    await expect(server.call('dkg_knowledge_asset_share', {
      name: 'rollback', entities: [],
    })).rejects.toThrow();
  });

  it('share accepts harmless legacy defaults and omits them from the client call', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetShare: async (args) => {
        Object.assign(captured, args);
        return { swmShared: true, promotedCount: 2 };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_knowledge_asset_share', {
      name: 'doc',
      entities: 'all',
      skipSeal: false,
    });
    expect(result.isError).toBeFalsy();
    expect(captured).toMatchObject({ name: 'doc', contextGraphId: 'test-cg' });
    expect(captured).not.toHaveProperty('entities');
    expect(captured).not.toHaveProperty('skipSeal');
  });

  it('share rejects root-selection arrays before invoking the client', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetShare: async (args) => {
        Object.assign(captured, args);
        return { swmShared: true, promotedCount: 2 };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    await expect(localServer.call('dkg_knowledge_asset_share', {
      name: 'doc',
      entities: [' urn:root-1 ', '\turn:root-2\n'],
    })).rejects.toThrow();
    expect(captured).toEqual({});
  });

  it('discard marks the assertion discarded; subsequent writes fail', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'rollback' });
    await server.call('dkg_knowledge_asset_discard', { name: 'rollback' });
    expect(client.assertions.get('test-cg::rollback')!.discarded).toBe(true);
    const writeAfterDiscard = await server.call('dkg_knowledge_asset_write', {
      name: 'rollback',
      quads: [{ subject: 'urn:r', predicate: 'urn:p', object: '"v"' }],
    });
    expect(writeAfterDiscard.isError).toBe(true);
  });

  it('query without a project returns the canonical "no project specified" hint', async () => {
    const noProjectServer = new FakeServer();
    const noProjectClient = new FakeClient();
    registerAssertionTools(
      noProjectServer.asMcpServer(),
      noProjectClient.asDkgClient(),
      makeConfig({ defaultProject: null }),
    );
    const result = await noProjectServer.call('dkg_knowledge_asset_query', { name: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No project specified/);
  });
});

describe('rc.17 lifecycle verbs — finalize / publish / pull_from (parity with OpenClaw PR1)', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  // CONTRACT §0 invariant 2 (parity with PR1's OpenClaw plugin.part-06 guard):
  // the dkg_knowledge_asset_write quad element schema must NOT advertise a
  // per-quad `graph` field. The daemon pins every triple to the per-KA WM graph,
  // so a client `graph` is daemon-overridden; the agent-facing schema must not
  // teach it. (`.element.shape` is zod's stable object-shape introspection.)
  it('write schema exposes no per-quad graph field (subject/predicate/object only)', () => {
    const schema = server.get('dkg_knowledge_asset_write').config.inputSchema!;
    const quadShape = (schema.quads as unknown as { element: { shape: Record<string, unknown> } }).element.shape;
    expect(quadShape).toHaveProperty('subject');
    expect(quadShape).toHaveProperty('predicate');
    expect(quadShape).toHaveProperty('object');
    expect(quadShape).not.toHaveProperty('graph');
  });

  // finalize surfaces author_agent_address (token-resolved author) but NOT the
  // raw preSignedAuthorAttestation — colocated-agent attribution by design
  // (CONTRACT §1 Stage3), matching the OpenClaw adapter.
  it('finalize schema surfaces authorAgentAddress + schemeVersion but not preSignedAuthorAttestation', () => {
    const schema = server.get('dkg_knowledge_asset_finalize').config.inputSchema!;
    expect(schema).toHaveProperty('authorAgentAddress');
    expect(schema).toHaveProperty('schemeVersion');
    expect(schema).not.toHaveProperty('preSignedAuthorAttestation');
    expect(schema).not.toHaveProperty('entities'); // whole-draft seal, no subset
  });

  it('finalize seals the whole WM draft (sets the seal flag)', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'doc' });
    await server.call('dkg_knowledge_asset_write', {
      name: 'doc',
      quads: [{ subject: 'urn:a', predicate: 'urn:p', object: '"v"' }],
    });
    const sealed = await server.call('dkg_knowledge_asset_finalize', { name: 'doc' });
    expect(sealed.isError).toBeFalsy();
    expect(sealed.content[0].text).toMatch(/Finalized \(sealed\) knowledge asset 'doc'/);
    expect(client.assertions.get('test-cg::doc')!.finalized).toBe(true);
  });

  // publish must NOT expose author/selection overrides — the seal selects them
  // (CONTRACT §1 Stage5 / §3). It exposes only the finalized-publish options,
  // byte-for-byte with OpenClaw.
  it('publish schema exposes only finalized-publish options, no author/selection/clear-after', () => {
    const schema = server.get('dkg_knowledge_asset_publish').config.inputSchema!;
    expect(schema).toHaveProperty('publishEpochs');
    expect(schema).toHaveProperty('publisherNodeIdentityIdOverride');
    // CONTRACT §G: per-KA publish can register the CG on-chain first —
    // vm/publish requires a registered CG.
    expect(schema).toHaveProperty('registerIfNeeded');
    // FIX X (#1076:2396 / Option A): the explicit-register route uses the daemon's
    // DEFAULT publishPolicy and does NOT preserve a stored custom publishPolicy
    // (daemon-side rehydration tracked in dkg#1085). The caveat must be present here.
    expect((schema.registerIfNeeded as { description?: string }).description).toContain('DEFAULT publishPolicy');
    expect((schema.registerIfNeeded as { description?: string }).description).toContain('OriginTrail/dkg#1085');
    // CONTRACT §D: clear-after is DROPPED from the per-asset publish tool — on
    // vm/publish it is graph-wide destructive (wipes other agents' SWM).
    expect(schema).not.toHaveProperty('clearSharedMemoryAfter');
    expect(schema).not.toHaveProperty('clearAfter');
    expect(schema).not.toHaveProperty('authorAgentAddress');
    expect(schema).not.toHaveProperty('preSignedAuthorAttestation');
    expect(schema).not.toHaveProperty('entities');
    expect(schema).not.toHaveProperty('selection');
  });

  // CONTRACT §C (float-truncation parity — Codex round-2 flagged this on Hermes):
  // a present-but-non-integral numeric must be REJECTED at the zod boundary, never
  // silently truncated (1.9 → 1). publishEpochs + schemeVersion use .int(); the
  // override regex /^\d+$/ rejects "1.9" and "-1".
  it('rejects non-integral / negative numeric options at the schema boundary (CONTRACT §C)', async () => {
    // publishEpochs 1.9 → .int() rejects (no truncation to 1).
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', publishEpochs: 1.9 }),
    ).rejects.toThrow();
    // publishEpochs 0 / negative → .positive() rejects.
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', publishEpochs: 0 }),
    ).rejects.toThrow();
    // publisher_node_identity_id_override "1.9" and "-1" → /^\d+$/ rejects.
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', publisherNodeIdentityIdOverride: '1.9' }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', publisherNodeIdentityIdOverride: '-1' }),
    ).rejects.toThrow();
    // scheme_version 1.9 / 0 → .int().positive() rejects.
    await expect(
      server.call('dkg_knowledge_asset_finalize', { name: 'doc', schemeVersion: 1.9 }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_knowledge_asset_finalize', { name: 'doc', schemeVersion: 0 }),
    ).rejects.toThrow();
  });

  it('publish forwards the finalized-publish options and returns the UAL', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetPublish: async (args) => {
        Object.assign(captured, args);
        return { kaId: 'ka-1', status: 'confirmed', ual: 'did:dkg:31337/0xauthor/7', txHash: '0xpub' };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_publish', {
      name: 'doc',
      publishEpochs: 2,
      publisherNodeIdentityIdOverride: '12',
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('"ual": "did:dkg:31337/0xauthor/7"');
    expect(captured.publishEpochs).toBe(2);
    expect(captured.publisherNodeIdentityIdOverride).toBe('12');
    expect(captured).not.toHaveProperty('authorAgentAddress');
    // CONTRACT §D: the per-asset publish never forwards a clear-after flag.
    expect(captured).not.toHaveProperty('clearAfter');
    expect(captured).not.toHaveProperty('clearSharedMemoryAfter');
  });

  it('publish surfaces a 207 partial (KA minted, CG bind failed) as a WARNING, not plain success (#1077:409)', async () => {
    // The client treats HTTP 207 as success and returns the body; a present
    // contextGraphError means the asset minted on-chain but the CG binding failed.
    const localClient = new FakeClient({
      knowledgeAssetPublish: async () => ({
        kaId: 'ka-1',
        status: 'confirmed',
        ual: 'did:dkg:31337/0xauthor/7',
        txHash: '0xpub',
        contextGraphError: 'context-graph binding timed out',
      }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_publish', { name: 'doc' });
    // Not a hard failure (the asset minted) but clearly flagged as partial.
    expect(res.content[0].text).toMatch(/PARTIAL/);
    expect(res.content[0].text).toContain('context-graph binding timed out');
    expect(res.content[0].text).toContain('"ual": "did:dkg:31337/0xauthor/7"'); // UAL still valid
    // FIX I: a confirmed publish cleared SWM, so do NOT re-publish — surface to operator.
    expect(res.content[0].text).toMatch(/do not re-publish/i);
    expect(res.content[0].text).toMatch(/operator/i);
  });

  it('publish reports plain success on a 200 (no contextGraphError)', async () => {
    const localClient = new FakeClient({
      knowledgeAssetPublish: async () => ({
        kaId: 'ka-1',
        status: 'confirmed',
        ual: 'did:dkg:31337/0xauthor/7',
        txHash: '0xpub',
      }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_publish', { name: 'doc' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Published knowledge asset 'doc'/);
    expect(res.content[0].text).not.toMatch(/PARTIAL/);
  });

  // ── CONTRACT §G — registerIfNeeded on per-KA publish ──────────────────────
  const setupPublishWithRegisterTracking = (opts: {
    registerImpl?: (args: { id: string; accessPolicy?: number }) => Promise<Record<string, unknown>>;
  } = {}) => {
    const events: string[] = [];
    const registerCalls: Array<{ id: string; accessPolicy?: number }> = [];
    const localClient = new FakeClient({
      registerContextGraph: async (args: { id: string; accessPolicy?: number }) => {
        events.push('register');
        registerCalls.push(args);
        if (opts.registerImpl) return opts.registerImpl(args);
        return { registered: args.id, onChainId: `chain:${args.id}`, txHash: '0xreg', alreadyRegistered: false };
      },
      knowledgeAssetPublish: async () => {
        events.push('publish');
        return { kaId: 'ka-1', status: 'confirmed', ual: 'did:dkg:31337/0xauthor/7', txHash: '0xpub' };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());
    return { localServer, events, registerCalls };
  };

  it('publish with registerIfNeeded=true registers THEN publishes (CONTRACT §G)', async () => {
    const { localServer, events, registerCalls } = setupPublishWithRegisterTracking();
    const res = await localServer.call('dkg_knowledge_asset_publish', {
      name: 'doc',
      registerIfNeeded: true,
      accessPolicy: 1,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('"ual": "did:dkg:31337/0xauthor/7"');
    expect(events).toEqual(['register', 'publish']); // register first, then publish
    expect(registerCalls).toEqual([{ id: 'test-cg', accessPolicy: 1 }]);
  });

  it('publish does NOT register when registerIfNeeded is omitted (CONTRACT §G)', async () => {
    const { localServer, events } = setupPublishWithRegisterTracking();
    const res = await localServer.call('dkg_knowledge_asset_publish', { name: 'doc' });
    expect(res.isError).toBeFalsy();
    expect(events).toEqual(['publish']); // no register call
  });

  it('publish with registerIfNeeded=true short-circuits an already-registered CG, still publishes (CONTRACT §G)', async () => {
    const { localServer, events, registerCalls } = setupPublishWithRegisterTracking({
      // The client surfaces alreadyRegistered:true (it swallows the daemon 409) —
      // no throw, no double-mint.
      registerImpl: async (args) => ({ registered: args.id, alreadyRegistered: true }),
    });
    const res = await localServer.call('dkg_knowledge_asset_publish', { name: 'doc', registerIfNeeded: true });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('"ual"');
    expect(events).toEqual(['register', 'publish']);
    expect(registerCalls).toHaveLength(1); // exactly one register attempt
  });

  it('publish surfaces a register HARD failure and does NOT publish (CONTRACT §G)', async () => {
    const { localServer, events } = setupPublishWithRegisterTracking({
      registerImpl: async () => { throw new Error('rpc unreachable'); },
    });
    const res = await localServer.call('dkg_knowledge_asset_publish', { name: 'doc', registerIfNeeded: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Failed to register context graph: rpc unreachable/);
    expect(events).toEqual(['register']); // publish NOT attempted
  });

  it('publish rejects a non-boolean registerIfNeeded at the schema boundary (CONTRACT §G)', async () => {
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', registerIfNeeded: 'yes' }),
    ).rejects.toThrow();
  });

  it('publish rejects accessPolicy without registerIfNeeded (FIX S)', async () => {
    const res = await server.call('dkg_knowledge_asset_publish', { name: 'doc', accessPolicy: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/accessPolicy.*requires.*registerIfNeeded/i);
  });

  it('publish rejects a non-integral publishEpochs at the schema boundary (CONTRACT §C)', async () => {
    // 1.9 must be REJECTED (zod .int()), not coerced to 1 — a present-but-invalid
    // numeric is a tool error, same as 0 / -1.
    await expect(
      server.call('dkg_knowledge_asset_publish', { name: 'doc', publishEpochs: 1.9 }),
    ).rejects.toThrow();
  });

  it('finalize rejects a non-integral schemeVersion at the schema boundary (CONTRACT §C)', async () => {
    await expect(
      server.call('dkg_knowledge_asset_finalize', { name: 'doc', schemeVersion: 1.9 }),
    ).rejects.toThrow();
  });

  it('pull_from seeds a fresh WM draft from swm/vm with layer + onConflict', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetPullFrom: async (args) => {
        Object.assign(captured, args);
        return { wmDraft: 'open', seededFrom: { layer: args.layer } };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_pull_from', {
      name: 'doc',
      layer: 'swm',
      onConflict: 'replace',
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Seeded a WM draft for knowledge asset 'doc'.*from SWM/s);
    expect(captured.layer).toBe('swm');
    expect(captured.onConflict).toBe('replace');
  });

  it('pull_from rejects an invalid layer at the schema boundary (swm|vm enum)', async () => {
    await expect(
      server.call('dkg_knowledge_asset_pull_from', { name: 'doc', layer: 'wm' }),
    ).rejects.toThrow();
  });

  it('pull_from surfaces 409 WM_DRAFT_CONFLICT verbatim onto a dirty draft', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'doc' });
    await server.call('dkg_knowledge_asset_write', {
      name: 'doc',
      quads: [{ subject: 'urn:a', predicate: 'urn:p', object: '"v"' }],
    });
    const res = await server.call('dkg_knowledge_asset_pull_from', { name: 'doc', layer: 'vm' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('WM_DRAFT_CONFLICT');
  });

  it('atomic share seals the complete KA and makes it publishable', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'multi' });
    await server.call('dkg_knowledge_asset_write', {
      name: 'multi',
      quads: [
        { subject: 'urn:a', predicate: 'urn:p', object: '"a"' },
        { subject: 'urn:b', predicate: 'urn:p', object: '"b"' },
      ],
    });
    const full = await server.call('dkg_knowledge_asset_share', { name: 'multi' });
    expect(full.isError).toBeFalsy();
    expect(client.assertions.get('test-cg::multi')!.finalized).toBe(true);

    const ok = await server.call('dkg_knowledge_asset_publish', { name: 'multi' });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('"ual"');
  });

  it('explicit finalize before atomic share also makes publish succeed', async () => {
    await server.call('dkg_knowledge_asset_create', { name: 'sealed' });
    await server.call('dkg_knowledge_asset_write', {
      name: 'sealed',
      quads: [{ subject: 'urn:a', predicate: 'urn:p', object: '"a"' }],
    });
    await server.call('dkg_knowledge_asset_finalize', { name: 'sealed' });
    await server.call('dkg_knowledge_asset_share', { name: 'sealed' });
    const res = await server.call('dkg_knowledge_asset_publish', { name: 'sealed' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('"ual"');
  });

  // ── Atomic-share boundary + defensive mixed-version warnings ──

  it('share rejects skipSeal before invoking the client', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetShare: async (args) => {
        Object.assign(captured, args);
        return { swmShared: true, promotedCount: 1, sealed: false, publishReady: false };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    await expect(
      localServer.call('dkg_knowledge_asset_share', { name: 'doc', skipSeal: true }),
    ).rejects.toThrow();
    expect(captured).toEqual({});
  });

  it('share with publishReady:false emits an atomic retry warning', async () => {
    const localClient = new FakeClient({
      knowledgeAssetShare: async () => ({ swmShared: true, promotedCount: 2, sealed: false, publishReady: false }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_share', { name: 'doc' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('did not become publish-ready (sealed:false)');
    expect(res.content[0].text).toContain('retry the complete Knowledge Asset share');
  });

  it('share with sealed:true + publishReady:false emits the incomplete atomic warning', async () => {
    const localClient = new FakeClient({
      knowledgeAssetShare: async () => ({ swmShared: true, promotedCount: 1, sealed: true, publishReady: false }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_share', { name: 'doc' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('complete sealed Knowledge Asset did not reach SWM');
    expect(res.content[0].text).toContain('retry the atomic share');
  });

  it('share with publishReady:true emits NO warning, reports sealed + publish-ready (#1116)', async () => {
    const localClient = new FakeClient({
      knowledgeAssetShare: async () => ({ swmShared: true, promotedCount: 2, sealed: true, publishReady: true }),
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_share', { name: 'doc' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('sealed:true, publish-ready');
    expect(res.content[0].text).not.toContain('NOT publish-ready');
  });

  it('share surfaces a 409 UNSEALED_SHARE_BLOCKED recovery verbatim (#1116)', async () => {
    const recovery = 'No local signing key; pass skipSeal:true to share unsealed.';
    const localClient = new FakeClient({
      knowledgeAssetShare: async () => {
        throw new DkgHttpError(409, { code: 'UNSEALED_SHARE_BLOCKED', recovery }, 'share failed');
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_share', { name: 'doc' });
    expect(res.isError).toBe(true);
    // The handler surfaces the daemon's recovery hint verbatim as the tool error.
    expect(res.content[0].text).toBe(recovery);
  });

  it('share falls back to the generic error for a non-matching 409 (#1116)', async () => {
    const localClient = new FakeClient({
      knowledgeAssetShare: async () => {
        throw new DkgHttpError(409, { code: 'SOMETHING_ELSE' }, 'other 409');
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const res = await localServer.call('dkg_knowledge_asset_share', { name: 'doc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Failed to share knowledge asset/);
  });

  it('finalize accepts the harmless legacy WM layer and omits it from the client call', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetFinalize: async (args) => {
        Object.assign(captured, args);
        return { merkleRoot: '0xroot', eip712Digest: '0xdig', authorAddress: '0xtoken' };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_knowledge_asset_finalize', {
      name: 'doc',
      layer: 'wm',
    });
    expect(result.isError).toBeFalsy();
    expect(captured).toMatchObject({ name: 'doc', contextGraphId: 'test-cg' });
    expect(captured).not.toHaveProperty('layer');
  });

  it('finalize rejects the retired SWM layer before invoking the client', async () => {
    const captured: Record<string, unknown> = {};
    const localClient = new FakeClient({
      knowledgeAssetFinalize: async (args) => {
        Object.assign(captured, args);
        return { merkleRoot: '0xroot', eip712Digest: '0xdig', authorAddress: '0xtoken' };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    await expect(
      localServer.call('dkg_knowledge_asset_finalize', { name: 'doc', layer: 'swm' }),
    ).rejects.toThrow();
    expect(captured).toEqual({});
  });

  it('finalize rejects an invalid layer at the schema boundary (wm|swm enum) (#1116)', async () => {
    await expect(
      server.call('dkg_knowledge_asset_finalize', { name: 'doc', layer: 'vm' }),
    ).rejects.toThrow();
  });

  it('finalize rejects a NON-STRING layer at the schema boundary (zod enum, no String() coercion) (#1116)', async () => {
    // Parity with the OpenClaw/Hermes non-string-layer guard: the MCP zod
    // .enum(['wm','swm']) rejects a present non-string structurally (it never
    // String()-coerces ['swm'] → 'swm' and forwards it).
    for (const bad of [true, ['swm'], 1, { l: 'swm' }] as unknown[]) {
      await expect(
        server.call('dkg_knowledge_asset_finalize', { name: 'doc', layer: bad as never }),
      ).rejects.toThrow();
    }
  });
});

describe('dkg_knowledge_asset_import_file — wave-2 P1 add', () => {
  let server: FakeServer;
  let client: FakeClient;
  let tempDir: string;

  beforeEach(async () => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    tempDir = await mkdtemp(path.join(tmpdir(), 'dkg-mcp-test-'));
  });

  it('reads a local markdown file and forwards it to the daemon with inferred MIME', async () => {
    const filePath = path.join(tempDir, 'notes.md');
    await writeFile(filePath, '# Hello\n\nA short markdown doc.\n', 'utf-8');

    const captured: Record<string, unknown> = {};
    client = new FakeClient({
      importAssertionFile: async (args) => {
        captured.assertionName = args.assertionName;
        captured.contentType = args.contentType;
        captured.fileName = args.fileName;
        captured.bytes = args.fileBuffer.byteLength;
        return { extraction: { status: 'completed', tripleCount: 3 } };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_knowledge_asset_import_file', {
      name: 'imported',
      filePath,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Imported 'notes\.md'/);
    expect(result.content[0].text).toMatch(/3 triple\(s\)/);
    expect(captured.contentType).toBe('text/markdown');
    expect(captured.fileName).toBe('notes.md');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('surfaces a tool error when the file path does not exist', async () => {
    const result = await server.call('dkg_knowledge_asset_import_file', {
      name: 'missing',
      filePath: path.join(tempDir, 'no-such-file.md'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to read file/);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('dkg_knowledge_asset_history — wave-2 P3 add', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('returns the lifecycle JSON block for a known assertion', async () => {
    const result = await server.call('dkg_knowledge_asset_history', { name: 'session-2026' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/History for assertion 'session-2026'/);
    expect(result.content[0].text).toContain('"author": "urn:dkg:agent:test"');
  });
});
