// Consumer-style check of the deep `dist/*` module paths this package has shipped.
//
// `@origintrail-official/dkg-node-ui` has no `exports` map, so every file under
// `dist/` is importable by path and downstream code does import them. Three of
// those modules (`chain-event-log-store`, `chain-cursor-stores`,
// `protocol-outbox-store`) moved to `@origintrail-official/dkg-node-store`; the
// files that remain at the old paths are thin compatibility forwards. This
// resolves them exactly as a consumer would (package specifier, through a
// `node_modules` link to the package root) for both runtime values and types,
// and fails the build if a path stops resolving or stops exporting something.
//
// The export lists below are the exports of the former modules at
// 31aff226187c13aec5b4ad05b615a31ef6e42aae (`packages/node-ui/src/<file>.ts`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
const NODE_UI = '@origintrail-official/dkg-node-ui';
const NODE_STORE = '@origintrail-official/dkg-node-store';

const LEGACY_MODULES = [
  {
    path: 'dist/chain-event-log-store.js',
    values: ['SqliteChainEventLogStore'],
    types: [
      'SqliteChainEventLogBlockRange',
      'SqliteChainEventLogCommit',
      'SqliteChainEventLogCountQuery',
      'SqliteChainEventLogCoverage',
      'SqliteChainEventLogCursor',
      'SqliteChainEventLogHead',
      'SqliteChainEventLogQuery',
      'SqliteChainEventLogRow',
      'SqliteChainEventLogState',
    ],
  },
  {
    path: 'dist/chain-cursor-stores.js',
    values: [
      'SqliteChainEventCursorStore',
      'SqliteContextGraphAuthorityHistoryStore',
      'SqliteContextGraphAuthorityIndexStore',
      'SqliteContextGraphRegistryScanCursorStore',
      'SqliteContextGraphStorageDiscoveryStore',
    ],
    types: [],
  },
  {
    path: 'dist/protocol-outbox-store.js',
    values: ['SqliteProtocolOutboxStore'],
    types: ['SqliteProtocolOutboxStoreOptions'],
  },
  {
    // `db.js` has always re-exported the stores that lived next to it.
    path: 'dist/db.js',
    values: [
      'SqliteChainEventCursorStore',
      'SqliteChangelogCursorStore',
      'SqliteChangelogEraGuard',
      'SqliteContextGraphAuthorityHistoryStore',
      'SqliteContextGraphAuthorityIndexStore',
      'SqliteContextGraphRegistryScanCursorStore',
      'SqliteContextGraphStorageDiscoveryStore',
      'SqliteKaNumberStore',
      'SqliteMessageIdempotencyStore',
      'SqliteProtocolOutboxStore',
      'SqliteSyncCheckpointStore',
    ],
    types: ['SqliteProtocolOutboxStoreOptions'],
  },
];

const specifier = (path) => `${NODE_UI}/${path}`;
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

const consumerDir = mkdtempSync(join(tmpdir(), 'dkg-node-ui-package-exports-'));
try {
  // A consumer's node_modules: the published package and its node-store dependency.
  const scope = join(consumerDir, 'node_modules', '@origintrail-official');
  mkdirSync(scope, { recursive: true });
  symlinkSync(packageRoot, join(scope, 'dkg-node-ui'), linkKind);
  symlinkSync(
    dirname(requireFromPackage.resolve(`${NODE_STORE}/package.json`)),
    join(scope, 'dkg-node-store'),
    linkKind,
  );

  // 1. Runtime: each old path resolves, exports exactly its former values, and
  //    each value is the very class node-store exports (not a second copy).
  writeFileSync(join(consumerDir, 'consumer.mjs'), `
import * as nodeStore from '${NODE_STORE}';
const legacy = ${JSON.stringify(LEGACY_MODULES.map(({ path, values }) => ({ path, values })))};
const report = [];
for (const { path, values } of legacy) {
  const mod = await import('${NODE_UI}/' + path);
  report.push({
    path,
    exported: Object.keys(mod).sort(),
    sameAsNodeStore: values.filter((name) => mod[name] === nodeStore[name]),
  });
}
process.stdout.write(JSON.stringify(report));
`);
  const run = spawnSync(process.execPath, ['consumer.mjs'], { cwd: consumerDir, encoding: 'utf8' });
  assert.equal(run.status, 0, `consumer import failed:\n${run.stderr}${run.stdout}`);
  const report = JSON.parse(run.stdout);
  for (const { path, values } of LEGACY_MODULES) {
    const entry = report.find((row) => row.path === path);
    assert.ok(entry, `${specifier(path)} was not loaded`);
    if (path !== 'dist/db.js') {
      assert.deepEqual(entry.exported, [...values].sort(), `${specifier(path)} runtime exports`);
    } else {
      for (const name of values) {
        assert.ok(entry.exported.includes(name), `${specifier(path)} must still export ${name}`);
      }
    }
    assert.deepEqual(
      entry.sameAsNodeStore,
      values,
      `${specifier(path)} must forward node-store's own classes`,
    );
  }

  // 2. Types: each old path resolves to a declaration file that exports every
  //    former type and value, and each is the same type node-store exports.
  const typeImports = LEGACY_MODULES.map(({ path, values, types }, index) => {
    const names = [...values, ...types];
    return `import type { ${names.map((name) => `${name} as Legacy${index}_${name}`).join(', ')} } from '${specifier(path)}';`;
  });
  const typeAssertions = LEGACY_MODULES.flatMap(({ values, types }, index) => [
    ...values.map((name) => `export const same${index}_${name}: Same<typeof Legacy${index}_${name}, typeof NodeStoreValues.${name}> = true;`),
    ...types.map((name) => `export const same${index}_${name}: Same<Legacy${index}_${name}, NodeStoreTypes.${name}> = true;`),
  ]);
  writeFileSync(join(consumerDir, 'consumer.mts'), `
import type * as NodeStoreTypes from '${NODE_STORE}';
import type * as NodeStoreValues from '${NODE_STORE}';
${typeImports.join('\n')}

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
${typeAssertions.join('\n')}
`);
  writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ['consumer.mts'],
  }));
  const tsc = spawnSync(
    process.execPath,
    [requireFromPackage.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.json'],
    { cwd: consumerDir, encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, `consumer type check failed:\n${tsc.stdout}${tsc.stderr}`);

  console.log(`node-ui deep-path compatibility: ${LEGACY_MODULES.length} module paths resolve for runtime and types`);
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}
