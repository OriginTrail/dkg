---
status: current
version: v10
audience: agent+human
doc_type: invariant
---

# Invariants

- Use the DKG Node Skill as the exact operational contract.
- Prefer tool or adapter calls over raw HTTP when the runtime exposes them.
- Working Memory is private; Shared Working Memory is peer-visible; Verifiable Memory is on-chain.
- Publish to Verifiable Memory only when finality is intended and funds are available.
- Publish named Knowledge Assets from SWM with `dkg ka publish` / `publish-async` or `/api/knowledge-assets/{name}/vm/publish`; do not use direct-from-file VM publish or loose shared-memory write/publish recipes.
- Use `dkg pca ...` or `/api/pca/*` for Publishing Conviction Accounts; do not infer PCA ownership or agent registration without checking.
- Treat x402 paid access and context oracles as roadmap concepts unless the current Node Skill exposes the exact workflow.
- Query sub-graph-routed data with named graph patterns.
- Do not cite archive docs as current behavior.
- Do not route users to old setup, onboarding, deployment, or protocol-operation docs.
- Do not ask for admin tokens from remote machines; use local token discovery or agent registration.
- Keep current docs metadata at `status: current` and `version: v10`.
