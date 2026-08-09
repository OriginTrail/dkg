import {
  assertNetworkIdV1,
  SYSTEM_RECORD_MATERIALIZER_HARD_TIMEOUT_MS,
} from '@origintrail-official/dkg-core/system-record-v1';

import { OwnedManagedHttpClient } from './adapters/managed-http-client.js';
import {
  SPARQL_QUERY_CONTENT_TYPE,
  SPARQL_UPDATE_CONTENT_TYPE,
} from './adapters/sparql-content-types.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from './internal-graph-policy.js';
import {
  managedOxigraphOwnershipEndpointsMatchV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';
import {
  SYSTEM_RECORD_V1_PREDICATES,
  systemRecordEpochSubjectV1,
} from './system-record-rdf-schema-v1-internal.js';

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_EPOCH_QUERY_BYTES = 4 * 1024;
const MAX_EPOCH_UPDATE_BYTES = 4 * 1024;
const MAX_EPOCH_RESPONSE_BYTES = 8 * 1024;

export interface SystemRecordMaterializationEpochRotationV1 {
  readonly epoch: string;
  readonly childGeneration: string;
}

export interface SystemRecordMaterializationEpochRotationInputV1 {
  readonly networkId: string;
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  readonly client: OwnedManagedHttpClient;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
}

interface EpochReadResultV1 {
  readonly value: string | null;
}

const exactKeys = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return value as Record<string, unknown>;
};

export function isSystemRecordMaterializationEpochRotationV1(
  value: unknown,
): value is SystemRecordMaterializationEpochRotationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // STRUCTURAL, not exact-shape. `rotateMaterializationEpoch` is declared as
  // `Promise<void | { epoch: string; childGeneration: string }>`, and
  // TypeScript satisfies that with any object carrying those two fields — so
  // an implementation returning them alongside its own diagnostics is
  // CONFORMING. An exact `keys.length === 2` check rejected that and failed
  // the lane closed on a legitimate rotation, which is a stricter contract
  // than the one the type publishes.
  const record = value as Record<string, unknown>;
  return typeof record.epoch === 'string' && typeof record.childGeneration === 'string';
}

const denseArray = (value: unknown, max: number, label: string): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw new Error(`${label} must be a dense closed array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense closed array`);
    }
  }
  return value;
};

const canonicalU64 = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
    throw new Error(`${label} must be a canonical decimal u64`);
  }
  if (BigInt(value) > MAX_U64) throw new Error(`${label} exceeds u64`);
  return value;
};

const parseEpochResponse = (body: string): EpochReadResultV1 => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (cause) {
    throw new Error('materialization epoch query returned invalid JSON', { cause });
  }
  const root = exactKeys(decoded, ['head', 'results'], 'materialization epoch query response');
  const head = exactKeys(root.head, ['vars'], 'materialization epoch query head');
  const variables = denseArray(head.vars, 1, 'materialization epoch query variables');
  if (variables.length !== 1 || variables[0] !== 'epoch') {
    throw new Error('materialization epoch query returned an unexpected variable set');
  }
  const results = exactKeys(root.results, ['bindings'], 'materialization epoch query results');
  const bindings = denseArray(results.bindings, 2, 'materialization epoch query bindings');
  if (bindings.length === 0) return Object.freeze({ value: null });
  if (bindings.length !== 1) {
    throw new Error('materialization epoch has multiple persisted values');
  }
  const row = exactKeys(bindings[0], ['epoch'], 'materialization epoch query row');
  const term = exactKeys(row.epoch, ['type', 'value'], 'materialization epoch query term');
  if (term.type !== 'literal') {
    throw new Error('materialization epoch must be a plain literal');
  }
  return Object.freeze({ value: canonicalU64(term.value, 'materialization epoch') });
};

const assertOwnedGeneration = (
  input: SystemRecordMaterializationEpochRotationInputV1,
  expectedGeneration: string,
): void => {
  const snapshot = readManagedOxigraphOwnershipSnapshotV1(input.lease);
  if (
    snapshot === null ||
    snapshot.terminal ||
    !snapshot.ready ||
    snapshot.childGeneration !== expectedGeneration ||
    input.client.childGeneration !== expectedGeneration ||
    !managedOxigraphOwnershipEndpointsMatchV1(
      snapshot,
      input.queryEndpoint,
      input.updateEndpoint,
    )
  ) {
    throw new Error('managed Oxigraph ownership changed during materialization epoch rotation');
  }
};

