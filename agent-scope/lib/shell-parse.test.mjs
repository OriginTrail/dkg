// Unit tests for the shell-command parser. Run with:
//   node --test agent-scope/lib/shell-parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCommands, tokenize, extractRedirections, extractDestructiveTargets,
  extractFindTargets, extractXargsTarget, extractNestedShellBody,
  extractOpaqueBody, bodyHasWriteIntent, bodyTouchesProtected,
  extractTaskCreateId, approvedTaskCreateWrites,
} from './shell-parse.mjs';
import { PROTECTED_PATTERNS } from './scope.mjs';

// --- splitCommands --------------------------------------------------------

test('splitCommands: semicolon', () => {
  assert.deepEqual(splitCommands('a; b; c'), ['a', 'b', 'c']);
});

test('splitCommands: && / ||', () => {
  assert.deepEqual(splitCommands('a && b || c'), ['a', 'b', 'c']);
});

test('splitCommands: pipe splits', () => {
  assert.deepEqual(splitCommands('find . | xargs rm'), ['find .', 'xargs rm']);
});

test('splitCommands: respects quotes', () => {
  assert.deepEqual(splitCommands('echo "a; b"; echo c'), ['echo "a; b"', 'echo c']);
});

// --- tokenize -------------------------------------------------------------

test('tokenize: basic', () => {
  assert.deepEqual(tokenize('rm -rf foo bar'), ['rm', '-rf', 'foo', 'bar']);
});

test('tokenize: quoted arg preserved whole', () => {
  assert.deepEqual(tokenize('bash -c "rm x"'), ['bash', '-c', 'rm x']);
});

test('tokenize: escaped spaces', () => {
  assert.deepEqual(tokenize('rm a\\ b'), ['rm', 'a b']);
});

// --- redirections ---------------------------------------------------------

test('extractRedirections: > target', () => {
  assert.deepEqual(extractRedirections(tokenize('echo x > foo.txt')), ['foo.txt']);
});

test('extractRedirections: >> append', () => {
  assert.deepEqual(extractRedirections(tokenize('echo x >> log.txt')), ['log.txt']);
});

test('extractRedirections: tee', () => {
  assert.deepEqual(extractRedirections(tokenize('echo x | tee -a out.log')), ['out.log']);
});

test('extractRedirections: no redirect', () => {
  assert.deepEqual(extractRedirections(tokenize('ls -la')), []);
});

// --- destructive targets --------------------------------------------------

test('extractDestructiveTargets: rm -rf', () => {
  const r = extractDestructiveTargets(tokenize('rm -rf foo bar'));
  assert.equal(r.cmd, 'rm');
  assert.deepEqual(r.targets, ['foo', 'bar']);
});

test('extractDestructiveTargets: unlink', () => {
  const r = extractDestructiveTargets(tokenize('unlink foo'));
  assert.equal(r.cmd, 'unlink');
  assert.deepEqual(r.targets, ['foo']);
});

test('extractDestructiveTargets: chmod numeric mode skipped', () => {
  const r = extractDestructiveTargets(tokenize('chmod 755 script.sh'));
  assert.equal(r.cmd, 'chmod');
  assert.deepEqual(r.targets, ['script.sh']);
});

test('extractDestructiveTargets: sed WITHOUT -i is not destructive', () => {
  const r = extractDestructiveTargets(tokenize('sed s/a/b/ file.txt'));
  assert.equal(r.cmd, 'sed');
  assert.deepEqual(r.targets, []);
});

test('extractDestructiveTargets: sed -i is destructive', () => {
  const r = extractDestructiveTargets(tokenize('sed -i s/a/b/ file.txt'));
  assert.equal(r.cmd, 'sed');
  assert.deepEqual(r.targets, ['s/a/b/', 'file.txt']);
});

test('extractDestructiveTargets: non-destructive command', () => {
  const r = extractDestructiveTargets(tokenize('echo hello'));
  assert.equal(r.cmd, null);
});

