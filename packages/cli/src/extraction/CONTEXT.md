# Extraction subsystem — context

Markdown is the canonical content intermediate for the DKG memory pipeline.
A document arrives, gets normalised to markdown, and then two extraction
passes turn it into RDF triples that land in the agent's context graph.

## Layer 1 — structural extraction (deterministic)

`extractFromMarkdown()` in [markdown-extractor.ts](./markdown-extractor.ts)
parses frontmatter, sections, and explicit metadata; emits byte-deterministic
triples. **Verifiable** — any party re-running the extractor on the same
markdown gets the same output. Covers: document type, title, sections,
source-file provenance, declared keywords.

## Layer 2 — semantic extraction (LLM-assisted)

`extractWithLlm()` in [llm-extractor.ts](./llm-extractor.ts) sends the
markdown to an LLM and asks it for N-Triples covering **implicit** knowledge
the structural pass can't capture: claims in prose, entity relationships,
quantitative facts. Output is non-deterministic and carries extraction
provenance so consumers can distinguish it from Layer 1 (verifiable) and
treat it as **endorsable**.

**Best-effort and fail-soft**: missing apiKey, upstream HTTP errors,
timeouts, or malformed responses all return an empty result and a
`console.warn`. Never throws. Layer 1 alone is sufficient for the system
to function.

## Provider abstraction

Layer 2 is pluggable via the `LlmProvider` interface in
[llm-provider.ts](./llm-provider.ts). Shipped providers:

- **`openaiProvider`** — default `gpt-5-nano`. Reasoning models
  (`gpt-5*`, `o1*`, `o3*`, `o4*`) use `max_completion_tokens` +
  `reasoning_effort: 'low'`; legacy chat-completions models keep
  `max_tokens` + `temperature: 0.1`.
- **`anthropicProvider`** — default `claude-sonnet-4-6`. Uses the
  Messages API at `/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`.

Both share the prompt (`DOCUMENT_KG_PROMPT` in `llm-provider.ts`) and the
tolerant parser in [parse-ntriples.ts](./parse-ntriples.ts).

## Provider selection

Resolved at `extractWithLlm()` call time, in precedence order:

1. `process.env.DKG_EXTRACTION_PROVIDER` (`'openai'` or `'anthropic'`)
2. `LlmConfig.provider` field
3. Default `'openai'`

Unknown values warn and fall back to OpenAI.

## Caller

The only invocation site is the `POST /api/memory/turn` handler in
[../daemon/routes/memory.ts](../daemon/routes/memory.ts), which wraps the
call in a try/catch and merges the returned triples into the turn's
target graph.

## Glossary

| Term | Meaning |
|---|---|
| Layer 1 | Deterministic, structural extraction. Verifiable. |
| Layer 2 | LLM-assisted semantic extraction. Endorsable, not verifiable. |
| LlmProvider | Per-vendor interface; owns HTTP transport and response parsing. |
| Fail-soft | Returns a degraded result + logs instead of throwing on upstream failure. |
| Extraction provenance | Triples stating "agent X extracted this from markdown M with extractor V at time T". |
| Triple | RDF subject-predicate-object 3-tuple. |
| N-Triples | Line-oriented RDF serialisation, one triple per line, trailing ` .`. |
