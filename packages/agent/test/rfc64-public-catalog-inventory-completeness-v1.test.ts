import { describe, expect, it } from 'vitest';

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';

import { computeRfc64AppliedInventoryDigestV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  Rfc64PublicCatalogInventoryCompletenessErrorV1,
  verifyRfc64PublicCatalogInventoryCompletenessV1,
  type Rfc64PublicCatalogInventoryEvidenceRowV1,
} from '../src/rfc64/public-catalog-inventory-completeness-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'gate2-multi-asset',
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;

describe('RFC-64 public catalog bounded inventory completeness', () => {
  it('mints deterministic exact-set evidence in numeric KA-ID order', () => {
    const expected = [row(2), row(10), row(100)];
    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '3' as CountV1,
      expectedRows: expected,
      observedRows: [expected[2], expected[0], expected[1]],
    });

    expect(evidence.catalogScopeDigest).toBe(computeAuthorCatalogScopeDigestV1(SCOPE));
    expect(evidence.inventoryRowCount).toBe('3');
    expect(evidence.rows.map((entry) => entry.kaUal)).toEqual([
      `did:dkg:otp:20430/${AUTHOR}/2`,
      `did:dkg:otp:20430/${AUTHOR}/10`,
      `did:dkg:otp:20430/${AUTHOR}/100`,
    ]);
    expect(evidence.inventoryDigest).toMatch(/^0x[0-9a-f]{64}$/);

    const repeated = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: { ...SCOPE },
      expectedTotalRows: '3' as CountV1,
      expectedRows: expected.map((entry) => ({ ...entry })),
      observedRows: [...expected].reverse(),
    });
    expect(repeated).toEqual(evidence);
  });

  it('preserves the exact Gate-1 digest framing for a one-row set', () => {
    const only = row(7);
    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1' as CountV1,
      expectedRows: [only],
      observedRows: [only],
    });
    expect(evidence.inventoryDigest).toBe(computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(SCOPE),
      rows: [{
        catalogRowDigest: only.catalogRowDigest,
        contentDigest: only.contentDigest,
        sealDigest: only.sealDigest,
        kaUal: only.kaUal,
        activatedTripleCount: only.activatedTripleCount,
      }],
    }));
  });

  it.each([
    ['missing', 'catalog-inventory-completeness-missing', (rows: typeof BASE) => rows.slice(0, 1)],
    ['extra', 'catalog-inventory-completeness-extra', (rows: typeof BASE) => [...rows, row(3)]],
    ['duplicate', 'catalog-inventory-completeness-duplicate', (rows: typeof BASE) => [rows[0], rows[0], rows[1]]],
    ['mismatch', 'catalog-inventory-completeness-mismatch', (rows: typeof BASE) => [rows[0], { ...rows[1], contentDigest: digest(99) }]],
  ] as const)('rejects an observed %s row set', (_label, code, mutate) => {
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '2' as CountV1,
      expectedRows: BASE,
      observedRows: mutate(BASE),
    }), code);
  });

  it('rejects a noncanonical signed expected-row order instead of hiding it by sorting', () => {
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '2' as CountV1,
      expectedRows: [...BASE].reverse(),
      observedRows: BASE,
    }), 'catalog-inventory-completeness-order');
  });

  it('classifies a duplicate signed expected row before its resulting order failure', () => {
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '3' as CountV1,
      expectedRows: [BASE[0], BASE[0], BASE[1]],
      observedRows: BASE,
    }), 'catalog-inventory-completeness-duplicate');
  });

  it('rejects head count disagreement, UAL aliases, and UAL/packed-ID mismatch', () => {
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '3' as CountV1,
      expectedRows: BASE,
      observedRows: BASE,
    }), 'catalog-inventory-completeness-count');

    const leadingZero = { ...BASE[0], kaUal: `did:dkg:otp:20430/${AUTHOR}/01` };
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1' as CountV1,
      expectedRows: [leadingZero],
      observedRows: [leadingZero],
    }), 'catalog-inventory-completeness-input');

    const wrongPackedId = { ...BASE[0], kaUal: `did:dkg:otp:20430/${AUTHOR}/999` };
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1' as CountV1,
      expectedRows: [wrongPackedId],
      observedRows: [wrongPackedId],
    }), 'catalog-inventory-completeness-input');
  });
});

const BASE = Object.freeze([row(1), row(2)]);

function row(number: number): Rfc64PublicCatalogInventoryEvidenceRowV1 {
  const kaId = ((BigInt(AUTHOR) << 96n) | BigInt(number)).toString() as KaIdV1;
  return Object.freeze({
    kaId,
    catalogRowDigest: digest(number * 4),
    contentDigest: digest((number * 4) + 1),
    sealDigest: digest((number * 4) + 2),
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${number}`,
    activatedTripleCount: number + 1,
  });
}

function digest(seed: number): Digest32V1 {
  return `0x${seed.toString(16).padStart(64, '0')}` as Digest32V1;
}

function expectCode(operation: () => unknown, expectedCode: string): void {
  try {
    operation();
    throw new Error(`expected ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Rfc64PublicCatalogInventoryCompletenessErrorV1);
    expect((error as Rfc64PublicCatalogInventoryCompletenessErrorV1).code).toBe(expectedCode);
  }
}
