#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synchronizeTrustedControllerSparseCheckouts } from './trusted-controller-pins.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/workflows/evm-integration.yml',
]);

export function syncTrustedControllerCheckouts({ check = false } = {}) {
  const changed = [];
  for (const relativePath of WORKFLOWS) {
    const filePath = path.join(REPO_ROOT, relativePath);
    const current = fs.readFileSync(filePath, 'utf8');
    const synchronized = synchronizeTrustedControllerSparseCheckouts(current);
    if (synchronized === current) continue;
    changed.push(relativePath);
    if (!check) fs.writeFileSync(filePath, synchronized);
  }
  if (check && changed.length > 0) {
    throw new Error(`trusted controller checkout fragments need regeneration: ${changed.join(', ')}`);
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changed = syncTrustedControllerCheckouts({ check: process.argv.includes('--check') });
    console.log(changed.length === 0
      ? 'Trusted controller checkout fragments are current.'
      : `Updated trusted controller checkouts: ${changed.join(', ')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
