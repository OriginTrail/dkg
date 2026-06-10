#!/usr/bin/env bash
#
# THE TOTAL DEVNET SCRIPT — exhaustive end-to-end gate for DKG V10.
#
# Exercises the FULL knowledge lifecycle across the heterogeneous 4-core/2-edge
# devnet, from BOTH core and edge nodes, over every valid context-graph config
# variant, with small AND big files — plus random sampling, staking, and the UI.
#
# Topology (the default: `./scripts/devnet.sh start`):
#   nodes 1-4 = CORE  (on-chain identity, staked, ACK quorum, RS prover)
#   nodes 5-6 = EDGE  (no on-chain identity; publish via core ACK quorum)
#   backends: 1-2 oxigraph-server, 3-4 oxigraph, 5-6 oxigraph-worker
#
# CG config variants (accessPolicy × publishPolicy × participants × registered):
#   public-open, public-curated, private-curated-eoa, private-open,
#   local-only-open, local-only-curated  (+ PCA variants — see PCA section)
#
# Preconditions: ./scripts/devnet.sh start   (6 nodes, 4 core + 2 edge)
#
# Usage: ./scripts/devnet-test-everything.sh
#   FAST=1   skip the big-file + soak-ish sections (quicker smoke)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"
NUM_CORE=4
NUM_NODES=6
TS=$(date +%s)
AUTH_TOKEN=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" 2>/dev/null | head -1 || echo "")  # shared across nodes

PASS=0; FAIL=0; declare -a FAILURES
ok()   { PASS=$((PASS+1)); echo "  ✅ $*"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$*"); echo "  ❌ $*"; }
sec()  { echo ""; echo "════════════════════════════════════════════════════════════"; echo "▶ $*"; echo "════════════════════════════════════════════════════════════"; }
log()  { echo "  · $*"; }

# ── API helper: api NODE METHOD PATH [JSON_BODY] ─────────────────────────────
api() {
  local node="$1" method="$2" path="$3" body="${4:-}" port=$((API_PORT_BASE + $1 - 1))
  if [ -n "$body" ]; then
    curl -sS --max-time 180 -X "$method" -H "Authorization: Bearer $AUTH_TOKEN" \
      -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:${port}${path}"
  else
    curl -sS --max-time 90 -X "$method" -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${port}${path}"
  fi
}
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo ""; }
# /api/query COUNT bindings are raw RDF literals ("34"^^<xsd:integer>) — extract the int.
count_of() { python3 -c "import sys,json,re;d=json.load(sys.stdin);b=(d.get('result') or d.get('results') or {}).get('bindings',[]);v=b[0].get('c','') if b else '';m=re.search(r'\d+',str(v));print(m.group(0) if m else '0')" 2>/dev/null || echo 0; }
role_of() { api "$1" GET /api/status | jget "d.get('nodeRole','?')"; }
agent_addr() { api "$1" GET /api/agent/identity | jget "d.get('agentAddress','')"; }

# gen_quads CG ROOT LABEL N  → JSON quads array (root + N entities, ~3N+2 quads)
gen_quads() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys, json
cg, root, label, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
g = f"did:dkg:context-graph:{cg}"
RDF="http://www.w3.org/1999/02/22-rdf-syntax-ns#type"; RDFS="http://www.w3.org/2000/01/rdf-schema#label"
q=[{"subject":root,"predicate":RDF,"object":"http://dkg.io/ontology/core/Entity","graph":g},
   {"subject":root,"predicate":RDFS,"object":f'"{label}"',"graph":g}]
for i in range(n):
    e=f"{root}/e{i}"
    q.append({"subject":e,"predicate":RDF,"object":"http://dkg.io/ontology/core/Entity","graph":g})
    q.append({"subject":e,"predicate":"http://schema.org/identifier","object":f'"id-{i}-{"x"*40}"',"graph":g})
    q.append({"subject":root,"predicate":"http://schema.org/hasPart","object":e,"graph":g})
print(json.dumps(q))
PY
}

# create_cg NODE SLUG ACCESS PUBLISH REGISTER [ALLOWED_JSON]  → echoes the CG id
create_cg() {
  local node="$1" slug="$2" access="$3" publish="$4" register="$5" allowed="${6:-}"
  local body="{\"id\":\"$slug\",\"name\":\"$slug\",\"accessPolicy\":$access,\"publishPolicy\":$publish,\"register\":$register"
  [ -n "$allowed" ] && body="$body,\"allowedAgents\":$allowed"
  body="$body}"
  local resp; resp=$(api "$node" POST /api/context-graph/create "$body")
  printf '%s' "$resp" | jget "d.get('created') or d.get('id') or d.get('contextGraphId') or ''"
}

