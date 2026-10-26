---
status: current
version: v10
audience: agent+human
doc_type: reference
---

# Recovering an exact WM draft after a lost pull response

A successful `wm/pull-from` can lose its HTTP response after writing public and private WM. An ordinary retry still returns `409 WM_DRAFT_CONFLICT`. Public quads or counts alone cannot prove that the private partition is complete. Keep an unproven draft unchanged.

Before the original pull, retain the accepted source's `kaUal`, `assertionVersion` and `merkleRoot` from its finalization result. An unpublished assertion version can be reused, so the root is required too.

## Authenticated exact recovery

Use the same authenticated actor, context graph, optional subgraph, name and source layer:

```http
POST /api/knowledge-assets/{name}/wm/pull-from
Authorization: Bearer <local token>
Content-Type: application/json
```

```json
{
  "contextGraphId": "<original context graph>",
  "layer": "swm",
  "onConflict": "reject",
  "recoverExact": {
    "kaUal": "<retained KA UAL>",
    "assertionVersion": "1",
    "merkleRoot": "0x<retained 32-byte root>"
  }
}
```

`layer` can also be `vm`. Supply the original `subGraphName` when applicable. Omit `onConflict` or use `reject`; recovery cannot be combined with `replace`.

The opt-in verifies an existing draft only. It never seeds, clears, finalizes or replaces it. Both the complete pinned source and current public/private draft partitions are checked against the same seal under the lifecycle lock. Superseded sources, missing private payload, equal-count wrong content and stray private WM for a public-only source are refused.

A successful response adds `recovered: true` and `draftEvidence`, binding context graph, optional subgraph, effective actor, name, layer, KA UAL, assertion version, public/private counts, combined `merkleRoot` and `privateMerkleRoot` (`null` for no private data). Private payload is never returned. Ordinary pull responses also include the accepted source's `merkleRoot`.

| Response | Meaning |
|---|---|
| `409 WM_DRAFT_NOT_EXACT` | Existing draft is absent, incomplete or conflicting; it was not modified |
| `409 WM_RECOVERY_SOURCE_UNAVAILABLE` | Pinned source is absent, invalid or superseded |
| `400 INVALID_PULL_RECOVERY_OPTIONS` | Pin is malformed or recovery was combined with replace |
| Retryable `503` | Store timeout, admission pressure or read transport prevented verification; bounded response excludes backend excerpts |
| `500 WM_RECOVERY_VERIFICATION_FAILED` | Unexpected verification failure; bounded response excludes private contents and exception causes |

Existing named-API authentication, scope and lifecycle error contracts still apply.

## CLI

```bash
dkg ka pull-from notes-doc -c my-project --layer swm \
  --recover-exact-ual '<retained-ual>' \
  --recover-exact-version '<retained-version>' \
  --recover-exact-root '<retained-root>' --json
```

## Snapshot limits

The evidence describes the draft while verification held the lifecycle lock. A write after that snapshot can invalidate it. This response is not a capability authorizing a later mutation: every later mutation must perform its own locked validation. Do not use public equality, counts or this snapshot to justify replacing an unproven draft.
