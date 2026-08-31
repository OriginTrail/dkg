#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/artifacts/semantic-runtime-smoke/$(date -u +%Y%m%dT%H%M%SZ)}"
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$REPO_ROOT/$OUTPUT_DIR" ;;
esac

STRATEGY_PATH="${SMOKE_STRATEGY_PATH:-$REPO_ROOT/packages/semantic-runtime/smoke/llm-agent.scm}"
CONTEXT_GRAPH_ID="${SMOKE_CONTEXT_GRAPH_ID:-devnet-test}"
PROGRAM_IRI="${SMOKE_PROGRAM_IRI:-urn:sr:program:codex-live}"
TOOL_IRI="${SMOKE_TOOL_IRI:-urn:sr:tool:investigator-v1}"
POLICY_IRI="${SMOKE_POLICY_IRI:-urn:sr:policy:devnet-codex}"
SMOKE_DEVNET_DIR="$OUTPUT_DIR/devnet"
STATUS_PATH="$OUTPUT_DIR/dkg-status.json"
PROGRAM_REQUEST_PATH="$OUTPUT_DIR/program-request.json"
PUBLISH_PATH="$OUTPUT_DIR/program-publish.json"
VM_QUERY_REQUEST_PATH="$OUTPUT_DIR/program-vm-query-request.json"
VM_QUERY_PATH="$OUTPUT_DIR/program-vm-query.json"
INVOKE_REQUEST_PATH="$OUTPUT_DIR/program-invoke-request.json"
INVOKE_PATH="$OUTPUT_DIR/program-invoke.json"
AUTHORITY_REQUEST_PATH="$OUTPUT_DIR/operator-authority-request.json"
AUTHORITY_PUBLISH_PATH="$OUTPUT_DIR/operator-authority-publish.json"
CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/execution-vm-query-request.json"
CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/execution-vm-query-node-3.json"
AUDIT_QUERY_REQUEST_PATH="$OUTPUT_DIR/execution-audit-vm-query-request.json"
AUDIT_QUERY_PATH="$OUTPUT_DIR/execution-audit-vm-query-node-3.json"
UI_SCREENSHOT_PATH="$OUTPUT_DIR/dkg-node-ui-execution.png"
RECEIPT_PATH="$OUTPUT_DIR/receipt.json"
HARDHAT_PORT="${SMOKE_HARDHAT_PORT:-28545}"
API_PORT_BASE="${SMOKE_API_PORT:-29251}"
LIBP2P_PORT_BASE="${SMOKE_LIBP2P_PORT:-30051}"
OXIGRAPH_BASE="${SMOKE_OXIGRAPH_BASE:-37950}"
BLAZEGRAPH_PORT="${SMOKE_BLAZEGRAPH_PORT:-39950}"
LLM_PROVIDER="${SMOKE_LLM_PROVIDER:-codex}"

mkdir -p "$OUTPUT_DIR"

stop_devnet() {
  DEVNET_DIR="$SMOKE_DEVNET_DIR" \
  HARDHAT_PORT="$HARDHAT_PORT" \
  API_PORT_BASE="$API_PORT_BASE" \
  LIBP2P_PORT_BASE="$LIBP2P_PORT_BASE" \
  DEVNET_OXIGRAPH_BASE="$OXIGRAPH_BASE" \
  DEVNET_BLAZEGRAPH_PORT="$BLAZEGRAPH_PORT" \
  DEVNET_DOCKER_NAME_PREFIX="semantic-runtime-smoke" \
    "$REPO_ROOT/scripts/devnet.sh" stop >/dev/null 2>&1 || true
}
trap stop_devnet EXIT INT TERM

echo "semantic-runtime-live-smoke: output=$OUTPUT_DIR"
echo "semantic-runtime-live-smoke: strategy=$STRATEGY_PATH"
echo "semantic-runtime-live-smoke: starting real Hardhat + Oxigraph + DKG + Wasm"

