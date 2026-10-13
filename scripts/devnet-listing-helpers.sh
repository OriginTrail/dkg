#!/usr/bin/env bash
#
# devnet-listing-helpers.sh — what a node's own listing (GET
# /api/context-graph/list) says about one context graph. SOURCE this after
# devnet-lib.sh: it calls api(). bash 3.2 compatible, no side effects on source.
#
# The answers come from scripts/lib/qa/context-graph-listing.mjs, which keeps
# "the node does not follow (or know) the graph" apart from "the node's answer
# could not be read". The functions here keep them apart as well, and a caller
# has to: no evidence is not evidence of absence.

_devnet_listing_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# devnet_listing <node> <subscription|definition> <context graph id>
# Prints the answer (following | not-following | defined | undefined |
# unknown <reason>); status 0 following / defined, 1 not, 2 unknown.
devnet_listing() {
  api "$1" GET /api/context-graph/list | node "$_devnet_listing_dir/lib/qa/context-graph-listing.mjs" "$2" "$3"
}

# devnet_has_definition <node> <context graph id>
# Status 0 only when the node's listing shows the graph with its definition.
# DEVNET_LISTING_ANSWER is what the listing said, for the message of a wait that
# ran out ("undefined" is a node that answered; "unknown ..." is one that did not).
devnet_has_definition() {
  local status=0
  DEVNET_LISTING_ANSWER="$(devnet_listing "$1" definition "$2")" || status=$?
  [ "$status" -eq 0 ] && [ "$DEVNET_LISTING_ANSWER" = "defined" ]
}

# devnet_following <context graph id> <node>...
# Asks each node whether it is subscribed to the graph. Leaves
#   DEVNET_FOLLOWING          the nodes that are, as " node3 node4"
#   DEVNET_FOLLOWING_UNKNOWN  the nodes whose state could not be established,
#                             with the reason, as " node2 (HTTP 500)"
# Status 0 only when EVERY node answered and none follows the graph; 1 when a
# node follows it; 2 when a node's state could not be established (whatever the
# others said). A caller that needs the nodes kept out of a graph must treat 2
# as it treats 1.
devnet_following() {
  local cg="$1" n answer status
  shift
  DEVNET_FOLLOWING=""; DEVNET_FOLLOWING_UNKNOWN=""
  for n in "$@"; do
    status=0
    answer="$(devnet_listing "$n" subscription "$cg")" || status=$?
    # The verdict has to say so in words too: a reader that died answers with a
    # status and nothing else.
    case "$status:$answer" in
      0:following) DEVNET_FOLLOWING="$DEVNET_FOLLOWING node$n" ;;
      1:not-following) ;;
      *:unknown\ *) DEVNET_FOLLOWING_UNKNOWN="$DEVNET_FOLLOWING_UNKNOWN node$n (${answer#unknown })" ;;
      *) DEVNET_FOLLOWING_UNKNOWN="$DEVNET_FOLLOWING_UNKNOWN node$n (no verdict)" ;;
    esac
  done
  [ -z "$DEVNET_FOLLOWING_UNKNOWN" ] || return 2
  [ -z "$DEVNET_FOLLOWING" ] || return 1
  return 0
}
