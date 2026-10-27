// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri, assertSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
const DKG = 'http://dkg.io/ontology/';

export interface ConfirmedGraphKnowledgeAssetMetadataEnvelope {
  assertionVersion: string;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph: string;
  subGraphName?: string;
  merkleRoot: Uint8Array;
  /** Present for receipt-backed finalization; absent for locally chain-authenticated sync. */
  transactionHash?: string;
  batchId: bigint;
}

export type ConfirmedGraphKnowledgeAssetMetadataRead =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'confirmed'; envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope };


export function rdfLiteralLexicalValue(value: string): string | undefined {
  const match = /^("(?:\\.|[^"\\])*")/.exec(value);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}


function metadataObjectsByPredicate(
  rows: ReadonlyArray<{ predicate: string; object: string }>,
): Map<string, string[]> {
  const objects = new Map<string, string[]>();
  for (const row of rows) {
    const values = objects.get(row.predicate) ?? [];
    values.push(row.object);
    objects.set(row.predicate, values);
  }
  return objects;
}


function singleMetadataObject(
  objects: Map<string, string[]>,
  predicate: string,
): string | undefined {
  const values = objects.get(predicate) ?? [];
  return values.length === 1 ? values[0] : undefined;
}

function unsignedIntegerLiteral(value: string | undefined): bigint | undefined {
  const lexical = value === undefined ? undefined : rdfLiteralLexicalValue(value);
  if (lexical === undefined || !/^(0|[1-9]\d*)$/.test(lexical)) return undefined;
  try {
    return BigInt(lexical);
  } catch {
    return undefined;
  }
}

function bytes32Literal(value: string | undefined): Uint8Array | undefined {
  const lexical = value === undefined ? undefined : rdfLiteralLexicalValue(value);
  const hex = lexical?.replace(/^0x/i, '');
  if (hex === undefined || !/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}


/** Canonical projection for bounded readers of the confirmed envelope below. */
export const GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES: readonly string[] = Object.freeze([
  'contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount', 'batchId',
  'merkleRoot', 'privateMerkleRoot', 'assertionGraph', 'kaUal', 'status', 'transactionHash', 'subGraphName',
].map(name => `${DKG}${name}`));

/** Confirmed-only consumers retain their chain-provenance requirement. */
export function parseConfirmedGraphKnowledgeAssetMetadataEnvelope(
  rows: readonly Pick<Quad, 'predicate' | 'object'>[],
  input: { contextGraphId: string; ual: string },
): ConfirmedGraphKnowledgeAssetMetadataRead {
  const parsed = parseGraphKnowledgeAssetMetadataEnvelope(rows, input);
  return parsed.state === 'tentative' ? { state: 'invalid' } : parsed;
}

export type GraphKnowledgeAssetMetadataRead = ConfirmedGraphKnowledgeAssetMetadataRead
  | { state: 'tentative'; envelope: Omit<ConfirmedGraphKnowledgeAssetMetadataEnvelope, 'batchId'> & { batchId?: bigint } };

/** Parse the exact envelope, preserving tentative status for explicit no-chain consumers. */
export function parseGraphKnowledgeAssetMetadataEnvelope(
  rows: readonly Pick<Quad, 'predicate' | 'object'>[],
  input: { contextGraphId: string; ual: string },
): GraphKnowledgeAssetMetadataRead {
  const objects = metadataObjectsByPredicate(rows);
  if ((objects.get(`${DKG}contentScopeVersion`) ?? []).length === 0) return { state: 'absent' };

  const scopeVersion = unsignedIntegerLiteral(singleMetadataObject(
    objects,
    `${DKG}contentScopeVersion`,
  ));
  const assertionVersion = unsignedIntegerLiteral(singleMetadataObject(
    objects,
    `${DKG}assertionVersion`,
  ));
  const publicTripleCount = unsignedIntegerLiteral(singleMetadataObject(
    objects,
    `${DKG}publicTripleCount`,
  ));
  const privateTripleCount = unsignedIntegerLiteral(singleMetadataObject(
    objects,
    `${DKG}privateTripleCount`,
  ));
  const batchId = unsignedIntegerLiteral(singleMetadataObject(objects, `${DKG}batchId`));
  const merkleRoot = bytes32Literal(singleMetadataObject(objects, `${DKG}merkleRoot`));
  const privateRootValues = objects.get(`${DKG}privateMerkleRoot`) ?? [];
  const privateMerkleRoot = privateRootValues.length === 1
    ? bytes32Literal(privateRootValues[0])
    : undefined;
  const assertionGraph = singleMetadataObject(objects, `${DKG}assertionGraph`);
  const kaUal = singleMetadataObject(objects, `${DKG}kaUal`);
  const status = rdfLiteralLexicalValue(
    singleMetadataObject(objects, `${DKG}status`) ?? '',
  );
  const transactionHashValues = objects.get(`${DKG}transactionHash`) ?? [];
  const transactionHash = transactionHashValues.length === 1
    ? rdfLiteralLexicalValue(transactionHashValues[0])?.trim()
    : undefined;
  const subGraphValues = objects.get(`${DKG}subGraphName`) ?? [];
  const subGraphName = subGraphValues.length === 1
    ? rdfLiteralLexicalValue(subGraphValues[0])
    : undefined;

  if (
    scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)
    || assertionVersion === undefined
    || publicTripleCount === undefined
    || publicTripleCount > BigInt(Number.MAX_SAFE_INTEGER)
    || privateTripleCount === undefined
    || privateTripleCount > BigInt(Number.MAX_SAFE_INTEGER)
    || (status === 'confirmed' && batchId === undefined)
    || ((objects.get(`${DKG}batchId`) ?? []).length > 0 && batchId === undefined)
    || merkleRoot === undefined
    || assertionGraph === undefined
    || kaUal !== input.ual
    || (status !== 'confirmed' && status !== 'tentative')
    || transactionHashValues.length > 1
    || (transactionHashValues.length === 1
      && (transactionHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)))
    || privateRootValues.length > 1
    || (privateRootValues.length === 1 && privateMerkleRoot === undefined)
    || (privateTripleCount > 0n) !== (privateMerkleRoot !== undefined)
    || (publicTripleCount === 0n && privateTripleCount === 0n)
    || subGraphValues.length > 1
    || (subGraphValues.length === 1 && subGraphName === undefined)
  ) {
    return { state: 'invalid' };
  }

  let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  try {
    if (subGraphName !== undefined) if (!validateSubGraphName(subGraphName).valid) throw new Error('Unsafe sub-graph name');
    scope = createGraphKnowledgeAssetScope(input.ual, assertionVersion);
    assertSafeIri(assertionGraph);
  } catch {
    return { state: 'invalid' };
  }
  const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
    input.contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  if (assertionGraph !== expectedAssertionGraph) return { state: 'invalid' };

  const envelope = {
      assertionVersion: assertionVersion.toString(),
      publicTripleCount: Number(publicTripleCount),
      privateTripleCount: Number(privateTripleCount),
      ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
      assertionGraph,
      ...(subGraphName ? { subGraphName } : {}),
      merkleRoot,
      ...(transactionHash ? { transactionHash } : {}),
  };
  return status === 'confirmed'
    ? { state: 'confirmed', envelope: { ...envelope, batchId: batchId! } }
    : { state: 'tentative', envelope: { ...envelope, ...(batchId === undefined ? {} : { batchId }) } };
}

