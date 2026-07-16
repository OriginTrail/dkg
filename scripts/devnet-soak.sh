#!/usr/bin/env bash
#
# devnet-soak.sh — long-running, RESOURCE-GOVERNED activity soak.
#
# Simulates sustained testnet/mainnet-like activity on an already-running devnet:
# continuous publishing (public + curated CGs), querying, updating and inter-node
# messaging, plus PERIODIC invite flows and staking/withdraw lifecycles. Designed
# to run for HOURS without crashing the host:
#
#   * SINGLE-THREADED + paced — never fans out concurrent load.
#   * MEMORY GOVERNOR — before each tick it reads free system memory and BACKS
#     OFF (doubles the pause, skips the heavy publish) when it drops below a
#     floor, so accumulation can never run away.
#   * HEALTH MONITOR — if nodes are unreachable it logs and waits instead of
#     hammering a dead fleet.
#   * Every activity is BEST-EFFORT and failure-isolated: one failing op is
#     logged and the soak continues.
#
# Usage:   ./scripts/devnet.sh start 6   &&   ./scripts/devnet-soak.sh
# Stop:    Ctrl-C (or `kill <pid>`) — prints a final summary on exit.
#
# Env (all optional):
#   SOAK_HOURS=4              total duration
#   SOAK_TICK_SECONDS=18      base pause between activity batches
#   MEM_FLOOR_PCT=12          back off when free system memory < this
#   SOAK_PERIODIC_TICKS=40    run invite + staking lifecycle every N ticks
#   SOAK_SUMMARY_TICKS=15     emit a progress summary every N ticks
#   SOAK_NODES=6              fleet size
#   SOAK_LOG=<path>           log file (default .devnet/soak-<ts>.log)
#   SOAK_NO_STAKE=1           skip the periodic staking lifecycle
#   SOAK_NO_INVITE=1          skip the periodic invite flow
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NODES="${SOAK_NODES:-6}"
SOAK_HOURS="${SOAK_HOURS:-4}"
TICK="${SOAK_TICK_SECONDS:-18}"
MEM_FLOOR="${MEM_FLOOR_PCT:-12}"
PERIODIC="${SOAK_PERIODIC_TICKS:-40}"
SUMMARY_EVERY="${SOAK_SUMMARY_TICKS:-15}"
TS="$(node -e 'process.stdout.write(String(Date.now()))')"
LOG="${SOAK_LOG:-$DEVNET_DIR/soak-$TS.log}"

PUBLISHED=0 QUERIED=0 UPDATED=0 MESSAGED=0 INVITED=0 STAKED=0 BACKOFFS=0 ERRORS=0 TICKN=0
START_EPOCH="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))')"
# node does the (possibly fractional) hours math; bash arithmetic is integer-only.
# SOAK_SECONDS overrides SOAK_HOURS (handy for short test runs).
DURATION_SECONDS="${SOAK_SECONDS:-$(node -e "process.stdout.write(String(Math.round(($SOAK_HOURS)*3600)))")}"
END_EPOCH=$(( START_EPOCH + DURATION_SECONDS ))

log() { local m="[$(date '+%H:%M:%S')] $*"; echo "$m"; echo "$m" >> "$LOG"; }

# Shared node auth / HTTP / JSON helpers (node_token, node_port, api, code_of,
# body_of, field). Keep the soak's lighter 90s api timeout.
# shellcheck disable=SC2034  # consumed by api() inside the sourced devnet-lib.sh
DKG_API_MAXTIME=90
. "$REPO_ROOT/scripts/devnet-lib.sh" || { echo "FATAL: cannot source devnet-lib.sh" >&2; exit 2; }
jget() { field "$@"; }   # back-compat alias for this script's existing call sites

# free system memory %, macOS (memory_pressure) then Linux (/proc/meminfo), with
# a safe constant only as a last resort. Without the Linux branch the governor is
# inert on CI/devnet hosts (always 50% ⇒ never backs off below MEM_FLOOR).
mem_free_pct() {
  local p
  p=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub(/[^0-9]/,"",$2); print $2; exit}')
  [ -n "$p" ] && { echo "$p"; return; }
  if [ -r /proc/meminfo ]; then
    p=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t>0) printf "%d", (a*100)/t }' /proc/meminfo)
    [ -n "$p" ] && { echo "$p"; return; }
  fi
  echo 50
}
# run_timed <seconds> <cmd...> — best-effort timeout: use `timeout` when present,
# else run directly (hosts without GNU coreutils still work, no dead fallback).
run_timed() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}
nodes_up() {
  local up=0 n
  for n in $(seq 1 "$NODES"); do
    curl -sf --max-time 4 -H "Authorization: Bearer $(node_token "$n")" \
      "http://127.0.0.1:$(node_port "$n")/api/status" >/dev/null 2>&1 && up=$((up+1))
  done
  echo "$up"
}

