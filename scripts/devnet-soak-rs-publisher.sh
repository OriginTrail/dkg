#!/usr/bin/env bash
# The RS soak's publisher (scripts/devnet-soak-rs.sh starts it in the
# background). It publishes a steady workload of default-graph RDF fixtures
# across the two registered CGs and round-robin across all 4 core nodes, and
# logs every attempt to $OUT_DIR/publish.jsonl.
#
# Each attempt creates and shares the draft with devnet-soak-rs-share.mjs,
# which follows the node's answer as a client should (it shares the same
# draft again, or waits for the share job that owns the share), and then
# publishes it with `dkg ka publish`. SOAK_SHARE_RECOVERY_WAIT_SEC bounds the
# wait for a share job (default 300).
#
#   devnet-soak-rs-publisher.sh <repoRoot> <devnetDir> <outDir> <cliJs> \
#     <publishIntervalSec> <endTs> <authToken> <round>
#
# Times are second-resolution: BSD `date` (macOS) does not honour `%N`, and
# bash's $((...)) cannot eat a literal "N", so we deliberately stick to whole
# seconds.
set -uo pipefail
REPO_ROOT="$1"; DEVNET_DIR="$2"; OUT_DIR="$3"; CLI_JS="$4"
PUBLISH_INTERVAL_SEC="$5"; END_TS="$6"; AUTH_TOKEN="$7"; ROUND="$8"
PUBLISH_LOG="$OUT_DIR/publish.jsonl"
: > "$PUBLISH_LOG"
CGS=("devnet-test" "devnet-isolation")
NODES=(1 2 3 4)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/soak-pub.XXXXXX") # a template GNU mktemp accepts too
trap 'rm -rf "$TMP"' EXIT
i=0
while [ "$(date +%s)" -lt "$END_TS" ]; do
  cg="${CGS[$((i % ${#CGS[@]}))]}"
  node_idx=${NODES[$((i % ${#NODES[@]}))]}
  uniq="$(date +%s)-${i}-$$"
  subj="urn:soak:r${ROUND}:i${i}:${uniq}"
  ka_name="soak-${ROUND}-${i}-${uniq}"
  fixture="$TMP/q${i}.nt"
  share_fields="$TMP/share${i}.json"
  cat > "$fixture" <<EOF
<${subj}> <urn:soak:predicate> "value-${i}" .
<${subj}> <urn:soak:round> "${ROUND}" .
<${subj}> <urn:soak:emittedAt> "$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
EOF
  start_s=$(date +%s)
  rc=0
  out=$(SOAK_API_AUTH="$AUTH_TOKEN" node "$REPO_ROOT/scripts/devnet-soak-rs-share.mjs" \
    "$DEVNET_DIR/node${node_idx}" "$cg" "$ka_name" "$fixture" "$share_fields" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    last_out=$(DKG_HOME="$DEVNET_DIR/node${node_idx}" node "$CLI_JS" ka publish "$ka_name" --context-graph-id "$cg" 2>&1) || rc=$?
    out="${out}
${last_out}"
  fi
  end_s=$(date +%s)
  status="ok"
  [ "$rc" -ne 0 ] && status="fail"
  elapsed_s=$((end_s - start_s))
  # The share step writes its fields (share_retries, share_recovery) as JSON
  # members, also when the share fails; one that could not start leaves none.
  share_json=$(cat "$share_fields" 2>/dev/null) || share_json=""
  [ -n "$share_json" ] || share_json='"share_retries":0,"share_recovery":null'
  # Escape only what JSON requires (backslash, double-quote, newline). The
  # `out` capture can contain arbitrary CLI stderr; pipe it through python for
  # a guaranteed-valid string literal.
  out_json=$(printf '%s' "$out" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')
  printf '{"ts":"%s","cg":"%s","node":%d,"i":%d,"subject":"%s","status":"%s","rc":%d,%s,"elapsed_s":%d,"out":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cg" "$node_idx" "$i" "$subj" "$status" "$rc" "$share_json" "$elapsed_s" "$out_json" \
    >> "$PUBLISH_LOG"
  rm -f "$fixture" "$share_fields"
  i=$((i + 1))
  sleep "$PUBLISH_INTERVAL_SEC"
done
