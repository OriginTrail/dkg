// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertGate2ExecutedRuntimeMatchesBuildV1,
  buildGate2ExecutedRuntimeManifestV1,
  buildGate2RuntimeManifestFromEntriesV1,
  buildGate2RuntimeManifestV1,
} from '../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-provenance.js';

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
  buildRfc64PrivateRuntimeProvenanceV1,
  createRfc64PrivateRuntimeEvidenceCollectorV1,
} from '../devnet/rfc64-private-catalog/runtime-provenance.mjs';
import {
  AgentChild,
  hasExactMemoryContents,
} from '../devnet/rfc64-private-catalog/run.mjs';
import { PROJECTION_DIGEST } from '../devnet/rfc64-private-catalog/fixture.mjs';

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
  const sourceBuild = buildGate2RuntimeManifestFromEntriesV1(sourceRevision, RUNTIME_FILES);
  const loaded = buildGate2ExecutedRuntimeManifestV1(sourceRevision, RUNTIME_FILES);
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('RFC-64 private release gate artifact lifecycle', () => {
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
    const sourceBuild = buildGate2RuntimeManifestFromEntriesV1(sourceRevision, RUNTIME_FILES);
    const loaded = buildGate2ExecutedRuntimeManifestV1(sourceRevision, RUNTIME_FILES);
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
  it('launches and gracefully seals the production agent process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-provenance-child-'));
    temporaryRoots.push(root);
    const sourceRevision = 'a'.repeat(40);
    const cleanBuild = buildGate2RuntimeManifestV1(REPO_ROOT, sourceRevision);
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
    expect(() => assertGate2ExecutedRuntimeMatchesBuildV1(
      shutdown.executedRuntimeManifest,
      cleanBuild,
    )).not.toThrow();
  }, 60000);

  it('rejects same-size SWM or VM semantic corruption', () => {
    const exactGraphCounts = [41, 42].map((kaNumber) => ({
      kaNumber,
      swm: 2,
      swmDigest: PROJECTION_DIGEST,
      vm: 2,
      vmDigest: PROJECTION_DIGEST,
    }));
    expect(hasExactMemoryContents({ graphCounts: exactGraphCounts })).toBe(true);
    expect(hasExactMemoryContents({
      graphCounts: exactGraphCounts.map((entry, index) => index === 0
        ? { ...entry, vmDigest: '0'.repeat(64) }
        : entry),
    })).toBe(false);
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
