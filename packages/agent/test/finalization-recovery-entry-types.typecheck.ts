import type {
  FinalizationRecoveryEntry,
  HistoricalFinalizationRecoveryEntry,
  UnverifiedFinalizationRecoveryEntry,
  VerifiedFinalizationRecoveryEntry,
} from '@origintrail-official/dkg-agent';

type EntryFields = Omit<
  UnverifiedFinalizationRecoveryEntry,
  'state' | 'verifiedEvidence'
>;

declare const fields: EntryFields;
declare const verifiedEvidence: VerifiedFinalizationRecoveryEntry['verifiedEvidence'];

const received: UnverifiedFinalizationRecoveryEntry = {
  ...fields,
  state: 'RECEIVED',
};
const verified: VerifiedFinalizationRecoveryEntry = {
  ...fields,
  state: 'VERIFIED',
  verifiedEvidence,
};
const settled: FinalizationRecoveryEntry = {
  ...fields,
  state: 'SETTLED',
  verifiedEvidence,
};
const historical: HistoricalFinalizationRecoveryEntry = {
  ...fields,
  state: 'SUPERSEDED',
};

// Evidence-bearing states cannot be constructed without evidence.
// @ts-expect-error VERIFIED entries require verifiedEvidence.
const missingEvidence: FinalizationRecoveryEntry = {
  ...fields,
  state: 'VERIFIED',
};

// Unverified states cannot carry chain-verified evidence.
// @ts-expect-error RECEIVED entries cannot carry verifiedEvidence.
const prematureEvidence: FinalizationRecoveryEntry = {
  ...fields,
  state: 'RECEIVED',
  verifiedEvidence,
};

export declare const pinned: [
  typeof received,
  typeof verified,
  typeof settled,
  typeof historical,
  typeof missingEvidence,
  typeof prematureEvidence,
];
