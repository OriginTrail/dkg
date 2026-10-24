/**
 * GH#3081 / GH#3072 — a successor producer that does not verify a second time the rows this
 * process has already verified. The producer, the canonical catalog producer and every core
 * verifier are the real ones; only the stores are in memory, and the core verifiers are counted.
 */
import {
  canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifications = vi.hoisted(() => ({ sealBinding: 0, transferredBundle: 0, projection: 0 }));
vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    verifyCatalogSealBindingV1: (...args: Parameters<typeof actual.verifyCatalogSealBindingV1>) => {
      verifications.sealBinding += 1;
      return actual.verifyCatalogSealBindingV1(...args);
    },
    verifyTransferredCatalogBundleV1: (
      ...args: Parameters<typeof actual.verifyTransferredCatalogBundleV1>
    ) => {
      verifications.transferredBundle += 1;
      return actual.verifyTransferredCatalogBundleV1(...args);
    },
    verifyCgSharedProjectionV1: (...args: Parameters<typeof actual.verifyCgSharedProjectionV1>) => {
      verifications.projection += 1;
      return actual.verifyCgSharedProjectionV1(...args);
    },
  };
});

import {
  Rfc64SuccessorRowVerificationV1,
  Rfc64VerifiedCatalogRowSetV1,
} from '../src/internal/verified-catalog-rows.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import {
  PRODUCER_AUTHOR,
  PRODUCER_AUTHOR_WALLET,
  PRODUCER_DEPLOYMENT,
  preparedSuccessorRowV1,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSealV1,
  producerSignerV1,
  type ProducerHistoryV1,
} from './support/rfc64-successor-producer-fixture.js';

type Genesis = Awaited<ReturnType<typeof producerGenesisV1>>;

/** The verifications one production ran. */
interface Counted<T> {
  readonly result: T;
  readonly sealBinding: number;
  readonly transferredBundle: number;
  readonly projection: number;
}

async function counted<T>(work: () => Promise<T>): Promise<Counted<T>> {
  verifications.sealBinding = 0;
  verifications.transferredBundle = 0;
  verifications.projection = 0;
  const result = await work();
  return { result, ...verifications };
}

function produce(
  genesis: Genesis,
  history: ProducerHistoryV1,
  assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[],
  step: number,
  options: Readonly<{
    verifiedRows?: Rfc64VerifiedCatalogRowSetV1;
    signDigest?: (digest: Uint8Array) => Promise<string>;
    signal?: AbortSignal;
    deployment?: typeof PRODUCER_DEPLOYMENT;
  }> = {},
) {
  return producerOverMemoryV1({ verifiedRows: options.verifiedRows }).produceAndStageExactSet({
    ...history,
    assets: [...assets],
    deployment: options.deployment ?? PRODUCER_DEPLOYMENT,
    issuedAt: String(1773900001000 + step * 1000) as never,
    catalogSigner: producerSignerV1(options.signDigest),
    catalogIssuerAuthorization: genesis.authorization,
    signal: options.signal,
  });
}

function historyOf(produced: Awaited<ReturnType<typeof produce>>): ProducerHistoryV1 {
  return {
    previousHead: produced.publication.head,
    previousDirectoryPath: produced.publication.directoryPath,
    previousBucket: produced.publication.bucket,
  };
}

/** Insert three rows, replace one with its next version, remove it, insert a fourth. */
async function successiveSets(): Promise<readonly (readonly Rfc64PublicCatalogSuccessorAssetInputV1[])[]> {
  const [one, two, three, four] = await Promise.all([1, 2, 3, 4].map((ka) => producerAssetV1(ka)));
  const twoNext = await producerAssetV1(2, '2');
  return [
    [one!],
    [one!, two!],
    [one!, two!, three!],
    [one!, twoNext, three!],
    [one!, three!],
    [one!, three!, four!],
  ];
}

