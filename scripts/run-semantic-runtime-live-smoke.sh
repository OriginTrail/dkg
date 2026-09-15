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
QUERY_PROGRAM_IRI="${SMOKE_QUERY_PROGRAM_IRI:-urn:sr:program:query-live}"
QUERY_TOOL_IRI="${SMOKE_QUERY_TOOL_IRI:-urn:sr:tool:dkg-query-v1}"
COMPOSER_PROGRAM_IRI="${SMOKE_COMPOSER_PROGRAM_IRI:-urn:sr:program:remote-compose-live}"
INTERMEDIATE_PROGRAM_IRI="${SMOKE_INTERMEDIATE_PROGRAM_IRI:-urn:sr:program:remote-hop-b}"
TERMINAL_PROGRAM_IRI="${SMOKE_TERMINAL_PROGRAM_IRI:-urn:sr:program:codex-live-terminal-c}"
REMOTE_TOOL_IRI="${SMOKE_REMOTE_TOOL_IRI:-urn:sr:tool:remote-execute-v1}"
POLICY_IRI="${SMOKE_POLICY_IRI:-urn:sr:policy:devnet-codex}"
SMOKE_DEVNET_DIR="$OUTPUT_DIR/devnet"
STATUS_PATH="$OUTPUT_DIR/dkg-status.json"
PROGRAM_REQUEST_PATH="$OUTPUT_DIR/program-request.json"
PUBLISH_PATH="$OUTPUT_DIR/program-publish.json"
QUERY_PROGRAM_REQUEST_PATH="$OUTPUT_DIR/query-program-request.json"
QUERY_PROGRAM_PUBLISH_PATH="$OUTPUT_DIR/query-program-publish.json"
QUERY_CATALOG_REQUEST_PATH="$OUTPUT_DIR/query-catalog-request.json"
QUERY_CATALOG_WRITE_PATH="$OUTPUT_DIR/query-catalog-write.json"
VM_QUERY_REQUEST_PATH="$OUTPUT_DIR/program-vm-query-request.json"
VM_QUERY_PATH="$OUTPUT_DIR/program-vm-query.json"
INVOKE_REQUEST_PATH="$OUTPUT_DIR/program-invoke-request.json"
INVOKE_PATH="$OUTPUT_DIR/program-invoke.json"
SOURCE_INVOKE_REQUEST_PATH="$OUTPUT_DIR/source-program-invoke-request.json"
SOURCE_INVOKE_PATH="$OUTPUT_DIR/source-program-invoke.json"
QUERY_INVOKE_REQUEST_PATH="$OUTPUT_DIR/query-program-invoke-request.json"
QUERY_INVOKE_PATH="$OUTPUT_DIR/query-program-invoke.json"
COMPOSER_PROGRAM_REQUEST_PATH="$OUTPUT_DIR/composer-program-request.json"
COMPOSER_PROGRAM_PUBLISH_PATH="$OUTPUT_DIR/composer-program-publish.json"
INTERMEDIATE_PROGRAM_REQUEST_PATH="$OUTPUT_DIR/intermediate-program-request.json"
INTERMEDIATE_PROGRAM_PUBLISH_PATH="$OUTPUT_DIR/intermediate-program-publish.json"
INTERMEDIATE_RESOLVE_PATH="$OUTPUT_DIR/intermediate-program-resolve-node-b.json"
TERMINAL_FORK_PATH="$OUTPUT_DIR/terminal-program-fork.json"
TERMINAL_RESOLVE_PATH="$OUTPUT_DIR/terminal-program-resolve-node-c.json"
COMPOSER_INVOKE_REQUEST_PATH="$OUTPUT_DIR/composer-program-invoke-request.json"
COMPOSER_INVOKE_PATH="$OUTPUT_DIR/composer-program-invoke.json"
COMPOSER_CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/composer-execution-vm-query-request.json"
COMPOSER_CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/composer-execution-vm-query-node-4.json"
CHILD_CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/child-execution-vm-query-request.json"
CHILD_CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/child-execution-vm-query-node-4.json"
TERMINAL_CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/terminal-execution-vm-query-request.json"
TERMINAL_CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/terminal-execution-vm-query-node-4.json"
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
SOURCE_CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/source-execution-vm-query-request.json"
SOURCE_CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/source-execution-vm-query-node-3.json"
QUERY_CROSS_NODE_QUERY_REQUEST_PATH="$OUTPUT_DIR/query-execution-vm-query-request.json"
QUERY_CROSS_NODE_QUERY_PATH="$OUTPUT_DIR/query-execution-vm-query-node-3.json"
QUERY_TIMING_PATH="$OUTPUT_DIR/query-invocation-timing.json"
AUDIT_QUERY_REQUEST_PATH="$OUTPUT_DIR/execution-audit-vm-query-request.json"
AUDIT_QUERY_PATH="$OUTPUT_DIR/execution-audit-vm-query-node-3.json"
RECEIPT_PATH="$OUTPUT_DIR/receipt.json"
HARDHAT_PORT="${SMOKE_HARDHAT_PORT:-28545}"
API_PORT_BASE="${SMOKE_API_PORT:-29251}"
LIBP2P_PORT_BASE="${SMOKE_LIBP2P_PORT:-30051}"
OXIGRAPH_BASE="${SMOKE_OXIGRAPH_BASE:-37950}"
BLAZEGRAPH_PORT="${SMOKE_BLAZEGRAPH_PORT:-39950}"
DOCKER_NAME_PREFIX="${SMOKE_DOCKER_NAME_PREFIX:-semantic-runtime-smoke}"
LLM_PROVIDER="${SMOKE_LLM_PROVIDER:-codex}"
PRIVATE_REMOTE="${SMOKE_PRIVATE_REMOTE:-0}"
PRIVATE_CONTEXT_SLUG="${SMOKE_PRIVATE_CONTEXT_SLUG:-semantic-runtime-private}"
QUERYING_NODE_IDENTITY_PATH="$OUTPUT_DIR/querying-node-identity.json"
VERIFYING_NODE_IDENTITY_PATH="$OUTPUT_DIR/verifying-node-identity.json"
QUERYING_NODE_AUTHORITY_REQUEST_PATH="$OUTPUT_DIR/querying-node-authority-request.json"
QUERYING_NODE_AUTHORITY_PUBLISH_PATH="$OUTPUT_DIR/querying-node-authority-publish.json"
PRIVATE_CREATE_PATH="$OUTPUT_DIR/private-context-graph-create.json"

mkdir -p "$OUTPUT_DIR"

