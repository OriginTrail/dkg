// ServiceSubscriptions, the logic of Conviction Account service spending
// (OT-RFC-27): the parts that need no account.
//
// Covers:
//   - metadata and the EIP-712 constants;
//   - the domain separator and the ServiceAssignment digest against ethers'
//     own EIP-712 encoder, the one wallets and external signers use, field by
//     field and at the type bounds;
//   - the subscription id, one per buyer key and epoch;
//   - initialize: onlyHub, the five dependencies it wires, and re-wiring after
//     the Hub re-registers one.
//
// Opt-in, consent, caps, funding and labels run against the real account stack
// in v10-conviction-service.test.ts and v10-conviction-service-labels.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Chronos, ConvictionServiceStorage, Hub, ServiceSubscriptions } from '../../typechain';
import {
  DAY,
  SERVICE_ASSIGNMENT_TYPES,
  TRAC,
  Terms,
  domainOf,
  registerServiceContracts,
  signTerms,
} from '../helpers/conviction-service';

const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT40 = (1n << 40n) - 1n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['Hub', 'ParametersStorage', 'Chronos', 'PublishingConvictionStorage']);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { CSS, SS } = await registerServiceContracts(Hub);
  return { accounts, Hub, CSS, SS };
}

const termsOf = (overrides: Partial<Terms> = {}): Terms => ({
  accountId: 7n,
  assignee: ethers.getAddress('0x00000000000000000000000000000000000000a1'),
  maxCostPerPeriod: 25n * TRAC,
  expiresAt: 4_000_000_000n,
  nonce: 3n,
  ...overrides,
});

