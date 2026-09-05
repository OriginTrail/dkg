import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_SPECS,
  PER_FILE_OVERHEAD_MS,
  UNKNOWN_FILE_BODY_MS,
  planPackageShards,
  planWeightedShards,
} from '../../ci/plan-vitest-shard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/ci/plan-vitest-shard.mjs');

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function independentlyDiscover(packageDirectory, excludeArchive) {
  const packageRoot = path.join(REPO_ROOT, packageDirectory);
  const testRoot = path.join(packageRoot, 'test');
  const files = [];

  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(path.relative(packageRoot, absolutePath).split(path.sep).join('/'));
      }
    }
  }

  walk(testRoot);
  return files
    .filter((file) => !excludeArchive
      || (!file.startsWith('test/archive/') && file !== 'test/evm-adapter.test.ts'))
    .sort(compareAscii);
}

for (const packageName of ['cli', 'chain']) {
  test(packageName + ' shards cover every eligible file exactly once', () => {
    const spec = PACKAGE_SPECS[packageName];
    const expected = independentlyDiscover(
      spec.packageDirectory,
      packageName === 'chain',
    );
    const shards = planPackageShards(packageName, REPO_ROOT);
    const flattened = shards.flatMap((shard) => shard.files);

    assert.equal(shards.length, spec.shardCount);
    assert.ok(shards.every((shard) => shard.files.length > 0));
    assert.equal(new Set(flattened).size, flattened.length, 'shards must not overlap');
    assert.deepEqual([...flattened].sort(compareAscii), expected);

    for (const shard of shards) {
      assert.deepEqual(shard.files, [...shard.files].sort(compareAscii));
    }
  });

  test(packageName + ' shard planning is deterministic and balanced for the timing snapshot', () => {
    const first = planPackageShards(packageName, REPO_ROOT);
    const second = planPackageShards(packageName, REPO_ROOT);
    assert.deepEqual(second, first);

    const unknownCount = first.reduce(
      (count, shard) => count + shard.unknownFiles.length,
      0,
    );
    if (unknownCount === 0) {
      const loads = first.map((shard) => shard.estimatedMs);
      assert.ok(
        Math.max(...loads) - Math.min(...loads) < 1_000,
        'latest-run weights should keep shard estimates within one second',
      );
    }
  });
}

test('chain discovery excludes archived suites and the separately owned EVM integration test', () => {
  const shards = planPackageShards('chain', REPO_ROOT);
  const files = shards.flatMap((shard) => shard.files);
  assert.ok(files.includes('test/v8-v9-archive.test.ts'));
  assert.ok(files.every((file) => !file.startsWith('test/archive/')));
  assert.ok(!files.includes('test/evm-adapter.test.ts'));
});

test('unknown files are conservatively weighted and still assigned exactly once', () => {
  const shards = planWeightedShards({
    files: [
      'test/a.test.ts',
      'test/new-unmeasured.test.ts',
      'test/z.test.ts',
    ],
    bodyWeightsMs: {
      'test/a.test.ts': 100,
      'test/z.test.ts': 200,
    },
    shardCount: 2,
  });
  const flattened = shards.flatMap((shard) => shard.files);
  const unknowns = shards.flatMap((shard) => shard.unknownFiles);

  assert.deepEqual([...flattened].sort(compareAscii), [
    'test/a.test.ts',
    'test/new-unmeasured.test.ts',
    'test/z.test.ts',
  ]);
  assert.equal(new Set(flattened).size, 3);
  assert.deepEqual(unknowns, ['test/new-unmeasured.test.ts']);

  const unknownShard = shards.find((shard) =>
    shard.files.includes('test/new-unmeasured.test.ts'));
  assert.ok(unknownShard);
  assert.ok(
    unknownShard.estimatedMs >= UNKNOWN_FILE_BODY_MS + PER_FILE_OVERHEAD_MS,
  );
});

test('equal weights use stable path and shard-index tie breakers', () => {
  const plan = () => planWeightedShards({
    files: [
      'test/d.test.ts',
      'test/c.test.ts',
      'test/b.test.ts',
      'test/a.test.ts',
    ],
    bodyWeightsMs: {
      'test/a.test.ts': 0,
      'test/b.test.ts': 0,
      'test/c.test.ts': 0,
      'test/d.test.ts': 0,
    },
    shardCount: 2,
  });

  assert.deepEqual(plan(), [
    {
      index: 1,
      estimatedMs: PER_FILE_OVERHEAD_MS * 2,
      files: ['test/a.test.ts', 'test/c.test.ts'],
      unknownFiles: [],
    },
    {
      index: 2,
      estimatedMs: PER_FILE_OVERHEAD_MS * 2,
      files: ['test/b.test.ts', 'test/d.test.ts'],
      unknownFiles: [],
    },
  ]);
  assert.deepEqual(plan(), plan());
});

test('the executable prints only its selected shard to stdout', () => {
  const expected = planPackageShards('cli', REPO_ROOT)[0].files;
  const result = spawnSync(process.execPath, [SCRIPT_PATH, 'cli', '1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), expected);
  assert.match(result.stderr, /vitest-shard: cli 1\/4/);

  const invalid = spawnSync(process.execPath, [SCRIPT_PATH, 'chain', '4'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /CLI has 4 shards and chain has 3 shards/);
});

test('invalid or duplicate planning inputs fail loudly', () => {
  assert.throws(
    () => planWeightedShards({
      files: ['test/a.test.ts'],
      bodyWeightsMs: {},
      shardCount: 2,
    }),
    /at least one eligible test file per shard/,
  );
  assert.throws(
    () => planWeightedShards({
      files: ['test/a.test.ts', 'test/a.test.ts'],
      bodyWeightsMs: {},
      shardCount: 1,
    }),
    /contains duplicates/,
  );
});
