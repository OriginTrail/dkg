import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Package Turbo test inputs are also the source of shared-fixture coverage provenance. */
export function sharedTestInputs(root, name) {
  const file = path.join(root, 'packages', name, 'turbo.json');
  if (!fs.existsSync(file)) return [];
  const inputs = JSON.parse(fs.readFileSync(file, 'utf8')).tasks?.test?.inputs ?? [];
  return inputs.filter((input) => input.startsWith('$TURBO_ROOT$/')).map((input) => {
    const relative = input.slice('$TURBO_ROOT$/'.length);
    if (relative.includes('..') || /[*?{]/.test(relative)) throw new Error(`${name}: shared test inputs must name specific files`);
    return relative;
  }).sort();
}

/** Catch new fixture consumers before a cached test can use an undeclared shared input. */
export function validateSharedTestInputs(root) {
  function files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? files(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
    });
  }
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const pkg = path.join(root, 'packages', name);
    if (!fs.statSync(pkg).isDirectory()) continue;
    const declared = new Set(sharedTestInputs(root, name));
    for (const input of declared) if (!fs.existsSync(path.join(root, input))) throw new Error(`${name}: missing shared test input ${input}`);
    const sources = [...files(path.join(pkg, 'test')), ...fs.readdirSync(pkg).filter((file) => /^vitest.*\.[cm]?[jt]s$/.test(file)).map((file) => path.join(pkg, file))];
    const visited = new Set();
    while (sources.length) {
      const file = sources.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      for (const { fileName } of ts.preProcessFile(fs.readFileSync(file, 'utf8'), true).importedFiles) {
        if (!fileName.startsWith('.')) continue;
        let target = path.resolve(path.dirname(file), fileName);
        if (!fs.existsSync(target) && target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
        const relative = path.relative(root, target).split(path.sep).join('/');
        if (!(relative.startsWith('scripts/testing/') || relative === 'scripts/lib/hardhat-test-env.mjs')) continue;
        if (!declared.has(relative)) throw new Error(`${name}: undeclared shared test input ${relative}`);
        if (relative.startsWith('scripts/testing/') && !declared.has('scripts/testing/package.json')) throw new Error(`${name}: missing fixture module boundary input`);
        sources.push(target);
      }
    }
  }
}
