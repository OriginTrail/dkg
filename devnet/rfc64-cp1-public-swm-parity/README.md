# RFC-64 CP1 public SWM parity

This is the strict M1/CP1 gate. It boots one author and one receiver as separate
OS processes, each running the built production `DKGAgent`. Across the same two
processes it publishes one identical exact-set asset under both publicly
readable policy cells:

- public/open: `accessPolicy=0`, `publishPolicy=1`
- public/curated: `accessPolicy=0`, `publishPolicy=0`

The gate passes only when each receiver-side durable inventory is applied and
the exact activated N-Quads, content digest, and bundle digest are byte-equal
both to the authored corpus and across the two policy cells.

Run from the repository root:

```sh
pnpm test:m1:rfc64-public-swm-parity
```

The command performs a clean runtime build, runs the two-process proof, writes
`artifacts/cp1-public-swm-parity.json`, and verifies the closed evidence shape.

