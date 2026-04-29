/**
 * Set minimumRequiredSignatures on a deployed ParametersStorage contract.
 *
 * Usage:
 *   npx ts-node --esm scripts/set-min-signatures.ts [value]
 *
 * Defaults to 1 if no value provided.
 * Reads deployer key from .env (EVM_PRIVATE_KEY_BASE_SEPOLIA_V10) and
 * ParametersStorage address from deployments/base_sepolia_v10_contracts.json.
 */

import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const value = BigInt(process.argv[2] ?? '1');
const rpcUrl = process.env.RPC_BASE_SEPOLIA_V10 ?? 'https://sepolia.base.org';
const privateKey = process.env.EVM_PRIVATE_KEY_BASE_SEPOLIA_V10;
if (!privateKey) {
  console.error('Missing EVM_PRIVATE_KEY_BASE_SEPOLIA_V10 in .env');
  process.exit(1);
}

const contracts = JSON.parse(
  readFileSync(join(__dirname, '..', 'deployments', 'base_sepolia_v10_contracts.json'), 'utf-8'),
);
const psAddress = contracts.contracts.ParametersStorage.evmAddress;
if (!psAddress) {
  console.error('ParametersStorage address not found in deployments');
  process.exit(1);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const abi = [
    'function minimumRequiredSignatures() view returns (uint256)',
    'function setMinimumRequiredSignatures(uint256) external',
  ];
  const ps = new ethers.Contract(psAddress, abi, wallet);

  const current = await ps.minimumRequiredSignatures();
  console.log(`ParametersStorage: ${psAddress}`);
  console.log(`Current minimumRequiredSignatures: ${current}`);

  if (current === value) {
    console.log(`Already set to ${value}, nothing to do.`);
    process.exit(0);
  }

  console.log(`Setting minimumRequiredSignatures to ${value}...`);
  const tx = await ps.setMinimumRequiredSignatures(value);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  const updated = await ps.minimumRequiredSignatures();
  console.log(`New minimumRequiredSignatures: ${updated}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
