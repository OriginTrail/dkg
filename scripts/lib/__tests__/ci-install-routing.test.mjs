// Install-hook routing: what every job's install runs or reads plans full CI,
// through the install dependency table's explicit variants, and a workspace
// build carries its output to what it runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { change, pullRequestPlan, selectedLanes, sourceFiles } from './ci-plan-fixtures.mjs';
import { INSTALL_HOOK_DEPENDENCIES, INSTALL_HOOK_INPUTS, installDependency, installHookInputs } from '../ci-routing.mjs';
import { laneSeeds } from './lane-entrypoints.mjs';
import { loadClosureGaps, INSTALL_HOOK_READS, installReadGaps } from './load-closure.mjs';

test('the load-closure guard holds install hooks to full CI and builds to their output', () => {
  // What every job's install runs needs full CI, the CLI preinstall's own
  // script included, though it lives in the CLI workspace: a plan routing it
  // by the CLI rule, as before, is reported.
  const preinstall = 'packages/cli/scripts/verify-node-sqlite-runtime.mjs';
  const seeds = laneSeeds({ workspaceCode: false });
  assert.match(seeds.get(preinstall)?.get('install') ?? '', /> preinstall$/);
  assert.equal(pullRequestPlan([change(preinstall)]).mode, 'full');
  const installed = { loaded: new Map([[preinstall, new Map([['install', 'ci.yml build > preinstall']])]]), unfollowed: new Map() };
  assert.deepEqual(loadClosureGaps(installed).missing, []);
  const byWorkspace = (file) => pullRequestPlan([change(file === preinstall ? 'packages/cli/src/cli.ts' : file)]);
  assert.deepEqual(loadClosureGaps(installed, { plan: byWorkspace }).missing, [`install loads ${preinstall} via ci.yml build > preinstall`]);

  // A file install code reads from a directory the trace cannot resolve must
  // be declared, and plan full CI: the postinstall reads markitdown-targets.json
  // at load, so a plan routing it by the CLI rule is reported, and so is a
  // read no declaration covers.
  const bundler = 'packages/cli/scripts/bundle-markitdown-binaries.mjs';
  const targets = 'packages/cli/markitdown-targets.json';
  assert.equal(pullRequestPlan([change(targets)]).mode, 'full');
  const reading = {
    loaded: new Map([[bundler, new Map([['install', 'ci.yml build > packages/cli postinstall']])]]),
    unresolvedReads: new Map([[bundler, ['markitdown-targets.json', 'new-input.json']]]),
  };
  const declared = new Map([...INSTALL_HOOK_READS].filter(([read]) => read.endsWith(': markitdown-targets.json')));
  const byCli = (file) => pullRequestPlan([change(file === targets ? 'packages/cli/src/cli.ts' : file)]);
  assert.deepEqual(installReadGaps(reading, { declared, plan: byCli }), {
    undeclared: [`${bundler}: new-input.json`],
    stale: [],
    notFull: [`${targets} (${bundler}: markitdown-targets.json)`],
    misnamed: [],
  });
  // A declared file must be the one the name reads.
  const wrongFile = new Map([[`${bundler}: markitdown-targets.json`, { name: 'markitdown-targets.json', reads: ['packages/cli/package.json'] }]]);
  assert.deepEqual(installReadGaps(reading, { declared: wrongFile }).misnamed, [`packages/cli/package.json (${bundler}: markitdown-targets.json)`]);

  // What the CLI build runs carries the CLI's build output: the asset copier,
  // a repository file, needs full CI, so routing it to the CLI lane alone is
  // reported. A workspace file it loads must select the CLI rule's lanes,
  // except the browser suite for the runtime that suite follows after merge.
  const copier = 'scripts/copy-cli-runtime-assets.mjs';
  const output = 'build-output:packages/cli';
  const built = {
    loaded: new Map([
      [copier, new Map([[output, 'packages/cli build:prepared']])],
      ['packages/cli/blazegraph-image-metadata.cjs', new Map([[output, copier]])],
      ['packages/storage/blazegraph-namespace-contract.cjs', new Map([[output, 'packages/cli/blazegraph-image-metadata.cjs']])],
    ]),
    unfollowed: new Map(),
  };
  assert.equal(pullRequestPlan([change('packages/storage/blazegraph-namespace-contract.cjs')]).lanes.kosava_node_ui_e2e, false);
  assert.deepEqual(loadClosureGaps(built).missing, []);
  const narrowed = (file) => pullRequestPlan([change(file === copier ? 'scripts/devnet-publish-helpers.sh' : file)]);
  assert.deepEqual(selectedLanes(narrowed(copier)), ['bura_cli']);
  assert.deepEqual(loadClosureGaps(built, { plan: narrowed }).missing, [`${output} loads ${copier} via packages/cli build:prepared`]);
  // Outside the deferred runtime, a workspace must select every CLI lane.
  const graphViz = 'packages/graph-viz/src/index.ts';
  const withoutBrowser = (file) => {
    const plan = pullRequestPlan([change(file)]);
    return file === graphViz ? { ...plan, lanes: { ...plan.lanes, kosava_node_ui_e2e: false } } : plan;
  };
  const viz = { loaded: new Map([[graphViz, new Map([[output, copier]])]]), unfollowed: new Map() };
  assert.deepEqual(loadClosureGaps(viz).missing, []);
  assert.deepEqual(loadClosureGaps(viz, { plan: withoutBrowser }).missing, [`${output} loads ${graphViz} via ${copier}`]);
});

