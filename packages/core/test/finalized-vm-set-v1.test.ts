import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  FinalizedVmSetAccumulatorV1,
  computeEmptyFinalizedVmSetRootV1,
  computeFinalizedVmSetEvidenceV1,
  computeFinalizedVmSetLeafDigestV1,
  snapshotFinalizedVmSetRowV1,
  type FinalizedVmSetScopeV1,
  type FinalizedVmSetRowV1,
  type FinalizedVmSetV1ErrorCode,
} from '../src/finalized-vm-set-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const OTHER_CONTRACT = '0x3333333333333333333333333333333333333333';
const OTHER_CHAIN = '20431';
const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  chainId: '20430',
  contractAddress: CONTRACT,
}) as FinalizedVmSetScopeV1;

describe('RFC-64 finalized VM-set accumulator', () => {
  it('returns the complete frozen empty-set evidence contract', () => {
    const mutableScope = {
      networkId: SCOPE.networkId,
      chainId: SCOPE.chainId,
      contractAddress: SCOPE.contractAddress,
    } as FinalizedVmSetScopeV1;
    const evidence = new FinalizedVmSetAccumulatorV1(mutableScope).finalize();
    mutableScope.contractAddress = OTHER_CONTRACT as never;

    expect(evidence).toEqual({
      scope: SCOPE,
      rootDigest: '0x900f13ea9b9bfc985dfd4beedf0ae0a6f01ff3a5a211943e18a751187dd9a09d',
      rowCount: '0',
      highestFinalizedOrdinal: null,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.scope)).toBe(true);
    expect(evidence.scope).not.toBe(mutableScope);
  });

  it('matches independent empty, one, even, and odd tree vectors', () => {
    expect(computeEmptyFinalizedVmSetRootV1()).toBe(
      '0x900f13ea9b9bfc985dfd4beedf0ae0a6f01ff3a5a211943e18a751187dd9a09d',
    );
    expect(computeFinalizedVmSetLeafDigestV1(SCOPE, row(0))).toBe(
      '0x45304bfc182887862fe36825a90aa37787e885d3c0cf7ee700264ff0fcdbd4d2',
    );

    const roots = new Map<number, string>([
      [1, '0x45304bfc182887862fe36825a90aa37787e885d3c0cf7ee700264ff0fcdbd4d2'],
      [2, '0x6c432a76137e037ae3feb0b838ad7c9f49c62b46f9c75727cd128aa4db95d0be'],
      [3, '0x94b06b80d4f8f386b71cb48d8b98394a41319a06d611ee14e3ccb8069a491ec6'],
      [5, '0x1f99dd55651c7942351eeef93b1662fa2795f745e460910b4b199b349689ef7d'],
    ]);
    for (const [count, expectedRoot] of roots) {
      const evidence = computeFinalizedVmSetEvidenceV1(
        SCOPE,
        Array.from({ length: count }, (_, ordinal) => row(ordinal)),
      );
      expect(evidence).toEqual({
        scope: SCOPE,
        rootDigest: expectedRoot,
        rowCount: String(count),
        highestFinalizedOrdinal: String(count - 1),
      });
    }
  });

  it('streams ordered rows with logarithmic retained tree state and finalizes idempotently', () => {
    const rows = [row(0), row(3), row(9)];
    const accumulator = new FinalizedVmSetAccumulatorV1(SCOPE);
    for (const value of rows) accumulator.append(value);
    const first = accumulator.finalize();
    expect(first.rootDigest).toBe(computeReferenceRoot(rows));
    expect(first.rowCount).toBe('3');
    expect(first.highestFinalizedOrdinal).toBe('9');
    expect(accumulator.finalize()).toBe(first);
    expectFailureCode(() => accumulator.append(row(10)), 'finalized-vm-set-state');
  });

  it('matches a direct level-by-level tree for every boundary through 129 rows', () => {
    for (let count = 0; count <= 129; count += 1) {
      const rows = Array.from({ length: count }, (_, ordinal) => row(ordinal));
      expect(computeFinalizedVmSetEvidenceV1(SCOPE, rows).rootDigest).toBe(
        computeReferenceRoot(rows),
      );
    }
  });

  it('rejects duplicate, descending, and cross-lane rows instead of sorting them', () => {
    const duplicate = new FinalizedVmSetAccumulatorV1(SCOPE);
    duplicate.append(row(2));
    expectFailureCode(() => duplicate.append(row(2)), 'finalized-vm-set-order');

    const descending = new FinalizedVmSetAccumulatorV1(SCOPE);
    descending.append(row(2));
    expectFailureCode(() => descending.append(row(1)), 'finalized-vm-set-order');

    const crossLane = new FinalizedVmSetAccumulatorV1(SCOPE);
    expectFailureCode(
      () => crossLane.append({ ...row(0), contractAddress: OTHER_CONTRACT } as FinalizedVmSetRowV1),
      'finalized-vm-set-lane',
    );
    expectFailureCode(
      () => snapshotFinalizedVmSetRowV1(
        SCOPE,
        { ...row(0), chainId: OTHER_CHAIN } as FinalizedVmSetRowV1,
      ),
      'finalized-vm-set-lane',
    );
    expectFailureCode(
      () => computeFinalizedVmSetLeafDigestV1(
        SCOPE,
        { ...row(0), contractAddress: OTHER_CONTRACT } as FinalizedVmSetRowV1,
      ),
      'finalized-vm-set-lane',
    );
  });

  it('rejects UAL aliases and author mismatches before hashing', () => {
    expectFailureCode(
      () => snapshotFinalizedVmSetRowV1(SCOPE, {
        ...row(0),
        ual: `did:dkg:otp:20430/${AUTHOR.toUpperCase()}/1`,
      } as FinalizedVmSetRowV1),
      'finalized-vm-set-ual',
    );
    expectFailureCode(
      () => snapshotFinalizedVmSetRowV1(SCOPE, {
        ...row(0),
        ual: `did:dkg:otp:20430/${OTHER_CONTRACT}/1`,
      } as FinalizedVmSetRowV1),
      'finalized-vm-set-ual',
    );
    expectFailureCode(
      () => snapshotFinalizedVmSetRowV1(SCOPE, {
        ...row(0),
        assertionVersion: '0',
      } as FinalizedVmSetRowV1),
      'finalized-vm-set-scalar',
    );
    expectFailureCode(
      () => snapshotFinalizedVmSetRowV1(SCOPE, {
        ...row(0),
        ual: `did:dkg:wrong-lane/${AUTHOR}/1`,
      } as FinalizedVmSetRowV1),
      'finalized-vm-set-ual',
    );
  });

  it('snapshots every caller field once and never re-reads a switching Proxy', () => {
    const source = row(0) as unknown as Record<string, unknown>;
    const descriptorReads = new Map<PropertyKey, number>();
    const proxy = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        const reads = (descriptorReads.get(key) ?? 0) + 1;
        descriptorReads.set(key, reads);
        if (reads > 1) throw new Error(`field ${String(key)} was re-read`);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === 'ordinal' && descriptor) {
          return { ...descriptor, value: '0' };
        }
        return descriptor;
      },
      get(_target, key) {
        throw new Error(`unsafe property read: ${String(key)}`);
      },
    });

    const snapshot = snapshotFinalizedVmSetRowV1(
      SCOPE,
      proxy as FinalizedVmSetRowV1,
    );
    expect(snapshot).toEqual(row(0));
    expect([...descriptorReads.values()].every((count) => count === 1)).toBe(true);
  });

  it('rejects Proxy re-entry instead of caching evidence during an unfinished append', () => {
    const accumulator = new FinalizedVmSetAccumulatorV1(SCOPE);
    let reentryCode: unknown;
    const proxy = new Proxy(row(0), {
      getPrototypeOf(target) {
        try {
          accumulator.finalize();
        } catch (error) {
          reentryCode = (error as Error & { code?: unknown }).code;
        }
        return Reflect.getPrototypeOf(target);
      },
    });

    accumulator.append(proxy);
    expect(reentryCode).toBe('finalized-vm-set-state');
    expect(accumulator.finalize()).toEqual({
      scope: SCOPE,
      rootDigest: computeFinalizedVmSetLeafDigestV1(SCOPE, row(0)),
      rowCount: '1',
      highestFinalizedOrdinal: '0',
    });
  });

  it('snapshots the lane before an input iterator can mutate its source object', () => {
    const mutableScope = {
      networkId: 'otp:20430',
      chainId: '20430',
      contractAddress: CONTRACT,
    } as FinalizedVmSetScopeV1;
    function* rows(): Generator<FinalizedVmSetRowV1> {
      mutableScope.contractAddress = OTHER_CONTRACT as never;
      yield row(0);
    }
    const evidence = computeFinalizedVmSetEvidenceV1(mutableScope, rows());
    expect(evidence.scope).toEqual(SCOPE);
  });
});

