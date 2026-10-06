// Repository-owned, bounded profiles. Case JSON supplies no commands or regexes.
// This register only maps case IDs to their definitions in cases/; what every
// profile shares is in profile-contract.mjs. Registering a case edits this file
// and so leaves the receipts of the existing cases valid.
import { withDerivedNames } from './profile-contract.mjs';
import onDemandCursor from './cases/GH-2782.mjs';
import peerStoreRepair from './cases/GH-2741.mjs';

export const PROFILES = Object.freeze({
  'agent-on-demand-cursor-v1': onDemandCursor,
  'agent-peer-store-repair-v1': peerStoreRepair,
});
export function profileFor(record) {
  const profile = PROFILES[record?.execution?.profile];
  if (!profile || record.id !== profile.caseId) throw new Error('unknown case/profile');
  return withDerivedNames(profile);
}
