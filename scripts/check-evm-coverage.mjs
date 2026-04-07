#!/usr/bin/env node
/**
 * Reads `packages/evm-module/coverage/lcov.info` (produced by `pnpm test:coverage`
 * in evm-module) and fails if totals fall below ratchet floors.
 *
 * Ratchet baseline: 2026-04-06 (`hardhat coverage` Istanbul summary).
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
  lines: 60,
  branches: 48,
  functions: 65,
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