stop_devnet() {
  DEVNET_DIR="$SMOKE_DEVNET_DIR" \
  HARDHAT_PORT="$HARDHAT_PORT" \
  API_PORT_BASE="$API_PORT_BASE" \
  LIBP2P_PORT_BASE="$LIBP2P_PORT_BASE" \
  DEVNET_OXIGRAPH_BASE="$OXIGRAPH_BASE" \
  DEVNET_BLAZEGRAPH_PORT="$BLAZEGRAPH_PORT" \
  DEVNET_DOCKER_NAME_PREFIX="$DOCKER_NAME_PREFIX" \
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
DEVNET_DOCKER_NAME_PREFIX="$DOCKER_NAME_PREFIX" \
DEVNET_NO_AUTH=1 \
NUM_CORE_NODES=4 \
DEVNET_NODE_READY_TIMEOUT=180 \
HARDHAT_BLOCK_INTERVAL_MS=0 \
DEVNET_ENABLE_SEMANTIC_RUNTIME=1 \
SEMANTIC_RUNTIME_LLM_PROVIDER="$LLM_PROVIDER" \
SEMANTIC_RUNTIME_TRACE_ADAPTER_TIMING=1 \
  "$REPO_ROOT/scripts/devnet.sh" start 4

API_URL="http://127.0.0.1:${API_PORT_BASE}"
API_URL_NODE_B="http://127.0.0.1:$((API_PORT_BASE + 1))"
API_URL_NODE_C="http://127.0.0.1:$((API_PORT_BASE + 2))"
API_URL_NODE_D="http://127.0.0.1:$((API_PORT_BASE + 3))"
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
curl --fail-with-body --silent --show-error \
  "$API_URL_NODE_D/api/agent/identity" \
  --output "$VERIFYING_NODE_IDENTITY_PATH"

if [ "$PRIVATE_REMOTE" = "1" ]; then
  curator_address=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).agentAddress)' "$PROGRAM_AUTHOR_IDENTITY_PATH")
  CONTEXT_GRAPH_ID="${curator_address}/${PRIVATE_CONTEXT_SLUG}"
  echo "semantic-runtime-live-smoke: creating private Context Graph $CONTEXT_GRAPH_ID"
  for target in "$API_URL_NODE_B" "$API_URL_NODE_C" "$API_URL_NODE_D"; do
    SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
    SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH="$PROGRAM_AUTHOR_IDENTITY_PATH" \
    SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
    SMOKE_QUERYING_NODE_IDENTITY_PATH="$QUERYING_NODE_IDENTITY_PATH" \
    SMOKE_VERIFYING_NODE_IDENTITY_PATH="$VERIFYING_NODE_IDENTITY_PATH" \
    node --input-type=module -e '
      import fs from "node:fs";
      const identities = [
        process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH,
        process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH,
        process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH,
        process.env.SMOKE_VERIFYING_NODE_IDENTITY_PATH,
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
  SMOKE_VERIFYING_NODE_IDENTITY_PATH="$VERIFYING_NODE_IDENTITY_PATH" \
  node --input-type=module -e '
    import fs from "node:fs";
    const identities = [
      process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH,
      process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH,
      process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH,
      process.env.SMOKE_VERIFYING_NODE_IDENTITY_PATH,
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
SMOKE_QUERY_PROGRAM_IRI="$QUERY_PROGRAM_IRI" \
SMOKE_QUERY_TOOL_IRI="$QUERY_TOOL_IRI" \
SMOKE_COMPOSER_PROGRAM_IRI="$COMPOSER_PROGRAM_IRI" \
SMOKE_INTERMEDIATE_PROGRAM_IRI="$INTERMEDIATE_PROGRAM_IRI" \
SMOKE_TERMINAL_PROGRAM_IRI="$TERMINAL_PROGRAM_IRI" \
SMOKE_REMOTE_TOOL_IRI="$REMOTE_TOOL_IRI" \
SMOKE_PRIVATE_REMOTE="$PRIVATE_REMOTE" \
SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
SMOKE_QUERYING_NODE_IDENTITY_PATH="$QUERYING_NODE_IDENTITY_PATH" \
SMOKE_STRATEGY_PATH="$STRATEGY_PATH" \
SMOKE_PROGRAM_REQUEST_PATH="$PROGRAM_REQUEST_PATH" \
SMOKE_QUERY_PROGRAM_REQUEST_PATH="$QUERY_PROGRAM_REQUEST_PATH" \
SMOKE_QUERY_CATALOG_REQUEST_PATH="$QUERY_CATALOG_REQUEST_PATH" \
SMOKE_VM_QUERY_REQUEST_PATH="$VM_QUERY_REQUEST_PATH" \
SMOKE_INVOKE_REQUEST_PATH="$INVOKE_REQUEST_PATH" \
SMOKE_SOURCE_INVOKE_REQUEST_PATH="$SOURCE_INVOKE_REQUEST_PATH" \
SMOKE_QUERY_INVOKE_REQUEST_PATH="$QUERY_INVOKE_REQUEST_PATH" \
SMOKE_COMPOSER_PROGRAM_REQUEST_PATH="$COMPOSER_PROGRAM_REQUEST_PATH" \
SMOKE_INTERMEDIATE_PROGRAM_REQUEST_PATH="$INTERMEDIATE_PROGRAM_REQUEST_PATH" \
SMOKE_COMPOSER_INVOKE_REQUEST_PATH="$COMPOSER_INVOKE_REQUEST_PATH" \
node --input-type=module -e '
  import crypto from "node:crypto";
  import fs from "node:fs";
  import { buildQueryCatalogWrite } from "@origintrail-official/dkg-core/query-catalog";
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
  fs.writeFileSync(process.env.SMOKE_SOURCE_INVOKE_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    programIri,
    invocationId: crypto.randomUUID(),
    programLayer: "vm",
    executionLayer: "vm",
  }));
  const queryProgramIri = process.env.SMOKE_QUERY_PROGRAM_IRI;
  const queryToolIri = process.env.SMOKE_QUERY_TOOL_IRI;
  const querySource = `(strategy smoke/query
    (version "1.0.0")
    (scope network:devnet)
    (goal prove-concurrent-catalog-query)
    (supervise one-for-one (max-restarts 2) (window-ms 60000)
      (delegate reader
        (grant dkg.query)
        (call dkg/query@1 "Configuration trace"))))`;
  fs.writeFileSync(process.env.SMOKE_QUERY_PROGRAM_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    name: "semantic-program-query",
    quads: [
      { subject: queryProgramIri, predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", object: `${sr}Program` },
      { subject: queryProgramIri, predicate: `${sr}language`, object: JSON.stringify("sexpr-v1") },
      { subject: queryProgramIri, predicate: `${sr}version`, object: JSON.stringify("1.0.0") },
      { subject: queryProgramIri, predicate: `${sr}source`, object: JSON.stringify(querySource) },
      { subject: queryProgramIri, predicate: `${sr}requiresTool`, object: queryToolIri },
    ],
    alsoShareSwm: true,
    alsoPublishVm: true,
  }));
  fs.writeFileSync(process.env.SMOKE_QUERY_CATALOG_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    quads: buildQueryCatalogWrite({
      contextGraphId,
      name: "Configuration trace",
      sparql: "SELECT ?value WHERE { VALUES ?value { \"query-ok\" } }",
      subGraph: "__context_graph",
      catalogSlug: "runtime",
      catalogName: "Runtime",
      rank: 1,
      catalogRank: 1,
      view: "verifiable-memory",
    }).quads,
  }));
  fs.writeFileSync(process.env.SMOKE_QUERY_INVOKE_REQUEST_PATH, JSON.stringify({
    contextGraphId,
    programIri: queryProgramIri,
    invocationId: crypto.randomUUID(),
    programLayer: "vm",
    executionLayer: "vm",
  }));
  if (process.env.SMOKE_PRIVATE_REMOTE === "1") {
    const nodeB = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH, "utf8"));
    const nodeC = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH, "utf8"));
    const composerProgramIri = process.env.SMOKE_COMPOSER_PROGRAM_IRI;
    const intermediateProgramIri = process.env.SMOKE_INTERMEDIATE_PROGRAM_IRI;
    const composerSource = `(strategy smoke/remote-compose
      (version "1.0.0")
      (scope network:devnet)
      (goal execute-b-then-c)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate composer
          (grant program.remote-execute)
          (call remote-execute@1 "${nodeB.peerId}" "${intermediateProgramIri}"))))`;
    const intermediateSource = `(strategy smoke/remote-hop-b
      (version "1.0.0")
      (scope network:devnet)
      (goal execute-c-as-b)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate composer
          (grant program.remote-execute)
          (call remote-execute@1 "${nodeC.peerId}" "${process.env.SMOKE_TERMINAL_PROGRAM_IRI}"))))`;
    fs.writeFileSync(process.env.SMOKE_COMPOSER_PROGRAM_REQUEST_PATH, JSON.stringify({
      contextGraphId,
      name: "semantic-program-remote-compose",
      quads: [
        { subject: composerProgramIri, predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", object: `${sr}Program` },
        { subject: composerProgramIri, predicate: `${sr}language`, object: JSON.stringify("sexpr-v1") },
        { subject: composerProgramIri, predicate: `${sr}version`, object: JSON.stringify("1.0.0") },
        { subject: composerProgramIri, predicate: `${sr}source`, object: JSON.stringify(composerSource) },
        { subject: composerProgramIri, predicate: `${sr}requiresTool`, object: process.env.SMOKE_REMOTE_TOOL_IRI },
      ],
      alsoShareSwm: true,
      alsoPublishVm: true,
    }));
    fs.writeFileSync(process.env.SMOKE_INTERMEDIATE_PROGRAM_REQUEST_PATH, JSON.stringify({
      contextGraphId,
      name: "semantic-program-remote-hop-b",
      quads: [
        { subject: intermediateProgramIri, predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", object: `${sr}Program` },
        { subject: intermediateProgramIri, predicate: `${sr}language`, object: JSON.stringify("sexpr-v1") },
        { subject: intermediateProgramIri, predicate: `${sr}version`, object: JSON.stringify("1.0.0") },
        { subject: intermediateProgramIri, predicate: `${sr}source`, object: JSON.stringify(intermediateSource) },
        { subject: intermediateProgramIri, predicate: `${sr}requiresTool`, object: process.env.SMOKE_REMOTE_TOOL_IRI },
      ],
      alsoShareSwm: true,
      alsoPublishVm: true,
    }));
    fs.writeFileSync(process.env.SMOKE_COMPOSER_INVOKE_REQUEST_PATH, JSON.stringify({
      contextGraphId,
      programIri: composerProgramIri,
      invocationId: crypto.randomUUID(),
      programLayer: "vm",
      executionLayer: "vm",
    }));
  }
'

echo "semantic-runtime-live-smoke: publishing the Program and required Tool reference to VM"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$PROGRAM_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$PUBLISH_PATH"

curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$QUERY_PROGRAM_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$QUERY_PROGRAM_PUBLISH_PATH"

if [ "$PRIVATE_REMOTE" = "1" ]; then
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$COMPOSER_PROGRAM_REQUEST_PATH" \
    "$API_URL/api/knowledge-assets" \
    --output "$COMPOSER_PROGRAM_PUBLISH_PATH"
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$INTERMEDIATE_PROGRAM_REQUEST_PATH" \
    "$API_URL_NODE_B/api/knowledge-assets" \
    --output "$INTERMEDIATE_PROGRAM_PUBLISH_PATH"
fi

curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$QUERY_CATALOG_REQUEST_PATH" \
  "$API_URL/api/profile/query-catalog/write" \
  --output "$QUERY_CATALOG_WRITE_PATH"

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
  SMOKE_QUERY_TOOL_IRI="$QUERY_TOOL_IRI" \
  SMOKE_INCLUDE_QUERY_TOOL="${4:-0}" \
  SMOKE_REMOTE_TOOL_IRI="$REMOTE_TOOL_IRI" \
  SMOKE_INCLUDE_REMOTE_TOOL="${5:-0}" \
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
    const queryTool = process.env.SMOKE_QUERY_TOOL_IRI;
    const remoteTool = process.env.SMOKE_REMOTE_TOOL_IRI;
    const policy = process.env.SMOKE_POLICY_IRI;
    const operator = identity.agentDid;
    const quads = [
      { subject: operator, predicate: `${sr}offersTool`, object: tool },
      { subject: tool, predicate: rdfType, object: `${sr}Tool` },
      { subject: tool, predicate: `${sr}operation`, object: JSON.stringify("agent/investigate") },
      { subject: tool, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: tool, predicate: `${sr}witInterface`, object: JSON.stringify("origintrail:semantic-runtime/investigator@0.1.0") },
      { subject: operator, predicate: `${sr}usesExecutionPolicy`, object: policy },
      { subject: policy, predicate: rdfType, object: `${sr}ExecutionPolicy` },
      { subject: policy, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: policy, predicate: `${sr}allowsTool`, object: tool },
    ];
    if (process.env.SMOKE_INCLUDE_QUERY_TOOL === "1") quads.push(
      { subject: operator, predicate: `${sr}offersTool`, object: queryTool },
      { subject: queryTool, predicate: rdfType, object: `${sr}Tool` },
      { subject: queryTool, predicate: `${sr}operation`, object: JSON.stringify("dkg/query") },
      { subject: queryTool, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: queryTool, predicate: `${sr}witInterface`, object: JSON.stringify("origintrail:semantic-runtime/query-catalog@0.1.0") },
      { subject: policy, predicate: `${sr}allowsTool`, object: queryTool },
    );
    if (process.env.SMOKE_INCLUDE_REMOTE_TOOL === "1") quads.push(
      { subject: operator, predicate: `${sr}offersTool`, object: remoteTool },
      { subject: remoteTool, predicate: rdfType, object: `${sr}Tool` },
      { subject: remoteTool, predicate: `${sr}operation`, object: JSON.stringify("remote-execute") },
      { subject: remoteTool, predicate: `${sr}version`, object: JSON.stringify("1") },
      { subject: remoteTool, predicate: `${sr}witInterface`, object: JSON.stringify("origintrail:semantic-runtime/remote-execute@0.1.0") },
      { subject: policy, predicate: `${sr}allowsTool`, object: remoteTool },
    );
    fs.writeFileSync(process.env.SMOKE_AUTHORITY_REQUEST_PATH, JSON.stringify({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      name: process.env.SMOKE_AUTHORITY_NAME,
      quads,
      alsoShareSwm: true,
      alsoPublishVm: true,
    }));
  '
}

