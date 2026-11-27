import type { DecimalU256V1 } from '@origintrail-official/dkg-core';
import type { ContextGraphAuthorityIndexId } from '../dist/chain-adapter.js';
import { assertContextGraphAuthorityIndexId } from '../dist/index.js';

declare const decimalU256: DecimalU256V1;
// @ts-expect-error A generic decimal u256 may be zero; index ids are positive.
const positiveId: ContextGraphAuthorityIndexId = decimalU256;

let ingress: unknown = '1';
assertContextGraphAuthorityIndexId(ingress);
const validatedId: ContextGraphAuthorityIndexId = ingress;

void [positiveId, validatedId];
