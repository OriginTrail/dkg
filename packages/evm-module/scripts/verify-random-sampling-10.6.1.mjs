#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Contract, JsonRpcProvider, ZeroAddress, getAddress } from 'ethers';

const EXPECTED_VERSION = '10.6.1';
const NETWORKS = Object.freeze({
  base_mainnet: {
    defaultRpc: 'https://base-rpc.publicnode.com',
    env: 'RPC_BASE_MAINNET',
  },
  base_sepolia_v10: {
    defaultRpc: 'https://base-sepolia-rpc.publicnode.com',
    env: 'RPC_BASE_SEPOLIA_V10',
  },
  gnosis_mainnet: {
    defaultRpc: 'https://gnosis-rpc.publicnode.com',
    env: 'RPC_GNOSIS_MAINNET',
  },
});

const mode = process.argv[2];
const networkName = process.argv[3];
if (!['predeploy', 'postdeploy'].includes(mode) || !(networkName in NETWORKS)) {
  throw new Error(
    'Usage: node scripts/verify-random-sampling-10.6.1.mjs ' +
      '<predeploy|postdeploy> <base_mainnet|base_sepolia_v10|gnosis_mainnet>',
  );
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(
  scriptDir,
  '..',
  'deployments',
  `${networkName}_contracts.json`,
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hubEntry = manifest.contracts?.Hub;
const randomSamplingEntry = manifest.contracts?.RandomSampling;
if (!hubEntry || !randomSamplingEntry) {
  throw new Error(`Hub or RandomSampling is missing from ${manifestPath}`);
}

if (mode === 'predeploy') {
  if (randomSamplingEntry.deployed !== false) {
    throw new Error(
      `${networkName}: RandomSampling must be marked deployed=false before rollout`,
    );
  }
  if (randomSamplingEntry.version === EXPECTED_VERSION) {
    throw new Error(
      `${networkName}: manifest already records ${EXPECTED_VERSION}; use postdeploy verification`,
    );
  }
  const otherPendingContracts = Object.entries(manifest.contracts)
    .filter(
      ([name, deployment]) =>
        name !== 'RandomSampling' && deployment.deployed !== true,
    )
    .map(([name]) => name);
  if (otherPendingContracts.length !== 0) {
    throw new Error(
      `${networkName}: only RandomSampling may be pending; also found ${otherPendingContracts.join(', ')}`,
    );
  }
} else {
  if (
    randomSamplingEntry.deployed !== true ||
    randomSamplingEntry.version !== EXPECTED_VERSION
  ) {
    throw new Error(
      `${networkName}: postdeploy manifest must record version ${EXPECTED_VERSION} and deployed=true`,
    );
  }
}

const network = NETWORKS[networkName];
const provider = new JsonRpcProvider(
  process.env[network.env] || network.defaultRpc,
);

async function rpcCall(operation) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await operation();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return result;
    } catch (error) {
      const message = String(error?.info?.error?.message || error);
      if (!message.toLowerCase().includes('rate limit') || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error('unreachable');
}

/**
 * Strip solc's trailing CBOR metadata blob, whose last two bytes carry its own
 * length. The blob embeds the source/metadata hash, so it differs between two
 * byte-identical builds compiled from different absolute paths; everything
 * before it is the executable runtime code we actually want to compare.
 */
function stripMetadata(bytecode) {
  const body = (bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode).toLowerCase();
  if (body.length < 4) return body;
  const metadataLength = Number.parseInt(body.slice(-4), 16);
  if (!Number.isInteger(metadataLength)) return body;
  const tailNibbles = (metadataLength + 2) * 2;
  if (tailNibbles >= body.length) return body;
  return body.slice(0, body.length - tailNibbles);
}

function compareDeployedBytecode(liveCode) {
  const artifactPath = path.join(
    scriptDir,
    '..',
    'artifacts',
    'contracts',
    'RandomSampling.sol',
    'RandomSampling.json',
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `${networkName}: ${artifactPath} is missing; run ` +
        '`pnpm exec hardhat compile --config hardhat.node.config.ts` from the reviewed ' +
        'checkout before the postdeploy check',
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const deployed = artifact.deployedBytecode;
  const expected = typeof deployed === 'string' ? deployed : deployed?.object;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error(`${networkName}: ${artifactPath} declares no deployedBytecode`);
  }
  // A literal comparison is only valid while the runtime code is constructor-
  // independent. RandomSampling holds `hub` in storage, not as an immutable, and
  // links no libraries; fail loudly rather than silently if that ever changes.
  const immutableReferences =
    (typeof deployed === 'object' ? deployed?.immutableReferences : undefined) ??
    artifact.immutableReferences ??
    {};
  const linkReferences =
    (typeof deployed === 'object' ? deployed?.linkReferences : undefined) ??
    artifact.deployedLinkReferences ??
    {};
  if (Object.keys(immutableReferences).length !== 0 || Object.keys(linkReferences).length !== 0) {
    throw new Error(
      `${networkName}: RandomSampling now has immutables or library links, so its runtime code ` +
        'is deploy-specific; mask those ranges before comparing bytecode',
    );
  }
  const liveRuntime = stripMetadata(liveCode);
  const expectedRuntime = stripMetadata(expected);
  if (liveRuntime !== expectedRuntime) {
    throw new Error(
      `${networkName}: deployed runtime bytecode does not match the local ` +
        'artifacts/contracts/RandomSampling.sol/RandomSampling.json build ' +
        `(live ${liveRuntime.length / 2} bytes, artifact ${expectedRuntime.length / 2} bytes, ` +
        'metadata tail excluded). The address was deployed from a different checkout or with ' +
        'different compiler settings than the one being verified.',
    );
  }
}

const hubAddress = getAddress(hubEntry.evmAddress);
const randomSamplingAddress = getAddress(randomSamplingEntry.evmAddress);
const hub = new Contract(
  hubAddress,
  ['function getContractAddress(string) view returns (address)'],
  provider,
);
const randomSampling = new Contract(
  randomSamplingAddress,
  [
    'function version() view returns (string)',
    'function status() view returns (bool)',
    'function identityStorage() view returns (address)',
    'function randomSamplingStorage() view returns (address)',
  ],
  provider,
);

// Keep calls sequential so the public fallback endpoints do not reject the
// preflight as a burst. Operators can supply their own RPC through the env var.
const code = await rpcCall(() => provider.getCode(randomSamplingAddress));
const registeredAddress = await rpcCall(() =>
  hub.getContractAddress('RandomSampling'),
);
const registeredIdentityStorage = await rpcCall(() =>
  hub.getContractAddress('IdentityStorage'),
);
const registeredRandomSamplingStorage = await rpcCall(() =>
  hub.getContractAddress('RandomSamplingStorage'),
);
const onChainVersion = await rpcCall(() => randomSampling.version());
const status = await rpcCall(() => randomSampling.status());
const identityStorage = await rpcCall(() => randomSampling.identityStorage());
const randomSamplingStorage = await rpcCall(() =>
  randomSampling.randomSamplingStorage(),
);

if (code === '0x') {
  throw new Error(`${networkName}: RandomSampling address has no code`);
}
if (getAddress(registeredAddress) !== randomSamplingAddress) {
  throw new Error(
    `${networkName}: Hub points to ${registeredAddress}, manifest points to ${randomSamplingAddress}`,
  );
}
if (onChainVersion !== randomSamplingEntry.version) {
  throw new Error(
    `${networkName}: on-chain version ${onChainVersion} does not match manifest ${randomSamplingEntry.version}`,
  );
}
// `version()` only proves the address SELF-REPORTS 10.6.1; it does not prove the
// address holds the build that was reviewed. The realistic failure is a deploy
// from the wrong checkout or with different compiler settings, which still
// returns 10.6.1. Compare the live runtime code against the local artifact
// instead. Predeploy skips this deliberately: the live contract is still 10.6.0.
let bytecodeMatchesArtifact = false;
if (mode === 'postdeploy') {
  compareDeployedBytecode(code);
  bytecodeMatchesArtifact = true;
}
if (!status) {
  throw new Error(`${networkName}: RandomSampling is not active`);
}
if (getAddress(identityStorage) === ZeroAddress) {
  throw new Error(`${networkName}: RandomSampling is not initialized`);
}
if (getAddress(identityStorage) !== getAddress(registeredIdentityStorage)) {
  throw new Error(
    `${networkName}: cached IdentityStorage ${identityStorage} does not match Hub ${registeredIdentityStorage}`,
  );
}
if (
  getAddress(randomSamplingStorage) !==
  getAddress(registeredRandomSamplingStorage)
) {
  throw new Error(
    `${networkName}: cached RandomSamplingStorage ${randomSamplingStorage} does not match Hub ${registeredRandomSamplingStorage}`,
  );
}

console.log(
  JSON.stringify(
    {
      mode,
      network: networkName,
      hub: hubAddress,
      randomSampling: randomSamplingAddress,
      version: onChainVersion,
      bytecodeMatchesArtifact,
      status,
      identityStorage: getAddress(identityStorage),
      randomSamplingStorage: getAddress(randomSamplingStorage),
    },
    null,
    2,
  ),
);
