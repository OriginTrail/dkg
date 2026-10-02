import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../devnet-curated-join-helpers.sh', import.meta.url));

test('curated join retries delivery with one signature and waits for delayed local approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-curated-join-'));
  try {
    const script = `
      source "$1"
      devnet_connect_member_to_curator() { return 0; }
      api_call() { printf '%s' '{"peerId":"curator-peer"}'; }
      devnet_json_field() {
        JSON_BODY="$1" node -e 'console.log(JSON.parse(process.env.JSON_BODY)[process.argv[1].slice(1)] ?? "")' "$2"
      }
      sleep() { :; }
      _devnet_member_api() {
        local method="$2" route="$3" body="\${4:-}" count
        case "$method $route" in
          'POST /api/context-graph/cg-1/sign-join')
            printf 'SIGN\\n' >> "$TRACE"
            printf '%s' '{"ok":true,"delegation":{"nonce":"fixed"}}'
            ;;
          'POST /api/context-graph/cg-1/request-join')
            printf 'REQUEST %s\\n' "$body" >> "$TRACE"
            count=$(grep -c '^REQUEST ' "$TRACE")
            if [ "$count" -eq 1 ]; then
              printf '%s' '{"status":"pending","delivered":0}'
            else
              printf '%s' '{"status":"approved","delivered":1}'
            fi
            ;;
          'GET /api/context-graph/cg-1/participants')
            printf 'POLL\\n' >> "$TRACE"
            count=$(grep -c '^POLL$' "$TRACE")
            if [ "$count" -lt 5 ]; then
              printf '%s' '{"allowedAgents":[]}'
            else
              printf '%s' '{"allowedAgents":["0xabc"]}'
            fi
            ;;
          'POST /api/subscribe') printf '%s' '{"subscribed":"cg-1"}' ;;
          *) return 1 ;;
        esac
      }
      devnet_join_curated_member 6 5 cg-1 0xABC
    `;
    const trace = path.join(dir, 'trace');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script, '--', helper], {
      env: { ...process.env, TRACE: trace }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = fs.readFileSync(trace, 'utf8').trim().split('\n');
    assert.equal(rows.filter((row) => row === 'SIGN').length, 1);
    const requests = rows.filter((row) => row.startsWith('REQUEST '));
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal(rows.filter((row) => row === 'POLL').length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
