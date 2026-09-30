// The load graph's scanner and trace (load-graph.mjs): the forms each format
// handler reads, and how a trace carries requirements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { commandFiles } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { dependenciesOf, loadReferences, traceLaneLoads } from './load-graph.mjs';

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
    format: undefined, modules: [], paths: [], packages: [], computed: [], assembled: [], unresolvedReads: [],
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

test('a shell script reaches what the package scripts it runs reach', () => {
  // The load graph reads a shell script with the execution graph's analyzer
  // and follows the package scripts it runs with the graph's reader, keeping
  // the repository scripts they reach: devnet.sh's `pnpm run build` runs
  // scripts/build.mjs.
  const devnet = dependenciesOf('scripts/devnet.sh', fs.readFileSync(path.join(REPO_ROOT, 'scripts/devnet.sh'), 'utf8'));
  assert.equal(devnet.format, 'shell');
  assert.ok(devnet.paths.includes('scripts/build.mjs'));
});
