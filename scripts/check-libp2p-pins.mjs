#!/usr/bin/env node
// Fails when a published package's libp2p family dependency is not the exact
// version in pnpm-lock.yaml. See scripts/lib/libp2p-pins.mjs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLibp2pPinViolations, lockfileFamilyVersions } from './lib/libp2p-pins.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifests = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir, 'package.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((manifest) => !manifest.private);
const lockVersions = lockfileFamilyVersions(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const violations = findLibp2pPinViolations({ manifests, lockVersions });
for (const violation of violations) console.error(`libp2p pins: ${violation}`);
if (violations.length > 0) process.exit(1);
console.log(`libp2p pins: ${lockVersions.size} family packages pinned exactly in ${manifests.length} published packages.`);
