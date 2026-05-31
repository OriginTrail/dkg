/**
 * V8/V9 archive surface guard.
 *
 * Issue 0004 — archive non-V10 chain-adapter methods that no longer have
 * production callers and would otherwise be permanent maintenance load.
 *
 * Implementations are preserved under `src/archive/` for history but MUST
 * NOT survive on the live `EVMChainAdapter` / `MockChainAdapter` /
 * `NoChainAdapter` prototypes, nor in the `ChainAdapter` interface, nor
 * (at the active path) in the bundled ABI snapshot.
 *
 * Each assertion below is a `grep`-equivalent statement from the
 * acceptance criteria; the test stays RED until the refactor lands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

/** Methods archived in issue 0004. Names match those listed in the PRD/spec. */
const ARCHIVED_METHODS: ReadonlyArray<string> = [
  // V8 staking lock
  'stakeWithLock',
  'stakeWithLockTier',
  'getDelegatorConvictionMultiplier',
  // V9 knowledge lifecycle
  //
  // NOTE (rc.12 rename): the V10.1 KnowledgeCollection -> KnowledgeAsset
  // rename re-introduced bare "*KnowledgeAssets" names as the canonical
  // V10.1 entrypoints (`createKnowledgeAssets`, `updateKnowledgeAssets`
  // — different signatures, different semantics from the archived V9
  // surface). The V9 PRD-listed name `publishKnowledgeAssets` was
  // re-purposed to `createKnowledgeAssets` (publish-as-mint) in V10.1
  // and remains on this archived list because the V9 name itself is
  // gone. Similarly, `updateKnowledgeAssets` is now a LIVE V10.1
  // method name (replacing the verbose `updateKnowledgeCollectionV10`
  // pattern) and is intentionally NOT listed below — its presence in
  // the live adapter is correct.
  'publishKnowledgeAssets',
  'extendStorage',
  'transferNamespace',
  // V9 permanent publish
  'publishKnowledgeAssetsPermanent',
  // V9 PCA family — all V9-only names. The V10 surface uses explicit
  // `*PublishingConviction*` names (issue #519, PRD §6) to disambiguate
  // from staking conviction, so these bare `Conviction` names must stay
  // absent from the live adapter.
  'createConvictionAccount',
  'addConvictionFunds',
  'extendConvictionLock',
  'addPCAAuthorizedKey',
  'isPCAAuthorizedKey',
  'getConvictionAccountInfo',
  'getConvictionDiscount',
];

function collectMethodNames(ctor: Function): Set<string> {
  const names = new Set<string>();
  let proto = ctor.prototype;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === 'function') names.add(key);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

describe('V8/V9 archive — EVMChainAdapter prototype is clean', () => {
  const methods = collectMethodNames(EVMChainAdapter);
  for (const name of ARCHIVED_METHODS) {
    it(`EVMChainAdapter does NOT export "${name}"`, () => {
      expect(methods.has(name)).toBe(false);
    });
  }
});

describe('V8/V9 archive — MockChainAdapter prototype is clean', () => {
  const methods = collectMethodNames(MockChainAdapter);
  for (const name of ARCHIVED_METHODS) {
    it(`MockChainAdapter does NOT export "${name}"`, () => {
      expect(methods.has(name)).toBe(false);
    });
  }
});

describe('V8/V9 archive — NoChainAdapter prototype is clean', () => {
  const methods = collectMethodNames(NoChainAdapter);
  for (const name of ARCHIVED_METHODS) {
    it(`NoChainAdapter does NOT export "${name}"`, () => {
      expect(methods.has(name)).toBe(false);
    });
  }
});

describe('V8/V9 archive — ChainAdapter interface is clean', () => {
  const SRC = readFileSync(
    join(import.meta.dirname, '..', 'src', 'chain-adapter.ts'),
    'utf8',
  );

  // The interface keeps a few V10-era `@deprecated` aliases (e.g.
  // `V10PublishDirectParams`, `signACKDigest`). The acceptance criterion
  // is narrower: NO `@deprecated` marker should sit on a V8/V9 method
  // SIGNATURE. The single such marker today is on `stakeWithLock?`.
  it('has no `@deprecated` marker preceding any V8 method signature', () => {
    // Find the JSDoc block that immediately precedes `stakeWithLock`. If
    // the line "stakeWithLock?" is present, the deprecation marker is
    // still alive somewhere up-tree, which is the violation we want to
    // pin. Once `stakeWithLock` is archived, the signature is gone, so
    // there is nothing for `@deprecated` to attach to.
    expect(SRC).not.toMatch(/\bstakeWithLock\??\s*\(/);
    expect(SRC).not.toMatch(/\bstakeWithLockTier\??\s*\(/);
  });

  for (const name of ARCHIVED_METHODS) {
    it(`interface no longer declares "${name}"`, () => {
      // Match the method signature shape `name(` or `name?(`. We avoid
      // pure substring matches so comments referencing the archived
      // name in passing don't trip the guard.
      const sigRe = new RegExp(`\\b${name}\\??\\s*\\(`);
      expect(SRC).not.toMatch(sigRe);
    });
  }
});

describe('V8/V9 archive — chain/src files contain no archived names', () => {
  const SRC_DIR = join(import.meta.dirname, '..', 'src');
  const FILES = ['evm-adapter.ts', 'mock-adapter.ts', 'no-chain-adapter.ts', 'chain-adapter.ts'];
  for (const file of FILES) {
    const src = readFileSync(join(SRC_DIR, file), 'utf8');
    for (const name of ARCHIVED_METHODS) {
      it(`src/${file} contains no occurrence of "${name}" (signature, call, or comment)`, () => {
        const re = new RegExp(`\\b${name}\\b`);
        expect(src).not.toMatch(re);
      });
    }
  }
});

describe('V8/V9 archive — source snapshot is preserved on disk', () => {
  it('packages/chain/src/archive/ exists with at least one archived module', () => {
    const archiveDir = join(import.meta.dirname, '..', 'src', 'archive');
    expect(existsSync(archiveDir)).toBe(true);
    // The acceptance criterion allows a single archive module or
    // per-method files — either is fine; we just require *something*.
    const fs = require('node:fs');
    const entries = fs.readdirSync(archiveDir).filter((e: string) => e.endsWith('.ts'));
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('V8/V9 archive — bundled ABIs for archived contracts moved aside', () => {
  const ABI_DIR = join(import.meta.dirname, '..', 'abi');
  const ARCHIVED_ABIS = [
    'Staking.json',
    'KnowledgeAssets.json',
    'KnowledgeCollection.json',
    'PublishingConvictionAccount.json',
    'Paymaster.json',
    'PaymasterManager.json',
    'DelegatorsInfo.json',
    'KnowledgeAssetsStorage.json',
    'ContextGraphNameRegistry.json',
    'IPaymaster.json',
  ];

  for (const abi of ARCHIVED_ABIS) {
    it(`abi/${abi} lives under abi/archive/ (not at the top level)`, () => {
      const live = existsSync(join(ABI_DIR, abi));
      const archived = existsSync(join(ABI_DIR, 'archive', abi));
      // Pass if the file is archived (moved) OR completely removed from
      // the top-level abi/ dir. Either outcome satisfies the spec.
      expect(live).toBe(false);
      if (live) return; // belt + braces
      // archived presence is the documented outcome; absence is also OK.
      if (!archived && !live) {
        // file was deleted outright — acceptable per the criterion.
      }
    });
  }
});
