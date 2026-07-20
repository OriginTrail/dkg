import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { equalBytes, fromHex, hash, hex } from '../src/bytes.js';
import { decodeCanonical, encodeCanonical } from '../src/cbor.js';
import { decodeDifference, deriveReconciliationSeed, encodeSymbolCbor, encodeSymbols, mappingIndexForState } from '../src/iblt.js';
import {
  independentCborDecode,
  independentCborEncode,
  independentDecryptAesGcm,
  independentDerivePrivateObjectKey,
  independentMappingIndexForState,
  independentEncodeReplayConflictProjection,
  independentRoot,
  independentSymbols,
  independentVerifyWalObject
} from '../src/independent.js';
import {
  assembleRanges,
  authorFinalityRequirement,
  derivePrivateObjectKey,
  decryptAes256Gcm,
  parseWalObject,
  encodeReplayConflictProjection,
  validateRangeFrame,
  verifyTupleSignature,
  type RangeFrame,
  type ReplayConflictProjectionInput
} from '../src/reference.js';
import { createMembershipProof, setCommitmentRoot, verifyMembershipProof, type SetMembershipProof } from '../src/set-commitment.js';
import { DOMAINS, SCHEMA, TUPLES } from '../src/schema.js';
import {
  independentCanonicalNQuads,
  independentRdfLogicalKey,
  independentRdfStateDigest,
  independentRdfTouchedKey
} from '../src/rdf.js';
import { decodeUnsignedVarint, decodeWireFrame, encodeWireFrame, wireFramesEqual } from '../src/wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(await readFile(resolve(here, '../vectors/protocol-v1.json'), 'utf8'));
const invalidWalObjects = vectors.invalidWalObjects as Array<{ name: string; bytes: string; error: string }>;
const invalidWireFrames = vectors.wire.invalid as Array<{ name: string; expected: string; frame: string }>;
const replayConflictVectorCases = vectors.replayConflict as Array<{ name: string; input: any; expected: any }>;

function frame(name: 'first' | 'middle' | 'final' | 'eof'): RangeFrame {
  const value = vectors.ranges.valid[name];
  return {
    walObjectId: fromHex(value.walObjectId, 32),
    totalObjectLength: BigInt(value.totalObjectLength),
    offset: BigInt(value.offset),
    bytes: fromHex(value.bytes)
  };
}

function replayConflictInput(value: (typeof vectors.replayConflict)[number]): ReplayConflictProjectionInput {
  return {
    name: value.name,
    semanticStatus: value.input.semanticStatus,
    semanticActiveHeads: value.input.semanticActiveHeads.map((entry: string) => fromHex(entry, 32)),
    semanticConflictHeads: value.input.semanticConflictHeads.map((entry: string) => fromHex(entry, 32))
  };
}

describe('WalObjectV1 sole-atom contract', () => {
  it('has the exact frozen eight-field generic tuple and no DKG fields', () => {
    expect(TUPLES.WalObjectV1.fields).toEqual([
      'version',
      'namespaceId',
      'writerId',
      'writerEpoch',
      'sequence',
      'previousObjectIdOrNull',
      'payloadBytes',
      'signature'
    ]);
    const forbidden = /graph|rdf|sparql|swm|vm|policy|tier|chain|conflict/i;
    expect(TUPLES.WalObjectV1.fields.some((field) => forbidden.test(field))).toBe(false);
    expect(SCHEMA.atom.tuple).toBe('WalObjectV1');
    expect(SCHEMA.atom.setElement).toBe('WalObjectId');
  });

  it('is byte-identical in both TypeScript implementations', () => {
    const bytes = fromHex(vectors.walObjects.first.canonicalBytes);
    const reference = parseWalObject(bytes);
    const independent = independentVerifyWalObject(bytes);
    expect(hex(reference.id)).toBe(vectors.walObjects.first.walObjectId);
    expect(hex(independent.id)).toBe(vectors.walObjects.first.walObjectId);
    expect(hex(independent.payloadBytes)).toBe(vectors.walObjects.first.payloadBytes);
    expect(hex(independentCborEncode(independentCborDecode(bytes)))).toBe(hex(bytes));
  });

  it('changes whole-object identity when one payload byte changes', () => {
    expect(vectors.walObjects.onePayloadByteChanged.differsFromFirst).toBe(true);
    expect(vectors.walObjects.onePayloadByteChanged.walObjectId).not.toBe(vectors.walObjects.first.walObjectId);
  });

  it.each(invalidWalObjects)('rejects invalid fixture $name', (value) => {
    expect(() => parseWalObject(fromHex(value.bytes))).toThrow();
    expect(() => independentVerifyWalObject(fromHex(value.bytes))).toThrow();
  });

  it('rejects maps, floats, tags, indefinite values, and non-shortest values', () => {
    for (const value of ['a0', 'f90000', 'c100', '9f01ff', '1817']) {
      expect(() => decodeCanonical(fromHex(value))).toThrow();
      expect(() => independentCborDecode(fromHex(value))).toThrow();
    }
  });
});

