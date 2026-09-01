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
FORK_PROGRAM_IRI="${SMOKE_FORK_PROGRAM_IRI:-urn:sr:program:codex-live-fork}"
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
REMOTE_INVOKE_DENIAL_PATH="$OUTPUT_DIR/program-remote-invoke-denial.json"
AUTHORITY_REQUEST_PATH="$OUTPUT_DIR/operator-authority-request.json"
AUTHORITY_PUBLISH_PATH="$OUTPUT_DIR/operator-authority-publish.json"
FORK_OWNER_AUTHORITY_REQUEST_PATH="$OUTPUT_DIR/fork-owner-authority-request.json"
FORK_OWNER_AUTHORITY_PUBLISH_PATH="$OUTPUT_DIR/fork-owner-authority-publish.json"
FORK_PATH="$OUTPUT_DIR/program-fork.json"
FORK_VM_QUERY_REQUEST_PATH="$OUTPUT_DIR/program-fork-vm-query-request.json"
FORK_VM_QUERY_PATH="$OUTPUT_DIR/program-fork-vm-query-node-3.json"
FORK_RESOLVE_PATH="$OUTPUT_DIR/program-fork-resolve-node-1.json"
PROGRAM_AUTHOR_IDENTITY_PATH="$OUTPUT_DIR/program-author-identity.json"
INVOKING_NODE_IDENTITY_PATH="$OUTPUT_DIR/invoking-node-identity.json"
PARTICIPANT_ADD_PATH="$OUTPUT_DIR/invoking-wallet-membership.json"
CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/execution-vm-query-request.json"
CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/execution-vm-query-node-3.json"
AUDIT_QUERY_REQUEST_PATH="$OUTPUT_DIR/execution-audit-vm-query-request.json"
AUDIT_QUERY_PATH="$OUTPUT_DIR/execution-audit-vm-query-node-3.json"
RECEIPT_PATH="$OUTPUT_DIR/receipt.json"
HARDHAT_PORT="${SMOKE_HARDHAT_PORT:-28545}"
API_PORT_BASE="${SMOKE_API_PORT:-29251}"
LIBP2P_PORT_BASE="${SMOKE_LIBP2P_PORT:-30051}"
OXIGRAPH_BASE="${SMOKE_OXIGRAPH_BASE:-37950}"
BLAZEGRAPH_PORT="${SMOKE_BLAZEGRAPH_PORT:-39950}"
LLM_PROVIDER="${SMOKE_LLM_PROVIDER:-codex}"
PRIVATE_REMOTE="${SMOKE_PRIVATE_REMOTE:-0}"
PRIVATE_CONTEXT_SLUG="${SMOKE_PRIVATE_CONTEXT_SLUG:-semantic-runtime-private}"
QUERYING_NODE_IDENTITY_PATH="$OUTPUT_DIR/querying-node-identity.json"
PRIVATE_CREATE_PATH="$OUTPUT_DIR/private-context-graph-create.json"

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

echo "semantic-runtime-live-smoke: loading Program-author and invoking-wallet identities"
curl --fail-with-body --silent --show-error \
  "$API_URL/api/agent/identity" \
  --output "$PROGRAM_AUTHOR_IDENTITY_PATH"
curl --fail-with-body --silent --show-error \
  "$API_URL_NODE_B/api/agent/identity" \
  --output "$INVOKING_NODE_IDENTITY_PATH"
curl --fail-with-body --silent --show-error \
  "$API_URL_NODE_C/api/agent/identity" \
  --output "$QUERYING_NODE_IDENTITY_PATH"

