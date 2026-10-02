// SPDX-License-Identifier: Apache-2.0
/**
 * `loadAbi` reads this package's vendored `abi/` copy before the
 * evm-module one, so a vendored ABI that lags the generated evm-module ABI
 * hides everything added since: a new custom error from a deployed contract
 * then surfaces as "unknown custom error". These tests pin every vendored
 * file to its evm-module counterpart byte for byte, pin the error decoder to
 * every vendored error, and check that each contract the adapter loads by
 * name is vendored (npm consumers cannot fall back to the private
 * evm-module package).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorFragment, Interface, type JsonFragment } from 'ethers';
import { decodeEvmError, enrichEvmError, getErrorInterface } from '../src/evm-adapter-errors.js';

const VENDOR_DIR = join(import.meta.dirname, '..', 'abi');
const ARCHIVE_DIR = join(VENDOR_DIR, 'archive');
const SOURCE_DIR = join(import.meta.dirname, '..', '..', 'evm-module', 'abi');
const SRC_DIR = join(import.meta.dirname, '..', 'src');
const SYNC_HINT = 'run `node scripts/sync-chain-abis.mjs` from the repository root and commit the result';

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
}

const vendoredPaths = [
  ...jsonFiles(VENDOR_DIR).map((file) => join(VENDOR_DIR, file)),
  ...jsonFiles(ARCHIVE_DIR).map((file) => join(ARCHIVE_DIR, file)),
];

describe('vendored ABIs are byte-for-byte copies of evm-module/abi', () => {
  for (const file of jsonFiles(VENDOR_DIR)) {
    it(`abi/${file}`, () => {
      const source = join(SOURCE_DIR, file);
      expect(
        existsSync(source),
        `abi/${file} has no evm-module counterpart: delete it, or move it to abi/archive/ if it is a contract evm-module no longer builds`,
      ).toBe(true);
      expect(readFileSync(join(VENDOR_DIR, file)).equals(readFileSync(source)), `abi/${file} is stale: ${SYNC_HINT}`).toBe(true);
    });
  }

  // An archived ABI without an evm-module counterpart is frozen: evm-module no
  // longer builds that contract. The rest are still generated and must match.
  for (const file of jsonFiles(ARCHIVE_DIR).filter((name) => existsSync(join(SOURCE_DIR, name)))) {
    it(`abi/archive/${file}`, () => {
      expect(
        readFileSync(join(ARCHIVE_DIR, file)).equals(readFileSync(join(SOURCE_DIR, file))),
        `abi/archive/${file} is stale: ${SYNC_HINT}`,
      ).toBe(true);
    });
  }
});

describe('the custom-error decoder is built from every vendored ABI', () => {
  it('decodes exactly the error selectors the vendored ABIs declare', () => {
    const vendored = new Set<string>();
    for (const path of vendoredPaths) {
      for (const entry of JSON.parse(readFileSync(path, 'utf8')) as JsonFragment[]) {
        if (entry.type === 'error') vendored.add(ErrorFragment.from(entry).selector);
      }
    }
    const decoded = new Set<string>();
    getErrorInterface().forEachError((fragment) => decoded.add(fragment.selector));
    expect(vendored.size).toBeGreaterThan(0);
    expect([...decoded].sort()).toEqual([...vendored].sort());
  });

  // Declared by deployed contracts but missing from the stale vendored copies,
  // so these reverts decoded as "unknown custom error".
  it.each([
    ['KnowledgeAssetsLifecycle', 'CannotWriteValueToInactiveContextGraph(uint256 contextGraphId)', [3n]],
    ['KnowledgeAssetsLifecycle', 'PublicKARequiresMerkleLeafCount(uint256 contextGraphId)', [3n]],
    ['StakingV10', 'NodeBelowMinimumStake(uint72 identityId)', [7n]],
    ['StakingV10', 'NodeAlreadyInShardingTable(uint72 identityId)', [7n]],
    ['ConvictionStakingStorage', 'NodeExpiryQueueFull(uint72 identityId, uint256 pending, uint256 maxPending)', [7n, 64n, 64n]],
    ['ShardingTable', 'ShardingTableIsFull(uint72 nodesCount, uint16 sizeLimit)', [500n, 500n]],
  ] as const)('%s reverts decode %s', (_contract, signature, args) => {
    const iface = new Interface([`error ${signature}`]);
    const fragment = iface.fragments[0] as ErrorFragment;
    const data = iface.encodeErrorResult(fragment, args);
    const decoded = decodeEvmError(data);
    expect(decoded?.name).toBe(fragment.name);
    expect([...(decoded?.args ?? [])]).toEqual([...args]);

    const err = new Error(`execution reverted (unknown custom error) (data="${data}")`);
    expect(enrichEvmError(err)).toBe(fragment.name);
    expect(err.message).toContain(`${fragment.name}(${args.join(', ')})`);
  });
});

describe('every contract the adapter loads by name is vendored', () => {
  it('resolves each static loadAbi / resolveContract / resolveAssetStorage name from abi/ or abi/archive/', () => {
    const names = new Set<string>();
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // src/archive is the uncompiled V8/V9 method archive.
        if (entry.isDirectory()) {
          if (entry.name !== 'archive') visit(join(dir, entry.name));
        } else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(join(dir, entry.name), 'utf8');
          for (const match of source.matchAll(/\b(?:loadAbi|resolveContract|resolveAssetStorage)\(\s*'(\w+)'/g)) {
            names.add(match[1]!);
          }
        }
      }
    };
    visit(SRC_DIR);

    expect([...names]).toEqual(expect.arrayContaining(['Hub', 'KnowledgeAssetsLifecycle', 'Staking']));
    const missing = [...names].filter((name) =>
      !existsSync(join(VENDOR_DIR, `${name}.json`)) && !existsSync(join(ARCHIVE_DIR, `${name}.json`)));
    expect(missing, `vendor these ABIs with \`node scripts/sync-chain-abis.mjs ${missing.join(' ')}\``).toEqual([]);
  });
});
