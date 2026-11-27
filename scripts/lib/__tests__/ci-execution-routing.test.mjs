// The load-closure guard on planted workflows and traces: what CI jobs run,
// what a lane runs as a child process, and paths it assembles or picks at
// run time, each reported unless its route or UNFOLLOWED_LOADS covers it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { change, pullRequestPlan, selectedLanes } from './ci-plan-fixtures.mjs';
import { PROGRAM_CHILD_COMMANDS, workflowExecution } from './ci-execution-graph.mjs';
import { SUBCOMMAND_CHILD_COMMANDS } from '../../release-packages.mjs';
import { jobRequirement, laneExecution, laneSeeds, requirement } from './lane-entrypoints.mjs';
import { fixtureContext, traceLaneLoads } from './load-graph.mjs';
import { loadClosureGaps, plantedWorkflowGaps } from './load-closure.mjs';

test('every repository script a CI job runs selects that job', () => {
  // The repository's workflows are checked by the guard above, which seeds
  // what each job runs from the execution graph. Its failure path: a lane job
  // running a script routed to the build checks alone is reported; a script
  // routed to that lane is not, however its path is spelled; the changes job
  // runs on every pull request.
  const planted = (job, run) => `jobs:\n  ${job}:\n    if: needs.changes.outputs.bura_cli == 'true'\n    steps:\n      - run: ${run}\n`;
  // The trace follows the script's own imports too.
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'node scripts/audit-dial-protocol.mjs')).missing, [
    'bura_cli loads scripts/audit-dial-protocol.mjs via ci.yml bura-cli',
    'bura_cli loads scripts/audit-create-random.mjs via scripts/audit-dial-protocol.mjs',
  ]);
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'bash "$GITHUB_WORKSPACE/scripts/devnet-publish-helpers.sh"')).missing, []);
  // A script path a step or a package script assembles at run time fails the
  // guard until it is listed: a devnet-* script it reaches would route to the
  // build checks alone.
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'bash "scripts/devnet-${SUITE}.sh"')).unexplained, [
    'ci.yml bura-cli: scripts/devnet-${SUITE}.sh',
  ]);
  const suite = { name: '@origintrail-official/dkg', scripts: { 'test:suite': 'bash ../../scripts/devnet-$SUITE.sh' } };
  const execution = { workspaces: { manifests: new Map([['packages/cli', suite]]), workspaceByName: new Map([[suite.name, 'packages/cli']]) }, rootManifest: {} };
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'pnpm --filter @origintrail-official/dkg run test:suite'), { execution }).unexplained, [
    'ci.yml bura-cli: ../../scripts/devnet-$SUITE.sh',
  ]);
  assert.equal(jobRequirement('ci.yml', 'changes', ''), undefined);
  assert.equal(jobRequirement('ci.yml', 'build', "needs.changes.outputs.run_node == 'true'"), 'build');
  assert.equal(jobRequirement('evm-integration.yml', 'evm-integration', "needs.plan.outputs.evm_matrix != '[]'"), 'full');
  // Only the changes job, which plans the others, runs its files unchecked. A
  // job without a condition is held to full CI like any other job outside
  // the lanes, so its build-only script is reported.
  const unconditional = (job) => `jobs:\n  ${job}:\n    steps:\n      - run: node scripts/audit-dial-protocol.mjs\n`;
  assert.equal(jobRequirement('ci.yml', 'audit', ''), 'full');
  assert.equal(plantedWorkflowGaps(unconditional('audit')).seeds.get('scripts/audit-dial-protocol.mjs')?.get('full'), 'ci.yml audit');
  assert.deepEqual(plantedWorkflowGaps(unconditional('audit')).missing, [
    'full loads scripts/audit-dial-protocol.mjs via ci.yml audit',
    'full loads scripts/audit-create-random.mjs via scripts/audit-dial-protocol.mjs',
  ]);
  assert.deepEqual([...plantedWorkflowGaps(unconditional('changes')).seeds.keys()], []);
});

