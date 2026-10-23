import fs from 'node:fs';
import path from 'node:path';

import { expect } from 'chai';
import hre from 'hardhat';

const NETWORKS = [
  'base_mainnet',
  'base_sepolia_v10',
  'gnosis_mainnet',
] as const;

describe('@unit RandomSampling deployment readiness', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'contracts', 'RandomSampling.sol'),
    'utf8',
  );
  const sourceVersion = source.match(
    /string private constant _VERSION = "([^"]+)";/,
  )?.[1];

  it('reads the source version used for deployment readiness', () => {
    expect(sourceVersion).not.to.equal(undefined);
  });

  for (const network of NETWORKS) {
    it(`${network} never treats an older RandomSampling version as deployed`, () => {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '..', '..', 'deployments', `${network}_contracts.json`),
          'utf8',
        ),
      );
      const deployment = manifest.contracts.RandomSampling;

      expect(deployment, 'RandomSampling deployment is missing').not.to.equal(
        undefined,
      );
      if (deployment.deployed) {
        expect(deployment.version).to.equal(sourceVersion);
      }
    });
  }

  // `scripts/verify-random-sampling-10.6.1.mjs postdeploy` compares the live
  // runtime code against artifacts/contracts/RandomSampling.sol/RandomSampling.json
  // with the trailing CBOR metadata blob stripped. That comparison is only sound
  // while RandomSampling's runtime code is deploy-independent: an immutable or a
  // linked library would bake per-deployment bytes into the code and turn every
  // postdeploy run red. Pin the invariant here so the change that breaks it also
  // breaks this test, instead of surfacing during a mainnet cutover.
  it('deployed runtime bytecode is deploy-independent and matches the artifact', async () => {
    const stripMetadata = (bytecode: string): string => {
      const body = (bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode).toLowerCase();
      if (body.length < 4) return body;
      const metadataLength = Number.parseInt(body.slice(-4), 16);
      if (!Number.isInteger(metadataLength)) return body;
      const tailNibbles = (metadataLength + 2) * 2;
      if (tailNibbles >= body.length) return body;
      return body.slice(0, body.length - tailNibbles);
    };

    const artifact = await hre.artifacts.readArtifact('RandomSampling');
    expect(Object.keys(artifact.deployedLinkReferences ?? {})).to.have.lengthOf(0);

    // Any non-zero address satisfies the HubDependent constructor guard; `hub`
    // is a storage variable, so it must not appear in the runtime code.
    const [deployer] = await hre.ethers.getSigners();
    const factory = await hre.ethers.getContractFactory('RandomSampling', deployer);
    const contract = await factory.deploy(deployer.address);
    await contract.waitForDeployment();

    const liveCode = await hre.ethers.provider.getCode(await contract.getAddress());
    expect(stripMetadata(liveCode)).to.equal(stripMetadata(artifact.deployedBytecode));
  });
});
