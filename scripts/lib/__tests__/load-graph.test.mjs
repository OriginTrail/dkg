// The load graph's scanner and trace (load-graph.mjs): the forms each format
// handler reads, and how a trace carries requirements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { commandFiles } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { dependenciesOf, loadReferences, repositoryContext, traceLaneLoads } from './load-graph.mjs';

test('the load scanner sees these forms, and nothing it cannot resolve statically', () => {
  // The load-closure guard sees only what loadReferences recognises, so its
  // reach is pinned here: each form below resolves to the named file, and the
  // comment mentions (even one shaped like an import) and the run-time path
  // deliberately resolve to nothing.
  const references = loadReferences('packages/node-ui/test/example.test.ts', [
    "import { api } from '../src/ui/api.js';",
    "import type { RequestContext } from '../../cli/src/daemon/routes/context.js';",
    "const cli = await import('../../cli/src/cli.js');",
    "import { resolveOxigraphBinary } from '../../cli/dist/daemon/oxigraph-binary.js';",
    "const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');",
    "const CLI_SRC = resolve(__dirname, '..', '..', 'cli', 'src');",
    "const barrel = resolve(CLI_SRC, 'daemon.ts');",
    'for (const entry of readdirSync(CLI_SRC)) void entry;',
    "const census = ['packages/agent/src/dkg-agent-join.ts'];",
    '// `packages/cli/src/keystore.ts` is only mentioned here.',
    "// import { retired } from '../src/ui/retired.js';",
    "import { contextGraphDataUri } from '@origintrail-official/dkg-core';",
    'const late = readFileSync(`${root}/${name}`);',
    'const plugin = await import(`../../cli/src/${name}.js`);',
  ].join('\n'));
  assert.deepEqual(references.modules.sort(), [
    'packages/cli/src/cli.ts',
    'packages/cli/src/daemon/oxigraph-binary.ts',
    'packages/node-ui/src/ui/api.ts',
  ]);
  assert.deepEqual(references.paths.sort(), [
    'packages/agent/src/dkg-agent-join.ts',
    'packages/cli/src',
    'packages/cli/src/daemon.ts',
    'packages/node-ui/README.md',
  ]);
  assert.deepEqual(references.packages, ['@origintrail-official/dkg-core']);
  // A repository script named inside a string (a test's embedded shell) counts
  // as read; one named only in a comment does not.
  const shell = loadReferences('packages/cli/test/example.test.ts', [
    '// Runs scripts/devnet-comprehensive.sh by hand.',
    'const script = `tr -d "\\r" < scripts/devnet-publish-helpers.sh > "$DIR/helpers.sh"`;',
  ].join('\n'));
  assert.deepEqual(shell.paths, ['scripts/devnet-publish-helpers.sh']);
  // One command resolver (commandFiles) reads workflow commands, package
  // scripts, shell scripts and test strings: paths of any extension or none,
  // behind a variable, a flag or JSON punctuation, a script's own directory
  // however it is spelled, and a scripts/ path under another root. `exists`
  // decides which exist.
  const present = new Set([
    'scripts/generate-fixture.py', 'scripts/devnet.sh', 'scripts/tool', 'scripts/nested/run.mts', 'scripts/lib.sh',
    'packages/cli/test/fixtures/helper.sh',
  ]);
  const resolve = (text, options = {}) => commandFiles(text, { exists: (file) => present.has(file), ...options });
  assert.deepEqual(
    resolve('python scripts/generate-fixture.py; "$repo_root/scripts/devnet.sh"; ./scripts/tool --x; scripts/nested/run.mts, myscripts/other.sh'),
    ['scripts/generate-fixture.py', 'scripts/devnet.sh', 'scripts/tool', 'scripts/nested/run.mts'],
  );
  for (const text of [
    'source "$(dirname "$0")/lib.sh"',
    '. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"',
    'source "${BASH_SOURCE%/*}/lib.sh"',
    'source "${SCRIPT_DIR}/lib.sh"',
  ]) {
    assert.deepEqual(resolve(text, { scriptDirectory: 'scripts' }), ['scripts/lib.sh'], text);
  }
  assert.deepEqual(resolve('bash ./helper.sh', { scriptDirectory: 'packages/cli/test/fixtures' }), ['packages/cli/test/fixtures/helper.sh']);
  assert.deepEqual(resolve('Run scripts/devnet.sh, or scripts/lib.sh).'), ['scripts/devnet.sh', 'scripts/lib.sh']);
  assert.deepEqual(resolve('{"run":"scripts/devnet.sh","env":["LIB=scripts/lib.sh"]}'), ['scripts/devnet.sh', 'scripts/lib.sh']);
  assert.deepEqual(resolve("import '../../../scripts/devnet.sh'; node candidate/scripts/lib.sh; cd path/to/dkg && bash scripts/tool"), [
    'scripts/devnet.sh', 'scripts/lib.sh', 'scripts/tool',
  ]);
  assert.deepEqual(resolve('ls /tmp/x.sh; cat myscripts/devnet.sh; echo "$HOME/$name.sh"'), []);
  const fixture = traceLaneLoads(new Map([['packages/cli/test/example.test.ts', new Map([['bura_cli', 'seed']])]]), {
    read: (file) => ({
      'packages/cli/test/example.test.ts': "spawnSync('bash', ['packages/cli/test/fixtures/devnet-blazegraph-smoke.sh']);",
      'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh': [
        '# scripts/devnet-comprehensive.sh is only mentioned here',
        'source "$repo_root/scripts/devnet.sh"',
      ].join('\n'),
    })[file],
  }).loaded;
  assert.equal(fixture.get('scripts/devnet.sh')?.get('bura_cli'), 'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh');
  assert.equal(fixture.has('scripts/devnet-comprehensive.sh'), false);
  // dependenciesOf reads each format with its own handler. A format without
  // one names nothing: a path in a TOML file, a Python file or an
  // extensionless note is no dependency, while an extensionless file with a
  // shell shebang is read as shell.
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/devnet.toml', 'run = "scripts/devnet.sh"'), {
    format: undefined, modules: [], paths: [], runs: [], packages: [], computed: [], assembled: [], unresolvedReads: [],
  });
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/runner.py', 'subprocess.run(["scripts/devnet.sh"])').paths, []);
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/NOTES', 'Start scripts/devnet.sh first.').paths, []);
  const shebang = dependenciesOf('packages/cli/test/fixtures/start-devnet', '#!/usr/bin/env bash\nsource "$repo_root/scripts/devnet.sh"\n');
  assert.deepEqual([shebang.format, shebang.paths], ['shell', ['scripts/devnet.sh']]);
  // A module load computed at run time cannot be followed, so it is reported.
  assert.deepEqual(references.computed, ['`../../cli/src/${name}.js`']);
  // So is a script path assembled at run time; literal segments joined onto
  // a scripts directory name a script, and a template that completes a path
  // before its value mentions one.
  const scripted = loadReferences('packages/cli/test/example.test.ts', [
    "import { join, resolve as resolvePath } from 'node:path';",
    "const bootstrap = join(root, 'scripts', 'devnet.sh');",
    'const helpers = `bash scripts/devnet-publish-helpers.sh ${flags}`;',
    'const byName = `scripts/${name}.sh`;',
    "const joined = join(process.cwd(), 'scripts', helper);",
    "const aliased = resolvePath(root, '../../scripts', helper);",
    "const added = 'scripts/devnet-' + suffix;",
  ].join('\n'));
  assert.deepEqual(scripted.paths, ['scripts/devnet.sh', 'scripts/devnet-publish-helpers.sh']);
  assert.deepEqual(scripted.assembled, [
    '`scripts/${name}.sh`',
    "join(process.cwd(), 'scripts', helper)",
    "resolvePath(root, '../../scripts', helper)",
    "'scripts/devnet-' + suffix",
  ]);
  // Repo-path literals count only in test files, and a directory only when walked.
  const source = loadReferences('packages/node-ui/src/ui/example.ts', "const note = 'packages/agent/src/dkg-agent-join.ts';\nconst dir = resolve(__dirname, '..');");
  assert.deepEqual(source.paths, []);

  // CommonJS, aliased path helpers, import.meta.dirname and URL-derived bases;
  // a fixture workspace's built output stands for its sources.
  const other = loadReferences('packages/kafka-plugin/test/example.test.ts', [
    "import { join, resolve as resolvePath } from 'node:path';",
    "const { helper } = require('../src/index.js');",
    "const entry = require.resolve('../../cli/src/cli.js');",
    "const CLI_ENTRY = resolvePath(__dirname, '..', '..', 'cli', 'dist', 'cli.js');",
    "const FIXTURE = join(resolvePath(__dirname, '..', '..', 'cli', 'test-fixtures', 'sample-kafka-plugin'), 'dist', 'index.js');",
    "const PLUGIN = resolvePath(__dirname, '..', '..', 'cli', 'test-fixtures', 'sample-kafka-plugin', 'dist', 'index.js');",
    "const RULES = resolve(import.meta.dirname, '..', '..', 'rdf-utils', 'package.json');",
    "const ROOT = fileURLToPath(new URL('../../../', import.meta.url));",
    "const BLAZEGRAPH = join(ROOT, 'blazegraph-image.json');",
    "const MANIFEST = join(\n  import.meta.dirname,\n  '..',\n  'package.json',\n);",
  ].join('\n'));
  assert.deepEqual(other.modules, ['packages/kafka-plugin/src/index.ts']);
  assert.deepEqual(other.paths.sort(), [
    'blazegraph-image.json',
    'packages/cli/src/cli.ts',
    'packages/cli/test-fixtures/sample-kafka-plugin/src/index.ts',
    'packages/kafka-plugin/package.json',
    'packages/rdf-utils/package.json',
  ]);
  // A bare side-effect import loads its module, relative or by package name.
  const sideEffects = loadReferences('packages/storage/test/example.test.ts', [
    "import '../src/adapters/oxigraph.js';",
    "import '@origintrail-official/dkg-core';",
  ].join('\n'));
  assert.deepEqual(sideEffects.modules, ['packages/storage/src/adapters/oxigraph.ts']);
  assert.deepEqual(sideEffects.packages, ['@origintrail-official/dkg-core']);
  // Test-runner configs list the files a lane runs, like tests do.
  const config = loadReferences('devnet/_bootstrap/vitest.example.config.ts', "export default { test: { include: ['devnet/_bootstrap/smoke.test.ts'] } };");
  assert.deepEqual(config.paths, ['devnet/_bootstrap/smoke.test.ts']);
});

