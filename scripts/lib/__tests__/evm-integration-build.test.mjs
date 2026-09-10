import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { buildEvmIntegration, integrationBuildArgs } from '../../ci/build-evm-integration.mjs';
import { validateEvmResults } from '../ci-results.mjs';
import { EVM_SCOPES, planCi } from '../ci-delta.mjs';

test('EVM build selects only requested workspace dependency closures', () => {
  assert.deepEqual(integrationBuildArgs(['publisher', 'chain']), [
    'exec', 'turbo', 'build',
    '--filter=@origintrail-official/dkg-chain...',
    '--filter=@origintrail-official/dkg-publisher...',
  ]);
  assert.deepEqual(integrationBuildArgs([...EVM_SCOPES].reverse()), [
    'exec', 'turbo', 'build', ...EVM_SCOPES.map((scope) => `--filter=@origintrail-official/dkg-${scope}...`),
  ]);
  for (const scope of EVM_SCOPES) {
    assert.deepEqual(integrationBuildArgs([scope]), ['exec', 'turbo', 'build', `--filter=@origintrail-official/dkg-${scope}...`]);
  }
  for (const invalid of [null, [], ['chain', 'chain'], ['unknown'], ['chain; echo bad']]) {
    assert.throws(() => integrationBuildArgs(invalid), /unique EVM scopes/);
  }
});

test('a successful cached Node build still compiles EVM and compiler failure propagates', () => {
  const calls = [];
  assert.equal(buildEvmIntegration(['agent'], {
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: calls.length === 1 ? 0 : 7 };
    },
  }), 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.DKG_SKIP_EVM_BUILD, '1');
  assert.deepEqual(calls[1].args.slice(-4), ['hardhat', 'compile', '--config', 'hardhat.node.config.ts']);
});

test('EVM matrix consumes one same-run build and propagates producer failure', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/evm-integration.yml', import.meta.url), 'utf8'));
  const { build, 'evm-integration': matrix, 'evm-gate': gate } = workflow.jobs;
  assert.equal(build.if, matrix.if);
  assert.deepEqual(matrix.needs, ['plan', 'build']);
  assert.deepEqual(gate.needs, ['plan', 'build', 'evm-integration']);
  assert.ok(build.steps.some((step) => step.with?.name === 'evm-integration-build' && step.with['if-no-files-found'] === 'error'));
  assert.ok(matrix.steps.some((step) => step.with?.name === 'evm-integration-build'));
  assert.ok(matrix.steps.some((step) => step.run === 'tar -xzf /tmp/evm-integration-build.tgz'));
  assert.ok(!matrix.steps.some((step) => /build:packages|turbo build|hardhat compile/.test(step.run ?? '')));
  const errors = validateEvmResults({
    eventName: 'merge_group', plan: planCi({ eventName: 'merge_group' }),
    needs: { plan: { result: 'success' }, build: { result: 'failure' }, 'evm-integration': { result: 'skipped' } },
  });
  assert.match(errors.join('\n'), /build ended with failure/);
  assert.match(errors.join('\n'), /evm-integration was selected but ended with skipped/);

});
