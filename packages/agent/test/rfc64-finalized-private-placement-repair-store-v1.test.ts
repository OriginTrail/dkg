// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssertionCoordinateV1,
  CanonicalDeterministicUalV1,
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  PositiveDecimalU64V1,
  SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import { openRfc64FinalizedPrivatePlacementRepairStoreV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';

const roots: string[] = [];
const repair = Object.freeze({
  version: 1 as const,
  contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
  authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
  inventoryScope: Object.freeze({
    networkId: 'testnet' as const,
    contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
    subGraphName: null,
    era: '1' as const,
  }) satisfies SwmAuthorInventoryScopeV1,
  assertionCoordinate: 'asset-1' as AssertionCoordinateV1,
  assertionVersion: '1' as PositiveDecimalU64V1,
  kaUal: `did:dkg:otp:20430/0x${'11'.repeat(20)}/1` as CanonicalDeterministicUalV1,
  sealDigest: `0x${'22'.repeat(32)}` as Digest32V1,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('RFC-64 finalized-private placement repair store', () => {
  it('durably retains confirmation until an exact completed repair deletes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-placement-repair-'));
    roots.push(root);
    const first = await openRfc64FinalizedPrivatePlacementRepairStoreV1(root);

    await first.put(repair);
    await first.put(repair);
    expect(first.list()).toEqual([repair]);

    const restarted = await openRfc64FinalizedPrivatePlacementRepairStoreV1(root);
    expect(restarted.list()).toEqual([repair]);
    await restarted.delete(repair);

    const completed = await openRfc64FinalizedPrivatePlacementRepairStoreV1(root);
    expect(completed.list()).toEqual([]);
  });

  it('fails closed when marker bytes change before deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-placement-tamper-'));
    roots.push(root);
    const opened = await openRfc64FinalizedPrivatePlacementRepairStoreV1(root);
    await opened.put(repair);
    const directory = join(root, 'finalized-private-placement-repairs-v1');
    const [filename] = await readdir(directory);
    if (filename === undefined) throw new Error('repair marker was not written');
    const markerPath = join(directory, filename);
    const original = await readFile(markerPath);
    await writeFile(markerPath, Buffer.concat([original.subarray(0, -2), Buffer.from(' }\n')]));

    await expect(opened.delete(repair)).rejects.toThrow('changed before delete');
    await expect(readFile(markerPath)).resolves.not.toHaveLength(0);
    const recovered = await openRfc64FinalizedPrivatePlacementRepairStoreV1(root);
    expect(recovered.list()).toEqual([repair]);
  });
});
