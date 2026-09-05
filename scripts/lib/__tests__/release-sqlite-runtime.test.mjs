import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findNodeSqliteEngineMismatches } from '../../release-packages.mjs';

test('new publishable SQLite consumers must declare the canonical Node runtime range', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-sqlite-engine-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
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
    pkg.engines.node = '>=22.13.0 <23.0.0 || >=23.4.0';
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