test('traceLaneLoads carries lanes through module loads, not through reads', () => {
  const sources = new Map([
    ['packages/node-ui/test/example.test.ts', [
      "import { api } from '../src/ui/api.js';",
      "const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');",
      "import { quads } from '@origintrail-official/dkg-rdf-utils';",
    ].join('\n')],
    ['packages/node-ui/src/ui/api.ts', "import { http } from './http.js';"],
    ['packages/node-ui/src/ui/http.ts', ''],
    // A path read is required but never followed.
    ['packages/node-ui/README.md', "import { never } from './src/ui/pca-api.js';"],
  ]);
  const seeds = new Map([['packages/node-ui/test/example.test.ts', new Map([['kosava_node_ui', 'seed']])]]);
  const { loaded: loads } = traceLaneLoads(seeds, { read: (file) => sources.get(file) });
  assert.equal(loads.get('packages/node-ui/src/ui/api.ts')?.get('kosava_node_ui'), 'packages/node-ui/test/example.test.ts');
  assert.equal(loads.get('packages/node-ui/src/ui/http.ts')?.get('kosava_node_ui'), 'packages/node-ui/src/ui/api.ts');
  assert.equal(loads.get('packages/node-ui/README.md')?.get('kosava_node_ui'), 'packages/node-ui/test/example.test.ts');
  assert.equal(loads.has('packages/node-ui/src/ui/pca-api.ts'), false);
  // A package-name import requires the workspace and its dependencies.
  assert.match(loads.get('packages/rdf-utils/src/index.ts')?.get('kosava_node_ui') ?? '', /imports @origintrail-official\/dkg-rdf-utils/);
});