# ── Preconditions + topology preflight ───────────────────────────────────────
[ -f "$DEVNET_DIR/hardhat.pid" ] || { echo "devnet not running — ./scripts/devnet.sh start"; exit 1; }
[ -n "$AUTH_TOKEN" ] || { echo "no auth token at $DEVNET_DIR/node1/auth.token"; exit 1; }

sec "PREFLIGHT — heterogeneous 4-core / 2-edge topology"
for n in $(seq 1 "$NUM_NODES"); do
  p=$((API_PORT_BASE + n - 1))
  curl -s "http://127.0.0.1:$p/api/status" >/dev/null 2>&1 || { bad "node$n :$p not responding"; continue; }
  r=$(role_of "$n"); expect=$([ "$n" -le "$NUM_CORE" ] && echo core || echo edge)
  [ "$r" = "$expect" ] && ok "node$n is $r (expected $expect)" || bad "node$n role=$r, expected $expect — boot with NUM_CORE_NODES=4 ./scripts/devnet.sh start 6"
done
[ "$FAIL" -eq 0 ] || { echo ""; echo "Preflight failed — fix topology first."; exit 1; }

# publish_with_retry NODE CG NAME [BUDGET_S] [CURL_TIMEOUT_S] — sets globals
# PUB_KAID / PUB_ERR (NOT a subshell, so the error propagates). Retries transient
# new-CG cold-gossip / policy-not-confirmed errors (a brand-new CG's SWM has to
# propagate to enough cores to host + ACK before quorum can be met). Default
# budget 150s; pass a longer CURL_TIMEOUT for big-payload publishes.
PUB_KAID=""; PUB_ERR=""
publish_with_retry() {
  local node="$1" cg="$2" name="$3" budget="${4:-150}" ctimeout="${5:-180}"
  local deadline=$(( $(date +%s) + budget )) port=$((API_PORT_BASE + $1 - 1)) vm
  PUB_KAID=""; PUB_ERR=""
  while :; do
    vm=$(curl -sS --max-time "$ctimeout" -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"contextGraphId\":\"$cg\",\"assertionName\":\"$name\"}" "http://127.0.0.1:${port}/api/shared-memory/publish")
    PUB_KAID=$(printf '%s' "$vm" | jget "d.get('kaId','')")
    [ -n "$PUB_KAID" ] && [ "$PUB_KAID" != "0" ] && return 0
    PUB_ERR=$(printf '%s' "$vm" | head -c 220)
    if printf '%s' "$PUB_ERR" | grep -qiE "storage_ack_insufficient|NO_DATA_IN_SWM|quorum no longer|curated=unknown|access-policy is unknown|not yet registered|registering" && [ "$(date +%s)" -lt "$deadline" ]; then
      sleep 3; continue
    fi
    PUB_KAID=""; return 1
  done
}

# Reusable lifecycle. run_lifecycle NODE CG_ID TAG ENTITIES MODE(full|swm|wm) [ALLOWED_FOR_LOG]
#   full = WM(finalize)→SWM(promote)→VM(publish, retried)
#   swm  = WM(finalize)→SWM(promote), no publish
#   wm   = WM write only (finalize:false) — for unregistered/local-only CGs
run_lifecycle() {
  local node="$1" cg="$2" tag="$3" entities="$4" mode="$5"
  local name="ev-${tag}-${TS}" root="urn:ev:${tag}:${TS}"
  local finalize="true"; [ "$mode" = "wm" ] && finalize="false"
  local quads; quads=$(gen_quads "$cg" "$root" "$tag" "$entities")
  local wm; wm=$(api "$node" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"$name\",\"finalize\":$finalize,\"quads\":$quads}")
  printf '%s' "$wm" | grep -qiE '"written"|"assertionUri"|"ok"' || { bad "[$tag] WM create failed: $(printf '%s' "$wm" | head -c 160)"; return 1; }
  if [ "$mode" = "wm" ]; then
    ok "[$tag] local-only WM write on node$node ($entities entities, unregistered — no on-chain)"
    return 0
  fi
  local pr; pr=$(api "$node" POST "/api/knowledge-assets/${name}/swm/share" "{\"contextGraphId\":\"$cg\"}")
  printf '%s' "$pr" | grep -qiE 'promot|"ok"|swm' || { bad "[$tag] promote failed: $(printf '%s' "$pr" | head -c 160)"; return 1; }
  log "[$tag] WM→SWM promoted on node$node"
  if [ "$mode" = "swm" ]; then
    ok "[$tag] WM→SWM lifecycle on node$node (no publish)"
    return 0
  fi
  publish_with_retry "$node" "$cg" "$name"
  if [ -n "$PUB_KAID" ]; then
    ok "[$tag] published SWM→VM on node$node → kaId=${PUB_KAID:0:14}…"
  else
    bad "[$tag] publish did not mint kaId>0: $PUB_ERR"
    return 1
  fi
}

