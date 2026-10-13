# Builder documentation validation — 13 October 2026

Scope: the five-part builder/agent documentation update. Base: `testnet-canary` at `3cfa350bec1ddf864e205a2045b13ffc48f9428e`. No private spec text or operational credentials are included in the public changes.

## Environment

- Published npm package: `@origintrail-official/dkg@10.0.23`, installed into an isolated local prefix.
- macOS, Node.js 22.23.2, native Oxigraph storage.
- Dedicated temporary Edge node home and loopback port; testnet configuration, no funded wallet, relay connections disabled, auto-update disabled.
- A mock-chain control run passed WM operations but could not seal because the mock publisher signer was unavailable. Sealing was then checked against the unfunded testnet-configured node and passed. The control failure is not evidence of a released-node sealing failure.

## Passed

- Published CLI version and 20 command-help surfaces used by the guides, including selected documented flags.
- Atlas CLI: create, write five RDF triples, read back, seal, share, and query. Expected row: Atlas / Oxigraph / `https://example.org/dkg-tutorial/source`.
- HTTP example: write five WM triples, query in separate processes, seal/share, and read the same evidence from SWM.
- OKF: conformant offline mapping of two concepts, nine triples, one resolved link, no broken links; WM import; advancing the same assets to SWM; `verify` reports complete with zero missing triples; export produces two concepts in three files.
- Node Skill template: no missing/unknown substitution tokens; standalone rendering includes the task-procedure link and no unresolved node-version token.
- Published navigation and local file targets, capability metadata, generated-reference freshness, and inline/supplied Turtle parity.

## Coverage limits and release follow-up

An attempted two-node, direct-bootstrap test did not establish peer replication. The consumer refused subscription with `Context Graph read authority is temporarily unavailable`; logs reported `chain-name-binding-unavailable` and public testnet RPC history unavailable for the authority index. A consumer query returned no evidence row. This is a blocked integration check, not a successful empty-graph result. Repeat with healthy authority/discovery dependencies before claiming the separate-node recipe is validated. The collaboration guides now spell out those prerequisites and separate the same-node path.

These checks do not establish a live Hermes/OpenClaw/Prime/MCP-client conversation, local-model inference, external signer behavior, or paid on-chain publication. A fresh process proves server-side data access, not an independent agent conversation. Framework sessions and a GitBook preview/published-site check remain release review tasks.

The smoke helper explicitly excludes paid publication and has no publish command. No funding transaction was performed for this documentation work. See `scripts/docs/README.md` for repeatable commands and the distinction between local sharing and peer replication.
