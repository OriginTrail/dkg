#!/usr/bin/env bash
#
# devnet-rs-validation.sh
# ─────────────────────────────────────────────────────────────────────────────
# SURGICAL random-sampling validation. Born out of the rc.12 release validation,
# where the comprehensive harness reported a "1-4% RS success rate" that turned
# out to be THREE different things tangled together:
#
#   1. A BROKEN METRIC. The comprehensive harness computes success as
#      submittedCount / totalTicks. But the prover ticks every ~5s while a node
#      can only submit ONE proof per ~100-block (~100s) proof period; after it
#      solves a period it idles in `already-solved` for ~20 ticks until the next
#      period. So submitted/ticks is structurally capped in the single digits
#      EVEN FOR A 100%-HEALTHY NODE. (Forensics: node1 submitted 39 proofs across
#      39 distinct periods = 100% per-period, but the harness called it "5%".)
#
#   2. SYNC LAG (`kc-not-synced`). Under bursty bulk-publish on a memory-starved
#      box, a core's local triple store lags the chain, so the prover draws a KA
#      whose data hasn't replicated yet. Transient + recoverable, NOT a proving
#      bug.
#
#   3. A REAL PRODUCT BUG (`data-corrupted` / leaf-count-mismatch) that ONLY
#      affects UPDATED KAs: after /api/update, the on-chain merkle commitment
#      reflects the update payload (e.g. 2 leaves) while the prover's store
#      extract still returns the full pre-update KA (hundreds of leaves), so the
#      proof can never match. Tracked separately; this harness deliberately does
#      NOT update its cohort so RS correctness is measured in isolation.
#
# This harness isolates RS proving from all three confounders:
#   - LOW MEMORY:   3 nodes (2 core + 1 edge), tiny KAs (few entities), 1 CG.
#   - NO UPDATES:   the cohort is published once and never updated, so a healthy
#                   prover MUST see ZERO `data-corrupted`.
#   - SYNC GATE:    after publishing, wait for replication to settle before the
#                   observation window so `kc-not-synced` doesn't masquerade as a
#                   proving failure (and is reported separately if it persists).
#   - SUSTAINED:    observe across MANY proof periods (default ~25 min ≈ 15
#                   periods) so the per-period metric has a real denominator. The
#                   devnet epoch is 2,592,000s (never rolls in a short run), so a
#                   single synced cohort keeps every period fed with eligible
#                   value — no need to literally span N epochs.
#   - CORRECT METRIC: per-period success = submits / distinct-proof-periods-seen,
#                   parsed from daemon.log `rs.tick.*` outcomes (the status API
#                   exposes no per-outcome breakdown).
#
# VERDICT (hard gates):
#   - each core submitted >= 1 proof                          (liveness)
#   - data-corrupted == 0 on the non-updated cohort           (proving correctness)
#   - per-period success >= RS_MIN_PER_PERIOD_PCT (default 80)
#
# Env knobs (all optional):
#   BOOTSTRAP=1               wipe + start a fresh devnet first
#   NUM_NODES=3               total nodes (cores + edges)
#   NUM_CORE_NODES=2          core (RS prover) nodes; rest are edge
#   TARGET_KAS=30             KAs to publish into the cohort CG
#   MIN_ENTITIES=5            min KG entities per KA (keep small = low memory)
#   MAX_ENTITIES=40           max KG entities per KA
#   SYNC_SETTLE_S=120         settle window after publish before observing
#   RS_OBSERVE_S=1500         RS observation window (~25 min ≈ 15 periods)
#   RS_MIN_PER_PERIOD_PCT=80  required per-period success rate
#   INCLUDE_UPDATED_COHORT=0  if 1, also publish+update a few KAs and report
#                             their RS outcomes separately (regression marker for
#                             the update<->RS leaf-count bug — does NOT gate)
#   RESULTS_DIR=...           output dir (default .rs-validation/<ts>)
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export REPO_ROOT
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-3}"
NUM_CORE_NODES="${NUM_CORE_NODES:-2}"

TARGET_KAS="${TARGET_KAS:-30}"
MIN_ENTITIES="${MIN_ENTITIES:-5}"
MAX_ENTITIES="${MAX_ENTITIES:-40}"
SYNC_SETTLE_S="${SYNC_SETTLE_S:-120}"
RS_OBSERVE_S="${RS_OBSERVE_S:-1500}"
RS_MIN_PER_PERIOD_PCT="${RS_MIN_PER_PERIOD_PCT:-80}"
INCLUDE_UPDATED_COHORT="${INCLUDE_UPDATED_COHORT:-0}"

