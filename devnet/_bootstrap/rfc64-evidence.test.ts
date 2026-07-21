import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import evidenceVitestConfig from './vitest.evidence.config.js';
import {
  RFC64_ARTIFACT_POSIX_ACCESS_POLICY,
  RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY,
  RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY,
  RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY,
  Rfc64EvidenceMismatchError,
  Rfc64EvidenceValidationError,
  assertRfc64SemanticSnapshotsEqual,
  canonicalizeSemanticNQuads,
  compareRfc64SemanticSnapshots,
  createRfc64DevnetEvidence,
  createRfc64SemanticSnapshot,
  stableJsonStringify,
  validateRfc64SemanticSnapshot,
  writeStableJsonArtifact,
  type Rfc64DevnetEvidenceInput,
  type Rfc64KnowledgeAssetObservation,
  type Rfc64SemanticSnapshotV1,
} from './rfc64-evidence.js';

const AUTHOR_A = '0xa111111111111111111111111111111111111111';
const AUTHOR_B = '0xb222222222222222222222222222222222222222';
const UAL_A = `did:dkg:otp:20430/${AUTHOR_A}/7`;
const UAL_B = `did:dkg:otp:20430/${AUTHOR_B}/8`;

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), 'rfc64-evidence-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 evidence Vitest discovery', () => {
  it('keeps the evidence include repository-relative and POSIX-normalized', () => {
    const config = evidenceVitestConfig as unknown as {
      readonly root?: string;
      readonly test?: { readonly include?: readonly string[] };
    };
    const include = config.test?.include?.[0];

    expect(config.root).toBe(resolve(import.meta.dirname, '../..'));
    expect(config.test?.include).toEqual([
      'devnet/_bootstrap/rfc64-evidence.test.ts',
    ]);
    expect(include).toBeDefined();
    expect(isAbsolute(include!)).toBe(false);
    expect(include).not.toContain('\\');
  });
});

