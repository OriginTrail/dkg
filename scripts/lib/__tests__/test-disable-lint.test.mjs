import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeD1Source, analyzeD2Source } from '../../test-disable-lint.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts/test-disable-lint.mjs');

test('analysis reports only static test-targeting Vitest discovery exclusions', () => {
  const source = [
    "import { defineConfig } from 'vitest/config';",
    "const TEST_FILE = '**/*.test.ts';",
    "const SPEC_DIRECTORY = 'spec/**';",
    "const DISTRIBUTION = '**/dist/**';",
    '',
    'export default defineConfig({',
    '  test: {',
    '    exclude: [',
    "      'test/unit/slow.test.ts',",
    "      '**/*.spec.ts',",
    '      TEST_FILE,',
    '      SPEC_DIRECTORY,',
    "      '**/node_modules/**',",
    '      DISTRIBUTION,',
    "      'build/**',",
    "      'coverage/**',",
    '    ],',
    "    coverage: { exclude: ['src/generated.test.ts'] },",
    '  },',
    '});',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ api, line, value }) => ({
      api,
      line,
      value,
    })),
    [
      { api: 'vitest.exclude', line: 9, value: 'test/unit/slow.test.ts' },
      { api: 'vitest.exclude', line: 10, value: '**/*.spec.ts' },
      { api: 'vitest.exclude', line: 11, value: '**/*.test.ts' },
      { api: 'vitest.exclude', line: 12, value: 'spec/**' },
    ],
  );
});

test('analysis resolves exclusion constants through lexical scope', () => {
  const source = [
    "import { defineConfig } from 'vitest/config';",
    "const OUTER_EXCLUSION = 'tests/top-level/**';",
    'export default defineConfig(() => {',
    "  const NESTED_EXCLUSION = 'spec/callback/**';",
    '  return { test: { exclude: [NESTED_EXCLUSION] } };',
    '});',
    'export const parameterized = defineConfig((OUTER_EXCLUSION) => ({',
    '  test: { exclude: [OUTER_EXCLUSION] },',
    '}));',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [
      { line: 5, value: 'spec/callback/**' },
      { line: 8, value: 'OUTER_EXCLUSION' },
    ],
  );
});

test('analysis resolves exclusion constants declared in for initializers', () => {
  const source = [
    "const EXCLUSION = 'tests/outer/**';",
    "for (const EXCLUSION = 'tests/loop/**'; enabled;) {",
    '  const config = { test: { exclude: [EXCLUSION] } };',
    '  break;',
    '}',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [{ line: 3, value: 'tests/loop/**' }],
  );
});

test('analysis resolves exclusion constants declared in switch cases', () => {
  const source = [
    "const EXCLUSION = 'tests/outer/**';",
    'switch (mode) {',
    "  case 'unit':",
    "    const EXCLUSION = 'spec/case/**';",
    '    const config = { test: { exclude: [EXCLUSION] } };',
    '    break;',
    '}',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [{ line: 5, value: 'spec/case/**' }],
  );
});

test('analysis reports catch-bound exclusions without resolving outer constants', () => {
  const source = [
    "const EXCLUSION = 'tests/outer/**';",
    'try {',
    '  configure();',
    '} catch (EXCLUSION) {',
    '  const config = { test: { exclude: [EXCLUSION] } };',
    '}',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [{ line: 5, value: 'EXCLUSION' }],
  );
});

test('analysis reports for-of exclusions without resolving outer constants', () => {
  const source = [
    "const EXCLUSION = 'tests/outer/**';",
    'for (const EXCLUSION of exclusions) {',
    '  const config = { test: { exclude: [EXCLUSION] } };',
    '}',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [{ line: 3, value: 'EXCLUSION' }],
  );
});

test('analysis reports for-in exclusions without resolving outer constants', () => {
  const source = [
    "const EXCLUSION = 'tests/outer/**';",
    'for (const EXCLUSION in exclusions) {',
    '  const config = { test: { exclude: [EXCLUSION] } };',
    '}',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.config.ts').map(({ line, value }) => ({ line, value })),
    [{ line: 3, value: 'EXCLUSION' }],
  );
});

test('analysis recognizes custom Vitest configuration filenames', () => {
  const source = [
    "import { defineConfig } from 'vitest/config';",
    'export default defineConfig({',
    "  test: { exclude: ['e2e/**'] },",
    '});',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vitest.evm-integration.ts').map(({ value }) => value),
    ['e2e/**'],
  );
});

