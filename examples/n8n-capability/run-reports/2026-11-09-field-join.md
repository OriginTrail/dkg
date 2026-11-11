# Native field-join regression — 2026-11-09

The production `componentPiece()` generator was used to create and execute one
workflow containing eight independent cases through n8n's official import and
execute CLI. The engine was n8n **2.43.8**, on Node **24.22.0**, macOS arm64.
A new temporary SQLite state and an ephemeral loopback broker port were used;
the state was removed afterward. No running instance, partner records or account
credentials were used. Set, Split Out and Merge nodes executed; no Code node or
external task runner was needed.

Generated workflow SHA-256: `5857b70050bf508188d21e42806ae8a0806dcb90d5a80b00507609eaffcdb036`.

| Case | Output records | Full output assertion |
| --- | ---: | --- |
| outer | 3 | Passed |
| inner | 1 | Passed |
| nonmatches | 2 | Passed |
| duplicates-outer | 6 | Passed |
| duplicates-inner | 4 | Passed |
| duplicates-nonmatches | 2 | Passed |
| append | 4 | Passed |
| append-duplicates | 6 | Passed |

Each join compares `leftKey` on input A with `rightKey` on input B. Assertions
compare every output field as a multiset, retaining duplicate multiplicity. The
two-by-two duplicate matches produce four combined records; collisions prefer
input A. `keepNonMatches` asserts n8n's `_source: input1/input2` metadata. Both
append cases additionally assert the original input order and unchanged records.

Mutation check: changing the production field-join generator's `mode` from
`combine` to `append` caused the native `outer` output assertion to fail. The
production generator was restored; it is unchanged in this follow-up.

Reproduce with an installed n8n 2.43.8 package and its supported Node runtime:

```sh
node examples/n8n-capability/verify-field-join-native.mjs /path/to/node_modules/n8n /tmp/field-join-report.json
```

This is isolated native output-behavior evidence. It does not qualify a deployed
Studio instance, partner evidence, DKG write recovery or production operation.
