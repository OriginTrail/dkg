# CONTEXT.md

Project-level vocabulary and domain context for AI coding agents. Skim this
before working on any subsystem you do not already know.

> This file evolves. When you introduce a new domain term or change an
> existing one, edit this file in the same commit.

---

## Repository shape

DKG is a pnpm + Turborepo monorepo. The Decentralized Knowledge Graph stack:
nodes, smart contracts, an SDK, and a CLI/daemon. 17 packages, with
`packages/cli` housing the daemon, HTTP API, and most user-facing flows.

See `ARCHITECTURE.md` for the current package map and per-subsystem
detail.

---

## Extraction subsystem (`packages/cli/src/extraction/`)

Markdown is the canonical content intermediate for the DKG memory pipeline.
A document arrives, gets normalised to markdown, and then two extraction
passes turn it into RDF triples that land in the agent's context graph.

### Layer 1 — structural extraction (deterministic)

`extractFromMarkdown()` in [packages/cli/src/extraction/markdown-extractor.ts](packages/cli/src/extraction/markdown-extractor.ts)
parses the markdown's frontmatter, sections, and explicit metadata and
emits triples that are byte-deterministic given the same input. The
resulting triples are **verifiable**: any party can re-run the extractor
on the same markdown and get the same output. Used for: document type,
title, sections, source-file provenance, declared keywords.

### Layer 2 — semantic extraction (LLM-assisted)

`extractWithLlm()` in [packages/cli/src/extraction/llm-extractor.ts](packages/cli/src/extraction/llm-extractor.ts)
sends the markdown to an LLM and asks it to emit N-Triples covering
**implicit** knowledge the structural pass cannot capture: claims in
prose, relationships between entities, quantitative facts. The output is
non-deterministic and carries explicit **extraction provenance** so
downstream consumers can distinguish it from Layer 1 triples and treat it
as **endorsable** rather than verifiable.

The Layer 2 pass is **best-effort and fail-soft**: missing API key,
upstream HTTP errors, timeouts, or malformed responses all return an
empty result and a `console.warn`. The caller never sees an exception.
Layer 1 alone is sufficient for the system to function.

### Provider abstraction

Layer 2 is provider-pluggable via the `LlmProvider` interface in
[packages/cli/src/extraction/llm-provider.ts](packages/cli/src/extraction/llm-provider.ts).
Shipped concrete providers:

- **`OpenAiProvider`** — `gpt-5-nano` default, `POST {baseURL}/chat/completions`
  with `Authorization: Bearer <apiKey>`. Default baseURL `https://api.openai.com/v1`.
- **`AnthropicProvider`** — `claude-sonnet-4-6` default, `POST {baseURL}/v1/messages`
  with `x-api-key: <apiKey>` and `anthropic-version: 2023-06-01`. Default
  baseURL `https://api.anthropic.com`.

Both providers share the same prompt and the same tolerant N-Triples
parser ([packages/cli/src/extraction/parse-ntriples.ts](packages/cli/src/extraction/parse-ntriples.ts)).
They differ only in HTTP transport and request/response shape translation.

### Provider selection

`extractWithLlm()` resolves the provider at call time. Precedence:

1. `process.env.DKG_EXTRACTION_PROVIDER` if set (`'openai'` or `'anthropic'`)
2. `llmConfig.provider` field
3. Default `'openai'`

Unknown values fall back to `'openai'` with a warning.

### Single caller

The only invocation site is the `POST /api/memory/turn` handler at
[packages/cli/src/daemon/routes/memory.ts](packages/cli/src/daemon/routes/memory.ts),
which wraps the call in a try/catch and merges the returned triples into
the turn's target graph.

---

## Glossary

| Term | Meaning |
|------|---------|
| **Layer 1 extraction** | Deterministic, structural extraction from markdown. Verifiable. |
| **Layer 2 extraction** | LLM-assisted semantic extraction. Non-deterministic. Endorsable, not verifiable. |
| **LlmProvider** | Interface implemented per LLM vendor. Owns the HTTP call and response parsing. |
| **Fail-soft** | A subsystem that returns a degraded result and logs, instead of throwing, when an upstream dependency fails. |
| **Extraction provenance** | Triples attached to a knowledge claim that say "agent X extracted this from markdown M with extractor V at time T". |
| **Triple** | RDF subject-predicate-object 3-tuple. |
| **N-Triples** | Line-oriented RDF serialisation. One triple per line, terminating in ` .`. |
