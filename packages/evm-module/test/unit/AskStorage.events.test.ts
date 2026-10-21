import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Interface } from 'ethers';
import hre from 'hardhat';

const eventAbi = new Interface([
  'event WeightedActiveAskSumUpdated(uint256 newSum)',
  'event PrevWeightedActiveAskSumUpdated(uint256 newSum)',
  'event TotalActiveStakeUpdated(uint96 newStake)',
  'event PrevTotalActiveStakeUpdated(uint96 newStake)',
]);

async function fixture() {
  const [owner, outsider] = await hre.ethers.getSigners();
  const hub = await (await hre.ethers.getContractFactory('Hub')).deploy();
  await hub.waitForDeployment();
  const ask = await (await hre.ethers.getContractFactory('AskStorage')).deploy(await hub.getAddress());
  await ask.waitForDeployment();
  return { ask, hub, owner, outsider };
}

const mutations = [
  ['setWeightedActiveAskSum', 'weightedActiveAskSum', 'WeightedActiveAskSumUpdated', 150n],
  ['increaseWeightedActiveAskSum', 'weightedActiveAskSum', 'WeightedActiveAskSumUpdated', 110n],
  ['decreaseWeightedActiveAskSum', 'weightedActiveAskSum', 'WeightedActiveAskSumUpdated', 90n],
  ['setPrevWeightedActiveAskSum', 'prevWeightedActiveAskSum', 'PrevWeightedActiveAskSumUpdated', 150n],
  ['setTotalActiveStake', 'totalActiveStake', 'TotalActiveStakeUpdated', 150n],
  ['increaseTotalActiveStake', 'totalActiveStake', 'TotalActiveStakeUpdated', 110n],
  ['decreaseTotalActiveStake', 'totalActiveStake', 'TotalActiveStakeUpdated', 90n],
  ['setPrevTotalActiveStake', 'prevTotalActiveStake', 'PrevTotalActiveStakeUpdated', 150n],
] as const;

