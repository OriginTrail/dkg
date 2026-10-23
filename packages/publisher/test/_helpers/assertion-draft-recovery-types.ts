import type { AssertionPullFromResult, AssertionDraftEvidence } from '../../src/index.js';

export function inspectRecovery(result: AssertionPullFromResult): AssertionDraftEvidence | undefined {
  if (result.recovered) {
    const evidence: AssertionDraftEvidence = result.draftEvidence;
    return evidence;
  }
  const evidence: undefined = result.draftEvidence;
  return evidence;
}

declare const fields: Omit<AssertionPullFromResult, 'recovered' | 'draftEvidence'>;
// @ts-expect-error Successful recovery must carry evidence.
const missingEvidence: AssertionPullFromResult = { ...fields, recovered: true };
// @ts-expect-error An ordinary seed cannot return recovery evidence.
const seedWithEvidence: AssertionPullFromResult = { ...fields, draftEvidence: {} as AssertionDraftEvidence };
void missingEvidence;
void seedWithEvidence;
