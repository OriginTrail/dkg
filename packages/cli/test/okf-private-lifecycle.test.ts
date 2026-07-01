import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  bodyOf,
  callPath,
  callPaths,
  ensureOkfCliBuilt,
  knowledgeAssetCreateBodies,
  knowledgeAssetShareBodies,
  knowledgeAssetWriteBodies,
  makeBundle,
  makeLargeTaggedBundle,
  makeOkfCliHome,
  manifestFor,
  okfDaemonHandler,
  parseJsonTail,
  runCli,
  startStub,
  subjectBelongsToOkfConcept,
  type StubHandler,
  writtenQuadsFor,
} from './okf-test-helpers';

// Focused private OKF lifecycle coverage: per-concept import, private CG
// safety, resumability checkpoints, and large-concept chunk/retry behavior.

describe.sequential('dkg okf private lifecycle', { timeout: 180_000 }, () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let dkgHome: string;
  const createdCGs = new Set<string>();

  beforeAll(async () => {
    await ensureOkfCliBuilt();
    stub = await startStub();
    stub.setHandler(okfDaemonHandler(createdCGs));
    dkgHome = await makeOkfCliHome(stub.port);
  }, 120_000);

  afterAll(async () => {
    if (stub) await stub.close();
    if (dkgHome) await rm(dkgHome, { recursive: true, force: true });
  });

  const env = () => ({ DKG_API_PORT: String(stub.port), DKG_HOME: dkgHome });
  const clear = () => {
    stub.calls.length = 0;
  };

  it('--private imports every concept as its own lifecycle KA in a private CG', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.importMode).toBe('per-concept');
    expect(out.memoryLayer).toBe('SWM');
    expect(out.triplesWritten).toBeGreaterThan(0);
    expect(out.assetsCreated).toBe(2);
    expect(out.assetsShared).toBe(2);
    expect(out.assetName).toBeUndefined();

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(createBodies.every((b) => b.quads === undefined && b.alsoShareSwm === undefined)).toBe(true);
    const writeBodies = ['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(stub.calls, name));
    expect(writeBodies).toHaveLength(2);
    expect(writeBodies.every((b) => Array.isArray(b.quads) && b.quads.length > 0)).toBe(true);
    const aQuads = writtenQuadsFor(stub.calls, 'a');
    const bQuads = writtenQuadsFor(stub.calls, 'b');
    expect(aQuads.every((q) => subjectBelongsToOkfConcept(q.subject, 'a'))).toBe(true);
    expect(bQuads.every((q) => subjectBelongsToOkfConcept(q.subject, 'b'))).toBe(true);
    expect(aQuads.length + bQuads.length).toBe(out.triplesWritten);
    expect(aQuads.length + bQuads.length).toBe(out.triples);
    expect(paths.filter((p) => p.endsWith('/wm/finalize'))).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith('/swm/share'))).toHaveLength(2);
    const shareBodies = ['a', 'b'].flatMap((name) => knowledgeAssetShareBodies(stub.calls, name));
    expect(shareBodies).toHaveLength(2);
    expect(shareBodies.every((b) => b.entities === 'all')).toBe(true);
    expect(paths.some((p) => /private-bulk/.test(p))).toBe(false);
    expect(paths.some((p) => p.startsWith('POST /api/shared-memory'))).toBe(false);

    // PRIVACY CONTRACT: the Context Graph must be created invite-only. A regression
    // that dropped `{ private: true, accessPolicy: 1 }` would import the corpus
    // into a public CG — exactly the substance-leak this mode must prevent.
    const createCall = stub.calls.find(
      (c) => c.method === 'POST' && callPath(c) === '/api/context-graph/create',
    );
    expect(createCall).toBeDefined();
    const createBody = bodyOf(createCall!);
    expect(createBody.private).toBe(true);
    expect(createBody.accessPolicy).toBe(1);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.assetName).toBeUndefined();
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private resumes per-concept WM stages by sharing without recreating or rewriting', async () => {
    clear();
    const bundle = await makeBundle();
    createdCGs.add('cg-priv-resume');
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-priv-resume',
          mode: 'per-concept',
          stages: { a: 'wm' },
        },
        null,
        2,
      ),
    );
    const knownAssets = new Set(['a']);
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets') {
        const name = JSON.parse(raw || '{}').name;
        if (typeof name === 'string') knownAssets.add(name);
      }
      const lifecycle = url.pathname.match(/^\/api\/knowledge-assets\/([^/]+)\/(?:wm\/finalize|swm\/share)$/);
      if (req.method === 'POST' && lifecycle && !knownAssets.has(decodeURIComponent(lifecycle[1]))) {
        return { status: 404, body: { error: 'unknown asset' } };
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-resume', '--private'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.importMode).toBe('per-concept');
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(2);

    const paths = callPaths(stub.calls);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name)).toEqual(['b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);
    expect(paths).toContain('POST /api/knowledge-assets/a/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/a/swm/share');
    expect(paths.some((p) => p === 'POST /api/knowledge-assets/a/wm/write')).toBe(false);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });

    stub.setHandler(okfDaemonHandler(createdCGs));
  });

  it('--private records finalized progress before a failed share and resumes without rewriting', async () => {
    clear();
    const bundle = await makeBundle();
    let failFirstShare = true;
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/a/swm/share' && failFirstShare) {
        failFirstShare = false;
        return { status: 200, body: { swmShared: false, promotedCount: 0 } };
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const failed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-share-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain('share did not report swmShared:true');
    let manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'finalized' });

    clear();
    stub.setHandler(okfDaemonHandler(createdCGs));
    const resumed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-share-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(resumed.exitCode).toBe(0);
    const paths = callPaths(stub.calls);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name)).toEqual(['b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);
    expect(paths).toContain('POST /api/knowledge-assets/a/swm/share');
    expect(paths).not.toContain('POST /api/knowledge-assets/a/wm/finalize');
    expect(paths.some((p) => p === 'POST /api/knowledge-assets/a/wm/write')).toBe(false);
    manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private ignores real bulk-private-lifecycle manifests and starts per-concept lifecycle', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-priv-legacy',
          mode: 'bulk-private-lifecycle',
          assetName: 'okf-private-bulk-root',
          chunkSize: 5000,
          chunksDone: 999,
          totalChunks: 999,
          draftCreated: true,
          finalized: true,
          shared: true,
        },
        null,
        2,
      ),
    );

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-legacy', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(2);
    expect(r.stderr).toContain('ignoring incompatible OKF manifest');

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    expect(paths.some((p) => p.includes('okf-private-bulk-root'))).toBe(false);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
    expect(manifest.assetName).toBeUndefined();
  });

  it('--private forwards --sub-graph-name through lifecycle bodies + manifest', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-sg', '--sub-graph-name', 'team', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    // Every lifecycle call must carry the sub-graph so data lands in cg/team SWM, not root.
    const lifecycleCalls = stub.calls.filter((c) =>
      c.method === 'POST' && callPath(c).startsWith('/api/knowledge-assets'),
    );
    expect(lifecycleCalls.length).toBeGreaterThan(0);
    for (const call of lifecycleCalls) expect(bodyOf(call).subGraphName).toBe('team');
    // The resumability manifest records the sub-graph (so a resume can't mix root/sub-graph).
    const manifest = await manifestFor(bundle);
    expect(manifest.subGraphName).toBe('team');
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
    expect(manifest.assetName).toBeUndefined();
  });

  it('--private refuses ambiguous legacy/root manifests when importing a sub-graph target', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-sg-isolated',
          mode: 'per-concept',
          stages: { a: 'swm', b: 'swm' },
        },
        null,
        2,
      ),
    );

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-sg-isolated', '--sub-graph-name', 'team', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('belongs to the root context graph');
    expect(stub.calls.some((c) => {
      const path = callPath(c);
      return c.method === 'POST' && (path === '/api/knowledge-assets' || path.startsWith('/api/knowledge-assets/'));
    })).toBe(false);
    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
    expect(manifest.subGraphName).toBeUndefined();
  });

  it('refuses root imports that would overwrite a sub-graph manifest', async () => {
    clear();
    const bundle = await makeBundle();
    createdCGs.add('cg-root-mismatch');
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-root-mismatch',
          subGraphName: 'team',
          mode: 'per-concept',
          stages: { a: 'swm', b: 'draft' },
        },
        null,
        2,
      ),
    );

    const r = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-root-mismatch', '--share'], env());
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('belongs to sub-graph "team"');
    expect(stub.calls.some((c) => {
      const path = callPath(c);
      return c.method === 'POST' && (path === '/api/knowledge-assets' || path.startsWith('/api/knowledge-assets/'));
    })).toBe(false);
    const manifest = await manifestFor(bundle);
    expect(manifest.subGraphName).toBe('team');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'draft' });
  });

  it('--private uses chunked lifecycle for concepts over the write chunk contract', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-large', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(1);

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(1);
    const createBody = knowledgeAssetCreateBodies(stub.calls)[0];
    expect(createBody.quads).toBeUndefined();
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets/bulk/wm/write')).toHaveLength(2);
    const writeLengths = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0);
    expect(writeLengths.every((length) => length <= 5000)).toBe(true);
    const totalWritten = writeLengths.reduce((sum, length) => sum + length, 0);
    expect(totalWritten).toBe(out.triplesWritten);
    expect(totalWritten).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    expect(paths.some((p) => /private-bulk/.test(p))).toBe(false);
  });

  it('--private discards and replays a draft after a mid-concept write failure', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();
    const manifestPath = join(bundle, '.okf-import-manifest.json');
    const acceptedBeforeFailure: number[] = [];
    let writeAttempts = 0;
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/bulk/wm/write') {
        writeAttempts += 1;
        const quads = JSON.parse(raw || '{}').quads ?? [];
        if (writeAttempts === 2) {
          return { status: 500, body: { error: 'simulated write failure' } };
        }
        acceptedBeforeFailure.push(quads.length);
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const failed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-mid-write-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(failed.exitCode).not.toBe(0);
    expect(acceptedBeforeFailure).toEqual([5000]);
    expect(existsSync(manifestPath)).toBe(true);
    let manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'draft' });

    clear();
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/bulk/wm/discard') {
        return { status: 503, body: { error: 'discard unavailable' } };
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });
    const discardFailed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-mid-write-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(discardFailed.exitCode).not.toBe(0);
    let paths = callPaths(stub.calls);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/discard');
    expect(paths).not.toContain('POST /api/knowledge-assets');
    expect(paths).not.toContain('POST /api/knowledge-assets/bulk/wm/write');
    expect(paths).not.toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).not.toContain('POST /api/knowledge-assets/bulk/swm/share');
    manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'draft' });

    clear();
    stub.setHandler(okfDaemonHandler(createdCGs));
    const retried = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-mid-write-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(retried.exitCode).toBe(0);
    const out = parseJsonTail(retried.stdout);
    paths = callPaths(stub.calls);
    const discardIndex = paths.indexOf('POST /api/knowledge-assets/bulk/wm/discard');
    const createIndex = paths.indexOf('POST /api/knowledge-assets');
    const firstWriteIndex = paths.indexOf('POST /api/knowledge-assets/bulk/wm/write');
    expect(discardIndex).toBeGreaterThanOrEqual(0);
    expect(discardIndex).toBeLessThan(createIndex);
    expect(createIndex).toBeLessThan(firstWriteIndex);
    const writeTotal = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0)
      .reduce((sum, length) => sum + length, 0);
    expect(writeTotal).toBe(out.triplesWritten);
    expect(writeTotal).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'swm' });
  });

  it('--private continues draft replay when discard reports no draft', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-priv-discard-404',
          mode: 'per-concept',
          stages: { a: 'draft' },
        },
        null,
        2,
      ),
    );
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/a/wm/discard') {
        return { status: 404, body: { error: 'no draft' } };
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-discard-404', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(2);
    expect(out.assetsShared).toBe(2);

    const paths = callPaths(stub.calls);
    const discardIndex = paths.indexOf('POST /api/knowledge-assets/a/wm/discard');
    const createIndex = paths.indexOf('POST /api/knowledge-assets');
    expect(discardIndex).toBeGreaterThanOrEqual(0);
    expect(discardIndex).toBeLessThan(createIndex);
    expect(knowledgeAssetCreateBodies(stub.calls).map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'a')).toHaveLength(1);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);
    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });

    stub.setHandler(okfDaemonHandler(createdCGs));
  });

  it('--private recursively splits oversized lifecycle write chunks on 413', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();
    const acceptedWriteSizes: number[] = [];
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/bulk/wm/write') {
        const quads = JSON.parse(raw || '{}').quads ?? [];
        if (quads.length > 1000) {
          return { status: 413, body: { error: 'payload too large' } };
        }
        acceptedWriteSizes.push(quads.length);
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-write-split', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(1);

    const paths = callPaths(stub.calls);
    const writeLengths = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0);
    expect(writeLengths).toContain(5000);
    expect(writeLengths.some((length) => length > 1000)).toBe(true);
    expect(acceptedWriteSizes.length).toBeGreaterThan(2);
    expect(acceptedWriteSizes.every((length) => length <= 1000)).toBe(true);
    const acceptedTotal = acceptedWriteSizes.reduce((sum, length) => sum + length, 0);
    expect(acceptedTotal).toBe(out.triplesWritten);
    expect(acceptedTotal).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'swm' });

    stub.setHandler(okfDaemonHandler(createdCGs));
  });

  it('refuses --private into an existing PUBLIC Context Graph; --allow-public-context-graph overrides', async () => {
    clear();
    const bundle = await makeBundle();
    const publicCgHandler: StubHandler = (req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/context-graph/exists') {
        return { status: 200, body: { id: url.searchParams.get('id'), exists: true } };
      }
      if (req.method === 'GET' && path === '/api/context-graph/list') {
        return { status: 200, body: { contextGraphs: [{ id: 'cg-pub', accessPolicy: 'public' }] } };
      }
      return okfDaemonHandler(createdCGs)(req, raw); // everything else succeeds
    };
    stub.setHandler(publicCgHandler);

    // Refusal: non-zero exit, and NO knowledge-asset mutation happened.
    const refused = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-pub', '--private'], env());
    expect(refused.exitCode).not.toBe(0);
    expect(stub.calls.some((c) => {
      const path = callPath(c);
      return c.method === 'POST' && (path === '/api/knowledge-assets' || path.startsWith('/api/knowledge-assets/'));
    })).toBe(false);
    expect(refused.stderr).toMatch(/Refusing --private/);

    // Override: --allow-public-context-graph proceeds and writes.
    const before = stub.calls.length;
    const allowed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-pub', '--private', '--allow-public-context-graph'],
      env(),
    );
    expect(allowed.exitCode).toBe(0);
    const allowedCalls = stub.calls.slice(before);
    expect(knowledgeAssetCreateBodies(allowedCalls).map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(allowedCalls, name))).toHaveLength(2);

    stub.setHandler(okfDaemonHandler(createdCGs));
  });

});
