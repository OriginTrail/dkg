#!/usr/bin/env node
/**
 * Reads `packages/evm-module/coverage/lcov.info` (produced by `pnpm test:coverage`
 * in evm-module) and fails if totals fall below ratchet floors.
 *
 * Ratchet history:
 *
 *   - 2026-04-06: initial floors set to lines=60 / branches=48 / functions=65,
 *     measured against the full `contracts/` tree (V8/V9 contracts were still
 *     in the active set and being exercised by tests under `test/unit/` and
 *     `test/integration/`).
 *
 *   - 2026-05-28: re-baselined alongside `.solcover.js` skipping
 *     `contracts/archive/` (PR #500 moved 10 V8/V9 contracts and their tests
 *     out of the active set; commit 929e29fe). The skip removed 888 lines
 *     (LF 4061 → 3173), 446 branches (BRF 2222 → 1776) and 149 functions
 *     (FNF 926 → 777) of dead, never-exercised code from the metric — all
 *     of those rows were 0/0 in LH/BRH/FNH, so the live LH/BRH/FNH numbers
 *     are unchanged but the denominators shrank.
 *
 *     Without raising the floors to match, the old floors on the narrower
 *     metric would represent strictly weaker protection (the dead-code
 *     denominator used to inflate the bar in absolute LH-units). Post-skip
 *     baseline on `fix/solidity-coverage-skip-archive`:
 *
 *       lines     71.82%   (LH=2279  LF=3173)
 *       branches  58.00%   (BRH=1030 BRF=1776)
 *       functions 68.08%   (FNH=529  FNF=777)
 *
 *     New floors are set ~2 percentage points below current to lock in the
 *     baseline while leaving room for benign coverage drift. At this
 *     sensitivity, a regression of >= ~58 covered lines, ~36 branches or
 *     ~16 functions would trip the ratchet — appropriate for a push-only
 *     safety net (no PR-time noise, but no slack for real regressions).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const lcovPath = path.join(
  repoRoot,
  'packages',
  'evm-module',
  'coverage',
  'lcov.info',
);

const MIN = {
  lines: 70,
  branches: 56,
  functions: 66,
};

function aggregateLcov(text) {
  const blocks = text.split('end_of_record');
  let LF = 0;
  let LH = 0;
  let BRF = 0;
  let BRH = 0;
  let FNF = 0;
  let FNH = 0;
  for (const b of blocks) {
    let m = b.match(/^LF:(\d+)/m);
    if (m) LF += Number(m[1]);
    m = b.match(/^LH:(\d+)/m);
    if (m) LH += Number(m[1]);
    m = b.match(/^BRF:(\d+)/m);
    if (m) BRF += Number(m[1]);
    m = b.match(/^BRH:(\d+)/m);
    if (m) BRH += Number(m[1]);
    m = b.match(/^FNF:(\d+)/m);
    if (m) FNF += Number(m[1]);
    m = b.match(/^FNH:(\d+)/m);
    if (m) FNH += Number(m[1]);
  }
  if (LF === 0 && BRF === 0 && FNF === 0) {
    throw new Error('LCOV contains no coverage data — the file may be empty or malformed');
  }
  const linesPct = LF > 0 ? (100 * LH) / LF : 0;
  const branchesPct = BRF > 0 ? (100 * BRH) / BRF : 0;
  const funcsPct = FNF > 0 ? (100 * FNH) / FNF : 0;
  return { LF, LH, linesPct, BRF, BRH, branchesPct, FNF, FNH, funcsPct };
}

function main() {
  if (!fs.existsSync(lcovPath)) {
    console.error(`check-evm-coverage: missing ${lcovPath}`);
    console.error('Run: cd packages/evm-module && pnpm test:coverage');
    process.exit(1);
  }

  const text = fs.readFileSync(lcovPath, 'utf8');
  const a = aggregateLcov(text);

  const failures = [];
  if (a.linesPct + 1e-9 < MIN.lines) {
    failures.push(
      `lines ${a.linesPct.toFixed(2)}% < ${MIN.lines}% (LH=${a.LH} LF=${a.LF})`,
    );
  }
  if (a.branchesPct + 1e-9 < MIN.branches) {
    failures.push(
      `branches ${a.branchesPct.toFixed(2)}% < ${MIN.branches}% (BRH=${a.BRH} BRF=${a.BRF})`,
    );
  }
  if (a.funcsPct + 1e-9 < MIN.functions) {
    failures.push(
      `functions ${a.funcsPct.toFixed(2)}% < ${MIN.functions}% (FNH=${a.FNH} FNF=${a.FNF})`,
    );
  }

  console.log(
    `Solidity coverage totals: lines ${a.linesPct.toFixed(2)}% (min ${MIN.lines}%), ` +
      `branches ${a.branchesPct.toFixed(2)}% (min ${MIN.branches}%), ` +
      `functions ${a.funcsPct.toFixed(2)}% (min ${MIN.functions}%)`,
  );

  if (failures.length) {
    console.error('check-evm-coverage: threshold failure(s):');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
