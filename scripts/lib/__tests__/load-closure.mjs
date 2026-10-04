// The load-closure guard's shared pieces, for its repository check
// (ci-delta-routing.test.mjs) and planted cases (ci-execution-routing and
// ci-install-routing tests): the module loads and runs no trace can follow,
// each with the reason it needs no route (UNFOLLOWED_LOADS), the gap checks,
// and a trace of a planted workflow.
import { change, pullRequestPlan } from './ci-plan-fixtures.mjs';
import { INSTALL_HOOK_DEPENDENCIES } from '../ci-routing.mjs';
import { laneExecution, requirement, requirementCoveredByPlan } from './lane-entrypoints.mjs';
import { traceLaneLoads } from './load-graph.mjs';

// Module loads computed and script paths assembled at run time that the
// load-closure guard cannot follow, each with the reason it needs no route of
// its own.
export const UNFOLLOWED_LOADS = new Map([
  ['packages/agent/test/sync-native-export-hostile.test.ts: pathToFileURL(`${oldDist}/dkg-agent-cg-resolve.js`).href',
    'an optional user-supplied external frozen 10.0.20 build; compatibility cases always execute the repository historical source fixture, and no repository lane can route the external build'],
  ['packages/agent/src/generic-sql-source.ts: moduleName', 'the optional mssql driver and node:sqlite, neither a repository file'],
  ['packages/agent/src/sqlite/module-loader-v1.ts: name', 'node:sqlite, the default loader, not a repository file'],
  ['packages/agent/test/generic-sql-source.test.ts: moduleName', 'node:sqlite, not a repository file'],
  ['packages/chain/src/evm-adapter-abi.ts: `@origintrail-official/dkg-evm-module/abi/${contractName}.json`',
    'an evm-module ABI, and every evm-module change runs full CI'],
  ['packages/cli/blazegraph-image-metadata.cjs: candidate',
    'one of the resolve(__dirname, ...) copies of blazegraph-namespace-contract.cjs, which the guard reads as paths'],
  ['packages/cli/src/daemon/plugin-loader.ts: pathToFileURL(spec).href', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/daemon/plugin-loader.ts: pathToFileURL(resolved).href', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/daemon/plugin-loader.ts: spec', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/source-worker-runner.ts: pathToFileURL(config.handlerModule).href',
    'a handler module named in the source-worker configuration'],
  ['packages/cli/test/blazegraph-image-metadata.test.ts: parserPath', "the CLI's own blazegraph-image-metadata.cjs"],
  ['packages/mcp-dkg/src/adapters.ts: pkg', 'a third-party adapter package named at run time; ADAPTER_MAP names no workspace'],
  ['packages/adapter-openclaw/test/openclaw-entry.test.ts: href', 'a module the test writes to a temporary directory'],
  ['packages/agent/scripts/test-package-root.mjs: specifier',
    "the agent package's own emitted internal namespace files, imported by package name to verify export denial; agent source changes run the agent's lanes"],
  ['packages/agent/scripts/test-package-root.mjs: `@origintrail-official/dkg-agent/dist/rfc64/${path}`',
    "the agent package's own built dist/rfc64/ entries, checked through its export map"],
  ['packages/agent/scripts/test-package-root.mjs: `@origintrail-official/dkg-agent/dist/${path}`',
    "the agent package's own built dist/ entries, checked through its export map"],
  ['packages/rdf-utils/scripts/rdf-literal-escape-benchmark.mjs: pathToFileURL(process.argv[4])',
    "rdf-utils' built dist/rdf-literal-escape.js, which the benchmark passes to its own worker; built from rdf-utils source the rdf-utils rule routes"],
  ['packages/agent/scripts/bench-sync-telemetry.mjs: pathToFileURL(distFile).href',
    "the agent's built dist/sync/attempt-telemetry.js, built from agent source the agent rule routes"],
  ['scripts/devnet.sh: $cli_entry',
    "the CLI entry a devnet node starts from (node_cli_entry): packages/cli/dist/cli.js, built from CLI source whose rule selects both lanes that reach devnet.sh (the CLI lane and the browser suite), or a released version's under .devnet-versions/, outside the repository's files"],
  // Files a child-process or worker call runs that no reading resolves.
  ["devnet/rfc64-persistence-lifecycle/run.ts: childArguments(AGENT_PROCESS, stage ? ['--stage'] : [])",
    'agent-process.ts beside it, run under tsx (childArguments puts the script after the loader flags); a devnet file with run.ts\'s own route'],
  ['devnet/rfc64-persistence-lifecycle/run.ts: childArguments(LEASE_PROBE)',
    'lease-probe.ts beside it, run under tsx; a devnet file with run.ts\'s own route'],
  ['packages/agent/devnet/rfc64-private-catalog/run.mjs: args',
    "agent-process.mjs beside it (AGENT_PROCESS) unless a caller passes its own, under tsx with a load hook when it records provenance; agent code with run.mjs's own route"],
  ['packages/agent/src/sync-verify-worker.ts: workerPath',
    "the agent's own sync-verify-worker-impl build (beside it, or under dist/), from agent source the agent rule routes"],
  ['packages/chain/test/hardhat-harness.ts: hardhatCli', "hardhat's CLI, resolved from node_modules, not a repository file"],
  ['packages/cli/src/migration.ts: cmd',
    'the pnpm install and runtime build commands it runs in an update slot, a checkout outside the repository\'s files'],
  ['packages/cli/test/auto-update-versioned-e2e.test.ts: cmd', 'the git commands its git() helper runs in temporary repositories'],
  ["packages/cli/test/blazegraph-image-metadata.test.ts: join(cleanCliDir, 'blazegraph-image-metadata.cjs')",
    "a copy of packages/cli/blazegraph-image-metadata.cjs in a temporary checkout; the file itself routes by the CLI rule"],
  ['packages/cli/test/blue-green-integration.test.ts: cmd', 'the git commands its git() helper runs in temporary repositories'],
  ['packages/cli/test/foreground-supervisor.test.ts: workerScript', 'a worker script the test writes to a temporary directory'],
  ['packages/cli/test/oxigraph-managed-caller-abort.e2e.test.ts: ...args',
    "the supervisor's own spawn arguments, passed through a wrapper that records each child's pid; they launch the Oxigraph server binary, not a repository file"],
  ['packages/evm-module/utils/helpers.ts: command', 'git rev-parse commands; every evm-module change runs full CI'],
  ["packages/node-ui/scripts/test-package-exports.mjs: 'consumer.mjs'", 'a module the script writes to a temporary directory'],
  ["packages/node-ui/scripts/test-package-exports.mjs: requireFromPackage.resolve('typescript/lib/tsc.js')",
    "the TypeScript compiler, resolved from node_modules, not a repository file"],
  ['packages/random-sampling/src/proof-worker.ts: this.entryPath',
    "the package's own proof-worker-entry beside it, or one a caller passes; random-sampling code its rule routes"],
  ['packages/rdf-utils/scripts/rdf-literal-escape-benchmark.mjs: import.meta.filename',
    'the benchmark itself, re-run as its own worker process'],
  ['packages/storage/src/adapters/oxigraph-worker.ts: this.workerPath',
    "the storage package's own oxigraph-worker-impl (beside it, or its dist/ build), storage code its rule routes"],
  // Programs a child-process call runs that no reading identifies: tools, or
  // node running the file named.
  ['devnet/rfc64-gate1-public-open/agent-child.ts: options.spawn.command',
    "the process its caller configures: run.ts starts the Gate 1 adapter process beside it under tsx; its tests start fixtures"],
  ['packages/adapter-hermes/pytests/run-pytest.mjs: cmd', 'the Python interpreters it probes and runs pytest with (-m pytest)'],
  ["packages/adapter-hermes/test/hermes-adapter.part-11.test.ts: process.env.PYTHON ?? 'python3'", 'Python (PYTHON or python3) running inline code (-c)'],
  ['packages/cli/scripts/bundle-markitdown-binaries.mjs: candidate.command', 'the Python interpreters it probes with --version (PYTHON, python3, python, py)'],
  ['packages/cli/src/cli-supervisor.ts: daemonCommand.executable',
    "process.execPath running the CLI's own daemon entry (resolveDaemonNodeCommand), CLI code the CLI rule routes"],
  ['packages/cli/src/commands/lifecycle.ts: daemonCommand.executable',
    "process.execPath running the CLI's own daemon entry (resolveDaemonNodeCommand), CLI code the CLI rule routes"],
  ['packages/cli/src/daemon/oxigraph-binary.ts: path', 'the Oxigraph server binary it checks with --version'],
  ['packages/cli/src/doctor/index.ts: cmd', "the system tools the doctor's checks probe"],
  ['packages/cli/src/extraction/markitdown-converter.ts: bin', 'the bundled MarkItDown binary (getMarkItDownBin)'],
  ['packages/cli/src/integrations/install-npm-global.ts: cmd', 'the npm global-install command its callers pass'],
  ['packages/cli/src/mcp-config-metadata.ts: command', 'a command it probes with --help'],
  ['packages/cli/src/mcp-config-metadata.ts: executable', 'Windows PowerShell'],
  ['packages/cli/src/mcp-config-metadata.ts: copyCommand', 'the copy command it installs an MCP config with: cp, or a metadata-preserving copy on Linux'],
  ['packages/cli/test/edge-auto-update-entrypoint-e2e.test.ts: pathDkg', 'a dkg shim the test writes to a temporary bin directory'],
  ['packages/cli/test/fixtures/mcp-config-wsl.fixture.ts: shadowExecutable', 'a shadow executable the fixture writes to a temporary directory'],
  ["packages/cli/test/fixtures/mcp-config-wsl.fixture.ts: windowsPowerShellExecutable('windows-wsl')", 'Windows PowerShell'],
  ['packages/cli/test/fixtures/oxigraph-orphan-harness.ts: tool', 'the host tools hostHas() probes with -h'],
  ['packages/cli/test/mcp-config-metadata.test.ts: shadowExecutable', 'a shadow executable the test writes to a temporary directory'],
  ['packages/cli/test/mcp-config-metadata.test.ts: systemPowerShell', 'Windows PowerShell'],
  ['packages/cli/test/oxigraph-orphan-lifecycle.test.ts: ...args', 'what the Oxigraph lifecycle spawns, passed through a counting wrapper: the Oxigraph binary or its standin'],
  ['packages/cli/test/oxigraph-orphan-native.test.ts: lockingStandin.binaryPath', 'an Oxigraph standin binary the test builds in a temporary directory'],
  ['packages/cli/test/oxigraph-parent-watchdog.test.ts: cmd', 'what the watchdog spawns, passed through its injected spawnChild: the Oxigraph binary or its standin'],
  ['packages/cli/test/oxigraph-server.test.ts: binaryPath', 'the Oxigraph binary or its standin, checked with --version'],
  ['packages/cli/test/oxigraph-server.test.ts: command', 'what the server spawns, passed through an injected spawnProcess: the Oxigraph binary or its standin'],
  ['packages/cli/test/oxigraph-server.test.ts: standin', 'an Oxigraph standin binary fixture'],
  ['packages/core/src/daemon-lifecycle.ts: node',
    'process.execPath running the CLI entry resolveDkgCli() finds (packages/cli/dist/cli.js, or an installed CLI), CLI code the CLI rule routes'],
  ['scripts/release-packages.mjs: cmd', "the npm, pnpm and git commands its run helpers take; verify-pack's is declared in SUBCOMMAND_CHILD_COMMANDS"],
  ['packages/cli/scripts/bundle-markitdown-binaries.mjs: python.command', 'the Python interpreter it builds a virtual environment with'],
  ['packages/cli/scripts/bundle-markitdown-binaries.mjs: venvPython', "the build's virtual-environment Python, outside the repository"],
  ['packages/cli/test/devnet-publish-helpers-smoke.test.ts: toWslPath(scriptPath)',
    'scripts/devnet-publish-helpers.sh (scriptPath), converted to a WSL path on Windows; the helpers route to the CLI lane'],
  ['packages/cli/test/foreground-supervisor-command.test.ts: harnessPath', 'a supervisor harness the test writes to a temporary directory'],
  // Runners that escape into injectable code (a default, an io object), which
  // may call them with anything.
  ['bench/support/profile-process.mjs: spawnProcess = spawn', 'the command its callers profile, through an injectable spawn'],
  ['packages/cli/scripts/build-prerequisites.mjs: spawn = spawnSync', 'the prerequisite pnpm builds it runs, through an injectable spawnSync'],
  ['packages/cli/src/daemon/auto-update.ts: promisify(exec)', 'the exec in its injectable io (_autoUpdateIo): npm, pnpm and git commands in update slots'],
  ['packages/cli/src/daemon/auto-update.ts: promisify(execFile)', 'the execFile in its injectable io (_autoUpdateIo): git commands in update slots'],
  ['packages/cli/src/daemon/manifest.ts: execAsync as (...args: any[]) => Promise<any>', 'the exec its injectable io exports: git commands in slot checkouts'],
  ['packages/cli/src/daemon/manifest.ts: execFileAsync as (...args: any[]) => Promise<any>', 'the execFile its injectable io exports: git commands in slot checkouts'],
  ['packages/cli/src/daemon/manifest.ts: execSync as (...args: any[]) => any', 'the execSync its injectable io exports: git commands in slot checkouts'],
  ['packages/cli/src/daemon/oxigraph-parent-watchdog.ts: opts.spawnChild ?? spawn', 'the Oxigraph server binary it watches, through an injectable spawnChild'],
  ['packages/cli/src/daemon/oxigraph-server.ts: ioOverrides.spawn ?? spawn', 'the Oxigraph server binary, through an injectable spawn'],
  ['packages/cli/src/extraction/markitdown-converter.ts: execFileSync as (...args: any[]) => any', 'the bundled MarkItDown binary, through its injectable io'],
  ['packages/cli/src/migration.ts: execFileSync as (...args: any[]) => any', 'the git commands its injectable io runs in update slots'],
  ['packages/cli/src/migration.ts: execSync as (...args: any[]) => any', 'the pnpm install and build commands its injectable io runs in update slots'],
  ['packages/cli/src/rollback-node-ui.ts: execSync', "the node-ui static build command (pnpm) its injectable io runs"],
  ['scripts/ci/build-evm-integration.mjs: spawnProcess = spawnSync', 'an injectable spawnSync for its tests; scripts/ci changes run full CI'],
  ['scripts/ci/check-oxlint-baseline.mjs: spawnProcess = spawnSync', 'an injectable spawnSync for its tests; scripts/ci changes run full CI'],
  ['scripts/ci/check-tracked-text-nul.mjs: spawnProcess = spawnSync', 'an injectable spawnSync for its tests; scripts/ci changes run full CI'],
  ['scripts/ci/discover-vitest-files.mjs: run = spawnSync', 'an injectable spawnSync for its tests; scripts/ci changes run full CI'],
  ['scripts/ci/fetch-trusted-controller.mjs: run = execFileSync', 'an injectable execFileSync (git) for its tests; scripts/ci changes run full CI'],
  ['scripts/ci/run-vitest-junit.mjs: spawnProcess = spawnSync', 'an injectable spawnSync for its tests; scripts/ci changes run full CI'],
  ['scripts/lib/run-build-command.mjs: spawn = spawnSync', 'an injectable spawnSync for its tests; scripts/lib changes run full CI'],
  ['scripts/run-evm-integration.mjs: run = spawnSync', "an injectable spawnSync for its tests; the EVM runner's changes run full CI"],
]);