if [ "$PRIVATE_REMOTE" = "1" ]; then
  curator_address=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).agentAddress)' "$PROGRAM_AUTHOR_IDENTITY_PATH")
  CONTEXT_GRAPH_ID="${curator_address}/${PRIVATE_CONTEXT_SLUG}"
  echo "semantic-runtime-live-smoke: creating private Context Graph $CONTEXT_GRAPH_ID"
  for target in "$API_URL_NODE_B" "$API_URL_NODE_C"; do
    SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
    SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH="$PROGRAM_AUTHOR_IDENTITY_PATH" \
    SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
    SMOKE_QUERYING_NODE_IDENTITY_PATH="$QUERYING_NODE_IDENTITY_PATH" \
    node --input-type=module -e '
      import fs from "node:fs";
      const identities = [
        process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH,
        process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH,
        process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH,
      ].map((path) => JSON.parse(fs.readFileSync(path, "utf8")).agentAddress);
      process.stdout.write(JSON.stringify({
        id: process.env.SMOKE_CONTEXT_GRAPH_ID,
        name: "Semantic runtime private remote smoke",
        accessPolicy: 1,
        publishPolicy: 1,
        allowedAgents: identities,
      }));
    ' | curl --fail-with-body --silent --show-error \
      --request POST -H "Content-Type: application/json" --data-binary @- \
      "$target/api/context-graph/create" >/dev/null
  done
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH="$PROGRAM_AUTHOR_IDENTITY_PATH" \
  SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
  SMOKE_QUERYING_NODE_IDENTITY_PATH="$QUERYING_NODE_IDENTITY_PATH" \
  node --input-type=module -e '
    import fs from "node:fs";
    const identities = [
      process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH,
      process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH,
      process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH,
    ].map((path) => JSON.parse(fs.readFileSync(path, "utf8")).agentAddress);
    process.stdout.write(JSON.stringify({
      id: process.env.SMOKE_CONTEXT_GRAPH_ID,
      name: "Semantic runtime private remote smoke",
      accessPolicy: 1,
      publishPolicy: 1,
      allowedAgents: identities,
      register: true,
    }));
  ' | curl --fail-with-body --silent --show-error \
    --request POST -H "Content-Type: application/json" --data-binary @- \
    "$API_URL/api/context-graph/create" --output "$PRIVATE_CREATE_PATH"
  sleep 3
fi

SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" \
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
    programIri: process.env.SMOKE_FORK_PROGRAM_IRI,
    invocationId: crypto.randomUUID(),
    programLayer: "vm",
    executionLayer: "vm",
  }));
'

echo "semantic-runtime-live-smoke: publishing the Program and required Tool reference to VM"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$PROGRAM_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$PUBLISH_PATH"

echo "semantic-runtime-live-smoke: adding node B's wallet to the Program Context Graph"
if [ "$PRIVATE_REMOTE" != "1" ]; then
SMOKE_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
node --input-type=module -e '
  import fs from "node:fs";
  const identity = JSON.parse(fs.readFileSync(process.env.SMOKE_NODE_IDENTITY_PATH, "utf8"));
  process.stdout.write(JSON.stringify({ agentAddress: identity.agentAddress }));
' | curl --fail-with-body --silent --show-error \
  --request POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$API_URL/api/context-graph/$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$CONTEXT_GRAPH_ID")/add-participant" \
  --output "$PARTICIPANT_ADD_PATH"
fi

write_authority_request() {
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_TOOL_IRI="$TOOL_IRI" \
  SMOKE_POLICY_IRI="$POLICY_IRI" \
  SMOKE_NODE_IDENTITY_PATH="$1" \
  SMOKE_AUTHORITY_REQUEST_PATH="$2" \
  SMOKE_AUTHORITY_NAME="$3" \
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
      name: process.env.SMOKE_AUTHORITY_NAME,
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
}

echo "semantic-runtime-live-smoke: publishing both Program owners' Tool offers and selected Policies"
write_authority_request "$PROGRAM_AUTHOR_IDENTITY_PATH" "$AUTHORITY_REQUEST_PATH" \
  "semantic-runtime-codex-authority"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$AUTHORITY_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$AUTHORITY_PUBLISH_PATH"