echo "semantic-runtime-live-smoke: publishing both Program owners' Tool offers and selected Policies"
write_authority_request "$PROGRAM_AUTHOR_IDENTITY_PATH" "$AUTHORITY_REQUEST_PATH" \
  "semantic-runtime-codex-authority" "1" "$PRIVATE_REMOTE"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$AUTHORITY_REQUEST_PATH" \
  "$API_URL/api/knowledge-assets" \
  --output "$AUTHORITY_PUBLISH_PATH"
write_authority_request "$INVOKING_NODE_IDENTITY_PATH" "$FORK_OWNER_AUTHORITY_REQUEST_PATH" \
  "semantic-runtime-codex-authority-fork-owner" "0" "$PRIVATE_REMOTE"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$FORK_OWNER_AUTHORITY_REQUEST_PATH" \
  "$API_URL_NODE_B/api/knowledge-assets" \
  --output "$FORK_OWNER_AUTHORITY_PUBLISH_PATH"
if [ "$PRIVATE_REMOTE" = "1" ]; then
  write_authority_request "$QUERYING_NODE_IDENTITY_PATH" "$QUERYING_NODE_AUTHORITY_REQUEST_PATH" \
    "semantic-runtime-codex-authority-node-c"
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$QUERYING_NODE_AUTHORITY_REQUEST_PATH" \
    "$API_URL_NODE_C/api/knowledge-assets" \
    --output "$QUERYING_NODE_AUTHORITY_PUBLISH_PATH"
