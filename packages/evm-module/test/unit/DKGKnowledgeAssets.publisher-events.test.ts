import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import type { DKGKnowledgeAssets } from '../../typechain';
import { packReservedKaId } from '../helpers/v10-ka-helpers';

async function fixture() {
  const accounts = await hre.ethers.getSigners();
  const hub = await (await hre.ethers.getContractFactory('Hub')).deploy();
  const store = await (await hre.ethers.getContractFactory('DKGKnowledgeAssets'))
    .deploy(await hub.getAddress(), 1, '') as unknown as DKGKnowledgeAssets;
  const author = accounts[1].address;
  const publisher = accounts[2].address;
  const id = packReservedKaId(author, 0);
  const root = ethers.keccak256(ethers.toUtf8Bytes('publisher-event-root'));
  const mint = (by = publisher, owner = author, kaId = id) => store.createKnowledgeAsset(
    by, owner, kaId, 'create', root, 1, 100, 1, 2, 0, false, 1,
  );
  return { accounts, hub, store, author, publisher, id, root, mint };
}

describe('@unit latest Knowledge Asset publisher event projection', () => {
  it('reports the supplied contract publisher, independently of author and transaction sender', async () => {
    const { accounts, store, author, id, mint } = await loadFixture(fixture);
    expect(await store.version()).to.equal('10.1.1');
    const wallet = await (await hre.ethers.getContractFactory('MockERC1271Wallet'))
      .deploy(accounts[3].address);
    const publisher = await wallet.getAddress();
    expect(publisher).not.to.equal(author);
    expect(publisher).not.to.equal(accounts[0].address);
    await expect(mint(publisher)).to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, publisher);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(publisher);
    expect(await store.getLatestMerkleRootAuthor(id)).to.equal(author);
  });

  it('reports each update, including consecutive roots from the same publisher', async () => {
    const { store, author, publisher, id, root, mint } = await loadFixture(fixture);
    await mint();
    for (const operation of ['update-one', 'update-two']) {
      await expect(store.updateKnowledgeAsset(publisher, author, id, operation, root, 0, [], 101, 0, 1))
        .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, publisher);
      expect(await store.getLatestMerkleRootPublisher(id)).to.equal(publisher);
    }
  });

  it('projects wholesale replacement and empty history exactly as the getter', async () => {
    const { accounts, store, publisher, id, root, mint } = await loadFixture(fixture);
    await mint();
    const latest = accounts[4].address;
    await expect(store.setMerkleRoots(id, [[publisher, root, 1], [latest, root, 2]]))
      .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, latest);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(latest);
    await expect(store.setMerkleRoots(id, []))
      .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, ethers.ZeroAddress);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(ethers.ZeroAddress);
  });

  it('projects push, rollback to the prior publisher and removal of the last root', async () => {
    const { accounts, store, publisher, id, root, mint } = await loadFixture(fixture);
    await mint();
    const next = accounts[4].address;
    await expect(store.pushMerkleRoot(next, id, root))
      .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, next);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(next);
    await expect(store.popMerkleRoot(id))
      .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, publisher);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(publisher);
    await expect(store.popMerkleRoot(id))
      .to.emit(store, 'KnowledgeAssetPublisherUpdated').withArgs(id, ethers.ZeroAddress);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(ethers.ZeroAddress);
  });

  it('keeps receipt order correct if the mint receiver changes the latest publisher', async () => {
    const { accounts, hub, store, publisher, mint } = await loadFixture(fixture);
    const next = accounts[4].address;
    const receiver = await (await hre.ethers.getContractFactory('PublisherChangingERC721Receiver'))
      .deploy(await store.getAddress(), next);
    const author = await receiver.getAddress();
    await hub.setContractAddress('PublisherChangingReceiver', author);
    const id = packReservedKaId(author, 0);
    const tx = await mint(publisher, author, id);
    const receipt = await tx.wait();
    const events = receipt!.logs.flatMap(log => {
      try {
        const event = store.interface.parseLog(log);
        return event?.name === 'KnowledgeAssetPublisherUpdated' ? [event.args.publisher] : [];
      } catch { return []; }
    });
    expect(events).to.deep.equal([publisher, next]);
    expect(events.at(-1)).to.equal(await store.getLatestMerkleRootPublisher(id));
  });

  it('preserves authorization and emits no projection from rejected mutations', async () => {
    const { accounts, store, author, publisher, id, root, mint } = await loadFixture(fixture);
    await mint();
    const outsider = store.connect(accounts[5]);
    const before = await store.queryFilter(store.filters.KnowledgeAssetPublisherUpdated(id));
    await expect(outsider.createKnowledgeAsset(publisher, author, id, 'bad', root, 1, 100, 1, 2, 0, false, 1)).to.be.reverted;
    await expect(outsider.updateKnowledgeAsset(publisher, author, id, 'bad', root, 0, [], 101, 0, 1)).to.be.reverted;
    await expect(outsider.setMerkleRoots(id, [])).to.be.reverted;
    await expect(outsider.pushMerkleRoot(publisher, id, root)).to.be.reverted;
    await expect(outsider.popMerkleRoot(id)).to.be.reverted;
    await expect(mint()).to.be.revertedWithCustomError(store, 'KaIdAlreadyMinted');
    expect(await store.queryFilter(store.filters.KnowledgeAssetPublisherUpdated(id))).to.have.length(before.length);
    expect(await store.getLatestMerkleRootPublisher(id)).to.equal(publisher);
  });
});
