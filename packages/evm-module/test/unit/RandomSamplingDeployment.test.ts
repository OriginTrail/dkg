import fs from 'node:fs';
import path from 'node:path';

import { expect } from 'chai';

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
});
