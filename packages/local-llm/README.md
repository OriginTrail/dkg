# `@origintrail-official/dkg-local-llm`

Bounded local-model orchestration for the DKG MCP surface. The package talks to
an OpenAI-compatible `llama.cpp` endpoint and receives its tools dynamically
from MCP `tools/list`.

The runtime is read-only by default. It routes each turn to a small status,
query-catalog, or DKG-read tool profile instead of sending the complete MCP
surface into an 8K context window. Mutations require `allowWrite: true` and an
explicit mutation request.

It also provides:

- llama.cpp-safe JSON Schema normalization (`\\d` becomes `[0-9]` losslessly);
- local argument validation and one repair retry;
- repeated-call and tool-call-count guards;
- bounded chat history whose old evidence is never treated as fresh;
- plain-text interaction traces with secret redaction and `0600` permissions;
- system context v4.2, without benchmark fixtures or domain-specific IDs.

The package is a library. The umbrella `dkg llm` CLI owns MCP stdio lifecycle,
configuration, and operator-facing write opt-in.
