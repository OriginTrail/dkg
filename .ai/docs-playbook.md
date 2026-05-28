---
status: current
version: v10
audience: human+agent
doc_type: playbook
---

# Docs Playbook

Current docs must describe supported DKG V10 behavior. Historical docs belong under `docs/archive/<version>/`.

Required metadata for current pages:

```yaml
status: current
version: v10
audience: human+agent
doc_type: concept
```

Rules:

- Do not link current docs to old-version archive pages.
- Do not use archived docs to generate agent context.
- Keep the public overview human-readable and agent-usable.
- Use package READMEs for package-specific details.
- Use `packages/cli/skills/dkg-node/SKILL.md` for exact agent operations.
- Update `llms.txt` and `llms-full.txt` when the current docs IA changes.

Validation:

```bash
node scripts/docs/validate-docs-corpus.mjs
```