TS=$(date -u +'%Y%m%dT%H%M%SZ')
RESULTS="${RESULTS_DIR:-$REPO_ROOT/.rs-validation/$TS}"
mkdir -p "$RESULTS"
ln -sfn "$RESULTS" "$(dirname "$RESULTS")/latest" 2>/dev/null || true

LOG="$RESULTS/run.log"
CHECKS_TSV="$RESULTS/checks.tsv"; : > "$CHECKS_TSV"
RUN_TAG=$(date +%s)

log()     { echo "[rs-val $(date -u +'%H:%M:%S')] $*" | tee -a "$LOG"; }
section() { echo "" | tee -a "$LOG"; echo "━━━━━━━━━━ $* ━━━━━━━━━━" | tee -a "$LOG"; }
record()  { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$CHECKS_TSV"; echo "  [$3] $1/$2 ${4:+— $4}" | tee -a "$LOG"; }
pass()    { record "$1" "$2" PASS "${3:-}"; }
warn()    { record "$1" "$2" WARN "${3:-}"; }
fail()    { record "$1" "$2" FAIL "${3:-}"; }

pyf() { python3 -c '
import sys, json
expr = sys.argv[1]
try: d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
try: print(eval(expr, {"d": d, "__builtins__": __builtins__}))
except Exception: print("")
' "$1"; }

# ── Bootstrap (optional) ─────────────────────────────────────────────────────
if [ "${BOOTSTRAP:-0}" = "1" ]; then
  section "BOOTSTRAP — wipe + start fresh $NUM_NODES-node devnet ($NUM_CORE_NODES core / $((NUM_NODES-NUM_CORE_NODES)) edge)"
  log "Building project..."
  ( cd "$REPO_ROOT" && pnpm run build ) >> "$LOG" 2>&1 || { log "FATAL: build failed"; exit 2; }
  log "devnet clean..."
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh clean ) >> "$LOG" 2>&1 || true
  log "devnet start $NUM_NODES (NUM_CORE_NODES=$NUM_CORE_NODES, publisher enabled)..."
  ( cd "$REPO_ROOT" && NUM_CORE_NODES="$NUM_CORE_NODES" DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start "$NUM_NODES" ) >> "$LOG" 2>&1 \
    || { log "FATAL: devnet start failed"; exit 2; }
  log "Waiting 45s for identity registration + RS prover bind..."
  sleep 45
fi

# ── Auth + preflight ─────────────────────────────────────────────────────────
section "PREFLIGHT — node health + RS prover readiness"
if [ -n "${DKG_AUTH:-}" ]; then AUTH="$DKG_AUTH"
elif [ -r "$DEVNET_DIR/node1/auth.token" ]; then AUTH=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" | head -1)
else log "FATAL: no auth token (set DKG_AUTH or run devnet)"; exit 2; fi
H="Authorization: Bearer $AUTH"

api()  { curl -s --max-time 90 -H "$H" "$@"; }
post() { local port=$1; shift; api -X POST -H "Content-Type: application/json" "http://127.0.0.1:$port$@"; }
get()  { local port=$1; shift; api "http://127.0.0.1:$port$@"; }

NODE_PORT=()
DOWN=""
for n in $(seq 1 "$NUM_NODES"); do
  port=$((API_PORT_BASE + n - 1))
  NODE_PORT+=("$port")
  st=$(get "$port" /api/status 2>/dev/null || echo '{}')
  name=$(echo "$st" | pyf "d.get('name','?')")
  role=$(echo "$st" | pyf "d.get('nodeRole','?')")
  if [ -z "$name" ] || [ "$name" = "?" ]; then DOWN="$DOWN node$n(:$port)"; else log "node$n :$port name=$name role=$role"; fi
done
if [ -n "$DOWN" ]; then fail PREFLIGHT nodes-up "down:$DOWN"; log "FATAL: nodes down"; exit 2; fi
pass PREFLIGHT nodes-up "all $NUM_NODES reachable"

# Confirm each core has an RS prover enabled (identity bound).
RS_READY=0
for n in $(seq 1 "$NUM_CORE_NODES"); do
  port="${NODE_PORT[$((n-1))]}"
  s=$(get "$port" /api/random-sampling/status 2>/dev/null || echo '{}')
  en=$(echo "$s" | pyf "d.get('enabled',False)")
  if [ "$en" = "True" ]; then RS_READY=$((RS_READY+1)); log "  core$n RS prover enabled"; else warn PREFLIGHT rs-ready "core$n RS prover not enabled: ${s:0:160}"; fi
done
if [ "$RS_READY" -ge "$NUM_CORE_NODES" ]; then pass PREFLIGHT rs-ready "$RS_READY/$NUM_CORE_NODES cores have an RS prover"; fi

# ── Cohort CG: create + register + subscribe ─────────────────────────────────
section "COHORT CG — one public CG, registered + subscribed on every node"
CGID="rs-cohort-${RUN_TAG}"
all_nodes_csv=$(seq -s, 1 "$NUM_NODES")
r=$(post "$API_PORT_BASE" /api/context-graph/create \
      -d "{\"id\":\"$CGID\",\"name\":\"$CGID\",\"accessPolicy\":0,\"publishPolicy\":1,\"register\":true}")
if echo "$r" | grep -qiE 'context-graph|registered|created|"id"|onChainId'; then
  pass COHORT cg-create "public CG $CGID created on node1"
else
  fail COHORT cg-create "create failed: ${r:0:200}"; log "FATAL"; exit 2
fi

SUB_OK=0
for n in $(seq 1 "$NUM_NODES"); do
  port="${NODE_PORT[$((n-1))]}"
  rr=$(post "$port" /api/context-graph/subscribe -d "{\"contextGraphId\":\"$CGID\",\"includeSharedMemory\":true}")
  echo "$rr" | grep -q "subscribed" && SUB_OK=$((SUB_OK+1))
done
[ "$SUB_OK" -ge "$NUM_NODES" ] && pass COHORT cg-subscribe "$SUB_OK/$NUM_NODES subscribed" || warn COHORT cg-subscribe "$SUB_OK/$NUM_NODES subscribed"
log "Waiting 15s for subscription catch-up..."
sleep 15

# ── Quad generator (small bodies = low memory) ───────────────────────────────
gen_quads() { # rootUri E
  python3 - "$1" "$2" <<'PY'
import sys, json
root, E = sys.argv[1], int(sys.argv[2])
RDF="http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
q=[{"subject":root,"predicate":RDF,"object":"http://schema.org/Dataset","graph":""},
   {"subject":root,"predicate":"http://schema.org/name","object":'"%s"'%("KA "+root.split(':')[-1]),"graph":""}]
for i in range(E):
    e=f"{root}/e{i}"
    q.append({"subject":e,"predicate":RDF,"object":"http://schema.org/Thing","graph":""})
    q.append({"subject":e,"predicate":"http://schema.org/identifier","object":'"%d"'%i,"graph":""})
    q.append({"subject":root,"predicate":"http://schema.org/hasPart","object":e,"graph":""})
print(json.dumps(q))
PY
}

# Single publish: create named KA -> share to SWM -> publish. Echoes the kaId on success, empty on failure.
publish_one() { # idx node root
  local idx=$1 node=$2 root=$3
  local port="${NODE_PORT[$((node-1))]}"
  local E name w p st kc bodyf attempt
  E=$(( RANDOM % (MAX_ENTITIES - MIN_ENTITIES + 1) + MIN_ENTITIES ))
  name="rs-${RUN_TAG}-${idx}-n${node}"
  bodyf=$(mktemp -t rspub.XXXXXX)
  { printf '{"contextGraphId":"%s","name":"%s","quads":' "$CGID" "$name"; gen_quads "$root" "$E"; printf ',"finalize":true,"alsoShareSwm":true}'; } > "$bodyf"
  w=$(curl -s --max-time 60 -H "$H" -H "Content-Type: application/json" -X POST \
      "http://127.0.0.1:$port/api/knowledge-assets" --data @"$bodyf")
  rm -f "$bodyf"
  [ "$(echo "$w" | pyf "1 if d.get('swmShared') or d.get('status') in ('swm-shared','vm-confirmed') else 0")" = "1" ] || { echo ""; return 1; }
  for attempt in 1 2 3 4 5; do
    p=$(curl -s --max-time 120 -H "$H" -H "Content-Type: application/json" -X POST \
        "http://127.0.0.1:$port/api/knowledge-assets/$name/vm/publish" \
        -d "{\"contextGraphId\":\"$CGID\",\"options\":{\"clearAfter\":false}}")
    st=$(echo "$p" | pyf "d.get('status','')")
    kc=$(echo "$p" | pyf "d.get('kaId','')")
    if [ "$st" = "confirmed" ] || [ "$st" = "finalized" ]; then echo "$kc"; return 0; fi
    case "$p" in
      *"could not be auto-registered"*|*"context graph owner"*) break ;;
      *) sleep 3 ;;
    esac
  done
  echo ""; return 1
}

