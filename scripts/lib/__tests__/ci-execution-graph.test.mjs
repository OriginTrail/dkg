// The CI execution graph (ci-execution-graph.mjs): which workspaces and
// package scripts a command reaches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { analyzeShell, workflowExecution, workspaceCatalog } from './ci-execution-graph.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { edgeRequirement, jobRequirement, laneSeeds } from './lane-entrypoints.mjs';

test('pnpm filter selectors resolve on the injected workspace graph alone', () => {
  // a depends on b, c on a; d stands apart. None of these names exists in the
  // repository, so its manifests cannot take part.
  const manifest = (name, dependencies = {}) => ({ name, dependencies, scripts: { build: 'tsc' } });
  const manifests = new Map([
    ['packages/a', manifest('fixture-a', { 'fixture-b': 'workspace:*' })],
    ['packages/b', manifest('fixture-b')],
    ['packages/c', manifest('fixture-c', { 'fixture-a': 'workspace:*' })],
    ['packages/d', manifest('fixture-d')],
  ]);
  const workspaces = { manifests, workspaceByName: new Map([...manifests].map(([directory, { name }]) => [name, directory])) };
  const built = (selector) => workflowExecution(`jobs:\n  bura-cli:\n    steps:\n      - run: pnpm --filter '${selector}' run build\n`, {
    workspaces,
    rootManifest: {},
  })[0].edges.filter(({ kind }) => kind === 'script').map(({ workspace }) => workspace).sort();
  assert.deepEqual(built('fixture-a...'), ['packages/a', 'packages/b']);
  assert.deepEqual(built('...fixture-b'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('!fixture-d'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('fixture-*'), ['packages/a', 'packages/b', 'packages/c', 'packages/d']);
});

test('a step runs in its working directory, its job default or its workflow default', () => {
  // GitHub runs a step in its working-directory, else the job's defaults.run,
  // else the workflow's; commands and paths resolve from there.
  const job = (step, defaults = '') => [
    'jobs:',
    '  bura-cli:',
    "    if: needs.changes.outputs.bura_cli == 'true'",
    defaults,
    '    steps:',
    `      - ${step}`,
  ].filter(Boolean).join('\n');
  const files = (source) => workflowExecution(source)[0].edges.filter(({ kind }) => kind === 'file').map(({ file }) => file);
  // The CLI's own build script is there only from packages/cli.
  const prerequisites = 'run: node scripts/build-prerequisites.mjs';
  const cli = ['packages/cli/scripts/build-prerequisites.mjs'];
  assert.deepEqual(files(job(`${prerequisites}\n        working-directory: packages/cli`)), cli);
  assert.deepEqual(files(job(prerequisites, '    defaults:\n      run:\n        working-directory: packages/cli')), cli);
  assert.deepEqual(files(`defaults:\n  run:\n    working-directory: packages/cli\n${job(prerequisites)}`), cli);
  assert.deepEqual(files(job(prerequisites)), [], 'the repository root has no scripts/build-prerequisites.mjs');
  const helpers = 'run: node ../../scripts/devnet-publish-helpers.sh';
  assert.deepEqual(files(job(`${helpers}\n        working-directory: packages/cli`)), ['scripts/devnet-publish-helpers.sh']);
  // The file carries the job's lane like any other the job runs.
  const seeds = laneSeeds({ workflows: [['ci.yml', job(`${helpers}\n        working-directory: packages/cli`)]], workspaceCode: false });
  assert.equal(seeds.get('scripts/devnet-publish-helpers.sh')?.has('bura_cli'), true);
  // A directory the graph cannot resolve statically fails instead of guessing.
  assert.throws(() => workflowExecution(job('run: pnpm test\n        working-directory: ${{ matrix.package }}')), /cannot resolve/);

  // The repository's solidity-coverage step runs evm-module's own
  // test:coverage from packages/evm-module, not the root turbo fan-out.
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const coverage = workflowExecution(ci).find(({ job: name }) => name === 'solidity-coverage');
  const scripts = coverage.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`);
  assert.ok(scripts.includes('packages/evm-module test:coverage'));
  assert.equal(scripts.includes('. test:coverage'), false);
  assert.ok(coverage.edges.some(({ kind, file }) => kind === 'file' && file === 'scripts/check-evm-coverage.mjs'));
});

test('one shell reading yields package-script calls, files and assembled paths', () => {
  // analyzeShell is the one reading of shell text: the execution graph reads
  // workflow steps, package scripts and shell scripts with it, and the load
  // graph reads the shell scripts lanes reach with it. Comments name nothing.
  const cli = { name: '@origintrail-official/dkg', scripts: { build: 'tsc' } };
  const context = { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]), rootManifest: {} };
  const present = new Set(['scripts/devnet.sh', 'scripts/devnet-lib.sh', 'scripts/tool.mjs', 'scripts/devnet-config.json']);
  const reading = analyzeShell([
    '# scripts/devnet-comprehensive.sh is only mentioned here',
    'source "$(dirname "$0")/devnet-lib.sh"',
    'pnpm --filter @origintrail-official/dkg run build',
    'bash "$REPO_ROOT/scripts/devnet.sh" start',
    'bash "$SCRIPT_DIR/devnet-${helper}.sh"',
    'node "$SCRIPT_DIR/tool.mjs" --config scripts/devnet-config.json',
  ].join('\n'), { scriptDirectory: 'scripts', exists: (file) => present.has(file), context });
  assert.deepEqual(reading.calls, [['packages/cli', 'build']]);
  assert.deepEqual(reading.files.map(({ file }) => file), ['scripts/devnet-lib.sh', 'scripts/devnet.sh', 'scripts/tool.mjs', 'scripts/devnet-config.json']);
  // What a command runs, as opposed to what it only names.
  assert.deepEqual(reading.runs, ['scripts/devnet-lib.sh', 'scripts/devnet.sh', 'scripts/tool.mjs']);
  assert.deepEqual(reading.assembled, ['$SCRIPT_DIR/devnet-${helper}.sh']);
});

test('a file a command runs is assembled when it is picked at run time', () => {
  // A script runner's operand, or a program path, that still expands a value
  // past its directory names a file no reading can resolve, however the
  // value was set, so the guard must list it. Inline code, stdin, a later
  // argument, a tool in a variable, a case pattern, a URL, regex text and an
  // escaped $ name no such file.
  const context = { manifests: new Map(), workspaceByName: new Map(), rootManifest: {} };
  const assembled = (text) => analyzeShell(text, { scriptDirectory: 'scripts', exists: () => false, context }).assembled;
  for (const [text, expected] of [
    ['helper=devnet-test-invite-flow.sh\nbash "$SCRIPT_DIR/$helper"', ['$SCRIPT_DIR/$helper']],
    ['cd "$REPO_ROOT" && "$SCRIPTS_DIR/$script" --quick', ['$SCRIPTS_DIR/$script']],
    ['if ! env DKG_HOME="$dir" A=1 node "$cli_entry" start; then', ['$cli_entry']],
    ['timeout -s KILL 600 bash -euo pipefail "$1"', ['$1']],
    ['exec nohup python3 -u "${tool}"', ['${tool}']],
    ['source "$lib"', ['$lib']],
    ['pnpm exec tsx "$SCRIPT_DIR/$step"', ['$SCRIPT_DIR/$step']],
    ['npx tsx "$SCRIPT_DIR/$helper"', ['$SCRIPT_DIR/$helper']],
    ['npx -y -p tsx tsx "$entry"', ['$entry']],
    ['npx -y verdaccio@$VERSION --listen 4873', []],
    ['npx -c "$command"', []],
    ['bash "$SCRIPT_DIR/lib.sh" "$RUN_DIR/$name"', []],
    ['node "$REPO_ROOT/scripts/x.mjs"', []],
    ['node -e "$code" "$arg"', []],
    ['node - "$file"', []],
    ['python3 -c "$code"', []],
    ['bash -c "$cmd"', []],
    ['"$tool" --version', []],
    ['*"$DIR/node"*oxigraph*) kill "$pid" ;;', []],
    ['http://127.0.0.1:$PORT/health', []],
    ["  .replace(/^-+|-+$/g, '')", []],
    ['python \\$MD_LOG', []],
  ]) {
    assert.deepEqual(assembled(text), expected, text);
  }
});

test('the graph reads every workspace pnpm-workspace.yaml declares, rule or no rule', () => {
  const files = {
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "tools/unmapped"\n',
    'packages/cli/package.json': JSON.stringify({ name: '@origintrail-official/dkg', scripts: { build: 'tsc' } }),
    'tools/unmapped/package.json': JSON.stringify({ name: '@example/unmapped', scripts: { postinstall: 'node setup.mjs', build: 'tsc' } }),
  };
  const catalog = workspaceCatalog({ readRepoFile: (file) => files[file], listDirectories: (directory) => (directory === 'packages' ? ['cli', 'no-manifest'] : []) });
  assert.deepEqual([...catalog.manifests.keys()], ['packages/cli', 'tools/unmapped']);
  assert.equal(catalog.workspaceByName.get('@example/unmapped'), 'tools/unmapped');
  const [build] = workflowExecution('jobs:\n  build:\n    steps:\n      - run: pnpm install && turbo build\n', { workspaces: catalog, rootManifest: {} });
  assert.deepEqual(build.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`).sort(), [
    'packages/cli build',
    'tools/unmapped build',
    'tools/unmapped postinstall',
  ]);
  // A pattern the catalog cannot expand fails instead of dropping workspaces.
  for (const pattern of ['packages/**', '!packages/private', 'packages/*/nested']) {
    assert.throws(() => workspaceCatalog({ readRepoFile: (file) => (file === 'pnpm-workspace.yaml' ? `packages:\n  - "${pattern}"\n` : undefined) }), /unsupported/, pattern);
  }
  // The repository's catalog covers the fixture and devnet workspaces the
  // routing rules leave out.
  const repository = workspaceCatalog();
  assert.ok(repository.manifests.has('packages/cli/test-fixtures/sample-kafka-plugin'));
  assert.ok(repository.manifests.has('devnet/_bootstrap'));
});