write_authority_request "$INVOKING_NODE_IDENTITY_PATH" "$FORK_OWNER_AUTHORITY_REQUEST_PATH" \
  "semantic-runtime-codex-authority-fork-owner"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$FORK_OWNER_AUTHORITY_REQUEST_PATH" \
  "$API_URL_NODE_B/api/knowledge-assets" \
  --output "$FORK_OWNER_AUTHORITY_PUBLISH_PATH"

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

echo "semantic-runtime-live-smoke: forking the Program on node B under node B's wallet"
SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" \
node --input-type=module -e '
  process.stdout.write(JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    sourceProgramIri: process.env.SMOKE_PROGRAM_IRI,
    newProgramIri: process.env.SMOKE_FORK_PROGRAM_IRI,
    sourceLayer: "vm",
    targetLayer: "vm",
  }));
' | curl --fail-with-body --silent --show-error \
  --request POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$API_URL_NODE_B/api/semantic-runtime/programs/fork" \
  --output "$FORK_PATH"

SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" \
SMOKE_FORK_VM_QUERY_REQUEST_PATH="$FORK_VM_QUERY_REQUEST_PATH" \
node --input-type=module -e '
  import fs from "node:fs";
  const sr = "https://origintrail.io/semantic-runtime/v1#";
  const prov = "http://www.w3.org/ns/prov#";
  const programIri = process.env.SMOKE_FORK_PROGRAM_IRI;
  fs.writeFileSync(process.env.SMOKE_FORK_VM_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    view: "verifiable-memory",
    sparql: `SELECT ?g ?language ?version ?source ?tool ?derivedFrom WHERE {
      GRAPH ?g {
        <${programIri}> a <${sr}Program> ;
          <${sr}language> ?language ;
          <${sr}version> ?version ;
          <${sr}source> ?source ;
          <${sr}requiresTool> ?tool ;
          <${prov}wasDerivedFrom> ?derivedFrom .
      }
    }`,
  }));
'

echo "semantic-runtime-live-smoke: querying node C VM for the fork and its author provenance"
fork_ready=0
for _ in $(seq 1 90); do
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$FORK_VM_QUERY_REQUEST_PATH" \
    "$API_URL_NODE_C/api/query" \
    --output "$FORK_VM_QUERY_PATH"
  if SMOKE_FORK_VM_QUERY_PATH="$FORK_VM_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_VM_QUERY_PATH, "utf8"));
    process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
  '; then
    fork_ready=1
    break
  fi
  sleep 1
done
if [ "$fork_ready" != "1" ]; then
  echo "semantic-runtime-live-smoke: node C did not observe exactly one forked Program" >&2
  cat "$FORK_VM_QUERY_PATH" >&2
  exit 1
fi

FORK_RESOLVE_URL="$API_URL/api/semantic-runtime/resolve?$(SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" node --input-type=module -e '
  process.stdout.write(new URLSearchParams({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    programIri: process.env.SMOKE_FORK_PROGRAM_IRI,
    programLayer: "vm",
  }).toString());
')"
fork_executable=0
for _ in $(seq 1 90); do
  if curl --fail-with-body --silent --show-error "$FORK_RESOLVE_URL" --output "$FORK_RESOLVE_PATH" \
    && SMOKE_FORK_RESOLVE_PATH="$FORK_RESOLVE_PATH" node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_RESOLVE_PATH, "utf8"));
      process.exit(body.executable === true ? 0 : 1);
    '; then
    fork_executable=1
    break
  fi
  sleep 1
done
if [ "$fork_executable" != "1" ]; then
  echo "semantic-runtime-live-smoke: fork did not become executable from node A" >&2
  test -f "$FORK_RESOLVE_PATH" && cat "$FORK_RESOLVE_PATH" >&2
  exit 1
fi

if [ "$PRIVATE_REMOTE" = "1" ]; then
  echo "semantic-runtime-live-smoke: invoking node B's private-CG fork remotely through node A"
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$INVOKE_REQUEST_PATH" \
    "$API_URL/api/semantic-runtime/invoke" \
    --output "$INVOKE_PATH"
