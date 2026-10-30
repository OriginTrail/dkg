---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Feature availability and validation

<!-- Only the marked capability table is generated; edit scripts/docs/capabilities.json. -->

Use the running node's version and discovered capabilities. A supported baseline is a version reviewed for this guide, not a claim about the first release that introduced a feature. Newer source code and open proposals are separate from installed-package support. Minimum introduction versions remain unclaimed until release evidence establishes them.

<!-- BEGIN GENERATED: capabilities -->
| Capability | Availability | Supported baseline | Validation recorded | Owner | Reviewed |
| --- | --- | --- | --- | --- | --- |
| [First node + agent workflow](../getting-started/quickstart.md) | released baseline | 10.0.23 | CLI create/write/read/seal/share/query passed; framework conversation pending | DKG maintainers | 2026-10-13 |
| [HTTP application](../build/http-application.md) | released baseline | 10.0.23 | Released-package WM write/read, local SWM share, and committed-share replay passed; controlled error-response tests passed | DKG maintainers | 2026-10-14 |
| [Google OKF](../build/okf-tutorial.md) | released baseline | 10.0.23 | Mapping, WM import, local SWM share, completeness verification, and export passed | DKG maintainers | 2026-10-13 |
| [Two-node collaboration](../build/collaborate.md) | released baseline | 10.0.23 | Attempted; subscription blocked by chain/metadata authority; replication pending | DKG maintainers | 2026-10-13 |
| [Hermes](../integrations/hermes.md) | released baseline | 10.0.23 | Source reviewed; live framework session pending | DKG maintainers | 2026-10-13 |
| [OpenClaw](../integrations/openclaw.md) | released baseline | 10.0.23 | Source reviewed; live framework session pending | DKG maintainers | 2026-10-13 |
| [Prime Agent chat bridge](../integrations/prime-agent.md) | released baseline | 10.0.23 | Source and released CLI reviewed; live session pending; automatic memory not advertised | DKG maintainers | 2026-10-13 |
| [MCP clients](../integrations/mcp.md) | released baseline | 10.0.23 | Source reviewed; client conversation pending | DKG maintainers | 2026-10-13 |
| [Local models](../use-dkg/local-llm.md) | released baseline | 10.0.23 | Source reviewed; model execution pending | DKG maintainers | 2026-10-13 |
| [External signer](../use-dkg/external-signer.md) | source only | Not a released baseline | Merged after the validated 10.0.23 release ([PR #3177](https://github.com/OriginTrail/dkg/pull/3177)); runtime verification and a released minimum remain unclaimed | DKG maintainers | 2026-10-14 |
| [Neuro-symbolic reasoning, GNNs, and marketplace direction](../how-dkg-works/roadmap-and-convergence.md) | proposal | Not a released baseline | Public architecture and RFC reviewed; integrated reasoning/GNN services not claimed as released | DKG maintainers | 2026-10-14 |
<!-- END GENERATED: capabilities -->

The recorded runtime checks used an isolated, unfunded Edge node, the published 10.0.23 package, Oxigraph, and testnet configuration with relays disabled. They establish local CLI/HTTP behavior, not peer replication, a framework conversation, production load, or paid on-chain publication. See the [validation record](https://github.com/OriginTrail/dkg/blob/main/docs/reports/docs-builder-validation.md).

The [public marketplace RFC](https://github.com/OriginTrail/OT-RFC-repository/tree/main/RFCs/OT-RFC-27_NeuroSymbolic_Marketplace) describes proposals and prototype evidence. It is not an install guide for a generally available marketplace feature. Private planning documents are not part of the public operational contract. Consult the capability table and [External Signer guide](../use-dkg/external-signer.md) before using external signing with your installed version.
