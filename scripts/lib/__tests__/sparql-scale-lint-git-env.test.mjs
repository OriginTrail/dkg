import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The SPARQL lint's diff-gate self-test builds a throwaway git repository and
// commits to it. Run from a git hook (which exports GIT_DIR and GIT_INDEX_FILE)
// or a tool that sets GIT_DIR / GIT_WORK_TREE, those git commands used to act
// on the CALLER'S repository instead: `git init` re-initialised it and wrote
// core.worktree, `git config` wrote the self-test identity into its config and
// `git commit` added a "base" commit to its current branch.
//
// Every scenario below points those variables at a DECOY repository created in
// the operating system's temporary directory, never at a real checkout.

const LINT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sparql-scale-lint.mjs');

/** This test's own git calls must not depend on, or act through, the runner's GIT_* variables either. */
const withoutGitVariables = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
const ownGitEnv = () => ({ ...withoutGitVariables(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'sparql-lint-git-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const decoy = join(root, 'decoy');
  const scratchTmp = join(root, 'tmp'); // the self-test's TMPDIR: whatever it leaves behind is visible here
  const childCwd = join(root, 'cwd'); // never the decoy and never a checkout
  const elsewhere = join(root, 'elsewhere'); // a work tree that is not the decoy's parent directory
  for (const directory of [decoy, scratchTmp, childCwd, elsewhere]) mkdirSync(directory);

  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=decoy-owner', '-c', 'user.email=decoy-owner@example.invalid', ...args,
  ], { cwd: decoy, encoding: 'utf8', env: ownGitEnv() }).trim();
  git('init', '-q');
  writeFileSync(join(decoy, 'README.md'), 'decoy\n');
  git('add', '-A');
  git('commit', '-qm', 'decoy-initial');

  /** Everything the self-test could have changed in the decoy: config, HEAD, refs, history, index and tree. */
  const snapshot = () => ({
    config: readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    head: readFileSync(join(decoy, '.git', 'HEAD'), 'utf8'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    history: git('log', '--all', '--format=%H %s'),
    index: git('ls-files', '--stage'),
    status: git('status', '--porcelain'),
    tree: readdirSync(decoy).sort().join(','),
    readme: readFileSync(join(decoy, 'README.md'), 'utf8'),
  });

  // Asynchronous, so the scenarios below can overlap.
  const runSelfTest = (environment) => new Promise((resolve) => {
    execFile(process.execPath, [LINT, '--self-test'], {
      cwd: childCwd,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...withoutGitVariables(), TMPDIR: scratchTmp, TMP: scratchTmp, TEMP: scratchTmp, ...environment },
    }, (error, stdout, stderr) => resolve({ status: error ? (error.code ?? error.signal ?? 1) : 0, stdout, stderr }));
  });

  return { root, decoy, elsewhere, scratchTmp, snapshot, runSelfTest };
}

const scenarios = [
  {
    name: 'GIT_DIR and GIT_WORK_TREE (a tool that drives git)',
    environment: ({ decoy }) => ({ GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy }),
  },
  {
    name: 'GIT_DIR and a GIT_WORK_TREE elsewhere (git init records it as core.worktree)',
    environment: ({ decoy, elsewhere }) => ({ GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: elsewhere }),
  },
  {
    name: 'GIT_DIR and GIT_INDEX_FILE (what git exports to a hook)',
    environment: ({ decoy }) => ({ GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index') }),
  },
];

// Each self-test run starts three Node processes (the CLI and --files checks), so the scenarios overlap.
describe('the SPARQL lint diff-gate self-test', { concurrency: true }, () => {
  for (const { name, environment } of scenarios) {
    it(`does not touch the repository named by ${name}`, async (t) => {
      const sandbox = makeSandbox(t);
      const before = sandbox.snapshot();
      assert.equal(before.history.split('\n').length, 1, 'the decoy starts with exactly one commit');

      const result = await sandbox.runSelfTest(environment(sandbox));

      assert.deepEqual(sandbox.snapshot(), before, 'the self-test must not write to the repository GIT_DIR points at');
      assert.equal(result.status, 0, `self-test exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /diff-gate pass/);
      assert.deepEqual(readdirSync(sandbox.scratchTmp), [], 'the self-test removes its temporary repository');
    });
  }

  it('ignores the caller\'s git configuration and identity variables', async (t) => {
    const sandbox = makeSandbox(t);
    // A caller whose global git config signs every commit with a signer that does
    // not exist, whose environment injects the same, and that pins an author.
    const hostileGlobal = join(sandbox.root, 'hostile.gitconfig');
    writeFileSync(hostileGlobal, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/signer\n');
    const before = sandbox.snapshot();

    const result = await sandbox.runSelfTest({
      GIT_CONFIG_GLOBAL: hostileGlobal,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: join(sandbox.root, 'no-such-hooks'),
      GIT_AUTHOR_NAME: 'caller',
      GIT_COMMITTER_EMAIL: 'caller@example.invalid',
    });

    assert.equal(result.status, 0, `self-test exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /diff-gate pass/);
    assert.deepEqual(sandbox.snapshot(), before);
  });
});

test('hermeticGitEnv drops every GIT_ variable, keeps the rest and turns the configuration files off', async () => {
  const { hermeticGitEnv } = await import('../../sparql-scale-lint.mjs');
  const env = hermeticGitEnv({
    PATH: '/usr/bin',
    HOME: '/home/someone',
    GIT_DIR: '/x/.git',
    GIT_WORK_TREE: '/x',
    GIT_INDEX_FILE: '/x/.git/index',
    GIT_COMMON_DIR: '/x/.git',
    GIT_OBJECT_DIRECTORY: '/x/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y',
    GIT_NAMESPACE: 'ns',
    GIT_PREFIX: 'sub/',
    GIT_CEILING_DIRECTORIES: '/z',
    GIT_CONFIG: '/c',
    GIT_CONFIG_PARAMETERS: "'a.b=c'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'a.b',
    GIT_CONFIG_VALUE_0: 'c',
    GIT_AUTHOR_NAME: 'someone',
    GIT_COMMITTER_EMAIL: 'someone@example.invalid',
  });
  assert.deepEqual(
    Object.keys(env).filter((name) => name.startsWith('GIT_')).sort(),
    ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'],
  );
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/someone');
});