else
  echo "semantic-runtime-live-smoke: proving the public CG cannot invoke node B's fork remotely"
  remote_invoke_status=$(curl --silent --show-error \
    --write-out '%{http_code}' \
    -H "Content-Type: application/json" \
    --data @"$INVOKE_REQUEST_PATH" \
    "$API_URL/api/semantic-runtime/invoke" \
    --output "$REMOTE_INVOKE_DENIAL_PATH")
  if [ "$remote_invoke_status" != "403" ]; then
    echo "semantic-runtime-live-smoke: expected public remote invocation to return 403, got $remote_invoke_status" >&2
    cat "$REMOTE_INVOKE_DENIAL_PATH" >&2
    exit 1
  fi
  SMOKE_REMOTE_DENIAL_PATH="$REMOTE_INVOKE_DENIAL_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const denial = JSON.parse(fs.readFileSync(process.env.SMOKE_REMOTE_DENIAL_PATH, "utf8"));
    if (denial.code !== "REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED") {
      throw new Error(`unexpected public remote-invocation denial: ${JSON.stringify(denial)}`);
    }
  '

  echo "semantic-runtime-live-smoke: invoking node B's fork locally on its author node"
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$INVOKE_REQUEST_PATH" \
    "$API_URL_NODE_B/api/semantic-runtime/invoke" \
    --output "$INVOKE_PATH"
