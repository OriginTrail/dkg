import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../devnet-soak-publish-helpers.sh', import.meta.url));
const soak = fileURLToPath(new URL('../../devnet-soak-rs.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// What the CLI prints when the daemon refuses a share as temporarily unavailable:
// the one-shot create reports it from its 207 body, the share route from its 503.
const REFUSED_CREATE = 'Knowledge asset create/share completed partially for "soak-1-26" in devnet-test: '
  + 'phase=swm-share A promote prerequisite is temporarily unavailable';
const REFUSED_SHARE = '[promote:encodeWorkspaceGossipPayload] A promote prerequisite is temporarily unavailable';
const CREATE = '3 ka create soak-1-26 --context-graph-id devnet-test --input-file /fixture/q26.nt --share';
const SHARE = '3 ka share soak-1-26 --context-graph-id devnet-test';
const PUBLISH = '3 ka publish soak-1-26 --context-graph-id devnet-test';

// Run one publication against scripted CLI answers: `answers[verb][n]` is the
// [exit status, output] of the n-th call of that verb.
function publishOnce(t, answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-soak-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answerDir = path.join(dir, 'answers');
  fs.mkdirSync(answerDir);
  for (const [verb, list] of Object.entries(answers)) {
    list.forEach(([status, output], index) => {
      fs.writeFileSync(path.join(answerDir, `${verb}.${index + 1}.status`), String(status));
      fs.writeFileSync(path.join(answerDir, `${verb}.${index + 1}.out`), output);
    });
  }
  const script = `
    source "$1"
    devnet_soak_cli() {
      local verb="$3" n
      printf '%s\\n' "$*" >> "$TRACE"
      n=$(grep -c " ka $verb " "$TRACE")
      [ -f "$ANSWERS/$verb.$n.status" ] || { echo "unexpected call $n of $verb" >&2; return 99; }
      cat "$ANSWERS/$verb.$n.out"
      return "$(cat "$ANSWERS/$verb.$n.status")"
    }
    sleep() { printf 'sleep %s\\n' "$1" >> "$TRACE"; }
    devnet_soak_publish_once 3 devnet-test soak-1-26 /fixture/q26.nt
    printf '%s\\n%s\\n' "$DEVNET_SOAK_RC" "$DEVNET_SOAK_SHARE_REPEATS" > "$RESULT"
    printf '%s' "$DEVNET_SOAK_OUT" > "$RESULT.out"
  `;
  const trace = path.join(dir, 'trace');
  const result = path.join(dir, 'result');
  // The publisher loop runs with `set -uo pipefail`.
  const run = spawnSync('bash', ['-uo', 'pipefail', '-c', script, '--', helper], {
    env: { ...process.env, ANSWERS: answerDir, TRACE: trace, RESULT: result }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const [rc, repeats] = fs.readFileSync(result, 'utf8').trim().split('\n').map(Number);
  return {
    rc,
    repeats,
    calls: fs.readFileSync(trace, 'utf8').trim().split('\n'),
    out: fs.readFileSync(`${result}.out`, 'utf8'),
  };
}

test('a share refused as temporarily unavailable is sent again, then the asset is published', (t) => {
  const run = publishOnce(t, {
    create: [[1, REFUSED_CREATE]],
    share: [[1, REFUSED_SHARE], [0, 'Knowledge asset shared to SWM:']],
    publish: [[0, 'Knowledge asset VM publish complete']],
  });
  assert.equal(run.rc, 0);
  assert.equal(run.repeats, 2);
  // Only the share is sent again; the create already sealed the draft.
  assert.deepEqual(run.calls, [CREATE, 'sleep 1', SHARE, 'sleep 2', SHARE, PUBLISH]);
  assert.equal(run.out, [REFUSED_CREATE, REFUSED_SHARE, 'Knowledge asset shared to SWM:',
    'Knowledge asset VM publish complete'].join('\n'));
});

test('a share still refused after the last repeat fails the publication without a publish', (t) => {
  const run = publishOnce(t, {
    create: [[1, REFUSED_CREATE]],
    share: Array.from({ length: 5 }, () => [1, REFUSED_SHARE]),
  });
  assert.equal(run.rc, 1);
  assert.equal(run.repeats, 5);
  assert.deepEqual(run.calls, [CREATE, 'sleep 1', SHARE, 'sleep 2', SHARE, 'sleep 4', SHARE,
    'sleep 8', SHARE, 'sleep 16', SHARE]);
});

test('a repeated share that fails for another reason is not sent again', (t) => {
  const run = publishOnce(t, {
    create: [[1, REFUSED_CREATE]],
    share: [[1, 'Knowledge asset "soak-1-26" is not finalized']],
  });
  assert.equal(run.rc, 1);
  assert.equal(run.repeats, 1);
  assert.deepEqual(run.calls, [CREATE, 'sleep 1', SHARE]);
});

test('failures other than the retryable share refusal are not repeated', async (t) => {
  for (const [label, answers, calls] of [
    ['daemon down', { create: [[1, 'Daemon is not running at /fixture/node3.']] }, [CREATE]],
    ['share refused for good', {
      create: [[1, 'Knowledge asset create/share completed partially for "soak-1-26" in devnet-test: '
        + 'phase=swm-share Curator rejected the share']],
    }, [CREATE]],
    ['publish failed', {
      create: [[0, 'Knowledge asset create complete:']],
      publish: [[1, 'storage_ack_insufficient: 2 of 3 core acknowledgements']],
    }, [CREATE, PUBLISH]],
  ]) {
    await t.test(label, (t) => {
      const run = publishOnce(t, answers);
      assert.equal(run.rc, 1);
      assert.equal(run.repeats, 0);
      assert.deepEqual(run.calls, calls);
    });
  }
});

test('a publication shared at once is published without a repeat', (t) => {
  const run = publishOnce(t, {
    create: [[0, 'Knowledge asset create complete:']],
    publish: [[0, 'Knowledge asset VM publish complete']],
  });
  assert.equal(run.rc, 0);
  assert.equal(run.repeats, 0);
  assert.deepEqual(run.calls, [CREATE, PUBLISH]);
});

test('the soak publisher loop records a publication its repeated share saved as ok', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-soak-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The loop is written out by the soak script itself; run that text.
  const loop = /cat > "\$OUT_DIR\/publisher-loop\.sh" <<'EOLOOP'\n([\s\S]*?)\nEOLOOP\n/
    .exec(fs.readFileSync(soak, 'utf8'))?.[1];
  assert.ok(loop, 'the soak script writes its publisher loop from a heredoc');
  const loopPath = path.join(dir, 'publisher-loop.sh');
  fs.writeFileSync(loopPath, `${loop}\n`, { mode: 0o755 });
  const cliLog = path.join(dir, 'cli.jsonl');
  const cliPath = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(cliPath, `
    const fs = require('fs');
    const [verb, name] = process.argv.slice(3);
    fs.appendFileSync(process.env.CLI_LOG, JSON.stringify({ home: process.env.DKG_HOME, args: process.argv.slice(2) }) + '\\n');
    const calls = fs.readFileSync(process.env.CLI_LOG, 'utf8').trim().split('\\n').filter((line) => JSON.parse(line).args[1] === verb).length;
    if (verb === 'create') {
      console.error('Knowledge asset create/share completed partially for "' + name + '" in devnet-test: phase=swm-share A promote prerequisite is temporarily unavailable');
      process.exit(1);
    }
    if (verb === 'share' && calls === 1) {
      console.error('${REFUSED_SHARE}');
      process.exit(1);
    }
    console.log('Knowledge asset ' + verb + ' complete');
  `);
  // A stand-in for sleep: the share repeats return at once, the 3 s pause after
  // the publication is real, so the loop ends after exactly one publication.
  const realSleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'),
    `#!/bin/sh\necho "$1" >> "$SLEEP_LOG"\n[ "$1" = 3 ] && exec "${realSleep}" 3\nexit 0\n`, { mode: 0o755 });
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  const sleepLog = path.join(dir, 'sleep.log');
  const endTs = Math.floor(Date.now() / 1000) + 3;
  const run = spawnSync('bash', [loopPath, repoRoot, path.join(dir, 'devnet'), outDir, cliPath, '3', String(endTs),
    'fixture-token', '7'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLI_LOG: cliLog, SLEEP_LOG: sleepLog },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);

  const rows = fs.readFileSync(path.join(outDir, 'publish.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.status, 'ok');
  assert.equal(row.rc, 0);
  assert.equal(row.share_repeats, 2);
  assert.equal(row.node, 1);
  assert.equal(row.cg, 'devnet-test');
  assert.match(row.out, /phase=swm-share A promote prerequisite is temporarily unavailable/);
  assert.match(row.out, /Knowledge asset publish complete$/);
  const calls = fs.readFileSync(cliLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args[1]), ['create', 'share', 'share', 'publish']);
  assert.ok(calls.every((call) => call.home === path.join(dir, 'devnet', 'node1')));
  assert.ok(calls.every((call) => call.args[2] === calls[0].args[2]), 'every step names the same asset');
  assert.deepEqual(fs.readFileSync(sleepLog, 'utf8').trim().split('\n'), ['1', '2', '3']);
});
