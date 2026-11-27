import type { BuyerLedger, HeldReceipt, KeptReceipt, OpenReceipt, UnresolvedReceipt } from '../../src/index.js';
declare const ledger: BuyerLedger;
declare const held: KeptReceipt;
declare const open: OpenReceipt;
declare const unresolved: UnresolvedReceipt;
declare const unknownState: HeldReceipt;
void ledger.recordSent(open);
void ledger.recordUnresolved(open);
void ledger.recordUnresolved(unresolved);
void ledger.recordAccepted(held, 0);
// @ts-expect-error Accepted receipts require their atomic charge path.
void ledger.recordSent(held);
// @ts-expect-error Accepted receipts cannot bypass charging through an unresolved record.
void ledger.recordUnresolved(held);
// @ts-expect-error The initial record must be open, not possibly refused.
void ledger.recordSent(unresolved);
// @ts-expect-error The caller must narrow an unknown state.
void ledger.recordUnresolved(unknownState);
// @ts-expect-error An open call has no checked receipt to charge.
void ledger.recordAccepted(open, 0);