fi

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
    sparql: `SELECT ?program ?executedBy ?policy ?tool ?adapterVersion ?adapterHash WHERE {
      GRAPH ?g {
        <${process.env.SMOKE_EXECUTION_IRI}>
          <${sr}usedProgram> ?program ;
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
SMOKE_FORK_PATH="$FORK_PATH" \
SMOKE_FORK_QUERY_PATH="$FORK_VM_QUERY_PATH" \
SMOKE_INVOKE_PATH="$INVOKE_PATH" \
SMOKE_REMOTE_DENIAL_PATH="$REMOTE_INVOKE_DENIAL_PATH" \
SMOKE_PRIVATE_REMOTE="$PRIVATE_REMOTE" \
SMOKE_CROSS_QUERY_PATH="$CROSS_NODE_QUERY_PATH" \
SMOKE_AUDIT_QUERY_PATH="$AUDIT_QUERY_PATH" \
SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH="$PROGRAM_AUTHOR_IDENTITY_PATH" \
SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" \
SMOKE_STRATEGY_PATH="$STRATEGY_PATH" \
SMOKE_RECEIPT_PATH="$RECEIPT_PATH" \
SMOKE_WASM_MANIFEST="$REPO_ROOT/packages/semantic-runtime/generated/integrity.json" \
node --input-type=module -e '
  import crypto from "node:crypto";
  import fs from "node:fs";
  const term = (value) => typeof value === "object" && value !== null ? value.value :
    (typeof value === "string" && value.startsWith("\"") ? JSON.parse(value) : value);
  const fork = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_PATH, "utf8"));
  const forkQuery = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_QUERY_PATH, "utf8"));
  const invocation = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8"));
  const privateRemote = process.env.SMOKE_PRIVATE_REMOTE === "1";
  const remoteInvocationDenial = privateRemote
    ? null
    : JSON.parse(fs.readFileSync(process.env.SMOKE_REMOTE_DENIAL_PATH, "utf8"));
  const sourceAuthor = JSON.parse(fs.readFileSync(process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH, "utf8"));
  const forkOwner = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH, "utf8"));
  const query = JSON.parse(fs.readFileSync(process.env.SMOKE_CROSS_QUERY_PATH, "utf8"));
  const audit = JSON.parse(fs.readFileSync(process.env.SMOKE_AUDIT_QUERY_PATH, "utf8"));
  const forkRows = forkQuery.result?.bindings ?? [];
  if (forkRows.length !== 1) throw new Error(`expected exactly one forked Program, got ${forkRows.length}`);
  const forkRow = Object.fromEntries(Object.entries(forkRows[0]).map(([key, value]) => [key, term(value)]));
  const expectedSource = fs.readFileSync(process.env.SMOKE_STRATEGY_PATH, "utf8");
  if (fork.programIri !== process.env.SMOKE_FORK_PROGRAM_IRI || fork.persisted !== true || !fork.programUal) {
    throw new Error(`fork response did not confirm VM persistence: ${JSON.stringify(fork)}`);
  }
  if (fork.authorAgentAddress.toLowerCase() !== forkOwner.agentAddress.toLowerCase()) {
    throw new Error(`fork author ${fork.authorAgentAddress} did not match copier ${forkOwner.agentAddress}`);
  }
  if (fork.derivedFrom !== process.env.SMOKE_PROGRAM_IRI || forkRow.derivedFrom !== process.env.SMOKE_PROGRAM_IRI) {
    throw new Error(`fork provenance mismatch: ${JSON.stringify({ response: fork.derivedFrom, vm: forkRow.derivedFrom })}`);
  }
  if (forkRow.language !== "sexpr-v1" || forkRow.version !== "1.0.0" || forkRow.source !== expectedSource) {
    throw new Error("forked Program definition differs from its source Program");
  }
  if (forkRow.tool !== "urn:sr:tool:investigator-v1") throw new Error(`unexpected fork tool: ${forkRow.tool}`);
  if (!String(forkRow.g).toLowerCase().includes(`/_verifiable_memory/${forkOwner.agentAddress.toLowerCase()}/`)) {
    throw new Error(`fork VM graph was not authored by the copier: ${forkRow.g}`);
  }
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
  if (auditRow.program !== process.env.SMOKE_FORK_PROGRAM_IRI) throw new Error(`unexpected executed Program: ${auditRow.program}`);
  if (auditRow.policy !== "urn:sr:policy:devnet-codex") throw new Error(`unexpected policy: ${auditRow.policy}`);
  if (auditRow.tool !== "urn:sr:tool:investigator-v1") throw new Error(`unexpected tool: ${auditRow.tool}`);
  if (auditRow.adapterVersion !== "1") throw new Error(`unexpected adapter version: ${auditRow.adapterVersion}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(String(auditRow.adapterHash))) throw new Error(`invalid adapter hash: ${auditRow.adapterHash}`);
  if (auditRow.executedBy !== forkOwner.agentDid) {
    throw new Error(`Fork executed by ${auditRow.executedBy}, expected copier node ${forkOwner.agentDid}`);
  }
  if (sourceAuthor.agentAddress.toLowerCase() === forkOwner.agentAddress.toLowerCase()) {
    throw new Error("smoke requires distinct source-author and fork-owner wallets");
  }
  const evidence = {
    recordedAt: new Date().toISOString(),
    mode: privateRemote
      ? "real-four-node-dkg-private-remote-inbox-wasm-codex-cross-node-vm"
      : "real-four-node-dkg-public-remote-denial-local-wasm-codex-cross-node-vm",
    sourceProgramAuthor: { node: "node-a", agentDid: sourceAuthor.agentDid, agentAddress: sourceAuthor.agentAddress },
    forkedBy: { node: "node-b", agentDid: forkOwner.agentDid, agentAddress: forkOwner.agentAddress },
    ...(remoteInvocationDenial
      ? { rejectedRemoteInvocationFrom: { node: "node-a", ...remoteInvocationDenial } }
      : {}),
    invokedFrom: privateRemote
      ? { node: "node-a", agentDid: sourceAuthor.agentDid, agentAddress: sourceAuthor.agentAddress }
      : { node: "node-b", agentDid: forkOwner.agentDid, agentAddress: forkOwner.agentAddress },
    executedOn: { node: "node-b", agentDid: forkOwner.agentDid, agentAddress: forkOwner.agentAddress },
    queriedNode: "node-c",
    fork,
    crossNodeForkVmResult: forkRows[0],
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
