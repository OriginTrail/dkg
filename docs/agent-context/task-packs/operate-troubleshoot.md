---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Operate and troubleshoot

Diagnose the failing layer before changing configuration. Preserve the node home, network, graph, KA, and job identifiers involved.

| Layer | Check | Next action |
| --- | --- | --- |
| Installation | `dkg doctor --json`, `dkg --version`, running status version | Resolve CLI/daemon skew or wrong home; do not modify unrelated checkouts |
| Daemon/store | `dkg status`, `dkg logs` | Verify storage readiness and pressure before retrying a workload |
| Runtime | Integration status and discovered tools | Restart the intended client/gateway if required; verify again |
| Identity/auth | `GET /api/agent/identity` with caller credentials | Confirm the intended agent; never request a remote admin token |
| Graph scope | Exact ID, selected view, membership, subscription | Correct scope; do not broaden access to make a query succeed |
| Ingestion | Extraction status and actual quads | Distinguish stored artifact from completed semantic extraction |
| Peers | `dkg peers`, `dkg peer info <peer-id>`, catch-up status | Check network, reachability, and subscription |
| Share/publish | Existing KA history and job details | Follow that operation's retry/ambiguity contract |
| Funds | `dkg wallet` and selected payer/PCA | Funding is for on-chain steps, not an explanation for every WM/query error |

Use status and the served skill on the configured endpoint; `127.0.0.1:9200` is only the default. Read-only health inspection should not rotate credentials or restart a healthy node.

**Done:** state the observed cause, the change actually made, and a repeated operation proving recovery. If recovery is blocked, retain the precise error/job evidence and identify the missing prerequisite. Do not claim a successful write or publish because a retry was accepted.