describe('ProtocolV1 wire golden frames', () => {
  it('freezes every method request and response byte-for-byte', () => {
    expect(vectors.wire.methods).toHaveLength(11);
    for (const value of vectors.wire.methods) {
      const requestBytes = fromHex(value.requestFrame);
      const responseBytes = fromHex(value.responseFrame);
      const request = decodeWireFrame(requestBytes);
      const response = decodeWireFrame(responseBytes);
      expect(request.messageType, value.name).toBe(BigInt(value.requestType));
      expect(response.messageType, value.name).toBe(BigInt(value.responseType));
      expect(hex(request.requestId), value.name).toBe(value.requestId);
      expect(hex(response.requestId), value.name).toBe(value.requestId);
      expect(hex(encodeCanonical((request.body as any[])[1])), value.name).toBe(value.requestBodyCbor);
      expect(hex(encodeCanonical(response.body)), value.name).toBe(value.responseBodyCbor);
      expect(wireFramesEqual(decodeWireFrame(encodeWireFrame(request)), request), value.name).toBe(true);
      expect(wireFramesEqual(decodeWireFrame(encodeWireFrame(response)), response), value.name).toBe(true);
      expect(hex(encodeWireFrame(request)), value.name).toBe(value.requestFrame);
      expect(hex(encodeWireFrame(response)), value.name).toBe(value.responseFrame);
      const invalidRequest = decodeWireFrame(fromHex(value.invalidRequestFrame));
      expect((invalidRequest.body as any[])[1]).toHaveLength((request.body as any[])[1].length + 1);
    }
  });

  it('freezes every protocol error and all varint-width boundaries', () => {
    expect(vectors.wire.errors).toHaveLength(9);
    for (const value of vectors.wire.errors) {
      const decoded = decodeWireFrame(fromHex(value.frame));
      expect(decoded.messageType, value.name).toBe(255n);
      expect(hex(decoded.requestId), value.name).toBe(value.requestId);
      expect(hex(encodeCanonical(decoded.body)), value.name).toBe(value.bodyCbor);
      expect(hex(encodeWireFrame(decoded)), value.name).toBe(value.frame);
      expect((decodeWireFrame(fromHex(value.invalidFrame)).body as any[])).toHaveLength(4);
    }
    expect(vectors.wire.boundaries.map((value: any) => value.prefixLength)).toEqual([1, 2, 3]);
    for (const value of vectors.wire.boundaries) {
      const bytes = fromHex(value.frame);
      expect(decodeUnsignedVarint(bytes)).toEqual({ value: value.cborLength, byteLength: value.prefixLength });
      expect(hex(encodeWireFrame(decodeWireFrame(bytes)))).toBe(value.frame);
    }
  });

  it.each(invalidWireFrames)('rejects invalid wire fixture $name', (value) => {
    expect(() => decodeWireFrame(fromHex(value.frame))).toThrow();
  });
});

