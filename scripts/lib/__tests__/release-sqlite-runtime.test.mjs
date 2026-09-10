import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { findNodeSqliteEngineMismatches } from '../../release-packages.mjs';

const cliManifest = new URL('../../../packages/cli/package.json', import.meta.url);
const requiredNodeRange = JSON.parse(fs.readFileSync(cliManifest, 'utf8')).engines.node;

function writePolicy(root, range) {
  const cliDir = path.join(root, 'packages', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({
    name: '@origintrail-official/dkg', version: '1.0.0', type: 'module', engines: { node: range },
  }));
  return cliDir;
}

test('new publishable SQLite consumers must declare the canonical Node runtime range', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-sqlite-engine-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
    writePolicy(root, requiredNodeRange);
    const dir = path.join(root, 'packages', 'new-consumer');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const pkg = { name: '@origintrail-official/new-consumer', version: '1.0.0' };
    const manifest = path.join(dir, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'src', 'database.ts'), "const moduleName = 'node:sqlite';\n");
    assert.equal(findNodeSqliteEngineMismatches(root).length, 1);
    pkg.engines = { node: '>=22' };
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    assert.equal(findNodeSqliteEngineMismatches(root).length, 1);
    pkg.engines.node = requiredNodeRange;
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    assert.deepEqual(findNodeSqliteEngineMismatches(root), []);
    delete pkg.engines;
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'src', 'database.ts'), 'export const noSqlite = true;');
    assert.deepEqual(findNodeSqliteEngineMismatches(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('current publishable SQLite consumers declare the supported runtime', () => {
  assert.deepEqual(findNodeSqliteEngineMismatches(), []);
});


test('target package metadata drives both release validation and the isolated runtime diagnostic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-sqlite-policy-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
    const cliDir = writePolicy(root, '>=99.0.0');
    const dist = path.join(cliDir, 'dist');
    fs.mkdirSync(dist);
    const source = fs.readFileSync(new URL('../../../packages/cli/src/node-runtime-preflight.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const modulePath = path.join(dist, 'node-runtime-preflight.js');
    fs.writeFileSync(modulePath, compiled);
    const consumer = path.join(root, 'packages', 'consumer');
    fs.mkdirSync(path.join(consumer, 'src'), { recursive: true });
    fs.writeFileSync(path.join(consumer, 'src', 'database.ts'), "import { DatabaseSync } from 'node:sqlite';");
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
      name: '@origintrail-official/consumer', engines: { node: requiredNodeRange },
    }));
    const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      const runtime = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const status = runtime.inspectNodeRuntime({ version: 'fixture', getBuiltinModule: () => undefined });
      process.stdout.write(JSON.stringify({ range: status.requiredNodeRange, error: runtime.nodeRuntimeError(status) }));
    `], { encoding: 'utf8' });
    for (const range of ['>=99.0.0', '>=100.0.0']) {
      writePolicy(root, range);
      assert.equal(findNodeSqliteEngineMismatches(root)[0].expected, range);
      const result = probe();
      assert.equal(result.status, 0, result.stderr);
      const diagnostic = JSON.parse(result.stdout);
      assert.equal(diagnostic.range, range);
      assert.ok(diagnostic.error.includes(range));
    }
    for (const missingPolicy of [undefined, '']) {
      writePolicy(root, missingPolicy);
      assert.throws(() => findNodeSqliteEngineMismatches(root), /engines.node/);
      const result = probe();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /engines.node/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
