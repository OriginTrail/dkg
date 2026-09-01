#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalized(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function hasWalletIdentity(value) {
  return normalized(value?.address) !== '' && normalized(value?.privateKey) !== '';
}

export function validateSharedSweepTopology({
  manifestPath = resolve(REPO_ROOT, 'devnet/suites.json'),
  devnetDir = process.env.DEVNET_DIR || resolve(REPO_ROOT, '.devnet'),
} = {}) {
  const manifest = readJson(manifestPath, 'devnet suite manifest');
  const nodeCount = positiveSafeInteger(
    manifest?.sharedSweep?.nodeCount,
    'sharedSweep.nodeCount',
  );
  const publisherWalletIndex = nonNegativeSafeInteger(
    manifest?.sharedSweep?.publisherWalletIndex,
    'sharedSweep.publisherWalletIndex',
  );
  const errors = [];

  for (let nodeNumber = 1; nodeNumber <= nodeCount; nodeNumber += 1) {
    const nodeDir = join(devnetDir, `node${nodeNumber}`);
    try {
      const config = readJson(join(nodeDir, 'config.json'), `node${nodeNumber} config.json`);
      const operational = readJson(
        join(nodeDir, 'wallets.json'),
        `node${nodeNumber} wallets.json`,
      )?.wallets;
      const selected = readJson(
        join(nodeDir, 'publisher-wallets.json'),
        `node${nodeNumber} publisher-wallets.json`,
      )?.wallets;

      if (config?.publisher?.enabled !== true) {
        errors.push(`node${nodeNumber} publisher runtime is not enabled`);
      }
      if (!Array.isArray(operational) || operational.length <= publisherWalletIndex) {
        errors.push(
          `node${nodeNumber} has no operational wallet index ${publisherWalletIndex}`,
        );
        continue;
      }
      if (!Array.isArray(selected) || selected.length !== 1) {
        errors.push(`node${nodeNumber} must configure exactly one publisher wallet`);
        continue;
      }

      const expected = operational[publisherWalletIndex];
      const actual = selected[0];
      if (!hasWalletIdentity(expected)) {
        errors.push(
          `node${nodeNumber} operational wallet index ${publisherWalletIndex} has no address/private key`,
        );
        continue;
      }
      if (!hasWalletIdentity(actual)) {
        errors.push(`node${nodeNumber} selected publisher has no address/private key`);
        continue;
      }
      if (
        normalized(actual?.address) !== normalized(expected?.address)
        || normalized(actual?.privateKey) !== normalized(expected?.privateKey)
      ) {
        errors.push(
          `node${nodeNumber} publisher wallet does not match operational wallet index ${publisherWalletIndex}`,
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Shared sweep topology mismatch:\n- ${errors.join('\n- ')}\n` +
      'Restart with: ./scripts/devnet.sh clean && ' +
      `DEVNET_ENABLE_PUBLISHER=1 DEVNET_PUBLISHER_WALLET_INDEX=${publisherWalletIndex} ` +
      `./scripts/devnet.sh start ${nodeCount}`,
    );
  }

  return { nodeCount, publisherWalletIndex };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = validateSharedSweepTopology();
    console.log(
      `shared sweep topology valid: ${result.nodeCount} nodes, ` +
      `publisher wallet index ${result.publisherWalletIndex}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
