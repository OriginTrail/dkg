// The rehearsal's scenario parameters, shared by its phases.

import { TRAC } from '../../../test/helpers/conviction-service';

export { TRAC };

/** The commitment of the cycle's Conviction Account: the 30 % tier. */
export const COMMITTED = BigInt(process.env.COMMITTED ?? String(100_000n * TRAC));
/** An account left untouched, booked late. */
export const LATE_COMMITTED = 12_000n * TRAC;
/** A 7 TRAC cost at the 30 % tier. */
export const CA_SUBSCRIPTION_VALUE = 10n * TRAC;
export const WALLET_SUBSCRIPTION_VALUE = 5n * TRAC;
/** What the wallet buyer tops its subscription up by, once its budget is too low for a seller's batch. */
export const WALLET_TOP_UP = 3n * TRAC;
/** A wallet subscription no one serves, whose money rolls into the next epoch with value. */
export const ROLLED_VALUE = 1n * TRAC;
export const PUBLISH_BASE_COST = 20n * TRAC;
export const PUBLISH_KA_EPOCHS = 2n;
/** The buyer's grant limit. */
export const MAX_COST_PER_EPOCH = 1_000n * TRAC;
/** The sellers, real Core Nodes, by identity id. */
export const SELLERS = (process.env.SELLERS ?? '3,1').split(',').map((s) => BigInt(s));
/** An account PublishingConviction 10.0.8 scheduled, which keeps publishing as before. */
export const SCHEDULED_ACCOUNT = BigInt(process.env.SCHEDULED_ACCOUNT ?? '22');