# ── Owner seed-publish (registers CG on-chain) then bulk publish cohort ───────
section "PUBLISH — owner seed + $TARGET_KAS small KAs into $CGID (NEVER updated)"
SEED_KC=$(publish_one "seed" 1 "urn:rs:${RUN_TAG}:seed")
[ -n "$SEED_KC" ] && pass PUBLISH cg-register "owner seed-publish registered CG (kaId=$SEED_KC)" \
                  || { fail PUBLISH cg-register "owner seed-publish failed"; log "FATAL"; exit 2; }
log "Waiting 15s for on-chain registration to propagate..."
sleep 15

COHORT_KCS="$RESULTS/cohort-kaids.txt"; : > "$COHORT_KCS"
OK=0
for i in $(seq 1 "$TARGET_KAS"); do
  node=$(( (i - 1) % NUM_NODES + 1 ))
  kc=$(publish_one "$i" "$node" "urn:rs:${RUN_TAG}:ka:${i}:n${node}")
  if [ -n "$kc" ]; then OK=$((OK+1)); echo "$kc" >> "$COHORT_KCS"; fi
  [ $(( i % 10 )) -eq 0 ] && log "  ...published $OK/$i so far"
done
if [ "$OK" -ge $(( TARGET_KAS * 7 / 10 )) ]; then pass PUBLISH ka-count "$OK/$TARGET_KAS KAs published"
else warn PUBLISH ka-count "$OK/$TARGET_KAS KAs published (low)"; fi