fi

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

if [ "$PRIVATE_REMOTE" = "1" ]; then
  echo "semantic-runtime-live-smoke: forking the terminal Program on node C under node C's wallet"
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
  SMOKE_TERMINAL_PROGRAM_IRI="$TERMINAL_PROGRAM_IRI" \
  node --input-type=module -e '
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      sourceProgramIri: process.env.SMOKE_PROGRAM_IRI,
      newProgramIri: process.env.SMOKE_TERMINAL_PROGRAM_IRI,
      sourceLayer: "vm",
      targetLayer: "vm",
    }));
  ' | curl --fail-with-body --silent --show-error \
    --request POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$API_URL_NODE_C/api/semantic-runtime/programs/fork" \
    --output "$TERMINAL_FORK_PATH"
fi

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

wait_for_program_executable() {
  local node_url="$1"
  local program_iri="$2"
  local output_path="$3"
  local label="$4"
  local resolve_url
  resolve_url="$node_url/api/semantic-runtime/resolve?$(SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" SMOKE_PROGRAM_IRI="$program_iri" node --input-type=module -e '
    process.stdout.write(new URLSearchParams({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      programIri: process.env.SMOKE_PROGRAM_IRI,
      programLayer: "vm",
    }).toString());
  ')"
  local executable=0
  for _ in $(seq 1 90); do
    if curl --fail-with-body --silent --show-error "$resolve_url" --output "$output_path" \
      && SMOKE_RESOLVE_PATH="$output_path" node --input-type=module -e '
        import fs from "node:fs";
        const body = JSON.parse(fs.readFileSync(process.env.SMOKE_RESOLVE_PATH, "utf8"));
        process.exit(body.executable === true ? 0 : 1);
      '; then
      executable=1
      break
    fi
    sleep 1
  done
  if [ "$executable" != "1" ]; then
    echo "semantic-runtime-live-smoke: $label did not become executable" >&2
    test -f "$output_path" && cat "$output_path" >&2
    exit 1
  fi
}

if [ "$PRIVATE_REMOTE" = "1" ]; then
  echo "semantic-runtime-live-smoke: waiting for both downstream Programs to become executable"
  wait_for_program_executable "$API_URL_NODE_B" "$INTERMEDIATE_PROGRAM_IRI" \
    "$INTERMEDIATE_RESOLVE_PATH" "node B intermediate Program"
  wait_for_program_executable "$API_URL_NODE_C" "$TERMINAL_PROGRAM_IRI" \
    "$TERMINAL_RESOLVE_PATH" "node C terminal Program"
fi

if [ "$PRIVATE_REMOTE" = "1" ]; then
  FORK_INVOKE_URL="$API_URL/api/semantic-runtime/invoke"
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
  FORK_INVOKE_URL="$API_URL_NODE_B/api/semantic-runtime/invoke"
fi

echo "semantic-runtime-live-smoke: invoking two Program KAs concurrently through DKG routes"
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$SOURCE_INVOKE_REQUEST_PATH" \
  "$API_URL/api/semantic-runtime/invoke" \
  --output "$SOURCE_INVOKE_PATH" &
source_invoke_pid=$!
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$INVOKE_REQUEST_PATH" \
  "$FORK_INVOKE_URL" \
  --output "$INVOKE_PATH" &
fork_invoke_pid=$!
SOURCE_INVOCATION_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).invocationId)' "$SOURCE_INVOKE_REQUEST_PATH")
llm_started=0
for _ in $(seq 1 100); do
  if grep -q "semantic-runtime-tool-timing.*urn:sr:effect:${SOURCE_INVOCATION_ID}:" \
    "$SMOKE_DEVNET_DIR/node1/daemon.log" 2>/dev/null; then
    llm_started=1
    break
  fi
  sleep 0.1
done
if [ "$llm_started" != "1" ]; then
  echo "semantic-runtime-live-smoke: source Codex call did not emit a start timestamp" >&2
  exit 1
fi
query_started_ns=$(node -e 'process.stdout.write(process.hrtime.bigint().toString())')
curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$QUERY_INVOKE_REQUEST_PATH" \
  "$API_URL/api/semantic-runtime/invoke" \
  --output "$QUERY_INVOKE_PATH"
query_finished_ns=$(node -e 'process.stdout.write(process.hrtime.bigint().toString())')
SMOKE_QUERY_TIMING_PATH="$QUERY_TIMING_PATH" \
SMOKE_QUERY_STARTED_NS="$query_started_ns" \
SMOKE_QUERY_FINISHED_NS="$query_finished_ns" \
node --input-type=module -e '
  import fs from "node:fs";
  fs.writeFileSync(process.env.SMOKE_QUERY_TIMING_PATH, JSON.stringify({
    startNs: process.env.SMOKE_QUERY_STARTED_NS,
    finishNs: process.env.SMOKE_QUERY_FINISHED_NS,
  }));
'
wait "$source_invoke_pid"
wait "$fork_invoke_pid"

if [ "$PRIVATE_REMOTE" = "1" ]; then
  echo "semantic-runtime-live-smoke: composing Programs through typed remote-execute"
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$COMPOSER_INVOKE_REQUEST_PATH" \
    "$API_URL/api/semantic-runtime/invoke" \
    --output "$COMPOSER_INVOKE_PATH"
fi