test('traceLaneLoads follows what a file runs, except workspace code the lanes seed', () => {
  // A module a test runs as a child process runs its imports, so they carry
  // the test's lane; a module it only reads runs none of them. Workspace code
  // the lanes seed (workspaceSeeds, from laneExecution) is required for the
  // lane that runs it, like a read, and its imports are traced from its own
  // seeds.
  const example = 'packages/node-ui/test/example.test.ts';
  const sources = new Map([
    [example, [
      "import { spawnSync } from 'node:child_process';",
      "import { join } from 'node:path';",
      "spawnSync(process.execPath, [join(root, 'scripts', 'sync-chain-abis.mjs')]);",
      "const text = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'audit-dial-protocol.mjs'), 'utf8');",
      "spawnSync(process.execPath, [fileURLToPath(new URL('../src/ui/api.ts', import.meta.url))]);",
    ].join('\n')],
    ['scripts/sync-chain-abis.mjs', "import './check-npm-metadata.mjs';"],
    ['scripts/audit-dial-protocol.mjs', "import './audit-create-random.mjs';"],
    ['packages/node-ui/src/ui/api.ts', "import { http } from './http.js';"],
  ]);
  const seeds = new Map([[example, new Map([['kosava_node_ui', 'seed']])]]);
  const trace = (options) => traceLaneLoads(seeds, { read: (file) => sources.get(file), ...options }).loaded;
  const loads = trace();
  assert.equal(loads.get('scripts/check-npm-metadata.mjs')?.get('kosava_node_ui'), 'scripts/sync-chain-abis.mjs');
  assert.equal(loads.get('scripts/audit-dial-protocol.mjs')?.get('kosava_node_ui'), example);
  assert.equal(loads.has('scripts/audit-create-random.mjs'), false);
  assert.equal(loads.get('packages/node-ui/src/ui/http.ts')?.get('kosava_node_ui'), 'packages/node-ui/src/ui/api.ts');
  const seeded = trace({ workspaceSeeds: new Set(['packages/node-ui/src/ui/api.ts']) });
  assert.equal(seeded.get('packages/node-ui/src/ui/api.ts')?.get('kosava_node_ui'), example);
  assert.equal(seeded.has('packages/node-ui/src/ui/http.ts'), false);
  assert.equal(seeded.get('scripts/check-npm-metadata.mjs')?.get('kosava_node_ui'), 'scripts/sync-chain-abis.mjs');
});

