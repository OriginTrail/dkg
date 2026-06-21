#!/usr/bin/env bash
#
# OT-RFC-39 / LU-11 — COMPREHENSIVE devnet validation.
#
# Drives FOUR scenarios against the same 6-node devnet, each
# culminating in an on-chain `submitChallengeProof` against the KC
# published in that scenario:
#
#   Scenario A — PUBLIC CG random sampling (regression).
#     Confirms PR-B's `_isCGEligible` revert (which re-enables curated
#     CGs in the picker) did NOT regress the existing public-CG path.
#     Picker draws a public KC, prover takes the flat-KC branch
#     (`extractV10KCFromStore` + `V10MerkleTree`), proof lands.
#
#   Scenario B — CURATED CG, SINGLE chunk.
#     Smallest LU-11 happy path: 1KB plaintext → 1 chunk. Validates
#     PR-A end-to-end: chunked emit, per-chunk SWM gossip, V2 ACK,
#     on-chain (root,count) commitment, off-chain prover picks curated
#     branch and lands the proof.
#
#   Scenario C — CURATED CG, MULTI-chunk.
#     ≥64KB plaintext → ≥2 chunks. The interesting one: exercises
#     `V10CiphertextChunksMerkleTree` with multiple leaves,
#     deterministic per-chunk AEAD nonces, multi-chunk Merkle root
#     recomputation in the V2 ACK verifier, and the prover's
#     `extractCiphertextChunksFromStore` GRAPH ?g scan across more
#     than one chunk subject URI.
#
#   Scenario D — LATE-JOIN auto-backfill (OT-RFC-39 prover ↔ sync verb).
#     The most-spec-coverage scenario: core node 4 is taken DOWN, a
#     curated CG is published (so node 4 misses the chunked SWM
#     envelopes entirely), node 4 is restarted, then we mine blocks
#     until the picker draws the missed KC for node 4. The prover's
#     `extractCiphertextChunksFromStore` raises
#     `CiphertextChunksMissingError`; the new backfill hook in
#     `random-sampling-bind` pulls the missing chunks from the other
#     cores via `PROTOCOL_GET_CIPHERTEXT_CHUNK`; the prover retries
#     the extract and lands a proof. Pass criteria: node 4's daemon
#     log contains `LU-11 backfill done … fetched=N` with N ≥ 1 AND
#     node 4's `submittedCount` strictly increased after restart.
#
# Each scenario snapshots `submittedCount` per core BEFORE publishing,
# `hardhat_mine`s 250 blocks AFTER publish to guarantee a fresh
# sampling period, and asserts at least one core's count strictly
# increases. The cores' `lastSubmittedTxHash` after the bump is the
# concrete proof tx — printed at the end for operator follow-up.
#
# Preconditions: devnet already running.
#   ./scripts/devnet.sh start 6
# (Honours DEVNET_DIR / HARDHAT_PORT / API_PORT_BASE env overrides.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CORE_NODES=(1 2 3 4)
EDGE_CURATOR_NODE=5
RS_TIMEOUT="${RS_TIMEOUT:-180}"
# Scenario D is wider: the picker has to draw node 4 specifically for
# the late-published curated KC (random per period; ~25% per period
# with 4 equal-stake cores). 600s ≈ 6 sampling periods at the devnet's
# 100-block / ~50s cadence after we mine to advance, plus headroom for
# the gossip-mesh resubscribe delay.
RS_BACKFILL_TIMEOUT="${RS_BACKFILL_TIMEOUT:-600}"
LIBP2P_PORT_BASE="${LIBP2P_PORT_BASE:-10001}"
# proofingPeriodDurationInBlocks is 100 on devnet; mining 250 reliably
# advances past a period boundary with margin for slippage.
MINE_BLOCKS_AFTER_PUBLISH=250

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

# Per-scenario summary collector
SCENARIO_RESULTS=()

log()  { echo "[rfc39-comp] $*"; }
warn() { echo "[rfc39-comp] WARN: $*" >&2; }
fail() { echo "[rfc39-comp] FAIL: $*" >&2; exit 1; }
banner() {
  echo ""
  echo "================================================================"
  echo "  $*"
  echo "================================================================"
}

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

