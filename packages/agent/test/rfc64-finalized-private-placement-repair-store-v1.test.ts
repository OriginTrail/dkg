// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
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
} from '@origintrail-official/dkg-core';

import { openRfc64FinalizedPrivatePlacementRepairStoreV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';

const roots: string[] = [];
const repair = Object.freeze({
  version: 1 as const,
  contextGraphId: 'finalized-private-repair' as ContextGraphIdV1,
  authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
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
});
