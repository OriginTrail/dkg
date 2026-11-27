import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInstalledTree } from '../package-certification/installed-tree.mjs';
import { CLI, tarFiles, validateTree } from '../package-certification/bundle.mjs';
import { fixture, writeJson } from './package-certification-fixture.mjs';

for (const layout of ['core-slot', 'edge-global']) for (const damage of ['none', 'asset', 'nested-family']) {
  test(`${layout} physical collection ${damage === 'none' ? 'validates installed bytes and integrity acquisition' : `rejects ${damage} changes`}`, t => {
    const f = fixture(t), root = path.join(fs.realpathSync(f.root), layout === 'core-slot' ? 'slot' : 'prefix/lib');
    const archives = {}, locked = {};
    const record = (name, version, integrity, resolved) => {
      archives[`${name}@${version}`] = { integrity, resolved };
      locked[`node_modules/${name}`] = { integrity, resolved: `https://lock.invalid/${name}` };
    };
    for (const pkg of f.manifest.packages) {
      for (const [name, bytes] of tarFiles(fs.readFileSync(path.join(f.bundle, pkg.tarball)))) {
        const file = path.join(root, 'node_modules', pkg.name, name);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      }
      record(pkg.name, pkg.version, pkg.integrity, `http://fixture/registry/${pkg.tarball}`);
    }
    const family = path.join(root, 'node_modules/libp2p');
    fs.mkdirSync(family, { recursive: true });
    writeJson(path.join(family, 'package.json'), { name: 'libp2p', version: '3.5.1' });
    record('libp2p', '3.5.1', 'sha512-family', 'https://registry.invalid/libp2p.tgz');
    if (layout === 'core-slot') writeJson(path.join(root, 'node_modules/.package-lock.json'), { packages: locked });
    const collect = () => collectInstalledTree({ root, layout, manifest: f.manifest, archives });
    const tree = collect();
    validateTree(tree, f.manifest);
    assert.equal(tree.layout, layout);
    assert.equal(tree.packages.length, 3);
    for (const pkg of tree.packages) {
      const acquisition = layout === 'core-slot' ? locked[pkg.path] : archives[`${pkg.name}@${pkg.version}`];
      assert.equal(pkg.integrity, acquisition.integrity);
      assert.equal(pkg.resolved, acquisition.resolved);
    }
    if (damage === 'asset') {
      fs.appendFileSync(path.join(root, 'node_modules', CLI, 'dist/cli.js'), '\nchanged installed bytes');
      assert.throws(() => validateTree(collect(), f.manifest), /modified installed package/);
    } else if (damage === 'nested-family') {
      const nested = path.join(root, 'node_modules', CLI, 'node_modules/libp2p');
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(nested, 'package.json'), { name: 'libp2p', version: '3.5.1' });
      assert.throws(() => validateTree(collect(), f.manifest), /duplicate family dependency/);
    }
  });
}
