---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# CLI

Common commands:

```bash
dkg init
dkg start
dkg stop
dkg status
dkg logs
dkg wallet
dkg peers
dkg auth show
dkg context-graph list
dkg assertion import-file <name> -f <file> -c <contextGraphId>
dkg assertion query <name> -c <contextGraphId>
dkg assertion promote <name> -c <contextGraphId>
dkg shared-memory publish <contextGraphId> --name <assertionName>
dkg query <contextGraphId> -q "<sparql>"
dkg mcp setup
dkg hermes setup
dkg openclaw setup
dkg update
dkg rollback
```

Run `dkg <command> --help` for the current option surface.
