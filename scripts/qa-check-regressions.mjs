#!/usr/bin/env node
// Refresh inventory; its existing tooling check also validates the register.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/ci/test-inventory.mjs'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
