// OT-RFC-27 script support: the terms of the subscriptions the scripts fund and serve.

import { CLASS_INFERENCE, budget, serviceId } from '../../test/helpers/conviction-service';

/** The seller's price per unit, which the buyer accepts: 0.001 TRAC. */
export const UNIT_PRICE = 10n ** 15n;
/** Each budget's price cap per unit. */
export const PRICE_CAP = 10n ** 16n;
/** The one budget of every subscription here: an inference budget of index 0. */
export const SERVICE0 = serviceId(0);

/** A subscription's budgets: that one, of `value`. */
export const inference = (value: bigint) => [budget(0, CLASS_INFERENCE, value, PRICE_CAP)];
