// Packed-artifact export-surface gate for @origintrail-official/dkg-storage
// (issue #2165). The phases below prove resolution, public/private surface,
// and two mutation tripwires against the packed tarball rather than sources.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@origintrail-official/dkg-storage';
const INTERNAL_ENTRY = `${PKG}/internal/managed-oxigraph-ownership-v1`;
const OWNERSHIP_MINT = 'createManagedOxigraphOwnershipControllerV1';
const PUBLIC_ERROR = 'ManagedOxigraphBackendUnownedError';
const INTERNAL_EXPORTS_MARKER = 'managed-ownership-exports:';
const RESOLUTION_EXPECTATIONS = Object.freeze([
  [PKG, true],
  [INTERNAL_ENTRY, true],
  [`${PKG}/dist/managed-oxigraph-ownership-v1-internal.js`, false],
  [`${PKG}/dist/internal/managed-oxigraph-ownership-v1.js`, false],
  [`${PKG}/dist/store-priority-scheduler.js`, false],
  [`${PKG}/dist/managed-oxigraph-ownership-v1-internal`, false],
  // The manifest is a STABLE metadata subpath, per ecosystem convention:
  // tooling reads package metadata through Node resolution, and refusing it
  // broke consumers for a reason unrelated to hiding the authority.
  [`${PKG}/package.json`, true],
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
  const pkgdir = join(
    scratch,
    'node_modules',
    '@origintrail-official',
    'dkg-storage',
  );
  const pack = run('npm', ['pack', '--pack-destination', scratch], {
    cwd: packageDir,
  });
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
    [
      '-xzf',
      tarball,
      '-C',
      'node_modules/@origintrail-official/dkg-storage',
      '--strip-components=1',
    ],
    { cwd: scratch },
  );
  if (untar.status !== 0) {
    console.error(untar.stderr);
    throw new Error('tar extraction failed');
  }
  return { scratch, pkgdir };
}

