// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  contextGraphLayerUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import {
  RFC64_RUNTIME_EVIDENCE_V1,
  RUNTIME_PACKAGE_CLOSURE,
  assertExecutedRuntimeMatchesBuildV1,
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
  buildRuntimeManifestV1,
} from '../../../devnet/rfc64-runtime-provenance.mts';
import { createRuntimeLoadEvidenceV1 } from
  '../../../devnet/rfc64-runtime-load-evidence.mts';

import {
  Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1,
  Rfc64PublicCatalogNativeTransportErrorV1,
} from '@origintrail-official/dkg-agent';
import {
  classifyExpectedPrivateCatalogDenialV1,
  isExpectedPrivateCatalogDenialResultV1,
} from '../devnet/rfc64-private-catalog/denial-evidence.mjs';
import {
  assertRfc64PrivateGatePassProvenanceV1,
  runRfc64PrivateGateArtifactLifecycleV1,
} from '../devnet/rfc64-private-catalog/gate-artifact.mjs';
import { runRfc64PrivateGateFromCleanBuildV1 } from '../devnet/rfc64-private-catalog/clean-launch.js';
import {
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
  assertRfc64PrivateRuntimeProvenanceV1,
  buildRfc64PrivateRuntimeProvenanceV1,
  createRfc64PrivateRuntimeEvidenceCollectorV1,
} from '../devnet/rfc64-private-catalog/runtime-provenance.mjs';
import {
  AgentChild,
  executeRfc64PrivateReleaseGateV1,
  hasExactMemoryContents,
} from '../devnet/rfc64-private-catalog/run.mjs';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  PROJECTION_EVIDENCE,
  PROJECTION_NQUADS,
  PROJECTION_QUADS,
  roleAgentAddress,
} from '../devnet/rfc64-private-catalog/fixture.mjs';
import {
  bindGraphlessProjectionToGraph,
  hasExactPrivateCatalogMemoryContents,
  readExactGraphMemoryEvidence,
  readPrivateCatalogGraphCountEvidence,
} from '../devnet/rfc64-private-catalog/memory-evidence.mjs';

const temporaryRoots: string[] = [];
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const RUNTIME_FILES = Object.freeze([
  'packages/agent/dist/index.js',
  'packages/chain/dist/index.js',
  'packages/core/dist/index.js',
  'packages/storage/dist/index.js',
].map((path, index) => Object.freeze({
  byteLength: index + 1,
  path,
  sha256: `0x${String(index + 1).repeat(64)}`,
})));

function runtimeProvenance(sourceRevision: string) {
  const sourceBuild = buildRuntimeManifestFromEntriesV1(sourceRevision, RUNTIME_FILES);
  const loaded = buildExecutedRuntimeManifestV1(sourceRevision, RUNTIME_FILES);
  return buildRfc64PrivateRuntimeProvenanceV1(
    sourceBuild,
    RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({ id, loaded })),
  );
}

function runtimeManifest(sourceRevision: string, marker: string) {
  return {
    manifestDigest: `0x${marker.repeat(64)}`,
    sourceCommit: sourceRevision,
  } as never;
}

// Independent oracle: these bytes and this digest are intentionally NOT
// produced by memory-evidence.mjs. If canonicalization drops or rewrites any
// term, the fixture/helper assertions below fail together against this pin.
const EXPECTED_PROJECTION_NQUADS =
  '<https://example.org/alice> <https://schema.org/age> ' +
  '"42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n' +
  '<https://example.org/alice> <https://schema.org/name> "Alice" .';