describe('whole-object range framing', () => {
  it('assembles duplicate and out-of-order ranges into exactly one complete object', () => {
    const expected = vectors.walObjects.first.canonicalBytes;
    expect(hex(assembleRanges([frame('final'), frame('first'), frame('middle')]))).toBe(expected);
    expect(hex(assembleRanges([frame('first'), frame('middle'), frame('middle'), frame('final')]))).toBe(expected);
  });

  it('accepts only a zero-length EOF sentinel', () => {
    expect(() => validateRangeFrame(frame('eof'))).not.toThrow();
    const invalid = { ...frame('eof'), offset: 0n };
    expect(() => validateRangeFrame(invalid)).toThrow(/zero-length/);
  });

  it('rejects dishonest lengths, bounds, overflow, and conflicting overlaps', () => {
    const first = frame('first');
    expect(() => validateRangeFrame({ ...first, totalObjectLength: first.totalObjectLength + 1n })).not.toThrow();
    expect(() => assembleRanges([{ ...first, totalObjectLength: first.totalObjectLength + 1n }, frame('middle'), frame('final')])).toThrow(/dishonest/);
    expect(() => validateRangeFrame({ ...first, offset: first.totalObjectLength + 1n, bytes: new Uint8Array() })).toThrow();
    expect(() => validateRangeFrame({ ...first, totalObjectLength: 0xffff_ffff_ffff_ffffn, offset: 0xffff_ffff_ffff_ffffn, bytes: Uint8Array.of(1) })).toThrow();
    const conflict = { ...first, bytes: new Uint8Array(first.bytes) };
    conflict.bytes[0] ^= 1;
    expect(() => assembleRanges([first, conflict, frame('middle'), frame('final')])).toThrow(/disagree/);
  });
});

describe('signed control statements', () => {
  it.each([
    ['authoritySet', DOMAINS.authoritySignature, DOMAINS.authorityId, 10, 'authoritySetId'],
    ['membershipCheckpoint', DOMAINS.membershipSignature, DOMAINS.membershipId, 13, 'membershipCheckpointId'],
    ['collectionHeadVector', DOMAINS.vectorSignature, DOMAINS.vectorId, 11, 'vectorId']
  ] as const)('verifies threshold-signed %s bytes and identity', (name, signatureDomain, identityDomain, unsignedArity, idField) => {
    const fixture = vectors.signedControl[name];
    const tuple = decodeCanonical(fromHex(fixture.canonicalBytes));
    expect(Array.isArray(tuple)).toBe(true);
    const value = tuple as any[];
    const entries = value.at(-1) as any[];
    expect(entries).toHaveLength(1);
    expect(verifyTupleSignature(signatureDomain, value.slice(0, unsignedArity), entries[0][1], entries[0][0])).toBe(true);
    expect(hex(hash(identityDomain, fromHex(fixture.canonicalBytes)))).toBe(fixture[idField]);
  });

  it('verifies the single-author checkpoint signature and identity', () => {
    const fixture = vectors.signedControl.authorCheckpoint;
    const tuple = decodeCanonical(fromHex(fixture.canonicalBytes)) as any[];
    expect(verifyTupleSignature(DOMAINS.checkpointSignature, tuple.slice(0, 12), tuple[12], tuple[2])).toBe(true);
    expect(hex(hash(DOMAINS.checkpointId, fromHex(fixture.canonicalBytes)))).toBe(fixture.checkpointId);
  });

  it('contains concrete stale-authority, vector-downgrade, and cutover-downgrade vectors', () => {
    expect(BigInt(vectors.authorityLifecycle.expiredAuthorityEvaluationTimeMs)).toBeGreaterThan(
      BigInt(vectors.authorityLifecycle.authorityExpiresAtMs)
    );
    const downgrade = decodeCanonical(fromHex(vectors.authorityLifecycle.vectorEpochDowngradeBytes)) as any[];
    expect(downgrade[4]).toBe(0n);
    const unsafeCutover = decodeCanonical(fromHex(vectors.cutover.invalidLegacySyncEnabledBytes)) as any[];
    expect(unsafeCutover[9]).toBe(false);
    expect(() => {
      if (unsafeCutover[9] !== true) throw new Error('legacySyncDisabled must be literal true');
    }).toThrow(/literal true/);
  });
});

