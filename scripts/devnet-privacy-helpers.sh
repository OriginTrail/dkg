#!/usr/bin/env bash
# Bash 3.2. Caller supplies ok/fail/warn reporting functions. RC fail records a
# failure and continues; invite fail exits 1. Invalid evidence explicitly aborts
# either legacy suite with exit 1 rather than becoming an empty observation.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/devnet-observation-helpers.sh"

rc_private_peer_privacy() {
  local api="$1" token="$2" subject="$3" context="$4" port="$5" count
  count=$(devnet_query_api "$api" "$token" "SELECT ?o WHERE { <$subject> <http://schema.org/email> ?o }" o rows "{\"contextGraphId\":\"$context\"}") || devnet_observation_abort
  if [ "$count" = 0 ]; then ok "Node $port: no private triple leak"
  else fail "Node $port: private triple leaked! ($count bindings)"; fi
}

rc_publisher_privacy() {
  local api="$1" token="$2" subject="$3" context="$4" count
  count=$(devnet_query_api "$api" "$token" "SELECT ?o WHERE { <$subject> <http://schema.org/email> ?o }" o rows "{\"contextGraphId\":\"$context\"}") || devnet_observation_abort
  if [ "$count" = 0 ]; then ok "Publisher (node 9201) public view does NOT leak private email — privacy boundary intact"
  else fail "Publisher (node 9201) public view leaked private email ($count bindings)"; fi
}

rc_wm_privacy() {
  local api="$1" token="$2" subject="$3" context="$4" count
  count=$(devnet_query_api "$api" "$token" "SELECT ?name WHERE { <$subject> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$context\"}") || devnet_observation_abort
  if [ "$count" = 0 ]; then ok "WM data correctly isolated — not visible on node 2"
  else fail "WM data leaked to node 2 ($count bindings)"; fi
}

# Preserve RC's public advisory behavior: valid visible rows warn and continue.
rc_subgraph_root_isolation() {
  local api="$1" token="$2" subject="$3" context="$4" count
  count=$(devnet_query_api "$api" "$token" "SELECT ?name WHERE { <$subject> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$context\"}") || devnet_observation_abort
  if [ "$count" = 0 ]; then ok "Sub-graph data correctly isolated from root graph"
  else warn "Sub-graph data found in root graph ($count bindings) — may be expected depending on query behavior"; fi
}

invite_outsider_privacy() {
  local api="$1" token="$2" subject="$3" context="$4" count
  count=$(devnet_query_api "$api" "$token" "SELECT ?o WHERE { <$subject> <http://schema.org/name> ?o }" o rows "{\"contextGraphId\":\"$context\",\"graphSuffix\":\"_shared_memory\"}") || devnet_observation_abort
  if [ "$count" = 0 ]; then ok "N3's public query cannot read private SWM"
  else fail "outsider N3 read private SWM"; fi
}
