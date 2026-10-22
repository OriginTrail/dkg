// SPDX-License-Identifier: Apache-2.0
import { assertionLifecycleUri, decodeAssertionLifecycleUriOwner, contextGraphMetaUri, createGraphKnowledgeAssetScope,
  canonicalKnowledgeAssetGraphIdentitySuffix, normalizeAgentDid, toAgentDid } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ASSERTION_RESERVATION_PREDICATES as P, decodeAssertionLifecycleRecord,
  decodeAssertionReservationValue, decodeStoredAssertionReservedUal, type AssertionLifecycleRecord } from './assertion-lifecycle-record.js';
import { mq, lit, intLit } from './metadata-rdf-terms.js';

export { ASSERTION_RESERVATION_PREDICATES } from './assertion-lifecycle-record.js';
export interface AssertionReservationMetadata {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly assertionName: string;
  readonly subGraphName?: string;
  readonly kaNumber?: string | number | bigint;
  readonly reservedUal?: string;
}

/** Stable reservation fields only: no draft state, pointers, events or version. */
export function generateAssertionReservationMetadata(input: AssertionReservationMetadata): Quad[] {
  const subject = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.assertionName, input.subGraphName);
  const graph = contextGraphMetaUri(input.contextGraphId);
  const rows = [mq(subject, P.owner, toAgentDid(input.agentAddress), graph), mq(subject, P.name, lit(input.assertionName), graph)];
  if (input.kaNumber !== undefined) rows.push(mq(subject, P.number, intLit(BigInt(input.kaNumber)), graph));
  if (input.reservedUal) rows.push(mq(subject, P.ual, lit(input.reservedUal), graph));
  if (input.subGraphName) rows.push(mq(subject, P.subGraphName, lit(input.subGraphName), graph));
  return rows;
}

export interface AssertionPhysicalIdentity {
  readonly agentAddress: string;
  readonly number: bigint;
  readonly kaUal?: string;
}
export type AssertionReservationIdentity =
  | { readonly kind: 'reserved'; readonly identity: AssertionPhysicalIdentity }
  | { readonly kind: 'legacy-fallback'; readonly identity: AssertionPhysicalIdentity; readonly warning?: string }
  | { readonly kind: 'unallocated' }
  | { readonly kind: 'conflict'; readonly reason: string };

export function assertionPhysicalIdentityKey(identity: AssertionPhysicalIdentity): string {
  return canonicalKnowledgeAssetGraphIdentitySuffix(identity.agentAddress, identity.number);
}

/** The one physical-graph policy used by reads, allocation and restoration. */
export function resolveAssertionReservationIdentity(input: {
  readonly number: bigint | undefined;
  readonly reservedUal: string | undefined;
  readonly lifecycleOwner: string | undefined;
}): AssertionReservationIdentity {
  const { number, reservedUal, lifecycleOwner: owner } = input;
  if (number === undefined) return { kind: 'unallocated' };
  let warning: string | undefined;
  if (reservedUal) {
    try {
      const scope = createGraphKnowledgeAssetScope(reservedUal, 1);
      if (BigInt(scope.kaNumber) !== number) throw new Error(`reservedUal number ${scope.kaNumber} does not match kaId ${number}`);
      return { kind: 'reserved', identity: { agentAddress: scope.agentAddress, number, kaUal: scope.ual } };
    } catch (error) { warning = error instanceof Error ? error.message : String(error); }
  }
  if (owner === undefined) return { kind: 'conflict', reason: 'Cannot resolve the lifecycle owner of a legacy reservation' };
  return { kind: 'legacy-fallback', identity: { agentAddress: owner, number }, ...(warning === undefined ? {} : { warning }) };
}

export interface StoredAssertionLifecycleCoordinates {
  readonly contextGraphId: string;
  readonly lifecycleUri: string;
  readonly subGraphName?: string;
}

/** Infer a legacy owner only when the native subject and stable fields agree. */
export function resolveStoredAssertionLifecycleOwner(record: AssertionLifecycleRecord, coordinates: StoredAssertionLifecycleCoordinates): string | undefined {
  const { contextGraphId, lifecycleUri, subGraphName } = coordinates;
  if (contextGraphId === undefined || lifecycleUri === undefined) return undefined;
  const values = (predicate: string) => [...new Set(record.bindings.filter(row => row.p === predicate)
    .map(row => decodeAssertionReservationValue(predicate, row.o)))];
  const names = values(P.name), owners = values(P.owner).map(value => value === undefined ? undefined : normalizeAgentDid(value));
  const uniqueOwners = [...new Set(owners)];
  if (names.length !== 1 || !names[0] || uniqueOwners.length !== 1 || uniqueOwners[0] === undefined) return undefined;
  const owner = decodeAssertionLifecycleUriOwner(lifecycleUri, { contextGraphId, name: names[0], subGraphName });
  if (owner === undefined || normalizeAgentDid(toAgentDid(owner)) !== uniqueOwners[0]) return undefined;
  return owner;
}

/** RDF is decoded once by the normal record reader; aliases share its policy. */
export function decodeAssertionReservationIdentity(record: AssertionLifecycleRecord, lifecycleOwner: string | undefined): AssertionReservationIdentity {
  const numbers = record.bindings.filter(row => row.p === P.number)
    .map(row => decodeAssertionLifecycleRecord([row]).number);
  if (numbers.some(number => number !== record.number)) return { kind: 'conflict', reason: 'Contradictory KA reservation numbers' };
  const uals = record.bindings.filter(row => row.p === P.ual).map(row => decodeStoredAssertionReservedUal(row.o));
  const candidates = (uals.length === 0 ? [record.reservedUal] : uals).map(reservedUal => resolveAssertionReservationIdentity({
    number: record.number, reservedUal, lifecycleOwner,
  }));
  const keys = new Set(candidates.map(candidate => candidate.kind === 'reserved'
    ? `reserved:${candidate.identity.kaUal}` : candidate.kind === 'legacy-fallback'
      ? `legacy:${assertionPhysicalIdentityKey(candidate.identity)}` : candidate.kind));
  if (keys.size !== 1) return { kind: 'conflict', reason: 'Contradictory KA reservation identities' };
  return candidates[0]!;
}

/** Compare a stable projection field without replacing equivalent stored RDF. */
export function sameAssertionReservationField(expected: Quad, actual: string): boolean {
  if (expected.predicate === P.ual) {
    try { return createGraphKnowledgeAssetScope(decodeStoredAssertionReservedUal(actual), 1).ual
      === createGraphKnowledgeAssetScope(decodeStoredAssertionReservedUal(expected.object), 1).ual; }
    catch { return false; }
  }
  const value = decodeAssertionReservationValue(expected.predicate, actual);
  const desired = decodeAssertionReservationValue(expected.predicate, expected.object);
  return expected.predicate === P.owner ? value !== undefined && normalizeAgentDid(value) === desired : value !== undefined && value === desired;
}