describe('set commitment and proof framing', () => {
  const ids = vectors.setCommitments.split257.ids.map((value: string) => fromHex(value, 32));

  it('matches empty, one, split, and independent roots', () => {
    expect(hex(setCommitmentRoot([]))).toBe(vectors.setCommitments.empty.root);
    expect(hex(setCommitmentRoot([fromHex(vectors.setCommitments.one.ids[0], 32)]))).toBe(vectors.setCommitments.one.root);
    expect(hex(setCommitmentRoot(ids))).toBe(vectors.setCommitments.split257.root);
    expect(hex(independentRoot(ids))).toBe(vectors.setCommitments.split257.root);
  });

  it('verifies an odd-nibble proof and rejects malformed variants', () => {
    const raw = vectors.setCommitments.oddNibbleProof;
    const proof: SetMembershipProof = {
      id: fromHex(raw.walObjectId, 32),
      leafPrefixLength: raw.leafPrefixNibbleLength,
      leafIds: raw.leafIds.map((value: string) => fromHex(value, 32)),
      path: raw.path.map((level: any) => ({
        parentPrefixLength: level.parentPrefixNibbleLength,
        childBitmap: level.childBitmap,
        childNibble: level.childNibble,
        siblings: level.siblings.map((sibling: any) => ({ nibble: sibling.nibble, count: sibling.childCount, hash: fromHex(sibling.childHash, 32) }))
      }))
    };
    const root = fromHex(vectors.setCommitments.split257.root, 32);
    expect(proof.leafPrefixLength % 2).toBe(1);
    expect(verifyMembershipProof(proof, root)).toBe(true);
    const duplicate: SetMembershipProof = { ...proof, leafIds: [...proof.leafIds, proof.leafIds[0]] };
    expect(verifyMembershipProof(duplicate, root)).toBe(false);
    const wrongBitmap: SetMembershipProof = { ...proof, path: proof.path.map((level, index) => index === 0 ? { ...level, childBitmap: level.childBitmap ^ 1 } : level) };
    expect(verifyMembershipProof(wrongBitmap, root)).toBe(false);
    const wrongRoot = new Uint8Array(root);
    wrongRoot[0] ^= 1;
    expect(verifyMembershipProof(proof, wrongRoot)).toBe(false);
  });

  it('rejects duplicate set elements', () => {
    expect(() => setCommitmentRoot([ids[0], ids[0]])).toThrow(/duplicate/);
    expect(() => createMembershipProof([ids[0], ids[0]], ids[0])).toThrow(/duplicate/);
  });
});

describe('ProtocolV1IbltReconciliationAlgorithm', () => {
  const receiver: Uint8Array[] = vectors.iblt.receiverIds.map((value: string) => fromHex(value, 32));
  const provider: Uint8Array[] = vectors.iblt.providerIds.map((value: string) => fromHex(value, 32));
  const seed = fromHex(vectors.iblt.reconciliationSeed, 32);
  const count = vectors.iblt.minimumCompleteSymbolCount;

  it('freezes binary64 behavior at integer-conversion and operation boundaries', () => {
    for (const value of vectors.iblt.binary64MappingBoundaryCases) {
      const state = BigInt(value.state);
      expect(mappingIndexForState(state, value.index), value.name).toBe(value.nextIndex);
      expect(independentMappingIndexForState(state, value.index), value.name).toBe(value.nextIndex);
    }
  });

  it('derives the frozen seed and byte-identical symbols independently', () => {
    expect(hex(deriveReconciliationSeed(
      fromHex(vectors.iblt.requesterHeadId, 32),
      fromHex(vectors.iblt.providerHeadId, 32),
      fromHex(vectors.iblt.requesterNonce, 32)
    ))).toBe(vectors.iblt.reconciliationSeed);
    const reference = encodeSymbols(provider, seed, count);
    const independent = independentSymbols(provider, seed, count);
    expect(reference.map((symbol) => hex(encodeSymbolCbor(symbol)))).toEqual(vectors.iblt.providerSymbols.map((symbol: any) => symbol.cbor));
    expect(independent.map((symbol) => hex(encodeSymbolCbor(symbol)))).toEqual(vectors.iblt.providerSymbols.map((symbol: any) => symbol.cbor));
  });

  it('peels the exact symmetric difference and reproduces the provider root', () => {
    const result = decodeDifference(encodeSymbols(provider, seed, count), receiver, seed);
    expect(result.complete).toBe(true);
    expect(result.providerOnly.map(hex)).toEqual(vectors.iblt.expectedProviderOnly);
    expect(result.receiverOnly.map(hex)).toEqual(vectors.iblt.expectedReceiverOnly);
    const reconstructed = receiver.filter((id) => !result.receiverOnly.some((removed) => equalBytes(id, removed))).concat(result.providerOnly);
    expect(hex(setCommitmentRoot(reconstructed))).toBe(vectors.iblt.providerRoot);
  });

  it('never exposes a partial decode from an insufficient window', () => {
    if (count === 1) return;
    const result = decodeDifference(encodeSymbols(provider, seed, count - 1), receiver, seed);
    expect(result.complete).toBe(false);
    expect(result.providerOnly).toEqual([]);
    expect(result.receiverOnly).toEqual([]);
  });

  it('rejects duplicate IDs and signed-count overflow', () => {
    expect(() => encodeSymbols([provider[0], provider[0]], seed, count)).toThrow(/duplicate/);
    expect(() => encodeSymbolCbor({ index: 0, count: 1n << 63n, idXor: new Uint8Array(32), checksumXor: new Uint8Array(32) })).toThrow(/i64/);
  });
});

