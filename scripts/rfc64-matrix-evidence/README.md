# RFC-64 matrix evidence certification

This tool merges immutable first-attempt matrix evidence with later recovery
evidence without allowing rows from another run, Context Graph, or asset to
affect the result.

The previous ad-hoc certifier keyed recovery rows only by `lane:index`. Because
those ordinals repeat in every test run, passing a recovery JSONL from another
run could silently change the certified totals.

## Recovery evidence contract

Each recovery JSONL must contain exactly one `recovery_start` record with:

- the source manifest `runId`;
- the source manifest `datasetDigest`;
- the exact `contextGraphBindings` map from lane to Context Graph ID.

Every `recovery_result` must repeat:

- `runId` and `datasetDigest`;
- the exact `contextGraphId` for its lane;
- the immutable asset identity: `lane`, `index`, `name`, `subject`,
  `tripleCount`, and `expectedDigest`.

Use `createRecoveryStartEvidence` and `createRecoveryResultEvidence` from
`certification.mjs` when producing rows. The certifier fails closed on any
missing or mismatched binding and copies only explicitly allowed recovery
evidence fields. Recovery JSON cannot replace manifest identity.

## Certify

```bash
node scripts/rfc64-matrix-evidence/certify.mjs \
  --manifest runs/example.manifest.json \
  --recovery runs/example.recovery.jsonl \
  --output runs/example.certified.json
```

Multiple `--recovery` arguments are supported. When more than one valid row
targets the same CG-bound asset, the row with the strongest finalized/readback
result wins.

## Test

```bash
node --test scripts/rfc64-matrix-evidence/certification.test.mjs
```