const EXPECTED_PROJECTION_EVIDENCE = Object.freeze({
  count: 2,
  digest: 'babf6f5fe8b4028a569792682dc3775c7410a853adfeb4e55ecea14d5ba0445f',
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('RFC-64 private release gate artifact lifecycle', () => {
  it('rejects persisted runtime provenance before admitting the typed model', () => {
    expect(() => assertRfc64PrivateRuntimeProvenanceV1(null))
      .toThrow(/must be an object/u);
    expect(() => assertRfc64PrivateRuntimeProvenanceV1([]))
      .toThrow(/must be an object/u);
    expect(() => assertRfc64PrivateRuntimeProvenanceV1({
      schema: 'dkg-rfc64-private-runtime-provenance-v1',
      processes: [],
      sourceBuild: null,
    })).toThrow(/source manifest must be an object/u);

    const valid = runtimeProvenance('1'.repeat(40));
    expect(() => assertRfc64PrivateRuntimeProvenanceV1({
      ...valid,
      sourceBuild: {},
    })).toThrow(/source manifest is missing data field build/u);
    expect(() => assertRfc64PrivateRuntimeProvenanceV1({
      ...valid,
      processes: [{}],
    })).toThrow(/runtime process 0 is missing data field id/u);
    expect(() => assertRfc64PrivateRuntimeProvenanceV1({
      ...valid,
      processes: valid.processes.map((entry, index) => index === 0
        ? { ...entry, loaded: {} }
        : entry),
    })).toThrow(/loaded manifest is missing data field manifestDigest/u);
  });

  it('writes a successful PASS with exact run and source provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-artifact-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    const timestamps = [
      new Date('2026-08-26T00:00:00.000Z'),
      new Date('2026-08-26T00:00:01.000Z'),
    ];

    const provenance = runtimeProvenance('b'.repeat(40));
    const artifact = await runRfc64PrivateGateArtifactLifecycleV1({
      artifactPath,
      resolveSourceRevision: () => 'b'.repeat(40),
      now: () => timestamps.shift() ?? new Date('2026-08-26T00:00:02.000Z'),
      execute: async () => ({
        schema: 'dkg-rfc64-private-release-gate-v1',
        status: 'PASS',
        checks: { strict: true },
        runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
        runtimeProvenance: provenance,
      }),
    });

    expect(artifact).toMatchObject({
      status: 'PASS',
      startedAt: '2026-08-26T00:00:00.000Z',
      finishedAt: '2026-08-26T00:00:01.000Z',
      sourceRevision: 'b'.repeat(40),
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
    });
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toEqual(artifact);
    expect(() => assertRfc64PrivateGatePassProvenanceV1(artifact)).not.toThrow();
  });

  it('rejects PASS provenance with a missing revision or invalid run interval', () => {
    const provenance = runtimeProvenance('c'.repeat(40));
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision: 'c'.repeat(40),
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      sourceRevision: null,
    })).toThrow(/exact source revision/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      finishedAt: '2026-08-25T23:59:59.000Z',
    })).toThrow(/precedes/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeManifestDigest: null,
    })).toThrow(/runtime manifest digest/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: null,
    })).toThrow(/runtime provenance is incomplete/u);
  });

  it('rejects syntactically valid outer provenance bindings that differ from the runtime proof', () => {
    const sourceRevision = 'c'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };

    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      sourceRevision: 'd'.repeat(40),
    })).toThrow(/not source-bound/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeManifestDigest: `0x${'f'.repeat(64)}`,
    })).toThrow(/not source-bound/u);
  });

  it('rejects non-canonical clean-build and executed-runtime hash claims', () => {
    const sourceRevision = 'd'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: {
        ...provenance,
        sourceBuild: {
          ...provenance.sourceBuild,
          runtimeFiles: provenance.sourceBuild.runtimeFiles.map((entry, index) => index === 0
            ? { ...entry, sha256: `0x${'a'.repeat(64)}` }
            : entry),
        },
      },
    })).toThrow(/runtime provenance is incomplete/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: {
        ...provenance,
        processes: provenance.processes.map((processEvidence, index) => index === 0
          ? {
              ...processEvidence,
              loaded: {
                ...processEvidence.loaded,
                manifestDigest: `0x${'e'.repeat(64)}`,
              },
            }
          : processEvidence),
      },
    })).toThrow(/runtime provenance is incomplete/u);
  });

  it('rejects every mutation of the fixed nine-process topology', () => {
    const sourceRevision = 'e'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
    };
    const swapped = [...provenance.processes];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const mutations = [
      { ...provenance, processes: provenance.processes.slice(0, -1) },
      { ...provenance, processes: [...provenance.processes, provenance.processes[0]] },
      { ...provenance, processes: swapped },
      {
        ...provenance,
        processes: provenance.processes.map((entry, index) => index === 0
          ? { ...entry, id: 'renamed-process' }
          : entry),
      },
      { ...provenance, schema: 'wrong-runtime-provenance-schema' },
    ];

    for (const runtimeProvenanceMutation of mutations) {
      expect(() => assertRfc64PrivateGatePassProvenanceV1({
        ...base,
        runtimeProvenance: runtimeProvenanceMutation,
      })).toThrow(/runtime provenance is incomplete/u);
    }
  });

  it('assembles all nine shutdown receipts in canonical process order and rejects omissions', () => {
    const sourceRevision = 'f'.repeat(40);
    const sourceBuild = buildRuntimeManifestFromEntriesV1(sourceRevision, RUNTIME_FILES);
    const loaded = buildExecutedRuntimeManifestV1(sourceRevision, RUNTIME_FILES);
    const collector = createRfc64PrivateRuntimeEvidenceCollectorV1(sourceBuild);
    for (const id of RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1) {
      collector.record(id, {
        exit: { code: 0, signal: null, error: null },
        executedRuntimeManifest: structuredClone(loaded),
      });
    }

    expect(collector.seal().processes.map(({ id }) => id)).toEqual(
      RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
    );

    const incomplete = createRfc64PrivateRuntimeEvidenceCollectorV1(sourceBuild);
    for (const id of RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.slice(0, -1)) {
      incomplete.record(id, { executedRuntimeManifest: structuredClone(loaded) });
    }
    expect(() => incomplete.seal()).toThrow(/missing process: receiver-restart/u);
  });

  it('replaces a stale PASS before work and publishes sanitized FAIL on early failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-artifact-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(artifactPath, JSON.stringify({
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      secretMarker: 'prior-pass-must-not-survive',
    }));

    const timestamps = [
      new Date('2026-08-26T00:00:00.000Z'),
      new Date('2026-08-26T00:00:01.000Z'),
    ];
    const sensitiveMessage = 'wallet material must never enter the artifact';
    let startingArtifact: Record<string, unknown> | null = null;

    await expect(runRfc64PrivateGateArtifactLifecycleV1({
      artifactPath,
      resolveSourceRevision: () => 'A'.repeat(40),
      now: () => timestamps.shift() ?? new Date('2026-08-26T00:00:02.000Z'),
      execute: async () => {
        startingArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
        throw Object.assign(new Error(sensitiveMessage), { code: 'owner-start-failed' });
      },
    })).rejects.toThrow(sensitiveMessage);

    expect(startingArtifact).toMatchObject({
      status: 'INCOMPLETE',
      phase: 'starting',
      sourceRevision: null,
    });
    const rawFailureArtifact = await readFile(artifactPath, 'utf8');
    expect(rawFailureArtifact).not.toContain('prior-pass-must-not-survive');
    expect(rawFailureArtifact).not.toContain(sensitiveMessage);
    expect(rawFailureArtifact).not.toContain('owner-start-failed');
    expect(JSON.parse(rawFailureArtifact)).toMatchObject({
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'FAIL',
      phase: 'failed',
      failure: {
        failureClass: 'gate-execution-failed',
      },
      sourceRevision: 'a'.repeat(40),
    });
  });

  it('invalidates stale PASS before rejecting a dirty tracked tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-dirty-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', stale: true }));
    const build = vi.fn();

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute: vi.fn(),
      dependencies: {
        resolveSourceRevision: () => '1'.repeat(40),
        readCleanSourceRevision: () => { throw new Error('tracked tree is dirty'); },
        runCleanRuntimeBuild: build,
      },
    })).rejects.toThrow(/tracked tree is dirty/u);

    expect(build).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision: '1'.repeat(40),
    });
  });

  it('invalidates stale PASS before source revision resolution fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-head-failure-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', stale: true }));

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute: vi.fn(),
      dependencies: {
        resolveSourceRevision: () => { throw new Error('git metadata unavailable'); },
      },
    })).rejects.toThrow(/git metadata unavailable/u);

    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision: null,
    });
  });

  it('rejects an untracked runtime source before build or execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-untracked-source-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    await mkdir(join(root, 'packages', 'agent', 'src'), { recursive: true });
    await writeFile(join(root, 'packages', 'agent', 'package.json'), '{"name":"fixture"}\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'rfc64-gate@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'RFC64 Gate Test'], { cwd: root });
    execFileSync('git', ['add', 'packages/agent/package.json'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    await writeFile(
      join(root, 'packages', 'agent', 'src', 'injected.ts'),
      'export const injected = true;\n',
    );
    const build = vi.fn();
    const execute = vi.fn();

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute,
      dependencies: {
        resolveSourceRevision: () => sourceRevision,
        runCleanRuntimeBuild: build,
      },
    })).rejects.toThrow(/untracked runtime build inputs/u);

    expect(build).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision,
    });
  });

  it('publishes FAIL when runtime bytes change after child execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-stale-dist-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    const sourceRevision = '2'.repeat(40);
    const first = runtimeManifest(sourceRevision, '3');
    const changed = runtimeManifest(sourceRevision, '4');
    let manifestReads = 0;

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute: async ({ runtimeManifest: cleanBuild }) => ({
        schema: 'dkg-rfc64-private-release-gate-v1',
        status: 'PASS',
        runtimeManifestDigest: cleanBuild.manifestDigest,
        runtimeProvenance: runtimeProvenance(sourceRevision),
      }),
      dependencies: {
        resolveSourceRevision: () => sourceRevision,
        readCleanSourceRevision: () => sourceRevision,
        runCleanRuntimeBuild: () => {},
        buildRuntimeManifest: () => (++manifestReads === 1 ? first : changed),
      },
    })).rejects.toThrow(/runtime manifest differs/u);

    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision,
    });
  });

  it('does not execute when the source changes during the clean build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-build-race-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    const sourceRevision = '5'.repeat(40);
    const revisions = [sourceRevision, '6'.repeat(40)];
    const build = vi.fn();
    const execute = vi.fn();

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute,
      dependencies: {
        resolveSourceRevision: () => sourceRevision,
        readCleanSourceRevision: () => revisions.shift()!,
        runCleanRuntimeBuild: build,
      },
    })).rejects.toThrow(/source HEAD changed/u);

    expect(build).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision,
    });
  });

  it('publishes FAIL when the source changes during live execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-execution-race-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    const sourceRevision = '7'.repeat(40);
    const revisions = [sourceRevision, sourceRevision, '8'.repeat(40)];
    const cleanBuild = runtimeManifest(sourceRevision, '9');
    const execute = vi.fn(async () => ({ status: 'PASS' }));

    await expect(runRfc64PrivateGateFromCleanBuildV1({
      artifactPath,
      repoRoot: root,
      execute,
      dependencies: {
        resolveSourceRevision: () => sourceRevision,
        readCleanSourceRevision: () => revisions.shift()!,
        runCleanRuntimeBuild: () => {},
        buildRuntimeManifest: () => cleanBuild,
      },
    })).rejects.toThrow(/source HEAD changed/u);

    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toMatchObject({
      status: 'FAIL',
      sourceRevision,
    });
  });
});