# Extract `loop.submittedCount` from /api/random-sampling/status (or 0).
get_submitted_count() {
  local node="$1" status
  status=$(api_call "$node" GET /api/random-sampling/status 2>/dev/null || true)
  printf '%s' "$status" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log((j.loop||{}).submittedCount||0); }
      catch(e) { console.log(0); }
    })
  ' 2>/dev/null || echo 0
}

# Extract `loop.lastSubmittedTxHash` from /api/random-sampling/status.
get_last_submitted_tx() {
  local node="$1" status
  status=$(api_call "$node" GET /api/random-sampling/status 2>/dev/null || true)
  printf '%s' "$status" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log((j.loop||{}).lastSubmittedTxHash||""); }
      catch(e) { console.log(""); }
    })
  ' 2>/dev/null || echo ""
}

# Snapshot baselines for the four cores into two parallel arrays.
declare BASELINE_KEYS=""
snap_baseline() {
  BASELINE_KEYS=""
  for n in "${CORE_NODES[@]}"; do
    local c
    c=$(get_submitted_count "$n")
    BASELINE_KEYS+="${n}=${c} "
  done
}
baseline_for() {
  local target="$1" tok
  for tok in $BASELINE_KEYS; do
    local k="${tok%%=*}"; local v="${tok#*=}"
    if [ "$k" = "$target" ]; then echo "$v"; return; fi
  done
  echo 0
}

# Mine N blocks via hardhat_mine RPC. Args: blocks (decimal).
hardhat_mine_blocks() {
  local blocks="$1"
  local hexcount
  hexcount=$(printf '0x%x' "$blocks")
  local resp
  resp=$(curl -sS -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hardhat_mine\",\"params\":[\"${hexcount}\"]}" \
    "http://127.0.0.1:${HARDHAT_PORT}" 2>/dev/null || true)
  if printf '%s' "$resp" | grep -q '"result":true'; then
    return 0
  fi
  warn "hardhat_mine response was unexpected: $resp"
  return 1
}

# Read on-chain (ciphertextChunksRoot, ciphertextChunkCount) for kaId.
read_ct_commitment() {
  local kc_id="$1"
  ( cd "$REPO_ROOT/packages/evm-module" && \
    RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
    CONTRACTS_JSON="$CONTRACTS_JSON" \
    ABI_DIR="$EVM_ABI_DIR" \
    KC_ID="$kc_id" \
    node -e '
      const { ethers } = require("ethers");
      const fs = require("fs");
      const path = require("path");
      (async () => {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
        const kcsAddr = contracts.DKGKnowledgeAssets?.evmAddress ?? contracts.KnowledgeCollectionStorage?.evmAddress;
        if (!kcsAddr) throw new Error("DKGKnowledgeAssets / KnowledgeCollectionStorage not deployed");
        const abiFile = fs.existsSync(path.join(process.env.ABI_DIR, "DKGKnowledgeAssets.json")) ? "DKGKnowledgeAssets.json" : "DKGKnowledgeAssets.json";
        const abi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, abiFile), "utf8"));
        const kas = new ethers.Contract(kcsAddr, abi, provider);
        const ctRoot = await kas.getLatestCiphertextChunksRoot(BigInt(process.env.KC_ID));
        const ctCount = await kas.getCiphertextChunkCount(BigInt(process.env.KC_ID));
        const plainRoot = await kas.getLatestMerkleRoot(BigInt(process.env.KC_ID));
        const plainCount = await kas.getMerkleLeafCount(BigInt(process.env.KC_ID));
        console.log(JSON.stringify({ ctRoot, ctCount: ctCount.toString(), plainRoot, plainCount: plainCount.toString() }));
      })().catch(e => { console.error("[kas] " + (e?.shortMessage || e?.message || e)); process.exit(1); });
    '
  )
}

# Wait for ANY core to bump submittedCount above its baseline. Returns
# "$node $count $tx" on success, empty string on timeout.
wait_for_fresh_proof() {
  local end_ts=$(( $(date +%s) + RS_TIMEOUT ))
  while [ "$(date +%s)" -lt "$end_ts" ]; do
    for n in "${CORE_NODES[@]}"; do
      local cur baseline tx
      cur=$(get_submitted_count "$n")
      baseline=$(baseline_for "$n")
      if [ "${cur:-0}" -gt "${baseline:-0}" ] 2>/dev/null; then
        tx=$(get_last_submitted_tx "$n")
        if [ -n "$tx" ]; then
          echo "$n $cur $tx"
          return 0
        fi
      fi
    done
    sleep 5
  done
  return 1
}

