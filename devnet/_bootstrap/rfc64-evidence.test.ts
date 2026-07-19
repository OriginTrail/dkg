import { createHash } from 'node:crypto';
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
    expect(statSync(firstPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(directory, 'nested'))).toEqual(['first.json']);
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

  it('atomically replaces regular targets as 0600 without temp remnants', () => {
    const directory = createTemporaryDirectory();
    const target = join(directory, 'artifact.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    chmodSync(target, 0o644);

    writeStableJsonArtifact(target, { generation: 2 });

    expect(readFileSync(target, 'utf8')).toBe('{\n  "generation": 2\n}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['artifact.json']);
  });

  it('rejects symlinked targets and parent topology without following them', () => {
    const directory = createTemporaryDirectory();
    const realTarget = join(directory, 'real.json');
    const linkedTarget = join(directory, 'linked.json');
    writeFileSync(realTarget, 'sentinel', { mode: 0o600 });
    symlinkSync(realTarget, linkedTarget);

    expect(() => writeStableJsonArtifact(linkedTarget, { unsafe: true }))
      .toThrow(/target must not be a symbolic link/);
    expect(readFileSync(realTarget, 'utf8')).toBe('sentinel');

    const realDirectory = join(directory, 'real-directory');
    const linkedDirectory = join(directory, 'linked-directory');
    mkdirSync(realDirectory, { mode: 0o700 });
    symlinkSync(realDirectory, linkedDirectory, 'dir');

    expect(() => writeStableJsonArtifact(
      join(linkedDirectory, 'escaped.json'),
      { unsafe: true },
    )).toThrow(/directory topology contains a symbolic link/);
    expect(existsSync(join(realDirectory, 'escaped.json'))).toBe(false);
  });
});
