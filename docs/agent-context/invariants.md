---
status: current
version: v10
audience: agent+human
doc_type: invariant
---

# Invariants

- Use the DKG Node Skill as the exact operational contract.
- Prefer tool or adapter calls over raw HTTP when the runtime exposes them.
- Working Memory is private; Shared Working Memory is peer-visible; Verified Memory is on-chain.
- Publish to Verified Memory only when finality is intended and funds are available.
- Query sub-graph-routed data with named graph patterns.
- Do not cite archive docs as current behavior.
- Do not route users to old setup, onboarding, deployment, or protocol-operation docs.
- Do not ask for admin tokens from remote machines; use local token discovery or agent registration.
- Keep current docs metadata at `status: current` and `version: v10`.