test('a package-local helper a job runs itself carries that job', () => {
  // The CLI rule does not select the query lane, so a query job running a
  // CLI helper directly, outside any package script, is reported. Workspace
  // code the lanes seed keeps its workspace's lanes when a job only names it
  // (in a message), and carries the job when the job runs it.
  const helper = 'packages/cli/scripts/build-prerequisites.mjs';
  const job = (run) => `jobs:\n  bura-query:\n    if: needs.changes.outputs.bura_query == 'true'\n    steps:\n      - run: ${run}\n`;
  assert.deepEqual(plantedWorkflowGaps(job(`node ${helper}`)).missing.filter((gap) => gap.includes(` ${helper} `)), [
    `bura_query loads ${helper} via ci.yml bura-query`,
  ]);
  const seedsFor = (run) => laneExecution({ workflows: [['ci.yml', job(run)]] }).seeds.get('packages/cli/src/cli.ts');
  assert.equal(seedsFor('echo "see packages/cli/src/cli.ts"')?.has('bura_query'), false);
  assert.equal(seedsFor('node --import tsx packages/cli/src/cli.ts')?.has('bura_query'), true);
});

test('one execution graph feeds the seeds and the gap check, direct and indirect runs alike', () => {
  // The build job runs one repository script directly and packs the CLI
  // through release-packages.mjs (a child command it declares), whose
  // prepack runs the asset copier. Both reach the seeds through the graph,
  // and a plan that drops either from its requirement is reported.
  const cli = { name: '@origintrail-official/dkg', scripts: { prepack: 'node ../../scripts/copy-cli-runtime-assets.mjs' } };
  const execution = {
    workspaces: { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]) },
    rootManifest: { scripts: { 'release:verify-pack': 'node scripts/release-packages.mjs verify-pack' } },
  };
  const workflow = [
    'jobs:',
    '  build:',
    "    if: needs.changes.outputs.run_node == 'true'",
    '    steps:',
    '      - run: node scripts/audit-dial-protocol.mjs',
    '      - run: pnpm release:verify-pack',
  ].join('\n');
  const [build] = workflowExecution(workflow, execution);
  assert.deepEqual(build.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`), [
    '. release:verify-pack',
    'packages/cli prepack',
  ]);
  const { seeds, missing } = plantedWorkflowGaps(workflow, { execution });
  assert.equal(seeds.get('scripts/audit-dial-protocol.mjs')?.has('build'), true);
  assert.equal(seeds.get('scripts/copy-cli-runtime-assets.mjs')?.has('build-output:packages/cli'), true);
  assert.deepEqual(missing, []);
  // A docs-only plan runs neither the build nor anything else.
  const nothing = () => pullRequestPlan([change('docs/ci-delta-policy.md')]);
  const undocumented = plantedWorkflowGaps(workflow, { execution, plan: nothing }).missing;
  for (const gap of [
    'build loads scripts/audit-dial-protocol.mjs via ci.yml build',
    'build-output:packages/cli loads scripts/copy-cli-runtime-assets.mjs via ci.yml build > release:verify-pack > packages/cli prepack',
  ]) {
    assert.ok(undocumented.includes(gap), gap);
  }
  // The graph reads the release program's own declaration, which
  // release-packages.test.mjs checks the program runs.
  assert.equal(PROGRAM_CHILD_COMMANDS.get('scripts/release-packages.mjs'), SUBCOMMAND_CHILD_COMMANDS);
});

test('the load-closure guard reports a planted unrouted load and an unlisted computed load', () => {
  // The guard's detection, not only its current pass: a query-lane test that
  // imports agent source (agent changes do not select the query lane) and
  // computes another import at run time must be reported on both counts.
  const planted = 'packages/query/test/planted.test.ts';
  const sources = new Map([[planted, [
    "import { DKGAgent } from '../../agent/src/dkg-agent.js';",
    'const late = await import(`../../cli/src/${name}.js`);',
  ].join('\n')]]);
  const context = fixtureContext(new Map([...sources, ['packages/agent/src/dkg-agent.ts', '']]));
  const trace = traceLaneLoads(new Map([[planted, new Map([['bura_query', 'seed']])]]), { context });
  const { missing, unexplained } = loadClosureGaps(trace);
  assert.deepEqual(missing, [`bura_query loads packages/agent/src/dkg-agent.ts via ${planted}`]);
  assert.deepEqual(unexplained, [`${planted}: \`../../cli/src/\${name}.js\``]);
});