/** A catalog of `rows` rows whose every row is remembered. */
async function rememberedCatalog(rows: number) {
  const genesis = await producerGenesisV1();
  const verifiedRows = new Rfc64VerifiedCatalogRowSetV1();
  const assets: Rfc64PublicCatalogSuccessorAssetInputV1[] = [];
  let history = genesis.history;
  for (let row = 1; row <= rows; row += 1) {
    assets.push(await producerAssetV1(row));
    history = historyOf(await produce(genesis, history, assets, row, { verifiedRows }));
  }
  expect(verifiedRows.size).toBe(rows);
  return { genesis, verifiedRows, assets, history };
}

describe('RFC-64 successor production over rows already verified', () => {
  beforeEach(() => {
    verifications.sealBinding = 0;
    verifications.transferredBundle = 0;
    verifications.projection = 0;
  });

  it('signs the same bytes and reports the same evidence as a production that verifies every row', async () => {
    const genesis = await producerGenesisV1();
    const sets = await successiveSets();
    const verifiedRows = new Rfc64VerifiedCatalogRowSetV1();
    let plainHistory = genesis.history;
    let reusingHistory = genesis.history;
    const plainCounts: number[] = [];
    const reusingCounts: number[] = [];

    for (const [step, assets] of sets.entries()) {
      const plain = await counted(() => produce(genesis, plainHistory, assets, step));
      const reusing = await counted(() => produce(genesis, reusingHistory, assets, step, { verifiedRows }));
      plainCounts.push(plain.transferredBundle);
      reusingCounts.push(reusing.transferredBundle);
      // One verifier of each kind per verified row, in both productions.
      expect([plain.sealBinding, plain.projection]).toEqual([plain.transferredBundle, plain.transferredBundle]);
      expect([reusing.sealBinding, reusing.projection])
        .toEqual([reusing.transferredBundle, reusing.transferredBundle]);

      const expected = plain.result;
      const actual = reusing.result;
      expect(canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(actual.publication.head))
        .toEqual(canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(expected.publication.head));
      expect(actual.publication.bucket === null ? null
        : canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(actual.publication.bucket))
        .toEqual(expected.publication.bucket === null ? null
          : canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(expected.publication.bucket));
      expect(actual.publication).toEqual(expected.publication);
      // Row, bundle bytes, seal binding, transfer, projection and authorship of every asset.
      expect(actual.assets).toEqual(expected.assets);
      expect(actual.assets.map((asset) => Object.keys(asset.transfer)))
        .toEqual(expected.assets.map((asset) => Object.keys(asset.transfer)));
      expect(actual.assets.map((asset) => Object.keys(asset.projection)))
        .toEqual(expected.assets.map((asset) => Object.keys(asset.projection)));
      expect(JSON.stringify(actual.assets.map(({ transfer, projection }) => ({ transfer, projection }))))
        .toBe(JSON.stringify(expected.assets.map(({ transfer, projection }) => ({ transfer, projection }))));
      for (const asset of actual.assets) {
        expect(asset.transfer.headObjectDigest).toBe(actual.publication.head.objectDigest);
        expect(asset.projection.headObjectDigest).toBe(actual.publication.head.objectDigest);
      }
      // A caller owns its copy of the seal bytes: no two rows or productions share one.
      expect(new Set(actual.assets.map((asset) => asset.sealBinding.canonicalSealBytes)).size)
        .toBe(actual.assets.length);
      expect(verifiedRows.size).toBe(assets.length);
      plainHistory = historyOf(expected);
      reusingHistory = historyOf(actual);
    }

    // Every row of every set, against the one row each successor changed (none for a removal).
    expect(plainCounts).toEqual([1, 2, 3, 3, 2, 3]);
    expect(reusingCounts).toEqual([1, 1, 1, 1, 0, 1]);
  });

  it('verifies every row when no rows are remembered for the producer', async () => {
    const genesis = await producerGenesisV1();
    const sets = await successiveSets();
    let history = genesis.history;
    const counts: number[] = [];
    for (const [step, assets] of sets.slice(0, 3).entries()) {
      const produced = await counted(() => produce(genesis, history, assets, step));
      counts.push(produced.transferredBundle);
      history = historyOf(produced.result);
    }
    expect(counts).toEqual([1, 2, 3]);
  });

  it('forgets every row when a production fails, and verifies them all the next time', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(3);
    const next = [...assets, await producerAssetV1(4)];

    await expect(produce(genesis, history, next, 4, {
      verifiedRows,
      signDigest: async () => { throw new Error('the wallet is locked'); },
    })).rejects.toMatchObject({ code: 'catalog-successor-producer-history' });
    expect(verifiedRows.size).toBe(0);

    const retried = await counted(() => produce(genesis, history, next, 4, { verifiedRows }));
    expect(retried.transferredBundle).toBe(4);
    expect(retried.sealBinding).toBe(4);
    expect(verifiedRows.size).toBe(4);
  });

  it('forgets every row when a production is cancelled', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const reason = new Error('shutting down');

    await expect(produce(genesis, history, [...assets, await producerAssetV1(3)], 3, {
      verifiedRows,
      signal: AbortSignal.abort(reason),
    })).rejects.toBe(reason);
    expect(verifiedRows.size).toBe(0);
  });

  it('still refuses a new row whose author attestation does not recover', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const stranger = new ethers.Wallet(`0x${'68'.repeat(32)}`);
    const forged = {
      assertionCoordinate: 'row-3' as never,
      projectionBytes: assets[0]!.projectionBytes,
      seal: await producerSealV1(3n, '1', stranger),
    };

    const refused = await counted(() => produce(genesis, history, [...assets, forged], 3, { verifiedRows })
      .then(() => 'signed', (cause: { code?: string }) => cause.code));
    expect(refused.result).toBe('catalog-successor-producer-binding');
    // Only the new row reached a verifier; nothing was signed for it.
    expect(refused.sealBinding).toBe(1);
    expect(refused.transferredBundle).toBe(0);
    expect(verifiedRows.size).toBe(0);
  });

  it('still refuses a new row whose projection is not the one its seal commits to', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const other = new TextEncoder().encode(
      '<https://example.org/alice> <https://schema.org/age> "43"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
      + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
    );
    const mismatched = { ...(await producerAssetV1(3)), projectionBytes: other };

    await expect(produce(genesis, history, [...assets, mismatched], 3, { verifiedRows }))
      .rejects.toMatchObject({ code: 'catalog-successor-producer-verification' });
    expect(verifiedRows.size).toBe(0);
  });

  it('finds no row under another lane, and none under the first lane afterwards', async () => {
    const first = await rememberedCatalog(2);
    const other = await producerGenesisV1(
      '0x1111111111111111111111111111111111111111/successor-rows-other' as ContextGraphIdV1,
    );

    // The same asset bytes and the same row fields, under another catalog scope.
    const underOther = await counted(() => produce(other, other.history, [first.assets[0]!], 1, {
      verifiedRows: first.verifiedRows,
    }));
    expect(underOther.transferredBundle).toBe(1);
    expect(underOther.sealBinding).toBe(1);
    expect(first.verifiedRows.size).toBe(1);

    const grown = [...first.assets, await producerAssetV1(3)];
    const backUnderFirst = await counted(() => produce(first.genesis, first.history, grown, 3, {
      verifiedRows: first.verifiedRows,
    }));
    expect(backUnderFirst.transferredBundle).toBe(3);
    expect(first.verifiedRows.size).toBe(3);
  });

  it('finds no row under another pinned deployment', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const elsewhere = {
      ...PRODUCER_DEPLOYMENT,
      assertedAtKav10Address: '0x5555555555555555555555555555555555555555' as never,
    };

    // A removal changes no row. The remaining row's seal was asserted on the other deployment,
    // which only a verification under the new pin can tell.
    const refused = await counted(() => produce(genesis, history, [assets[0]!], 3, {
      verifiedRows,
      deployment: elsewhere,
    }).then(() => 'signed', (cause: { code?: string }) => cause.code));
    expect(refused.result).toBe('catalog-successor-producer-binding');
    expect(refused.sealBinding).toBe(1);
    expect(verifiedRows.size).toBe(0);
  });

  it('finds no row under a deployment pin that only prints like the one it was verified under', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const lookalike = { ...PRODUCER_DEPLOYMENT, assertedAtChainId: 20430 as never };

    // A removal changes no row: every remaining row would be found if the pins were compared as text.
    await expect(produce(genesis, history, [assets[0]!], 3, { verifiedRows, deployment: lookalike }))
      .rejects.toMatchObject({ code: 'catalog-successor-producer-binding' });
    expect(verifiedRows.size).toBe(0);
  });

  it('verifies in full a signed row that is not the row built from the bytes at hand', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(2);
    const head = history.previousHead;
    const signedRow = history.previousBucket!.payload.rows[0]!;
    // The remembered KA, with other bytes than the ones the signed row commits to.
    const otherBytes = preparedSuccessorRowV1({
      ...assets[0]!,
      projectionBytes: new TextEncoder().encode(
        '<https://example.org/alice> <https://schema.org/name> "Alice" .\n'
        + '<https://example.org/alice> <https://schema.org/name> "Bob" .\n',
      ),
    }, genesis.scope);
    const verification = new Rfc64SuccessorRowVerificationV1(verifiedRows);

    verification.assertSealBinds(otherBytes);
    expect(() => verification.verifyProduced(head, signedRow, otherBytes))
      .toThrow(/transferred-bundle-/u);

    // The same signed row over the bytes it does commit to is found without another verification.
    const sameBytes = preparedSuccessorRowV1(assets[0]!, genesis.scope);
    const found = await counted(async () => {
      verification.assertSealBinds(sameBytes);
      return verification.verifyProduced(head, signedRow, sameBytes);
    });
    expect(found.transferredBundle + found.sealBinding + found.projection).toBe(0);
    expect(found.result.transfer.headObjectDigest).toBe(head.objectDigest);
    expect(found.result.sealBinding.authorAddress).toBe(PRODUCER_AUTHOR);
  });

  it('does not look a row up before the production has checked that row\'s seal', async () => {
    const { genesis, verifiedRows, assets, history } = await rememberedCatalog(1);
    const prepared = preparedSuccessorRowV1(assets[0]!, genesis.scope);
    const verification = new Rfc64SuccessorRowVerificationV1(verifiedRows);

    const verified = await counted(async () => verification.verifyProduced(
      history.previousHead,
      history.previousBucket!.payload.rows[0]!,
      prepared,
    ));
    expect(verified.transferredBundle).toBe(1);
    expect(verified.projection).toBe(1);
  });

  it('keeps what one completed successor holds and nothing else', async () => {
    const rows = new Rfc64VerifiedCatalogRowSetV1();
    const outcome = { transfer: {}, projection: {} } as never;
    rows.replace('scope-a', new Map([['row-1', outcome], ['row-2', outcome]]));
    expect(rows.find('scope-a', 'row-1')).toBe(outcome);
    expect(rows.find('scope-b', 'row-1')).toBeUndefined();
    expect(rows.find(undefined, 'row-1')).toBeUndefined();

    rows.replace('scope-a', new Map([['row-2', outcome]]));
    expect(rows.size).toBe(1);
    expect(rows.find('scope-a', 'row-1')).toBeUndefined();

    // A successor without rows, or one whose scope could not be named, leaves nothing behind.
    rows.replace('scope-a', new Map());
    expect(rows.size).toBe(0);
    rows.replace(undefined, new Map([['row-1', outcome]]));
    expect(rows.size).toBe(0);
    expect(PRODUCER_AUTHOR_WALLET.address.toLowerCase()).toBe(PRODUCER_AUTHOR);
  });
});
