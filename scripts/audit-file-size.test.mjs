/**
 * Unit tests for the pure helpers powering `scripts/audit-file-size.mjs`.
 *
 * Run with:  node --test scripts/audit-file-size.test.mjs
 *
 * The guard's value depends entirely on (a) measuring the right files --
 * hand-written source, never generated typechain bindings or tests -- and
 * (b) the ratchet semantics: a baselined file may shrink but not grow, and a
 * new file must stay under the cap. Both are covered below so a refactor of
 * the scanner can't silently start waving large files through.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_LINES,
  BASELINE_ROUND,
  isSourceFile,
  countLines,
  roundUpTo,
  budgetForSize,
  budgetFor,
  evaluate,
} from './audit-file-size.mjs';

describe('isSourceFile', () => {
  it('accepts hand-written package source', () => {
    assert.equal(isSourceFile('packages/agent/src/dkg-agent.ts'), true);
    assert.equal(isSourceFile('packages/node-ui/src/ui/Shell/PanelRight.tsx'), true);
  });

  it('rejects files outside a /src/ tree', () => {
    assert.equal(isSourceFile('packages/cli/scripts/thing.ts'), false);
    assert.equal(isSourceFile('scripts/audit-file-size.mjs'), false);
  });

  it('rejects generated typechain bindings even under a src-shaped path', () => {
    assert.equal(isSourceFile('packages/evm-module/typechain/contracts/Storage.ts'), false);
    assert.equal(isSourceFile('packages/chain/src/typechain/Foo.ts'), false);
  });

  it('rejects tests, declarations, generated, and build output', () => {
    assert.equal(isSourceFile('packages/agent/src/dkg-agent.test.ts'), false);
    assert.equal(isSourceFile('packages/agent/src/dkg-agent.spec.tsx'), false);
    assert.equal(isSourceFile('packages/agent/src/types.d.ts'), false);
    assert.equal(isSourceFile('packages/agent/src/schema.generated.ts'), false);
    assert.equal(isSourceFile('packages/agent/dist/src/dkg-agent.ts'), false);
  });

  it('rejects non-ts extensions', () => {
    assert.equal(isSourceFile('packages/agent/src/styles.css'), false);
    assert.equal(isSourceFile('packages/agent/src/data.json'), false);
  });

  it('normalizes backslash paths (Windows)', () => {
    assert.equal(isSourceFile('packages\\agent\\src\\dkg-agent.ts'), true);
  });
});

describe('countLines', () => {
  it('is 0 for empty content', () => {
    assert.equal(countLines(''), 0);
  });

  it('matches wc -l for trailing-newline files', () => {
    assert.equal(countLines('a\n'), 1);
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\n\n'), 2);
    assert.equal(countLines('\n'), 1);
  });

  it('counts the final line when there is no trailing newline', () => {
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\nb'), 2);
  });
});

describe('roundUpTo / budgetForSize', () => {
  it('rounds up to the next step', () => {
    assert.equal(roundUpTo(2864, 50), 2900);
    assert.equal(roundUpTo(2900, 50), 2900);
    assert.equal(roundUpTo(801, 50), 850);
  });

  it('always leaves 1..ROUND lines of headroom', () => {
    assert.equal(budgetForSize(2864), 2900); // 36 lines headroom
    assert.equal(budgetForSize(2850), 2900); // 50 lines headroom
    assert.equal(budgetForSize(2900), 2950); // on a boundary -> still grows
    assert.ok(budgetForSize(1234) > 1234);
    assert.ok(budgetForSize(1234) - 1234 <= BASELINE_ROUND);
  });
});

describe('budgetFor', () => {
  const baseline = { 'packages/agent/src/dkg-agent.ts': 2100 };

  it('uses the baseline entry when present', () => {
    assert.equal(budgetFor('packages/agent/src/dkg-agent.ts', baseline), 2100);
  });

  it('falls back to the default cap otherwise', () => {
    assert.equal(budgetFor('packages/agent/src/new-file.ts', baseline), DEFAULT_MAX_LINES);
  });
});

describe('evaluate', () => {
  it('passes a new file under the cap with no warning', () => {
    const { violations, warnings } = evaluate([{ path: 'a/src/x.ts', lines: 400 }], {});
    assert.equal(violations.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('warns (but does not fail) a new file approaching the cap', () => {
    const { violations, warnings } = evaluate([{ path: 'a/src/x.ts', lines: 770 }], {});
    assert.equal(violations.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, 'a/src/x.ts');
  });

  it('fails a NEW file over the cap', () => {
    const { violations } = evaluate([{ path: 'a/src/big.ts', lines: 900 }], {});
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'new-file-over-cap');
    assert.equal(violations[0].budget, DEFAULT_MAX_LINES);
  });

  it('lets a baselined file sit at or below its budget', () => {
    const baseline = { 'a/src/big.ts': 2900 };
    const { violations } = evaluate([{ path: 'a/src/big.ts', lines: 2890 }], baseline);
    assert.equal(violations.length, 0);
  });

  it('fails a baselined file that grew past its budget', () => {
    const baseline = { 'a/src/big.ts': 2900 };
    const { violations } = evaluate([{ path: 'a/src/big.ts', lines: 2950 }], baseline);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'baselined-file-grew');
    assert.equal(violations[0].budget, 2900);
  });

  it('sorts violations largest-first', () => {
    const { violations } = evaluate(
      [
        { path: 'a/src/small.ts', lines: 850 },
        { path: 'a/src/huge.ts', lines: 4000 },
      ],
      {},
    );
    assert.deepEqual(
      violations.map((v) => v.path),
      ['a/src/huge.ts', 'a/src/small.ts'],
    );
  });
});
