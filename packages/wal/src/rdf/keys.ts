import { hashCanonicalTupleV1 } from '../protocol/hashes.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { rdfError } from './errors.js';
import { canonicalizeAbsoluteIriV1 } from './nquads.js';
import type { RdfLogicalKeyCoordinatesV1 } from './types.js';

const UTF8_ENCODER = new TextEncoder();

function exactBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    rdfError('WAL_RDF_POLICY_INVALID', label + ' must be exactly ' + length + ' bytes');
  }
  return new Uint8Array(value);
}

function nfcText(value: string, maximumBytes: number, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || value !== value.normalize('NFC')
    || (!allowEmpty && value.length === 0)
    || UTF8_ENCODER.encode(value).length > maximumBytes
  ) {
    rdfError('WAL_RDF_POLICY_INVALID', label + ' must be bounded NFC text');
  }
  return value;
}

export function bytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function rdfLogicalKeyV1(input: RdfLogicalKeyCoordinatesV1): Uint8Array {
  const contextGraphId = nfcText(input.contextGraphId, 512, 'contextGraphId');
  const subGraphName = input.subGraphName === null
    ? null
    : nfcText(input.subGraphName, 128, 'subGraphName', true);
  const authorAddress = exactBytes(input.authorAddress, 20, 'authorAddress');
  const entity = canonicalizeAbsoluteIriV1(
    input.knowledgeAssetUalOrRootEntity,
    'knowledgeAssetUalOrRootEntity',
  );
  return hashCanonicalTupleV1('logicalKey', [
    contextGraphId,
    subGraphName,
    authorAddress,
    entity,
  ]);
}

export function rdfTouchedKeyV1(graphIri: string, subjectIri: string, predicateIri: string): Uint8Array {
  return hashCanonicalTupleV1('touchedKey', [
    canonicalizeAbsoluteIriV1(graphIri, 'touched graph IRI'),
    canonicalizeAbsoluteIriV1(subjectIri, 'touched subject IRI'),
    canonicalizeAbsoluteIriV1(predicateIri, 'touched predicate IRI'),
  ]);
}

export function isGraphAllowedByRdfPolicyV1(
  graphIri: string,
  policy: ProtocolTuple<'RdfPolicyV1'>,
): boolean {
  const graph = canonicalizeAbsoluteIriV1(graphIri, 'graph IRI');
  return policy[2].some(prefix => graph.startsWith(prefix));
}

export function assertRdfWriteAuthorizedV1(input: {
  readonly logicalKey: Uint8Array;
  readonly logicalKeyAuthor: Uint8Array;
  readonly writerId: Uint8Array;
  readonly memberWriterIds: readonly Uint8Array[];
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
}): void {
  const logicalKey = exactBytes(input.logicalKey, 32, 'logicalKey');
  const author = exactBytes(input.logicalKeyAuthor, 20, 'logicalKeyAuthor');
  const writer = exactBytes(input.writerId, 20, 'writerId');
  const writerIsMember = input.memberWriterIds.some(candidate =>
    candidate instanceof Uint8Array
    && candidate.length === 20
    && bytesEqualV1(candidate, writer));
  if (!writerIsMember) rdfError('WAL_RDF_UNAUTHORIZED', 'writer is not authorized by current membership');
  if (bytesEqualV1(author, writer)) return;
  const shared = input.policy[7].some(candidate => bytesEqualV1(candidate, logicalKey));
  if (!shared) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'cross-author logical-key write is not enabled by signed policy');
  }
}