// --- find / xargs ---------------------------------------------------------

test('extractFindTargets: -delete', () => {
  const r = extractFindTargets(tokenize('find .cursor -name "*.mjs" -delete'));
  assert.equal(r.cmd, 'find');
  assert.deepEqual(r.targets, ['.cursor']);
});

test('extractFindTargets: -exec rm', () => {
  const r = extractFindTargets(tokenize('find agent-scope -name "*.json" -exec rm {} ;'));
  assert.equal(r.cmd, 'find');
  assert.deepEqual(r.targets, ['agent-scope']);
});

test('extractFindTargets: no destructive expression → null', () => {
  assert.equal(extractFindTargets(tokenize('find . -name "*.ts"')), null);
});

test('extractXargsTarget: xargs rm', () => {
  const r = extractXargsTarget(tokenize('xargs rm'));
  assert.equal(r.cmd, 'xargs rm');
});

test('extractXargsTarget: xargs -0 unlink', () => {
  const r = extractXargsTarget(tokenize('xargs -0 unlink'));
  assert.equal(r.cmd, 'xargs unlink');
});

test('extractXargsTarget: xargs echo (not destructive)', () => {
  assert.equal(extractXargsTarget(tokenize('xargs echo')), null);
});

// --- nested shell / opaque evaluators -------------------------------------

test('extractNestedShellBody: bash -c', () => {
  const r = extractNestedShellBody(tokenize('bash -c "rm -rf foo"'));
  assert.equal(r.shell, 'bash');
  assert.equal(r.body, 'rm -rf foo');
});

test('extractNestedShellBody: sh -c with absolute path', () => {
  const r = extractNestedShellBody(tokenize('/bin/sh -c "echo x > y"'));
  assert.equal(r.shell, 'sh');
  assert.equal(r.body, 'echo x > y');
});

test('extractNestedShellBody: not a shell → null', () => {
  assert.equal(extractNestedShellBody(tokenize('echo hi')), null);
});

test('extractOpaqueBody: node -e', () => {
  const r = extractOpaqueBody(tokenize("node -e \"require('fs').unlinkSync('x')\""));
  assert.equal(r.evaluator, 'node');
  assert.equal(r.flag, '-e');
  assert.match(r.body, /unlinkSync/);
});

test('extractOpaqueBody: python3 -c', () => {
  const r = extractOpaqueBody(tokenize('python3 -c "import os; os.remove(\'x\')"'));
  assert.equal(r.evaluator, 'python3');
  assert.match(r.body, /os\.remove/);
});

test('extractOpaqueBody: perl -e', () => {
  const r = extractOpaqueBody(tokenize("perl -e \"unlink 'x'\""));
  assert.equal(r.evaluator, 'perl');
});

test('extractOpaqueBody: plain node (no -e)', () => {
  assert.equal(extractOpaqueBody(tokenize('node script.js')), null);
});

// --- body intent / protected-path scanning --------------------------------

test('bodyHasWriteIntent: fs.writeFileSync', () => {
  assert.ok(bodyHasWriteIntent("require('fs').writeFileSync('x', 'y')"));
});

test('bodyHasWriteIntent: python os.remove', () => {
  assert.ok(bodyHasWriteIntent('os.remove("x")'));
});

test("bodyHasWriteIntent: python open('w')", () => {
  assert.ok(bodyHasWriteIntent('open("foo.txt", "w").write("x")'));
});

test('bodyHasWriteIntent: shell-style redirect in body', () => {
  assert.ok(bodyHasWriteIntent('echo x > y.txt'));
});

test('bodyHasWriteIntent: read-only code', () => {
  assert.equal(bodyHasWriteIntent("console.log('hi')"), false);
});

test('bodyTouchesProtected: .cursor/hooks.json', () => {
  assert.ok(bodyTouchesProtected("fs.writeFileSync('.cursor/hooks.json', '')", PROTECTED_PATTERNS));
});