const epochQuery = (subject: string): string =>
  `SELECT ?epoch WHERE { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ` +
  `<${subject}> <${SYSTEM_RECORD_V1_PREDICATES.materializationEpoch}> ?epoch . } } LIMIT 2`;

const epochUpdate = (subject: string, previous: string | null, next: string): string => {
  const triple = `<${subject}> <${SYSTEM_RECORD_V1_PREDICATES.materializationEpoch}>`;
  if (previous === null) {
    return `INSERT { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} "${next}" . } } ` +
      `WHERE { FILTER NOT EXISTS { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} ?existing . } } }`;
  }
  return `DELETE { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} "${previous}" . } } ` +
    `INSERT { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} "${next}" . } } ` +
    `WHERE { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} "${previous}" . } ` +
    `FILTER NOT EXISTS { GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { ${triple} ?other . ` +
    `FILTER (?other != "${previous}") } } }`;
};

async function readEpoch(
  input: SystemRecordMaterializationEpochRotationInputV1,
  expectedGeneration: string,
  query: string,
): Promise<EpochReadResultV1> {
  assertOwnedGeneration(input, expectedGeneration);
  const response = await input.client.post(
    input.queryEndpoint,
    SPARQL_QUERY_CONTENT_TYPE,
    query,
    SYSTEM_RECORD_MATERIALIZER_HARD_TIMEOUT_MS,
    undefined,
    {
      maxRequestBytes: MAX_EPOCH_QUERY_BYTES,
      maxResponseBytes: MAX_EPOCH_RESPONSE_BYTES,
    },
  );
  assertOwnedGeneration(input, expectedGeneration);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`materialization epoch query failed with HTTP ${response.status}`);
  }
  return parseEpochResponse(response.body);
}

/**
 * Durably advance the per-network agents materialization epoch.
 *
 * This function is called only inside the store-wide control barrier. It uses
 * the generation-owned client directly and therefore never re-enters the
 * ordinary store scheduler. The post-read is authoritative: it resolves a
 * response lost after commit, while every unchanged or competing state fails
 * closed before an activation facade can be published.
 */
export async function rotateSystemRecordMaterializationEpochV1(
  input: SystemRecordMaterializationEpochRotationInputV1,
): Promise<SystemRecordMaterializationEpochRotationV1> {
  const initial = readManagedOxigraphOwnershipSnapshotV1(input.lease);
  if (initial === null) throw new Error('managed Oxigraph ownership lease is unavailable');
  const expectedGeneration = initial.childGeneration;
  assertOwnedGeneration(input, expectedGeneration);

  assertNetworkIdV1(input.networkId);
  const subject = systemRecordEpochSubjectV1(input.networkId);
  const query = epochQuery(subject);
  const before = await readEpoch(input, expectedGeneration, query);
  const previous = before.value === null ? 0n : BigInt(before.value);
  if (previous === MAX_U64) throw new Error('materialization epoch cannot advance beyond u64');
  const next = (previous + 1n).toString(10);
  const update = epochUpdate(subject, before.value, next);

  assertOwnedGeneration(input, expectedGeneration);
  let updateFailure: unknown = null;
  try {
    const response = await input.client.post(
      input.updateEndpoint,
      SPARQL_UPDATE_CONTENT_TYPE,
      update,
      SYSTEM_RECORD_MATERIALIZER_HARD_TIMEOUT_MS,
      undefined,
      {
        maxRequestBytes: MAX_EPOCH_UPDATE_BYTES,
        maxResponseBytes: MAX_EPOCH_RESPONSE_BYTES,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      updateFailure = new Error(`materialization epoch update failed with HTTP ${response.status}`);
    }
  } catch (error) {
    updateFailure = error;
  }

  // Recheck before the recovery read. A listener replacement after an
  // indeterminate update must never be mistaken for the store that received it.
  assertOwnedGeneration(input, expectedGeneration);
  const after = await readEpoch(input, expectedGeneration, query);
  assertOwnedGeneration(input, expectedGeneration);
  if (after.value !== next) {
    throw new Error(
      `materialization epoch rotation did not commit the expected value ${next}`,
      updateFailure === null ? undefined : { cause: updateFailure },
    );
  }

  return Object.freeze({ epoch: next, childGeneration: expectedGeneration });
}