function row(ordinal: number): FinalizedVmSetRowV1 {
  const scalar = BigInt(ordinal);
  return Object.freeze({
    chainId: '20430',
    contractAddress: CONTRACT,
    ordinal: scalar.toString(),
    ual: `did:dkg:otp:20430/${AUTHOR}/${scalar + 1n}`,
    authorAddress: AUTHOR,
    assertionVersion: (scalar + 1n).toString(),
    assertionRoot: digest(scalar + 1n),
    finalizedBlockNumber: (100n + scalar).toString(),
    finalizedBlockHash: digest(1000n + scalar),
    placementEvidenceDigest: digest(2000n + scalar),
  }) as FinalizedVmSetRowV1;
}

function digest(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function computeReferenceRoot(rows: readonly FinalizedVmSetRowV1[]): `0x${string}` {
  if (rows.length === 0) return computeEmptyFinalizedVmSetRootV1();
  let level = rows.map((value) => hexToBytes(computeFinalizedVmSetLeafDigestV1(SCOPE, value)));
  const encoder = new TextEncoder();
  const nodeDomain = encoder.encode('dkg-finalized-vm-set-node-v1\n');
  const oddDomain = encoder.encode('dkg-finalized-vm-set-odd-v1\n');
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length
        ? sha256(concat(nodeDomain, level[index]!, level[index + 1]!))
        : sha256(concat(oddDomain, level[index]!)));
    }
    level = next;
  }
  return bytesToHex(level[0]!);
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(value: Uint8Array): `0x${string}` {
  return `0x${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function expectFailureCode(operation: () => unknown, expected: FinalizedVmSetV1ErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: unknown }).code).toBe(expected);
    return;
  }
  throw new Error(`expected operation to fail with ${expected}`);
}