describe('RFC-64 private release gate process and denial evidence', () => {
  it('returns and seals the exact source bytes without delegating to a downstream loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-runtime-load-source-binding-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'packages', 'agent', 'dist', 'index.js');
    await mkdir(dirname(artifactPath), { recursive: true });
    const source = Buffer.from('export const marker = "sealed";\n');
    writeFileSync(artifactPath, source);
    const artifactUrl = pathToFileURL(artifactPath).href;
    const evidence = createRuntimeLoadEvidenceV1({
      repoRoot: root,
      sourceCommit: '9'.repeat(40),
    });
    evidence.resolve(artifactUrl, {} as never, () => ({
      format: 'module',
      url: artifactUrl,
    }));
    const nextLoad = vi.fn(() => ({
      format: 'module' as const,
      source: Buffer.from('export const marker = "tampered";\n'),
    }));

    const loaded = evidence.load(artifactUrl, { format: 'module' } as never, nextLoad);
    expect(nextLoad).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({ format: 'module', shortCircuit: true });
    expect(Buffer.from(loaded.source as Uint8Array)).toEqual(source);
    const manifest = evidence.createSealer(RFC64_RUNTIME_EVIDENCE_V1)();
    expect(manifest.runtimeFiles).toEqual([{
      byteLength: source.byteLength,
      path: 'packages/agent/dist/index.js',
      sha256: `0x${createHash('sha256').update(source).digest('hex')}`,
    }]);
  });

  it('rejects a package closure root symlink before measuring external runtime bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-runtime-closure-symlink-'));
    temporaryRoots.push(root);
    for (const pkg of RUNTIME_PACKAGE_CLOSURE) {
      const directory = join(root, pkg.path);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.js'), `export const packageName = ${JSON.stringify(pkg.name)};\n`);
    }
    const external = await mkdtemp(join(tmpdir(), 'rfc64-runtime-external-'));
    temporaryRoots.push(external);
    await writeFile(join(external, 'index.js'), 'export const injected = true;\n');
    const queryDist = join(root, 'packages', 'query', 'dist');
    await rm(queryDist, { recursive: true });
    await symlink(external, queryDist, 'dir');

    expect(() => buildRuntimeManifestV1(root, '8'.repeat(40))).toThrow(
      /closure root is a symbolic link/u,
    );
  });

  it('rejects runtime bytes replaced between resolution and the exact load boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-runtime-load-race-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'packages', 'agent', 'dist', 'index.js');
    await mkdir(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, 'export const marker = "clean";\n');
    const artifactUrl = pathToFileURL(artifactPath).href;
    const evidence = createRuntimeLoadEvidenceV1({
      repoRoot: root,
      sourceCommit: 'a'.repeat(40),
    });

    evidence.resolve(artifactUrl, {} as never, () => ({
      format: 'module',
      url: artifactUrl,
    }));
    writeFileSync(artifactPath, 'export const marker = "other";\n');

    expect(() => evidence.load(artifactUrl, {} as never, () => ({
      format: 'module',
      source: readFileSync(artifactPath),
    }))).toThrow(/changed between resolution and load/u);

    writeFileSync(artifactPath, 'export const marker = "clean";\n');
    expect(() => evidence.createSealer(RFC64_RUNTIME_EVIDENCE_V1)()).toThrow(
      /observed no workspace dist artifacts/u,
    );
  });

  it('launches and gracefully seals the production agent process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-provenance-child-'));
    temporaryRoots.push(root);
    const sourceRevision = 'a'.repeat(40);
    const cleanBuild = buildRuntimeManifestV1(REPO_ROOT, sourceRevision);
    const child = new AgentChild('production-probe', root, undefined, 'probe', {
      runtimeProvenance: {
        runtimeManifestDigest: cleanBuild.manifestDigest,
        sourceRevision,
      },
    });
    const ready = await child.waitFor('ready', { timeoutMs: 20_000 });
    expect(ready.runtimeBuildManifestDigest).toBe(cleanBuild.manifestDigest);

    const shutdown = await child.stop();
    expect(shutdown.exit).toMatchObject({ code: 0, error: null });
    expect(shutdown.executedRuntimeManifest).toBeDefined();
    expect(() => assertExecutedRuntimeMatchesBuildV1(
      shutdown.executedRuntimeManifest,
      cleanBuild,
    )).not.toThrow();
  }, 60000);

  it('feeds process-built SWM/VM evidence through the executable gate predicate', async () => {
    const store = new OxigraphStore();
    const authorAddress = roleAgentAddress('owner');
    try {
      const graphs = ASSET_NUMBERS.flatMap((kaNumber) => (
        [MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiableMemory].flatMap((layer) => {
          const graph = contextGraphLayerUri(
            CONTEXT_GRAPH_ID,
            layer,
            authorAddress,
            kaNumber,
          );
          return bindGraphlessProjectionToGraph(PROJECTION_QUADS, graph);
        })
      ));
      await store.insert(graphs);

      const graphCounts = await readPrivateCatalogGraphCountEvidence(store, {
        assetNumbers: ASSET_NUMBERS,
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress,
      });
      expect(hasExactMemoryContents({ graphCounts })).toBe(true);
      expect(hasExactMemoryContents({
        graphCounts: graphCounts.map((entry, index) => index === 0
          ? { ...entry, swmDigest: entry.vmDigest, vmDigest: '0'.repeat(64) }
          : entry),
      })).toBe(false);
      expect(hasExactMemoryContents({
        graphCounts: graphCounts.map((entry, index) => index === 1
          ? { ...entry, kaNumber: 43 }
          : entry),
      })).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('hashes real graph contents and rejects same-size semantic corruption', async () => {
    const graph = 'urn:rfc64:private-gate:test-memory';
    const store = new OxigraphStore();
    const projection = (name: string) => bindGraphlessProjectionToGraph(
      PROJECTION_QUADS.map((quad) => quad.predicate === 'https://schema.org/name'
        ? { ...quad, object: `"${name}"` }
        : quad),
      graph,
    );
    try {
      // Reverse fixture order: canonicalization, not insertion order, defines
      // the digest used by the process gate.
      const original = projection('Alice').reverse();
      await store.insert(original);
      const exact = await readExactGraphMemoryEvidence(store, graph);
      expect(PROJECTION_NQUADS).toBe(EXPECTED_PROJECTION_NQUADS);
      expect(PROJECTION_EVIDENCE).toEqual(EXPECTED_PROJECTION_EVIDENCE);
      expect(exact).toEqual(EXPECTED_PROJECTION_EVIDENCE);

      const exactGraphCounts = ASSET_NUMBERS.map((kaNumber) => ({
        kaNumber,
        swm: exact.count,
        swmDigest: exact.digest,
        vm: exact.count,
        vmDigest: exact.digest,
      }));
      const expected = {
        assetNumbers: ASSET_NUMBERS,
        projection: PROJECTION_EVIDENCE,
      };
      expect(hasExactPrivateCatalogMemoryContents(
        { graphCounts: exactGraphCounts },
        expected,
      )).toBe(true);
      // Identity substitution, multiplicity, and omission are independent
      // failures even when every surviving projection digest is authentic.
      expect(hasExactPrivateCatalogMemoryContents({
        graphCounts: exactGraphCounts.map((entry, index) => index === 1
          ? { ...entry, kaNumber: 43 }
          : entry),
      }, expected)).toBe(false);
      expect(hasExactPrivateCatalogMemoryContents({
        graphCounts: exactGraphCounts.map((entry) => ({ ...entry, kaNumber: 41 })),
      }, expected)).toBe(false);
      expect(hasExactPrivateCatalogMemoryContents({
        graphCounts: exactGraphCounts.slice(0, 1),
      }, expected)).toBe(false);

      const semanticCorruptions = [
        ['omitted age statement', PROJECTION_QUADS.slice(1)],
        ['omitted name statement', PROJECTION_QUADS.slice(0, 1)],
        ['changed subject', PROJECTION_QUADS.map((quad, index) => index === 0
          ? { ...quad, subject: 'https://example.org/bob' }
          : quad)],
        ['changed predicate', PROJECTION_QUADS.map((quad, index) => index === 0
          ? { ...quad, predicate: 'https://schema.org/birthDate' }
          : quad)],
        ['changed object', PROJECTION_QUADS.map((quad, index) => index === 0
          ? { ...quad, object: '"43"^^<http://www.w3.org/2001/XMLSchema#integer>' }
          : quad)],
      ] as const;
      for (const [label, quads] of semanticCorruptions) {
        await store.delete(original);
        const corruptedProjection = bindGraphlessProjectionToGraph(quads, graph);
        await store.insert(corruptedProjection);
        const evidence = await readExactGraphMemoryEvidence(store, graph);
        expect(evidence, label).not.toEqual(EXPECTED_PROJECTION_EVIDENCE);
        await store.delete(corruptedProjection);
        await store.insert(original);
      }

      await store.delete(original);
      await store.insert(projection('Mallory'));
      const corrupted = await readExactGraphMemoryEvidence(store, graph);
      expect(corrupted.count).toBe(PROJECTION_EVIDENCE.count);
      expect(corrupted.digest).not.toBe(PROJECTION_EVIDENCE.digest);
      expect(hasExactPrivateCatalogMemoryContents({
        graphCounts: exactGraphCounts.map((entry, index) => index === 0
          ? {
              ...entry,
              vm: corrupted.count,
              vmDigest: corrupted.digest,
            }
          : entry),
      }, expected)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('reaps a child that ignores the stop command and SIGTERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-stop-'));
    temporaryRoots.push(root);
    const child = new AgentChild('ignored-stop', root, undefined, 'ignored-stop', {
      agentProcess: join(HERE, 'fixtures', 'rfc64-private-catalog-ignored-stop-child.mjs'),
      stopHandshakeTimeoutMs: 25,
      gracefulExitTimeoutMs: 25,
      sigtermExitTimeoutMs: 25,
      sigkillExitTimeoutMs: 2_000,
    });
    await child.waitFor('ready', { timeoutMs: 2_000 });

    await expect(child.stop()).rejects.toThrow(/forced process exit completed/u);
    const exit = await child.exit;
    expect(exit.signal).toBe('SIGKILL');
    expect(child.exited).toBe(true);
  });

  it('reaps every probe child when readiness never arrives', async () => {
    const children: AgentChild[] = [];
    const sourceRevision = 'b'.repeat(40);
    const startedAt = Date.now();

    await expect(executeRfc64PrivateReleaseGateV1({
      sourceRevision,
      runtimeManifest: {
        manifestDigest: `0x${'1'.repeat(64)}`,
        sourceCommit: sourceRevision,
      },
      probeReadyTimeoutMs: 25,
      createProbeChild: (...args: ConstructorParameters<typeof AgentChild>) => {
        const [role, dataDir, manifestPath, mode, options] = args;
        const child = new AgentChild(role, dataDir, manifestPath, mode, {
          ...options,
          agentProcess: join(
            HERE,
            'fixtures',
            'rfc64-private-catalog-hanging-probe-child.mjs',
          ),
          sigtermExitTimeoutMs: 25,
          sigkillExitTimeoutMs: 2_000,
        });
        children.push(child);
        return child;
      },
    })).rejects.toThrow(/timed out waiting for ready/u);

    expect(children).toHaveLength(4);
    await Promise.all(children.map((child) => child.exit));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(children.every(({ exited }) => exited)).toBe(true);
  }, 10_000);

  it('accepts only stable typed private policy denials', () => {
    const discoveryDenial = new Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1(
      'catalog-discovery-policy-denied',
      'denied',
    );
    const nativeDenial = new Rfc64PublicCatalogNativeTransportErrorV1(
      'catalog-native-policy-denied',
      'denied',
    );
    expect(classifyExpectedPrivateCatalogDenialV1(
      new AggregateError([discoveryDenial], 'provider failed'),
    )).toEqual({
      failureClass: 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
      failureCode: 'catalog-discovery-policy-denied',
    });
    expect(classifyExpectedPrivateCatalogDenialV1(
      new Error('wrapper', { cause: nativeDenial }),
    )).toEqual({
      failureClass: 'Rfc64PublicCatalogNativeTransportErrorV1',
      failureCode: 'catalog-native-policy-denied',
    });
  });

  it('does not treat transport, timeout, provider, or forged failures as denial', () => {
    const denial = new Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1(
      'catalog-discovery-policy-denied',
      'denied',
    );
    const protocolFailure = new Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1(
      'catalog-discovery-wire',
      'bad response',
    );
    expect(classifyExpectedPrivateCatalogDenialV1(protocolFailure)).toBeNull();
    expect(classifyExpectedPrivateCatalogDenialV1(
      new Rfc64PublicCatalogNativeTransportErrorV1(
        'catalog-native-resource-refused',
        'resource limit',
      ),
    )).toBeNull();
    expect(classifyExpectedPrivateCatalogDenialV1(
      Object.assign(new Error('timed out'), { name: 'AbortError' }),
    )).toBeNull();
    expect(classifyExpectedPrivateCatalogDenialV1(
      new AggregateError([denial, new Error('provider disconnected')]),
    )).toBeNull();
    expect(classifyExpectedPrivateCatalogDenialV1(
      Object.assign(new Error('forged'), {
        name: 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
        code: 'catalog-discovery-policy-denied',
      }),
    )).toBeNull();
    expect(isExpectedPrivateCatalogDenialResultV1({
      denied: true,
      applied: false,
      failureClass: 'AggregateError',
      failureCode: null,
    })).toBe(false);
  });
});