DEVNET_DIR="$SMOKE_DEVNET_DIR" \
HARDHAT_PORT="$HARDHAT_PORT" \
API_PORT_BASE="$API_PORT_BASE" \
LIBP2P_PORT_BASE="$LIBP2P_PORT_BASE" \
DEVNET_OXIGRAPH_BASE="$OXIGRAPH_BASE" \
DEVNET_BLAZEGRAPH_PORT="$BLAZEGRAPH_PORT" \
DEVNET_DOCKER_NAME_PREFIX="semantic-runtime-smoke" \
DEVNET_NO_AUTH=1 \
NUM_CORE_NODES=4 \
DEVNET_NODE_READY_TIMEOUT=180 \
HARDHAT_BLOCK_INTERVAL_MS=0 \
DEVNET_ENABLE_SEMANTIC_RUNTIME=1 \
SEMANTIC_RUNTIME_LLM_PROVIDER="$LLM_PROVIDER" \
  "$REPO_ROOT/scripts/devnet.sh" start 4

API_URL="http://127.0.0.1:${API_PORT_BASE}"
API_URL_NODE_B="http://127.0.0.1:$((API_PORT_BASE + 1))"
API_URL_NODE_C="http://127.0.0.1:$((API_PORT_BASE + 2))"
curl --fail --silent --show-error "$API_URL/api/status" \
  --output "$STATUS_PATH"

if [ "$LLM_PROVIDER" != "codex" ] && [ -n "${SMOKE_LLM_API_KEY:-}" ]; then
  echo "semantic-runtime-live-smoke: configuring ephemeral real LLM adapter"
  node -e '
    const value = { apiKey: process.env.SMOKE_LLM_API_KEY, model: process.env.SMOKE_LLM_MODEL || "gpt-4o-mini" };
    if (process.env.SMOKE_LLM_BASE_URL) value.baseURL = process.env.SMOKE_LLM_BASE_URL;
    process.stdout.write(JSON.stringify(value));
  ' | curl --fail-with-body --silent --show-error \
    --request PUT \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$API_URL/api/settings/llm" \
    --output "$OUTPUT_DIR/llm-settings.json"
fi

SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
SMOKE_TOOL_IRI="$TOOL_IRI" \
SMOKE_STRATEGY_PATH="$STRATEGY_PATH" \
SMOKE_PROGRAM_REQUEST_PATH="$PROGRAM_REQUEST_PATH" \
SMOKE_VM_QUERY_REQUEST_PATH="$VM_QUERY_REQUEST_PATH" \
SMOKE_INVOKE_REQUEST_PATH="$INVOKE_REQUEST_PATH" \
node --input-type=module -e '
  import crypto from "node:crypto";
  import fs from "node:fs";
  const source = fs.readFileSync(process.env.SMOKE_STRATEGY_PATH, "utf8");
  const sr = "https://origintrail.io/semantic-runtime/v1#";
  const programIri = process.env.SMOKE_PROGRAM_IRI;
  const toolIri = process.env.SMOKE_TOOL_IRI;
  const contextGraphId = process.env.SMOKE_CONTEXT_GRAPH_ID;
  const quads = [
    { subject: programIri, predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", object: `${sr}Program` },
    { subject: programIri, predicate: `${sr}language`, object: JSON.stringify("sexpr-v1") },
    { subject: programIri, predicate: `${sr}version`, object: JSON.stringify("1.0.0") },
    { subject: programIri, predicate: `${sr}source`, object: JSON.stringify(source) },
    { subject: programIri, predicate: `${sr}requiresTool`, object: toolIri },
  ];
  fs.writeFileSync(process.env.SMOKE_PROGRAM_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    name: "semantic-program-two-agents",
    quads,
    alsoShareSwm: true,
    alsoPublishVm: true,
  }));
  fs.writeFileSync(process.env.SMOKE_VM_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    view: "verifiable-memory",
    sparql: `SELECT DISTINCT ?source WHERE { GRAPH ?g { <${programIri}> <${sr}source> ?source } }`,
  }));
  fs.writeFileSync(process.env.SMOKE_INVOKE_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    programIri,
    invocationId: crypto.randomUUID(),
  }));
'

echo "semantic-runtime-live-smoke: publishing the Program and required Tool reference to VM"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$PROGRAM_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$PUBLISH_PATH"

echo "semantic-runtime-live-smoke: publishing node B's Tool offer and selected Policy"
curl --fail-with-body --silent --show-error \
  "$API_URL_NODE_B/api/agent/identity" \
  --output "$OUTPUT_DIR/node-b-identity.json"
SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_TOOL_IRI="$TOOL_IRI" \
SMOKE_POLICY_IRI="$POLICY_IRI" \
SMOKE_NODE_IDENTITY_PATH="$OUTPUT_DIR/node-b-identity.json" \
SMOKE_AUTHORITY_REQUEST_PATH="$AUTHORITY_REQUEST_PATH" \
node --input-type=module -e '
  import fs from "node:fs";
  const sr = "https://origintrail.io/semantic-runtime/v1#";
  const rdfType = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const identity = JSON.parse(fs.readFileSync(process.env.SMOKE_NODE_IDENTITY_PATH, "utf8"));
  const tool = process.env.SMOKE_TOOL_IRI;
  const policy = process.env.SMOKE_POLICY_IRI;
  const operator = identity.agentDid;
  fs.writeFileSync(process.env.SMOKE_AUTHORITY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    name: "semantic-runtime-codex-authority",
    quads: [
      { subject: operator, predicate: `${sr}offersTool`, object: tool },
      { subject: tool, predicate: rdfType, object: `${sr}Tool` },
      { subject: tool, predicate: `${sr}operation`, object: JSON.stringify("agent/investigate") },
      { subject: tool, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: tool, predicate: `${sr}witInterface`, object: JSON.stringify("origintrail:semantic-tools/investigator@1") },
      { subject: operator, predicate: `${sr}usesExecutionPolicy`, object: policy },
      { subject: policy, predicate: rdfType, object: `${sr}ExecutionPolicy` },
      { subject: policy, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: policy, predicate: `${sr}allowsTool`, object: tool },
    ],
    alsoShareSwm: true,
    alsoPublishVm: true,
  }));
'
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$AUTHORITY_REQUEST_PATH" \
  "$API_URL_NODE_B/api/knowledge-assets" \
  --output "$AUTHORITY_PUBLISH_PATH"

echo "semantic-runtime-live-smoke: querying the stored source from VM"
vm_ready=0
for _ in $(seq 1 30); do
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$VM_QUERY_REQUEST_PATH" \
    "$API_URL_NODE_B/api/query" \
    --output "$VM_QUERY_PATH"
  if SMOKE_VM_QUERY_PATH="$VM_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.env.SMOKE_VM_QUERY_PATH, "utf8"));
    process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
  '; then
    vm_ready=1
    break
  fi
  sleep 1
done
if [ "$vm_ready" != "1" ]; then
  echo "semantic-runtime-live-smoke: program did not appear in VM" >&2
  cat "$VM_QUERY_PATH" >&2
  exit 1
fi