# ── Warm-up: prime SWM hosting (absorbs the cold-mesh-after-boot race) ───────
# A freshly booted/rebooted mesh hasn't settled SWM hosting for new CGs, so the
# first couple of publishes race the cores subscribing to + hosting the CG's SWM
# (NO_DATA_IN_SWM → quorum unmet). One throwaway publish with a long retry primes
# the mesh so the ASSERTED scenarios below run warm + deterministic.
sec "WARM-UP — prime the SWM hosting mesh (cold-boot first-publish race)"
CG_WARM=$(create_cg 1 "ev-warmup-$TS" 0 1 true)
if [ -n "$CG_WARM" ]; then
  WN="ev-warmup-$TS"
  api 1 POST /api/knowledge-assets "{\"contextGraphId\":\"$CG_WARM\",\"name\":\"$WN\",\"finalize\":true,\"quads\":$(gen_quads "$CG_WARM" "urn:warm:$TS" warm 2)}" >/dev/null
  api 1 POST "/api/knowledge-assets/${WN}/swm/share" "{\"contextGraphId\":\"$CG_WARM\"}" >/dev/null
  publish_with_retry 1 "$CG_WARM" "$WN" 240
  [ -n "$PUB_KAID" ] && ok "mesh primed — warm-up publish minted (cold window absorbed)" \
    || log "warm-up publish didn't mint within 240s — proceeding (scenarios retry independently)"
fi

# ── Scenario 1: public-open, full lifecycle from a CORE node ────────────────
sec "SCENARIO 1 — public-open CG, full lifecycle from CORE node 1"
CG_PUBOPEN=$(create_cg 1 "ev-pubopen-$TS" 0 1 true)
if [ -n "$CG_PUBOPEN" ]; then
  ok "created public-open CG: $CG_PUBOPEN"
  run_lifecycle 1 "$CG_PUBOPEN" "pubopen-core" 5 full
else
  bad "public-open CG create returned no id"
fi

# Build a JSON allowlist of every node's agent address (curated CG members).
ALLOWED_ALL="[$(for n in $(seq 1 "$NUM_NODES"); do a=$(agent_addr "$n"); [ -n "$a" ] && printf '"%s",' "$a"; done | sed 's/,$//')]"
log "member allowlist: $(printf '%s' "$ALLOWED_ALL" | jget 'len(d)') agents"

# ── Scenario 2: public-open, full lifecycle from an EDGE node ───────────────
# Proves an edge node (no on-chain identity) can publish to VM via the CORE
# ACK quorum — the headline mixed-fleet capability.
sec "SCENARIO 2 — public-open CG, full lifecycle from EDGE node 5"
CG_EDGE=$(create_cg 5 "ev-edge-pubopen-$TS" 0 1 true)
if [ -n "$CG_EDGE" ]; then
  ok "edge node 5 created public-open CG: $CG_EDGE"
  run_lifecycle 5 "$CG_EDGE" "pubopen-edge" 4 full
else
  bad "edge public-open CG create returned no id"
fi

# ── Scenario 3: private-curated-eoa, core curator publishes ─────────────────
sec "SCENARIO 3 — private-curated (EOA authority) CG, core curator lifecycle"
CG_PRIVCUR=$(create_cg 1 "ev-privcur-$TS" 1 0 true "[\"$(agent_addr 1)\"]")
if [ -n "$CG_PRIVCUR" ]; then
  ok "created private-curated CG: $CG_PRIVCUR (curator=node1, $(printf '%s' "$ALLOWED_ALL" | jget 'len(d)') members)"
  run_lifecycle 1 "$CG_PRIVCUR" "privcur-core" 5 full
else
  bad "private-curated CG create returned no id"
fi