describe('RFC-64 semantic snapshot evidence', () => {
  it('canonicalizes blank nodes, line order, and UAL aliases', async () => {
    const first = await createRfc64SemanticSnapshot([
      {
        ual: `  did:dkg:otp:20430/${AUTHOR_B.toUpperCase().replace('0X', '0x')}/0008  `,
        semanticNQuads: [
          '_:right <https://schema.org/name> "B" .',
          '_:left <https://schema.org/knows> _:right .',
        ],
      },
      {
        ual: UAL_A,
        semanticNQuads:
          '<https://example.org/a> <https://schema.org/name> "Alice" .',
      },
    ]);
    const second = await createRfc64SemanticSnapshot([
      {
        ual: `did:dkg:otp:20430/${AUTHOR_A}/07`,
        semanticNQuads:
          '<https://example.org/a> <https://schema.org/name> "Alice" .\r\n',
      },
      {
        ual: UAL_B,
        semanticNQuads: [
          '_:other1 <https://schema.org/knows> _:other2 .',
          '_:other2 <https://schema.org/name> "B" .',
        ],
      },
    ]);

    expect(first).toEqual(second);
    expect(first.knowledgeAssets.map((asset) => asset.ual)).toEqual([UAL_A, UAL_B]);
    expect(first).toMatchObject({ kaCount: 2, quadCount: 3 });
    expect(first.ualsSha256).toBe(
      'sha256:b7365d82e247bbe3932e3f732e6419dbc677ff57721fae6f2c1cd1436522f384',
    );
  });

  it('projects physical graph placement to the RFC-64 semantic S/P/O view', async () => {
    const inGraphA = await createRfc64SemanticSnapshot([{
      ual: UAL_A,
      semanticNQuads:
        '<urn:entity> <urn:predicate> "value" <urn:physical:node-a> .',
    }]);
    const inGraphB = await createRfc64SemanticSnapshot([{
      ual: UAL_A,
      semanticNQuads:
        '<urn:entity> <urn:predicate> "value" <urn:physical:node-b> .',
    }]);
    const canonical = await canonicalizeSemanticNQuads(
      '<urn:entity> <urn:predicate> "value" <urn:physical:node-a> .',
    );

    expect(inGraphA).toEqual(inGraphB);
    expect(canonical.text).toBe('<urn:entity> <urn:predicate> "value" .\n');
    expect(canonical.text).not.toContain('physical:node-a');
  });

  it('rejects duplicates at the received semantic projection boundary', async () => {
    await expect(canonicalizeSemanticNQuads([
      '<urn:entity> <urn:predicate> "value" <urn:physical:a> .',
      '<urn:entity> <urn:predicate> "value" <urn:physical:b> .',
    ])).rejects.toThrow(/Duplicate received semantic S\/P\/O projection/);

    await expect(canonicalizeSemanticNQuads([
      '<urn:entity> <urn:predicate> "value" .',
      '<urn:entity> <urn:predicate> "value" .',
    ])).rejects.toThrow(/Duplicate received semantic S\/P\/O projection/);
  });

  it('pins the exact canonical N-Quads bytes and SHA-256 digest', async () => {
    const canonical = await canonicalizeSemanticNQuads([
      '<https://example.org/b> <https://schema.org/name> "B" .',
      '<https://example.org/a> <https://schema.org/name> "A" .',
    ]);

    expect(canonical.text).toBe(
      '<https://example.org/a> <https://schema.org/name> "A" .\n'
      + '<https://example.org/b> <https://schema.org/name> "B" .\n',
    );
    expect(canonical.sha256).toBe(
      'sha256:d4495ca31733ad54c3532fb44d33a23a419f71cf8e7164eeffb37c32718e9d7e',
    );
  });

  it('rejects duplicate canonical UALs instead of silently merging observations', async () => {
    await expect(createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '' },
      {
        ual: `did:dkg:otp:20430/${AUTHOR_A.toUpperCase().replace('0X', '0x')}/007`,
        semanticNQuads: '',
      },
    ])).rejects.toThrow(/Duplicate canonical Knowledge Asset UAL/);
  });

  it('rejects hostile observation containers before invoking caller code', async () => {
    let customMapCalls = 0;
    const customObservations = [{
      ual: 'not-a-ual',
      semanticNQuads: 'not N-Quads',
    }];
    Object.defineProperty(customObservations, 'map', {
      configurable: true,
      enumerable: true,
      value: () => {
        customMapCalls += 1;
        return [];
      },
    });
    await expect(createRfc64SemanticSnapshot(customObservations))
      .rejects.toThrow(/custom array property "map"/);
    expect(customMapCalls).toBe(0);

    const sparseObservations = new Array(1) as Rfc64KnowledgeAssetObservation[];
    await expect(createRfc64SemanticSnapshot(sparseObservations))
      .rejects.toThrow(/sparse array/);

    const customPrototypeObservations = [{
      ual: UAL_A,
      semanticNQuads: '',
    }];
    Object.setPrototypeOf(
      customPrototypeObservations,
      Object.create(Array.prototype),
    );
    await expect(createRfc64SemanticSnapshot(customPrototypeObservations))
      .rejects.toThrow(/custom array prototype/);

    let proxyReads = 0;
    const proxiedObservations = new Proxy([{
      ual: UAL_A,
      semanticNQuads: '',
    }], {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(createRfc64SemanticSnapshot(proxiedObservations))
      .rejects.toThrow(/observations must not be a proxy/);
    expect(proxyReads).toBe(0);

    let ualReads = 0;
    const accessorObservation = { semanticNQuads: '' } as {
      ual: string;
      semanticNQuads: string;
    };
    Object.defineProperty(accessorObservation, 'ual', {
      enumerable: true,
      get: () => {
        ualReads += 1;
        return UAL_A;
      },
    });
    await expect(createRfc64SemanticSnapshot([accessorObservation]))
      .rejects.toThrow(/observations\[0\]\.ual must not be an accessor property/);
    expect(ualReads).toBe(0);
  });

  it('captures N-Quads fragment arrays once without reading accessors', async () => {
    let fragmentReads = 0;
    const fragments: string[] = [];
    Object.defineProperty(fragments, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        fragmentReads += 1;
        return fragmentReads === 1
          ? '<urn:a> <urn:p> <urn:checked> .'
          : '<urn:b> <urn:p> <urn:hashed> .';
      },
    });
    fragments.length = 1;

    await expect(canonicalizeSemanticNQuads(fragments))
      .rejects.toThrow(/semanticNQuads\[0\] must be an enumerable data property/);
    expect(fragmentReads).toBe(0);
  });

  it('rejects malformed N-Quads instead of hashing unchecked text', async () => {
    await expect(canonicalizeSemanticNQuads('this is not N-Quads'))
      .rejects.toThrow(/Invalid semantic N-Quads/);
  });

  it('reports granular mismatches and the assert helper fails closed', async () => {
    const expected = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "expected" .' },
      { ual: UAL_B, semanticNQuads: '<urn:b> <urn:p> "expected" .' },
    ]);
    const observed = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "observed" .' },
    ]);

    expect(compareRfc64SemanticSnapshots(expected, observed).mismatches)
      .toEqual([
        {
          code: 'SEMANTIC_NQUADS_DIGEST_MISMATCH',
          ual: UAL_A,
          expected: expected.knowledgeAssets[0]!.semanticNQuadsSha256,
          observed: observed.knowledgeAssets[0]!.semanticNQuadsSha256,
        },
        { code: 'KA_MISSING', ual: UAL_B },
      ]);
    expect(() => assertRfc64SemanticSnapshotsEqual(expected, observed))
      .toThrow(Rfc64EvidenceMismatchError);
  });

  it('rejects a snapshot whose redundant digest was tampered with', async () => {
    const snapshot = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "A" .' },
    ]);
    const tampered = {
      ...snapshot,
      knowledgeAssets: snapshot.knowledgeAssets.map((asset) => ({
        ...asset,
        semanticNQuadsSha256: `sha256:${'0'.repeat(64)}`,
      })),
    } as Rfc64SemanticSnapshotV1;

    expect(() => validateRfc64SemanticSnapshot(tampered))
      .toThrow(/semanticNQuadsSha256 .* does not equal computed/);
  });

  it('returns deeply frozen semantic snapshots', async () => {
    const snapshot = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "A" .' },
    ]);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.knowledgeAssets)).toBe(true);
    expect(Object.isFrozen(snapshot.knowledgeAssets[0])).toBe(true);
    expect(() => {
      (snapshot as unknown as { kaCount: number }).kaCount = 99;
    }).toThrow(TypeError);
  });

  it('rejects snapshot accessors, proxies, and custom arrays before comparison', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    let accessorReads = 0;
    const accessorSnapshot = { ...snapshot };
    Object.defineProperty(accessorSnapshot, 'knowledgeAssets', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return accessorReads % 6 === 0
          ? [{
              ual: 'not-a-ual',
              quadCount: 99,
              semanticNQuadsSha256: `sha256:${'0'.repeat(64)}`,
            }]
          : [];
      },
    });

    expect(() => compareRfc64SemanticSnapshots(
      accessorSnapshot as Rfc64SemanticSnapshotV1,
      accessorSnapshot as Rfc64SemanticSnapshotV1,
    )).toThrow(/must not be an accessor property/);
    expect(accessorReads).toBe(0);

    expect(() => validateRfc64SemanticSnapshot(
      new Proxy({ ...snapshot }, {}) as Rfc64SemanticSnapshotV1,
    )).toThrow(/must not be a proxy/);

    const customAssets = [...snapshot.knowledgeAssets] as Rfc64SemanticSnapshotV1[
      'knowledgeAssets'
    ] & { marker?: boolean };
    customAssets.marker = true;
    expect(() => validateRfc64SemanticSnapshot({
      ...snapshot,
      knowledgeAssets: customAssets,
    })).toThrow(/custom array property/);
  });
});

