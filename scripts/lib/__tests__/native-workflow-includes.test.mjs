import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { discoverVitestFiles } from '../../ci/discover-vitest-files.mjs';

// The macOS/Windows/Linux MCP metadata and macOS Oxigraph workflows run named
// CLI test files with vitest.unit.config.ts, but do not trigger on that config,
// which changes whenever any CLI unit test is added. Vitest runs a named file
// only if the config discovers it, so this asks Vitest which files the config
// discovers: dropping, commenting out or excluding one of those files fails
// here, on the pull request that does it, instead of silently leaving a
// native suite with nothing to run.
const CLI_ROOT = fileURLToPath(new URL('../../../packages/cli/', import.meta.url));
const UNIT_CONFIG = 'vitest.unit.config.ts';
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

export function nativeSelectors(workflowFile) {
  const workflow = parse(read(`.github/workflows/${workflowFile}`));
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ''))
    .filter((run) => run.includes(`--config ${UNIT_CONFIG}`));
  return { workflow, runs, files: runs.flatMap((run) => run.split(/\s+/).filter((word) => /^test\/\S+\.test\.ts$/.test(word))) };
}

export function undiscovered(selectors, discovered) {
  const found = new Set(discovered);
  return selectors.filter((file) => !found.has(file));
}

const WORKFLOWS = ['mcp-config-native.yml', 'oxigraph-lifecycle-native.yml'];

test('every CLI test the native workflows run is discovered by vitest.unit.config.ts', () => {
  const discovered = discoverVitestFiles(CLI_ROOT, { config: UNIT_CONFIG });
  for (const workflowFile of WORKFLOWS) {
    const { workflow, runs, files } = nativeSelectors(workflowFile);
    assert.ok(runs.length > 0, `${workflowFile} no longer runs ${UNIT_CONFIG}`);
    assert.ok(files.length > 0, `${workflowFile} names no test files`);
    assert.deepEqual(undiscovered(files, discovered), [], `${workflowFile} runs files ${UNIT_CONFIG} does not discover`);
    assert.ok(!workflow.on.pull_request.paths.includes(`packages/cli/${UNIT_CONFIG}`));
  }
});

test('a selector commented out of the config is no longer discovered, and the check reports it', () => {
  const { files } = nativeSelectors('oxigraph-lifecycle-native.yml');
  const victim = 'test/oxigraph-orphan-native.test.ts';
  assert.ok(files.includes(victim));
  const source = readFileSync(`${CLI_ROOT}${UNIT_CONFIG}`, 'utf8');
  const entry = `'${victim}',`;
  assert.equal(source.split(entry).length, 2, `${victim} is listed once in ${UNIT_CONFIG}`);
  // A sibling of the real config (same relative paths), named so no config scan picks it up.
  const fixture = `.native-guard-${process.pid}.config.ts`;
  writeFileSync(`${CLI_ROOT}${fixture}`, source.replace(entry, `// ${entry}`));
  try {
    const discovered = discoverVitestFiles(CLI_ROOT, { config: fixture });
    assert.deepEqual(undiscovered(files, discovered), [victim]);
  } finally {
    rmSync(`${CLI_ROOT}${fixture}`, { force: true });
  }
  assert.deepEqual(undiscovered(['test/a.test.ts', 'test/b.test.ts'], ['test/b.test.ts']), ['test/a.test.ts']);
});
