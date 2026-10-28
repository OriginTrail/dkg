#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveRegression } from './lib/regressions/proof.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
try {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--case', '--bad-ref', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('usage: qa:prove-regression --case GH-N --bad-ref REF [--output NEW_DIRECTORY]');
    options[args[i]] = args[i + 1];
  }
  if (!/^GH-\d+$/.test(options['--case'] ?? '') || !options['--bad-ref']) throw new Error('--case and --bad-ref are required');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/regressions', `${options['--case']}.json`), 'utf8'));
  const output = options['--output'] ? path.resolve(options['--output'])
    : path.join(root, '.regression-proofs', `${record.id}-${Date.now()}`);
  await proveRegression(root, record, options['--bad-ref'], output, { signal: abort.signal });
  console.log(`${record.id}: PROVEN (historical red / candidate green). Evidence: ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