test('a module runs what its imported runners name, and reports an operand no reading resolves', () => {
  // Runners are known by their import (an alias, a namespace or a require()
  // binding runs as what it names; a RegExp's exec runs nothing), and every
  // value an operand may take must name a repository file: one no reading
  // resolves - a wrapper's parameter, a computed argument list, a template
  // command - is reported (`assembled`) until the routing test lists it.
  const references = (source) => loadReferences('packages/chain/test/example.test.ts', `import { join } from 'node:path';\n${source}`);
  const tool = 'scripts/sync-chain-abis.mjs';
  const toolPath = "join(root, 'scripts', 'sync-chain-abis.mjs')";
  for (const [source, runs, assembled] of [
    [`import { spawnSync as run } from 'node:child_process';\nrun(process.execPath, [${toolPath}]);`, [tool], []],
    [`import * as cp from 'child_process';\ncp.execFileSync('node', ['--import', 'tsx', ${toolPath}]);`, [tool], []],
    [`const { fork } = require('node:child_process');\nfork(${toolPath});`, [tool], []],
    [`import { spawn } from 'node:child_process';\nconst script = fast ? ${toolPath} : ${toolPath};\nspawn(process.execPath, [script]);`, [tool], []],
    [`import { spawn } from 'node:child_process';\nconst script = options.script ?? ${toolPath};\nspawn(process.execPath, [script]);`, [tool], ['script']],
    ["import { spawnSync } from 'node:child_process';\nconst run = (file) => spawnSync(process.execPath, [file]);", [], ['file']],
    ["import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, argumentsFor(name));", [], ['argumentsFor(name)']],
    ["import { execSync } from 'node:child_process';\nexecSync(`node ${script}`);", [], ['`node ${script}`']],
    ["import { execSync, spawnSync } from 'node:child_process';\nexecSync(`git clone \"${url}\"`);\nspawnSync('git', ['add', 'package.json']);\nspawnSync(process.execPath, ['-e', code]);", [], []],
    ["import { Worker } from 'node:worker_threads';\nnew Worker(code, { eval: true });\n/x/.exec(name);", [], []],
  ]) {
    const { runs: found, assembled: reported } = references(source);
    assert.deepEqual({ runs: found, assembled: reported }, { runs, assembled }, source);
  }
});