# publish_ka <node> <cg> <tag> -> 0 on confirmed publish
publish_ka() {
  local node="$1" cg="$2" tag="$3"
  local name="soak-$tag" subj="urn:soak:$tag" r
  api "$node" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"$name\"}" >/dev/null
  api "$node" POST "/api/knowledge-assets/$name/wm/write" \
    "{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"$subj\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"soak $tag\\\"\",\"graph\":\"\"},{\"subject\":\"$subj\",\"predicate\":\"http://schema.org/dateCreated\",\"object\":\"\\\"$(date -u +%FT%TZ)\\\"\",\"graph\":\"\"}]}" >/dev/null
  api "$node" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$cg\"}" >/dev/null
  api "$node" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$cg\"}" >/dev/null
  r=$(api "$node" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$cg\"}")
  local st; st=$(jget "$(body_of "$r")" status)
  [ "$st" = "confirmed" ] || [ "$st" = "finalized" ]
}

# ── setup ───────────────────────────────────────────────────────────────────
curl -sf --max-time 5 -H "Authorization: Bearer $(node_token 1)" \
  "http://127.0.0.1:$(node_port 1)/api/status" >/dev/null \
  || { echo "FATAL: node1 unreachable — run ./scripts/devnet.sh start $NODES first" >&2; exit 2; }

# A small set of long-lived CGs to publish into (public + curated), created once.
CG_PUB="soak-pub-$TS"; CG_PRIV="soak-priv-$TS"
api 1 POST /api/context-graph/create "{\"id\":\"$CG_PUB\",\"name\":\"soak public\",\"accessPolicy\":0}" >/dev/null
api 1 POST /api/context-graph/create "{\"id\":\"$CG_PRIV\",\"name\":\"soak curated\",\"accessPolicy\":1}" >/dev/null
CGS=("$CG_PUB" "$CG_PRIV")

summary() {
  log "──── SUMMARY @ tick $TICKN | $(( ($(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))') - START_EPOCH)/60 ))min elapsed ────"
  log "     published=$PUBLISHED queried=$QUERIED updated=$UPDATED messaged=$MESSAGED invited=$INVITED staked=$STAKED | backoffs=$BACKOFFS errors=$ERRORS | mem_free=$(mem_free_pct)% nodes_up=$(nodes_up)/$NODES"
}
trap 'echo; log "SOAK STOPPING (signal/exit)"; summary; exit 0' INT TERM

log "SOAK START — ${SOAK_HOURS}h, tick=${TICK}s, mem_floor=${MEM_FLOOR}%, periodic=${PERIODIC}, nodes=${NODES}"
log "  CGs: public=$CG_PUB curated=$CG_PRIV   log=$LOG"

