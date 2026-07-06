import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

function copyIfPresent(fromRoot, toRoot, relPath) {
  const source = path.join(fromRoot, relPath);
  if (!fs.existsSync(source)) return;
  const target = path.join(toRoot, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function symlinkDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, 'dir');
}

test('import-ontology dry-run reports a build prerequisite instead of compiling core', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ontology-script-'));
  const miniRepo = path.join(tempRoot, 'repo');
  const fixtureDir = path.join(tempRoot, 'ontology-fixture');

  try {
    copyIfPresent(REPO_ROOT, miniRepo, 'package.json');
    copyIfPresent(REPO_ROOT, miniRepo, 'tsconfig.base.json');
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/import-ontology.mjs');
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/lib/dkg-daemon.mjs');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/package.json');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/tsconfig.json');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/src/project-ontology.ts');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/src/sparql-safe.ts');

    const typescriptPackage = path.join(REPO_ROOT, 'node_modules/typescript');
    assert.ok(fs.existsSync(typescriptPackage), 'typescript package must be installed to run the source-checkout smoke test');
    symlinkDir(typescriptPackage, path.join(miniRepo, 'node_modules/typescript'));
    symlinkDir(
      path.join(miniRepo, 'packages/core'),
      path.join(miniRepo, 'node_modules/@origintrail-official/dkg-core'),
    );

    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'ontology.ttl'), '@prefix ex: <urn:example:> .\n', 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'agent-guide.md'), '# Test guide\n', 'utf8');

    const result = spawnSync(process.execPath, [
      'scripts/import-ontology.mjs',
      '--dry-run',
      `--dir=${fixtureDir}`,
      '--project=test-project',
      '--starter=test-starter',
    ], {
      cwd: miniRepo,
      encoding: 'utf8',
    });

    assert.equal(
      result.status,
      1,
      `expected dry-run to fail cleanly before core is built\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /@origintrail-official\/dkg-core\/project-ontology is not built/,
    );
    assert.match(
      result.stderr,
      /pnpm --filter @origintrail-official\/dkg-core build/,
    );
    assert.equal(
      fs.existsSync(path.join(miniRepo, 'packages/core/dist')),
      false,
      'dry-run must not compile or mutate packages/core/dist',
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('import-ontology dry-run uses the built public core package subpath', () => {
  const coreDistEntry = path.join(REPO_ROOT, 'packages/core/dist/project-ontology.js');
  assert.ok(
    fs.existsSync(coreDistEntry),
    'packages/core must be built before running script smoke tests',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ontology-script-built-'));
  const miniRepo = path.join(tempRoot, 'repo');
  const fixtureDir = path.join(tempRoot, 'ontology-fixture');

  try {
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/import-ontology.mjs');
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/lib/dkg-daemon.mjs');
    symlinkDir(
      path.join(REPO_ROOT, 'packages/core'),
      path.join(miniRepo, 'node_modules/@origintrail-official/dkg-core'),
    );

    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'ontology.ttl'), '@prefix ex: <urn:example:> .\n', 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'agent-guide.md'), '# Test guide\n', 'utf8');

    const result = spawnSync(process.execPath, [
      'scripts/import-ontology.mjs',
      '--dry-run',
      `--dir=${fixtureDir}`,
      '--project=test-project',
      '--starter=test-starter',
    ], {
      cwd: miniRepo,
      encoding: 'utf8',
    });

    assert.equal(
      result.status,
      0,
      `expected dry-run to succeed with built core package\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /\[ontology\] Produced 21 triples from test-starter starter:/);
    assert.match(result.stdout, /ontology URI\s+= urn:dkg:project:test-project:ontology/);
    assert.match(result.stdout, /guide URI\s+= urn:dkg:project:test-project:ontology:agent-guide/);
    assert.match(result.stdout, /\[ontology\] --dry-run set; not importing\./);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
