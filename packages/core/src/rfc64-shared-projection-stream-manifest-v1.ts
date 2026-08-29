import {
  readVerifiedCatalogSealBindingV1,
  type VerifiedCatalogSealBindingV1,
} from './catalog-seal-binding.js';
import {
  CG_SHARED_PRIVATE_COMMITMENT_SUFFIX_V1,
} from './cg-shared-projection.js';
import {
  buildCatalogAssertionScopeV1,
  type CatalogLaneV1,
} from './author-catalog-codec.js';
import {
  assertCanonicalDeterministicUalV1,
} from './ka-content-scope.js';
import {
  MAX_KA_TRANSFER_BYTES_V1,
} from './ka-transfer-descriptor.js';
import {
  isPlainRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import type {
  CountV1,
  Digest32V1,
} from './sync-wire-scalars.js';

export const RFC64_SHARED_PROJECTION_STREAM_QUERY_ID_V1 =
  'SYNC_KA_SHARED_PROJECTION_STREAM_V1' as const;
export const RFC64_SHARED_PROJECTION_STREAM_CONCURRENCY_CLASS_V1 =
  'rfc64-shared-projection-v1' as const;
export const RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1 =
  Number(MAX_KA_TRANSFER_BYTES_V1);

export interface Rfc64SharedProjectionStreamTemplateInputV1 {
  readonly sealBinding: VerifiedCatalogSealBindingV1;
}

/**
 * Closed storage operation for one authenticated KA projection.
 *
 * The operation deliberately carries the verified catalog/seal coordinates
 * used to derive its physical graph. Callers cannot supply a graph, subject,
 * SPARQL template, signed ceiling, or protocol ceiling independently.
 */
export interface Rfc64SharedProjectionStreamOperationV1 {
  readonly queryId: typeof RFC64_SHARED_PROJECTION_STREAM_QUERY_ID_V1;
  readonly graphIri: string;
  readonly commitmentSubject: string;
  readonly projectionDigest: Digest32V1;
  readonly publicTripleCount: CountV1;
  readonly signedByteCeiling: number;
  readonly protocolByteCeiling: typeof RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1;
  readonly resultKind: 'canonical-line-byte-stream';
  readonly concurrencyClass: typeof RFC64_SHARED_PROJECTION_STREAM_CONCURRENCY_CLASS_V1;
  readonly sparql: string;
}

export class Rfc64SharedProjectionStreamManifestErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(`[rfc64-shared-projection-stream-schema] ${message}`, options);
    this.name = 'Rfc64SharedProjectionStreamManifestErrorV1';
  }
}

/**
 * Prefix-free physical graph for one RFC-64 shared projection.
 *
 * The legacy `{contextGraphId}[/{subGraphName}]` path is not injective when a
 * context-graph ID itself contains `/`. Reuse the catalog-v1 root/subgraph
 * discriminator and escaped context component so two authenticated lanes can
 * never resolve to the same graph.
 */
export function deriveRfc64SharedProjectionGraphIriV1(
  lane: CatalogLaneV1,
  kaUal: unknown,
): string {
  let ual: ReturnType<typeof assertCanonicalDeterministicUalV1>;
  try {
    ual = assertCanonicalDeterministicUalV1(kaUal);
  } catch (cause) {
    fail('shared-projection graph requires a canonical deterministic KA UAL', cause);
  }
  return `did:dkg:context-graph:${buildCatalogAssertionScopeV1(lane)}`
    + `/_shared_memory/${ual.agentAddress}/${ual.kaNumber}`;
}

/** Compile the sole exact-graph RFC-64 shared-projection stream. */
export function compileRfc64SharedProjectionStreamOperationV1(
  input: unknown,
): Rfc64SharedProjectionStreamOperationV1 {
  const request = snapshotInput(input);
  let sealBinding: ReturnType<typeof readVerifiedCatalogSealBindingV1>;
  try {
    sealBinding = readVerifiedCatalogSealBindingV1(request.sealBinding);
  } catch (cause) {
    fail('sealBinding was not minted by the catalog seal verifier', cause);
  }

  const catalogScope = sealBinding.catalogScope;
  const catalogRow = sealBinding.catalogRow;

  let ual: ReturnType<typeof assertCanonicalDeterministicUalV1>;
  try {
    ual = assertCanonicalDeterministicUalV1(sealBinding.seal.kaUal);
  } catch (cause) {
    fail('verified author seal does not carry a canonical deterministic KA UAL', cause);
  }
  if (
    ual.chainId !== catalogScope.networkId
    || ual.agentAddress !== catalogScope.authorAddress
  ) {
    fail('verified seal UAL does not belong to the catalog author lane');
  }

  const signedByteCeiling = Number(BigInt(catalogRow.transfer.byteLength));
  if (
    !Number.isSafeInteger(signedByteCeiling)
    || signedByteCeiling < 1
    || signedByteCeiling > RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1
  ) {
    fail('signed transfer byte ceiling is outside the protocol hard cap');
  }

  const graphIri = deriveRfc64SharedProjectionGraphIriV1(catalogScope, ual.ual);
  const commitmentSubject =
    `${ual.ual}${CG_SHARED_PRIVATE_COMMITMENT_SUFFIX_V1}`;

  return Object.freeze({
    queryId: RFC64_SHARED_PROJECTION_STREAM_QUERY_ID_V1,
    graphIri,
    commitmentSubject,
    projectionDigest: catalogRow.projectionDigest,
    publicTripleCount: sealBinding.seal.publicTripleCount,
    signedByteCeiling,
    protocolByteCeiling: RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
    resultKind: 'canonical-line-byte-stream' as const,
    concurrencyClass: RFC64_SHARED_PROJECTION_STREAM_CONCURRENCY_CLASS_V1,
    sparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  GRAPH <${graphIri}> {
    ?s ?p ?o .
  }
}`,
  });
}

function snapshotInput(input: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(input)) fail('shared-projection stream input must be a plain object');
  try {
    return snapshotExactDataRecord(
      input,
      ['sealBinding'],
      'RFC-64 shared-projection stream input',
    );
  } catch (cause) {
    fail('shared-projection stream input has an invalid field set', cause);
  }
}

function fail(message: string, cause?: unknown): never {
  throw new Rfc64SharedProjectionStreamManifestErrorV1(
    message,
    cause === undefined ? {} : { cause },
  );
}