# Build a single SWM write payload of ~target_bytes plaintext by
# splatting one long literal across many triples. The publisher will
# concatenate the SWM graph quads → serialize → encrypt → chunk into
# 32KB ciphertext chunks; target_bytes ≈ 64K reliably produces ≥2
# chunks even after compression / N-quads framing trims a little.
build_swm_write_payload() {
  local cg_uri="$1" stamp="$2" target_bytes="$3"
  local triples_per_subject=12
  local literal_chunk_bytes=2048
  local n_subjects=$(( (target_bytes + (triples_per_subject * literal_chunk_bytes) - 1) / (triples_per_subject * literal_chunk_bytes) ))
  [ "$n_subjects" -lt 1 ] && n_subjects=1

  STAMP="$stamp" CG_URI="$cg_uri" N_SUBJECTS="$n_subjects" \
  TRIPLES_PER_SUBJECT="$triples_per_subject" LITERAL_BYTES="$literal_chunk_bytes" \
  node -e '
    const cg = process.env.CG_URI;
    const stamp = process.env.STAMP;
    const N = +process.env.N_SUBJECTS;
    const T = +process.env.TRIPLES_PER_SUBJECT;
    const B = +process.env.LITERAL_BYTES;
    // Deterministic, alphanumeric literal — compresses poorly enough to
    // preserve the rough byte budget even if the publisher gzips
    // anywhere downstream.
    const literal = ("abcdefghijklmnopqrstuvwxyz0123456789".repeat(Math.ceil(B/36))).slice(0, B);
    const quads = [];
    for (let s = 0; s < N; s++) {
      const subj = `urn:rfc39:bulk:${stamp}/s${s}`;
      for (let t = 0; t < T; t++) {
        quads.push({
          subject: subj,
          predicate: `http://schema.org/multiChunkProbe_${t}`,
          object: `"${literal}"`,
          graph: "",
        });
      }
    }
    process.stdout.write(JSON.stringify({ contextGraphId: cg, quads }));
  '
}

