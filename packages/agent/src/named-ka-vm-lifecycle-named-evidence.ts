// SPDX-License-Identifier: Apache-2.0
import { buildAssertionSealQuads, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  type AssertionSeal, type CanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { assertConfirmedNamedAssertionSeal, confirmedNamedAssertionSealQuads, type ConfirmedGraphKnowledgeAssetProof } from '@origintrail-official/dkg-publisher';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-evidence.js';
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
const SUBJECT = 'urn:dkg:confirmed-lifecycle-seal';
const invalid = (): never => { throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed named assertion seal evidence'); };

/** Stable public wire for newly admitted confirmations; private plaintext never enters the journal. */
export function confirmedNamedSealQuads(seal: AssertionSeal, packedKaId: bigint): readonly Quad[] {
  return buildAssertionSealQuads({ ...seal, assertionUri: SUBJECT, metaGraph: '',
    reservedKaId: packedKaId, contentScopeVersion: 2, kaUal: seal.kaUal!, assertionVersion: seal.assertionVersion!,
    publicTripleCount: seal.publicTripleCount!, privateTripleCount: seal.privateTripleCount!, rootEntities: undefined });
}
export function lifecycleNamedSealWire(seal: CanonicalGraphScopedAuthorSealV1): readonly Quad[] {
  return confirmedNamedAssertionSealQuads(seal, SUBJECT, '');
}
/** Decode RDF only at admission/disk boundaries; execution consumes immutable canonical fields. */
export function normalizeConfirmedNamedSeal(value: unknown, input: ConfirmedNamedKaVmLifecycleInput,
  proof?: ConfirmedGraphKnowledgeAssetProof): CanonicalGraphScopedAuthorSealV1 {
  if (!Array.isArray(value) || value.some(q => !q || typeof q !== 'object'
    || q.subject !== SUBJECT || q.graph !== '' || typeof q.predicate !== 'string' || typeof q.object !== 'string')) return invalid();
  try {
    const seal = parseAssertionSealQuads(value, SUBJECT);
    if (!seal || seal.contentScopeVersion !== 2 || seal.reservedKaId !== input.packedKaId) return invalid();
    const terms = (quads: readonly Quad[]) => quads.map(q => JSON.stringify([q.predicate, q.object])).sort().join('\n');
    if (terms(value) !== terms(confirmedNamedSealQuads(seal, input.packedKaId))) return invalid();
    const canonical = canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
    assertConfirmedNamedAssertionSeal(canonical, { ...input, kaUal: input.materialization?.kaUal }, proof);
    return canonical;
  } catch { return invalid(); }
}
