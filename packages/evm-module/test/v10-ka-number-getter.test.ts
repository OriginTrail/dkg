import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Hub, DKGKnowledgeAssets } from '../typechain';
import { packReservedKaId } from './helpers/v10-kc-helpers';

/**
 * OT-RFC-43 Option 1 (variant 1a): `getMaxKaNumberForAuthor` is the O(1)
 * on-chain replacement for enumerating `KnowledgeAssetCreated(id, author)` logs
 * to recover an author's high-water KA `number`. It must reproduce the exact
 * semantics the off-chain allocator already relies on: `-1` when the author has
 * never minted (so the next number is `-1 + 1 = 0`), otherwise the highest
 * minted `number`, never regressed by a gap-filling lower mint.
 */
async function deployFixture() {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
  ]);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);
  const DKGKnowledgeAssets = await hre.ethers.getContract<DKGKnowledgeAssets>(
    'DKGKnowledgeAssets',
  );
  return { accounts, Hub, DKGKnowledgeAssets };
}

describe('@unit DKGKnowledgeAssets.getMaxKaNumberForAuthor (OT-RFC-43 Option 1)', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let storageOperator: SignerWithAddress;

  // Mint a KA with the packed kaId for (author, number). `createKnowledgeAsset`
  // is `onlyContracts`, so it is called from the Hub-registered storageOperator.
  async function mint(author: string, num: number | bigint) {
    const kaId = packReservedKaId(author, num);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address, // publisher
      author, // author — high 160 bits of kaId must equal this (namespace check)
      kaId,
      `op-${author}-${num}`,
      ethers.keccak256(ethers.toUtf8Bytes(`root-${author}-${num}`)),
      1, // knowledgeAssetsAmount (must be 1)
      1000, // byteSize
      1, // startEpoch
      2, // endEpoch
      0, // tokenAmount
      false, // isImmutable
      1, // merkleLeafCount
    );
    return kaId;
  }

  beforeEach(async () => {
    ({ accounts, Hub, DKGKnowledgeAssets } = await loadFixture(deployFixture));
    storageOperator = accounts[19];
    await Hub.setContractAddress('TestStorageOperator', storageOperator.address);
  });

  it('returns -1 for an author that has never minted', async () => {
    expect(
      await DKGKnowledgeAssets.getMaxKaNumberForAuthor(accounts[1].address),
    ).to.equal(-1n);
  });

  it('distinguishes a legitimately-minted number 0 from never-minted', async () => {
    const authorZero = accounts[1].address;
    const authorFive = accounts[2].address;
    await mint(authorZero, 0);
    await mint(authorFive, 5);

    expect(
      await DKGKnowledgeAssets.getMaxKaNumberForAuthor(authorZero),
    ).to.equal(0n);
    expect(
      await DKGKnowledgeAssets.getMaxKaNumberForAuthor(authorFive),
    ).to.equal(5n);
    // an unrelated author is still the never-minted sentinel
    expect(
      await DKGKnowledgeAssets.getMaxKaNumberForAuthor(accounts[3].address),
    ).to.equal(-1n);
  });

  it('rises with a higher number and never regresses on a gap-filling lower mint', async () => {
    const author = accounts[2].address;
    await mint(author, 5);
    await mint(author, 10);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(author)).to.equal(
      10n,
    );

    // Numbers can be sparse on-chain (reserved-but-unpublished gaps), so a later
    // mint of a lower number must NOT lower the high-water mark.
    await mint(author, 3);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(author)).to.equal(
      10n,
    );
  });

  it('reproduces the allocator floor: next number == getMaxKaNumberForAuthor + 1', async () => {
    const author = accounts[4].address;
    // fresh author => -1 => allocator next = 0
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(author)).to.equal(
      -1n,
    );
    await mint(author, 0);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(author)).to.equal(
      0n,
    ); // next = 1
    await mint(author, 1);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(author)).to.equal(
      1n,
    );
  });

  it('is namespaced per author (no cross-author leakage)', async () => {
    const a = accounts[5].address;
    const b = accounts[6].address;
    await mint(a, 7);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(a)).to.equal(7n);
    expect(await DKGKnowledgeAssets.getMaxKaNumberForAuthor(b)).to.equal(-1n);
  });
});
