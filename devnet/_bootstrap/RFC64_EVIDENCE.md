# RFC-64 deterministic devnet evidence

`rfc64-evidence.ts` is a protocol-independent evidence layer for RFC-64 Gate 0+
devnet harnesses. It does not discover peers, transfer data, retry operations,
or modify runtime sync behavior. A harness supplies the expected and observed
Knowledge Asset datasets after its own operation completes.

## Deterministic snapshot rules

1. UALs are parsed with `parseDeterministicKnowledgeAssetUal`, converted to the
   canonical protocol spelling, rejected on duplicate canonical identity, and
   sorted lexically.
2. Each KA's semantic N-Quads are canonicalized with the existing RDFC-1.0
   helper, deduplicated, sorted lexically, joined with LF, and terminated by one
   LF when non-empty.
3. `ualsSha256` is SHA-256 over the sorted UAL list (`UAL + LF` per entry).
4. Each `semanticNQuadsSha256` is SHA-256 over that KA's exact canonical
   N-Quads UTF-8 bytes.
5. The snapshot-level semantic digest is SHA-256 over the domain string
   `rfc64-semantic-nquads-manifest/v1\n` followed by stable JSON containing the
   sorted `(UAL, quadCount, per-KA digest)` manifest.
6. The stable JSON writer recursively sorts object keys, uses two-space
   indentation, rejects lossy/non-finite values, and writes one trailing LF.

Snapshots contain KA and quad counts plus exact digests, without embedding the
potentially large N-Quads payload. Validation recomputes every redundant count
and manifest digest before comparison. Duplicate UALs, malformed snapshots,
missing KAs, unexpected KAs, count differences, and digest differences cannot
produce a passing comparison.

The run artifact adds the stable gate/observer label, selected source peer,
canonical ISO timing and duration, attempt/retry/failure details, expected and
observed snapshots, and the derived comparison. `passed` is derived from the
comparison and terminal failure; a caller cannot manually force it to `true`.

## Harness use

```ts
import {
  createRfc64DevnetEvidence,
  createRfc64SemanticSnapshot,
  writeStableJsonArtifact,
} from '@origintrail-official/dkg-devnet-harness/rfc64-evidence';

const expected = await createRfc64SemanticSnapshot(expectedAssets);
const observed = await createRfc64SemanticSnapshot(observedAssets);
const evidence = createRfc64DevnetEvidence({
  gate: 'gate-1-semantic-recovery',
  observer: 'receiver-node-2',
  sourcePeerId,
  startedAt,
  completedAt: new Date(),
  attemptCount,
  retryFailures,
  terminalFailure: null,
  expected,
  observed,
});

writeStableJsonArtifact(artifactPath, evidence);
if (!evidence.passed) throw new Error('RFC-64 evidence gate failed');
```

Run the focused no-devnet verification with:

```sh
pnpm test:devnet:rfc64-evidence
```