# ── main loop ───────────────────────────────────────────────────────────────
while [ "$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))')" -lt "$END_EPOCH" ]; do
  TICKN=$((TICKN+1))
  pause="$TICK"

  # 1. MEMORY GOVERNOR
  free=$(mem_free_pct)
  if [ "${free:-50}" -lt "$MEM_FLOOR" ]; then
    BACKOFFS=$((BACKOFFS+1))
    log "MEM LOW (${free}% < ${MEM_FLOOR}%) — backing off, skipping publish this tick"
    sleep $((TICK*2)); continue
  fi

  # 2. HEALTH MONITOR
  up=$(nodes_up)
  if [ "$up" -eq 0 ]; then log "FLEET DOWN — pausing 60s"; sleep 60; continue; fi
  if [ "$up" -lt $(( (NODES+1)/2 )) ]; then log "DEGRADED ($up/$NODES up) — easing off"; pause=$((TICK*2)); fi

  # 3. ACTIVITY BATCH (best-effort). Bulk publish to the PUBLIC CG from a rotating
  #    CORE node (cores carry the ACK quorum). Each publish flows WM -> SWM -> VM,
  #    so all three memory layers are exercised. Curated/private CG activity
  #    (membership + member writes) is driven by the periodic invite flow below.
  node=$(( (TICKN % 4) + 1 )); cg="$CG_PUB"
  if publish_ka "$node" "$cg" "${TS}-${TICKN}"; then PUBLISHED=$((PUBLISHED+1)); else ERRORS=$((ERRORS+1)); fi

  # query (count quads in the CG we just wrote)
  r=$(api 1 POST /api/query "{\"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { GRAPH <did:dkg:context-graph:$cg> { ?s ?p ?o } }\"}")
  [ "$(code_of "$r")" = "200" ] && QUERIED=$((QUERIED+1)) || ERRORS=$((ERRORS+1))

  # every 3rd tick: a REAL update — publish a KA (mint), then modify the now-
  # published asset on-chain via POST /api/update (the daemon's update primitive,
  # the same call devnet-rs-validation.sh uses), NOT another first-time publish.
  if [ $((TICKN % 3)) -eq 0 ]; then
    un="soak-upd-${TS}-${TICKN}"; us="urn:soak-upd:${TS}-${TICKN}"
    api "$node" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"$un\"}" >/dev/null
    api "$node" POST "/api/knowledge-assets/$un/wm/write" "{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"$us\",\"predicate\":\"http://schema.org/version\",\"object\":\"\\\"1\\\"\",\"graph\":\"\"}]}" >/dev/null
    api "$node" POST "/api/knowledge-assets/$un/wm/finalize" "{\"contextGraphId\":\"$cg\"}" >/dev/null
    api "$node" POST "/api/knowledge-assets/$un/swm/share" "{\"contextGraphId\":\"$cg\"}" >/dev/null
    pubr=$(api "$node" POST "/api/knowledge-assets/$un/vm/publish" "{\"contextGraphId\":\"$cg\"}")
    kaid=$(jget "$(body_of "$pubr")" kaId)
    if [ -n "$kaid" ]; then
      uq="[{\"subject\":\"$us\",\"predicate\":\"http://schema.org/version\",\"object\":\"\\\"2\\\"\",\"graph\":\"\"}]"
      r=$(api "$node" POST /api/update "{\"contextGraphId\":\"$cg\",\"kaId\":\"$kaid\",\"quads\":$uq}")
      [ "$(code_of "$r")" = "200" ] && UPDATED=$((UPDATED+1)) || ERRORS=$((ERRORS+1))
    else
      ERRORS=$((ERRORS+1))   # no kaId from publish ⇒ nothing to update
    fi
  fi

  # every 5th tick: inter-node message node1 -> node2
  if [ $((TICKN % 5)) -eq 0 ]; then
    s2=$(api 2 GET /api/status); peer2=$(body_of "$s2" | sed -n 's/.*"peerId":"\([^"]*\)".*/\1/p' | head -1)
    if [ -n "$peer2" ]; then
      r=$(api 1 POST /api/chat "{\"to\":\"$peer2\",\"text\":\"soak ping tick $TICKN\"}")
      [ "$(code_of "$r")" = "200" ] && MESSAGED=$((MESSAGED+1)) || ERRORS=$((ERRORS+1))
    fi
  fi

  # every PERIODIC ticks: invite flow + staking lifecycle (best-effort, isolated)
  if [ $((TICKN % PERIODIC)) -eq 0 ]; then
    if [ -z "${SOAK_NO_INVITE:-}" ]; then
      log "periodic: invite flow (devnet-test-cli-invite.sh)"
      if run_timed 240 "$REPO_ROOT/scripts/devnet-test-cli-invite.sh" >>"$LOG" 2>&1; then INVITED=$((INVITED+1)); else log "  invite flow failed (isolated)"; ERRORS=$((ERRORS+1)); fi
    fi
    if [ -z "${SOAK_NO_STAKE:-}" ]; then
      log "periodic: conviction emission (conviction-emission-bell)"
      if ( cd "$REPO_ROOT" && pnpm test:devnet:conviction-emission-bell ) >>"$LOG" 2>&1; then STAKED=$((STAKED+1)); else log "  conviction emission failed (isolated)"; ERRORS=$((ERRORS+1)); fi
    fi
  fi

  # 4. periodic summary
  [ $((TICKN % SUMMARY_EVERY)) -eq 0 ] && summary

  # 5. pace
  sleep "$pause"
done

log "SOAK COMPLETE — ${SOAK_HOURS}h reached"
summary