describe('@unit AskStorage event-backed pricing state', () => {
  for (const [method, getter, event, expected] of mutations) {
    it(`${method} emits the exact new ${getter} from the real receipt`, async () => {
      const { ask } = await loadFixture(fixture);
      const setter = `set${getter[0].toUpperCase()}${getter.slice(1)}`;
      await (await ask.getFunction(setter)(100n)).wait();
      const receipt = await (await ask.getFunction(method)(method.startsWith('set') ? 150n : 10n)).wait();
      const logs = receipt!.logs.filter(log => log.address === ask.target)
        .map(log => eventAbi.parseLog(log)).filter(Boolean);
      expect(logs, 'Every successful state mutation must be indexable').to.have.length(1);
      expect(logs[0]!.name).to.equal(event);
      expect(logs[0]!.args[0]).to.equal(expected);
      expect(await ask.getFunction(getter)()).to.equal(expected);
    });
  }

  it('retains Hub registration authorization and lossless maximum-size values', async () => {
    const { ask, hub, outsider } = await loadFixture(fixture);
    await (await hub.getFunction('setContractAddress')('AuthorizedWriter', outsider.address)).wait();
    for (const [setter, getter, event, maximum] of [
      ['setWeightedActiveAskSum', 'weightedActiveAskSum', 'WeightedActiveAskSumUpdated', (1n << 256n) - 1n],
      ['setPrevWeightedActiveAskSum', 'prevWeightedActiveAskSum', 'PrevWeightedActiveAskSumUpdated', (1n << 256n) - 1n],
      ['setTotalActiveStake', 'totalActiveStake', 'TotalActiveStakeUpdated', (1n << 96n) - 1n],
      ['setPrevTotalActiveStake', 'prevTotalActiveStake', 'PrevTotalActiveStakeUpdated', (1n << 96n) - 1n],
    ] as const) {
      const receipt = await (await ask.connect(outsider).getFunction(setter)(maximum)).wait();
      const logs = receipt!.logs.filter(log => log.address === ask.target).map(log => eventAbi.parseLog(log));
      expect(logs).to.have.length(1);
      expect(logs[0]!.name).to.equal(event);
      expect(logs[0]!.args[0]).to.equal(maximum);
      expect(await ask.getFunction(getter)()).to.equal(maximum);
    }
  });

  it('reconstructs both quotes from logs through zero stakes and all eight mutations', async () => {
    const { ask } = await loadFixture(fixture);
    const indexed = { sum: 0n, stake: 0n, previousSum: 0n, previousStake: 0n };
    const actions = [
      ['setWeightedActiveAskSum', 200n], ['setTotalActiveStake', 10n],
      ['increaseWeightedActiveAskSum', 25n], ['increaseTotalActiveStake', 5n],
      ['decreaseWeightedActiveAskSum', 45n], ['decreaseTotalActiveStake', 3n],
      ['setPrevWeightedActiveAskSum', 200n], ['setPrevTotalActiveStake', 10n],
      ['setTotalActiveStake', 0n], ['setPrevTotalActiveStake', 0n],
      ['setWeightedActiveAskSum', 0n], ['setPrevWeightedActiveAskSum', 0n],
      ['increaseTotalActiveStake', 0n], ['decreaseWeightedActiveAskSum', 0n],
    ] as const;
    for (const [method, value] of actions) {
      const receipt = await (await ask.getFunction(method)(value)).wait();
      const logs = receipt!.logs.filter(log => log.address === ask.target).map(log => eventAbi.parseLog(log));
      expect(logs).to.have.length(1);
      for (const log of logs) {
        if (log!.name === 'WeightedActiveAskSumUpdated') indexed.sum = log!.args[0];
        if (log!.name === 'TotalActiveStakeUpdated') indexed.stake = log!.args[0];
        if (log!.name === 'PrevWeightedActiveAskSumUpdated') indexed.previousSum = log!.args[0];
        if (log!.name === 'PrevTotalActiveStakeUpdated') indexed.previousStake = log!.args[0];
      }
      expect(indexed.stake ? indexed.sum / indexed.stake : 0n).to.equal(await ask.getFunction('getStakeWeightedAverageAsk')());
      expect(indexed.previousStake ? indexed.previousSum / indexed.previousStake : 0n).to.equal(await ask.getFunction('getPrevStakeWeightedAverageAsk')());
    }
  });

  it('emits no logs and preserves state on unauthorized calls to every mutator', async () => {
    const { ask, outsider } = await loadFixture(fixture);
    const start = await hre.ethers.provider.getBlockNumber();
    for (const [method, getter] of mutations) {
      await expect(ask.connect(outsider).getFunction(method)(1n)).to.be.revertedWithCustomError(ask, 'UnauthorizedAccess');
      expect(await ask.getFunction(getter)()).to.equal(0n);
    }
    const logs = await hre.ethers.provider.getLogs({ address: await ask.getAddress(), fromBlock: start + 1, toBlock: 'latest' });
    expect(logs).to.have.length(0);
  });

  for (const [setter, method, getter, value] of [
    ['setWeightedActiveAskSum', 'increaseWeightedActiveAskSum', 'weightedActiveAskSum', (1n << 256n) - 1n],
    ['setWeightedActiveAskSum', 'decreaseWeightedActiveAskSum', 'weightedActiveAskSum', 0n],
    ['setTotalActiveStake', 'increaseTotalActiveStake', 'totalActiveStake', (1n << 96n) - 1n],
    ['setTotalActiveStake', 'decreaseTotalActiveStake', 'totalActiveStake', 0n],
  ] as const) {
    it(`${method} emits no state on arithmetic revert`, async () => {
      const { ask } = await loadFixture(fixture);
      await (await ask.getFunction(setter)(value)).wait();
      const start = await hre.ethers.provider.getBlockNumber();
      await expect(ask.getFunction(method)(1n)).to.be.revertedWithPanic(0x11);
      expect(await ask.getFunction(getter)()).to.equal(value);
      expect(await hre.ethers.provider.getLogs({ address: await ask.getAddress(), fromBlock: start + 1, toBlock: 'latest' })).to.have.length(0);
    });
  }
});
