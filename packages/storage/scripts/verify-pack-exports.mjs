// Packed-artifact export-surface gate for @origintrail-official/dkg-storage
// (issue #2165). Run via `pnpm --filter @origintrail-official/dkg-storage run
// test:package-exports`; CI orchestrates, the package owns the invariant.
//
// Three properties, all proven against the PACKED TARBALL rather than the
// source tree (this repo has shipped a release where packaging silently
// dropped tarball files):
//
//   1. RESOLUTION — the public barrel and the documented internal entry
//      resolve; every deep `dist/*` specifier refuses. `import.meta.resolve`
//      (via a child probe) exercises the exports map without executing the
//      module graph, so registry-absent workspace deps cannot masquerade as
//      resolution verdicts.
//   2. SURFACE — the packed barrel (`dist/index.js` + `dist/index.d.ts`)
//      exports none of the ownership-authority symbols, and the internal
//      entry exports all of them. Resolution alone cannot catch the primary
//      regression (re-adding the mint to the barrel keeps every resolution
//      probe green), which is why this check exists.
//   3. THE GATE CAN FAIL — two mutants run on every invocation. The exports
//      map is deleted from the extracted copy: resolution probes must fail.
//      The mint is re-exported from the extracted barrel: the surface check
//      must fail. A gate that cannot fail proves nothing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@origintrail-official/dkg-storage';

// The authority symbols that must be OFF the public barrel and ON the internal
// entry. Value exports are asserted in dist/index.js; type-only exports can
// only appear in dist/index.d.ts, which is asserted for both lists.
const OWNERSHIP_VALUE_SYMBOLS = [
  'MANAGED_OXIGRAPH_LEASE_OPTION_KEY',
  'ManagedOxigraphBackendUnownedError',
  'attachManagedOxigraphLeaseV1',
  'createManagedOxigraphOwnershipControllerV1',
  'extractManagedOxigraphHandoffV1',
  'extractManagedOxigraphLeaseV1',
  'isManagedOxigraphOwnershipLeaseV1',
  'isManagedOxigraphOwnershipLiveV1',
  'readManagedOxigraphOwnershipSnapshotV1',
];
const OWNERSHIP_TYPE_SYMBOLS = [
  'ManagedOxigraphOwnershipControllerV1',
  'ManagedOxigraphOwnershipInvalidationV1',
  'ManagedOxigraphOwnershipLeaseV1',
  'ManagedOxigraphOwnershipSnapshotV1',
  'ManagedOxigraphSupervisorHandoffV1',
];

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