# Per-scenario runner. Args:
#   $1 scenario tag (A | B | C)
#   $2 description
#   $3 access policy (0=public, 1=curated)
#   $4 SWM payload mode: "small" | "multi-chunk"
#   $5 expected ciphertextChunkCount-min (0 for public; 1 for B; 2 for C)
run_scenario() {
  local tag="$1" desc="$2" access_policy="$3" payload_mode="$4" min_ct_count="$5"

  banner "Scenario $tag — $desc"

  local stamp cg_slug cg_local_id cg_uri
  stamp=$(date +%s)
  local tag_lc
  tag_lc=$(printf '%s' "$tag" | tr '[:upper:]' '[:lower:]')
  cg_slug="rfc39-${tag_lc}-${stamp}"
  cg_local_id="${CURATOR_AGENT}/${cg_slug}"
  cg_uri="${cg_local_id}"

  local visibility_label
  if [ "$access_policy" = "1" ]; then visibility_label="curated"; else visibility_label="public"; fi

  log "Creating $visibility_label CG '$cg_local_id' (accessPolicy=$access_policy)..."
  # `/api/context-graph/create` silently flips accessPolicy → 1 (curated)
  # whenever `allowedAgents` is non-empty (see cli.ts:1780 — the
  # daemon's intent is "explicit allowlist ⇒ private"). For Scenario A
  # we want a genuinely public CG, so omit `allowedAgents` when
  # accessPolicy=0 and include it (single-curator allowlist) when
  # accessPolicy=1.
  local create_body
  if [ "$access_policy" = "1" ]; then
    create_body=$(cat <<EOF
{
  "id": "${cg_local_id}",
  "name": "RFC-39 comp $tag ${stamp}",
  "description": "OT-RFC-39 comprehensive devnet probe scenario $tag",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}"],
  "register": true
}
EOF
)
  else
    create_body=$(cat <<EOF
{
  "id": "${cg_local_id}",
  "name": "RFC-39 comp $tag ${stamp}",
  "description": "OT-RFC-39 comprehensive devnet probe scenario $tag",
  "accessPolicy": 0,
  "publishPolicy": 0,
  "register": true
}
EOF
)
  fi
  local create_resp
  create_resp=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$create_body")
  local on_chain_id
  on_chain_id=$(printf '%s' "$create_resp" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); if(!j.registered||!j.onChainId){process.exit(1)} console.log(j.onChainId); }
      catch(e){process.exit(1)}
    })' 2>/dev/null) || fail "Scenario $tag: create+register did not return onChainId. Response: $create_resp"
  log "  CG on chain: onChainId=$on_chain_id"

  log "Writing SWM payload ($payload_mode)..."
  local write_body write_resp
  case "$payload_mode" in
    small)
      write_body=$(STAMP="$stamp" CG_URI="$cg_uri" node -e '
        const stamp = process.env.STAMP; const cg = process.env.CG_URI;
        const out = { contextGraphId: cg, quads: [] };
        for (const who of ["alice","bob","carol","dave"]) {
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/name", object: `"${who.charAt(0).toUpperCase()+who.slice(1)} Smallpayload"`, graph: "" });
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/role", object: `"engineering"`, graph: "" });
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/email", object: `"${who}@example.com"`, graph: "" });
        }
        process.stdout.write(JSON.stringify(out));
      ')
      ;;
    multi-chunk)
      # 96KB plaintext → ~3 chunks after AES-GCM framing.
      write_body=$(build_swm_write_payload "$cg_uri" "$stamp" 98304)
      ;;
    *) fail "Scenario $tag: unknown payload mode '$payload_mode'";;
  esac
  write_resp=$(DEVNET_PUBLISH_PRESERVE_BATCH=1 devnet_create_shared_ka "$EDGE_CURATOR_NODE" "$write_body")
  local triples_written
  triples_written=$(printf '%s' "$write_resp" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log(j.triplesWritten||0); } catch(e){console.log(0);}
    })' 2>/dev/null || echo 0)
  log "  triplesWritten=$triples_written"
  [ "$triples_written" -ge 1 ] || fail "Scenario $tag: SWM write reported zero triples: $write_resp"
  sleep 2

  # Snapshot per-core baseline JUST BEFORE the publish so we can later
  # demand a strict increase. Done per-scenario because each scenario
  # bumps counts on at least one core.
  snap_baseline
  log "  Baseline submittedCount per core: $BASELINE_KEYS"

  log "Publishing $visibility_label CG to VM..."
  local publish_resp
  publish_resp=$(devnet_publish_swm_all_roots "$EDGE_CURATOR_NODE" "${cg_uri}" false)
  local publish_status publish_tx publish_kc publish_block
  publish_status=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch(e){console.log("")}})')
  publish_tx=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).txHash||"")}catch(e){console.log("")}})')
  publish_kc=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).kaId||"")}catch(e){console.log("")}})')
  publish_block=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).blockNumber||"")}catch(e){console.log("")}})')

  [ "$publish_status" = "confirmed" ] || fail "Scenario $tag: publish status='$publish_status' (expected confirmed). Full response: $publish_resp"
  [ -n "$publish_tx" ] || fail "Scenario $tag: publish: no txHash. Full response: $publish_resp"
  [ -n "$publish_kc" ] && [ "$publish_kc" != "0" ] || fail "Scenario $tag: publish: zero/empty kaId"
  log "  ✓ publish landed: kaId=$publish_kc tx=$publish_tx block=$publish_block"

  log "Reading on-chain commitment for kaId=$publish_kc..."
  local commitment ct_root ct_count plain_root plain_count
  commitment=$(read_ct_commitment "$publish_kc") || fail "Scenario $tag: on-chain commitment read failed"
  ct_root=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctRoot))')
  ct_count=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctCount))')
  plain_root=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainRoot))')
  plain_count=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainCount))')
  log "  ciphertextChunksRoot:  $ct_root"
  log "  ciphertextChunkCount:  $ct_count"
  log "  plain merkleRoot:      $plain_root  (== batchId)"
  log "  plain merkleLeafCount: $plain_count"
  [ "$plain_count" = "$triples_written" ] || fail "Scenario $tag: preserve-batch publish plain merkleLeafCount=$plain_count, expected triplesWritten=$triples_written"

  local zero_root="0x0000000000000000000000000000000000000000000000000000000000000000"
  if [ "$access_policy" = "1" ]; then
    [ "$ct_root" != "$zero_root" ] || fail "Scenario $tag: RFC-39 INVARIANT BROKEN — ciphertextChunksRoot is zero on a curated KC publish (publisher did NOT take the LU-11 chunked path)"
    [ "$ct_count" -ge "$min_ct_count" ] || fail "Scenario $tag: ciphertextChunkCount=$ct_count, expected ≥ $min_ct_count"
    log "  ✓ on-chain LU-11 commitment is non-zero and meets count expectation (≥$min_ct_count)"
  else
    # Public KCs intentionally have NO ciphertext commitment (legacy
    # path), so root/count MUST be zero.
    [ "$ct_root" = "$zero_root" ] || fail "Scenario $tag: PUBLIC KC unexpectedly has a non-zero ciphertextChunksRoot=$ct_root (chunked path leaked into public path)"
    [ "$ct_count" = "0" ] || fail "Scenario $tag: PUBLIC KC unexpectedly has ciphertextChunkCount=$ct_count (expected 0 — public path must skip LU-11)"
    log "  ✓ public KC correctly carries zero ciphertext commitment"
  fi

  log "Mining $MINE_BLOCKS_AFTER_PUBLISH hardhat blocks to advance into a fresh sampling period..."
  hardhat_mine_blocks "$MINE_BLOCKS_AFTER_PUBLISH" || warn "block-mine RPC call failed"

  log "Polling cores for fresh submitChallengeProof tx (timeout=${RS_TIMEOUT}s)..."
  local proof_line proof_node proof_count proof_tx
  if proof_line=$(wait_for_fresh_proof); then
    proof_node=${proof_line%% *}
    proof_tx=${proof_line##* }
    local rest="${proof_line#* }"
    proof_count="${rest%% *}"
    log "  ✓ core node $proof_node submitted a NEW proof: submittedCount=$proof_count tx=$proof_tx"
  else
    log "  Dumping per-core RS status for diagnostics:"
    for n in "${CORE_NODES[@]}"; do
      log "    node $n: $(api_call "$n" GET /api/random-sampling/status 2>/dev/null || echo '<api error>')"
    done
    log ""
    log "  Tail of node1 daemon log (look for 'rs.tick.*' / 'curated' / 'LU-11'):"
    tail -40 "$(node_log 1)" | sed 's/^/      /'
    fail "Scenario $tag: no core landed a fresh proof within ${RS_TIMEOUT}s"
  fi

  SCENARIO_RESULTS+=("$tag|$visibility_label|kc=$publish_kc|ct_root=${ct_root:0:18}…|ct_count=$ct_count|proof_node=$proof_node|proof_tx=${proof_tx:0:18}…")
}

