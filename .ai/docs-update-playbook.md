---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Docs Update Playbook

When code behavior changes:

1. Update package-owned references if flags, routes, payloads, or setup behavior changed.
2. Update current docs if user-facing workflows, concepts, or operating rules changed.
3. Update `packages/cli/skills/dkg-node/SKILL.md` if agent tool/HTTP contracts changed.
4. Update Agent Context projections when current docs change.
5. Keep old-version docs in `docs/archive/<version>/`.
6. Do not link current docs or agent projections to old-version archive pages.
7. Run:

```bash
node scripts/docs/validate-docs-corpus.mjs
```

Current docs require front matter:

```yaml
status: current
version: v10
audience: human+agent
doc_type: how-to
```
