import { GRAPH_KA_CONTENT_SCOPE_VERSION, LegacyKnowledgeAssetReadOnlyError, type AssertionSeal } from '@origintrail-official/dkg-core';

/** Called under the publisher lifecycle lock before encoding, confirmation or SWM mutation. */
export function assertPromoteSeal(seal: AssertionSeal | null | undefined, subject: string,
  authorAgentAddress?: string): asserts seal is AssertionSeal & Required<Pick<AssertionSeal, 'kaUal' | 'assertionVersion' | 'publicTripleCount' | 'privateTripleCount'>> {
  if (!seal) throw Object.assign(new Error('Graph-scoped KA sharing requires a finalized v2 assertion seal'),
    { code: 'UNSEALED_SHARE_BLOCKED' });
  if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) throw new LegacyKnowledgeAssetReadOnlyError();
  if (!seal.kaUal || !seal.assertionVersion || seal.publicTripleCount === undefined || seal.privateTripleCount === undefined)
    throw new Error(`Graph-scoped assertion seal for <${subject}> is incomplete`);
  if (authorAgentAddress && seal.authorAddress.toLowerCase() !== authorAgentAddress.toLowerCase())
    throw Object.assign(new Error('The requested share author does not match the finalized assertion seal'),
      { code: 'KA_SHARE_AUTHOR_MISMATCH' });
}
