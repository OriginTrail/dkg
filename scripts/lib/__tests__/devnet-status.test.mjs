import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
function pausedStatusCheck(statusBody, setup = '') {
  return spawnSync('bash', ['-c', `
    set -euo pipefail
    source "$1"
    healthy_count=123
    ${setup}
    status_body() { ${statusBody}
    }
    say() { :; }
    fail() { echo "$*" >&2; exit 1; }
    check_paused_store_status
  `, 'bash', join(root, 'scripts/devnet-lib.sh')], { encoding: 'utf8' });
}

test('store outage accepts a count refreshed between the healthy baseline and SIGSTOP', () => {
  const r = pausedStatusCheck(`
    if [ "$1" = '/api/status?probeStore=true' ]; then
      printf '%s' '{"storeReachability":"no-answer"}'
    else
      printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124}'
    fi
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('paused status rejects an ordinary read that probes the store', () => {
  const r = pausedStatusCheck(`printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124,"storeReachability":"reachable"}'`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ordinary status unexpectedly probed/);
});

test('paused status rejects a delayed second ordinary read', () => {
  const r = pausedStatusCheck(`
    local count="$(cat "$calls")"
    if [ "$1" = '/api/status?probeStore=true' ]; then
      printf '%s' '{"storeReachability":"no-answer"}'
    else
      [ "$count" != first ] || sleep 6
      printf first > "$calls"
      printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124}'
    fi
  `, `calls="$(mktemp)"; trap 'rm -f "$calls"' EXIT`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ordinary .*blocked/);
});

test('paused status rejects a second ordinary response carrying probe evidence', () => {
  const r = pausedStatusCheck(`
    if [ "$1" = '/api/status?probeStore=true' ]; then
      printf '%s' '{"storeReachability":"no-answer"}'
    elif [ -s "$calls" ]; then
      printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124,"storeReachability":"unreachable"}'
    else
      printf first > "$calls"
      printf '%s' '{"storeQuadsStatus":"ready","storeQuads":124}'
    fi
  `, `calls="$(mktemp)"; trap 'rm -f "$calls"' EXIT`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ordinary status unexpectedly probed/);
});