test('analysis recognizes standard Vite configuration filenames', () => {
  const source = [
    "import { defineConfig } from 'vite';",
    'export default defineConfig({',
    "  test: { exclude: ['tests/integration/**'] },",
    '});',
  ].join('\n');

  assert.deepEqual(
    analyzeD2Source(source, 'vite.config.ts').map(({ value }) => value),
    ['tests/integration/**'],
  );
});

test('full-tree audit reports tracked static D2 baseline without failing', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-d2-audit-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const configPath = 'packages/example/vitest.config.ts';
  const configSource = [
    "import { defineConfig } from 'vitest/config';",
    "const LEGACY_TESTS = 'tests/legacy/**';",
    'export default defineConfig({',
    '  test: {',
    '    exclude: [',
    "      'test/e2e.test.ts',",
    '      LEGACY_TESTS,',
    "      '**/dist/**',",
    '    ],',
    '  },',
    '});',
  ].join('\n');
  fs.mkdirSync(path.join(fixtureRoot, 'packages/example'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, configPath), configSource);
  fs.mkdirSync(path.join(fixtureRoot, 'build'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'build/vitest.config.ts'), configSource);

  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'audit@example.invalid'],
    ['config', 'user.name', 'audit'],
    ['add', '-A'],
  ]) {
    const git = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--all'], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${configPath}:6:7: D2 vitest.exclude`,
    `${configPath}:7:7: D2 vitest.exclude`,
  ]);
});

test('diff mode fails only for net-new static D2 exclusions', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-d2-diff-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'diff@example.invalid');
  git('config', 'user.name', 'diff');
  fs.writeFileSync(path.join(fixtureRoot, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    'export default defineConfig({',
    '  test: {',
    '    exclude: [',
    "      'test/existing.test.ts',",
    "      '**/dist/**',",
    '    ],',
    '  },',
    '});',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  fs.writeFileSync(path.join(fixtureRoot, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    'export default defineConfig({',
    '  test: {',
    '    exclude: [',
    "      'test/existing.test.ts',",
    "      '**/dist/**',",
    "      'coverage/**',",
    "      'test/new.test.ts',",
    '    ],',
    '  },',
    '});',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--diff', base, head], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), 'vitest.config.ts:8:7: D2 vitest.exclude');
});

test('analysis reports every conditional test suppression occurrence', () => {
  const source = [
    "test.skipIf(isWindows)('Windows test', () => {});",
    "it.runIf(hasDatabase)('database test', () => {});",
    "describe.skipIf(isCi)('CI suite', () => {});",
    "suite.runIf(hasDocker)('Docker suite', () => {});",
    "test('browser test', async ({ browserName }) => {",
    "  test.skip(browserName === 'webkit', 'WebKit is unsupported');",
    '});',
    "test.skipIf(isWindows)('Windows test', () => {});",
  ].join('\n');

  assert.deepEqual(
    analyzeD1Source(source, 'test/conditional.test.ts').map(({ api, line }) => ({ api, line })),
    [
      { api: 'test.skipIf', line: 1 },
      { api: 'it.runIf', line: 2 },
      { api: 'describe.skipIf', line: 3 },
      { api: 'suite.runIf', line: 4 },
      { api: 'test.skip', line: 6 },
      { api: 'test.skipIf', line: 8 },
    ],
  );
});

test('analysis reports indirect skip references with stable fallback fingerprints', () => {
  const source = [
    'const skippedTest = test.skip;',
    'const maybeTest = disabled ? it.skip : it;',
    'const maybeSuite = enabled ? describe : describe.skip;',
  ].join('\n');
  const reformattedSource = [
    'const skippedTest=test . skip;',
    'const maybeTest = disabled',
    '  ? it . skip',
    '  : it;',
    'const maybeSuite=enabled?describe:describe . skip;',
  ].join('\n');
  const findings = analyzeD1Source(source, 'test/indirect.test.ts');
  const reformattedFindings = analyzeD1Source(reformattedSource, 'test/indirect.test.ts');

  assert.deepEqual({
    references: findings.map(({ api, line }) => ({ api, line })),
    fingerprintsPresent: findings.every(
      ({ fingerprint }) => typeof fingerprint === 'string' && fingerprint.length > 0,
    ),
    stableAfterFormatting: findings.map(
      ({ fingerprint }, index) => fingerprint === reformattedFindings[index]?.fingerprint,
    ),
  }, {
    references: [
      { api: 'test.skip', line: 1 },
      { api: 'it.skip', line: 2 },
      { api: 'describe.skip', line: 3 },
    ],
    fingerprintsPresent: true,
    stableAfterFormatting: [true, true, true],
  });
});

test('file audit reports direct disabled declarations at their source locations', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-lint-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixturePath = path.join(fixtureRoot, 'test/direct.test.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, [
    "test.skip('skipped test', () => {});",
    "it.todo('todo test');",
    "describe.skip('skipped suite', () => {});",
    "xit('legacy it', () => {});",
    "xtest('legacy test', () => {});",
    "xdescribe('legacy suite', () => {});",
    "test('active test', () => {});",
  ].join('\n'));

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', fixturePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${fixturePath}:1:1: D1 test.skip`,
    `${fixturePath}:2:1: D1 it.todo`,
    `${fixturePath}:3:1: D1 describe.skip`,
    `${fixturePath}:4:1: D1 xit`,
    `${fixturePath}:5:1: D1 xtest`,
    `${fixturePath}:6:1: D1 xdescribe`,
  ]);
});