// What the load-closure guard reports for a trace: each load whose file does
// not select the requirement that reaches it, and each module load computed
// or script path assembled at run time that UNFOLLOWED_LOADS does not
// explain - in a traced file, or in a job's commands (`unresolved`, from
// laneExecution). What each requirement asks of a plan is
// requirementCoveredByPlan's (lane-entrypoints.mjs). `plan(file)` plans a
// change to one file.
export function loadClosureGaps({ loaded, unfollowed }, { plan = (file) => pullRequestPlan([change(file)]), unresolved = [] } = {}) {
  const missing = [];
  for (const [target, requirements] of loaded) {
    const targetPlan = plan(target);
    for (const [required, via] of requirements) {
      if (!requirementCoveredByPlan(required, targetPlan, target)) missing.push(`${required} loads ${target} via ${via}`);
    }
  }
  const computed = [...new Set([
    ...[...unfollowed].flatMap(([file, specifiers]) => specifiers.map((specifier) => `${file}: ${specifier}`)),
    ...unresolved,
  ])];
  return { missing, unexplained: computed.filter((entry) => !UNFOLLOWED_LOADS.has(entry)), computed };
}

// The reads install code makes from directories it builds at run time, as
// INSTALL_HOOK_DEPENDENCIES declares them (its repositoryRead and exemption
// variants): `${reader}: ${name}` -> the file each reaches (none for an
// exemption) and the exemption's reason.
export const INSTALL_HOOK_READS = new Map(INSTALL_HOOK_DEPENDENCIES
  .filter(({ kind }) => kind === 'repositoryRead' || kind === 'exemption')
  .map(({ kind, reader, name, path: file, reason }) => [`${reader}: ${name}`, kind === 'exemption' ? { name, reads: [], reason } : { name, reads: [file] }]));

