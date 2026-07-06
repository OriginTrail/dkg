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

test('import-ontology dry-run works from source checkout without built core output', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ontology-script-'));
  const miniRepo = path.join(tempRoot, 'repo');
  const fixtureDir = path.join(tempRoot, 'ontology-fixture');

  try {
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/import-ontology.mjs');
    copyIfPresent(REPO_ROOT, miniRepo, 'scripts/lib/dkg-daemon.mjs');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/src/project-ontology-runtime.js');
    copyIfPresent(REPO_ROOT, miniRepo, 'packages/core/src/sparql-safe-runtime.js');

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
      `expected dry-run to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /\[ontology\] Produced 21 triples from test-starter starter:/);
    assert.match(result.stdout, /ontology URI\s+= urn:dkg:project:test-project:ontology/);
    assert.match(result.stdout, /guide URI\s+= urn:dkg:project:test-project:ontology:agent-guide/);
    assert.match(result.stdout, /\[ontology\] --dry-run set; not importing\./);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
