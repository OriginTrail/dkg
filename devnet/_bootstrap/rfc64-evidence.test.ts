import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
  type Rfc64SemanticSnapshotV1,
} from './rfc64-evidence.js';

const AUTHOR_A = '0xa111111111111111111111111111111111111111';
const AUTHOR_B = '0xb222222222222222222222222222222222222222';
const UAL_A = `did:dkg:otp:20430/${AUTHOR_A}/7`;
const UAL_B = `did:dkg:otp:20430/${AUTHOR_B}/8`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 semantic snapshot evidence', () => {
  it('canonicalizes blank nodes, line order, duplicate quads, and UAL aliases', async () => {
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
        semanticNQuads: [
          '<https://example.org/a> <https://schema.org/name> "Alice" .',
          '<https://example.org/a> <https://schema.org/name> "Alice" .',
        ],
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

  it('writes byte-identical stable JSON independent of object insertion order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rfc64-evidence-'));
    temporaryDirectories.push(directory);
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
  });

  it('rejects lossy JSON values', () => {
    expect(() => stableJsonStringify({ value: undefined }))
      .toThrow(Rfc64EvidenceValidationError);
    expect(() => stableJsonStringify({ value: Number.NaN }))
      .toThrow(/non-finite number/);
  });
});