test('a package-local helper a workspace build runs is traced with that build output', () => {
  // The CLI build runs a helper under packages/cli/scripts/, which imports a
  // build-only repository script: that script now shapes the CLI's build
  // output, so a plan with the build checks alone is reported.
  const helper = 'packages/cli/scripts/planted-helper.mjs';
  const cli = { name: '@origintrail-official/dkg', scripts: { build: 'node scripts/planted-helper.mjs' } };
  const execution = {
    workspaces: { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]) },
    rootManifest: { scripts: { 'build:packages': 'turbo build' } },
    readRepoFile: (file) => (file === helper ? '' : undefined),
  };
  const workflow = "jobs:\n  build:\n    if: needs.changes.outputs.run_node == 'true'\n    steps:\n      - run: pnpm run build:packages\n";
  const seeds = laneSeeds({ workflows: [['ci.yml', workflow]], execution, workspaceCode: false });
  assert.equal(seeds.get(helper)?.has(requirement.buildOutput('packages/cli')), true);
  const context = fixtureContext(new Map([[helper, "import '../../../scripts/audit-dial-protocol.mjs';"], ['scripts/audit-dial-protocol.mjs', '']]));
  const trace = traceLaneLoads(seeds, { context });
  assert.deepEqual(loadClosureGaps(trace).missing, [`build-output:packages/cli loads scripts/audit-dial-protocol.mjs via ${helper}`]);
});

test('a script path a lane assembles at run time fails the guard until it is listed', () => {
  // The wildcard families route a new devnet-* script, and existing ones such
  // as devnet-test-invite-flow.sh, to the build checks alone, so a lane
  // reaching one through a path it builds or picks at run time would skip
  // itself; the guard reports every such construction it reaches, a file a
  // command runs through a variable included, until UNFOLLOWED_LOADS lists it
  // with the route that covers its targets.
  assert.deepEqual(selectedLanes(pullRequestPlan([change('scripts/devnet-new-helper.sh')])), []);
  assert.deepEqual(selectedLanes(pullRequestPlan([change('scripts/devnet-test-invite-flow.sh')])), []);
  const planted = 'packages/cli/test/planted.test.ts';
  const fixture = 'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh';
  const sources = new Map([
    [planted, [
      "import { join } from 'node:path';",
      `spawnSync('bash', ['${fixture}']);`,
      "spawnSync('bash', [join(process.cwd(), 'scripts', helper)]);",
    ].join('\n')],
    [fixture, [
      'helper=new-helper',
      'source "$SCRIPT_DIR/devnet-${helper}.sh"',
      'helper=devnet-test-invite-flow.sh',
      'bash "$SCRIPT_DIR/$helper"',
    ].join('\n')],
  ]);
  const trace = traceLaneLoads(new Map([[planted, new Map([['bura_cli', 'seed']])]]), { context: fixtureContext(sources) });
  assert.deepEqual(loadClosureGaps(trace).unexplained.sort(), [
    `${fixture}: $SCRIPT_DIR/$helper`,
    `${fixture}: $SCRIPT_DIR/devnet-\${helper}.sh`,
    `${planted}: join(process.cwd(), 'scripts', helper)`,
  ]);
});