# ── Sync gate: let replication settle so kc-not-synced isn't a false negative ─
section "SYNC GATE — settle ${SYNC_SETTLE_S}s so cores replicate the cohort"
log "Sleeping ${SYNC_SETTLE_S}s for SWM replication to all cores..."
sleep "$SYNC_SETTLE_S"

# ── Observe RS across many proof periods ─────────────────────────────────────
section "OBSERVE — RS for ${RS_OBSERVE_S}s (~$(( RS_OBSERVE_S / 100 )) proof periods of ~100s)"
# Record per-core daemon.log byte offsets so we parse ONLY this window.
declare -a LOG_OFFSET RS_BASE_SUB
for n in $(seq 1 "$NUM_CORE_NODES"); do
  f="$DEVNET_DIR/node$n/daemon.log"
  LOG_OFFSET[$n]=$( [ -f "$f" ] && wc -c < "$f" | tr -d ' ' || echo 0 )
  port="${NODE_PORT[$((n-1))]}"
  s=$(get "$port" /api/random-sampling/status 2>/dev/null || echo '{}')
  RS_BASE_SUB[$n]=$(echo "$s" | pyf "d.get('loop',{}).get('submittedCount',0)")
  [ -z "${RS_BASE_SUB[$n]}" ] && RS_BASE_SUB[$n]=0
done
log "daemon.log offsets recorded; observing..."

OBSERVE_END=$(( $(date +%s) + RS_OBSERVE_S ))
while [ "$(date +%s)" -lt "$OBSERVE_END" ]; do
  sleep 120
  line="  progress:"
  for n in $(seq 1 "$NUM_CORE_NODES"); do
    port="${NODE_PORT[$((n-1))]}"
    s=$(get "$port" /api/random-sampling/status 2>/dev/null || echo '{}')
    sub=$(echo "$s" | pyf "d.get('loop',{}).get('submittedCount',0)")
    lo=$(echo "$s" | pyf "(d.get('loop',{}).get('lastOutcome') or {}).get('kind','')")
    line="$line core$n(sub=$sub last=$lo)"
  done
  log "$line"
done