echo "semantic-runtime-live-smoke: opening the real node B DKG UI and clicking Run Program"
(
  cd "$REPO_ROOT/packages/node-ui"
  SMOKE_UI_URL="$API_URL_NODE_B/ui" \
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
  SMOKE_INVOKE_PATH="$INVOKE_PATH" \
  SMOKE_SCREENSHOT_PATH="$UI_SCREENSHOT_PATH" \
  SMOKE_VIDEO_DIR="$OUTPUT_DIR/video" \
  node --input-type=module -e '
    import fs from "node:fs";
    import { chromium } from "@playwright/test";
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ recordVideo: { dir: process.env.SMOKE_VIDEO_DIR } });
    const page = await context.newPage();
    await page.goto(process.env.SMOKE_UI_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".v10-app").waitFor({ state: "visible", timeout: 60_000 });
    const projectName = /devnet-test|Devnet Test/i;
    const myProject = page.locator(".v10-peer-group-body .v10-tree-section-header")
      .filter({ hasText: projectName }).first();
    if (await myProject.isVisible().catch(() => false)) {
      await myProject.click();
    } else {
      // Node B is not the graph curator, so an open devnet graph correctly
      // appears in the native Context Oracle rather than "My Context Graphs".
      await page.locator(".v10-tree-mode-btn").filter({ hasText: "Context Oracle" }).click();
      const discovered = page.locator(".v10-tree-section-header")
        .filter({ hasText: projectName }).first();
      await discovered.waitFor({ state: "visible", timeout: 60_000 });
      const browse = discovered.getByRole("button", { name: /Browse/i });
      if (await browse.isVisible().catch(() => false)) await browse.click();
      else await discovered.click();
    }
    await page.locator(".v10-memory-explorer").waitFor({ state: "visible", timeout: 60_000 });
    const panel = page.locator("[data-testid=semantic-program-panel]");
    for (let attempt = 0; attempt < 30 && !(await panel.isVisible().catch(() => false)); attempt += 1) {
      await page.evaluate(({ contextGraphId, entityUri }) => {
        window.dispatchEvent(new CustomEvent("v10:open-entity", { detail: { contextGraphId, entityUri } }));
      }, { contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID, entityUri: process.env.SMOKE_PROGRAM_IRI });
      await page.waitForTimeout(1_000);
    }
    await panel.waitFor({ state: "visible", timeout: 30_000 });
    const authority = await panel.textContent();
    for (const expected of ["requested", "offered", "policy allowed", "installed", "enabled"]) {
      if (!authority?.includes(expected)) throw new Error(`DKG UI did not show ${expected}: ${authority}`);
    }
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/semantic-runtime/invoke")
      && response.request().method() === "POST", { timeout: 180_000 });
    await page.locator("[data-testid=run-semantic-program]").click();
    const response = await responsePromise;
    const body = await response.json();
    if (!response.ok() || body.persisted !== true || !body.executionIri || !body.executionUal) {
      throw new Error(`UI invocation did not confirm persistence: ${response.status()} ${JSON.stringify(body)}`);
    }
    fs.writeFileSync(process.env.SMOKE_INVOKE_PATH, JSON.stringify(body, null, 2));
    await page.locator(".v10-ka-ual").filter({ hasText: body.executionIri })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: process.env.SMOKE_SCREENSHOT_PATH, fullPage: true });
    await context.close();
    await browser.close();
  '
)

EXECUTION_IRI=$(SMOKE_INVOKE_PATH="$INVOKE_PATH" node --input-type=module -e '
  import fs from "node:fs";
  process.stdout.write(JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8")).executionIri);
')
SMOKE_EXECUTION_IRI="$EXECUTION_IRI" \
SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_QUERY_REQUEST_PATH="$CROSS_NODE_QUERY_REQUEST_PATH" \
SMOKE_AUDIT_QUERY_REQUEST_PATH="$AUDIT_QUERY_REQUEST_PATH" \
node --input-type=module -e '
  import fs from "node:fs";
  const sr = "https://origintrail.io/semantic-runtime/v1#";
  fs.writeFileSync(process.env.SMOKE_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    view: "verifiable-memory",
    sparql: `SELECT ?output ?outputHash ?status WHERE {
      GRAPH ?g {
        <${process.env.SMOKE_EXECUTION_IRI}>
          a <${sr}Execution> ;
          <${sr}output> ?output ;
          <${sr}outputHash> ?outputHash ;
          <${sr}status> ?status .
      }
    }`,
  }));
  fs.writeFileSync(process.env.SMOKE_AUDIT_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    view: "verifiable-memory",
    sparql: `SELECT ?executedBy ?policy ?tool ?adapterVersion ?adapterHash WHERE {
      GRAPH ?g {
        <${process.env.SMOKE_EXECUTION_IRI}>
          <${sr}executedBy> ?executedBy ;
          <${sr}appliedPolicy> ?policy ;
          <${sr}usedTool> ?tool ;
          <${sr}adapterVersion> ?adapterVersion ;
          <${sr}adapterHash> ?adapterHash .
      }
    }`,
  }));
'

echo "semantic-runtime-live-smoke: querying node C Verifiable Memory for the Execution"
execution_ready=0
for _ in $(seq 1 90); do
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$CROSS_NODE_QUERY_REQUEST_PATH" \
    "$API_URL_NODE_C/api/query" \
    --output "$CROSS_NODE_QUERY_PATH"
  if SMOKE_QUERY_PATH="$CROSS_NODE_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
    process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
  '; then
    execution_ready=1
    break
  fi
  sleep 1
done
if [ "$execution_ready" != "1" ]; then
  echo "semantic-runtime-live-smoke: node C did not observe exactly one Execution" >&2
  cat "$CROSS_NODE_QUERY_PATH" >&2
  exit 1