describe('RFC-64 devnet run artifact', () => {
  it('passes only an exact observation without a terminal failure', async () => {
    const snapshot = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "exact" .' },
    ]);
    const evidence = createRfc64DevnetEvidence({
      gate: 'gate-1-semantic-recovery',
      observer: 'receiver-node-2',
      sourcePeerId: '12D3KooWSource',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      expected: snapshot,
      observed: snapshot,
    });

    expect(evidence).toMatchObject({
      passed: true,
      comparison: { passed: true, mismatches: [] },
      attempts: { total: 1, retries: 0, failures: [] },
      terminalFailure: null,
    });
  });

  it('closes evidence over defensive frozen snapshot copies', async () => {
    const snapshot = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "exact" .' },
    ]);
    const mutable = JSON.parse(JSON.stringify(snapshot)) as Rfc64SemanticSnapshotV1;
    const evidence = createRfc64DevnetEvidence({
      gate: 'gate-1-semantic-recovery',
      observer: 'receiver-node-2',
      sourcePeerId: '12D3KooWSource',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      expected: mutable,
      observed: mutable,
    });
    const closedBytes = stableJsonStringify(evidence);

    (mutable as unknown as { kaCount: number }).kaCount = 99;
    (mutable.knowledgeAssets[0] as unknown as { quadCount: number }).quadCount = 99;

    expect(evidence.passed).toBe(true);
    expect(evidence.expected.kaCount).toBe(1);
    expect(evidence.expected.knowledgeAssets[0]!.quadCount).toBe(1);
    expect(stableJsonStringify(evidence)).toBe(closedBytes);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.expected.knowledgeAssets[0])).toBe(true);
    expect(Object.isFrozen(evidence.comparison.mismatches)).toBe(true);
  });

  it('records peer, timing, retry, failure, counts, and a fail-closed comparison', async () => {
    const expected = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "expected" .' },
    ]);
    const observed = await createRfc64SemanticSnapshot([
      { ual: UAL_A, semanticNQuads: '<urn:a> <urn:p> "observed" .' },
    ]);

    const evidence = createRfc64DevnetEvidence({
      gate: 'gate-1-semantic-recovery',
      observer: 'receiver-node-2',
      sourcePeerId: '12D3KooWSource',
      startedAt: '2026-07-19T12:00:00.000Z',
      completedAt: '2026-07-19T12:00:01.250Z',
      attemptCount: 2,
      retryFailures: [{
        attempt: 1,
        code: 'PEER_STREAM_RESET',
        message: 'source reset the first stream',
        retryable: true,
      }],
      expected,
      observed,
    });

    expect(evidence).toMatchObject({
      sourcePeerId: '12D3KooWSource',
      timing: { durationMs: 1_250 },
      attempts: { total: 2, retries: 1 },
      comparison: { passed: false },
      terminalFailure: null,
      passed: false,
    });
    expect(evidence.expected).toMatchObject({ kaCount: 1, quadCount: 1 });
  });

  it('records a missing observation as failed when discovery/fetch terminates', async () => {
    const expected = await createRfc64SemanticSnapshot([]);
    const evidence = createRfc64DevnetEvidence({
      gate: 'gate-1-discovery',
      observer: 'receiver-node-2',
      sourcePeerId: null,
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:05Z',
      attemptCount: 1,
      terminalFailure: {
        code: 'NO_SOURCE_PEER',
        message: 'no eligible source peer discovered',
        retryable: true,
      },
      expected,
      observed: null,
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.comparison.mismatches).toEqual([{
      code: 'OBSERVED_SNAPSHOT_MISSING',
      expected: expected.semanticNQuadsSha256,
      observed: null,
    }]);
  });

  it('does not let callers omit terminal failure evidence for a missing observation', async () => {
    const expected = await createRfc64SemanticSnapshot([]);
    expect(() => createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: null,
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      expected,
      observed: null,
    })).toThrow(/missing observed snapshot requires terminalFailure/);
  });

  it('requires evidence for every retried attempt', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    expect(() => createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 2,
      expected: snapshot,
      observed: snapshot,
    })).toThrow(/one failure for each of the 1 retried attempts/);
  });

  it('captures the run record and retry array once before field validation', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    const baseInput = {
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      expected: snapshot,
    };

    let observedReads = 0;
    const accessorInput = { ...baseInput } as Rfc64DevnetEvidenceInput;
    Object.defineProperty(accessorInput, 'observed', {
      enumerable: true,
      get: () => {
        observedReads += 1;
        return observedReads === 1 ? null : snapshot;
      },
    });
    expect(() => createRfc64DevnetEvidence(accessorInput))
      .toThrow(/input\.observed must not be an accessor property/);
    expect(observedReads).toBe(0);

    let proxyReads = 0;
    const proxiedInput = new Proxy({ ...baseInput, observed: snapshot }, {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createRfc64DevnetEvidence(proxiedInput))
      .toThrow(/input must not be a proxy/);
    expect(proxyReads).toBe(0);

    const customPrototypeInput = Object.assign(
      Object.create({ inherited: true }) as Rfc64DevnetEvidenceInput,
      { ...baseInput, observed: snapshot },
    );
    expect(() => createRfc64DevnetEvidence(customPrototypeInput))
      .toThrow(/input must be a plain data object/);

    let retryMapCalls = 0;
    const retryFailures = [{
      attempt: 1,
      code: 'TRANSIENT',
      message: 'retry',
      retryable: true,
    }];
    Object.defineProperty(retryFailures, 'map', {
      configurable: true,
      enumerable: true,
      value: () => {
        retryMapCalls += 1;
        return [];
      },
    });
    expect(() => createRfc64DevnetEvidence({
      ...baseInput,
      attemptCount: 2,
      retryFailures,
      observed: snapshot,
    })).toThrow(/retryFailures must not contain custom array property "map"/);
    expect(retryMapCalls).toBe(0);
  });

  it('rejects accessor and proxy failure records before reading their fields', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    let retryableReads = 0;
    const accessorFailure = {
      attempt: 1,
      code: 'TRANSIENT_FAILURE',
      message: 'retry me',
      get retryable(): boolean {
        retryableReads += 1;
        return (retryableReads === 1 ? true : 'not-boolean') as unknown as boolean;
      },
    };

    expect(() => createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 2,
      retryFailures: [accessorFailure],
      expected: snapshot,
      observed: snapshot,
    })).toThrow(/retryFailures\[0\]\.retryable must not be an accessor property/);
    expect(retryableReads).toBe(0);

    const proxyFailure = new Proxy({
      code: 'TERMINAL_FAILURE',
      message: 'stop',
      retryable: false,
    }, {});
    expect(() => createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00Z',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      terminalFailure: proxyFailure,
      expected: snapshot,
      observed: snapshot,
    })).toThrow(/terminalFailure must not be a proxy/);
  });

  it('rejects timezone-ambiguous strings and canonicalizes explicit offsets', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    expect(() => createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00',
      completedAt: '2026-07-19T12:00:01Z',
      attemptCount: 1,
      expected: snapshot,
      observed: snapshot,
    })).toThrow(/startedAt must be an ISO timestamp with Z or an explicit UTC offset/);

    const evidence = createRfc64DevnetEvidence({
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      startedAt: '2026-07-19T12:00:00+02:00',
      completedAt: '2026-07-19T12:00:01+02:00',
      attemptCount: 1,
      expected: snapshot,
      observed: snapshot,
    });
    expect(evidence.timing).toEqual({
      startedAt: '2026-07-19T10:00:00.000Z',
      completedAt: '2026-07-19T10:00:01.000Z',
      durationMs: 1_000,
    });

    for (const excessivePrecision of [
      '2026-01-01T12:00:00.0000Z',
      '2026-01-01T12:00:00.1234Z',
      '2026-01-01T12:00:00.123456789+02:00',
    ]) {
      expect(() => createRfc64DevnetEvidence({
        gate: 'gate-1',
        observer: 'receiver',
        sourcePeerId: 'source',
        startedAt: excessivePrecision,
        completedAt: '2026-03-02T12:00:01Z',
        attemptCount: 1,
        expected: snapshot,
        observed: snapshot,
      })).toThrow(/must be a valid, representable RFC 3339 timestamp/);
    }

    for (const impossible of [
      '2026-02-30T12:00:00Z',
      '2025-02-29T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T12:00:00-00:00',
    ]) {
      expect(() => createRfc64DevnetEvidence({
        gate: 'gate-1',
        observer: 'receiver',
        sourcePeerId: 'source',
        startedAt: impossible,
        completedAt: '2026-03-02T12:00:01Z',
        attemptCount: 1,
        expected: snapshot,
        observed: snapshot,
      })).toThrow(/must be a valid, representable RFC 3339 timestamp/);
    }
  });

  it('normalizes genuine Dates intrinsically and rejects non-Date or unsafe timing', async () => {
    const snapshot = await createRfc64SemanticSnapshot([]);
    const baseInput = {
      gate: 'gate-1',
      observer: 'receiver',
      sourcePeerId: 'source',
      attemptCount: 1,
      expected: snapshot,
      observed: snapshot,
    };

    expect(() => createRfc64DevnetEvidence({
      ...baseInput,
      startedAt: 0 as unknown as string,
      completedAt: 1_000 as unknown as string,
    })).toThrow(/primitive timestamp string or a non-proxy Date/);

    class HostileDate extends Date {
      override getTime(): number {
        return 0;
      }

      override toISOString(): string {
        return 'not-an-ISO-instant';
      }
    }
    const subclassEvidence = createRfc64DevnetEvidence({
      ...baseInput,
      startedAt: new HostileDate('2026-07-19T12:00:00.000Z'),
      completedAt: new HostileDate('2026-07-19T12:00:01.000Z'),
    });
    expect(subclassEvidence.timing).toEqual({
      startedAt: '2026-07-19T12:00:00.000Z',
      completedAt: '2026-07-19T12:00:01.000Z',
      durationMs: 1_000,
    });

    const proxiedDate = new Proxy(new Date('2026-07-19T12:00:00Z'), {});
    expect(() => createRfc64DevnetEvidence({
      ...baseInput,
      startedAt: proxiedDate,
      completedAt: new Date('2026-07-19T12:00:01Z'),
    })).toThrow(/primitive timestamp string or a non-proxy Date/);

    expect(() => createRfc64DevnetEvidence({
      ...baseInput,
      startedAt: new Date(-8_640_000_000_000_000 + 1),
      completedAt: new Date(8_640_000_000_000_000),
    })).toThrow(/timing\.durationMs must be a non-negative safe integer/);
  });

  it('writes byte-identical stable JSON independent of object insertion order', () => {
    const directory = createTemporaryDirectory();
    const firstPath = join(directory, 'nested', 'first.json');
    const secondPath = join(directory, 'second.json');
    const firstValue = { z: 3, nested: { b: true, a: 'x' }, a: [2, 1] };
    const secondValue = { a: [2, 1], nested: { a: 'x', b: true }, z: 3 };

    const first = writeStableJsonArtifact(firstPath, firstValue);
    const second = writeStableJsonArtifact(secondPath, secondValue);
    const firstBytes = readFileSync(firstPath);
    const secondBytes = readFileSync(secondPath);

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first).toEqual(second);
    expect(first.sha256).toBe(
      `sha256:${createHash('sha256').update(firstBytes).digest('hex')}`,
    );
    expect(firstBytes.toString('utf8')).toBe(stableJsonStringify(firstValue));
    expect(firstBytes.at(-1)).toBe(0x0a);
    expect(readdirSync(join(directory, 'nested'))).toEqual(['first.json']);
    if (process.platform === 'win32') {
      expect(first).toMatchObject({
        namespaceDurability: RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY,
        accessPolicy: RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY,
      });
    } else {
      expect(statSync(firstPath).mode & 0o777).toBe(0o600);
      expect(first).toMatchObject({
        namespaceDurability: RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY,
        accessPolicy: RFC64_ARTIFACT_POSIX_ACCESS_POLICY,
      });
    }
  });

  it('rejects lossy JSON values', () => {
    expect(() => stableJsonStringify({ value: undefined }))
      .toThrow(Rfc64EvidenceValidationError);
    expect(() => stableJsonStringify({ value: Number.NaN }))
      .toThrow(/non-finite number/);
  });

  it('rejects sparse, custom, accessor, symbol, and custom-prototype JSON containers', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'present';
    expect(() => stableJsonStringify(sparse)).toThrow(/sparse array/);

    const customArray = [1] as number[] & { extra?: number };
    customArray.extra = 2;
    expect(() => stableJsonStringify(customArray)).toThrow(/custom array property/);

    let accessorRead = false;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 1;
      },
    });
    expect(() => stableJsonStringify(accessor)).toThrow(/accessor property/);
    expect(accessorRead).toBe(false);

    const symbolBearing = { value: 1 } as Record<PropertyKey, unknown>;
    symbolBearing[Symbol('hidden')] = 2;
    expect(() => stableJsonStringify(symbolBearing)).toThrow(/symbol keys/);

    const hiddenProperty = { visible: 1 };
    Object.defineProperty(hiddenProperty, 'hidden', { value: 2 });
    expect(() => stableJsonStringify(hiddenProperty)).toThrow(/hidden non-enumerable/);

    const customPrototype = Object.create({ inherited: true }) as object;
    expect(() => stableJsonStringify(customPrototype)).toThrow(/plain JSON objects/);
  });

  it('preserves an own __proto__ JSON key without changing object prototypes', () => {
    const input = JSON.parse('{"z":1,"__proto__":{"polluted":true}}') as object;
    const parsed = JSON.parse(stableJsonStringify(input)) as Record<string, unknown>;

    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('atomically replaces regular targets under the platform access policy', () => {
    const directory = createTemporaryDirectory();
    const target = join(directory, 'artifact.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    chmodSync(target, 0o644);

    writeStableJsonArtifact(target, { generation: 2 });

    expect(readFileSync(target, 'utf8')).toBe('{\n  "generation": 2\n}\n');
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(directory)).toEqual(['artifact.json']);
  });

  it.runIf(process.platform !== 'win32')(
    'persists every newly created directory entry through its parent',
    () => {
      const directory = createTemporaryDirectory();
      const target = join(directory, 'first', 'second', 'artifact.json');
      const originalFsync = fs.fsyncSync;
      let fileFsyncs = 0;
      let directoryFsyncs = 0;
      fs.fsyncSync = (descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncs += 1;
        else fileFsyncs += 1;
        originalFsync(descriptor);
      };
      syncBuiltinESMExports();
      try {
        writeStableJsonArtifact(target, { durable: true });
      } finally {
        fs.fsyncSync = originalFsync;
        syncBuiltinESMExports();
      }

      expect(fileFsyncs).toBe(1);
      expect(directoryFsyncs).toBe(3);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'persists a parent after a concurrent creator wins the mkdir race',
    () => {
      const directory = createTemporaryDirectory();
      const racedDirectory = join(directory, 'raced');
      const target = join(racedDirectory, 'artifact.json');
      mkdirSync(racedDirectory, { mode: 0o700 });
      const originalLstat = fs.lstatSync;
      const originalFsync = fs.fsyncSync;
      let injectedMissing = false;
      let fileFsyncs = 0;
      let directoryFsyncs = 0;
      const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
        if (!injectedMissing && String(path) === racedDirectory) {
          injectedMissing = true;
          throw Object.assign(new Error('simulated missing directory'), { code: 'ENOENT' });
        }
        return originalLstat(path);
      }) as typeof fs.lstatSync);
      fs.fsyncSync = (descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncs += 1;
        else fileFsyncs += 1;
        originalFsync(descriptor);
      };
      syncBuiltinESMExports();
      try {
        writeStableJsonArtifact(target, { durable: true });
      } finally {
        lstat.mockRestore();
        fs.fsyncSync = originalFsync;
        syncBuiltinESMExports();
      }

      expect(injectedMissing).toBe(true);
      expect(fileFsyncs).toBe(1);
      expect(directoryFsyncs).toBe(2);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'detects a parent swap after rename while preserving the possible side effect',
    () => {
      const directory = createTemporaryDirectory();
      const checkedDirectory = join(directory, 'checked');
      const movedDirectory = join(directory, 'moved');
      const target = join(checkedDirectory, 'artifact.json');
      mkdirSync(checkedDirectory, { mode: 0o700 });
      const originalRename = fs.renameSync;
      let injectedSwap = false;
      fs.renameSync = ((source, destination) => {
        if (!injectedSwap && String(destination) === target) {
          injectedSwap = true;
          originalRename(checkedDirectory, movedDirectory);
          symlinkSync(movedDirectory, checkedDirectory, 'dir');
        }
        originalRename(source, destination);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try {
        expect(() => writeStableJsonArtifact(target, { generation: 1 }))
          .toThrow(/directory topology contains a symbolic link/);
      } finally {
        fs.renameSync = originalRename;
        syncBuiltinESMExports();
      }

      expect(injectedSwap).toBe(true);
      expect(readFileSync(join(movedDirectory, 'artifact.json'), 'utf8'))
        .toBe(stableJsonStringify({ generation: 1 }));
    },
  );

  it('declares the weaker Windows namespace and inherited-ACL policy', () => {
    const directory = createTemporaryDirectory();
    const target = join(directory, 'windows-policy.json');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const written = writeStableJsonArtifact(target, { platform: 'windows' });
      expect(written).toMatchObject({
        namespaceDurability: RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY,
        accessPolicy: RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY,
      });
      expect(readFileSync(target, 'utf8'))
        .toBe(stableJsonStringify({ platform: 'windows' }));
    } finally {
      platform.mockRestore();
    }
  });

  it('rejects symlinked targets and parent topology without following them', () => {
    const directory = createTemporaryDirectory();
    const realTarget = join(directory, 'real.json');
    const linkedTarget = join(directory, 'linked.json');
    if (process.platform !== 'win32') {
      writeFileSync(realTarget, 'sentinel', { mode: 0o600 });
      symlinkSync(realTarget, linkedTarget);

      expect(() => writeStableJsonArtifact(linkedTarget, { unsafe: true }))
        .toThrow(/target must not be a symbolic link/);
      expect(readFileSync(realTarget, 'utf8')).toBe('sentinel');
    }

    const realDirectory = join(directory, 'real-directory');
    const linkedDirectory = join(directory, 'linked-directory');
    mkdirSync(realDirectory, { mode: 0o700 });
    symlinkSync(
      realDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => writeStableJsonArtifact(
      join(linkedDirectory, 'escaped.json'),
      { unsafe: true },
    )).toThrow(/directory topology contains a symbolic link/);
    expect(existsSync(join(realDirectory, 'escaped.json'))).toBe(false);
  });
});