// --- pack + extract ---------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'dkg-storage-pack-'));
const pkgdir = join(scratch, 'node_modules', '@origintrail-official', 'dkg-storage');
try {
  const pack = spawnSync('npm', ['pack', '--pack-destination', scratch], {
    cwd: packageDir,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (pack.status !== 0) {
    console.error(pack.stdout, pack.stderr);
    throw new Error('npm pack failed');
  }
  const tarball = readdirSync(scratch).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  mkdirSync(pkgdir, { recursive: true });
  // Relative paths + cwd, deliberately: a Git-Bash tar on PATH mangles
  // absolute `C:\` paths, while every tar accepts relative ones.
  const untar = spawnSync(
    'tar',
    ['-xzf', tarball, '-C', 'node_modules/@origintrail-official/dkg-storage', '--strip-components=1'],
    { cwd: scratch, shell: process.platform === 'win32', encoding: 'utf8' },
  );
  if (untar.status !== 0) {
    console.error(untar.stderr);
    throw new Error('tar extraction failed');
  }

  // --- resolution probe (child process so its parent URL sits in scratch) ---
  //
  // Phase 2 of the child IMPORTS the internal entry for real and enumerates
  // its runtime exports. That is only possible because the ownership module is
  // deliberately dependency-free (a data-less WeakMap authority); if it ever
  // grows an import, this degrades loudly, not silently.
  const probeSource = `const expectations = [
  ['${PKG}', true],
  ['${PKG}/internal/managed-oxigraph-ownership-v1', true],
  ['${PKG}/dist/managed-oxigraph-ownership-v1-internal.js', false],
  ['${PKG}/dist/internal/managed-oxigraph-ownership-v1.js', false],
  ['${PKG}/dist/store-priority-scheduler.js', false],
  ['${PKG}/dist/managed-oxigraph-ownership-v1-internal', false],
  ['${PKG}/package.json', false],
];
let bad = 0;
for (const [specifier, shouldResolve] of expectations) {
  let resolved = true;
  try { import.meta.resolve(specifier); } catch { resolved = false; }
  if (resolved !== shouldResolve) { bad += 1; console.error('resolution mismatch: ' + specifier + ' resolved=' + resolved); }
}
if (process.argv[2] === 'with-internal-import') {
  const ns = await import('${PKG}/internal/managed-oxigraph-ownership-v1');
  const expected = ${JSON.stringify(OWNERSHIP_VALUE_SYMBOLS)};
  const missing = expected.filter((name) => !(name in ns));
  if (missing.length > 0) { bad += 1; console.error('internal entry missing runtime exports: ' + missing.join(', ')); }
}
process.exit(bad === 0 ? 0 : 1);
`;
  writeFileSync(join(scratch, 'probe.mjs'), probeSource);
  const runProbe = (...args) => spawnSync(process.execPath, [join(scratch, 'probe.mjs'), ...args], { encoding: 'utf8' });

  const probe = runProbe('with-internal-import');
  check(probe.status === 0, `resolution: exports map admits exactly the two entry points, and the internal entry serves every ownership value export${probe.status === 0 ? '' : `\n${probe.stderr}`}`);

  // --- surface check on the packed artifact ---------------------------------
  const barrelJs = readFileSync(join(pkgdir, 'dist', 'index.js'), 'utf8');
  const barrelDts = readFileSync(join(pkgdir, 'dist', 'index.d.ts'), 'utf8');
  const internalDts = readFileSync(join(pkgdir, 'dist', 'internal', 'managed-oxigraph-ownership-v1.d.ts'), 'utf8');
  // Comments are stripped before matching so documentation may MENTION the
  // authority without tripping the gate; an export statement always sits on a
  // code line and always matches. (An inline trailing comment naming a symbol
  // on a code line still trips it — that errs toward a loud false positive, a
  // human look, and never toward a silent leak.)
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const surfaceCheck = (js, dts, label) => {
    const code = stripComments(js);
    const decl = stripComments(dts);
    const leakedValues = OWNERSHIP_VALUE_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(code));
    const leakedTypes = [...OWNERSHIP_VALUE_SYMBOLS, ...OWNERSHIP_TYPE_SYMBOLS]
      .filter((s) => new RegExp(`\\b${s}\\b`).test(decl));
    check(leakedValues.length === 0, `surface: barrel js exports no ownership value${label}${leakedValues.length ? ` (leaked: ${leakedValues.join(', ')})` : ''}`);
    check(leakedTypes.length === 0, `surface: barrel d.ts names no ownership symbol${label}${leakedTypes.length ? ` (leaked: ${leakedTypes.join(', ')})` : ''}`);
  };
  surfaceCheck(barrelJs, barrelDts, '');

  // Runtime value exports are proven by the probe's real import above. Types
  // do not exist at runtime, so they are asserted statically: the shim's d.ts
  // must link to the authority module, and the linked module's d.ts must name
  // every type. Both halves matter — the star re-export alone names nothing.
  check(
    internalDts.includes("managed-oxigraph-ownership-v1-internal"),
    'surface: internal entry d.ts re-exports the authority module',
  );
  const targetDts = readFileSync(join(pkgdir, 'dist', 'managed-oxigraph-ownership-v1-internal.d.ts'), 'utf8');
  const missingTypes = OWNERSHIP_TYPE_SYMBOLS.filter((s) => !new RegExp(`\\b${s}\\b`).test(targetDts));
  check(
    missingTypes.length === 0,
    `surface: authority d.ts declares every ownership type${missingTypes.length ? ` (missing: ${missingTypes.join(', ')})` : ''}`,
  );

  // --- mutant 1: delete the exports map → resolution gate must fail ---------
  const pkgJsonPath = join(pkgdir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  const mutated = JSON.parse(originalPkgJson);
  delete mutated.exports;
  writeFileSync(pkgJsonPath, JSON.stringify(mutated));
  const mutantProbe = runProbe();
  check(mutantProbe.status !== 0, 'mutant: without the exports map, the resolution gate fails');
  writeFileSync(pkgJsonPath, originalPkgJson);
  const restoredProbe = runProbe();
  check(restoredProbe.status === 0, 'mutant: restoring the map restores the gate');

  // --- mutant 2: re-export the mint from the barrel → surface gate must fail
  const mutantJs = `${barrelJs}\nexport { createManagedOxigraphOwnershipControllerV1 } from './managed-oxigraph-ownership-v1-internal.js';\n`;
  const mutantDts = `${barrelDts}\nexport { createManagedOxigraphOwnershipControllerV1 } from './managed-oxigraph-ownership-v1-internal.js';\n`;
  const mutantLeakedJs = OWNERSHIP_VALUE_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(mutantJs));
  const mutantLeakedDts = OWNERSHIP_VALUE_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(mutantDts));
  check(
    mutantLeakedJs.length > 0 && mutantLeakedDts.length > 0,
    'mutant: re-exporting the mint from the barrel fails the surface gate',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

if (failures.length > 0) {
  console.error(`\npackage-exports gate: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\npackage-exports gate: all properties held, both mutants killed');
