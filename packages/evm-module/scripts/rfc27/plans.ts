// OT-RFC-27 script support: the terms of the periods the scripts fund and serve.

import { CLASS_INFERENCE, bucket, bucketId } from '../../test/helpers/conviction-service';

/** The seller's ask per unit, which the buyer accepts: 0.001 TRAC. */
export const UNIT_ASK = 10n ** 15n;
/** Each bucket's price cap per unit. */
export const PRICE_CAP = 10n ** 16n;
/** The one bucket of every period here: an inference bucket of index 0. */
export const BUCKET0 = bucketId(0);

/** A period's buckets: that one, of `value`. */
export const inference = (value: bigint) => [bucket(0, CLASS_INFERENCE, value, PRICE_CAP)];