test('file audit reports declarations only from active test sources', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-scope-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixtures = new Map([
    ['src/widget.spec.ts', "// test.skip('commented');\nconst example = \"xit('string')\";"],
    ['packages/example/test/support.ts', "test.skip('active support', () => {});"],
    ['src/support.ts', "test.skip('ordinary source', () => {});"],
    ['node_modules/example/test/dependency.ts', "test.skip('dependency', () => {});"],
    ['dist/tests/compiled.ts', "test.skip('distribution output', () => {});"],
    ['build/test/generated.ts', "test.skip('build output', () => {});"],
    ['coverage/test/instrumented.ts', "test.skip('coverage output', () => {});"],
    ['test/archive/legacy.test.ts', "test.skip('archived test', () => {});"],
    ['tests/archive/legacy.test.ts', "test.skip('archived tests', () => {});"],
  ]);
  const fixturePaths = [];
  for (const [relativePath, source] of fixtures) {
    const fixturePath = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, source);
    fixturePaths.push(fixturePath);
  }

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', ...fixturePaths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  const activePath = path.join(fixtureRoot, 'packages/example/test/support.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${activePath}:1:1: D1 test.skip`);
});

test('file audit accepts only nearby matching ticketed D1 pragmas with reasons', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-pragma-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixturePath = path.join(fixtureRoot, 'pragma.test.ts');
  fs.writeFileSync(fixturePath, [
    '// test-disable-allow: D1 #123 -- unavailable on the Windows runner',
    "test.skip('ticket number', () => {});",
    '',
    '// test-disable-allow: D1 https://github.com/OriginTrail/dkg/issues/456 -- upstream fix pending',
    "it.todo('issue URL');",
    '',
    '// test-disable-allow: D1 DKG-789 -- migration remains in progress',
    "xdescribe('tracker key', () => {});",
    '',
    '// test-disable-allow: D2 #100 -- wrong rule',
    "test.skip('wrong rule', () => {});",
    '// test-disable-allow: D1 -- missing ticket',
    "xit('missing ticket', () => {});",
    '// test-disable-allow: D1 #101 --',
    "xtest('missing reason', () => {});",
    '// test-disable-allow: D1 #102 -- outside the allowed window',
    '',
    '',
    '',
    "describe.skip('distant pragma', () => {});",
    '',
    '// test-disable-allow: D1 #103 -- exactly three lines above',
    '',
    '',
    "test.todo('window boundary');",
  ].join('\n'));

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', fixturePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${fixturePath}:11:1: D1 test.skip`,
    `${fixturePath}:13:1: D1 xit`,
    `${fixturePath}:15:1: D1 xtest`,
    `${fixturePath}:20:1: D1 describe.skip`,
  ]);
});

function semanticMoveSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-move-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, 'test/original.test.ts'),
      "test.skip('existing debt', () => {});\n",
    );
    writeFileSync(
      path.join(fixtureRoot, 'test/untouched.test.ts'),
      "it.todo('untouched debt');\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    git('mv', 'test/original.test.ts', 'test/moved.test.ts');
    writeFileSync(
      path.join(fixtureRoot, 'test/moved.test.ts'),
      "\n\ntest.skip('existing debt', () => {});\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'move disabled test');
    const head = git('rev-parse', 'HEAD').trim();
    const cli = spawnSync(
      process.execPath,
      [LINT_SCRIPT, '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
      },
    );
    const pass = cli.status === 0 && cli.stdout === '';
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: semantic move exit=${cli.status}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function semanticGrowthSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-growth-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    const fixturePath = path.join(fixtureRoot, 'test/original.test.ts');
    const disabledTest = "test.skip('copied debt', () => {});\n";
    writeFileSync(fixturePath, disabledTest);
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    const copiedPath = path.join(fixtureRoot, 'test/café\tcopy.test.ts');
    copyFileSync(fixturePath, copiedPath);
    git('add', '-A');
    git('commit', '-qm', 'copy disabled test');
    const head = git('rev-parse', 'HEAD').trim();
    const cli = spawnSync(
      process.execPath,
      [LINT_SCRIPT, '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
      },
    );
    const diagnostics = cli.stdout
      .trim()
      .split('\n')
      .filter((line) => line.includes(': D1 '));
    const expected = ['test/café\tcopy.test.ts:1:1: D1 test.skip'];
    const pass = cli.status === 1 && JSON.stringify(diagnostics) === JSON.stringify(expected);
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: semantic growth exit=${cli.status}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function auditModesSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-audit-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    const relativeFixturePath = 'test/café\tdebt.test.ts';
    const fixturePath = path.join(fixtureRoot, relativeFixturePath);
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, "it.todo('audit debt');\n");
    git('add', '-A');

    const spawnAudit = (args) => spawnSync(
      process.execPath,
      [LINT_SCRIPT, ...args],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
      },
    );
    const fileAudit = spawnAudit(['--files', fixturePath]);
    const fullAudit = spawnAudit(['--all']);
    const pass = fileAudit.status === 0
      && fileAudit.stdout.trim() === `${fixturePath}:1:1: D1 it.todo`
      && fullAudit.status === 0
      && fullAudit.stdout.trim() === `${relativeFixturePath}:1:1: D1 it.todo`;
    if (!pass) {
      process.stderr.write(
        'SELF-TEST FAIL: audit modes did not report debt without failure\n'
          + `--files exit=${fileAudit.status}\nstdout:\n${fileAudit.stdout}\nstderr:\n${fileAudit.stderr}`
          + `--all exit=${fullAudit.status}\nstdout:\n${fullAudit.stdout}\nstderr:\n${fullAudit.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function staticD2ArraySelfTest() {
  const source = [
    "const TEST_EXCLUSIONS = ['tests/unit/**'];",
    "const NESTED_EXCLUSIONS = ['coverage/**', ...TEST_EXCLUSIONS];",
    "const EXCLUSIONS = [...NESTED_EXCLUSIONS, '**/*.spec.ts'];",
    'export default { test: { exclude: EXCLUSIONS } };',
  ].join('\n');
  const values = analyzeD2Source(source, 'vitest.config.ts').map(({ value }) => value);
  const expected = ['tests/unit/**', '**/*.spec.ts'];
  const pass = JSON.stringify(values) === JSON.stringify(expected);
  if (!pass) {
    process.stderr.write(
      `SELF-TEST FAIL: static D2 arrays expected ${JSON.stringify(expected)}, `
        + `received ${JSON.stringify(values)}\n`,
    );
  }
  return pass;
}

function wrappedD2ArraySelfTest() {
  const source = [
    "const OUTPUT_EXCLUSIONS = (['coverage/**'] as const);",
    "const TEST_EXCLUSIONS = (['tests/unit/**'] as const);",
    "const TEST_FILE = ('**/*.test.ts' as const) satisfies string;",
    "const SPEC_EXCLUSIONS = ['**/*.spec.ts'] satisfies readonly string[];",
    'export default {',
    '  test: {',
    '    exclude: ([',
    '      ...OUTPUT_EXCLUSIONS,',
    '      ...TEST_EXCLUSIONS,',
    '      TEST_FILE,',
    '      ...SPEC_EXCLUSIONS,',
    '    ] as const) satisfies readonly string[],',
    '  },',
    '};',
  ].join('\n');
  const values = analyzeD2Source(source, 'vitest.config.ts').map(({ value }) => value);
  const expected = ['tests/unit/**', '**/*.test.ts', '**/*.spec.ts'];
  const pass = JSON.stringify(values) === JSON.stringify(expected);
  if (!pass) {
    process.stderr.write(
      `SELF-TEST FAIL: wrapped D2 arrays expected ${JSON.stringify(expected)}, `
        + `received ${JSON.stringify(values)}\n`,
    );
  }
  return pass;
}

function opaqueD2RatchetSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-opaque-d2-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    const configPath = path.join(fixtureRoot, 'vitest.config.ts');
    writeFileSync(configPath, [
      'export default {',
      '  test: {',
      '    exclude: [',
      '      legacyExclusions(),',
      '    ],',
      '  },',
      '};',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    writeFileSync(configPath, [
      'export default {',
      '  test: {',
      '    exclude: [',
      '      legacyExclusions(),',
      '',
      '      // test-disable-allow: D2 #123 -- generated test inventory',
      '      allowedExclusions(),',
      '',
      '',
      '',
      '      // test-disable-allow: D1 #124 -- wrong rule cannot allow D2',
      '      wrongRuleExclusions(),',
      '',
      '',
      '',
      '      newExclusions(),',
      '    ],',
      '  },',
      '};',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD').trim();

    const cli = spawnSync(
      process.execPath,
      [LINT_SCRIPT, '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
      },
    );
    const diagnostics = cli.stdout.trim().split('\n');
    const expected = [
      'vitest.config.ts:12:7: D2 vitest.exclude',
      'vitest.config.ts:16:7: D2 vitest.exclude',
    ];
    const pass = cli.status === 1
      && JSON.stringify(diagnostics) === JSON.stringify(expected);
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: opaque D2 ratchet exit=${cli.status}\n`
          + `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function destructuredD2RatchetSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-destructured-d2-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    const configPath = path.join(fixtureRoot, 'vitest.config.ts');
    const configSource = (exclusion) => [
      'const [legacyExclusion, replacementExclusion] = loadExclusions();',
      'export default {',
      '  test: {',
      '    exclude: [',
      `      ${exclusion},`,
      '    ],',
      '  },',
      '};',
    ].join('\n');
    writeFileSync(configPath, configSource('legacyExclusion'));
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    writeFileSync(configPath, configSource('replacementExclusion'));
    git('add', '-A');
    git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD').trim();

    const cli = spawnSync(
      process.execPath,
      [LINT_SCRIPT, '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
      },
    );
    const expected = 'vitest.config.ts:5:7: D2 vitest.exclude';
    const pass = cli.status === 1 && cli.stdout.trim() === expected;
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: destructured D2 ratchet exit=${cli.status}\n`
          + `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}


for (const scenario of [semanticMoveSelfTest, semanticGrowthSelfTest, auditModesSelfTest, staticD2ArraySelfTest, wrappedD2ArraySelfTest, opaqueD2RatchetSelfTest, destructuredD2RatchetSelfTest]) {
  test(scenario.name, () => assert.equal(scenario(), true));
}

test('import aliases, namespaces, chained declarations and skip references retain canonical fingerprints', () => {
  const variants = [
    ["import { test as check } from 'vitest'; check.skip('case', () => {});", "test.skip('case', () => {});"],
    ["import { it as check } from 'vitest'; check.todo('case');", "it.todo('case');"],
    ["import { test as check } from '@playwright/test'; check.skipIf(true)('case', () => {});", "test.skipIf(true)('case', () => {});"],
    ["import { test as check } from 'vitest'; check.runIf(false)('case', () => {});", "test.runIf(false)('case', () => {});"],
    ["import { test as check } from 'vitest'; const disabled = check.skip;", "const disabled = test.skip;"],
    ["import * as v from 'vitest'; v.test.concurrent.skip('case', () => {});", "test.skip('case', () => {});"],
    ["import { test as check } from 'vitest'; check['skip']('case', () => {});", "test.skip('case', () => {});"],
    ["import { test } from 'vitest'; const check = test; check.skip('case', () => {});", "test.skip('case', () => {});"],
    ["import { it } from 'vitest'; const pending = it.todo; pending('case');", "it.todo('case');"],
    ["import { test } from 'vitest'; const conditional = test.skipIf; conditional(true)('case', () => {});", "test.skipIf(true)('case', () => {});"],
    ["import { test } from 'vitest'; const conditional = test.runIf; conditional(false)('case', () => {});", "test.runIf(false)('case', () => {});"],
  ];
  for (const [alias, direct] of variants) {
    const actual = analyzeD1Source(alias, 'test/alias.test.ts');
    const expected = analyzeD1Source(direct, 'test/alias.test.ts');
    assert.equal(actual.length, 1, alias);
    // Reference fingerprints also include the expression spelling; declarations
    // retain the existing title-based fingerprint across import renames.
    if (!alias.includes('const ')) assert.equal(actual[0].fingerprint, expected[0].fingerprint);
  }
  assert.equal(analyzeD1Source("import { test as check } from 'vitest'; function local(check) { check.skip('not a test'); }", 'test/alias.test.ts').length, 0);
});

test('the repository debt gate rejects a newly disabled aliased test', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-alias-gate-'));
  try {
    fs.mkdirSync(path.join(fixture, 'test-policy'));
    fs.mkdirSync(path.join(fixture, 'test'));
    fs.writeFileSync(path.join(fixture, 'test-policy/disabled-tests.json'), '[]');
    fs.writeFileSync(path.join(fixture, 'test/new.test.ts'), "import { test } from 'vitest'; const check = test; check.skip('regression', () => {}); const pending = test.todo; pending('later');");
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/ci/check-disabled-tests.mjs')], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /new disabled test.*test\.skip/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