fi

curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$AUDIT_QUERY_REQUEST_PATH" \
  "$API_URL_NODE_C/api/query" \
  --output "$AUDIT_QUERY_PATH"

SMOKE_STATUS_PATH="$STATUS_PATH" \
SMOKE_PUBLISH_PATH="$PUBLISH_PATH" \
SMOKE_INVOKE_PATH="$INVOKE_PATH" \
SMOKE_CROSS_QUERY_PATH="$CROSS_NODE_QUERY_PATH" \
SMOKE_AUDIT_QUERY_PATH="$AUDIT_QUERY_PATH" \
SMOKE_RECEIPT_PATH="$RECEIPT_PATH" \
SMOKE_WASM_MANIFEST="$REPO_ROOT/packages/semantic-runtime/generated/integrity.json" \
node --input-type=module -e '
  import crypto from "node:crypto";
  import fs from "node:fs";
  const term = (value) => typeof value === "object" && value !== null ? value.value :
    (typeof value === "string" && value.startsWith("\"") ? JSON.parse(value) : value);
  const invocation = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8"));
  const query = JSON.parse(fs.readFileSync(process.env.SMOKE_CROSS_QUERY_PATH, "utf8"));
  const audit = JSON.parse(fs.readFileSync(process.env.SMOKE_AUDIT_QUERY_PATH, "utf8"));
  const rows = query.result?.bindings ?? [];
  if (rows.length !== 1) throw new Error(`expected exactly one Execution, got ${rows.length}`);
  const output = term(rows[0].output);
  const outputHash = term(rows[0].outputHash);
  const status = term(rows[0].status);
  if (output !== "semantic-runtime-llm-ok") throw new Error(`unexpected Codex output: ${JSON.stringify(output)}`);
  const expectedHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(output, "utf8")).digest("hex")}`;
  if (outputHash !== expectedHash) throw new Error(`output hash mismatch: ${outputHash} != ${expectedHash}`);
  if (status !== "https://origintrail.io/semantic-runtime/v1#Succeeded") throw new Error(`unexpected status: ${status}`);
  const auditRows = audit.result?.bindings ?? [];
  if (auditRows.length !== 1) throw new Error(`expected exactly one Execution audit row, got ${auditRows.length}`);
  const auditRow = Object.fromEntries(Object.entries(auditRows[0]).map(([key, value]) => [key, term(value)]));
  if (auditRow.policy !== "urn:sr:policy:devnet-codex") throw new Error(`unexpected policy: ${auditRow.policy}`);
  if (auditRow.tool !== "urn:sr:tool:investigator-v1") throw new Error(`unexpected tool: ${auditRow.tool}`);
  if (auditRow.adapterVersion !== "1") throw new Error(`unexpected adapter version: ${auditRow.adapterVersion}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(String(auditRow.adapterHash))) throw new Error(`invalid adapter hash: ${auditRow.adapterHash}`);
  if (!String(auditRow.executedBy).startsWith("did:dkg:agent:")) throw new Error(`invalid executing node: ${auditRow.executedBy}`);
  const evidence = {
    recordedAt: new Date().toISOString(),
    mode: "real-four-node-dkg-ui-wasm-codex-cross-node-vm",
    queriedNode: "node-c",
    invocation,
    crossNodeVmResult: rows[0],
    crossNodeVmAudit: auditRow,
    wasmSha256: JSON.parse(fs.readFileSync(process.env.SMOKE_WASM_MANIFEST, "utf8")).files["cjs/runtime_bg.wasm"].sha256,
  };
  fs.writeFileSync(process.env.SMOKE_RECEIPT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
'

echo "semantic-runtime-live-smoke: PASS receipt=$RECEIPT_PATH"

stop_devnet
trap - EXIT INT TERM
if [ "$SMOKE_DEVNET_DIR" = "$OUTPUT_DIR/devnet" ] && [ "$OUTPUT_DIR" != "/" ] \
  && command -v trash >/dev/null 2>&1; then
  trash "$SMOKE_DEVNET_DIR"
  echo "semantic-runtime-live-smoke: removed ephemeral devnet state and test credentials"
fi
