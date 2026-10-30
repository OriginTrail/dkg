// Deployed runtime size of the conviction, plan-period and settlement contracts
// against the EIP-170 limit of 24,576 bytes.
//
// Hardhat already refuses an oversized deployment in every test run except
// coverage. This states the limit explicitly and fails with the measured size,
// so a change that eats the remaining margin is caught where it is made.

import { expect } from 'chai';
import hre from 'hardhat';

const EIP170_RUNTIME_LIMIT = 24_576;

// Coverage instruments every contract and lifts the size limit, so a size
// measured under it says nothing about the bytecode that is deployed.
const isCoverage = process.argv.includes('coverage');

/** Contracts whose runtime must stay deployable; each takes the Hub address. */
const CONTRACTS = [
  'PublishingConviction',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'ConvictionServiceStorage',
  'QueryInferenceStorage',
  'QueryInferenceSettlement',
];

describe('@unit Contract runtime size (EIP-170)', () => {
  for (const name of CONTRACTS) {
    it(`${name} has at most ${EIP170_RUNTIME_LIMIT} bytes of runtime code`, async function () {
      if (isCoverage) this.skip();

      const artifact = await hre.artifacts.readArtifact(name);
      const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
      expect(runtimeBytes, `${name} runtime is ${runtimeBytes} bytes`).to.be.at.most(EIP170_RUNTIME_LIMIT);

      // The code a deployment stores is that runtime, byte for byte.
      const [deployer] = await hre.ethers.getSigners();
      const Factory = await hre.ethers.getContractFactory(name);
      const deployed = await Factory.deploy(deployer.address);
      await deployed.waitForDeployment();
      const code = await hre.ethers.provider.getCode(await deployed.getAddress());
      expect((code.length - 2) / 2).to.equal(runtimeBytes);
    });
  }
});
