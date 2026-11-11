// ConvictionWithdrawalStorage: what a withdrawn conviction position leaves to
// claim of the epoch that was in progress at its withdrawal (StakingV10
// 10.1.0).
//
// Covers:
//   - the gates: every mutator is onlyContracts (a Hub-registered contract or
//     the Hub owner);
//   - a record and its carries: written once, read whole and carry by carry,
//     and deleted together;
//   - the narrow carry setters: a carry joins only a recorded token id, once
//     per slot it points at and at most 32, the bound ConvictionStakingStorage
//     puts on a position's carries, and the carries clear without the record;
//   - the compiler's storage layout against the documented one.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ConvictionStakingStorage, ConvictionWithdrawalStorage, Hub } from '../../typechain';

type Fixture = {
  Hub: Hub;
  CWS: ConvictionWithdrawalStorage;
  owner: SignerWithAddress;
  logic: SignerWithAddress;
  stranger: SignerWithAddress;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['Hub']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  const Factory = await hre.ethers.getContractFactory('ConvictionWithdrawalStorage');
  const CWS = (await Factory.deploy(await Hub.getAddress())) as unknown as ConvictionWithdrawalStorage;
  await CWS.waitForDeployment();
  await Hub.setContractAddress('ConvictionWithdrawalStorage', await CWS.getAddress());
  // A Hub-registered contract stands in for StakingV10Ledger.
  await Hub.setContractAddress('WithdrawalLogicStandIn', accounts[1].address);

  return { Hub, CWS, owner: accounts[0], logic: accounts[1], stranger: accounts[2] };
}

const STAKER = ethers.getAddress('0x00000000000000000000000000000000000000d5');

const recordOf = (overrides: Partial<{ staker: string; identityId: bigint; epoch: bigint }> = {}) => ({
  staker: STAKER,
  identityId: 7n,
  epoch: 12n,
  ...overrides,
});

const carryOf = (identityId: bigint, epoch: bigint, key: bigint) => ({
  identityId,
  epoch,
  delegatorKey: ethers.toBeHex(key, 32),
});

/** A struct read back from the contract, as a plain object. */
const plain = (r: unknown) => (r as ethers.Result).toObject();