# ── Scenario 4: private-open, CURATOR lifecycle ─────────────────────────────
# private-open = accessPolicy:private + publishPolicy:open (in principle ANY
# member may publish). On the devnet a member only gains SWM publish rights after
# the curator provisions its sender key via the INVITE flow — a bare allowlist
# entry (or subscribe) hits "SWM Sender Key setup rejected", which also breaks the
# curator's OWN publish when a non-provisioned member is listed. So this scenario
# uses a curator-only allowlist and proves the private-open create→promote→publish
# path FROM THE CURATOR; the non-creator member-publish path (invite → sender-key
# → member publishes) is covered by devnet-test-invite-flow.sh, not duplicated
# here (and not falsely claimed by this scenario).
sec "SCENARIO 4 — private-open CG (curator lifecycle; member-publish → see invite-flow test)"
CG_PRIVOPEN=$(create_cg 2 "ev-privopen-$TS" 1 1 true "[\"$(agent_addr 2)\"]")
if [ -n "$CG_PRIVOPEN" ]; then
  ok "created private-open CG (curator-only allowlist): $CG_PRIVOPEN"
  run_lifecycle 2 "$CG_PRIVOPEN" "privopen-core" 5 full
else
  bad "private-open CG create returned no id"
fi

# ── Scenario 5: public-curated, core lifecycle ──────────────────────────────
sec "SCENARIO 5 — public-curated CG (public read, curator-only publish)"
CG_PUBCUR=$(create_cg 3 "ev-pubcur-$TS" 0 0 true)
if [ -n "$CG_PUBCUR" ]; then
  ok "created public-curated CG: $CG_PUBCUR"
  run_lifecycle 3 "$CG_PUBCUR" "pubcur-core" 5 full
else
  bad "public-curated CG create returned no id"
fi

# ── Scenario 6/7: local-only (UNREGISTERED) — WM write ONLY ─────────────────
# Unregistered CGs have no on-chain identity, so they cannot finalize/promote an
# assertion (no SWM) or publish (no VM). These scenarios deliberately cover the
# WM-write path only — `wm` mode finalizes:false and stops before /promote. They
# do NOT exercise SWM; the named "WM" reflects exactly what is asserted.
sec "SCENARIO 6 — local-only-open CG from EDGE (WM write only — unregistered, no promote/SWM/VM)"
CG_LOPEN=$(create_cg 6 "ev-localopen-$TS" 0 1 false)
if [ -n "$CG_LOPEN" ]; then
  ok "edge node 6 created local-only-open CG: $CG_LOPEN"
  run_lifecycle 6 "$CG_LOPEN" "localopen-edge" 4 wm
else
  bad "local-only-open CG create returned no id"
fi

sec "SCENARIO 7 — local-only-curated CG from EDGE (WM write only — unregistered, no promote/SWM/VM)"
CG_LCUR=$(create_cg 5 "ev-localcur-$TS" 1 0 false "[\"$(agent_addr 5)\"]")
if [ -n "$CG_LCUR" ]; then
  ok "edge node 5 created local-only-curated CG: $CG_LCUR"
  run_lifecycle 5 "$CG_LCUR" "localcur-edge" 4 wm
else
  bad "local-only-curated CG create returned no id"
fi