test('bodyTouchesProtected: agent-scope/lib/scope.mjs', () => {
  assert.ok(bodyTouchesProtected("open('agent-scope/lib/scope.mjs', 'w')", PROTECTED_PATTERNS));
});

test('bodyTouchesProtected: agent-scope/active', () => {
  assert.ok(bodyTouchesProtected("fs.writeFileSync('agent-scope/active', 'evil')", PROTECTED_PATTERNS));
});

test('bodyTouchesProtected: normal path does not match', () => {
  assert.equal(bodyTouchesProtected("fs.writeFileSync('README.md', '')", PROTECTED_PATTERNS), false);
});

// --- composite scenarios (the gap we're closing) --------------------------

test('scenario: node -e + fs.writeFileSync + protected path is flagged', () => {
  const cmd = "node -e \"require('fs').writeFileSync('agent-scope/active', 'evil')\"";
  const tokens = tokenize(cmd);
  const opaque = extractOpaqueBody(tokens);
  assert.ok(opaque);
  assert.ok(bodyHasWriteIntent(opaque.body));
  assert.ok(bodyTouchesProtected(opaque.body, PROTECTED_PATTERNS));
});

test('scenario: python3 -c + open(w) + .cursor/hooks/ is flagged', () => {
  const cmd = 'python3 -c "open(\'.cursor/hooks/evil.py\', \'w\').write(\'x\')"';
  const tokens = tokenize(cmd);
  const opaque = extractOpaqueBody(tokens);
  assert.ok(opaque);
  assert.ok(bodyHasWriteIntent(opaque.body));
  assert.ok(bodyTouchesProtected(opaque.body, PROTECTED_PATTERNS));
});

test('scenario: bash -c "rm -rf .cursor/hooks" produces destructive target on recursion', () => {
  const cmd = 'bash -c "rm -rf .cursor/hooks"';
  const outer = tokenize(cmd);
  const nested = extractNestedShellBody(outer);
  assert.ok(nested);
  const inner = tokenize(nested.body);
  const dest = extractDestructiveTargets(inner);
  assert.equal(dest.cmd, 'rm');
  assert.deepEqual(dest.targets, ['.cursor/hooks']);
});

test('scenario: benign node command (read-only) is not flagged', () => {
  const cmd = "node -e \"console.log(require('fs').readFileSync('.cursor/hooks.json', 'utf8'))\"";
  const tokens = tokenize(cmd);
  const opaque = extractOpaqueBody(tokens);
  assert.ok(opaque);
  // Body references protected path but has no write intent → not flagged.
  assert.equal(bodyHasWriteIntent(opaque.body), false);
});

// --- extractTaskCreateId + approvedTaskCreateWrites ----------------------
// The afterShell hook uses these to allow the ONE specific write that a
// `pnpm task create <id>` invocation legitimately produces. Everything
// else under agent-scope/** still gets reverted.

test('extractTaskCreateId: pnpm task create <id> returns the id', () => {
  assert.equal(
    extractTaskCreateId('pnpm task create peer-sync-auth --inherits base --activate'),
    'peer-sync-auth',
  );
});

test('extractTaskCreateId: pnpm run task create <id> returns the id', () => {
  assert.equal(
    extractTaskCreateId('pnpm run task create my-id'),
    'my-id',
  );
});

test('extractTaskCreateId: node agent-scope/bin/task.mjs create <id>', () => {
  assert.equal(
    extractTaskCreateId('node agent-scope/bin/task.mjs create my-id --activate'),
    'my-id',
  );
});

test('extractTaskCreateId: node ./agent-scope/bin/task.mjs create <id>', () => {
  assert.equal(
    extractTaskCreateId('node ./agent-scope/bin/task.mjs create my-id'),
    'my-id',
  );
});

test('extractTaskCreateId: absolute node path works', () => {
  assert.equal(
    extractTaskCreateId('/usr/local/bin/node agent-scope/bin/task.mjs create my-id'),
    'my-id',
  );
});

