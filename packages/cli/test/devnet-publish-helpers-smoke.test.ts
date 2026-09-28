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
      await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps large create planning and growing response state off env/argv', async () => {
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
      receipt: "r".repeat(24_000),
    }));
  '
}

tr -d '\r' < scripts/devnet-publish-helpers.sh > "$DEVNET_DIR/devnet-publish-helpers.sh"
source "$DEVNET_DIR/devnet-publish-helpers.sh"

payload="$(node <<'NODE'
const roots = 96;
const pad = "x".repeat(4_096);
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

CREATE_FILE="$DEVNET_DIR/create.json"
devnet_create_shared_ka node-a "$payload" large > "$CREATE_FILE"

CREATE_FILE="$CREATE_FILE" node <<'NODE'
const fs = require('fs');
const calls = fs.readFileSync(process.env.CALLS_FILE, 'utf8')
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (calls.length !== 96) throw new Error('expected 96 create calls, got ' + calls.length);
if (calls.some((call) => call.method !== 'POST' || call.path !== '/api/knowledge-assets')) {
  throw new Error('unexpected route: ' + JSON.stringify(calls));
}
if (calls.some((call) => call.quadCount !== 1)) {
  throw new Error('large payload should be split into one-root assets: ' + JSON.stringify(calls));
}
const create = JSON.parse(fs.readFileSync(process.env.CREATE_FILE, 'utf8'));
if (create.triplesWritten !== 96 || create.names.length !== 96 || create.rootEntities.length !== 96) {
  throw new Error('unexpected create response counts: ' + JSON.stringify({
    triplesWritten: create.triplesWritten,
    names: create.names?.length,
    rootEntities: create.rootEntities?.length,
  }));
}
if (create.responses.length !== 96 || create.responses.some((response) => response.receipt.length !== 24_000)) {
  throw new Error('response accumulator was not preserved');
}
NODE
`;

    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-devnet-helper-large-smoke-'));
    const scriptPath = join(tempDir, 'smoke-large.sh');
    try {
      await writeFile(scriptPath, script.replace(/\r\n/g, '\n'), 'utf8');
      await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('scopes published-root verification queries and fails on an error answer', async () => {
    const repoRoot = resolve(process.cwd(), '../..');
    const script = String.raw`
set -euo pipefail
DEVNET_DIR="/tmp/devnet-publish-verify-smoke-$$"
rm -rf "$DEVNET_DIR"
mkdir -p "$DEVNET_DIR"
trap 'rm -rf "$DEVNET_DIR"' EXIT
CALLS_FILE="$DEVNET_DIR/calls.jsonl"
QUERY_MODE_FILE="$DEVNET_DIR/query-mode"
DEVNET_QUERY_RETRY_DELAY_S=0
export DEVNET_DIR CALLS_FILE QUERY_MODE_FILE DEVNET_QUERY_RETRY_DELAY_S
MERKLE="0x$(printf 'ab%.0s' $(seq 1 32))"
export MERKLE

# Mocks the daemon on a store without all-writer consistency coverage: an
# /api/query without contextGraphId gets the v10.0.17 fail-closed error body
# (curl -sS still exits 0 on an HTTP error status).
api_call() {
  local node_id="$1" method="$2" path="$3" data="{}"
  if [ "$#" -ge 4 ]; then
    data="$4"
  fi
  CALL_NODE="$node_id" CALL_METHOD="$method" CALL_PATH="$path" CALL_DATA="$data" node -e '
    const fs = require("fs");
    const call = {
      node: process.env.CALL_NODE,
      method: process.env.CALL_METHOD,
      path: process.env.CALL_PATH,
      data: JSON.parse(process.env.CALL_DATA || "{}"),
    };
    fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(call) + "\n");
    const answer = (() => {
      if (call.method === "POST" && call.path === "/api/knowledge-assets") {
        return {
          status: "swm-shared",
          name: call.data.name,
          promotedCount: call.data.quads.length,
          swmShared: true,
          sealed: true,
          publishReady: true,
          shareOperationId: "share-" + call.data.name,
        };
      }
      if (call.method === "POST" && /^\/api\/knowledge-assets\/[^/]+\/vm\/publish$/.test(call.path)) {
        const published = fs.readFileSync(process.env.CALLS_FILE, "utf8").split("\n")
          .filter((line) => line.includes("/vm/publish")).length;
        return { status: "confirmed", kaId: String(100 + published), contextGraphId: call.data.contextGraphId };
      }
      if (call.method === "GET" && call.path.startsWith("/api/kc/")) {
        return { merkleRoot: process.env.MERKLE };
      }
      if (call.method === "POST" && call.path === "/api/query") {
        if (!call.data.contextGraphId) {
          return { error: "Unscoped query requires a store with all-writer consistency coverage; specify contextGraphId to scope the query" };
        }
        const mode = fs.existsSync(process.env.QUERY_MODE_FILE)
          ? fs.readFileSync(process.env.QUERY_MODE_FILE, "utf8").trim()
          : "ok";
        if (mode === "retry-once") {
          fs.writeFileSync(process.env.QUERY_MODE_FILE, "ok");
          return { error: "Context Graph read authority is temporarily unavailable", code: "CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE", retryable: true };
        }
        if (mode === "error") return { error: "Scoped query violation: rejected" };
        if (call.data.sparql.includes("privateMerkleRoot")) {
          return { result: { type: "bindings", bindings: [{ privateRoot: JSON.stringify("cd".repeat(32)) }] } };
        }
        if (call.data.sparql.includes("assertionGraph")) {
          return { result: { type: "bindings", bindings: [{ p: "http://schema.org/name", o: JSON.stringify("Catalog") }] } };
        }
      }
      if (call.method === "POST" && call.path === "/api/shared-memory/verify-batch") {
        return { ok: true, actualRoot: call.data.expectedMerkleRoot };
      }
      return null;
    })();
    console.log(JSON.stringify(answer ?? { error: "unexpected call " + call.method + " " + call.path }));
    if (!answer) process.exit(1);
  '
}

