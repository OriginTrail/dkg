# DKG Documentation Context

This context defines the product and documentation language for DKG V10. It is
used to keep human docs, agent docs, skills, and generated context packs aligned.

## Language

**DKG Node**:
The local DKG V10 daemon and tool surface that gives agents and applications access to working, shared working, and verified memory.
_Avoid_: DKG app, memory app

**Node Skill**:
An operational instruction artifact loaded into an agent so it can install, call, and troubleshoot a DKG node correctly.
_Avoid_: docs, manual, overview

**Docs Corpus**:
The broader explanatory documentation set that teaches DKG architecture, concepts, examples, operations, and references to agents and humans.
_Avoid_: skill, README only

**Overview-Led IA**:
A documentation structure that gives every reader a compact system map before routing them into tasks or deeper architecture.
_Avoid_: task-only docs, marketing homepage

**Task Route**:
A docs path organized around a user's intent, such as install DKG, connect an agent, publish knowledge, query memory, or troubleshoot sync.
_Avoid_: random guide, loose tutorial

**Architecture Backing**:
The concept and architecture pages that explain why task routes work and how DKG fits together as a system.
_Avoid_: background docs, optional theory

**Public Docs Nav**:
The visible website navigation organized around product and workflow intent rather than internal documentation taxonomy.
_Avoid_: index, generic IA labels only

**For AI Agents**:
A visible top-level docs section that exposes agent-oriented context, invariants, task packs, and generated retrieval endpoints.
_Avoid_: hidden agent docs, private prompt dump

**Doc Type Metadata**:
Internal page metadata that marks whether a page is a how-to, concept, reference, architecture explanation, invariant, or playbook.
_Avoid_: public nav label, page title

**Codebase Decision Record**:
An internal architectural or implementation decision record kept for maintainers and coding agents, not public docs readers.
_Avoid_: public docs page, product explainer

**Agent Context Pack**:
A curated or generated projection of the docs corpus optimized for agent retrieval and task execution.
_Avoid_: dumping all docs, raw archive ingestion

**Current Corpus**:
The subset of documentation that reflects the supported V10 behavior and should be retrievable by default.
_Avoid_: latest-looking docs, everything under docs/

**Archive Corpus**:
Historical documentation preserved for forensics but excluded from default human navigation and agent retrieval.
_Avoid_: stale current docs, hidden docs

**Version Archive**:
An archive path grouped by DKG version, such as `docs/archive/v9/` or `docs/archive/v8/`, for docs that do not describe current V10 behavior.
_Avoid_: mixed archive, stale docs in primary paths

**Current V10 Docs**:
The public docs corpus that describes supported V10 behavior and contains no links to older version docs.
_Avoid_: partially updated legacy docs, V9-linked V10 docs

## Relationships

- A **Node Skill** gives an agent the operational minimum for using the **DKG Node**.
- The **Docs Corpus** explains the **DKG Node** as a whole, including architecture, examples, concepts, and operational guidance beyond the **Node Skill**.
- **Overview-Led IA** gives humans and agents the map first, then **Task Routes**, then exact commands.
- **Task Routes** are supported by **Architecture Backing** so agents can reason beyond narrow command execution.
- **Public Docs Nav** uses product and workflow labels; **Doc Type Metadata** preserves retrieval and review discipline underneath.
- **For AI Agents** is visible in the **Public Docs Nav** so humans can inspect the agent-facing projections.
- **Codebase Decision Records** live under `.ai/adr/` by default; public docs get derived architecture pages only when needed.
- An **Agent Context Pack** is generated or curated from the **Current Corpus**, not from the **Archive Corpus**.
- Non-V10 docs belong in a **Version Archive**, not in primary docs paths.
- **Current V10 Docs** must not link to old version docs.
- The **Archive Corpus** remains accessible for humans doing historical research but must not pollute default agent answers.

## Example Dialogue

> **Dev:** "Should we put the full architecture explanation into the DKG node skill?"
> **Domain expert:** "No. The **Node Skill** should teach the operational contract. The **Docs Corpus** should explain the system deeply, and the **Agent Context Pack** should expose the right pieces to agents."

> **Dev:** "Should the docs start from tasks or architecture?"
> **Domain expert:** "Start with an **Overview-Led IA**: every agent gets the map first, then a **Task Route**, with **Architecture Backing** available when the task requires deeper reasoning."

## Flagged Ambiguities

- "Agent docs" can mean either the **Node Skill** or the broader **Agent Context Pack**. Resolved: the skill is the operational contract; docs/context packs provide broader explanation and examples.
- "Task-first docs" was too narrow for DKG. Resolved: the public docs should be overview-led, task-routed, and architecture-backed.
- "Guides", "Concepts", and similar Diataxis labels can mean public navigation labels or internal document types. Resolved: public navigation uses product/workflow labels, while Diataxis-style categories live in **Doc Type Metadata**.
- "For AI Agents" can be hidden generated infrastructure or a public section. Resolved: it is visible top-level navigation, backed by generated/curated projections from the current corpus.
- "Archive" can mean a generic folder or version-specific quarantine. Resolved: old docs move under versioned archive paths, and current V10 docs never reference them.
- "ADR" can mean public docs content or internal codebase memory. Resolved: repo-level ADRs are **Codebase Decision Records** under `.ai/adr/` unless a decision needs a separate public architecture explainer.
