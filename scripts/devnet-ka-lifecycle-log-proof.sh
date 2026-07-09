#!/usr/bin/env bash
#
# Generate repeatable KA publish lifecycle log proof from a running devnet.
#
# Preconditions:
#   ./scripts/devnet.sh start 6
#   pnpm run build
#
# Output:
#   $DEVNET_DIR/ka-lifecycle-log-proof/<timestamp>/
#     metadata.txt  run metadata, assetUal, required tokens, grep command
#     publish.txt   full output from scripts/devnet-test-publish.sh
#     grep.txt      all new ka_lifecycle rows for the published assetUal

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NODE_NUM="${DEVNET_TEST_NODE:-1}"
CONFIRM_TIMEOUT="${CONFIRM_TIMEOUT:-60}"
LIFECYCLE_LOG_TIMEOUT="${LIFECYCLE_LOG_TIMEOUT:-60}"
ARTIFACT_ROOT="${ARTIFACT_ROOT:-$DEVNET_DIR/ka-lifecycle-log-proof}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ARTIFACT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)}"
PUBLISH_SCRIPT="$REPO_ROOT/scripts/devnet-test-publish.sh"
PUBLISHER_LOG="$DEVNET_DIR/node${NODE_NUM}/daemon.log"
BASELINES="$ARTIFACT_DIR/baselines.tsv"
PUBLISH_OUT="$ARTIFACT_DIR/publish.txt"
GREP_OUT="$ARTIFACT_DIR/grep.txt"
METADATA_OUT="$ARTIFACT_DIR/metadata.txt"

REQUIRED_STAGE_TOKENS=(
  "stage=identity"
  "stage=wm"
  "stage=swm_share"
  "stage=storage_ack"
  "stage=chain"
  "stage=vm"
  "stage=finalization"
  "stage=sync"
  "stage=reconcile"
)

REQUIRED_FIELD_TOKENS=(
  "role=publisher"
  "role=receiver"
  "role=sync"
  "event=storage_ack_signed"
  "event=finalization_applied"
  "event=sync_apply"
  "event=reconcile_promote"
)

