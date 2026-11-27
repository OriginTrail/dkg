// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface AbiEntry {
  readonly type: string;
  readonly name?: string;
}

describe('Context Graph finalized creation pair invariant', () => {
  it('keeps nameHash and accessPolicy creation-only in ABI and Solidity source', () => {
    const abi = JSON.parse(readFileSync(join(
      import.meta.dirname,
      '..',
      'abi',
      'ContextGraphStorage.json',
    ), 'utf8')) as AbiEntry[];
    expect(abi.some((entry) => (
      entry.type === 'event' && /AccessPolicyUpdated/i.test(entry.name ?? '')
    ))).toBe(false);
    expect(abi.some((entry) => (
      entry.type === 'function' && /(?:set|update).*AccessPolicy/i.test(entry.name ?? '')
    ))).toBe(false);

    // An ABI-only check cannot see a future internal mutator. Either new
    // assignment invalidates event-backed immutable reads until the update is
    // represented in the complete authority index and consumed atomically.
    const source = readFileSync(join(
      import.meta.dirname,
      '..',
      '..',
      'evm-module',
      'contracts',
      'storage',
      'ContextGraphStorage.sol',
    ), 'utf8');
    expect(source.match(/cg\.accessPolicy\s*=/g)).toHaveLength(1);
    expect(source.match(/_contextGraphNameHash\s*\[[^\]]+\]\s*=/g)).toHaveLength(1);
    expect(source).not.toMatch(/event\s+AccessPolicyUpdated\b/);
  });
});