test('a trace reads one repository context, a fixture workspace and its package scripts included', () => {
  // Sources, files, workspaces and the root manifest all come from the
  // context: a fixture shell script running a fixture workspace's package
  // script reaches the repository script that package script runs, and its
  // import, with no checkout file involved. Given only `read`, the rest is
  // the checkout's, which has none of them.
  const files = new Map([
    ['fixture/run.sh', 'pnpm --filter fixture-a run build\n'],
    ['fixture/a/package.json', JSON.stringify({ name: 'fixture-a', scripts: { build: 'node ../../scripts/fixture-build.mjs' } })],
    ['scripts/fixture-build.mjs', "import './fixture-helper.mjs';\n"],
    ['scripts/fixture-helper.mjs', ''],
  ]);
  const context = repositoryContext({
    read: (file) => files.get(file),
    isFile: (file) => files.has(file),
    isDirectory: () => false,
    workspaces: {
      manifests: new Map([['fixture/a', JSON.parse(files.get('fixture/a/package.json'))]]),
      workspaceByName: new Map([['fixture-a', 'fixture/a']]),
    },
    rootManifest: {},
  });
  const seeds = new Map([['fixture/run.sh', new Map([['bura_cli', 'seed']])]]);
  const { loaded } = traceLaneLoads(seeds, { context });
  assert.equal(loaded.get('scripts/fixture-build.mjs')?.get('bura_cli'), 'fixture/run.sh');
  assert.equal(loaded.get('scripts/fixture-helper.mjs')?.get('bura_cli'), 'scripts/fixture-build.mjs');
  assert.equal(traceLaneLoads(seeds, { read: (file) => files.get(file) }).loaded.has('scripts/fixture-build.mjs'), false);
});

test('a shell script reaches what the package scripts it runs reach', () => {
  // The load graph reads a shell script with the execution graph's analyzer
  // and follows the package scripts it runs with the graph's reader, keeping
  // the repository scripts they reach: devnet.sh's `pnpm run build` runs
  // scripts/build.mjs.
  const devnet = dependenciesOf('scripts/devnet.sh', fs.readFileSync(path.join(REPO_ROOT, 'scripts/devnet.sh'), 'utf8'));
  assert.equal(devnet.format, 'shell');
  assert.ok(devnet.paths.includes('scripts/build.mjs'));
});

test('an unresolved read keeps its identity when the directory expression changes', () => {
  // INSTALL_HOOK_DEPENDENCIES keys a read by the reading file and the literal
  // path it reads, so renaming the directory binding or switching join() for
  // path.join() does not change the dependency.
  const reads = (source) => loadReferences('packages/cli/scripts/example.mjs', source).unresolvedReads;
  const before = reads("import { join } from 'node:path';\nconst entry = readFileSync(join(resolvedPackageDir, 'scripts', 'markitdown-entry.py'));");
  const after = reads("import path from 'node:path';\nconst entry = readFileSync(path.join(packageRoot, 'scripts', 'markitdown-entry.py'));");
  assert.deepEqual(before, ['scripts/markitdown-entry.py']);
  assert.deepEqual(after, before);
  // A directory the pass resolves is a path, not an unresolved read.
  assert.deepEqual(reads("import { join } from 'node:path';\nconst entry = join(import.meta.dirname, 'markitdown-entry.py');"), []);
});
