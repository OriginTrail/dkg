// SPDX-License-Identifier: Apache-2.0

/**
 * The most units a call's input can take (OT-RFC-27): its messages' UTF-8
 * bytes, which a tokenizer never exceeds, and an allowance per message and
 * per call for the chat template. The buyer's gateway sets `maxUnits` to this
 * and `max_tokens` (`unitsBound` in gateway.ts, with the same allowances).
 * The seller checks a request's unit cap against it before its backend runs:
 * a cap the input could use up leaves nothing to answer with, and the
 * backend's work would go unpaid.
 */
import type { InferenceBody } from './wire.js';

/** Units allowed per message for the chat template, and per call: the gateway's. */
export const UNITS_PER_MESSAGE = 8;
export const UNITS_PER_CALL = 16;

export function inputUnitsBound(body: InferenceBody): bigint {
  return BigInt(body.messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + UNITS_PER_MESSAGE, UNITS_PER_CALL));
}