describe('adapter, replay/conflict, privacy, and finality vectors', () => {
  it('independently reproduces canonical RDF, state, logical-key, touched-key, policy, and mutation bytes', () => {
    const rdf = vectors.rdfAdapter;
    const canonical = independentCanonicalNQuads(rdf.canonicalization.input);
    expect(hex(canonical)).toBe(rdf.canonicalization.canonicalBytes);
    expect(new TextDecoder().decode(canonical)).toBe(rdf.canonicalization.canonical);
    expect(hex(independentRdfStateDigest(canonical))).toBe(rdf.canonicalization.stateDigest);
    expect(hex(independentRdfLogicalKey({
      contextGraphId: rdf.logicalKey.contextGraphId,
      subGraphName: rdf.logicalKey.subGraphName,
      authorAddress: fromHex(rdf.logicalKey.authorAddress, 20),
      entity: rdf.logicalKey.knowledgeAssetUalOrRootEntity
    }))).toBe(rdf.logicalKey.digest);
    for (const item of rdf.touchedKeys) {
      expect(hex(independentRdfTouchedKey(item.graphIri, item.subjectIri, item.predicateIri)))
        .toBe(item.digest);
    }
    const policy = [
      1n,
      BigInt(rdf.policy.adapterVersion),
      rdf.policy.allowedGraphPrefixes,
      BigInt(rdf.policy.maxQuadsPerMutation),
      BigInt(rdf.policy.maxWalObjectBytes),
      rdf.policy.singleValuedPredicates,
      rdf.policy.multiValuedPredicates,
      [],
      [],
      [],
      rdf.policy.allowedPayloadKinds.map(BigInt)
    ] as const;
    expect(hex(encodeCanonical(policy))).toBe(rdf.policy.canonicalBytes);
    const touched = rdf.publishReplace.touchedKeys.map((value: string) => fromHex(value, 32));
    const mutation = [
      1n,
      0n,
      independentRdfStateDigest(new Uint8Array()),
      fromHex(rdf.publishReplace.resultStateDigest, 32),
      [[rdf.publishReplace.graphIri, canonical, 2n]],
      [],
      new Uint8Array(),
      new Uint8Array(),
      touched,
      null
    ] as const;
    expect(hex(encodeCanonical(mutation))).toBe(rdf.publishReplace.rdfMutationBytes);
    expect(hex(encodeCanonical([
      1n,
      0n,
      fromHex(rdf.logicalKey.digest, 32),
      [],
      [],
      fromHex(rdf.publishReplace.policyObjectId, 32),
      mutation,
      null,
      null,
      null
    ]))).toBe(rdf.publishReplace.dkgMutationBytes);
  });

  it('freezes explicit expiry evidence and snapshot tombstones', () => {
    const expiryMutation = decodeCanonical(fromHex(vectors.rdfAdapter.expiryDelete.dkgMutationBytes)) as any[];
    expect(expiryMutation).toHaveLength(10);
    expect(expiryMutation[1]).toBe(BigInt(SCHEMA.enums.mutationOperation.DELETE));
    expect(expiryMutation[8]).toEqual([
      BigInt(vectors.rdfAdapter.expiryDelete.expiresAtMs),
      fromHex(vectors.rdfAdapter.expiryDelete.curatorVectorId, 32),
      null,
    ]);

    const manifest = decodeCanonical(fromHex(vectors.snapshot.manifestBytes)) as any[];
    const entries = manifest[9] as any[][];
    expect(TUPLES.SnapshotEntryV1.fields).toEqual([
      'logicalKey',
      'stateKind',
      'activeHeadIds',
      'stateDigest',
      'canonicalGraphBytes',
    ]);
    expect(entries.map(entry => Number(entry[1])).sort()).toEqual([
      vectors.snapshot.entryStates.LIVE,
      vectors.snapshot.entryStates.TOMBSTONE,
    ]);
    const tombstone = entries.find(entry => Number(entry[1]) === vectors.snapshot.entryStates.TOMBSTONE)!;
    expect(tombstone[4]).toEqual(new Uint8Array());
    expect(vectors.snapshot.envelopePayloadKind).toBe(SCHEMA.enums.payloadKind.SNAPSHOT_MANIFEST);
  });

  it('decrypts the fixed AES-GCM vector in independent implementations', async () => {
    const epochKey = fromHex(vectors.encryption.epochKey, 32);
    const coordinates = {
      namespaceId: fromHex(vectors.encryption.namespaceId, 32),
      writerId: fromHex(vectors.encryption.writerId, 20),
      writerEpoch: BigInt(vectors.encryption.writerEpoch),
      sequence: BigInt(vectors.encryption.sequence),
    };
    const key = derivePrivateObjectKey(epochKey, coordinates);
    expect(hex(key)).toBe(vectors.encryption.objectKey);
    expect(hex(await independentDerivePrivateObjectKey(
      epochKey,
      coordinates.namespaceId,
      coordinates.writerId,
      coordinates.writerEpoch,
      coordinates.sequence,
    ))).toBe(vectors.encryption.objectKey);
    const nonce = fromHex(vectors.encryption.nonce, 12);
    const ciphertext = fromHex(vectors.encryption.ciphertextAndTag);
    const associatedData = fromHex(vectors.encryption.associatedDataDigest, 32);
    expect(hex(decryptAes256Gcm(key, nonce, ciphertext, associatedData))).toBe(vectors.encryption.plaintext);
    expect(hex(await independentDecryptAesGcm(key, nonce, ciphertext, associatedData))).toBe(vectors.encryption.plaintext);
    const wrong = new Uint8Array(associatedData);
    wrong[0] ^= 1;
    expect(() => decryptAes256Gcm(key, nonce, ciphertext, wrong)).toThrow();
    await expect(independentDecryptAesGcm(key, nonce, ciphertext, wrong)).rejects.toThrow();
  });

  it.each(replayConflictVectorCases)('encodes shared-core replay/conflict projection $name in both implementations', (value) => {
    expect(Object.keys(value.input).sort()).toEqual([
      'semanticActiveHeads',
      'semanticConflictHeads',
      'semanticStatus',
    ]);
    const input = replayConflictInput(value);
    const reference = encodeReplayConflictProjection(input);
    const independent = independentEncodeReplayConflictProjection(input);
    expect(reference.status).toBe(value.expected.status);
    expect(independent.status).toBe(value.expected.status);
    expect(hex(reference.headDigest)).toBe(value.expected.headDigest);
    expect(hex(independent.headDigest)).toBe(value.expected.headDigest);
    expect(hex(reference.conflictDigest)).toBe(value.expected.conflictDigest);
    expect(hex(independent.conflictDigest)).toBe(value.expected.conflictDigest);
  });

  it('does not infer a DKG decision from a replay fixture name or head shape', () => {
    const head = fromHex('11'.repeat(32), 32);
    const statuses = ['apply', 'merge', 'conflict', 'pending'] as const;
    for (const semanticStatus of statuses) {
      const input: ReplayConflictProjectionInput = {
        name: 'same-protocol-shape',
        semanticStatus,
        semanticActiveHeads: [head],
        semanticConflictHeads: [],
      };
      expect(encodeReplayConflictProjection(input).status).toBe(semanticStatus);
      expect(independentEncodeReplayConflictProjection(input).status).toBe(semanticStatus);
    }
  });

  it('keeps private MOVE_TIER data out of the public target bytes', () => {
    const publicBytes = Buffer.from(vectors.moveTier.publicTargetPayload, 'hex');
    for (const forbidden of vectors.moveTier.forbiddenPublicValues) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'hex'))).toBe(false);
    }
    for (const forbidden of vectors.moveTier.forbiddenPublicText) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'utf8'))).toBe(false);
    }
    for (const forbidden of vectors.moveTier.forbiddenPublicScalarCbor) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'hex'))).toBe(false);
    }
  });

  it('cannot weaken current network finality', () => {
    for (const item of vectors.finality) {
      expect(authorFinalityRequirement(item.authorRequested, item.networkMinimum)).toBe(item.effective);
      expect(item.effective).toBeGreaterThanOrEqual(item.networkMinimum);
    }
  });
});
