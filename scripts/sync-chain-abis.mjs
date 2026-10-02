#!/usr/bin/env node
// Refresh the contract ABIs that `@origintrail-official/dkg-chain` vendors under
// packages/chain/abi/ from the generated packages/evm-module/abi/.
//
// dkg-chain loads its own copy first (src/evm-adapter-abi.ts) and has to ship
// it: evm-module is private, so npm consumers cannot fall back to it. Every
// vendored file with an evm-module counterpart, top-level or under archive/, is
// overwritten with that counterpart's bytes. An archive/ file without one is a
// frozen ABI of a contract evm-module no longer builds, and is left alone.
//
//   node scripts/sync-chain-abis.mjs                  refresh the vendored ABIs
//   node scripts/sync-chain-abis.mjs Name [Name ...]  also vendor these ABIs
//
// Run it after regenerating evm-module's ABIs (`npx hardhat compile` there).
// packages/chain/test/vendored-abi-sync.unit.test.ts fails while any vendored
// ABI differs from its counterpart. For each file it changes, the script prints
// the ABI entries added (+) and removed (-).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'packages/evm-module/abi');
const VENDOR_DIR = path.join(ROOT_DIR, 'packages/chain/abi');
const ARCHIVE_DIR = path.join(VENDOR_DIR, 'archive');

function abiNames(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

function formatParam(param) {
  const type = param.type.startsWith('tuple')
    ? `(${(param.components ?? []).map(formatParam).join(', ')})${param.type.slice('tuple'.length)}`
    : param.type;
  return [type, param.indexed ? 'indexed' : '', param.name].filter(Boolean).join(' ');
}

// One line per ABI entry, e.g. `error NodeBelowMinimumStake(uint72 identityId)`.
function formatEntry(entry) {
  const inputs = (entry.inputs ?? []).map(formatParam).join(', ');
  switch (entry.type) {
    case 'function': {
      const outputs = (entry.outputs ?? []).map(formatParam).join(', ');
      return `function ${entry.name}(${inputs}) ${entry.stateMutability}${outputs ? ` returns (${outputs})` : ''}`;
    }
    case 'event':
      return `event ${entry.name}(${inputs})${entry.anonymous ? ' anonymous' : ''}`;
    case 'error':
      return `error ${entry.name}(${inputs})`;
    default:
      return `${entry.type}(${inputs})${entry.stateMutability ? ` ${entry.stateMutability}` : ''}`;
  }
}

function entryChanges(before, after) {
  const was = new Set(before.map(formatEntry));
  const now = new Set(after.map(formatEntry));
  return [
    ...[...now].filter((line) => !was.has(line)).map((line) => `+ ${line}`),
    ...[...was].filter((line) => !now.has(line)).map((line) => `- ${line}`),
  ];
}

const available = new Set(abiNames(SOURCE_DIR));
const requested = process.argv.slice(2).map((arg) => arg.replace(/\.json$/, ''));
const unknown = requested.filter((name) => !available.has(name));
if (unknown.length > 0) {
  console.error(`No packages/evm-module/abi/<name>.json to vendor for: ${unknown.join(', ')}`);
  process.exit(1);
}

const archived = abiNames(ARCHIVE_DIR);
const topLevel = [...new Set([...abiNames(VENDOR_DIR), ...requested])]
  .filter((name) => !archived.includes(name))
  .sort();
const targets = [
  ...topLevel.map((name) => ({ name, file: path.join(VENDOR_DIR, `${name}.json`), archive: false })),
  ...archived.map((name) => ({ name, file: path.join(ARCHIVE_DIR, `${name}.json`), archive: true })),
];

let updated = 0;
let unchanged = 0;
const frozen = [];
const orphans = [];
for (const { name, file, archive } of targets) {
  const label = path.relative(ROOT_DIR, file);
  if (!available.has(name)) {
    (archive ? frozen : orphans).push(label);
    continue;
  }
  const sourceFile = path.join(SOURCE_DIR, `${name}.json`);
  const source = fs.readFileSync(sourceFile);
  const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (current?.equals(source)) {
    unchanged += 1;
    continue;
  }
  fs.copyFileSync(sourceFile, file);
  updated += 1;
  console.log(`${current ? 'Updated' : 'Added'} ${label}`);
  const changes = entryChanges(current ? JSON.parse(current) : [], JSON.parse(source));
  for (const line of changes) console.log(`  ${line}`);
  if (changes.length === 0) console.log('  (formatting or internalType only)');
}

console.log(
  `${targets.length - frozen.length - orphans.length} vendored ABIs match packages/evm-module/abi: `
  + `${updated} written, ${unchanged} already current.`,
);
if (frozen.length > 0) console.log(`Frozen, no evm-module counterpart: ${frozen.join(', ')}`);
if (orphans.length > 0) {
  console.error(
    `No evm-module counterpart for top-level ${orphans.join(', ')}. `
    + 'Delete the file, or move it to archive/ if the adapter still loads a contract evm-module no longer builds.',
  );
  process.exit(1);
}
