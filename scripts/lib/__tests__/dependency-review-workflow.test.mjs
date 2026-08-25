import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/dependency-review.yml');

test('dependency review gates pull requests and merge-queue candidates with event-native refs', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  assert.match(workflow, /^  pull_request:\n    branches: \[main, testnet-canary\]$/m);
  assert.match(workflow, /^  merge_group:\n    types: \[checks_requested\]$/m);
  assert.match(
    workflow,
    /base-ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/,
  );
  assert.match(
    workflow,
    /head-ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \}\}/,
  );
  assert.match(workflow, /^          fail-on-severity: high$/m);
  assert.match(workflow, /^          fail-on-scopes: runtime, development, unknown$/m);
});
