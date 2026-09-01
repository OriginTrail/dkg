#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const MAX_DEVNET_NODE_NUMBER = 10;
const EXTRA_API_PROBE_TIMEOUT_MS = 500;

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

function extraNodeDirectories(devnetDir, nodeCount) {
  try {
    return readdirSync(devnetDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ entry, match: /^node([1-9]\d*)$/.exec(entry.name) }))
      .filter(({ match }) => match && Number(match[1]) > nodeCount)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
      .map(({ entry }) => entry.name);
  } catch {
    // Required-node reads below retain the existing detailed missing-directory
    // diagnostics when DEVNET_DIR itself is absent or unreadable.
    return [];
  }
}

function inferApiPortBase(configs, nodeCount) {
  if (configs.size !== nodeCount) return undefined;
  const firstPort = configs.get(1)?.apiPort;
  if (!Number.isSafeInteger(firstPort) || firstPort <= 0) return undefined;
  for (let nodeNumber = 1; nodeNumber <= nodeCount; nodeNumber += 1) {
    if (configs.get(nodeNumber)?.apiPort !== firstPort + nodeNumber - 1) return undefined;
  }
  return firstPort;
}

async function responsiveExtraDevnetApis(nodeCount, apiPortBase) {
  if (apiPortBase === undefined || nodeCount >= MAX_DEVNET_NODE_NUMBER) return [];
  const probes = [];
  for (
    let nodeNumber = nodeCount + 1;
    nodeNumber <= MAX_DEVNET_NODE_NUMBER;
    nodeNumber += 1
  ) {
    const port = apiPortBase + nodeNumber - 1;
    if (port > 65_535) continue;
    probes.push((async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          signal: AbortSignal.timeout(EXTRA_API_PROBE_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const status = await response.json();
        if (
          status?.name !== `devnet-node-${nodeNumber}`
          || typeof status?.peerId !== 'string'
          || status.peerId.length === 0
        ) return undefined;
        return `node${nodeNumber} (API :${port})`;
      } catch {
        return undefined;
      }
    })());
  }
  return (await Promise.all(probes)).filter(Boolean);
}

export async function validateSharedSweepTopology({
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
  const requiredNodeConfigs = new Map();

  const extras = extraNodeDirectories(devnetDir, nodeCount);
  if (extras.length > 0) {
    errors.push(
      `extra configured devnet node directories found: ${extras.join(', ')}; ` +
      `sharedSweep.nodeCount=${nodeCount} requires exactly node1-node${nodeCount}`,
    );
  }

  for (let nodeNumber = 1; nodeNumber <= nodeCount; nodeNumber += 1) {
    const nodeDir = join(devnetDir, `node${nodeNumber}`);
    try {
      const config = readJson(join(nodeDir, 'config.json'), `node${nodeNumber} config.json`);
      requiredNodeConfigs.set(nodeNumber, config);
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

  const activeExtras = await responsiveExtraDevnetApis(
    nodeCount,
    inferApiPortBase(requiredNodeConfigs, nodeCount),
  );
  if (activeExtras.length > 0) {
    errors.push(
      `extra active devnet APIs found: ${activeExtras.join(', ')}; ` +
      `stop stray nodes before running the ${nodeCount}-node shared sweep`,
    );
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
    const result = await validateSharedSweepTopology();
    console.log(
      `shared sweep topology valid: ${result.nodeCount} nodes, ` +
      `publisher wallet index ${result.publisherWalletIndex}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
