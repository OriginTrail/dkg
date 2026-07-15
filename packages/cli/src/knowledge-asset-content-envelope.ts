export interface KnowledgeAssetContentEnvelope {
  contentScopeVersion?: number;
  kaUal?: string;
  assertionVersion?: string;
  publicTripleCount?: number;
  privateMerkleRoot?: string;
  privateTripleCount?: number;
}

export function serializeKnowledgeAssetContentEnvelope(
  envelope: KnowledgeAssetContentEnvelope,
): KnowledgeAssetContentEnvelope {
  return {
    ...(envelope.contentScopeVersion !== undefined
      ? { contentScopeVersion: envelope.contentScopeVersion }
      : {}),
    ...(envelope.kaUal !== undefined ? { kaUal: envelope.kaUal } : {}),
    ...(envelope.assertionVersion !== undefined
      ? { assertionVersion: envelope.assertionVersion }
      : {}),
    ...(envelope.publicTripleCount !== undefined
      ? { publicTripleCount: envelope.publicTripleCount }
      : {}),
    ...(envelope.privateMerkleRoot !== undefined
      ? { privateMerkleRoot: envelope.privateMerkleRoot }
      : {}),
    ...(envelope.privateTripleCount !== undefined
      ? { privateTripleCount: envelope.privateTripleCount }
      : {}),
  };
}

export function decodeKnowledgeAssetContentEnvelope(value: unknown): KnowledgeAssetContentEnvelope {
  const envelope = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return serializeKnowledgeAssetContentEnvelope({
    contentScopeVersion: finiteNumber(envelope.contentScopeVersion),
    kaUal: nonEmptyString(envelope.kaUal),
    assertionVersion: nonEmptyString(envelope.assertionVersion),
    publicTripleCount: finiteNumber(envelope.publicTripleCount),
    privateMerkleRoot: nonEmptyString(envelope.privateMerkleRoot),
    privateTripleCount: finiteNumber(envelope.privateTripleCount),
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