describe('@unit ConvictionWithdrawalStorage', () => {
  let Hub: Hub;
  let CWS: ConvictionWithdrawalStorage;
  let owner: SignerWithAddress;
  let logic: SignerWithAddress;
  let stranger: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ Hub, CWS, owner, logic, stranger } = await loadFixture(deployFixture));
  });

  /** Every carry `tokenId`'s record holds, read one by one. */
  const carriesOf = async (tokenId: bigint) => {
    const out = [];
    for (let i = 0n; i < (await CWS.rewardCarryCount(tokenId)); i++) out.push(plain(await CWS.rewardCarryAt(tokenId, i)));
    return out;
  };

  it('is named ConvictionWithdrawalStorage, version 1.0.0', async () => {
    expect(await CWS.name()).to.equal('ConvictionWithdrawalStorage');
    expect(await CWS.version()).to.equal('1.0.0');
  });

  describe('mutator gates (onlyContracts)', () => {
    // Each call takes a salt so the two passing callers write distinct records.
    const mutators: Array<[string, (c: ConvictionWithdrawalStorage, salt: bigint) => Promise<unknown>]> = [
      ['setWithdrawal', (c, s) => c.setWithdrawal(s, recordOf(), [carryOf(1n, 12n, 1n)])],
      ['deleteWithdrawal', (c, s) => c.deleteWithdrawal(s)],
      [
        'addRewardCarry',
        async (c, s) => {
          await CWS.connect(logic).setWithdrawal(100n + s, recordOf(), []);
          return c.addRewardCarry(100n + s, carryOf(1n, 12n, 1n));
        },
      ],
      ['clearRewardCarries', (c, s) => c.clearRewardCarries(s)],
    ];

    it('the list below covers every state-changing function', () => {
      const stateChanging: string[] = [];
      CWS.interface.forEachFunction((f) => {
        if (f.stateMutability === 'nonpayable') stateChanging.push(f.name);
      });
      expect(stateChanging.sort()).to.deep.equal(mutators.map(([n]) => n).sort());
    });

    for (const [name, call] of mutators) {
      it(`${name} refuses a caller outside the Hub, and admits a Hub contract and the Hub owner`, async () => {
        await expect(call(CWS.connect(stranger), 1n))
          .to.be.revertedWithCustomError(CWS, 'UnauthorizedAccess')
          .withArgs('Only Contracts in Hub');
        await call(CWS.connect(logic), 2n);
        await call(CWS.connect(owner), 3n);
      });
    }
  });

  describe('a record and its carries', () => {
    it('every view reads empty for a token id never recorded', async () => {
      const [w, carries] = await CWS.getWithdrawal(9n);
      expect(plain(w)).to.deep.equal({ staker: ethers.ZeroAddress, identityId: 0n, epoch: 0n });
      expect(carries.length).to.equal(0);
      expect(await CWS.rewardCarryCount(9n)).to.equal(0n);
      await expect(CWS.rewardCarryAt(9n, 0n)).to.be.revertedWithPanic(0x32);
    });

    it('setWithdrawal writes a record with its carries once; the views read it whole and carry by carry; deleteWithdrawal deletes both', async () => {
      const carries = [carryOf(3n, 12n, 21n), carryOf(4n, 12n, 22n)];
      await CWS.connect(logic).setWithdrawal(21n, recordOf(), carries);
      const [w, read] = await CWS.getWithdrawal(21n);
      expect(plain(w)).to.deep.equal(recordOf());
      expect(read.map(plain)).to.deep.equal(carries);
      expect(await CWS.rewardCarryCount(21n)).to.equal(2n);
      expect(await carriesOf(21n)).to.deep.equal(carries);
      await expect(CWS.rewardCarryAt(21n, 2n)).to.be.revertedWithPanic(0x32);

      // One record per token id.
      await expect(CWS.connect(logic).setWithdrawal(21n, recordOf({ epoch: 13n }), []))
        .to.be.revertedWithCustomError(CWS, 'WithdrawalRecorded')
        .withArgs(21n);

      await CWS.connect(logic).deleteWithdrawal(21n);
      expect((await CWS.getWithdrawal(21n))[0].epoch).to.equal(0n);
      expect(await CWS.rewardCarryCount(21n)).to.equal(0n);
    });
  });

  describe('the narrow carry setters', () => {
    it('addRewardCarry adds a carry to a recorded token id alone, once per slot it points at, and refuses a token id with no record', async () => {
      await expect(CWS.connect(logic).addRewardCarry(31n, carryOf(3n, 12n, 31n)))
        .to.be.revertedWithCustomError(CWS, 'WithdrawalNotRecorded')
        .withArgs(31n);
      expect(await CWS.rewardCarryCount(31n)).to.equal(0n);

      await CWS.connect(logic).setWithdrawal(31n, recordOf(), [carryOf(3n, 12n, 31n)]);
      await CWS.connect(logic).addRewardCarry(31n, carryOf(4n, 12n, 32n));
      // The same node, epoch and key again, already carried: not added twice.
      await CWS.connect(logic).addRewardCarry(31n, carryOf(4n, 12n, 32n));
      await CWS.connect(logic).addRewardCarry(31n, carryOf(3n, 12n, 31n));
      // Another key, or another epoch, of the same node is another slot.
      await CWS.connect(logic).addRewardCarry(31n, carryOf(4n, 12n, 33n));
      await CWS.connect(logic).addRewardCarry(31n, carryOf(4n, 11n, 32n));
      expect(await carriesOf(31n)).to.deep.equal([
        carryOf(3n, 12n, 31n),
        carryOf(4n, 12n, 32n),
        carryOf(4n, 12n, 33n),
        carryOf(4n, 11n, 32n),
      ]);
      expect(plain((await CWS.getWithdrawal(31n))[0])).to.deep.equal(recordOf());
    });

    it('a record takes at most 32 carries, the bound ConvictionStakingStorage puts on a position', async () => {
      const Staking = await hre.ethers.getContractFactory('ConvictionStakingStorage');
      const staking = (await Staking.deploy(await Hub.getAddress())) as unknown as ConvictionStakingStorage;
      expect(await staking.MAX_REWARD_CARRIES()).to.equal(32n);

      await CWS.connect(logic).setWithdrawal(41n, recordOf(), []);
      for (let i = 0n; i < 32n; i++) await CWS.connect(logic).addRewardCarry(41n, carryOf(1n, 12n, i));
      await expect(CWS.connect(logic).addRewardCarry(41n, carryOf(1n, 12n, 32n)))
        .to.be.revertedWithCustomError(CWS, 'RewardCarriesFull')
        .withArgs(41n);
      // A carry the record holds already is no addition, even when full.
      await CWS.connect(logic).addRewardCarry(41n, carryOf(1n, 12n, 0n));
      expect(await CWS.rewardCarryCount(41n)).to.equal(32n);
    });

    it('clearRewardCarries removes the carries and keeps the record, which then takes carries again', async () => {
      await CWS.connect(logic).setWithdrawal(51n, recordOf(), [carryOf(3n, 12n, 51n), carryOf(4n, 12n, 52n)]);
      await CWS.connect(logic).clearRewardCarries(51n);
      expect(await CWS.rewardCarryCount(51n)).to.equal(0n);
      expect(plain((await CWS.getWithdrawal(51n))[0])).to.deep.equal(recordOf());
      await CWS.connect(logic).addRewardCarry(51n, carryOf(5n, 12n, 53n));
      expect(await carriesOf(51n)).to.deep.equal([carryOf(5n, 12n, 53n)]);
      // A token id with no record has none to clear.
      await CWS.connect(logic).clearRewardCarries(52n);
      expect(await CWS.rewardCarryCount(52n)).to.equal(0n);
    });
  });

  describe('storage layout', () => {
    type LayoutEntry = { label: string; slot: string; offset: number; type: string };
    type LayoutType = { label: string; numberOfBytes: string; members?: LayoutEntry[] };
    type StorageLayout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };

    it('matches the documented layout: slot 0 the hub, slot 1 the records, slot 2 their carries', async () => {
      const sourceName = 'contracts/storage/ConvictionWithdrawalStorage.sol';
      const buildInfo = await hre.artifacts.getBuildInfo(`${sourceName}:ConvictionWithdrawalStorage`);
      const layout = (
        buildInfo?.output.contracts[sourceName]?.ConvictionWithdrawalStorage as { storageLayout?: StorageLayout } | undefined
      )?.storageLayout;
      expect(layout, 'the build info has no storageLayout').to.not.equal(undefined);

      const rows = layout!.storage.map((s) => [s.slot, s.offset, s.label, layout!.types[s.type].label]);
      expect(rows).to.deep.equal([
        ['0', 0, 'hub', 'contract Hub'],
        ['1', 0, '_withdrawals', 'mapping(uint256 => struct ConvictionWithdrawalStorage.Withdrawal)'],
        ['2', 0, '_carries', 'mapping(uint256 => struct ConvictionStakingStorage.RewardCarry[])'],
      ]);
      // A record takes two slots: the staker and the node in the first, the epoch in the second.
      const record = Object.values(layout!.types).find(
        (t) => t.label === 'struct ConvictionWithdrawalStorage.Withdrawal',
      )!;
      expect(record.numberOfBytes).to.equal('64');
      expect(record.members!.map((m) => [m.label, m.slot, m.offset])).to.deep.equal([
        ['staker', '0', 0],
        ['identityId', '0', 20],
        ['epoch', '1', 0],
      ]);
    });
  });
});