test('install dependencies are explicit variants, and only their repository paths reach the planner', () => {
  // Each constructor checks its fields, so a record cannot be ambiguous or
  // incomplete; the planner's full-CI inputs are the entrypoints' and
  // repository reads' paths, never an exemption's.
  const reader = 'packages/cli/scripts/bundle-markitdown-binaries.mjs';
  assert.throws(() => installDependency.entrypoint(undefined), /needs a path/);
  assert.throws(() => installDependency.repositoryRead(reader, 'targets.json'), /needs a path/);
  assert.throws(() => installDependency.exemption(reader, 'targets.json', ''), /needs a reason/);
  assert.deepEqual(installDependency.repositoryRead(reader, 'targets.json', 'packages/cli/targets.json'), {
    kind: 'repositoryRead', reader, name: 'targets.json', path: 'packages/cli/targets.json',
  });
  assert.deepEqual(installHookInputs([installDependency.entrypoint('a.mjs'), installDependency.exemption(reader, 'b.json', 'why')]), ['a.mjs']);
  assert.throws(() => installHookInputs([{ kind: 'repositoryReed', reader, name: 'targets.json', path: 'packages/cli/targets.json' }]), /unknown install dependency/);
  assert.deepEqual([...new Set(INSTALL_HOOK_DEPENDENCIES.map(({ kind }) => kind))].sort(), ['entrypoint', 'exemption', 'repositoryRead']);
  for (const dependency of INSTALL_HOOK_DEPENDENCIES) {
    assert.ok(Object.isFrozen(dependency));
    assert.equal(INSTALL_HOOK_INPUTS.includes(dependency.path), dependency.kind !== 'exemption', JSON.stringify(dependency));
  }
});

test('what tells the install hook it runs in a workspace checkout plans full CI', () => {
  // The CLI postinstall skips the release download only when the CLI has its
  // tsconfig.json (isWorkspaceCheckout; the CLI's markitdown-binaries test
  // pins it, and packs the CLI to check the published package leaves it
  // out): any change to it plans full CI, since deleting or moving it would
  // make every job's install download a binary for its platform. Its src/
  // marks nothing, so a deleted source file is an ordinary CLI change.
  const tsconfig = 'packages/cli/tsconfig.json';
  for (const entry of [change(tsconfig, 'D'), { status: 'R100', paths: [tsconfig, 'packages/cli/tsconfig.base.json'] }, change(tsconfig)]) {
    assert.equal(pullRequestPlan([entry]).mode, 'full', JSON.stringify(entry));
  }
  assert.notEqual(pullRequestPlan([change(sourceFiles('packages/cli/src')[0], 'D')]).mode, 'full');
});