tr -d '\r' < scripts/devnet-publish-helpers.sh > "$DEVNET_DIR/devnet-publish-helpers.sh"
source "$DEVNET_DIR/devnet-publish-helpers.sh"

payload='{"contextGraphId":"cg-verify","quads":[{"subject":"urn:root:a","predicate":"http://schema.org/name","object":"\"A\""},{"subject":"urn:root:b","predicate":"http://schema.org/name","object":"\"B\""}]}'
devnet_create_shared_ka node-a "$payload" verify > /dev/null
devnet_publish_load_state
devnet_publish_swm_all_roots node-a cg-verify false > /dev/null

# The first query answers with the retryable 503 body; the helper must retry.
: > "$CALLS_FILE"
echo retry-once > "$QUERY_MODE_FILE"
devnet_verify_each_published_root node-b cg-verify "$payload" \
  || { echo "verification failed with scoped queries" >&2; exit 1; }
cp "$CALLS_FILE" "$DEVNET_DIR/scoped.jsonl"

: > "$CALLS_FILE"
echo error > "$QUERY_MODE_FILE"
if devnet_verify_each_published_root node-b cg-verify "$payload" 2> "$DEVNET_DIR/error.log"; then
  echo "verification passed on an error answer" >&2
  exit 1
fi
cp "$CALLS_FILE" "$DEVNET_DIR/errored.jsonl"

