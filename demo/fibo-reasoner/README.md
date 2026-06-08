# FIBO Reasoner Demo — reasoning across the Chorus memory layers

A small, end-to-end demo that puts a **reasoner** (eye-js — the EYE reasoner
compiled to WebAssembly) inside the rc.17 **Working → Shared → Verifiable** memory
pipeline, using a **FIBO** corporate-control example.

## The story

The rc.17 "Chorus" model gives every Knowledge Asset a three-layer memory:

| Layer | Meaning |
|-------|---------|
| **Working Memory (WM)** | what an agent observed — local, unverified |
| **Shared Working Memory (SWM)** | promoted for the swarm to see and challenge |
| **Verifiable Memory (VM)** | anchored, provenance-backed, on chain |

This demo adds the missing verb. Agents assert plain ownership facts into WM.
eye-js applies a FIBO-style control ontology and **derives facts nobody
asserted**. Each inference is written with provenance (`prov:wasDerivedFrom` the
exact WM facts + the rule), promoted to SWM, and published to VM.

The example is corporate control:

```
  Acme Capital ──60%──▶ Bridge Holdings ──55%──▶ SmallCo
       │
       ├──10%──▶ SmallCo            (a tiny direct stake)
       └──30%──▶ Meridian Trading   (a minority stake)
```

No asserted fact says Acme controls SmallCo — on the cap table it owns 10%. The
reasoner derives `Acme indirectlyControls SmallCo` through Bridge: **concealed,
beneficial control**. Meanwhile the 30% Meridian stake produces nothing (below
the 50% threshold) — the rule encodes the law, not a guess.

## Why a reasoner (not an LLM) here

The daemon already has a `semantic-enrichment/write` path that attaches
`prov:wasDerivedFrom` / `generatedBy` provenance to *model-derived* triples. A
reasoner is a better citizen of it than an LLM: the output is **deterministic**
and the derivation is a **formal proof** you can replay and audit.

## Run it

```sh
pnpm install                         # picks up eyereasoner + n3 (added to demo/package.json)

node fibo-reasoner/run.mjs           # paced, narrated walkthrough (offline — always runs)
node fibo-reasoner/run.mjs --no-pause
node fibo-reasoner/run.mjs --json | jq .     # NDJSON, one line per step (agent-friendly)
```

Offline mode needs nothing but the install — eye-js runs in-process, no daemon,
no devnet. That's deliberate: the reasoning + layer narration is the same with
or without a live node, so it's safe to run on stage.

### Live mode (optional)

```sh
dkg start                            # healthy daemon + devnet required
node fibo-reasoner/run.mjs --live
```

`--live` additionally drives the real rc.17 lifecycle on a running node:

| Step | Endpoint |
|------|----------|
| WM write (one KA per ownership fact) | `POST /api/knowledge-assets` (auto-finalize) |
| SWM share (the inference + provenance) | `POST /api/knowledge-assets` `{alsoShareSwm:true}` |
| VM publish | `POST /api/knowledge-assets/:name/vm/publish` |
| read back | `dkg query <cg> --sparql … --include-shared-memory` |

Every live call is best-effort — a flaky devnet degrades to a warning, never an
abort. Set `FIBO_DEMO_CG=<cg-id>` to reuse an existing context graph, or
`DKG_HOME` to point at a non-default daemon home.

## Layout

```
fibo-reasoner/
  run.mjs                 orchestrator: 5 phases, --json / --no-pause / --live
  rules/control.n3        the entire reasoner — 2 N3 rules
  fixtures/fibo-slice.ttl  curated FIBO fragment (LegalEntity vocab)
  lib/
    data.mjs              entities + ownership facts (single source of truth)
    reasoner.mjs          eye-js wrapper + deterministic explain()
    narrative.mjs         the spoken story, one beat per phase
    live.mjs              best-effort WM→SWM→VM client
    format.mjs            self-contained terminal formatting
  test/reasoner.test.mjs  pins the inference (hidden control fires, minority doesn't)
```

Run the test: `pnpm --filter @origintrail-official/dkg-demo test:fibo`.

## Swap the domain

The reasoner is two rules in `rules/control.n3`. Replace them with supply-chain,
compliance, or eligibility rules and the same WM → reason → SWM → VM pipeline
applies — the memory model doesn't care what the inference is about.