test('each package-manager form a CI job can use reaches the scripts and files it runs', () => {
  // Independent of the repository and of the routing guard: injected
  // manifests and files, and the edges each command form must produce, with
  // the requirement its job gives them. a depends on b; c stands apart.
  const manifests = new Map([
    ['packages/a', {
      name: 'fixture-a',
      dependencies: { 'fixture-b': 'workspace:*' },
      scripts: {
        build: 'node ../../scripts/build-a.mjs',
        'build:ui': 'node ../../scripts/ui-a.mjs',
        prepack: 'node ../../scripts/pack-a.mjs',
        postinstall: 'node ../../scripts/install-a.mjs',
      },
    }],
    ['packages/b', { name: 'fixture-b', scripts: { build: 'node ../../scripts/build-b.mjs && pnpm run build:extra', 'build:extra': 'node ../../scripts/extra-b.mjs' } }],
    ['packages/c', { name: 'fixture-c', scripts: { prebuild: 'node ../../scripts/prebuild-c.mjs', build: 'node ../../scripts/build-c.mjs' } }],
  ]);
  const workspaces = { manifests, workspaceByName: new Map([...manifests].map(([directory, { name }]) => [name, directory])) };
  const rootManifest = { scripts: { 'gate:build': 'pnpm -r --filter fixture-a... run build' } };
  const present = new Set([
    'scripts/build-a.mjs', 'scripts/ui-a.mjs', 'scripts/pack-a.mjs', 'scripts/install-a.mjs', 'scripts/build-b.mjs',
    'scripts/extra-b.mjs', 'scripts/prebuild-c.mjs', 'scripts/build-c.mjs', 'packages/c/test/c.test.ts',
  ]);
  const run = (command, job = 'bura-cli', condition = "needs.changes.outputs.bura_cli == 'true'") => {
    const [graph] = workflowExecution(`jobs:\n  ${job}:\n    if: ${condition}\n    steps:\n      - run: ${command}\n`, {
      readRepoFile: (file) => (present.has(file) ? '' : undefined),
      workspaces,
      rootManifest,
    });
    const required = jobRequirement('ci.yml', job, condition);
    return {
      scripts: graph.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`).sort(),
      files: [...new Set(graph.edges.filter(({ kind }) => kind === 'file').map(({ file, chain }) => `${edgeRequirement(required, chain)} ${file}`))].sort(),
    };
  };
  const lane = (files) => files.map((file) => `bura_cli ${file}`);
  for (const [command, scripts, files] of [
    // A root script running a recursive filtered build: the package and its dependencies.
    ['pnpm run gate:build', ['. gate:build', 'packages/a build', 'packages/b build', 'packages/b build:extra'],
      lane(['scripts/build-a.mjs', 'scripts/build-b.mjs', 'scripts/extra-b.mjs'])],
    ['pnpm -r --filter "!fixture-a" run build', ['packages/b build', 'packages/b build:extra', 'packages/c build', 'packages/c prebuild'],
      lane(['scripts/build-b.mjs', 'scripts/build-c.mjs', 'scripts/extra-b.mjs', 'scripts/prebuild-c.mjs'])],
    ['pnpm --filter fixture-a run build:ui', ['packages/a build:ui'], lane(['scripts/ui-a.mjs'])],
    ['pnpm --dir packages/c run build', ['packages/c build', 'packages/c prebuild'], lane(['scripts/build-c.mjs', 'scripts/prebuild-c.mjs'])],
    ['pnpm -C packages/c build', ['packages/c build', 'packages/c prebuild'], lane(['scripts/build-c.mjs', 'scripts/prebuild-c.mjs'])],
    ['cd packages/c && npm run build', ['packages/c build', 'packages/c prebuild'], lane(['scripts/build-c.mjs', 'scripts/prebuild-c.mjs'])],
    ['turbo run build', ['packages/a build', 'packages/b build', 'packages/b build:extra', 'packages/c build', 'packages/c prebuild'],
      lane(['scripts/build-a.mjs', 'scripts/build-b.mjs', 'scripts/build-c.mjs', 'scripts/extra-b.mjs', 'scripts/prebuild-c.mjs'])],
    ['pnpm --filter fixture-a pack', ['packages/a prepack'], lane(['scripts/pack-a.mjs'])],
    ['pnpm --filter fixture-c exec vitest run test/c.test.ts', [], lane(['packages/c/test/c.test.ts'])],
    // Every job's install runs the install hooks, which need full CI.
    ['pnpm install --frozen-lockfile', ['packages/a postinstall'], ['install scripts/install-a.mjs']],
  ]) {
    assert.deepEqual(run(command), { scripts, files }, command);
  }
  // The build job's workspace builds carry each producer's build output.
  assert.deepEqual(run('pnpm run gate:build', 'build', "needs.changes.outputs.run_node == 'true'").files, [
    'build-output:packages/a scripts/build-a.mjs',
    'build-output:packages/b scripts/build-b.mjs',
    'build-output:packages/b scripts/extra-b.mjs',
  ]);
});
