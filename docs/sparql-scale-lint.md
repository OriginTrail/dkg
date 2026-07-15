# SPARQL scalability lint

`scripts/sparql-scale-lint.mjs` + `.github/workflows/sparql-scale-lint.yml`
block PRs that **add** SPARQL queries matching shapes that have melted
production nodes before. It is a ratchet: pre-existing findings are
grandfathered and reported as notices; only newly added (or edited) offending
queries fail the check.

## Why

Every rule encodes a real incident class:

| Rule | Shape | Incident lineage |
|------|-------|------------------|
| `R1 unscoped-all-var-scan` | `?s ?p ?o` with no bound term outside any `GRAPH <iri>` scope | whole-store scans on hot paths |
| `R2 graph-var-scan` | an all-variable triple inside `GRAPH ?g` | the #1597 `listGraphs` sync storm (`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }` = every graph × every triple) |
| `R3 offset-pagination` | `OFFSET n` (n > 0 or interpolated) | O(offset) re-scan per page → O(n²) full walks, plus torn reads on mutable data (sync responder) |
| `R4 bucket-graph-scan` | all-variable scan over a graph family that grows with fleet usage (`…/_shared_memory`, `…/_meta`, data graph, `_catalog`) with no `LIMIT` | the #1609 unbounded SWM-slice `CONSTRUCT` |

What deliberately does **not** trigger:

- plain `ASK { ?s ?p ?o }` with no `FILTER` (first-match short-circuit);
- all-variable triples inside `FILTER [NOT] EXISTS` / `MINUS` — per-binding
  existence probes (the **fixed** #1597 `listGraphs` form lives here);
- `LIMIT` without `ORDER BY` (bounded materialization) for R1/R2;
- `GRAPH ?g` bound by `VALUES ?g { … }`;
- whole-graph reads of exact per-KA graphs (bounded by one assertion) —
  R4 keys on the *unbounded* graph families only;
- `CONSTRUCT`/`INSERT`/`DELETE` **templates** (output, not scan patterns);
- test/e2e/bench files.

## When the check fails

Restructure the query — exact graph scope, bind at least one term, keyset
(`FILTER(?key > lastKey) ORDER BY ?key LIMIT n`) instead of `OFFSET`, or add a
`LIMIT`. If the query is provably bounded (fixed-size graph, startup-only
migration, devnet tooling), acknowledge it **in code** with a justification:

```ts
// sparql-scan-allow: R4 -- catalog floor is capped at 64 triples per CG
const rows = await store.query(`SELECT ?s WHERE { GRAPH <${catalogGraph}> { ?s ?p ?o } }`);
```

or as a SPARQL comment inside the query itself:

```sparql
# sparql-scan-allow: R3 -- startup-only migration, store is idle
```

The rule id must match and the justification must be non-empty. The pragma is
deliberately a diffable code change: allowing a scan is a reviewed decision.

## Mechanics

- Findings are fingerprinted by `(rule, normalized query text)` — whitespace-
  and interpolation-insensitive, so moving or reindenting an existing query
  does not re-flag it, while editing the query re-evaluates it.
- The scanner self-tests against ~20 fixtures (including the exact #1597
  bad/fixed pair) before every CI scan; a broken scanner fails loudly instead
  of passing silently.
- Local usage:
  - `node scripts/sparql-scale-lint.mjs --diff origin/main HEAD` — what CI runs
  - `node scripts/sparql-scale-lint.mjs --all` — full-tree debt audit
  - `node scripts/sparql-scale-lint.mjs --files <paths…>` — spot-check
  - `node scripts/sparql-scale-lint.mjs --self-test`

## Making it required

The workflow alone reports; blocking needs the check in the branch
protection / ruleset required list (it already runs on `merge_group`, so the
merge queue will not stall):

```sh
gh api repos/OriginTrail/dkg/branches/main/protection/required_status_checks/contexts \
  -X POST -f "contexts[]=SPARQL scalability lint"
```

## Current debt baseline

At the time this gate landed, the full-tree audit reported ~52 grandfathered
findings (17 R1, 9 R2, 12 R3, 14 R4) — including the sync responder's
documented OFFSET fallback and several adapter-level store primitives. They
stay visible as notices on any PR that touches those files; burn them down
opportunistically (each either restructures or earns a pragma).
