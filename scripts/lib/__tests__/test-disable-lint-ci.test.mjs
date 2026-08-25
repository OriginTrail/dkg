import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('repository exposes the disabled-test ratchet through local and CI entry points', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/test-disable-lint.yml'),
    'utf8',
  );
  const triggerBlock = workflow.slice(
    workflow.indexOf('on:\n'),
    workflow.indexOf('\nconcurrency:'),
  );
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
  const permissionsBlock = workflow.slice(
    workflow.indexOf('permissions:\n'),
    workflow.indexOf('\njobs:'),
  );
  const permissions = [...permissionsBlock.matchAll(/^  ([a-z-]+): ([a-z]+)$/gm)]
    .map((match) => `${match[1]}: ${match[2]}`);
  const firstParent = workflow.indexOf('BASE_SHA="$(git rev-parse HEAD^1)"');
  const diffScan = workflow.indexOf(
    'node scripts/test-disable-lint.mjs --diff "${BASE_SHA}" HEAD',
  );

  assert.deepEqual({
    localCommand: packageJson.scripts['lint:test-disable'],
    triggers,
    permissions,
    checkoutCount: workflow.match(/uses: actions\/checkout@/g)?.length ?? 0,
    safeCheckout: workflow.includes('persist-credentials: false'),
    twoCommitHistory: workflow.includes('fetch-depth: 2'),
    lifecycleFreeFrozenInstall: workflow.includes(
      'pnpm install --frozen-lockfile --ignore-scripts',
    ),
    manualAudit: workflow.includes('if [[ "${EVENT_NAME}" == "workflow_dispatch" ]]')
      && workflow.includes('node scripts/test-disable-lint.mjs --all'),
    firstParentBeforeDiff: firstParent !== -1 && firstParent < diffScan,
    stalePayloadBaseAbsent: !workflow.includes('github.event.pull_request.base.sha'),
  }, {
    localCommand: 'node scripts/test-disable-lint.mjs',
    triggers: ['pull_request', 'merge_group', 'workflow_dispatch'],
    permissions: ['contents: read'],
    checkoutCount: 1,
    safeCheckout: true,
    twoCommitHistory: true,
    lifecycleFreeFrozenInstall: true,
    manualAudit: true,
    firstParentBeforeDiff: true,
    stalePayloadBaseAbsent: true,
  });
});
