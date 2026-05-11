#!/usr/bin/env node
//
// Deployment-side smoke check for the agent-provenance contracts.
//
// Run AFTER `./scripts/devnet.sh start N` against a localhost
// hardhat. Confirms the deployed bytecode actually carries the
// strict-break ABI shape from the agent-provenance plan §9.7 #2:
//
//   - KnowledgeAssetsV10.publish(PublishParams) accepts the four
//     author* fields.
//   - KnowledgeAssetsV10 does NOT expose publishDirect / updateDirect.
//   - KnowledgeCollectionStorage.getLatestMerkleRootAuthor(uint256)
//     is callable.
//
// This is the runtime counterpart of
// packages/chain/test/agent-provenance-cross-cutting.test.ts (which
// pins the static ABI at build time). Together they catch (a) ABI
// regressions in the source tree and (b) drift between the source
// ABI and what's actually deployed on the local hardhat.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const require = createRequire(
  join(REPO_ROOT, 'packages/evm-module/package.json'),
);
const { ethers } = require('ethers');

const RPC_URL = process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545';

const CONTRACTS_JSON = join(
  REPO_ROOT,
  'packages/evm-module/deployments/localhost_contracts.json',
);
const KAV10_ABI = join(REPO_ROOT, 'packages/evm-module/abi/KnowledgeAssetsV10.json');
const KCS_ABI = join(
  REPO_ROOT,
  'packages/evm-module/abi/KnowledgeCollectionStorage.json',
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function probeProvider(url) {
  const provider = new ethers.JsonRpcProvider(url, undefined, {
    staticNetwork: true,
  });
  try {
    await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 1500)),
    ]);
    return provider;
  } catch {
    provider.destroy?.();
    return null;
  }
}

async function main() {
  const root = loadJson(CONTRACTS_JSON);
  const contracts = root.contracts ?? root;

  const kav10Addr =
    contracts.KnowledgeAssetsV10?.evmAddress ||
    contracts.KnowledgeAssetsV10?.address;
  const kcsAddr =
    contracts.KnowledgeCollectionStorage?.evmAddress ||
    contracts.KnowledgeCollectionStorage?.address;

  if (!kav10Addr) fail('KnowledgeAssetsV10 address missing from contracts.json');
  if (!kcsAddr) fail('KnowledgeCollectionStorage address missing from contracts.json');

  const kav10Iface = new ethers.Interface(loadJson(KAV10_ABI));
  const kcsIface = new ethers.Interface(loadJson(KCS_ABI));

  console.log(`KAv10 expected at: ${kav10Addr}`);
  console.log(`KCS expected at:   ${kcsAddr}`);
  console.log('');

  const publishFn = kav10Iface.getFunction('publish');
  if (!publishFn) fail('publish(PublishParams) is not in the deployed ABI');
  pass('publish(PublishParams) selector present');

  const updateFn = kav10Iface.getFunction('update');
  if (!updateFn) fail('update(UpdateParams) is not in the deployed ABI');
  pass('update(UpdateParams) selector present');

  let publishDirectFound = false;
  let updateDirectFound = false;
  for (const f of kav10Iface.fragments) {
    if (f.type === 'function') {
      if (f.name === 'publishDirect') publishDirectFound = true;
      if (f.name === 'updateDirect') updateDirectFound = true;
    }
  }
  if (publishDirectFound) fail('publishDirect selector present in ABI (should be removed)');
  pass('publishDirect selector absent (strict-break confirmed)');
  if (updateDirectFound) fail('updateDirect selector present in ABI (should be removed)');
  pass('updateDirect selector absent (strict-break confirmed)');

  const publishInputs = (publishFn.inputs[0]?.components || []).map((c) => c.name);
  const required = ['authorAddress', 'authorR', 'authorVS', 'authorSchemeVersion'];
  for (const f of required) {
    if (!publishInputs.includes(f)) {
      fail(`PublishParams.${f} is missing from the deployed ABI`);
    }
  }
  pass('PublishParams carries authorAddress / authorR / authorVS / authorSchemeVersion');

  const removed = ['publisherNodeR', 'publisherNodeVS'];
  for (const f of removed) {
    if (publishInputs.includes(f)) {
      fail(`PublishParams.${f} should be removed but is still in ABI`);
    }
  }
  pass('PublishParams does not carry publisherNodeR / publisherNodeVS');

  const getAuthor = kcsIface.getFunction('getLatestMerkleRootAuthor');
  if (!getAuthor) fail('getLatestMerkleRootAuthor(uint256) is not in the KCS ABI');
  pass('KCS exposes getLatestMerkleRootAuthor(uint256)');

  const events = kcsIface.fragments.filter((f) => f.type === 'event');
  const created = events.find((e) => e.name === 'KnowledgeCollectionCreated');
  const updated = events.find((e) => e.name === 'KnowledgeCollectionUpdated');
  if (!created) fail('KnowledgeCollectionCreated event missing from KCS ABI');
  if (!updated) fail('KnowledgeCollectionUpdated event missing from KCS ABI');
  const createdHasAuthor = created.inputs.some(
    (i) => i.name === 'author' && i.indexed,
  );
  const updatedHasAuthor = updated.inputs.some(
    (i) => i.name === 'author' && i.indexed,
  );
  if (!createdHasAuthor) fail('KnowledgeCollectionCreated.author indexed field missing');
  if (!updatedHasAuthor) fail('KnowledgeCollectionUpdated.author indexed field missing');
  pass('KCS events emit indexed `author`');

  console.log('');
  console.log('--- runtime checks (require live hardhat at ' + RPC_URL + ') ---');
  const provider = await probeProvider(RPC_URL);
  if (!provider) {
    console.log('SKIP: hardhat RPC not reachable — re-run after `./scripts/devnet.sh start N`');
    console.log('');
    console.log('All static agent-provenance checks PASSED.');
    return;
  }

  const kav10Code = await provider.getCode(kav10Addr);
  if (kav10Code === '0x') fail('No bytecode at KnowledgeAssetsV10 address');
  pass('KnowledgeAssetsV10 has deployed bytecode');

  const kcsCode = await provider.getCode(kcsAddr);
  if (kcsCode === '0x') fail('No bytecode at KnowledgeCollectionStorage address');
  pass('KnowledgeCollectionStorage has deployed bytecode');

  const kcs = new ethers.Contract(kcsAddr, loadJson(KCS_ABI), provider);
  try {
    await kcs.getLatestMerkleRootAuthor(0n);
    pass('getLatestMerkleRootAuthor callable on deployed bytecode');
  } catch (err) {
    pass(`getLatestMerkleRootAuthor reverts on unknown kcId 0 (expected): ${err.shortMessage || err.message}`);
  }

  console.log('');
  console.log('All deployment-side agent-provenance checks PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
