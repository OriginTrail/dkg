// Packed-artifact export-surface gate for @origintrail-official/dkg-storage
// (issue #2165), phase-structured, using the PLATFORM as the abstraction:
// the packed tarball is imported as a real consumer would import it, and the
// type surface is proven by compiling a consumer fixture — no regex parsing
// of emitted JS or d.ts.
//
//   1. RESOLUTION  — import.meta.resolve over a data-driven expectation set:
//                    the public barrel, the documented internal entry and the
//                    manifest resolve; every dist/* deep import refuses.
//   2. RUNTIME     — the packed barrel and internal entry are IMPORTED (with
//                    workspace deps linked into the scratch install) and
//                    namespace membership is asserted: the public error is a
//                    real export, the mint is absent from the barrel and
//                    present on the internal entry. An aliased re-export that
//                    merely mentions a name in text cannot fool this.
//   3. TYPES       — a consumer fixture compiles under NodeNext against the
//                    packed d.ts: allowed imports plain, the forbidden mint
//                    import under @ts-expect-error, so the fixture fails
//                    EITHER way the surface regresses (missing allowed export
//                    = error; mint back on the barrel = unused directive).
//   4. MUTANTS     — the gate must be able to fail: with the exports map
//                    deleted, resolution must fail; with the mint re-exported
//                    from the extracted barrel, the runtime probe must fail
//                    through the same namespace assertion the real run uses.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');
const PKG = '@origintrail-official/dkg-storage';
const INTERNAL_ENTRY = `${PKG}/internal/managed-oxigraph-ownership-v1`;
const OWNERSHIP_MINT = 'createManagedOxigraphOwnershipControllerV1';
const PUBLIC_ERROR = 'ManagedOxigraphBackendUnownedError';
const RESOLUTION_EXPECTATIONS = Object.freeze([
  [PKG, true],
  [INTERNAL_ENTRY, true],
  // The manifest is a STABLE metadata subpath, per ecosystem convention:
  // tooling reads package metadata through Node resolution, and refusing it
  // broke consumers for a reason unrelated to hiding the authority.
  [`${PKG}/package.json`, true],
  [`${PKG}/dist/internal/managed-oxigraph-ownership-v1.js`, false],
  [`${PKG}/dist/store-priority-scheduler.js`, false],
  [`${PKG}/dist/index.js`, false],
]);

const failures = [];
function check(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    shell: process.platform === 'win32',
    encoding: 'utf8',
    ...options,
  });
}

function packAndExtractPackage() {
  const scratch = mkdtempSync(join(tmpdir(), 'dkg-storage-pack-'));
  const pkgdir = join(scratch, 'node_modules', '@origintrail-official', 'dkg-storage');
  const pack = run('npm', ['pack', '--pack-destination', scratch], { cwd: packageDir });
  if (pack.status !== 0) {
    console.error(pack.stdout, pack.stderr);
    throw new Error('npm pack failed');
  }
  const tarball = readdirSync(scratch).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  mkdirSync(pkgdir, { recursive: true });
  // Relative paths plus cwd avoid Git-Bash mangling absolute Windows paths.
  const untar = run(
    'tar',
    ['-xzf', tarball, '-C', 'node_modules/@origintrail-official/dkg-storage', '--strip-components=1'],
    { cwd: scratch },
  );
  if (untar.status !== 0) {
    console.error(untar.stderr);
    throw new Error('tar extraction failed');
  }
  return { scratch, pkgdir };
}

// Link the packed package's dependencies into the scratch install so the
// barrel can be imported the way a consumer imports it. Node resolves
// through realpaths, so each linked workspace package keeps resolving its own
// dependencies from the repository root.
function linkRuntimeDeps(scratch, pkgdir) {
  // The packed manifest is the single source of truth for what a consumer
  // install would bring: link exactly its dependencies, never a hand list.
  const deps = Object.keys(
    JSON.parse(readFileSync(join(pkgdir, 'package.json'), 'utf8')).dependencies ?? {},
  );
  const links = deps.map((name) => [
    name,
    join(scratch, 'node_modules', ...name.split('/')),
  ]);
  for (const [name, linkPath] of links) {
    mkdirSync(dirname(linkPath), { recursive: true });
    // pnpm links a package's deps under the DEPENDENT's node_modules, so the
    // storage package's own tree is the authoritative place to find them;
    // the repo root is the fallback for hoisted installs.
    const candidates = [
      join(packageDir, 'node_modules', ...name.split('/')),
      join(repoRoot, 'node_modules', ...name.split('/')),
    ];
    const found = candidates.find((candidate) => {
      try { realpathSync(candidate); return true; } catch { return false; }
    });
    if (!found) throw new Error(`cannot locate dependency ${name} for the packed-import probe`);
    symlinkSync(realpathSync(found), linkPath, 'junction');
  }
}

function writeProbe(scratch) {
  const source = `const expectations = ${JSON.stringify(RESOLUTION_EXPECTATIONS)};
let bad = 0;
for (const [specifier, shouldResolve] of expectations) {
  let resolved = true;
  try { import.meta.resolve(specifier); } catch { resolved = false; }
  if (resolved !== shouldResolve) {
    bad += 1;
    console.error('resolution mismatch: ' + specifier + ' resolved=' + resolved);
  }
}
const barrel = await import('${PKG}');
const internal = await import('${INTERNAL_ENTRY}');
// The forbidden set is DERIVED: every runtime export of the authority entry
// is internal-only, so none of them may appear on the barrel. Adding an
// authority export automatically extends the gate.
const leaked = Object.keys(internal)
  .filter((name) => name !== 'default' && name in barrel);
const verdicts = [
  [typeof barrel['${PUBLIC_ERROR}'] === 'function', 'barrel exports the public unowned-backend error'],
  [leaked.length === 0, 'barrel exports no authority symbol (leaked: ' + leaked.join(',') + ')'],
  [typeof internal['${OWNERSHIP_MINT}'] === 'function', 'internal entry exports the ownership mint'],
  [!('${PUBLIC_ERROR}' in internal),
    'the public error is not doubled through the authority entry'],
];
for (const [ok, label] of verdicts) {
  if (!ok) { bad += 1; console.error('runtime surface: ' + label + ' — FAILED'); }
}
process.exit(bad === 0 ? 0 : 1);
`;
  writeFileSync(join(scratch, 'probe.mjs'), source);
}

