import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { INSTALL_ROOT_PACKAGE, findLibp2pPinViolations, lockfileFamilyVersions } from '../libp2p-pins.mjs';

const lock = `lockfileVersion: '9.0'
packages:
  '@libp2p/utils@7.4.5':
    resolution: {integrity: sha512-a}
  libp2p@3.5.1:
    resolution: {integrity: sha512-b}
  retimeable-signal@1.0.1:
    resolution: {integrity: sha512-c}
  semver@7.7.4:
    resolution: {integrity: sha512-d}
`;
const cli = (dependencies) => ({ name: INSTALL_ROOT_PACKAGE, dependencies });
const pinned = { '@libp2p/utils': '7.4.5', libp2p: '3.5.1', 'retimeable-signal': '1.0.1' };

test('reads the libp2p family from the lockfile and ignores other packages', () => {
  assert.deepEqual(
    [...lockfileFamilyVersions(lock)].map(([name, versions]) => [name, [...versions]]),
    [['@libp2p/utils', ['7.4.5']], ['libp2p', ['3.5.1']], ['retimeable-signal', ['1.0.1']]],
  );
  assert.equal(lockfileFamilyVersions('lockfileVersion: 9.0\n').size, 0);
});

test('accepts exact pins that match the lockfile on the install root and the importing packages', () => {
  const lockVersions = lockfileFamilyVersions(lock);
  const core = { name: '@origintrail-official/dkg-core', dependencies: { libp2p: '3.5.1', semver: '^7.7.4' } };
  assert.deepEqual(findLibp2pPinViolations({ manifests: [cli(pinned), core], lockVersions }), []);
});

test('rejects ranges, versions the lockfile lacks, and two versions of one package', () => {
  const lockVersions = lockfileFamilyVersions(`${lock}  libp2p@3.3.1:\n    resolution: {integrity: sha512-e}\n`);
  const core = {
    name: '@origintrail-official/dkg-core',
    dependencies: { libp2p: '^3.5.1' },
    optionalDependencies: { '@libp2p/utils': '7.4.4' },
  };
  assert.deepEqual(findLibp2pPinViolations({ manifests: [cli(pinned), core], lockVersions }), [
    'pnpm-lock.yaml has libp2p at 3.3.1, 3.5.1: an npm install would mix versions; keep one',
    '@origintrail-official/dkg-core dependencies: libp2p is "^3.5.1"; use the exact version from pnpm-lock.yaml (3.5.1, 3.3.1)',
    '@origintrail-official/dkg-core optionalDependencies: @libp2p/utils is 7.4.4 but pnpm-lock.yaml has 7.4.5',
  ]);
});

test('requires the install root to pin every family package in the lockfile', () => {
  const lockVersions = lockfileFamilyVersions(lock);
  const { 'retimeable-signal': _, ...rest } = pinned;
  assert.deepEqual(findLibp2pPinViolations({ manifests: [cli(rest)], lockVersions }), [
    `${INSTALL_ROOT_PACKAGE} dependencies: add retimeable-signal 1.0.1; npm installs take the libp2p family's versions from it`,
  ]);
  assert.deepEqual(findLibp2pPinViolations({ manifests: [], lockVersions }), [
    `${INSTALL_ROOT_PACKAGE} is not among the published packages`,
  ]);
  assert.deepEqual(
    findLibp2pPinViolations({ manifests: [{ name: 'x', dependencies: { '@libp2p/gone': '1.0.0' } }, cli(pinned)], lockVersions }),
    ['x dependencies: @libp2p/gone is 1.0.0 but pnpm-lock.yaml has none'],
  );
  assert.deepEqual(
    findLibp2pPinViolations({ manifests: [{ name: 'x', dependencies: { '@libp2p/gone': '^1.0.0' } }, cli(pinned)], lockVersions }),
    ['x dependencies: @libp2p/gone is "^1.0.0"; use the exact version from pnpm-lock.yaml (not locked)'],
  );
});

test('the repository passes its own check', () => {
  const script = new URL('../../check-libp2p-pins.mjs', import.meta.url);
  const output = execFileSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.match(output, /libp2p pins: \d+ family packages pinned exactly/);
});
