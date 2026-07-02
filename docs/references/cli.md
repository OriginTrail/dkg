---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# CLI

Run `dkg <command> --help` for the current option surface.

Common commands:

```bash
dkg init                                 # interactive setup: node name, role, relay, triple-store backend (default: oxigraph-server)
dkg init --role core --network <name>    # initialize a Core Node that will create an on-chain node profile on startup
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, store status
dkg logs                                 # tail the daemon log
dkg peers                                # list discovered agents on the network
dkg peer info <peer-id>                  # inspect a peer's identity and addresses

# Direct messaging
dkg send <name> <msg>                    # encrypted direct message to a peer
dkg chat <name>                          # interactive chat with a peer

# Context graphs (projects)
dkg context-graph create <id>            # create a local context graph
dkg context-graph register <id>          # register an existing CG on-chain (unlocks VM)
dkg context-graph add-agent <id> --agent <addr>   # add an agent to a curated CG allowlist (replaces deprecated 'invite')
dkg context-graph list                   # list subscribed context graphs
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id> <curatorPeerId>   # request to join a curated CG (peer id from V10 invite)
dkg context-graph sign-join <id>         # sign a join-request delegation locally without forwarding
dkg context-graph approve-join <id>      # approve a pending join request

# Knowledge Assets: create -> write -> finalize -> share -> publish
dkg ka create <name> -c <cg> --input-file <rdf-file> --share  # one-shot create/write/finalize/share; no VM publish
dkg ka import-file <name> -c <cg> --input-file <file>         # import a document into WM
dkg ka write <name> -c <cg> --input-file <rdf-file>           # append RDF payload quads to WM
dkg ka finalize <name> -c <cg> [--layer wm|swm]               # seal WM, or seal SWM content
dkg ka share <name> -c <cg> [--entity <uri...>]               # WM -> SWM
dkg ka share-async <name> -c <cg>                             # enqueue async WM -> SWM share
dkg ka share-jobs [--context-graph-id <cg>]                   # list async share jobs
dkg ka publish <name> -c <cg>                                 # sync SWM -> VM publish
dkg ka publish-async <name> -c <cg>                           # enqueue SWM -> VM publish
dkg ka pull-from <name> -c <cg> --layer swm|vm                # seed WM from SWM or VM
dkg ka discard <name> -c <cg>                                 # discard WM draft
dkg ka query <name> -c <cg>                                   # read WM quads
dkg ka history <name> -c <cg>                                 # lifecycle descriptor

# Compatibility aliases
dkg assertion import-file <name> -f <file> -c <cg>  # compatibility alias for document import
dkg assertion promote <name> -c <cg>                # compatibility alias for KA share

# Verification and endorsement
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> [--agent <addr>]  # endorse a published KA as the authenticated agent (--agent only asserts the token's agent matches)

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync catchup-status <cg>             # show background catch-up status for a context graph
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher publish-async <cg> <name>  # operational alias for dkg ka publish-async
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats
# publisher wallets must already have on-chain identities/profiles before they can claim VM publish jobs

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show admin and operational wallet addresses and balances
dkg set-ask <amount>                     # set the node's on-chain ask (TRAC per KB·epoch)

# Identity & auth
dkg auth show                            # show the current API auth token
dkg auth rotate                          # generate a new auth token
dkg auth status                          # show whether auth is enabled

# Framework adapters & MCP wiring
dkg openclaw setup                       # install & configure the OpenClaw adapter
dkg hermes setup                         # install & configure the Hermes adapter
dkg mcp setup                            # register the MCP server with Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline / Codex CLI
dkg mcp serve                            # run the MCP server on stdio (invoked by the client; not run manually)

# Community integrations (registry: OriginTrail/dkg-integrations)
dkg integration list [--tier community]  # default tier filter is `verified`+
dkg integration info <slug>              # show details for one entry
dkg integration install <slug>           # install cli/mcp kind; --allow-community for community-tier entries

# Health & maintenance
dkg doctor [--json] [--no-orphan-scan]     # diagnose install state, version skew, orphan clones, config sanity

# Update / rollback
dkg update [--check] [--allow-prerelease]  # update node software
dkg rollback                               # roll back to previous version
```

