import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { digest, hash, readJson } from './bundle.mjs';

export function collectInstalledTree({ root, layout, manifest, archives }) {
  const lockPath = `${root}/node_modules/.package-lock.json`;
  const lock = fs.existsSync(lockPath) ? readJson(lockPath) : { packages: {} };
  const packages = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), `linked node_modules directory: ${directory}`);
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) { visit(path.join(directory, entry)); continue; }
      const location = path.join(directory, entry);
      assert.ok(!fs.lstatSync(location).isSymbolicLink(), `workspace link in installation: ${location}`);
      if (!fs.existsSync(path.join(location, 'package.json'))) continue;
      const metadata = readJson(path.join(location, 'package.json'));
      const relative = path.relative(root, location);
      const locked = lock.packages[relative] ?? archives[`${metadata.name}@${metadata.version}`] ?? {};
      if (metadata.name.startsWith('@origintrail-official/')) {
        assert.ok(archives[`${metadata.name}@${metadata.version}`], `candidate archive not fetched: ${metadata.name}`);
      }
      const pkg = { path: relative, name: metadata.name, version: metadata.version, integrity: locked.integrity ?? null, resolved: locked.resolved ?? null, dependencies: metadata.dependencies ?? {} };
      if (metadata.name.startsWith('@origintrail-official/')) {
        const prepared = manifest.packages.find(p => p.name === metadata.name);
        assert.ok(prepared, `unknown internal package: ${metadata.name}`);
        const actual = {};
        for (const file of Object.keys(prepared.files)) {
          const target = path.join(location, file);
          assert.ok(fs.realpathSync(target).startsWith(`${location}/`), `installed file escapes package: ${file}`);
          actual[file] = hash(fs.readFileSync(target));
        }
        pkg.filesDigest = digest(actual);
      }
      packages.push(pkg);
      visit(path.join(location, 'node_modules'));
    }
  };
  visit(`${root}/node_modules`);
  packages.sort((a, b) => a.path.localeCompare(b.path));
  return { layout, packages, permittedNonFamilyDrift: packages.filter(p => !manifest.familyPolicy[p.name] && !p.name.startsWith('@origintrail-official/') && !manifest.lockPackages.includes(`${p.name}@${p.version}`)).map(p => ({ name: p.name, version: p.version, reason: 'profile permits unrelated npm transitive resolution; retained for review' })) };
}