// What the guard reports about those reads, from a trace's `unresolvedReads`
// in files with the `install` requirement: ones `declared` does not list,
// listed ones no longer made, listed files that do not plan full CI without
// a reason, and listed files whose path does not end in the name read.
export function installReadGaps({ loaded, unresolvedReads }, { declared = INSTALL_HOOK_READS, plan = (file) => pullRequestPlan([change(file)]) } = {}) {
  const made = [...unresolvedReads]
    .filter(([file]) => loaded.get(file)?.has(requirement.install))
    .flatMap(([file, reads]) => reads.map((read) => `${file}: ${read}`));
  return {
    undeclared: [...new Set(made.filter((read) => !declared.has(read)))],
    stale: [...declared.keys()].filter((read) => !made.includes(read)),
    notFull: [...declared].flatMap(([read, { reads, reason }]) => (reason ? [] : reads
      .filter((file) => plan(file).mode !== 'full')
      .map((file) => `${file} (${read})`))),
    misnamed: [...declared].flatMap(([read, { name, reads }]) => reads
      .filter((file) => !`/${file}`.endsWith(`/${name.replace(/^(?:\.\.\/)+/, '')}`))
      .map((file) => `${file} (${read})`)),
  };
}

// The load-closure gaps for what a planted ci.yml runs (laneSeeds from the
// execution graph, without the workspace code), through the same trace and
// check as the repository's own workflows.
export function plantedWorkflowGaps(workflowSource, options = {}) {
  const { seeds, unresolved } = laneExecution({ workflows: [['ci.yml', workflowSource]], workspaceCode: false, ...options });
  return { seeds, ...loadClosureGaps(traceLaneLoads(seeds), { ...options, unresolved }) };
}