function writeResolutionProbe(scratch) {
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
if (process.argv[2] === 'with-internal-import') {
  const ns = await import('${INTERNAL_ENTRY}');
  console.log('${INTERNAL_EXPORTS_MARKER}' + JSON.stringify(Object.keys(ns).sort()));
}
process.exit(bad === 0 ? 0 : 1);
`;
  writeFileSync(join(scratch, 'probe.mjs'), source);
}

function runResolutionProbe(scratch, ...args) {
  return run(process.execPath, [join(scratch, 'probe.mjs'), ...args]);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

function exportedDeclarationNames(source) {
  const code = stripComments(source);
  const declared = [...code.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|const|enum|function|interface|let|type|var)\s+([A-Za-z_$][\w$]*)/gu,
  )].map((match) => match[1]);
  const listed = [...code.matchAll(/\bexport\s*\{([^}]*)\}/gu)].flatMap(
    (match) => match[1]
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/u).at(-1))
      .filter(Boolean),
  );
  return [...new Set([...declared, ...listed])].sort();
}

function readPackedSurfaces(pkgdir, probe) {
  const markerLine = probe.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(INTERNAL_EXPORTS_MARKER));
  let internalRuntimeExports = [];
  try {
    internalRuntimeExports = JSON.parse(
      markerLine?.slice(INTERNAL_EXPORTS_MARKER.length) ?? '[]',
    );
  } catch {
    // The explicit checks below report both the probe and surface failures.
  }

  const internalDts = readFileSync(
    join(pkgdir, 'dist', 'internal', 'managed-oxigraph-ownership-v1.d.ts'),
    'utf8',
  );
  return {
    barrelJs: readFileSync(join(pkgdir, 'dist', 'index.js'), 'utf8'),
    barrelDts: readFileSync(join(pkgdir, 'dist', 'index.d.ts'), 'utf8'),
    internalRuntimeExports,
    internalDeclarationExports: exportedDeclarationNames(internalDts),
  };
}

function assertInternalSurface(surface) {
  check(
    surface.internalRuntimeExports.includes(OWNERSHIP_MINT),
    'surface: internal runtime entry exposes the ownership-controller mint',
  );
  check(
    surface.internalDeclarationExports.includes(OWNERSHIP_MINT) &&
      surface.internalRuntimeExports.every((name) =>
        surface.internalDeclarationExports.includes(name)),
    'surface: internal declarations cover every runtime export',
  );
}

function inspectBarrelPolicy(js, dts, label, report = check) {
  const code = stripComments(js);
  const declarations = stripComments(dts);
  const internalOnlyValues = [OWNERSHIP_MINT];
  const leakedValues = internalOnlyValues.filter((symbol) =>
    new RegExp(`\\b${symbol}\\b`, 'u').test(code));
  const leakedDeclarations = internalOnlyValues.filter((symbol) =>
    new RegExp(`\\b${symbol}\\b`, 'u').test(declarations));
  const linksAuthorityModule = [code, declarations].some((source) =>
    /managed-oxigraph-ownership-v1(?:-internal)?/u.test(source));
  const publishesError = [code, declarations].every((source) =>
    new RegExp(`\\b${PUBLIC_ERROR}\\b`, 'u').test(source));

  report(
    leakedValues.length === 0,
    `surface: barrel js exports no ownership mint${label}`,
  );
  report(
    leakedDeclarations.length === 0,
    `surface: barrel d.ts names no ownership mint${label}`,
  );
  report(
    !linksAuthorityModule,
    `surface: barrel does not re-export the ownership module${label}`,
  );
  report(
    publishesError,
    `surface: barrel preserves the public unowned-backend error${label}`,
  );
  return leakedValues.length === 0 &&
    leakedDeclarations.length === 0 &&
    !linksAuthorityModule &&
    publishesError;
}

function runMutants({ scratch, pkgdir, surface }) {
  const pkgJsonPath = join(pkgdir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  const withoutExports = JSON.parse(originalPkgJson);
  delete withoutExports.exports;
  writeFileSync(pkgJsonPath, JSON.stringify(withoutExports));
  check(
    runResolutionProbe(scratch).status !== 0,
    'mutant: without the exports map, the resolution gate fails',
  );
  writeFileSync(pkgJsonPath, originalPkgJson);
  check(
    runResolutionProbe(scratch).status === 0,
    'mutant: restoring the map restores the gate',
  );

  const mutantExport =
    `export { ${OWNERSHIP_MINT} } from './internal/managed-oxigraph-ownership-v1.js';`;
  const mutantFailures = [];
  const mutantClean = inspectBarrelPolicy(
    `${surface.barrelJs}\n${mutantExport}\n`,
    `${surface.barrelDts}\n${mutantExport}\n`,
    ' in the mint mutant',
    (ok, label) => {
      if (!ok) mutantFailures.push(label);
    },
  );
  check(
    !mutantClean && mutantFailures.length === 3,
    'mutant: re-exporting the mint fails every applicable authority check',
  );
}

function main() {
  const packed = packAndExtractPackage();
  try {
    writeResolutionProbe(packed.scratch);
    const probe = runResolutionProbe(packed.scratch, 'with-internal-import');
    check(
      probe.status === 0,
      `resolution: exports map admits only the public and internal entries${
        probe.status === 0 ? '' : `\n${probe.stderr}`
      }`,
    );
    const surface = readPackedSurfaces(packed.pkgdir, probe);
    assertInternalSurface(surface);
    inspectBarrelPolicy(surface.barrelJs, surface.barrelDts, '');
    runMutants({ ...packed, surface });
  } finally {
    rmSync(packed.scratch, { recursive: true, force: true, maxRetries: 5 });
  }

  if (failures.length > 0) {
    console.error(`\npackage-exports gate: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\npackage-exports gate: all properties held, both mutants killed');
}

main();