function runProbe(scratch) {
  return run(process.execPath, [join(scratch, 'probe.mjs')], { cwd: scratch });
}

// The TYPE surface, proven by compiling a consumer fixture. Self-
// discriminating in both directions: dropping an allowed export is a compile
// error; the mint returning to the barrel turns the suppression into an
// unused directive (TS2578). NOTE: the directive token must never begin a
// wrapped comment line — tsc would parse that comment as a real directive.
function writeTypeFixture(scratch) {
  writeFileSync(join(scratch, 'fixture.ts'), `import { ${PUBLIC_ERROR} } from '${PKG}';
import type { ManagedOxigraphSupervisorHandoffV1 } from '${INTERNAL_ENTRY}';
// @ts-expect-error — the ownership mint is not on the public barrel
import { ${OWNERSHIP_MINT} } from '${PKG}';
// @ts-expect-error — ownership types are not on the public barrel either
import type { ManagedOxigraphOwnershipLeaseV1 } from '${PKG}';
const witness: [typeof ${PUBLIC_ERROR}, ManagedOxigraphSupervisorHandoffV1 | null] = [${PUBLIC_ERROR}, null];
export default witness;
`);
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['fixture.ts'],
  }));
}

function runTypeFixture(scratch) {
  const tscJs = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  return run(process.execPath, [tscJs, '-p', scratch], { cwd: scratch });
}

const { scratch, pkgdir } = packAndExtractPackage();
try {
  linkRuntimeDeps(scratch, pkgdir);
  writeProbe(scratch);
  writeTypeFixture(scratch);

  const probe = runProbe(scratch);
  check(
    probe.status === 0,
    `resolution+runtime: packed entries resolve, import, and carry the intended surface${
      probe.status === 0 ? '' : `\n${probe.stderr}`
    }`,
  );

  const fixture = runTypeFixture(scratch);
  check(
    fixture.status === 0,
    `types: consumer fixture compiles (error public, handoff type internal, mint absent)${
      fixture.status === 0 ? '' : `\n${fixture.stdout}`
    }`,
  );

  // --- mutant 1: delete the exports map → the probe must fail --------------
  const pkgJsonPath = join(pkgdir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  const mutated = JSON.parse(originalPkgJson);
  delete mutated.exports;
  writeFileSync(pkgJsonPath, JSON.stringify(mutated));
  check(runProbe(scratch).status !== 0, 'mutant: without the exports map, the gate fails');
  writeFileSync(pkgJsonPath, originalPkgJson);
  check(runProbe(scratch).status === 0, 'mutant: restoring the map restores the gate');

  // --- mutant 2: re-export the mint from the extracted barrel → the SAME
  // runtime namespace assertion the real run uses must fail ------------------
  const barrelPath = join(pkgdir, 'dist', 'index.js');
  const originalBarrel = readFileSync(barrelPath, 'utf8');
  writeFileSync(
    barrelPath,
    `${originalBarrel}\nexport { ${OWNERSHIP_MINT} } from './internal/managed-oxigraph-ownership-v1.js';\n`,
  );
  check(runProbe(scratch).status !== 0, 'mutant: re-exporting the mint fails the runtime surface probe');
  writeFileSync(barrelPath, originalBarrel);
  check(runProbe(scratch).status === 0, 'mutant: restoring the barrel restores the gate');

  // A REPRESENTATIVE non-mint authority symbol proves the derived set is what
  // fails the gate, not a special-case on the mint's name.
  writeFileSync(
    barrelPath,
    `${originalBarrel}
export { attachManagedOxigraphLeaseV1 } from './internal/managed-oxigraph-ownership-v1.js';
`,
  );
  check(
    runProbe(scratch).status !== 0,
    'mutant: re-exporting a non-mint authority symbol also fails the probe',
  );
  writeFileSync(barrelPath, originalBarrel);
  check(runProbe(scratch).status === 0, 'mutant: restore after the non-mint mutant');

  // --- mutant 3: re-export the mint from the barrel d.ts → the type fixture
  // must fail (its suppression becomes an unused directive) ------------------
  const barrelDtsPath = join(pkgdir, 'dist', 'index.d.ts');
  const originalBarrelDts = readFileSync(barrelDtsPath, 'utf8');
  writeFileSync(
    barrelDtsPath,
    `${originalBarrelDts}\nexport { ${OWNERSHIP_MINT} } from './internal/managed-oxigraph-ownership-v1.js';\n`,
  );
  check(runTypeFixture(scratch).status !== 0, 'mutant: mint on the barrel d.ts fails the type fixture');
  writeFileSync(barrelDtsPath, originalBarrelDts);
  check(runTypeFixture(scratch).status === 0, 'mutant: restoring the d.ts restores the type fixture');
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

if (failures.length > 0) {
  console.error(`\npackage-exports gate: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\npackage-exports gate: all properties held, all mutants killed');
