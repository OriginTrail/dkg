// SPDX-License-Identifier: Apache-2.0
/**
 * scripts/sync-chain-abis.mjs against temporary copies of the directories it
 * syncs. The vendored-ABI test only reports drift; these tests pin what the
 * script writes. The script finds its directories from its own location, so
 * a copy under a temporary root works on that root alone.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SYNC_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'sync-chain-abis.mjs');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'sync-chain-abis-'));
  roots.push(root);
  for (const directory of ['scripts', 'packages/evm-module/abi', 'packages/chain/abi/archive']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  copyFileSync(SYNC_SCRIPT, join(root, 'scripts', 'sync-chain-abis.mjs'));
  const source = join(root, 'packages', 'evm-module', 'abi');
  const vendor = join(root, 'packages', 'chain', 'abi');
  const sync = (...names: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'sync-chain-abis.mjs'), ...names], { encoding: 'utf8' });
  return { source, vendor, sync };
}

// An ABI of view functions with these names.
const abi = (...names: string[]) => `${JSON.stringify(
  names.map((name) => ({ type: 'function', name, inputs: [], outputs: [], stateMutability: 'view' })),
  null,
  2,
)}\n`;

describe('scripts/sync-chain-abis.mjs', () => {
  it('overwrites every vendored ABI that has an evm-module counterpart, and nothing else', () => {
    const { source, vendor, sync } = checkout();
    writeFileSync(join(source, 'Hub.json'), abi('getContractAddress', 'setContractAddress'));
    writeFileSync(join(vendor, 'Hub.json'), abi('getContractAddress'));
    writeFileSync(join(source, 'Legacy.json'), abi('legacy', 'renamed'));
    writeFileSync(join(vendor, 'archive', 'Legacy.json'), abi('legacy'));
    writeFileSync(join(vendor, 'archive', 'Frozen.json'), abi('frozen'));
    writeFileSync(join(source, 'Staking.json'), abi('stake'));

    const first = sync();
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(join(vendor, 'Hub.json'), 'utf8')).toBe(readFileSync(join(source, 'Hub.json'), 'utf8'));
    expect(readFileSync(join(vendor, 'archive', 'Legacy.json'), 'utf8')).toBe(readFileSync(join(source, 'Legacy.json'), 'utf8'));
    // A frozen archive has no counterpart; an evm-module ABI is vendored only on request.
    expect(readFileSync(join(vendor, 'archive', 'Frozen.json'), 'utf8')).toBe(abi('frozen'));
    expect(existsSync(join(vendor, 'Staking.json'))).toBe(false);
    expect(first.stdout).toContain('Updated packages/chain/abi/Hub.json\n  + function setContractAddress() view');
    expect(first.stdout).toContain('2 vendored ABIs match packages/evm-module/abi: 2 written, 0 already current.');
    expect(first.stdout).toContain('Frozen, no evm-module counterpart: packages/chain/abi/archive/Frozen.json');

    const second = sync();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('2 vendored ABIs match packages/evm-module/abi: 0 written, 2 already current.');
  });

  it('vendors a requested ABI and rejects a name evm-module does not build', () => {
    const { source, vendor, sync } = checkout();
    writeFileSync(join(source, 'Staking.json'), abi('stake'));

    const requested = sync('Staking');
    expect(requested.status, requested.stderr).toBe(0);
    expect(readFileSync(join(vendor, 'Staking.json'), 'utf8')).toBe(abi('stake'));
    expect(requested.stdout).toContain('Added packages/chain/abi/Staking.json');

    const unknown = sync('Missing.json');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('No packages/evm-module/abi/<name>.json to vendor for: Missing');
  });

  it('fails on a top-level vendored ABI without an evm-module counterpart', () => {
    const { vendor, sync } = checkout();
    writeFileSync(join(vendor, 'Gone.json'), abi('gone'));

    const orphan = sync();
    expect(orphan.status).toBe(1);
    expect(orphan.stderr).toContain('No evm-module counterpart for top-level packages/chain/abi/Gone.json.');
    expect(readFileSync(join(vendor, 'Gone.json'), 'utf8')).toBe(abi('gone'));
  });
});