EXECUTION_IRI=$(SMOKE_INVOKE_PATH="$INVOKE_PATH" node --input-type=module -e '
  import fs from "node:fs";
  process.stdout.write(JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8")).executionIri);
')
SOURCE_EXECUTION_IRI=$(SMOKE_INVOKE_PATH="$SOURCE_INVOKE_PATH" node --input-type=module -e '
  import fs from "node:fs";
  process.stdout.write(JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8")).executionIri);
')
QUERY_EXECUTION_IRI=$(SMOKE_INVOKE_PATH="$QUERY_INVOKE_PATH" node --input-type=module -e '
  import fs from "node:fs";
  process.stdout.write(JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8")).executionIri);
')
SMOKE_EXECUTION_IRI="$EXECUTION_IRI" \
SMOKE_SOURCE_EXECUTION_IRI="$SOURCE_EXECUTION_IRI" \
SMOKE_QUERY_EXECUTION_IRI="$QUERY_EXECUTION_IRI" \
SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_QUERY_REQUEST_PATH="$CROSS_NODE_QUERY_REQUEST_PATH" \
SMOKE_SOURCE_QUERY_REQUEST_PATH="$SOURCE_CROSS_NODE_QUERY_REQUEST_PATH" \
SMOKE_CATALOG_QUERY_REQUEST_PATH="$QUERY_CROSS_NODE_QUERY_REQUEST_PATH" \
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
  fs.writeFileSync(process.env.SMOKE_SOURCE_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    view: "verifiable-memory",
    sparql: `SELECT ?output ?outputHash ?status WHERE {
      GRAPH ?g {
        <${process.env.SMOKE_SOURCE_EXECUTION_IRI}>
          a <${sr}Execution> ;
          <${sr}output> ?output ;
          <${sr}outputHash> ?outputHash ;
          <${sr}status> ?status .
      }
    }`,
  }));
  fs.writeFileSync(process.env.SMOKE_CATALOG_QUERY_REQUEST_PATH, JSON.stringify({
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    view: "verifiable-memory",
    sparql: `SELECT ?output ?outputHash ?status WHERE {
      GRAPH ?g {
        <${process.env.SMOKE_QUERY_EXECUTION_IRI}>
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

source_execution_ready=0
for _ in $(seq 1 90); do
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$SOURCE_CROSS_NODE_QUERY_REQUEST_PATH" \
    "$API_URL_NODE_C/api/query" \
    --output "$SOURCE_CROSS_NODE_QUERY_PATH"
  if SMOKE_QUERY_PATH="$SOURCE_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
    process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
  '; then
    source_execution_ready=1
    break
  fi
  sleep 1
done
if [ "$source_execution_ready" != "1" ]; then
  echo "semantic-runtime-live-smoke: node C did not observe the source Program Execution" >&2
  cat "$SOURCE_CROSS_NODE_QUERY_PATH" >&2
  exit 1
fi

query_execution_ready=0
for _ in $(seq 1 90); do
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    --data @"$QUERY_CROSS_NODE_QUERY_REQUEST_PATH" \
    "$API_URL_NODE_C/api/query" \
    --output "$QUERY_CROSS_NODE_QUERY_PATH"
  if SMOKE_QUERY_PATH="$QUERY_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
    process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
  '; then
    query_execution_ready=1
    break
  fi
  sleep 1
done
if [ "$query_execution_ready" != "1" ]; then
  echo "semantic-runtime-live-smoke: node C did not observe the Query Program Execution" >&2
  cat "$QUERY_CROSS_NODE_QUERY_PATH" >&2
  exit 1
fi

if [ "$PRIVATE_REMOTE" = "1" ]; then
  COMPOSER_EXECUTION_IRI=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).executionIri)' "$COMPOSER_INVOKE_PATH")
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_COMPOSER_EXECUTION_IRI="$COMPOSER_EXECUTION_IRI" \
  SMOKE_COMPOSER_QUERY_REQUEST_PATH="$COMPOSER_CROSS_NODE_QUERY_REQUEST_PATH" \
  node --input-type=module -e '
    import fs from "node:fs";
    const sr = "https://origintrail.io/semantic-runtime/v1#";
    fs.writeFileSync(process.env.SMOKE_COMPOSER_QUERY_REQUEST_PATH, JSON.stringify({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      view: "verifiable-memory",
      sparql: `SELECT ?output ?status ?executedBy ?invokedBy WHERE {
        GRAPH ?g {
          <${process.env.SMOKE_COMPOSER_EXECUTION_IRI}>
            a <${sr}Execution> ;
            <${sr}output> ?output ;
            <${sr}status> ?status ;
            <${sr}executedBy> ?executedBy ;
            <${sr}invokedBy> ?invokedBy .
        }
      }`,
    }));
  '
  composer_ready=0
  for _ in $(seq 1 90); do
    curl --fail-with-body --silent --show-error \
      -H "Content-Type: application/json" \
      --data @"$COMPOSER_CROSS_NODE_QUERY_REQUEST_PATH" \
      "$API_URL_NODE_D/api/query" \
      --output "$COMPOSER_CROSS_NODE_QUERY_PATH"
    if SMOKE_QUERY_PATH="$COMPOSER_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
      process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
    '; then
      composer_ready=1
      break
    fi
    sleep 1
  done
  if [ "$composer_ready" != "1" ]; then
    echo "semantic-runtime-live-smoke: node D did not observe the composer Execution" >&2
    cat "$COMPOSER_CROSS_NODE_QUERY_PATH" >&2
    exit 1
  fi
  CHILD_EXECUTION_IRI=$(SMOKE_QUERY_PATH="$COMPOSER_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const value = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8")).result.bindings[0].output;
    process.stdout.write(typeof value === "object" ? value.value : JSON.parse(value));
  ')
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_CHILD_EXECUTION_IRI="$CHILD_EXECUTION_IRI" \
  SMOKE_CHILD_QUERY_REQUEST_PATH="$CHILD_CROSS_NODE_QUERY_REQUEST_PATH" \
  node --input-type=module -e '
    import fs from "node:fs";
    const sr = "https://origintrail.io/semantic-runtime/v1#";
    fs.writeFileSync(process.env.SMOKE_CHILD_QUERY_REQUEST_PATH, JSON.stringify({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      view: "verifiable-memory",
      sparql: `SELECT ?output ?outputHash ?status ?executedBy ?invokedBy WHERE {
        GRAPH ?g {
          <${process.env.SMOKE_CHILD_EXECUTION_IRI}>
            a <${sr}Execution> ;
            <${sr}output> ?output ;
            <${sr}outputHash> ?outputHash ;
            <${sr}status> ?status ;
            <${sr}executedBy> ?executedBy ;
            <${sr}invokedBy> ?invokedBy .
        }
      }`,
    }));
  '
  child_ready=0
  for _ in $(seq 1 90); do
    curl --fail-with-body --silent --show-error \
      -H "Content-Type: application/json" \
      --data @"$CHILD_CROSS_NODE_QUERY_REQUEST_PATH" \
      "$API_URL_NODE_D/api/query" \
      --output "$CHILD_CROSS_NODE_QUERY_PATH"
    if SMOKE_QUERY_PATH="$CHILD_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
      process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
    '; then
      child_ready=1
      break
    fi
    sleep 1
  done
  if [ "$child_ready" != "1" ]; then
    echo "semantic-runtime-live-smoke: node D did not observe the intermediate Execution" >&2
    cat "$CHILD_CROSS_NODE_QUERY_PATH" >&2
    exit 1
  fi
  TERMINAL_EXECUTION_IRI=$(SMOKE_QUERY_PATH="$CHILD_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
    import fs from "node:fs";
    const value = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8")).result.bindings[0].output;
    process.stdout.write(typeof value === "object" ? value.value : JSON.parse(value));
  ')
  SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
  SMOKE_TERMINAL_EXECUTION_IRI="$TERMINAL_EXECUTION_IRI" \
  SMOKE_TERMINAL_QUERY_REQUEST_PATH="$TERMINAL_CROSS_NODE_QUERY_REQUEST_PATH" \
  node --input-type=module -e '
    import fs from "node:fs";
    const sr = "https://origintrail.io/semantic-runtime/v1#";
    fs.writeFileSync(process.env.SMOKE_TERMINAL_QUERY_REQUEST_PATH, JSON.stringify({
      contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
      view: "verifiable-memory",
      sparql: `SELECT ?output ?outputHash ?status ?executedBy ?invokedBy WHERE {
        GRAPH ?g {
          <${process.env.SMOKE_TERMINAL_EXECUTION_IRI}>
            a <${sr}Execution> ;
            <${sr}output> ?output ;
            <${sr}outputHash> ?outputHash ;
            <${sr}status> ?status ;
            <${sr}executedBy> ?executedBy ;
            <${sr}invokedBy> ?invokedBy .
        }
      }`,
    }));
  '
  terminal_ready=0
  for _ in $(seq 1 90); do
    curl --fail-with-body --silent --show-error \
      -H "Content-Type: application/json" \
      --data @"$TERMINAL_CROSS_NODE_QUERY_REQUEST_PATH" \
      "$API_URL_NODE_D/api/query" \
      --output "$TERMINAL_CROSS_NODE_QUERY_PATH"
    if SMOKE_QUERY_PATH="$TERMINAL_CROSS_NODE_QUERY_PATH" node --input-type=module -e '
      import fs from "node:fs";
      const body = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PATH, "utf8"));
      process.exit(body.result?.bindings?.length === 1 ? 0 : 1);
    '; then
      terminal_ready=1
      break
    fi
    sleep 1
  done
  if [ "$terminal_ready" != "1" ]; then
    echo "semantic-runtime-live-smoke: node D did not observe the terminal Execution" >&2
    cat "$TERMINAL_CROSS_NODE_QUERY_PATH" >&2
    exit 1
  fi
fi

curl --fail-with-body --silent --show-error \
  -H "Content-Type: application/json" \
  --data @"$AUDIT_QUERY_REQUEST_PATH" \
  "$API_URL_NODE_C/api/query" \
  --output "$AUDIT_QUERY_PATH"

SMOKE_STATUS_PATH="$STATUS_PATH" \
SMOKE_PUBLISH_PATH="$PUBLISH_PATH" \
SMOKE_FORK_PATH="$FORK_PATH" \
SMOKE_TERMINAL_FORK_PATH="$TERMINAL_FORK_PATH" \
SMOKE_FORK_QUERY_PATH="$FORK_VM_QUERY_PATH" \
SMOKE_INVOKE_PATH="$INVOKE_PATH" \
SMOKE_SOURCE_INVOKE_PATH="$SOURCE_INVOKE_PATH" \
SMOKE_QUERY_INVOKE_PATH="$QUERY_INVOKE_PATH" \
SMOKE_COMPOSER_INVOKE_PATH="$COMPOSER_INVOKE_PATH" \
SMOKE_COMPOSER_CROSS_QUERY_PATH="$COMPOSER_CROSS_NODE_QUERY_PATH" \
SMOKE_CHILD_CROSS_QUERY_PATH="$CHILD_CROSS_NODE_QUERY_PATH" \
SMOKE_TERMINAL_CROSS_QUERY_PATH="$TERMINAL_CROSS_NODE_QUERY_PATH" \
SMOKE_PROGRAM_PUBLISH_PATH="$PUBLISH_PATH" \
SMOKE_QUERY_PROGRAM_PUBLISH_PATH="$QUERY_PROGRAM_PUBLISH_PATH" \
SMOKE_REMOTE_DENIAL_PATH="$REMOTE_INVOKE_DENIAL_PATH" \
SMOKE_PRIVATE_REMOTE="$PRIVATE_REMOTE" \
SMOKE_CROSS_QUERY_PATH="$CROSS_NODE_QUERY_PATH" \
SMOKE_SOURCE_CROSS_QUERY_PATH="$SOURCE_CROSS_NODE_QUERY_PATH" \
SMOKE_CATALOG_CROSS_QUERY_PATH="$QUERY_CROSS_NODE_QUERY_PATH" \
SMOKE_QUERY_TIMING_PATH="$QUERY_TIMING_PATH" \
SMOKE_AUDIT_QUERY_PATH="$AUDIT_QUERY_PATH" \
SMOKE_NODE_A_LOG="$SMOKE_DEVNET_DIR/node1/daemon.log" \
SMOKE_NODE_B_LOG="$SMOKE_DEVNET_DIR/node2/daemon.log" \
SMOKE_API_URL="$API_URL" \
SMOKE_API_URL_NODE_B="$API_URL_NODE_B" \
SMOKE_API_URL_NODE_C="$API_URL_NODE_C" \
SMOKE_API_URL_NODE_D="$API_URL_NODE_D" \
SMOKE_CONTEXT_GRAPH_ID="$CONTEXT_GRAPH_ID" \
SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH="$PROGRAM_AUTHOR_IDENTITY_PATH" \
SMOKE_INVOKING_NODE_IDENTITY_PATH="$INVOKING_NODE_IDENTITY_PATH" \
SMOKE_QUERYING_NODE_IDENTITY_PATH="$QUERYING_NODE_IDENTITY_PATH" \
SMOKE_VERIFYING_NODE_IDENTITY_PATH="$VERIFYING_NODE_IDENTITY_PATH" \
SMOKE_PROGRAM_IRI="$PROGRAM_IRI" \
SMOKE_FORK_PROGRAM_IRI="$FORK_PROGRAM_IRI" \
SMOKE_QUERY_PROGRAM_IRI="$QUERY_PROGRAM_IRI" \
SMOKE_COMPOSER_PROGRAM_IRI="$COMPOSER_PROGRAM_IRI" \
SMOKE_INTERMEDIATE_PROGRAM_IRI="$INTERMEDIATE_PROGRAM_IRI" \
SMOKE_TERMINAL_PROGRAM_IRI="$TERMINAL_PROGRAM_IRI" \
SMOKE_STRATEGY_PATH="$STRATEGY_PATH" \
SMOKE_RECEIPT_PATH="$RECEIPT_PATH" \
SMOKE_WASM_MANIFEST="$REPO_ROOT/packages/semantic-runtime/generated/integrity.json" \
node --input-type=module -e '
  import crypto from "node:crypto";
  import fs from "node:fs";
  const term = (value) => typeof value === "object" && value !== null ? value.value :
    (typeof value === "string" && value.startsWith("\"") ? JSON.parse(value) : value);
  const privateRemote = process.env.SMOKE_PRIVATE_REMOTE === "1";
  const fork = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_PATH, "utf8"));
  const terminalFork = privateRemote
    ? JSON.parse(fs.readFileSync(process.env.SMOKE_TERMINAL_FORK_PATH, "utf8"))
    : null;
  const forkQuery = JSON.parse(fs.readFileSync(process.env.SMOKE_FORK_QUERY_PATH, "utf8"));
  const invocation = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKE_PATH, "utf8"));
  const sourceInvocation = JSON.parse(fs.readFileSync(process.env.SMOKE_SOURCE_INVOKE_PATH, "utf8"));
  const queryInvocation = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_INVOKE_PATH, "utf8"));
  const sourcePublish = JSON.parse(fs.readFileSync(process.env.SMOKE_PROGRAM_PUBLISH_PATH, "utf8"));
  const queryProgramPublish = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERY_PROGRAM_PUBLISH_PATH, "utf8"));
  const composerInvocation = privateRemote
    ? JSON.parse(fs.readFileSync(process.env.SMOKE_COMPOSER_INVOKE_PATH, "utf8"))
    : null;
  const composerQuery = privateRemote
    ? JSON.parse(fs.readFileSync(process.env.SMOKE_COMPOSER_CROSS_QUERY_PATH, "utf8"))
    : null;
  const childQuery = privateRemote
    ? JSON.parse(fs.readFileSync(process.env.SMOKE_CHILD_CROSS_QUERY_PATH, "utf8"))
    : null;
  const terminalQuery = privateRemote
    ? JSON.parse(fs.readFileSync(process.env.SMOKE_TERMINAL_CROSS_QUERY_PATH, "utf8"))
    : null;
  const remoteInvocationDenial = privateRemote
    ? null
    : JSON.parse(fs.readFileSync(process.env.SMOKE_REMOTE_DENIAL_PATH, "utf8"));
  const sourceAuthor = JSON.parse(fs.readFileSync(process.env.SMOKE_PROGRAM_AUTHOR_IDENTITY_PATH, "utf8"));
  const forkOwner = JSON.parse(fs.readFileSync(process.env.SMOKE_INVOKING_NODE_IDENTITY_PATH, "utf8"));
  const nodeC = JSON.parse(fs.readFileSync(process.env.SMOKE_QUERYING_NODE_IDENTITY_PATH, "utf8"));
  const verifier = JSON.parse(fs.readFileSync(process.env.SMOKE_VERIFYING_NODE_IDENTITY_PATH, "utf8"));
  const query = JSON.parse(fs.readFileSync(process.env.SMOKE_CROSS_QUERY_PATH, "utf8"));
  const sourceQuery = JSON.parse(fs.readFileSync(process.env.SMOKE_SOURCE_CROSS_QUERY_PATH, "utf8"));
  const catalogQuery = JSON.parse(fs.readFileSync(process.env.SMOKE_CATALOG_CROSS_QUERY_PATH, "utf8"));
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
  const sourceRows = sourceQuery.result?.bindings ?? [];
  if (sourceRows.length !== 1) throw new Error(`expected exactly one source Execution, got ${sourceRows.length}`);
  const sourceOutput = term(sourceRows[0].output);
  const sourceOutputHash = term(sourceRows[0].outputHash);
  const sourceStatus = term(sourceRows[0].status);
  if (sourceOutput !== "semantic-runtime-llm-ok") throw new Error(`unexpected source Codex output: ${JSON.stringify(sourceOutput)}`);
  const expectedSourceHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(sourceOutput, "utf8")).digest("hex")}`;
  if (sourceOutputHash !== expectedSourceHash) throw new Error(`source output hash mismatch: ${sourceOutputHash} != ${expectedSourceHash}`);
  if (sourceStatus !== "https://origintrail.io/semantic-runtime/v1#Succeeded") throw new Error(`unexpected source status: ${sourceStatus}`);
  const catalogRows = catalogQuery.result?.bindings ?? [];
  if (catalogRows.length !== 1) throw new Error(`expected exactly one Query Program Execution, got ${catalogRows.length}`);
  const catalogOutput = term(catalogRows[0].output);
  const catalogOutputHash = term(catalogRows[0].outputHash);
  const catalogStatus = term(catalogRows[0].status);
  const expectedCatalogHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(catalogOutput, "utf8")).digest("hex")}`;
  if (catalogOutputHash !== expectedCatalogHash) throw new Error(`query output hash mismatch: ${catalogOutputHash} != ${expectedCatalogHash}`);
  if (catalogStatus !== "https://origintrail.io/semantic-runtime/v1#Succeeded") throw new Error(`unexpected query status: ${catalogStatus}`);
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
  let composition = null;
  if (privateRemote) {
    const composerRows = composerQuery.result?.bindings ?? [];
    const childRows = childQuery.result?.bindings ?? [];
    const terminalRows = terminalQuery.result?.bindings ?? [];
    if (composerRows.length !== 1 || childRows.length !== 1 || terminalRows.length !== 1) {
      throw new Error(`remote composition evidence is incomplete: ${JSON.stringify({ composerRows, childRows, terminalRows })}`);
    }
    const composerRow = Object.fromEntries(Object.entries(composerRows[0]).map(([key, value]) => [key, term(value)]));
    const childRow = Object.fromEntries(Object.entries(childRows[0]).map(([key, value]) => [key, term(value)]));
    const terminalRow = Object.fromEntries(Object.entries(terminalRows[0]).map(([key, value]) => [key, term(value)]));
    if (composerRow.status !== "https://origintrail.io/semantic-runtime/v1#Succeeded") {
      throw new Error(`composer did not succeed: ${composerRow.status}`);
    }
    if (composerRow.executedBy !== sourceAuthor.agentDid) {
      throw new Error(`composer executed by ${composerRow.executedBy}, expected ${sourceAuthor.agentDid}`);
    }
    if (composerRow.invokedBy !== sourceAuthor.agentDid) {
      throw new Error(`composer invoked by ${composerRow.invokedBy}, expected ${sourceAuthor.agentDid}`);
    }
    if (!String(composerRow.output).startsWith("urn:sr:execution:")) {
      throw new Error(`composer output is not a child Execution IRI: ${composerRow.output}`);
    }
    if (childRow.executedBy !== forkOwner.agentDid) {
      throw new Error(`intermediate executed by ${childRow.executedBy}, expected node B ${forkOwner.agentDid}`);
    }
    if (childRow.invokedBy !== sourceAuthor.agentDid) {
      throw new Error(`intermediate invoked by ${childRow.invokedBy}, expected node A ${sourceAuthor.agentDid}`);
    }
    if (!String(childRow.output).startsWith("urn:sr:execution:")) {
      throw new Error(`intermediate output is not a terminal Execution IRI: ${childRow.output}`);
    }
    const expectedChildHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(childRow.output, "utf8")).digest("hex")}`;
    if (childRow.outputHash !== expectedChildHash) {
      throw new Error(`child output hash mismatch: ${childRow.outputHash} != ${expectedChildHash}`);
    }
    if (childRow.status !== "https://origintrail.io/semantic-runtime/v1#Succeeded") {
      throw new Error(`intermediate did not succeed: ${childRow.status}`);
    }
    if (terminalFork.authorAgentAddress.toLowerCase() !== nodeC.agentAddress.toLowerCase()) {
      throw new Error(`terminal Program owner ${terminalFork.authorAgentAddress} did not match node C ${nodeC.agentAddress}`);
    }
    if (terminalRow.output !== "semantic-runtime-llm-ok") {
      throw new Error(`unexpected terminal Codex output: ${JSON.stringify(terminalRow.output)}`);
    }
    const expectedTerminalHash = `sha256:${crypto.createHash("sha256").update(Buffer.from(terminalRow.output, "utf8")).digest("hex")}`;
    if (terminalRow.outputHash !== expectedTerminalHash) {
      throw new Error(`terminal output hash mismatch: ${terminalRow.outputHash} != ${expectedTerminalHash}`);
    }
    if (terminalRow.status !== "https://origintrail.io/semantic-runtime/v1#Succeeded") {
      throw new Error(`terminal did not succeed: ${terminalRow.status}`);
    }
    if (terminalRow.executedBy !== nodeC.agentDid) {
      throw new Error(`terminal executed by ${terminalRow.executedBy}, expected node C ${nodeC.agentDid}`);
    }
    if (terminalRow.invokedBy !== forkOwner.agentDid) {
      throw new Error(`terminal invoked by ${terminalRow.invokedBy}, expected node B ${forkOwner.agentDid}`);
    }
    composition = {
      invocation: composerInvocation,
      parentVm: composerRows[0],
      intermediateVm: childRows[0],
      terminalVm: terminalRows[0],
      verifiedBy: verifier.agentDid,
    };
  }
  if (sourceAuthor.agentAddress.toLowerCase() === forkOwner.agentAddress.toLowerCase()) {
    throw new Error("smoke requires distinct source-author and fork-owner wallets");
  }
  const toolTimings = (logPath, invocationId) => {
    const text = fs.readFileSync(logPath, "utf8");
    return text.split("\n").flatMap((line) => {
      const marker = "semantic-runtime-tool-timing ";
      const at = line.indexOf(marker);
      if (at < 0) return [];
      const tail = line.slice(at + marker.length);
      const end = tail.indexOf("}");
      if (end < 0) return [];
      try {
        const record = JSON.parse(tail.slice(0, end + 1));
        return record.effectId?.includes(`:${invocationId}:`) ? [record] : [];
      } catch {
        return [];
      }
    });
  };
  const timingWindow = (records, label) => {
    const start = records.find((record) => record.phase === "start");
    const finish = records.find((record) => record.phase === "finish");
    if (!start || !finish) throw new Error(`missing ${label} adapter timing records`);
    return { startNs: start.monotonicNs, finishNs: finish.monotonicNs, effectId: start.effectId };
  };
  const sourceTiming = timingWindow(
    toolTimings(process.env.SMOKE_NODE_A_LOG, sourceInvocation.invocationId),
    "source",
  );
  const forkTiming = timingWindow(
    toolTimings(process.env.SMOKE_NODE_B_LOG, invocation.invocationId),
    "fork",
  );
  const queryTiming = timingWindow(
    toolTimings(process.env.SMOKE_NODE_A_LOG, queryInvocation.invocationId),
    "query",
  );
  const overlaps = BigInt(sourceTiming.startNs) < BigInt(forkTiming.finishNs)
    && BigInt(forkTiming.startNs) < BigInt(sourceTiming.finishNs);
  if (!overlaps) throw new Error(`real Codex calls did not overlap: ${JSON.stringify({ sourceTiming, forkTiming })}`);
  const llmAndQueryOverlap = BigInt(sourceTiming.startNs) < BigInt(queryTiming.finishNs)
    && BigInt(queryTiming.startNs) < BigInt(sourceTiming.finishNs);
  if (!llmAndQueryOverlap) throw new Error(`Codex and Query Catalog calls did not overlap: ${JSON.stringify({ sourceTiming, queryTiming })}`);
  const componentInstance = (logPath, executionIri) => {
    const text = fs.readFileSync(logPath, "utf8");
    const escaped = executionIri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`semantic-component-execution-started handle=\\d+ instance=([^ ]+) execution=${escaped}`));
    if (!match) throw new Error(`missing component instance evidence for ${executionIri}`);
    return match[1];
  };
  const sourceComponentInstance = componentInstance(process.env.SMOKE_NODE_A_LOG, sourceInvocation.executionIri);
  const forkComponentInstance = componentInstance(process.env.SMOKE_NODE_B_LOG, invocation.executionIri);
  const queryComponentInstance = componentInstance(process.env.SMOKE_NODE_A_LOG, queryInvocation.executionIri);
  if (new Set([sourceComponentInstance, forkComponentInstance, queryComponentInstance]).size !== 3) {
    throw new Error("concurrent executions shared a component instance");
  }
  const manifest = JSON.parse(fs.readFileSync(process.env.SMOKE_WASM_MANIFEST, "utf8"));
  const evidence = {
    recordedAt: new Date().toISOString(),
    mode: privateRemote
      ? "real-four-node-dkg-private-transitive-remote-inbox-wasm-codex-cross-node-vm"
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
    queriedNode: privateRemote ? "node-d" : "node-c",
    nodeUrls: {
      sourceAuthor: process.env.SMOKE_API_URL,
      forkAuthor: process.env.SMOKE_API_URL_NODE_B,
      secondNodeVerification: process.env.SMOKE_API_URL_NODE_C,
      transitiveVerification: process.env.SMOKE_API_URL_NODE_D,
    },
    contextGraphId: process.env.SMOKE_CONTEXT_GRAPH_ID,
    sourceProgram: {
      programIri: process.env.SMOKE_PROGRAM_IRI,
      programUal: sourcePublish.ual,
    },
    queryProgram: {
      programIri: process.env.SMOKE_QUERY_PROGRAM_IRI,
      programUal: queryProgramPublish.ual,
    },
    fork,
    crossNodeForkVmResult: forkRows[0],
    invocation,
    sourceInvocation,
    queryInvocation,
    ...(composition ? { composition } : {}),
    crossNodeVmResult: rows[0],
    sourceCrossNodeVmResult: sourceRows[0],
    queryCrossNodeVmResult: catalogRows[0],
    crossNodeVmAudit: auditRow,
    concurrency: {
      realCodexCallsOverlap: overlaps,
      llmAndQueryCatalogOverlap: llmAndQueryOverlap,
      sourceTiming,
      forkTiming,
      queryTiming,
      sourceComponentInstance,
      forkComponentInstance,
      queryComponentInstance,
    },
    artifactHashes: {
      legacyWasmSha256: manifest.files["cjs/runtime_bg.wasm"].sha256,
      componentSha256: manifest.files["component/runtime.component.wasm"].sha256,
      witSha256: manifest.files["component/wit/semantic-runtime.wit"].sha256,
      integritySha256: crypto.createHash("sha256").update(fs.readFileSync(process.env.SMOKE_WASM_MANIFEST)).digest("hex"),
    },
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
