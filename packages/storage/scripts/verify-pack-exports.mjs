// Packed-artifact export-surface gate for @origintrail-official/dkg-storage
// (issue #2165) — a THIN RUNNER over data and static fixtures.
//
// The contract lives in the GATE data block below and in two static fixture
// files (scripts/pack-gate/probe-fixture.mjs, scripts/pack-gate/type-fixture
// .ts); this script only packs, extracts, links, copies, and runs. Properties:
//
//   EXACTNESS   — the packed exports map's keys equal the intended allowlist,
//                 so an undocumented subpath cannot appear without failing.
//   RESOLUTION  — allowlisted entries resolve; sampled deep imports refuse.
//   RUNTIME     — the packed barrel/internal entries are IMPORTED as a
//                 consumer; authority leak detection is by VALUE IDENTITY, so
//                 an aliased re-export leaks under any name.
//   TYPES       — the static consumer fixture compiles against the packed
//                 d.ts (see the fixture for its two-way self-discrimination).
//   MUTANTS     — map deleted; mint re-exported same-name; non-mint authority
//                 symbol re-exported; mint re-exported ALIASED; mint on the
//                 d.ts. Each must fail through the same path the real run
//                 uses, each with a restore check.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
const fixtureDir = join(packageDir, 'scripts', 'pack-gate');

// ---------------------------------------------------------------------------
// THE CONTRACT, as data.
const GATE = Object.freeze({
  pkg: '@origintrail-official/dkg-storage',
  internalEntry: '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1',
  ownershipMint: 'createManagedOxigraphOwnershipControllerV1',
  publicError: 'ManagedOxigraphBackendUnownedError',
  /** The packed exports map must carry EXACTLY these keys. */
  exportsAllowlist: ['.', './internal/managed-oxigraph-ownership-v1', './package.json'],
  resolutionExpectations: [
    ['@origintrail-official/dkg-storage', true],
    ['@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1', true],
    // The manifest is a STABLE metadata subpath, per ecosystem convention.
    ['@origintrail-official/dkg-storage/package.json', true],
    ['@origintrail-official/dkg-storage/dist/internal/managed-oxigraph-ownership-v1.js', false],
    ['@origintrail-official/dkg-storage/dist/store-priority-scheduler.js', false],
    ['@origintrail-official/dkg-storage/dist/index.js', false],
  ],
});
// ---------------------------------------------------------------------------

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

function linkRuntimeDeps(scratch, pkgdir) {
  // The packed manifest is the single source of truth for what a consumer
  // install would bring: link exactly its dependencies, never a hand list.
  const deps = Object.keys(
    JSON.parse(readFileSync(join(pkgdir, 'package.json'), 'utf8')).dependencies ?? {},
  );
  for (const name of deps) {
    const linkPath = join(scratch, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(linkPath), { recursive: true });
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

function stageFixtures(scratch) {
  copyFileSync(join(fixtureDir, 'probe-fixture.mjs'), join(scratch, 'probe.mjs'));
  copyFileSync(join(fixtureDir, 'type-fixture.ts'), join(scratch, 'fixture.ts'));
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

const barrelValueExports = JSON.parse(
  readFileSync(join(fixtureDir, 'barrel-value-exports.json'), 'utf8'),
);
const internalEntryExports = JSON.parse(
  readFileSync(join(fixtureDir, 'internal-entry-exports.json'), 'utf8'),
);

function runProbe(scratch) {
  return run(process.execPath, [join(scratch, 'probe.mjs')], {
    cwd: scratch,
    env: {
      ...process.env,
      PACK_GATE_CONFIG: JSON.stringify({ ...GATE, barrelValueExports, internalEntryExports }),
    },
  });
}

function runTypeFixture(scratch) {
  const tscJs = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  return run(process.execPath, [tscJs, '-p', scratch], { cwd: scratch });
}

/** Append a line to a packed dist file, run a phase, restore, check both. */
function withBarrelMutant(pkgdir, scratch, file, appended, label, phase) {
  const path = join(pkgdir, 'dist', file);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, `${original}\n${appended}\n`);
  check(phase(scratch).status !== 0, `mutant: ${label}`);
  writeFileSync(path, original);
  check(phase(scratch).status === 0, `mutant restore: ${label}`);
}

const { scratch, pkgdir } = packAndExtractPackage();
try {
  linkRuntimeDeps(scratch, pkgdir);
  stageFixtures(scratch);

  const packedExports = Object.keys(
    JSON.parse(readFileSync(join(pkgdir, 'package.json'), 'utf8')).exports ?? {},
  ).sort();
  check(
    JSON.stringify(packedExports) === JSON.stringify([...GATE.exportsAllowlist].sort()),
    `exactness: packed exports map carries exactly the allowlist (got: ${packedExports.join(', ')})`,
  );

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
    `types: consumer fixture compiles against the packed d.ts${
      fixture.status === 0 ? '' : `\n${fixture.stdout}`
    }`,
  );

  // Mutant: exports map deleted → resolution fails.
  const pkgJsonPath = join(pkgdir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  const mutated = JSON.parse(originalPkgJson);
  delete mutated.exports;
  writeFileSync(pkgJsonPath, JSON.stringify(mutated));
  check(runProbe(scratch).status !== 0, 'mutant: without the exports map, the gate fails');
  writeFileSync(pkgJsonPath, originalPkgJson);
  check(runProbe(scratch).status === 0, 'mutant restore: exports map');

  const authorityJs = './internal/managed-oxigraph-ownership-v1.js';
  withBarrelMutant(
    pkgdir, scratch, 'index.js',
    `export { ${GATE.ownershipMint} } from '${authorityJs}';`,
    'mint re-exported same-name fails the runtime probe', runProbe,
  );
  withBarrelMutant(
    pkgdir, scratch, 'index.js',
    `export { attachManagedOxigraphLeaseV1 } from '${authorityJs}';`,
    'non-mint authority symbol fails the runtime probe', runProbe,
  );
  withBarrelMutant(
    pkgdir, scratch, 'index.js',
    `export { ${GATE.ownershipMint} as createStorageOwner } from '${authorityJs}';`,
    'ALIASED mint re-export fails the runtime probe (identity, not name)', runProbe,
  );
  withBarrelMutant(
    pkgdir, scratch, 'index.js',
    `import { ${GATE.ownershipMint} as packGateWrapped } from '${authorityJs}';
export const createStorageOwner = (...args) => packGateWrapped(...args);`,
    'WRAPPER around the mint under a fresh name fails the surface snapshot', runProbe,
  );
  // A new implementation export on the internal entry is a PUBLISHED surface
  // change and must fail until the snapshot is deliberately updated.
  withBarrelMutant(
    pkgdir, scratch, 'internal/managed-oxigraph-ownership-v1.js',
    'export const packGateAccidentalHelper = () => undefined;',
    'accidental new internal-entry export fails the internal snapshot', runProbe,
  );
  withBarrelMutant(
    pkgdir, scratch, 'index.d.ts',
    `export { ${GATE.ownershipMint} } from '${authorityJs}';`,
    'mint on the barrel d.ts fails the type fixture', runTypeFixture,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

if (failures.length > 0) {
  console.error(`\npackage-exports gate: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\npackage-exports gate: all properties held, all mutants killed');