# ── Parse daemon.log for the per-outcome taxonomy in THIS window ──────────────
section "ANALYSIS — per-core RS outcome taxonomy (this window only)"
RS_TSV="$RESULTS/rs-outcomes.tsv"
printf 'core\tsubmits\tdistinct_periods\tper_period_pct\talready_solved\tkc_not_synced\tdata_corrupted\tno_eligible_cg\terror\n' > "$RS_TSV"

OVERALL_FAIL=0
TOT_SUB=0; TOT_DC=0
for n in $(seq 1 "$NUM_CORE_NODES"); do
  f="$DEVNET_DIR/node$n/daemon.log"
  off="${LOG_OFFSET[$n]:-0}"
  win="$RESULTS/node$n-rs-window.log"
  if [ -f "$f" ]; then tail -c +"$((off + 1))" "$f" > "$win"; else : > "$win"; fi

  # NB: `grep -c` already prints "0" on zero matches (and exits 1); the script
  # does not run under `set -e`, so capture the count and default if empty.
  # Do NOT use `|| echo 0` — that appends a second line, yielding "0\n0".
  submits=$(grep -c 'rs.tick.submitted' "$win" 2>/dev/null); submits=${submits:-0}
  asolved=$(grep -c 'rs.tick.already-solved' "$win" 2>/dev/null); asolved=${asolved:-0}
  kcns=$(grep -c 'rs.tick.kc-not-synced' "$win" 2>/dev/null); kcns=${kcns:-0}
  dc=$(grep -c 'rs.tick.data-corrupted' "$win" 2>/dev/null); dc=${dc:-0}
  nocg=$(grep -c 'rs.tick.no-eligible-cg' "$win" 2>/dev/null); nocg=${nocg:-0}
  errc=$(grep -c 'rs.tick.error' "$win" 2>/dev/null); errc=${errc:-0}
  # Distinct proof periods that were challenged/active in this window. A node
  # submits at most one proof per period, so per-period success = submits /
  # distinct periods. periodStart appears on submitted + already-solved ticks.
  periods=$(grep -oE '"periodStart":"[0-9]+"' "$win" 2>/dev/null | sort -u | wc -l | tr -d ' ')
  [ -z "$periods" ] && periods=0
  if [ "$periods" -gt 0 ]; then pp=$(( submits * 100 / periods )); else pp=0; fi
  [ "$pp" -gt 100 ] && pp=100
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "core$n" "$submits" "$periods" "$pp" "$asolved" "$kcns" "$dc" "$nocg" "$errc" >> "$RS_TSV"
  log "core$n: submits=$submits periods=$periods per-period=${pp}% | already-solved=$asolved kc-not-synced=$kcns data-corrupted=$dc no-eligible-cg=$nocg error=$errc"
  TOT_SUB=$(( TOT_SUB + submits )); TOT_DC=$(( TOT_DC + dc ))

  # Per-core gates.
  if [ "$submits" -lt 1 ]; then fail OBSERVE rs-liveness-core$n "core$n submitted ZERO proofs in window"; OVERALL_FAIL=1; fi
  if [ "$dc" -gt 0 ]; then
    # data-corrupted on a NEVER-UPDATED cohort = real proving bug.
    samp=$(grep -m1 'rs.tick.data-corrupted' "$win" | grep -oE '\{.*\}' | head -c 300)
    fail OBSERVE rs-data-integrity-core$n "core$n: $dc data-corrupted on non-updated cohort (PROVING BUG) sample=$samp"
    OVERALL_FAIL=1
  fi
  if [ "$periods" -gt 0 ] && [ "$pp" -lt "$RS_MIN_PER_PERIOD_PCT" ]; then
    fail OBSERVE rs-per-period-core$n "core$n per-period success ${pp}% < ${RS_MIN_PER_PERIOD_PCT}% (submits=$submits/periods=$periods)"
    OVERALL_FAIL=1
  elif [ "$periods" -gt 0 ]; then
    pass OBSERVE rs-per-period-core$n "core$n per-period success ${pp}% (submits=$submits/periods=$periods)"
  fi
  # kc-not-synced is sync lag, not a proving bug — surface as WARN only.
  if [ "$kcns" -gt "$submits" ] && [ "$submits" -gt 0 ]; then
    warn OBSERVE rs-sync-lag-core$n "core$n kc-not-synced=$kcns > submits=$submits — replication lagged the prover (sync throughput, not proving)"
  fi
done

