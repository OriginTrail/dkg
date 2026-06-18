#!/usr/bin/env bash
#
# Shared helpers for devnet scripts that call POST /api/update with
# rc.12 owner-sealed updates (precomputedUpdateAttestation).
#
# Usage: source after setting REPO_ROOT, DEVNET_DIR, NUM_NODES (optional).
#
#   source "$SCRIPT_DIR/devnet-update-helpers.sh"
#   body=$(build_update_body 1 "$kaId" "$cg" "$quads_json") || exit 1
#
: "${REPO_ROOT:?REPO_ROOT must be set}"
: "${DEVNET_DIR:?DEVNET_DIR must be set}"

NUM_NODES="${NUM_NODES:-6}"
CONTRACTS_JSON="${CONTRACTS_JSON:-$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json}"
export CONTRACTS_JSON
UPDATE_SEAL="${UPDATE_SEAL:-node $REPO_ROOT/scripts/devnet-update-seal.mjs}"
CHAIN_CALL="${CHAIN_CALL:-node $REPO_ROOT/scripts/devnet-chain-call.mjs}"

ka_owner_key() {
  local kc=$1
  local owner addr key
  owner=$($CHAIN_CALL DKGKnowledgeAssets ownerOf --json "[\"$kc\"]" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','') or '')" 2>/dev/null)
  [ -z "$owner" ] && return 1
  python3 - "$DEVNET_DIR" "$owner" "$NUM_NODES" <<'PY'
import json, os, sys
devnet_dir = sys.argv[1]
target = sys.argv[2].lower()
max_node = int(sys.argv[3])
for n in range(1, max_node + 1):
    for fname in ("publisher-wallets.json", "wallets.json"):
        p = os.path.join(devnet_dir, f"node{n}", fname)
        if not os.path.exists(p):
            continue
        try:
            data = json.load(open(p))
        except Exception:
            continue
        wallets = data["wallets"] if isinstance(data, dict) and "wallets" in data else data
        if not isinstance(wallets, list):
            continue
        for w in wallets:
            a = (w.get("address") or "").lower()
            if a == target:
                print(w.get("address", "") + "\t" + w.get("privateKey", ""))
                sys.exit(0)
sys.exit(1)
PY
}

# Args: node_num kaId contextGraphId quads_json_array_string [private_quads_json_array_string] [curated_context_graph_id]
# When the 6th arg is set, the seal injects the OT-RFC-49 public `_catalog`
# floor (curated CG) so expectedNewMerkleRoot matches the producer's
# post-injection recompute. Pass the LOCAL context-graph id (== `cg`).
build_update_body() {
  local node=$1 kc=$2 cg=$3 quads_json=$4 private_quads_json="${5:-[]}" curated_cg="${6:-}" key seal owner_line seal_args
  owner_line=$(ka_owner_key "$kc") || return 1
  key="${owner_line##*$'\t'}"
  [ -z "$key" ] && return 1
  seal_args=(--key "$key" --ka-id "$kc" --quads-json "$quads_json")
  if [ "$private_quads_json" != "[]" ] && [ -n "$private_quads_json" ]; then
    seal_args+=(--private-quads-json "$private_quads_json")
  fi
  if [ -n "$curated_cg" ]; then
    seal_args+=(--curated "$curated_cg")
  fi
  seal=$($UPDATE_SEAL "${seal_args[@]}") || return 1
  python3 -c "
import json, sys
wrap = json.loads(sys.argv[1])
if not wrap.get('ok'):
    sys.stderr.write(wrap.get('error','seal failed') + '\n')
    sys.exit(1)
body = {
    'kaId': sys.argv[2],
    'contextGraphId': sys.argv[3],
    'quads': json.loads(sys.argv[4]),
    'precomputedUpdateAttestation': wrap['precomputedUpdateAttestation'],
}
private_quads = json.loads(sys.argv[5])
if private_quads:
    body['privateQuads'] = private_quads
print(json.dumps(body))
" "$seal" "$kc" "$cg" "$quads_json" "$private_quads_json"
}