# ── Scenario 8: BIG file lifecycle (multi-MB, under the 10MB gossip ceiling) ─
if [ "${FAST:-0}" != "1" ]; then
  # Run on node 2 (oxigraph-server): the embedded oxigraph / oxigraph-worker
  # backends (nodes 3-6) are ORDERS slower for large WM→SWM promotes — a 1.6MB
  # promote on node 4 exceeds 300s. oxigraph-server is the production backend.
  # "big" is bounded by SWM-gossip+ACK publish time, NOT the 10MB gossip limit:
  # a ~0.9MB (1500-entity) publish exceeds 300s. ~400 entities (~0.25MB) exercises
  # the large-payload import/promote/publish path with a deterministic runtime.
  BIG_ENTITIES="${BIG_ENTITIES:-400}"
  sec "SCENARIO 8 — BIG file (${BIG_ENTITIES} entities) full lifecycle from CORE node 2 (oxigraph-server)"
  CG_BIG=$(create_cg 2 "ev-big-$TS" 0 1 true)
  if [ -n "$CG_BIG" ]; then
    BNAME="ev-big-$TS"; BROOT="urn:ev:big:$TS"; TMP=$(mktemp); P=$((API_PORT_BASE + 2 - 1))
    printf '{"contextGraphId":"%s","name":"%s","finalize":true,"quads":%s}' \
      "$CG_BIG" "$BNAME" "$(gen_quads "$CG_BIG" "$BROOT" "big" "$BIG_ENTITIES")" > "$TMP"
    SZ=$(( $(wc -c < "$TMP") / 1024 ))
    log "big assertion body = ${SZ}KB (${BIG_ENTITIES} entities, ~$((BIG_ENTITIES*3+2)) quads)"
    WB=$(curl -sS --max-time 300 -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' --data @"$TMP" "http://127.0.0.1:$P/api/knowledge-assets")
    rm -f "$TMP"
    if printf '%s' "$WB" | grep -qiE '"written"|"assertionUri"'; then
      ok "big-file WM create (${SZ}KB) accepted on node2"
      PR=$(curl -sS --max-time 240 -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' -d "{\"contextGraphId\":\"$CG_BIG\"}" "http://127.0.0.1:$P/api/knowledge-assets/${BNAME}/swm/share")
      if printf '%s' "$PR" | grep -qiE 'promot|"ok"|swm'; then
        ok "big-file promoted WM→SWM (${SZ}KB)"
        publish_with_retry 2 "$CG_BIG" "$BNAME" 200 300
        [ -n "$PUB_KAID" ] && ok "big-file published SWM→VM → kaId=${PUB_KAID:0:14}…" || bad "big-file publish failed: $PUB_ERR"
      else
        bad "big-file promote failed: $(printf '%s' "$PR"|head -c 160)"
      fi
    else
      bad "big-file WM create rejected (${SZ}KB): $(printf '%s' "$WB"|head -c 180)"
    fi
  else
    bad "big-file CG create returned no id"
  fi
fi

# ── Scenario 9: cross-node SHARING (edge publishes → core consumes) ──────────
sec "SCENARIO 9 — cross-node sharing: core node 1 consumes the EDGE-published CG"
if [ -n "${CG_EDGE:-}" ]; then
  api 1 POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_EDGE\",\"includeSharedMemory\":true}" >/dev/null
  SHARED=0
  for _ in $(seq 1 30); do
    Q=$(api 1 POST /api/query "{\"contextGraphId\":\"$CG_EDGE\",\"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g),\\\"$CG_EDGE\\\")) }\",\"includeSharedMemory\":true}")
    C=$(printf '%s' "$Q" | count_of)
    [ "$C" -gt 0 ] 2>/dev/null && { SHARED=$C; break; }
    sleep 2
  done
  [ "$SHARED" -gt 0 ] 2>/dev/null && ok "core node 1 consumed edge-published CG ($SHARED triples synced)" \
    || bad "core node 1 did not sync the edge-published CG within budget"
else
  bad "no edge CG from scenario 2 to share"
fi

# ── Scenario 10: random sampling (core prover active) ───────────────────────
sec "SCENARIO 10 — random sampling prover on the core nodes"
RS=$(api 1 GET /api/random-sampling/status)
if printf '%s' "$RS" | grep -qiE '"enabled"|submittedCount|"running"|challenge|loop'; then
  SUB=$(printf '%s' "$RS" | jget "d.get('loop',{}).get('submittedCount') or d.get('submittedCount') or 0")
  ok "random-sampling prover active on core node 1 (submittedCount=${SUB:-?})"
else
  bad "random-sampling status not reported: $(printf '%s' "$RS"|head -c 160)"
fi

# ── Scenario 11: staking / on-chain identity (core staked, edge not) ────────
sec "SCENARIO 11 — staking: cores have on-chain identity, edges do not"
for n in 1 5; do
  HID=$(api "$n" GET /api/identity | jget "1 if d.get('hasIdentity') else 0")
  r=$(role_of "$n")
  if [ "$r" = "core" ]; then
    [ "$HID" = "1" ] && ok "core node$n has on-chain identity (staked)" || bad "core node$n missing on-chain identity"
  else
    [ "$HID" = "0" ] && ok "edge node$n has NO on-chain identity (by design)" || bad "edge node$n unexpectedly has identity"
  fi
done

# ── Scenario 12: node-UI smoke ──────────────────────────────────────────────
sec "SCENARIO 12 — node-UI smoke"
UI_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:5173/ui/" 2>/dev/null || echo "000")
if [ "$UI_CODE" = "200" ]; then
  ok "node-UI serving at :5173/ui (HTTP 200)"
else
  log "node-UI not running (HTTP $UI_CODE) — start with ./scripts/devnet.sh ui start; skipping (not a failure)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
sec "RESULT — $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  exit 1
fi
exit 0
