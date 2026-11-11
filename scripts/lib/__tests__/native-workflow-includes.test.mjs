import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

// The macOS/Windows/Linux MCP metadata and macOS Oxigraph workflows run named
// CLI test files with vitest.unit.config.ts, but do not trigger on that config,
// which changes whenever any CLI unit test is added. Vitest runs a named file
// only if the config includes it, so this keeps every file those workflows
// name in the config: dropping one fails here, on the pull request that
// drops it, instead of silently leaving a native suite with nothing to run.
const read = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const unitConfig = read('packages/cli/vitest.unit.config.ts');

for (const workflowFile of ['mcp-config-native.yml', 'oxigraph-lifecycle-native.yml']) {
  test(`${workflowFile} runs only CLI tests that vitest.unit.config.ts includes`, () => {
    const workflow = parse(read(`.github/workflows/${workflowFile}`));
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ''))
      .filter((run) => run.includes('--config vitest.unit.config.ts'));
    assert.ok(runs.length > 0, `${workflowFile} no longer runs vitest.unit.config.ts`);
    const files = runs.flatMap((run) => run.split(/\s+/).filter((word) => /^test\/\S+\.test\.ts$/.test(word)));
    assert.ok(files.length > 0, `${workflowFile} names no test files`);
    for (const file of files) {
      assert.ok(unitConfig.includes(`'${file}'`) || unitConfig.includes(`"${file}"`), `${file} is not in packages/cli/vitest.unit.config.ts`);
      assert.doesNotThrow(() => read(`packages/cli/${file}`), `${file} does not exist`);
    }
    assert.ok(!workflow.on.pull_request.paths.includes('packages/cli/vitest.unit.config.ts'));
  });
}