log()  { printf '[ka-lifecycle-proof] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

line_count() {
  if [ -s "$1" ]; then
    wc -l < "$1" | tr -d ' '
  else
    printf '0'
  fi
}

snapshot_baselines() {
  : > "$BASELINES"
  for log_file in "$DEVNET_DIR"/node*/daemon.log; do
    [ -f "$log_file" ] || continue
    printf '%s\t%s\n' "$log_file" "$(line_count "$log_file")" >> "$BASELINES"
  done
  [ -s "$BASELINES" ] || fail "no daemon logs found under $DEVNET_DIR/node*/daemon.log"
}

baseline_for_log() {
  awk -F '\t' -v target="$1" '$1 == target { print $2 }' "$BASELINES" | tail -n 1
}

collect_lifecycle_grep() {
  local tmp_out="$GREP_OUT.tmp"
  : > "$tmp_out"
  while IFS=$'\t' read -r log_file baseline_lines; do
    [ -f "$log_file" ] || continue
    node_name="$(basename "$(dirname "$log_file")")"
    tail -n +"$((baseline_lines + 1))" "$log_file" \
      | grep -F 'ka_lifecycle' \
      | grep -F "assetUal=$ASSET_UAL" \
      | sed "s#^#${node_name} ${log_file}: #" \
      >> "$tmp_out" || true
  done < "$BASELINES"
  mv "$tmp_out" "$GREP_OUT"
}

missing_tokens() {
  local missing=""
  local token
  for token in "${REQUIRED_STAGE_TOKENS[@]}" "${REQUIRED_FIELD_TOKENS[@]}"; do
    if ! grep -F "$token" "$GREP_OUT" >/dev/null 2>&1; then
      missing="${missing}${missing:+ }${token}"
    fi
  done
  printf '%s' "$missing"
}

write_metadata() {
  local git_sha git_branch node_count
  git_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  git_branch="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || printf 'unknown')"
  node_count="$(find "$DEVNET_DIR" -maxdepth 1 -type d -name 'node*' | wc -l | tr -d ' ')"

  {
    printf 'generatedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'gitSha=%s\n' "$git_sha"
    printf 'gitBranch=%s\n' "$git_branch"
    printf 'repoRoot=%s\n' "$REPO_ROOT"
    printf 'devnetDir=%s\n' "$DEVNET_DIR"
    printf 'publisherNode=node%s\n' "$NODE_NUM"
    printf 'nodeCount=%s\n' "$node_count"
    printf 'nodeRoles=node%s publisher/core; other node*/daemon.log entries receiver/core/sync as emitted\n' "$NODE_NUM"
    printf 'publishCommand=DEVNET_DIR=%s DEVNET_TEST_NODE=%s CONFIRM_TIMEOUT=%s %s\n' \
      "$DEVNET_DIR" "$NODE_NUM" "$CONFIRM_TIMEOUT" "$PUBLISH_SCRIPT"
    printf 'assetUal=%s\n' "$ASSET_UAL"
    printf 'batchId=%s\n' "$BATCH_ID"
    printf 'txHash=%s\n' "$TX_HASH"
    printf 'grepCommand=grep -H "ka_lifecycle .*assetUal=%s" %s/node*/daemon.log\n' \
      "$ASSET_UAL" "$DEVNET_DIR"
    printf 'requiredStageTokens=%s\n' "${REQUIRED_STAGE_TOKENS[*]}"
    printf 'requiredFieldTokens=%s\n' "${REQUIRED_FIELD_TOKENS[*]}"
    printf '\n# Captured daemon log baselines before publish\n'
    cat "$BASELINES"
  } > "$METADATA_OUT"
}

mkdir -p "$ARTIFACT_DIR"

[ -f "$DEVNET_DIR/hardhat.pid" ] || fail "devnet not running; start it with ./scripts/devnet.sh start 6"
[ -f "$PUBLISH_SCRIPT" ] || fail "missing publish script: $PUBLISH_SCRIPT"
[ -f "$PUBLISHER_LOG" ] || fail "missing publisher daemon log: $PUBLISHER_LOG"

log "Writing artifact under $ARTIFACT_DIR"
snapshot_baselines
PUBLISHER_BASELINE="$(baseline_for_log "$PUBLISHER_LOG")"
[ -n "$PUBLISHER_BASELINE" ] || fail "publisher log was not captured in baselines: $PUBLISHER_LOG"

log "Publishing one KA through scripts/devnet-test-publish.sh"
set +e
DEVNET_DIR="$DEVNET_DIR" \
DEVNET_TEST_NODE="$NODE_NUM" \
CONFIRM_TIMEOUT="$CONFIRM_TIMEOUT" \
  "$PUBLISH_SCRIPT" > "$PUBLISH_OUT" 2>&1
PUBLISH_RC=$?
set -e
cat "$PUBLISH_OUT"
[ "$PUBLISH_RC" -eq 0 ] || fail "publish script failed; see $PUBLISH_OUT"

CONFIRM_LINE="$(tail -n +"$((PUBLISHER_BASELINE + 1))" "$PUBLISHER_LOG" \
  | grep -E 'On-chain confirmed: UAL=.* batchId=[0-9]+ tx=0x[0-9a-fA-F]+' \
  | tail -n 1 || true)"
[ -n "$CONFIRM_LINE" ] || fail "could not find On-chain confirmed line in $PUBLISHER_LOG"

ASSET_UAL="$(printf '%s\n' "$CONFIRM_LINE" | sed -E 's/.*On-chain confirmed: UAL=([^ ]+) batchId=.*/\1/')"
BATCH_ID="$(printf '%s\n' "$CONFIRM_LINE" | sed -E 's/.* batchId=([0-9]+) tx=.*/\1/')"
TX_HASH="$(printf '%s\n' "$CONFIRM_LINE" | sed -E 's/.* tx=(0x[0-9a-fA-F]+).*/\1/')"

[ -n "$ASSET_UAL" ] || fail "failed to parse assetUal from confirmation line: $CONFIRM_LINE"
[ -n "$BATCH_ID" ] || fail "failed to parse batchId from confirmation line: $CONFIRM_LINE"
[ -n "$TX_HASH" ] || fail "failed to parse tx hash from confirmation line: $CONFIRM_LINE"

log "Captured assetUal=$ASSET_UAL"
log "Waiting up to ${LIFECYCLE_LOG_TIMEOUT}s for lifecycle rows to converge"

MISSING=""
for _ in $(seq 1 "$LIFECYCLE_LOG_TIMEOUT"); do
  collect_lifecycle_grep
  MISSING="$(missing_tokens)"
  [ -z "$MISSING" ] && break
  sleep 1
done

collect_lifecycle_grep
MISSING="$(missing_tokens)"
write_metadata

if [ -n "$MISSING" ]; then
  log "Lifecycle grep output so far:"
  cat "$GREP_OUT"
  fail "missing required lifecycle tokens: $MISSING"
fi

log "Lifecycle proof complete:"
log "  metadata: $METADATA_OUT"
log "  publish:   $PUBLISH_OUT"
log "  grep:      $GREP_OUT"
cat "$GREP_OUT"
