import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

function toWslPath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`);
}

describe('devnet publish helper smoke', () => {
  it('routes create/share and publish through named KA lifecycle helpers', async () => {
    const repoRoot = resolve(process.cwd(), '../..');
    const script = String.raw`
set -euo pipefail
DEVNET_DIR="/tmp/devnet-publish-smoke-$$"
rm -rf "$DEVNET_DIR"
mkdir -p "$DEVNET_DIR"
CALLS_FILE="$DEVNET_DIR/calls.jsonl"
export DEVNET_DIR CALLS_FILE

api_call() {
  local node_id="$1" method="$2" path="$3" data="{}"
  if [ "$#" -ge 4 ]; then
    data="$4"
  fi
  CALL_NODE="$node_id" CALL_METHOD="$method" CALL_PATH="$path" CALL_DATA="$data" node -e '
    const fs = require("fs");
    fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({
      node: process.env.CALL_NODE,
      method: process.env.CALL_METHOD,
      path: process.env.CALL_PATH,
      data: JSON.parse(process.env.CALL_DATA || "{}"),
    }) + "\n");
  '
  if [ "$method" = "POST" ] && [ "$path" = "/api/knowledge-assets" ]; then
    BODY="$data" node -e '
      const body = JSON.parse(process.env.BODY);
      console.log(JSON.stringify({
        status: "swm-shared",
        name: body.name,
        written: Array.isArray(body.quads) ? body.quads.length : 0,
        promotedCount: Array.isArray(body.quads) ? body.quads.length : 0,
        swmShared: true,
        sealed: true,
        publishReady: true,
        shareOperationId: "share-" + body.name,
      }));
    '
    return 0
  fi
  if [ "$method" = "POST" ] && [[ "$path" == /api/knowledge-assets/*/vm/publish ]]; then
    BODY="$data" node -e '
      const body = JSON.parse(process.env.BODY);
      console.log(JSON.stringify({
        status: "confirmed",
        ual: "did:dkg:31337/0x1111111111111111111111111111111111111111/1",
        contextGraphId: body.contextGraphId,
      }));
    '
    return 0
  fi
  printf '{"error":"unexpected call","path":%q}\n' "$path"
  return 1
}

tr -d '\r' < scripts/devnet-publish-helpers.sh > "$DEVNET_DIR/devnet-publish-helpers.sh"
source "$DEVNET_DIR/devnet-publish-helpers.sh"

payload='{"contextGraphId":"cg-smoke","quads":[{"subject":"urn:root:a","predicate":"http://schema.org/name","object":"\"A\""},{"subject":"urn:root:b","predicate":"http://schema.org/name","object":"\"B\""}]}'
create_resp="$(devnet_create_shared_ka node-a "$payload" smoke)"
devnet_publish_load_state
publish_resp="$(devnet_publish_swm_all_roots node-a cg-smoke true)"

CREATE_RESP="$create_resp" PUBLISH_RESP="$publish_resp" node <<'NODE'
const fs = require('fs');
const calls = fs.readFileSync(process.env.CALLS_FILE, 'utf8')
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/knowledge-assets');
const publishCalls = calls.filter((call) =>
  call.method === 'POST' &&
  call.path.startsWith('/api/knowledge-assets/') &&
  call.path.endsWith('/vm/publish')
);
if (createCalls.length !== 2) throw new Error('expected 2 KA create calls, got ' + createCalls.length);
if (publishCalls.length !== 2) throw new Error('expected 2 KA publish calls, got ' + publishCalls.length);
for (const call of createCalls) {
  if (call.data.finalize !== true || call.data.alsoShareSwm !== true) {
    throw new Error('create helper must request finalize+SWM share: ' + JSON.stringify(call));
  }
}
if (calls.some((call) => call.path.includes('/shared-memory') || call.path.includes('/api/publisher/enqueue'))) {
  throw new Error('legacy route used: ' + JSON.stringify(calls));
}
if (publishCalls[0].data.options.clearAfter !== false) {
  throw new Error('first publish should keep SWM for later assets: ' + JSON.stringify(publishCalls[0]));
}
if (publishCalls[1].data.options.clearAfter !== true) {
  throw new Error('last publish should honor caller clearAfter=true: ' + JSON.stringify(publishCalls[1]));
}
const create = JSON.parse(process.env.CREATE_RESP);
if (create.triplesWritten !== 2 || create.names.length !== 2 || create.rootEntities.length !== 2) {
  throw new Error('unexpected create response: ' + process.env.CREATE_RESP);
}
const publish = JSON.parse(process.env.PUBLISH_RESP);
if (publish.status !== 'confirmed') throw new Error('unexpected publish response: ' + process.env.PUBLISH_RESP);
NODE
`;

    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-devnet-helper-smoke-'));
    const scriptPath = join(tempDir, 'smoke.sh');
    try {
      await writeFile(scriptPath, script.replace(/\r\n/g, '\n'), 'utf8');
      const { stderr } = await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      expect(stderr).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('streams large create payload planning through stdin instead of env/argv', async () => {
    const repoRoot = resolve(process.cwd(), '../..');
    const script = String.raw`
set -euo pipefail
DEVNET_DIR="/tmp/devnet-publish-large-smoke-$$"
rm -rf "$DEVNET_DIR"
mkdir -p "$DEVNET_DIR"
CALLS_FILE="$DEVNET_DIR/calls.jsonl"
export DEVNET_DIR CALLS_FILE

api_call() {
  local node_id="$1" method="$2" path="$3" data="{}"
  if [ "$#" -ge 4 ]; then
    data="$4"
  fi
  CALL_NODE="$node_id" CALL_METHOD="$method" CALL_PATH="$path" CALL_DATA="$data" node -e '
    const fs = require("fs");
    const body = JSON.parse(process.env.CALL_DATA || "{}");
    fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({
      node: process.env.CALL_NODE,
      method: process.env.CALL_METHOD,
      path: process.env.CALL_PATH,
      quadCount: Array.isArray(body.quads) ? body.quads.length : 0,
    }) + "\n");
    console.log(JSON.stringify({
      status: "swm-shared",
      name: body.name,
      written: Array.isArray(body.quads) ? body.quads.length : 0,
      promotedCount: Array.isArray(body.quads) ? body.quads.length : 0,
      swmShared: true,
      sealed: true,
      publishReady: true,
      shareOperationId: "share-" + body.name,
    }));
  '
}

tr -d '\r' < scripts/devnet-publish-helpers.sh > "$DEVNET_DIR/devnet-publish-helpers.sh"
source "$DEVNET_DIR/devnet-publish-helpers.sh"

payload="$(node <<'NODE'
const roots = 10;
const pad = "x".repeat(40_000);
const quads = [];
for (let i = 0; i < roots; i++) {
  quads.push({
    subject: "urn:large:" + i,
    predicate: "http://schema.org/text",
    object: JSON.stringify(pad + "-" + i),
  });
}
console.log(JSON.stringify({ contextGraphId: "cg-large-smoke", quads }));
NODE
)"

create_resp="$(devnet_create_shared_ka node-a "$payload" large)"

CREATE_RESP="$create_resp" node <<'NODE'
const fs = require('fs');
const calls = fs.readFileSync(process.env.CALLS_FILE, 'utf8')
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (calls.length !== 10) throw new Error('expected 10 create calls, got ' + calls.length);
if (calls.some((call) => call.method !== 'POST' || call.path !== '/api/knowledge-assets')) {
  throw new Error('unexpected route: ' + JSON.stringify(calls));
}
if (calls.some((call) => call.quadCount !== 1)) {
  throw new Error('large payload should be split into one-root assets: ' + JSON.stringify(calls));
}
const create = JSON.parse(process.env.CREATE_RESP);
if (create.triplesWritten !== 10 || create.names.length !== 10 || create.rootEntities.length !== 10) {
  throw new Error('unexpected create response: ' + process.env.CREATE_RESP);
}
NODE
`;

    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-devnet-helper-large-smoke-'));
    const scriptPath = join(tempDir, 'smoke-large.sh');
    try {
      await writeFile(scriptPath, script.replace(/\r\n/g, '\n'), 'utf8');
      const { stderr } = await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      expect(stderr).toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