# --- Scenario D helpers ------------------------------------------------------

# Kill a single core node by its devnet pid, wait for exit, scrub stale
# pid files so the next start_node_inline call boots cleanly.
stop_node_inline() {
  local n="$1"
  local pidf="$(node_dir "$n")/devnet.pid"
  [ -f "$pidf" ] || { warn "stop_node_inline: $pidf missing — assuming already stopped"; return 0; }
  local pid; pid=$(cat "$pidf")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi
  rm -f "$pidf"
  rm -f "$(node_dir "$n")/daemon.pid"
  log "  ✓ node $n stopped"
}

# Re-spawn a single core node using the same invocation devnet.sh
# uses (DKG_HOME=<node_dir>, foreground, log → daemon.log). Waits for
# the API to respond. Returns 0 on ready, non-zero on timeout.
start_node_inline() {
  local n="$1"
  local node_dir; node_dir=$(node_dir "$n")
  local pidf="$node_dir/devnet.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    log "  start_node_inline: node $n already running"
    return 0
  fi
  rm -f "$node_dir/daemon.pid"
  log "  Spawning node $n..."
  DKG_HOME="$node_dir" DKG_NO_BLUE_GREEN=1 \
    node "$REPO_ROOT/packages/cli/dist/cli.js" start --foreground \
    >> "$node_dir/daemon.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$pidf"
  local port; port=$(node_port "$n")
  local token; token=$(node_token "$n")
  local auth_arg=""
  [ -n "$token" ] && auth_arg="-H 'Authorization: Bearer $token'"
  for i in $(seq 1 60); do
    if curl -sf -H "Authorization: Bearer $token" "http://127.0.0.1:${port}/api/status" >/dev/null 2>&1; then
      log "  ✓ node $n API ready (pid=$pid)"
      return 0
    fi
    sleep 1
  done
  warn "start_node_inline: node $n API not ready in 60s (tail of daemon.log):"
  tail -20 "$node_dir/daemon.log" | sed 's/^/    /'
  return 1
}

