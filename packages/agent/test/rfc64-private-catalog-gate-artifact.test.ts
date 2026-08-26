// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  MemoryLayer,
  contextGraphLayerUri,
} from '@origintrail-official/dkg-core';

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
import {
  AgentChild,
  hasExactMemoryContents,
} from '../devnet/rfc64-private-catalog/run.mjs';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  PROJECTION_EVIDENCE,
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
      }),
    });

    expect(artifact).toMatchObject({
      status: 'PASS',
      startedAt: '2026-08-26T00:00:00.000Z',
      finishedAt: '2026-08-26T00:00:01.000Z',
      sourceRevision: 'b'.repeat(40),
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
    };
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      sourceRevision: null,
    })).toThrow(/exact source revision/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      finishedAt: '2026-08-25T23:59:59.000Z',
    })).toThrow(/precedes/u);
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
});

describe('RFC-64 private release gate process and denial evidence', () => {
  it('feeds process-built SWM/VM evidence through the executable gate predicate', async () => {
    const store = new OxigraphStore();
    const authorAddress = roleAgentAddress('owner');
    try {
      for (const kaNumber of ASSET_NUMBERS) {
        for (const layer of [MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiableMemory]) {
          const graph = contextGraphLayerUri(
            CONTEXT_GRAPH_ID,
            layer,
            authorAddress,
            kaNumber,
          );
          await store.insert([
            {
              graph,
              subject: 'https://example.org/alice',
              predicate: 'https://schema.org/age',
              object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
            },
            {
              graph,
              subject: 'https://example.org/alice',
              predicate: 'https://schema.org/name',
              object: '"Alice"',
            },
          ]);
        }
      }

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
      expect(exact).toEqual(PROJECTION_EVIDENCE);

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
