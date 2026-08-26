// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { AgentChild } from '../devnet/rfc64-private-catalog/run.mjs';

const temporaryRoots: string[] = [];
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_MANIFEST_DIGEST = `0x${'d'.repeat(64)}`;

function runtimeProvenance(sourceRevision: string) {
  const processIds = [
    'probe-owner',
    'probe-provider2',
    'probe-receiver',
    'probe-outsider',
    'owner',
    'provider2',
    'receiver',
    'outsider',
    'receiver-restart',
  ];
  return {
    schema: 'dkg-rfc64-private-runtime-provenance-v1',
    sourceBuild: {
      manifestDigest: RUNTIME_MANIFEST_DIGEST,
      sourceCommit: sourceRevision,
    },
    processes: processIds.map((id) => ({
      id,
      loaded: {
        manifestDigest: `0x${'e'.repeat(64)}`,
        runtimeFiles: [{
          byteLength: 1,
          path: 'packages/agent/dist/index.js',
          sha256: `0x${'f'.repeat(64)}`,
        }],
        sourceCommit: sourceRevision,
      },
    })),
  };
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

    const artifact = await runRfc64PrivateGateArtifactLifecycleV1({
      artifactPath,
      sourceRevision: 'b'.repeat(40),
      now: () => timestamps.shift() ?? new Date('2026-08-26T00:00:02.000Z'),
      execute: async () => ({
        schema: 'dkg-rfc64-private-release-gate-v1',
        status: 'PASS',
        checks: { strict: true },
        runtimeManifestDigest: RUNTIME_MANIFEST_DIGEST,
        runtimeProvenance: runtimeProvenance('b'.repeat(40)),
      }),
    });

    expect(artifact).toMatchObject({
      status: 'PASS',
      startedAt: '2026-08-26T00:00:00.000Z',
      finishedAt: '2026-08-26T00:00:01.000Z',
      sourceRevision: 'b'.repeat(40),
      runtimeManifestDigest: RUNTIME_MANIFEST_DIGEST,
    });
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toEqual(artifact);
    expect(() => assertRfc64PrivateGatePassProvenanceV1(artifact)).not.toThrow();
  });

  it('rejects PASS provenance with a missing revision or invalid run interval', () => {
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision: 'c'.repeat(40),
      runtimeManifestDigest: RUNTIME_MANIFEST_DIGEST,
      runtimeProvenance: runtimeProvenance('c'.repeat(40)),
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
      sourceRevision: 'A'.repeat(40),
      now: () => timestamps.shift() ?? new Date('2026-08-26T00:00:02.000Z'),
      execute: async () => {
        startingArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
        throw Object.assign(new Error(sensitiveMessage), { code: 'owner-start-failed' });
      },
    })).rejects.toThrow(sensitiveMessage);

    expect(startingArtifact).toMatchObject({
      status: 'INCOMPLETE',
      phase: 'starting',
      sourceRevision: 'a'.repeat(40),
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
});

describe('RFC-64 private release gate process and denial evidence', () => {
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
