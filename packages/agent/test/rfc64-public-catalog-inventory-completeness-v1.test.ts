import { describe, expect, it } from 'vitest';

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';

import {
  computeRfc64AppliedInventoryDigestV1,
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
    expect(evidence.inventoryDigest).toBe(
      '0x299d93f46a4baa1a0099f3ebfabb43f2070dc590313c4abfcf22f3541766a79e',
    );

    const repeated = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: { ...SCOPE },
      expectedTotalRows: '3' as CountV1,
      expectedRows: expected.map((entry) => ({ ...entry })),
      observedRows: [...expected].reverse(),
    });
    expect(repeated).toEqual(evidence);
  });

  it('preserves the exact Gate-1 empty and one-row digest vectors', () => {
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(SCOPE);
    const emptyDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
    });
    expect(emptyDigest).toBe(
      '0xcd36c729c972b50de1b2e562fa7e2200513d8ba282af29ebf4e403a806605aee',
    );
    expect(verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '0' as CountV1,
      expectedRows: [],
      observedRows: [],
    })).toMatchObject({
      inventoryRowCount: '0',
      inventoryDigest: emptyDigest,
      rows: [],
    });

    const only = row(7);
    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1' as CountV1,
      expectedRows: [only],
      observedRows: [only],
    });
    const recomputed = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [only],
    });
    expect(recomputed).toBe('0x6b258dc6f104ad042aec38da7837d9ba53f292af96eecd70f4e71dfb9a53e2f2');
    expect(evidence.inventoryDigest).toBe(recomputed);
  });

  it('uses numeric KA-ID order for 2 vs 10 and matches the completeness digest', () => {
    const two = row(2);
    const ten = row(10);
    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '2' as CountV1,
      expectedRows: [two, ten],
      observedRows: [ten, two],
    });
    const recomputed = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(SCOPE),
      rows: [ten, two],
    });

    expect(recomputed).toBe('0x6d273d5f5fc1acbfe6836168c7159b747fe3df549d2d5bddcd8bf409ff58ea01');
    expect(recomputed).not.toBe('0x7fdb1bfd439ccde258f1061d728cc555337ee1764b1188cf36c519ece1d7abb5');
    expect(recomputed).toBe(evidence.inventoryDigest);
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

  it('enforces the signed-descriptor 0..1024 row boundary before enumerating rows', () => {
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: { ...SCOPE, bucketCount: '2' as CountV1 },
      expectedTotalRows: '1' as CountV1,
      expectedRows: [row(1)],
      observedRows: [row(1)],
    }), 'catalog-inventory-completeness-slice');

    const maximum = Array.from({ length: 1024 }, (_value, index) => row(index + 1));
    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1024' as CountV1,
      expectedRows: maximum,
      observedRows: [...maximum].reverse(),
    });
    expect(evidence.inventoryRowCount).toBe('1024');
    expect(evidence.rows).toHaveLength(1024);
    expect(evidence.rows[0].kaUal).toBe(`did:dkg:otp:20430/${AUTHOR}/1`);
    expect(evidence.rows[1023].kaUal).toBe(`did:dkg:otp:20430/${AUTHOR}/1024`);

    let enumeratedOversizedRows = false;
    const oversized = new Proxy(new Array(1025), {
      ownKeys(target) {
        enumeratedOversizedRows = true;
        return Reflect.ownKeys(target);
      },
    }) as Rfc64PublicCatalogInventoryEvidenceRowV1[];
    expectCode(() => verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1024' as CountV1,
      expectedRows: oversized,
      observedRows: maximum,
    }), 'catalog-inventory-completeness-count');
    expect(enumeratedOversizedRows).toBe(false);
  });

  it('snapshots top-level, array, scope, and row data without invoking switching gets', () => {
    let topLevelGets = 0;
    let scopeGets = 0;
    let arrayGets = 0;
    let rowGets = 0;
    const only = row(7);
    const switchingScope = new Proxy({ ...SCOPE }, {
      get(target, key, receiver) {
        scopeGets += 1;
        return key === 'networkId' && scopeGets > 1
          ? 'otp:tampered'
          : Reflect.get(target, key, receiver);
      },
    });
    const switchingRow = new Proxy({ ...only }, {
      get(target, key, receiver) {
        rowGets += 1;
        return key === 'contentDigest' && rowGets > 1
          ? digest(999)
          : Reflect.get(target, key, receiver);
      },
    });
    const switchingArray = new Proxy([switchingRow], {
      get(target, key, receiver) {
        arrayGets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const switchingInput = new Proxy({
      catalogScope: switchingScope,
      expectedTotalRows: '1' as CountV1,
      expectedRows: switchingArray,
      observedRows: switchingArray,
    }, {
      get(target, key, receiver) {
        topLevelGets += 1;
        return key === 'expectedTotalRows' && topLevelGets > 1
          ? '999'
          : Reflect.get(target, key, receiver);
      },
    });

    const evidence = verifyRfc64PublicCatalogInventoryCompletenessV1(switchingInput);
    expect(evidence.inventoryRowCount).toBe('1');
    expect(evidence.rows[0]).toEqual(only);
    expect({ topLevelGets, scopeGets, arrayGets, rowGets }).toEqual({
      topLevelGets: 0,
      scopeGets: 0,
      arrayGets: 0,
      rowGets: 0,
    });
  });

  it('rejects accessor inputs without invoking them and remains reentry-safe', () => {
    let getterInvoked = false;
    const accessorInput = Object.defineProperties({}, {
      catalogScope: { value: SCOPE, enumerable: true },
      expectedTotalRows: {
        enumerable: true,
        get() {
          getterInvoked = true;
          return '1';
        },
      },
      expectedRows: { value: [row(1)], enumerable: true },
      observedRows: { value: [row(1)], enumerable: true },
    }) as VerifyParameters;
    expectCode(
      () => verifyRfc64PublicCatalogInventoryCompletenessV1(accessorInput),
      'catalog-inventory-completeness-input',
    );
    expect(getterInvoked).toBe(false);

    const only = row(9);
    let reentered = false;
    let insideTrap = false;
    const reentrantRow = new Proxy({ ...only }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'contentDigest' && !insideTrap) {
          insideTrap = true;
          const nested = verifyRfc64PublicCatalogInventoryCompletenessV1({
            catalogScope: SCOPE,
            expectedTotalRows: '1' as CountV1,
            expectedRows: [only],
            observedRows: [only],
          });
          reentered = nested.rows[0].kaId === only.kaId;
          insideTrap = false;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const outer = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: SCOPE,
      expectedTotalRows: '1' as CountV1,
      expectedRows: [reentrantRow],
      observedRows: [reentrantRow],
    });
    expect(reentered).toBe(true);
    expect(outer.rows[0]).toEqual(only);
  });
});

type VerifyParameters = Parameters<
  typeof verifyRfc64PublicCatalogInventoryCompletenessV1
>[0];

const BASE = Object.freeze([row(1), row(2)]);

function row(number: number): Rfc64PublicCatalogInventoryEvidenceRowV1 {
  const kaId = ((BigInt(AUTHOR) << 96n) | BigInt(number)).toString() as KaIdV1;
  return Object.freeze({
    kaId,
    catalogRowDigest: digest(number * 4),
    contentDigest: digest((number * 4) + 1),
    sealDigest: digest((number * 4) + 2),
    bundleDigest: digest((number * 4) + 3),
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