# Scrub Scenario D's grep marker from node 4's daemon.log BEFORE the
# scenario so a leftover line from a previous run can't false-pass.
# Done by truncating the log; we still preserve the file (open fds).
preflight_clear_log() {
  local n="$1"
  : > "$(node_log "$n")"
}

# Wait for the late-join backfill to fire on a specific core. Watches
# for an `LU-11 backfill done … fetched=[1-9]` line in node $n's
# daemon.log AND a corresponding bump in `submittedCount`. Mines
# fresh blocks every iteration to push sampling periods forward
# (otherwise we'd sit waiting for the next epoch boundary). Returns
# `<count> <tx> <backfill-line>` on success, empty on timeout.
wait_for_backfill_and_proof_on() {
  local n="$1" baseline_n="$2"
  local end_ts=$(( $(date +%s) + RS_BACKFILL_TIMEOUT ))
  local mine_every=60
  local last_mine=0
  while [ "$(date +%s)" -lt "$end_ts" ]; do
    local now_ts; now_ts=$(date +%s)
    if [ $(( now_ts - last_mine )) -ge "$mine_every" ]; then
      hardhat_mine_blocks 250 >/dev/null 2>&1 || true
      last_mine=$now_ts
    fi
    local cur; cur=$(get_submitted_count "$n")
    if [ "${cur:-0}" -gt "${baseline_n:-0}" ] 2>/dev/null; then
      # Only count it if a backfill line precedes the count bump.
      local bf_line
      bf_line=$(grep -E 'LU-11 backfill done .* fetched=[1-9][0-9]*' "$(node_log "$n")" 2>/dev/null | tail -1 || true)
      if [ -n "$bf_line" ]; then
        local tx; tx=$(get_last_submitted_tx "$n")
        echo "$cur|$tx|$bf_line"
        return 0
      fi
    fi
    sleep 5
  done
  return 1
}

