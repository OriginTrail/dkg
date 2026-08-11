import { types as utilTypes } from 'node:util';

import {
  escapeSparqlLiteral,
  isSafeIri,
  parseCanonicalDecimalU64,
} from '@origintrail-official/dkg-core';
import {
  assertAgentRootV1,
  assertNetworkIdV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSystemRecordAppliedStateV1,
  canonicalizeSystemRecordCapacityStateV1,
  canonicalizeSystemRecordMaterializationReceiptV1,
  canonicalizeSystemRecordRootClaimSetV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordCapacityStateDigestV1,
  computeSystemRecordMaterializationReceiptDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalSystemRecordAppliedStateV1,
  parseCanonicalSystemRecordCapacityStateV1,
  parseCanonicalSystemRecordMaterializationReceiptV1,
  parseCanonicalSystemRecordRootClaimSetV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordCapacityStateV1,
  type SystemRecordMaterializationReceiptV1,
  type SystemRecordRootClaimSetV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from './triple-store.js';
import {
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
} from './internal-graph-policy.js';

/**
 * Fixed RDF vocabulary for the private System Record V1 materializer.
 *
 * The values are deliberately module-internal. Callers hand the materializer
 * verified protocol objects; they never supply a graph, subject or predicate.
 * Canonical JSON remains the normative representation, while the surrounding
 * RDF gives Oxigraph exact indexed subjects for bounded CAS reads.
 */
const NS = 'urn:dkg:system-record-v1:';
const UTF8 = new TextEncoder();
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

export const SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH =
  'did:dkg:context-graph:agents' as const;

export const SYSTEM_RECORD_V1_JSON_DATATYPE = `${NS}canonical-json` as const;
export const SYSTEM_RECORD_V1_PREDICATES = Object.freeze({
  appliedState: `${NS}applied-state`,
  appliedStateDigest: `${NS}applied-state-digest`,
  /** Storage-local frontier; deliberately not part of the frozen B1 applied-state codec. */
  headVersion: `${NS}head-version`,
  ownedSubjectTable: `${NS}owned-subject-table`,
  ownedSubjectTableDigest: `${NS}owned-subject-table-digest`,
  pendingDeletionTable: `${NS}pending-deletion-table`,
  pendingDeletionTableDigest: `${NS}pending-deletion-table-digest`,
  rootClaimSet: `${NS}root-claim-set`,
  rootClaimSetDigest: `${NS}root-claim-set-digest`,
  capacityState: `${NS}capacity-state`,
  capacityStateDigest: `${NS}capacity-state-digest`,
  materializationEpoch: `${NS}materialization-epoch`,
  receipt: `${NS}materialization-receipt`,
  receiptDigest: `${NS}materialization-receipt-digest`,
  root: `${NS}root`,
  claimedBy: `${NS}claimed-by`,
  claimPosition: `${NS}claim-position`,
} as const);

export type SystemRecordMaterializationModeV1 = 'shadow' | 'authoritative';

export interface SystemRecordReservedStateQuadsV1 {
  readonly record: readonly Quad[];
  readonly capacity: readonly Quad[];
  readonly epoch: readonly Quad[];
  readonly receipt: readonly Quad[];
  readonly rootClaims: readonly Quad[];
}

export function systemRecordProjectionGraphV1(
  mode: SystemRecordMaterializationModeV1,
): string {
  if (mode === 'shadow') return SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH;
  if (mode === 'authoritative') return SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH;
  throw new Error('system-record materialization mode is invalid');
}

export function systemRecordRecordSubjectV1(networkId: string, stableKeyHash: string): string {
  return fixedSubject(networkId, `record:${digestToken(stableKeyHash)}`);
}

export function systemRecordCapacitySubjectV1(networkId: string): string {
  return fixedSubject(networkId, 'capacity');
}

export function systemRecordEpochSubjectV1(networkId: string): string {
  return fixedSubject(networkId, 'epoch');
}

export function buildSystemRecordMaterializationEpochQuadsV1(
  networkId: string,
  materializationEpoch: string,
): readonly Quad[] {
  assertNetworkIdV1(networkId);
  const canonicalEpoch = parseCanonicalDecimalU64(materializationEpoch).toString();
  if (canonicalEpoch !== materializationEpoch) {
    throw new Error('system-record materialization epoch must be canonical');
  }
  return freezeQuads([
    quad(
      systemRecordEpochSubjectV1(networkId),
      SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
      stringLiteral(canonicalEpoch),
      SYSTEM_RECORD_V1_STATE_GRAPH,
    ),
  ]);
}

export function systemRecordReceiptSubjectV1(networkId: string, stableKeyHash: string): string {
  return fixedSubject(networkId, `receipt:${digestToken(stableKeyHash)}`);
}

export function systemRecordRootClaimSubjectV1(networkId: string, root: string): string {
  assertAgentRootV1(root);
  return fixedSubject(networkId, `root:${base64Url(root)}`);
}

export function buildSystemRecordReservedStateQuadsV1(input: {
  readonly appliedState: SystemRecordAppliedStatePresentV1;
  readonly headVersion: string;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly pendingDeletionTable?: OwnedSubjectTableObjectV1;
  readonly rootClaimSet: SystemRecordRootClaimSetV1;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly receipt: SystemRecordMaterializationReceiptV1;
}): SystemRecordReservedStateQuadsV1 {
  const outer = snapshotBuildInput(input);
  const headVersion = parseCanonicalDecimalU64(outer.headVersion).toString();
  if (headVersion !== outer.headVersion) {
    throw new Error('reserved state head version must be canonical');
  }
  const stateBytes = canonicalizeSystemRecordAppliedStateV1(outer.appliedState);
  const appliedState = parseCanonicalSystemRecordAppliedStateV1(stateBytes);
  if (appliedState.state !== 'present') {
    throw new Error('reserved state requires one present applied state');
  }
  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(
    appliedState.currentRoot,
    outer.ownedSubjectTable,
  );
  const ownedSubjectTable = parseCanonicalOwnedSubjectTableObjectV1(
    appliedState.currentRoot,
    tableBytes,
  );
  const pendingDeletionTableBytes = outer.pendingDeletionTable === undefined
    ? undefined
    : canonicalizeOwnedSubjectTableObjectV1(
        appliedState.currentRoot,
        outer.pendingDeletionTable,
      );
  const pendingDeletionTable = pendingDeletionTableBytes === undefined
    ? undefined
    : parseCanonicalOwnedSubjectTableObjectV1(
        appliedState.currentRoot,
        pendingDeletionTableBytes,
      );
  const claimsBytes = canonicalizeSystemRecordRootClaimSetV1(outer.rootClaimSet);
  const rootClaimSet = parseCanonicalSystemRecordRootClaimSetV1(claimsBytes);
  const capacityBytes = canonicalizeSystemRecordCapacityStateV1(outer.capacityState);
  const capacityState = parseCanonicalSystemRecordCapacityStateV1(capacityBytes);
  const receiptBytes = canonicalizeSystemRecordMaterializationReceiptV1(outer.receipt);
  const materializationReceipt = parseCanonicalSystemRecordMaterializationReceiptV1(receiptBytes);

  if (computeSystemRecordAppliedStateDigestV1(appliedState)
      !== materializationReceipt.appliedStateDigest) {
    throw new Error('materialization receipt does not bind the applied state');
  }
  if (computeOwnedSubjectTableDigestV1(appliedState.currentRoot, ownedSubjectTable)
      !== appliedState.ownedSubjectTableDigest) {
    throw new Error('owned-subject table does not bind the applied state');
  }
  const expectedPendingDigest = appliedState.pendingDeletionTableDigest;
  if ((expectedPendingDigest === undefined) !== (pendingDeletionTable === undefined)) {
    throw new Error('pending deletion table presence does not bind the applied state');
  }
  if (pendingDeletionTable !== undefined && pendingDeletionTableBytes !== undefined
      && (computeOwnedSubjectTableDigestV1(appliedState.currentRoot, pendingDeletionTable)
          !== expectedPendingDigest
        || String(pendingDeletionTable.length) !== appliedState.pendingDeletionSubjectCount
        || String(pendingDeletionTableBytes.byteLength)
          !== appliedState.pendingDeletionTableBytes)) {
    throw new Error('pending deletion table does not bind the applied state');
  }
  if (computeSystemRecordRootClaimSetDigestV1(rootClaimSet)
      !== appliedState.rootClaimSetDigest) {
    throw new Error('root-claim set does not bind the applied state');
  }
  if (rootClaimSet.networkId !== appliedState.networkId
      || rootClaimSet.stableKeyHash !== appliedState.stableKeyHash
      || capacityState.networkId !== appliedState.networkId
      || materializationReceipt.networkId !== appliedState.networkId
      || materializationReceipt.stableKeyHash !== appliedState.stableKeyHash
      || materializationReceipt.stateRevision !== appliedState.stateRevision
      || materializationReceipt.headDigest !== appliedState.headDigest
      || materializationReceipt.materializationEpoch !== appliedState.materializationEpoch) {
    throw new Error('reserved state objects do not describe one materialization');
  }

  const graph = SYSTEM_RECORD_V1_STATE_GRAPH;
  const record = systemRecordRecordSubjectV1(
    appliedState.networkId,
    appliedState.stableKeyHash,
  );
  const capacity = systemRecordCapacitySubjectV1(appliedState.networkId);
  const receipt = systemRecordReceiptSubjectV1(
    appliedState.networkId,
    appliedState.stableKeyHash,
  );
  const roots = [rootClaimSet.currentRoot, ...rootClaimSet.historicalRoots];

  return Object.freeze({
    record: freezeQuads([
      quad(record, SYSTEM_RECORD_V1_PREDICATES.appliedState, jsonLiteral(stateBytes), graph),
      quad(
        record,
        SYSTEM_RECORD_V1_PREDICATES.appliedStateDigest,
        stringLiteral(computeSystemRecordAppliedStateDigestV1(appliedState)),
        graph,
      ),
      quad(record, SYSTEM_RECORD_V1_PREDICATES.headVersion, stringLiteral(headVersion), graph),
      quad(record, SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable, jsonLiteral(tableBytes), graph),
      quad(
        record,
        SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTableDigest,
        stringLiteral(appliedState.ownedSubjectTableDigest),
        graph,
      ),
      ...(pendingDeletionTableBytes === undefined || pendingDeletionTable === undefined
        ? []
        : [
          quad(
            record,
            SYSTEM_RECORD_V1_PREDICATES.pendingDeletionTable,
            jsonLiteral(pendingDeletionTableBytes),
            graph,
          ),
          quad(
            record,
            SYSTEM_RECORD_V1_PREDICATES.pendingDeletionTableDigest,
            stringLiteral(computeOwnedSubjectTableDigestV1(
              appliedState.currentRoot,
              pendingDeletionTable,
            )),
            graph,
          ),
        ]),
      quad(record, SYSTEM_RECORD_V1_PREDICATES.rootClaimSet, jsonLiteral(claimsBytes), graph),
      quad(
        record,
        SYSTEM_RECORD_V1_PREDICATES.rootClaimSetDigest,
        stringLiteral(appliedState.rootClaimSetDigest),
        graph,
      ),
    ]),
    capacity: freezeQuads([
      quad(capacity, SYSTEM_RECORD_V1_PREDICATES.capacityState, jsonLiteral(capacityBytes), graph),
      quad(
        capacity,
        SYSTEM_RECORD_V1_PREDICATES.capacityStateDigest,
        stringLiteral(computeSystemRecordCapacityStateDigestV1(capacityState)),
        graph,
      ),
    ]),
    epoch: buildSystemRecordMaterializationEpochQuadsV1(
      appliedState.networkId,
      appliedState.materializationEpoch,
    ),
    receipt: freezeQuads([
      quad(receipt, SYSTEM_RECORD_V1_PREDICATES.receipt, jsonLiteral(receiptBytes), graph),
      quad(
        receipt,
        SYSTEM_RECORD_V1_PREDICATES.receiptDigest,
        stringLiteral(computeSystemRecordMaterializationReceiptDigestV1(materializationReceipt)),
        graph,
      ),
    ]),
    rootClaims: freezeQuads(roots.flatMap((root, index) => {
      const claim = systemRecordRootClaimSubjectV1(appliedState.networkId, root);
      return [
        quad(claim, SYSTEM_RECORD_V1_PREDICATES.root, root, graph),
        quad(claim, SYSTEM_RECORD_V1_PREDICATES.claimedBy, record, graph),
        quad(
          claim,
          SYSTEM_RECORD_V1_PREDICATES.claimPosition,
          stringLiteral(index === 0 ? 'current' : `historical:${index - 1}`),
          graph,
        ),
      ];
    })),
  });
}

function snapshotBuildInput(input: unknown): {
  readonly appliedState: SystemRecordAppliedStatePresentV1;
  readonly headVersion: string;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly pendingDeletionTable?: OwnedSubjectTableObjectV1;
  readonly rootClaimSet: SystemRecordRootClaimSetV1;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly receipt: SystemRecordMaterializationReceiptV1;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || utilTypes.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('reserved-state build input must be a plain data object');
  }
  const hasPendingDeletionTable = Object.prototype.hasOwnProperty.call(
    input,
    'pendingDeletionTable',
  );
  const expected: readonly string[] = [
    'appliedState', 'headVersion', 'ownedSubjectTable', 'rootClaimSet', 'capacityState', 'receipt',
    ...(hasPendingDeletionTable ? ['pendingDeletionTable'] as const : []),
  ];
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new Error('reserved-state build input has unknown or missing fields');
  }
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('reserved-state build input fields must be enumerable data properties');
    }
    return descriptor.value;
  };
  return Object.freeze({
    appliedState: read('appliedState') as SystemRecordAppliedStatePresentV1,
    headVersion: read('headVersion') as string,
    ownedSubjectTable: read('ownedSubjectTable') as OwnedSubjectTableObjectV1,
    ...(hasPendingDeletionTable ? {
      pendingDeletionTable: read('pendingDeletionTable') as OwnedSubjectTableObjectV1,
    } : {}),
    rootClaimSet: read('rootClaimSet') as SystemRecordRootClaimSetV1,
    capacityState: read('capacityState') as SystemRecordCapacityStateV1,
    receipt: read('receipt') as SystemRecordMaterializationReceiptV1,
  });
}

function fixedSubject(networkId: string, suffix: string): string {
  assertNetworkIdV1(networkId);
  const iri = `${NS}${base64Url(networkId)}:${suffix}`;
  if (!isSafeIri(iri)) throw new Error('derived system-record subject is not a safe IRI');
  return iri;
}

function digestToken(value: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error('system-record digest is not canonical');
  return value.slice(2);
}

function base64Url(value: string): string {
  return Buffer.from(UTF8.encode(value)).toString('base64url');
}

function jsonLiteral(bytes: Uint8Array): string {
  return `"${escapeSparqlLiteral(FATAL_UTF8.decode(bytes))}"^^<${SYSTEM_RECORD_V1_JSON_DATATYPE}>`;
}

function stringLiteral(value: string): string {
  return `"${escapeSparqlLiteral(value)}"`;
}

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  if (!isSafeIri(subject) || !isSafeIri(predicate) || !isSafeIri(graph)) {
    throw new Error('derived system-record RDF IRI is unsafe');
  }
  return Object.freeze({ subject, predicate, object, graph });
}

function freezeQuads(quads: Quad[]): readonly Quad[] {
  return Object.freeze(quads);
}
