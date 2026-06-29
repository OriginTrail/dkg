# `@origintrail-official/dkg-ip-oracle` — CONTEXT

Engineering harness for an **IP / Patent Context Oracle** built on the OKF→DKG
integration (`@origintrail-official/dkg-okf`). It generates a deterministic,
**synthetic** Google-Patents-shaped OKF corpus and feeds it into the DKG's
private memory layer.

## Why synthetic

The real source is the public BigQuery `patents-public-data` dataset. Building
the oracle does not require live BigQuery access: the generator reproduces the
shape (CPC class, jurisdictions, assignees, families, backward-citation DAG,
counts) deterministically from a seed. Every concept is stamped
`source: … [SIMULATED]` + `license: CC BY 4.0` so the redaction guard and the
public article never misrepresent generated data as real. Swapping in a real
BigQuery extractor later is a drop-in replacement for `patent-generator.ts`.

## Invariants (carried from the oracle design)

- **Content Context Graphs stay private.** The corpus is bulk-written to a
  PRIVATE Context Graph's Shared Working Memory (`accessPolicy: 1`,
  invite-only, off-chain) via `dkg okf import --private`. Gossip is restricted
  to allowlisted peers.
- **Substance never leaks.** `claim_chart_ref` / `essentiality_note` and any
  restrictively-licensed enrichment live ONLY in the private layer. The only
  public artifact is a minimal on-chain discoverability signal and, later,
  aggregated descriptors at collection granularity — and only for
  CC-BY/public-domain bibliographic fields, with attribution.
- **Access by invitation.** A requester is granted access by the curator
  inviting them into the private CG's SWM (optionally x402-gated) — never by
  making the content public.
- **Determinism.** Same seed ⇒ byte-identical corpus. No `Math.random()` /
  `Date.now()` in the generation path (mulberry32, index-scoped streams).
- **No silent on-chain spend.** Generation + private import are free and
  off-chain. VM descriptors, identity, and x402 settlement are separate,
  explicitly-gated steps.

## Scale

Start small (1k smoke), then 100k sample, then scale only after a cost gate.
`writePatentBundle` streams to disk so 100k–10M concepts stay memory-bounded;
the `--private` importer chunks SWM writes at 5,000 quads with a resumable,
chunk-indexed manifest and 413 → halve-and-retry.

## Surface

- `generatePatentBundle(opts)` — in-memory bundle (tests / small N).
- `writePatentBundle(opts, outDir)` — streamed-to-disk bundle (large N).
- `pubNumber(resolvedOpts, i)` — pure recompute of a patent's publication number.
- PRNG helpers (`mulberry32`, `streamFor`, `pick`, `intBetween`).
- CLI: `dkg ip-oracle generate <outDir> --count <n> --cpc-class <c> --seed <n>`.