test('a module a lane runs as a child process is traced through its imports', () => {
  // The chain lane's ABI-sync test runs scripts/sync-chain-abis.mjs from a
  // copy it makes (join(root, 'scripts', ...)). A build-only script the tool
  // imported would run in the chain lane too, so the guard reports it, as it
  // reports a build-only script the test reads; what that one imports does
  // not run.
  const planted = 'packages/chain/test/planted.unit.test.ts';
  const tool = 'scripts/sync-chain-abis.mjs';
  const sources = new Map([
    [planted, [
      "import { spawnSync } from 'node:child_process';",
      "import { join } from 'node:path';",
      "spawnSync(process.execPath, [join(root, 'scripts', 'sync-chain-abis.mjs'), ...names], { encoding: 'utf8' });",
      "const text = readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'audit-dial-protocol.mjs'), 'utf8');",
    ].join('\n')],
    [tool, "import './check-npm-metadata.mjs';"],
    ['scripts/audit-dial-protocol.mjs', "import './audit-create-random.mjs';"],
  ]);
  assert.deepEqual(selectedLanes(pullRequestPlan([change(tool)])), ['tornado_core']);
  const gaps = (test) => loadClosureGaps(traceLaneLoads(new Map([[test, new Map([['tornado_core', 'seed']])]]), {
    context: fixtureContext(new Map([...sources, ['scripts/check-npm-metadata.mjs', ''], ['scripts/audit-create-random.mjs', '']])),
  }));
  assert.deepEqual(gaps(planted).missing.sort(), [
    `tornado_core loads scripts/audit-dial-protocol.mjs via ${planted}`,
    `tornado_core loads scripts/check-npm-metadata.mjs via ${tool}`,
  ]);
  // Through an aliased spawnSync the helper is still reported; through a
  // wrapper whose parameter names the file, the call fails the guard itself
  // until UNFOLLOWED_LOADS lists it.
  const aliased = 'packages/chain/test/aliased.unit.test.ts';
  const wrapped = 'packages/chain/test/wrapped.unit.test.ts';
  sources.set(aliased, [
    "import { spawnSync as run } from 'node:child_process';",
    "import { join } from 'node:path';",
    "run(process.execPath, [join(root, 'scripts', 'sync-chain-abis.mjs')]);",
  ].join('\n'));
  sources.set(wrapped, [
    "import { spawnSync } from 'node:child_process';",
    "import { join } from 'node:path';",
    'const runScript = (file) => spawnSync(process.execPath, [file]);',
    "runScript(join(root, 'scripts', 'sync-chain-abis.mjs'));",
  ].join('\n'));
  assert.deepEqual(gaps(aliased).missing, [`tornado_core loads scripts/check-npm-metadata.mjs via ${tool}`]);
  assert.deepEqual(gaps(wrapped).unexplained, [`${wrapped}: file`]);
  // A wrapper that takes the program too, and a child class that spawns the
  // command its options configure (the Gate 1 AgentChild shape), name a
  // program no reading identifies: each fails the guard until listed.
  const programWrapper = 'packages/chain/test/program-wrapper.unit.test.ts';
  const agentChild = 'packages/chain/test/agent-child.unit.test.ts';
  sources.set(programWrapper, [
    "import { spawnSync } from 'node:child_process';",
    "import { join } from 'node:path';",
    'const run = (command, args) => spawnSync(command, args);',
    "run(process.execPath, [join(root, 'scripts', 'audit-dial-protocol.mjs')]);",
  ].join('\n'));
  sources.set(agentChild, [
    "import { spawn } from 'node:child_process';",
    'class AgentChild {',
    '  constructor(options) { this.child = spawn(options.spawn.command, [...options.spawn.args]); }',
    '}',
  ].join('\n'));
  assert.deepEqual(gaps(programWrapper).unexplained, [`${programWrapper}: command`]);
  assert.deepEqual(gaps(agentChild).unexplained, [`${agentChild}: options.spawn.command`]);
  // Lane source (not a test) running the tool through promisify(execFile):
  // the helper is reported; handing the runner to other code fails the guard.
  const promisified = 'packages/chain/src/planted-runner.ts';
  const escaping = 'packages/chain/src/planted-io.ts';
  sources.set(promisified, [
    "import { execFile } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    "import { join } from 'node:path';",
    'const run = promisify(execFile);',
    "await run(process.execPath, [join(root, 'scripts', 'sync-chain-abis.mjs')]);",
  ].join('\n'));
  sources.set(escaping, "import { execFile } from 'node:child_process';\nexport const io = { run: withRetry(execFile) };");
  assert.deepEqual(gaps(promisified).missing, [`tornado_core loads scripts/check-npm-metadata.mjs via ${tool}`]);
  assert.deepEqual(gaps(escaping).unexplained, [`${escaping}: withRetry(execFile)`]);
});