if [ "$TOT_DC" -eq 0 ]; then pass OBSERVE rs-data-integrity "0 data-corrupted across all cores on non-updated cohort"; fi

# ── Optional: updated-cohort regression marker (does NOT gate) ───────────────
if [ "$INCLUDE_UPDATED_COHORT" = "1" ]; then
  section "REGRESSION MARKER — updated-KA cohort (expected to show data-corrupted; informational)"
  log "(This block intentionally reproduces the known update<->RS leaf-count bug; it does not affect the verdict.)"
  # Publish a few, update them, then note that RS will report data-corrupted for them.
  UPD_KCS="$RESULTS/updated-kaids.txt"; : > "$UPD_KCS"
  for i in 1 2 3; do
    root="urn:rs:${RUN_TAG}:upd:${i}"
    kc=$(publish_one "upd-$i" 1 "$root")
    if [ -n "$kc" ]; then
      echo "$kc" >> "$UPD_KCS"
      # Minimal 2-triple update (matches the rc.12 harness pattern that exposed the bug).
      newuri="${root}/v2"
      uq="[{\"subject\":\"$newuri\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/UpdateAction\",\"graph\":\"\"},{\"subject\":\"$newuri\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"upd-$i\\\"\",\"graph\":\"\"}]"
      post 1 /api/update -d "{\"contextGraphId\":\"$CGID\",\"kaId\":\"$kc\",\"quads\":$uq}" >/dev/null 2>&1 || true
    fi
  done
  log "updated kaIds: $(tr '\n' ' ' < "$UPD_KCS")  — see issue tracker for the update<->RS leaf-count defect"
  warn REGRESSION updated-cohort "published+updated $(wc -l < "$UPD_KCS" | tr -d ' ') KAs; RS will report data-corrupted for these until the update<->RS extract is fixed (informational)"
fi

# ── Report ───────────────────────────────────────────────────────────────────
section "REPORT"
VERDICT="PASS"; [ "$OVERALL_FAIL" -eq 1 ] && VERDICT="FAIL"
PASS_N=$(grep -c $'\tPASS\t' "$CHECKS_TSV" 2>/dev/null); PASS_N=${PASS_N:-0}
WARN_N=$(grep -c $'\tWARN\t' "$CHECKS_TSV" 2>/dev/null); WARN_N=${WARN_N:-0}
FAIL_N=$(grep -c $'\tFAIL\t' "$CHECKS_TSV" 2>/dev/null); FAIL_N=${FAIL_N:-0}

{
  echo "# Surgical Random-Sampling validation report"
  echo
  echo "- Topology: $NUM_NODES nodes ($NUM_CORE_NODES core / $((NUM_NODES-NUM_CORE_NODES)) edge)"
  echo "- Cohort: $OK KAs in 1 public CG ($CGID), entities ${MIN_ENTITIES}..${MAX_ENTITIES}, NEVER updated"
  echo "- Settle: ${SYNC_SETTLE_S}s | Observe: ${RS_OBSERVE_S}s (~$(( RS_OBSERVE_S / 100 )) periods)"
  echo "- Metric: per-period success = submits / distinct-proof-periods (NOT submits/ticks)"
  echo
  echo "## Verdict: **$VERDICT**  (PASS=$PASS_N WARN=$WARN_N FAIL=$FAIL_N)"
  echo
  echo "## Per-core RS outcomes (observation window only)"
  echo
  column -t -s$'\t' "$RS_TSV" | sed 's/^/    /'
  echo
  echo "## Interpretation"
  echo "- per_period_pct ~100 with data_corrupted=0 ⇒ RS proving is healthy."
  echo "- data_corrupted>0 on this NEVER-updated cohort ⇒ real proving bug (gates FAIL)."
  echo "- high kc_not_synced ⇒ replication/sync throughput lag (NOT proving; WARN only)."
  echo "- no_eligible_cg should be ~0 after publish (epoch never rolls on devnet)."
} > "$RESULTS/REPORT.md"

log ""
log "════════════════════════════════════════════════"
log "VERDICT: $VERDICT | cohort=$OK KAs | submits=$TOT_SUB data-corrupted=$TOT_DC | PASS=$PASS_N WARN=$WARN_N FAIL=$FAIL_N"
log "Report: $RESULTS/REPORT.md"
log "════════════════════════════════════════════════"
[ "$VERDICT" = "PASS" ] && exit 0 || exit 1