node <<'NODE'
const fs = require('fs');
const dir = process.env.DEVNET_DIR;
const read = (name) => fs.readFileSync(dir + '/' + name, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const queriesOf = (calls) => calls.filter((call) => call.method === 'POST' && call.path === '/api/query');
const verifiesOf = (calls) => calls.filter((call) => call.path === '/api/shared-memory/verify-batch');

const scoped = read('scoped.jsonl');
const queries = queriesOf(scoped);
// Two queries per root, plus one retry of the first.
if (queries.length !== 5) throw new Error('expected 5 queries, got ' + JSON.stringify(queries));
if (JSON.stringify(queries[0].data) !== JSON.stringify(queries[1].data)) {
  throw new Error('a retryable answer must retry the same query: ' + JSON.stringify(queries.slice(0, 2)));
}
for (const query of queries) {
  if (query.data.contextGraphId !== 'cg-verify') {
    throw new Error('/api/query must be scoped to the context graph: ' + JSON.stringify(query));
  }
  if (query.node !== 'node-a') throw new Error('metadata must be read from the publish node: ' + JSON.stringify(query));
}
const catalog = queries.filter((query) => query.data.sparql.includes('assertionGraph'));
if (catalog.length !== 2 || catalog.some((query) => query.data.includeContextGraphPartitions !== true)) {
  throw new Error('catalog query must set includeContextGraphPartitions: ' + JSON.stringify(catalog));
}
const verifies = verifiesOf(scoped);
if (verifies.length !== 2) throw new Error('expected one verify-batch per root, got ' + verifies.length);
for (const verify of verifies) {
  if (verify.node !== 'node-b') throw new Error('verify-batch must run on the verifier node: ' + JSON.stringify(verify));
  if (JSON.stringify(verify.data.privateRoots) !== JSON.stringify(['0x' + 'cd'.repeat(32)])) {
    throw new Error('verify-batch must carry the private roots: ' + JSON.stringify(verify.data));
  }
  if (!verify.data.quads.some((quad) => quad.subject === 'did:dkg:context-graph:cg-verify' && quad.object === '"Catalog"')) {
    throw new Error('verify-batch must carry the catalog quads: ' + JSON.stringify(verify.data));
  }
}

const errored = read('errored.jsonl');
if (queriesOf(errored).length !== 1 || verifiesOf(errored).length !== 0) {
  throw new Error('an error answer must stop verification: ' + JSON.stringify(errored));
}
if (!fs.readFileSync(dir + '/error.log', 'utf8').includes('Scoped query violation: rejected')) {
  throw new Error('the error answer must be reported');
}
NODE
`;

    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-devnet-helper-verify-smoke-'));
    const scriptPath = join(tempDir, 'smoke-verify.sh');
    try {
      await writeFile(scriptPath, script.replace(/\r\n/g, '\n'), 'utf8');
      await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
  for (const [label, retryableError] of [
    ['gossip prerequisite', '[promote:encodeWorkspaceGossipPayload] A promote prerequisite is temporarily unavailable'],
    ['legacy boundary retirement', 'RFC-64 legacy SWM boundary retirement is in progress; retry promotion'],
  ]) {
  it(`resumes a sealed named asset through the share route after ${label}`, async () => {
    const repoRoot = resolve(process.cwd(), '../..');
    const script = String.raw`
set -euo pipefail
DEVNET_DIR="$(mktemp -d)"
trap 'rm -rf "$DEVNET_DIR"' EXIT
CALLS_FILE="$DEVNET_DIR/calls.jsonl"
export DEVNET_DIR CALLS_FILE

api_call() {
  local node_id="$1" method="$2" path="$3" data="$4"
  CALL_DATA="$data" CALL_PATH="$path" node -e '
    const fs=require("fs"); const body=JSON.parse(process.env.CALL_DATA);
    fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({path:process.env.CALL_PATH,body})+"\n");
    if (process.env.CALL_PATH==="/api/knowledge-assets") {
      const calls=fs.readFileSync(process.env.CALLS_FILE,"utf8").trim().split("\n").length;
      if (calls!==1) console.log(JSON.stringify({code:"KA_ASSERTION_ALREADY_FINALIZED"}));
      else console.log(JSON.stringify({created:true,status:"wm-sealed",errors:[
        {phase:"swm-share",error:process.env.RETRYABLE_PROMOTION_ERROR}
      ]}));
    } else if (/^\/api\/knowledge-assets\/retry-.*\/swm\/share$/.test(process.env.CALL_PATH)) {
      const calls=fs.readFileSync(process.env.CALLS_FILE,"utf8").trim().split("\n").length;
      if (calls===2) console.log(JSON.stringify({error:process.env.RETRYABLE_PROMOTION_ERROR}));
      else console.log(JSON.stringify({status:"swm-shared",swmShared:true,publishReady:true,
        shareOperationId:"durable-original-share",promotedCount:0}));
    } else throw new Error("unexpected route: "+process.env.CALL_PATH);
  '
}

source scripts/devnet-publish-helpers.sh
payload='{"contextGraphId":"cg-retry","quads":[{"subject":"urn:retry:1","predicate":"http://schema.org/name","object":"\"retry\""}]}'
response="$(devnet_create_shared_ka node-a "$payload" retry)"
CREATE_RESPONSE="$response" node -e '
  const fs=require("fs"); const calls=fs.readFileSync(process.env.CALLS_FILE,"utf8").trim().split("\n").map(JSON.parse);
  if (calls.length!==3 || calls[0].path!=="/api/knowledge-assets"
    || calls[1].path!=="/api/knowledge-assets/"+calls[0].body.name+"/swm/share"
    || calls[2].path!==calls[1].path)
    throw new Error("retry did not resume the sealed named asset through SWM share");
  if (calls.slice(1).some(call => call.body.contextGraphId!==calls[0].body.contextGraphId || "quads" in call.body))
    throw new Error("share replay used a create body");
  if (JSON.parse(process.env.CREATE_RESPONSE).triplesWritten!==1) throw new Error("retry did not share");
'
`;
    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-devnet-helper-retry-smoke-'));
    const scriptPath = join(tempDir, 'smoke-retry.sh');
    try {
      await writeFile(scriptPath, script.replace(/\r\n/g, '\n'), 'utf8');
      await execFileAsync('bash', [toWslPath(scriptPath)], {
        cwd: repoRoot,
        env: { ...process.env, RETRYABLE_PROMOTION_ERROR: retryableError },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
  }
});