run_scenario_d() {
  banner "Scenario D — Late-join auto-backfill (PROTOCOL_GET_CIPHERTEXT_CHUNK)"

  local late_node=4
  local sibling_nodes=(1 2 3)

  log "Stopping node $late_node (simulating offline-during-publish)..."
  stop_node_inline "$late_node"
  # Brief settle so peer-disconnect events propagate to remaining cores.
  sleep 5

  local stamp cg_slug cg_local_id cg_uri
  stamp=$(date +%s)
  cg_slug="rfc39-d-${stamp}"
  cg_local_id="${CURATOR_AGENT}/${cg_slug}"
  cg_uri="${cg_local_id}"

  log "Creating curated CG (node $late_node will miss everything)..."
  local create_body
  create_body=$(cat <<EOF
{
  "id": "${cg_local_id}",
  "name": "RFC-39 comp D late-join ${stamp}",
  "description": "OT-RFC-39 late-join auto-backfill probe",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}"],
  "register": true
}
EOF
)
  local create_resp on_chain_id
  create_resp=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$create_body")
  on_chain_id=$(printf '%s' "$create_resp" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{try{const j=JSON.parse(d); if(!j.registered||!j.onChainId)process.exit(1); console.log(j.onChainId);}catch(e){process.exit(1)}})' 2>/dev/null) || fail "Scenario D: create+register failed: $create_resp"
  log "  CG on chain: onChainId=$on_chain_id"

  # Multi-chunk payload increases the picker weight for this KC. Each
  # extra ciphertext chunk adds another vote in `_pickWeightedChallenge`,
  # so a 3-chunk curated KC outweighs the small 1-chunk and public KCs
  # from earlier scenarios — node 4's first few ticks after restart will
  # almost certainly draw THIS KC.
  log "Writing multi-chunk SWM payload to skew picker weight..."
  local write_body write_resp
  write_body=$(build_swm_write_payload "$cg_uri" "$stamp" 98304)
  write_resp=$(devnet_create_shared_ka "$EDGE_CURATOR_NODE" "$write_body")
  local triples_written
  triples_written=$(printf '%s' "$write_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).triplesWritten||0)}catch(e){console.log(0)}})' 2>/dev/null || echo 0)
  [ "$triples_written" -ge 1 ] || fail "Scenario D: SWM write reported zero triples: $write_resp"
  log "  triplesWritten=$triples_written"
  sleep 2

  log "Publishing curated CG to VM (only nodes ${sibling_nodes[*]} are listening)..."
  local publish_resp publish_status publish_tx publish_kc
  publish_resp=$(devnet_publish_swm_all_roots "$EDGE_CURATOR_NODE" "${cg_uri}" false)
  publish_status=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch(e){console.log("")}})')
  publish_tx=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).txHash||"")}catch(e){console.log("")}})')
  publish_kc=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).kaId||"")}catch(e){console.log("")}})')
  [ "$publish_status" = "confirmed" ] || fail "Scenario D: publish status='$publish_status'. Full response: $publish_resp"
  [ -n "$publish_kc" ] && [ "$publish_kc" != "0" ] || fail "Scenario D: publish: zero/empty kaId"
  log "  ✓ publish landed (node $late_node was offline): kaId=$publish_kc tx=$publish_tx"

  # Read on-chain commitment so the operator can correlate the proof
  # to the right KC; also asserts that the chunked path actually ran.
  local commitment ct_root ct_count
  commitment=$(read_ct_commitment "$publish_kc") || fail "Scenario D: on-chain commitment read failed"
  ct_root=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctRoot))')
  ct_count=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctCount))')
  local zero_root="0x0000000000000000000000000000000000000000000000000000000000000000"
  [ "$ct_root" != "$zero_root" ] || fail "Scenario D: curated KC has zero ciphertextChunksRoot"
  [ "$ct_count" -ge 2 ] || fail "Scenario D: ciphertextChunkCount=$ct_count (expected ≥2 — multi-chunk payload didn't split)"
  log "  ✓ ciphertextChunkCount=$ct_count, ctRoot=${ct_root:0:18}…"

  # Sanity-check: at least one sibling actually persisted chunks for
  # this kaId. If none did, the eventual backfill on node 4 will
  # inherently fail (no peer holds the chunks), and the failure mode
  # masks the interesting RFC-39 path. We scan via the daemon log
  # line emitted by `ingestSwmCiphertextChunkEnvelope` after persist;
  # filtering on the batchId (== plain merkleRoot) keeps us scoped
  # to THIS scenario's KC.
  log "Verifying sibling cores hold chunks for kaId=$publish_kc..."
  local plain_root_short
  plain_root_short=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainRoot.slice(0,18)))')
  local siblings_with_chunks=0
  for s in "${sibling_nodes[@]}"; do
    if grep -q "LU-11: persisted ciphertext chunk.*${plain_root_short}" "$(node_log "$s")" 2>/dev/null; then
      siblings_with_chunks=$((siblings_with_chunks + 1))
    fi
  done
  log "  ✓ ${siblings_with_chunks}/${#sibling_nodes[@]} sibling cores persisted chunks (matched on batchId prefix ${plain_root_short}…)"
  [ "$siblings_with_chunks" -ge 1 ] || fail "Scenario D: no sibling core persisted chunks — backfill source is empty"

  # Snap node 4's baseline BEFORE restart so we can measure the post-
  # restart proof bump unambiguously. Node 4 is offline → API call
  # would fail; treat as 0 (no submission possible while down).
  local baseline_node4=0
  log "  Baseline for node $late_node (offline): submittedCount=$baseline_node4"

  log "Restarting node $late_node..."
  start_node_inline "$late_node" || fail "Scenario D: failed to restart node $late_node"

  # Give the late-joiner time to:
  #  1. resubscribe to the workspace gossip topic (≤ heartbeat ≈ 1s),
  #  2. peer-store identify with siblings (a few seconds),
  #  3. replay the ContextGraphCreated event so subscribedContextGraphs
  #     gets a record for this CG (the chain event poll runs every few s).
  log "  Waiting 30s for node $late_node gossip mesh + chain-event replay to warm up..."
  sleep 30

  # Mine to advance into a fresh sampling period (RS picker re-samples
  # only on a new period). Then poll for the backfill marker + count bump.
  hardhat_mine_blocks 250 >/dev/null 2>&1 || true

  log "Polling node $late_node for LU-11 backfill + proof submission (timeout=${RS_BACKFILL_TIMEOUT}s)..."
  local result
  if result=$(wait_for_backfill_and_proof_on "$late_node" "$baseline_node4"); then
    local cnt tx bf
    cnt=${result%%|*}; rest=${result#*|}
    tx=${rest%%|*}; bf=${rest#*|}
    log "  ✓ node $late_node: backfill fired AND proof landed"
    log "      submittedCount: ${baseline_node4} → ${cnt}"
    log "      tx:            $tx"
    log "      backfill log:  $bf"
    SCENARIO_RESULTS+=("D|curated/late-join|kc=$publish_kc|ct_count=$ct_count|proof_node=$late_node|proof_tx=${tx:0:18}…|backfill=YES")
  else
    log "  Diagnostics — last 60 lines of node $late_node daemon.log:"
    tail -60 "$(node_log "$late_node")" | sed 's/^/      /'
    log "  Node $late_node submittedCount=$(get_submitted_count "$late_node")"
    log "  rs.tick.* lines on node $late_node:"
    grep 'rs.tick' "$(node_log "$late_node")" | tail -20 | sed 's/^/      /' || true
    log "  LU-11 backfill lines on node $late_node:"
    grep 'LU-11 backfill' "$(node_log "$late_node")" | tail -20 | sed 's/^/      /' || true
    fail "Scenario D: node $late_node did not auto-backfill + prove within ${RS_BACKFILL_TIMEOUT}s"
  fi
}

# --- Preconditions -----------------------------------------------------------

log "Checking devnet state..."
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE"; do
  pidf="$(node_dir "$n")/devnet.pid"
  [ -f "$pidf" ] || fail "node $n: missing $pidf"
  kill -0 "$(cat "$pidf")" 2>/dev/null || fail "node $n: pid stale"
  api_call "$n" GET /api/status >/dev/null || fail "node $n: API not reachable"
done
log "Cores + edge curator are up."

# --- Curator identity (shared across all scenarios) --------------------------

CURATOR_IDENTITY=$(api_call "$EDGE_CURATOR_NODE" GET /api/agent/identity)
CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
log "Curator agent: $CURATOR_AGENT (node $EDGE_CURATOR_NODE)"

# --- Scenarios ----------------------------------------------------------------

run_scenario A "PUBLIC CG random sampling (regression check)" 0 small        0
run_scenario B "CURATED CG random sampling — single-chunk"    1 small        1
run_scenario C "CURATED CG random sampling — multi-chunk"     1 multi-chunk  2
run_scenario_d

# --- Final summary -----------------------------------------------------------

banner "RFC-39 COMPREHENSIVE DEVNET VALIDATION: PASS"
for line in "${SCENARIO_RESULTS[@]}"; do
  log "  $line"
done
echo ""
echo "================================================================"
echo "  All four scenarios drove on-chain submitChallengeProof:"
echo "    A) public path     — picker draws + flat-KC prover lands proof"
echo "    B) curated path    — LU-11 chunked emit + curated prover lands"
echo "    C) curated path    — ≥2 chunks, multi-leaf Merkle, fresh proof"
echo "    D) late-join sync  — offline core auto-backfills via the new"
echo "                          PROTOCOL_GET_CIPHERTEXT_CHUNK responder"
echo "                          and lands a proof on a missed KC"
echo "================================================================"