describe('@unit ServiceSubscriptions', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, CSS, SS } = await loadFixture(deployFixture));
  });

  describe('metadata and EIP-712 constants', () => {
    it('is named ServiceSubscriptions, version 1.1.0, with a 10,000 bps denominator', async () => {
      expect(await SS.name()).to.equal('ServiceSubscriptions');
      expect(await SS.version()).to.equal('1.1.0');
      expect(await SS.BPS_DENOMINATOR()).to.equal(10_000n);
      expect(await SS.hub()).to.equal(await HubContract.getAddress());
    });

    it('the ServiceAssignment type hash is the hash of the type ethers encodes', async () => {
      const encoder = ethers.TypedDataEncoder.from(SERVICE_ASSIGNMENT_TYPES);
      const typeString = encoder.encodeType('ServiceAssignment');
      expect(typeString).to.equal(
        'ServiceAssignment(uint256 accountId,address assignee,uint96 maxCostPerPeriod,uint40 expiresAt,uint64 nonce)',
      );
      expect(await SS.SERVICE_ASSIGNMENT_TYPEHASH()).to.equal(ethers.id(typeString));
    });

    it('the Hub marks it active when it registers it', async () => {
      expect(await SS.status()).to.equal(true);
    });
  });

  describe('EIP-712 domain and digest', () => {
    it('domainSeparator is the domain DKGConvictionServices, version 1, this chain and this contract', async () => {
      const domain = await domainOf(SS);
      expect(await SS.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(domain));
    });

    it('another deployment has its own domain, so a digest is bound to its verifying contract', async () => {
      const other = (await (
        await hre.ethers.getContractFactory('ServiceSubscriptions')
      ).deploy(await HubContract.getAddress())) as unknown as ServiceSubscriptions;
      await other.waitForDeployment();
      expect(await other.domainSeparator()).to.not.equal(await SS.domainSeparator());
      expect(await other.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(await domainOf(other)));
      expect(await other.hashAssignment(termsOf())).to.not.equal(await SS.hashAssignment(termsOf()));
    });

    it('hashAssignment is the digest ethers signs, including at the type bounds', async () => {
      const domain = await domainOf(SS);
      for (const terms of [
        termsOf(),
        termsOf({ maxCostPerPeriod: 1n, nonce: 0n }),
        termsOf({
          accountId: ethers.MaxUint256,
          assignee: ethers.getAddress('0xffffffffffffffffffffffffffffffffffffffff'),
          maxCostPerPeriod: MAX_UINT96,
          expiresAt: MAX_UINT40,
          nonce: MAX_UINT64,
        }),
      ]) {
        expect(await SS.hashAssignment(terms)).to.equal(
          ethers.TypedDataEncoder.hash(domain, SERVICE_ASSIGNMENT_TYPES, terms),
        );
      }
    });

    it('every field of the terms is part of the digest', async () => {
      const base = termsOf();
      const digest = await SS.hashAssignment(base);
      const changed: Array<Partial<Terms>> = [
        { accountId: base.accountId + 1n },
        { assignee: ethers.getAddress('0x00000000000000000000000000000000000000a2') },
        { maxCostPerPeriod: base.maxCostPerPeriod + 1n },
        { expiresAt: base.expiresAt + 1n },
        { nonce: base.nonce + 1n },
      ];
      expect(changed.length).to.equal(SERVICE_ASSIGNMENT_TYPES.ServiceAssignment.length);
      const seen = new Set<string>([digest]);
      for (const c of changed) {
        const d = await SS.hashAssignment(termsOf(c));
        expect(seen.has(d), JSON.stringify(c, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).to.equal(false);
        seen.add(d);
      }
    });

    it('a typed-data signature over the terms recovers from hashAssignment', async () => {
      const signer = accounts[9];
      const terms = termsOf({ assignee: signer.address });
      const signature = await signTerms(signer, SS, terms);
      expect(ethers.recoverAddress(await SS.hashAssignment(terms), signature)).to.equal(signer.address);
    });
  });

  describe('subscription id', () => {
    it('subscriptionIdOf is keccak256(abi.encode(assignee, epoch)), so it is unique per buyer key and epoch', async () => {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      for (const assignee of [accounts[1].address, accounts[2].address]) {
        for (const epoch of [1n, 2n, (1n << 40n) - 1n]) {
          expect(await SS.subscriptionIdOf(assignee, epoch)).to.equal(
            ethers.keccak256(coder.encode(['address', 'uint256'], [assignee, epoch])),
          );
        }
      }
      expect(await SS.subscriptionIdOf(accounts[1].address, 5n)).to.not.equal(
        await SS.subscriptionIdOf(accounts[2].address, 5n),
      );
      expect(await SS.subscriptionIdOf(accounts[1].address, 5n)).to.not.equal(
        await SS.subscriptionIdOf(accounts[1].address, 6n),
      );
    });
  });

  describe('initialize', () => {
    it('wires PublishingConvictionStorage, ConvictionServiceStorage, Chronos, ParametersStorage and QueryInferenceStorage from the Hub', async () => {
      expect(await SS.publishingConvictionStorage()).to.equal(
        await HubContract.getContractAddress('PublishingConvictionStorage'),
      );
      expect(await SS.convictionServiceStorage()).to.equal(await CSS.getAddress());
      expect(await SS.chronos()).to.equal(await HubContract.getContractAddress('Chronos'));
      expect(await SS.parametersStorage()).to.equal(await HubContract.getContractAddress('ParametersStorage'));
      expect(await SS.queryInferenceStorage()).to.equal(await HubContract.getContractAddress('QueryInferenceStorage'));
    });

    it('is onlyHub: a stranger and a Hub-registered contract are refused', async () => {
      const stranger = accounts[3];
      await HubContract.setContractAddress('SomeHubContract', accounts[4].address);
      for (const caller of [stranger, accounts[4]]) {
        await expect(SS.connect(caller).initialize())
          .to.be.revertedWithCustomError(SS, 'UnauthorizedAccess')
          .withArgs('Only Hub');
      }
    });

    it('re-wires a dependency the Hub re-registers', async () => {
      const ChronosFactory = await hre.ethers.getContractFactory('Chronos');
      const next = (await ChronosFactory.deploy(1_700_000_000n, DAY)) as unknown as Chronos;
      await next.waitForDeployment();
      await HubContract.setContractAddress('Chronos', await next.getAddress());
      expect(await SS.chronos()).to.not.equal(await next.getAddress());
      await HubContract.forwardCall(await SS.getAddress(), SS.interface.encodeFunctionData('initialize'));
      expect(await SS.chronos()).to.equal(await next.getAddress());
    });

    it('reverts ContractDoesNotExist while a dependency is not registered', async () => {
      const fresh = (await (
        await hre.ethers.getContractFactory('ServiceSubscriptions')
      ).deploy(await HubContract.getAddress())) as unknown as ServiceSubscriptions;
      await fresh.waitForDeployment();
      await HubContract.removeContractByName('QueryInferenceStorage');
      await expect(fresh.initialize())
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('QueryInferenceStorage');
      await HubContract.removeContractByName('ConvictionServiceStorage');
      await expect(fresh.initialize())
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('ConvictionServiceStorage');
    });
  });

  it('accepts no ETH', async () => {
    await expect(accounts[1].sendTransaction({ to: await SS.getAddress(), value: 1n })).to.be.reverted;
  });
});
