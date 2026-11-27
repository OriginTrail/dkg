import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registryDist, preparedRelease } from '../package-certification/publish.mjs';
import { fixture, releaseGitFixture, fakeDistTags } from './package-certification-fixture.mjs';

function npmShim(t, f, response) {
  const directory = path.join(f.root, 'bin');
  fs.mkdirSync(directory);
  const script = path.join(directory, 'npm-shim.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(directory, 'response.json'))}, 'utf8'));
if (process.argv[2] !== 'view') throw new Error('unexpected npm mutation');
const result = response[process.argv[3]] ?? response.default;
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status;
`);
  fs.writeFileSync(path.join(directory, 'response.json'), JSON.stringify(response));
  // registryDist spawns the normal npm executable. Only that executable is
  // substituted; its result parsing and the default release preflight run intact.
  fs.writeFileSync(path.join(directory, 'npm'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
}

const cases = [
  ['valid integrity', 'present'],
  ['E404 absent version', 'absent', { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) }],
  ['E401 authentication failure', 'error', { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }) }],
  ['network failure', 'error', { status: 1, stdout: JSON.stringify({ error: { code: 'ECONNRESET' } }) }],
  ['malformed failure JSON', 'error', { status: 1, stdout: 'not JSON' }],
  ['malformed successful JSON', 'error', { status: 0, stdout: 'not JSON' }],
  ['missing integrity', 'error', { status: 0, stdout: JSON.stringify({ tarball: 'https://example.invalid/package.tgz' }) }],
];
for (const mode of ['publish', 'promote']) for (const [name, kind, result] of cases) {
  test(`${mode} default registry acquisition handles ${name} before mutation`, async t => {
    const f = fixture(t);
    npmShim(t, f, result ? { default: result } : Object.fromEntries(f.manifest.packages.map(pkg => [
      `${pkg.name}@${pkg.version}`, { status: 0, stdout: JSON.stringify({ integrity: pkg.integrity }) },
    ])));
    const pkg = f.manifest.packages[0];
    if (kind === 'present') assert.equal(registryDist(pkg).integrity, pkg.integrity);
    else if (kind === 'absent') assert.equal(registryDist(pkg), null);
    else assert.throws(() => registryDist(pkg));
    let mutations = 0;
    const options = { mode, bundle: f.bundle, receiptFile: f.receiptFile, expected: f.expected,
      tags: ['canary'], ...releaseGitFixture(f.expected), evidenceFile: 'fixture-decision.json', prepareEvidence: () => ({ recheckLocalIntegrity: () => {} }), ...fakeDistTags({ write: () => { mutations++; } }),
      askOtp: null, settle: 0, log: () => {},
    };
    if (kind === 'error' || (kind === 'absent' && mode === 'promote')) {
      await assert.rejects(preparedRelease(options));
      assert.equal(mutations, 0);
    } else {
      const progress = await preparedRelease(options);
      assert.equal(mutations, kind === 'present' && mode === 'publish' ? 0 : f.manifest.packages.length);
      if (kind === 'present' && mode === 'publish') assert.equal(progress.reused.length, f.manifest.packages.length);
    }
  });
}
