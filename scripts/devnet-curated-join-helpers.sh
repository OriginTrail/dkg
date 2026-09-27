#!/usr/bin/env bash
# Join an allowlisted devnet member through the signed request flow. A local
# context-graph/create on the member would make it its own curator and hide
# failures in the curator-to-member path.

_devnet_member_agent_token() {
  local node="$1"
  AGENT_KEYSTORE="$DEVNET_DIR/node${node}/agent-keystore.json" node -e '
    const fs = require("fs");
    try {
      const records = Object.values(JSON.parse(fs.readFileSync(process.env.AGENT_KEYSTORE, "utf8")));
      process.stdout.write(records.find((record) => typeof record?.authToken === "string")?.authToken ?? "");
    } catch { process.stdout.write(""); }
  '
}

_devnet_member_api() {
  local node="$1" method="$2" path="$3" data="${4:-}" token
  token=$(_devnet_member_agent_token "$node")
  [ -n "$token" ] || return 1
  local -a args=(-sS --max-time 60 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && args+=(--data "$data")
  curl "${args[@]}" "http://127.0.0.1:$(node_port "$node")$path"
}

devnet_join_curated_member() {
  local member="$1" curator="$2" cg_id="$3" member_agent="$4"
  local curator_peer curator_addr encoded connected signed body response status delivered subscribed participants ready i
  curator_peer=$(api_call "$curator" GET /api/agent/identity | devnet_json_field_stdin '.peerId') || return 1
  [ -n "$curator_peer" ] || return 1
  curator_addr=$(cat "$DEVNET_DIR/node${curator}/multiaddr") || return 1
  [ -n "$curator_addr" ] || return 1
  connected=0
  for i in 1 2 3; do
    response=$(_devnet_member_api "$member" POST /api/connect "$(CURATOR_ADDR="$curator_addr" node -e 'console.log(JSON.stringify({multiaddr:process.env.CURATOR_ADDR}))')") || return 1
    if [ "$(devnet_json_field "$response" '.connected')" = "true" ]; then connected=1; break; fi
    sleep 5
  done
  [ "$connected" -eq 1 ] || return 1
  encoded=$(CG_ID="$cg_id" node -e 'console.log(encodeURIComponent(process.env.CG_ID))') || return 1
  signed=$(_devnet_member_api "$member" POST "/api/context-graph/${encoded}/sign-join" '{}') || return 1
  body=$(SIGNED_JOIN="$signed" CURATOR_PEER="$curator_peer" node -e '
    const signed = JSON.parse(process.env.SIGNED_JOIN);
    if (!signed.delegation) process.exit(1);
    console.log(JSON.stringify({delegation:signed.delegation, curatorPeerId:process.env.CURATOR_PEER, agentName:"devnet-member"}));
  ') || return 1
  status=""
  delivered=""
  for i in 1 2 3 4; do
    response=$(_devnet_member_api "$member" POST "/api/context-graph/${encoded}/request-join" "$body") || return 1
    status=$(devnet_json_field "$response" '.status') || return 1
    delivered=$(devnet_json_field "$response" '.delivered') || return 1
    if { [ "$status" = "approved" ] || [ "$status" = "already-member" ]; } \
      && { [ "$delivered" = "1" ] || [ "$delivered" = "local" ]; }; then break; fi
    sleep 20
  done
  { [ "$status" = "approved" ] || [ "$status" = "already-member" ]; } || return 1
  { [ "$delivered" = "1" ] || [ "$delivered" = "local" ]; } || return 1
  # The approval notification is asynchronous. Do not count a member ready
  # until the curator's allowlist has reached the member's local metadata.
  ready=0
  for i in $(seq 1 60); do
    participants=$(_devnet_member_api "$member" GET "/api/context-graph/${encoded}/participants") || participants=''
    if MEMBER_AGENT="$member_agent" PARTICIPANTS="$participants" node -e '
      try {
        const j=JSON.parse(process.env.PARTICIPANTS);
        process.exit(Array.isArray(j.allowedAgents) && j.allowedAgents.some((a)=>
          typeof a === "string" && a.toLowerCase() === process.env.MEMBER_AGENT.toLowerCase()) ? 0 : 1);
      } catch { process.exit(1); }
    '; then ready=1; break; fi
    sleep 2
  done
  [ "$ready" -eq 1 ] || return 1
  response=$(_devnet_member_api "$member" POST /api/subscribe "$(CG_ID="$cg_id" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG_ID,includeSharedMemory:true}))')") || return 1
  subscribed=$(devnet_json_field "$response" '.subscribed') || return 1
  [ "$subscribed" = "$cg_id" ]
}

devnet_json_field_stdin() {
  local field="$1"
  node -e '
    let data=""; process.stdin.on("data",c=>data+=c);
    process.stdin.on("end",()=>{try{let v=JSON.parse(data);for(const key of process.argv[1].split(".").filter(Boolean))v=v?.[key];console.log(v??"")}catch{process.exit(1)}})
  ' "$field"
}