test('extractTaskCreateId: absolute pnpm path works', () => {
  assert.equal(
    extractTaskCreateId('/opt/homebrew/bin/pnpm task create my-id --activate'),
    'my-id',
  );
});

test('extractTaskCreateId: quoted id is accepted', () => {
  assert.equal(
    extractTaskCreateId('pnpm task create "my-id" --description "x"'),
    'my-id',
  );
});

test('extractTaskCreateId: chained command — picks up the create sub-command', () => {
  assert.equal(
    extractTaskCreateId('git add . && pnpm task create my-id --activate'),
    'my-id',
  );
  assert.equal(
    extractTaskCreateId('pnpm task create my-id --activate && pnpm task show'),
    'my-id',
  );
});

test('extractTaskCreateId: pnpm task list / set / clear / show → null', () => {
  assert.equal(extractTaskCreateId('pnpm task list'), null);
  assert.equal(extractTaskCreateId('pnpm task set my-id'), null);
  assert.equal(extractTaskCreateId('pnpm task clear'), null);
  assert.equal(extractTaskCreateId('pnpm task show'), null);
});

test('extractTaskCreateId: missing id → null', () => {
  assert.equal(extractTaskCreateId('pnpm task create'), null);
  assert.equal(extractTaskCreateId('pnpm task create --activate'), null);
});

test('extractTaskCreateId: id starts with hyphen (flag-like) → null', () => {
  assert.equal(extractTaskCreateId('pnpm task create --my-id'), null);
  assert.equal(extractTaskCreateId('pnpm task create -foo'), null);
});

test('extractTaskCreateId: id with path-escape / special chars → null', () => {
  assert.equal(extractTaskCreateId('pnpm task create ../evil'), null);
  assert.equal(extractTaskCreateId('pnpm task create my/id'), null);
  assert.equal(extractTaskCreateId('pnpm task create "my id"'), null);
  assert.equal(extractTaskCreateId('pnpm task create my.id'), null);
  assert.equal(extractTaskCreateId('pnpm task create $(whoami)'), null);
});

test('extractTaskCreateId: impostor that writes to tasks/ directly → null', () => {
  assert.equal(
    extractTaskCreateId('echo \'{"id":"evil"}\' > agent-scope/tasks/evil.json'),
    null,
  );
  assert.equal(
    extractTaskCreateId('cp /tmp/m.json agent-scope/tasks/evil.json'),
    null,
  );
  assert.equal(
    extractTaskCreateId("node -e \"require('fs').writeFileSync('agent-scope/tasks/evil.json', '{}')\""),
    null,
  );
});

test('extractTaskCreateId: non-canonical scripts → null (forces bootstrap)', () => {
  assert.equal(extractTaskCreateId('npm run task create my-id'), null);
  assert.equal(extractTaskCreateId('yarn task create my-id'), null);
  assert.equal(extractTaskCreateId('bun task create my-id'), null);
});

test('extractTaskCreateId: non-string / empty → null', () => {
  assert.equal(extractTaskCreateId(''), null);
  assert.equal(extractTaskCreateId(null), null);
  assert.equal(extractTaskCreateId(undefined), null);
  assert.equal(extractTaskCreateId(42), null);
  assert.equal(extractTaskCreateId('   '), null);
});

test('approvedTaskCreateWrites: returns manifest + active paths for valid id', () => {
  const s = approvedTaskCreateWrites('peer-sync-auth');
  assert.equal(s.size, 2);
  assert.ok(s.has('agent-scope/tasks/peer-sync-auth.json'));
  assert.ok(s.has('agent-scope/active'));
});

test('approvedTaskCreateWrites: invalid / empty id → empty set', () => {
  assert.equal(approvedTaskCreateWrites(null).size, 0);
  assert.equal(approvedTaskCreateWrites('').size, 0);
  assert.equal(approvedTaskCreateWrites('../evil').size, 0);
  assert.equal(approvedTaskCreateWrites('a/b').size, 0);
});
