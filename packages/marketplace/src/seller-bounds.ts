// SPDX-License-Identifier: Apache-2.0

/**
 * The most units a call's input can take (OT-RFC-27): its messages' UTF-8
 * bytes, which a tokenizer never exceeds, and an allowance per message and
 * per call for the chat template. A call with tools also counts its tools'
 * JSON bytes, `tool_choice`'s, an assistant's tool calls' and a tool result's
 * id, with an allowance per tool and one for the tools' preamble. The buyer's
 * gateway sets `maxUnits` to this and `max_tokens` (`unitsBound` in
 * gateway.ts). The seller checks a request's unit cap against it before its
 * backend runs: a cap the input could use up leaves nothing to answer with,
 * and the backend's work would go unpaid. A call without tools counts as in
 * 10.1.0.
 */
import type { InferenceBody } from './wire.js';

/** Units allowed per message for the chat template, and per call: the gateway's. */
export const UNITS_PER_MESSAGE = 8;
export const UNITS_PER_CALL = 16;
/** Units allowed per tool, and once for the tools' preamble, as a backend renders them into the prompt. */
export const UNITS_PER_TOOL = 8;
export const UNITS_FOR_TOOLS = 32;

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

export function inputUnitsBound(body: InferenceBody): bigint {
  let units = UNITS_PER_CALL;
  for (const m of body.messages) {
    units += bytesOf(m.content ?? '') + UNITS_PER_MESSAGE;
    if (m.role === 'assistant' && m.tool_calls) units += bytesOf(JSON.stringify(m.tool_calls));
    if (m.role === 'tool') units += bytesOf(m.tool_call_id);
  }
  if (body.tools) {
    units += UNITS_FOR_TOOLS + body.tools.length * UNITS_PER_TOOL + bytesOf(JSON.stringify(body.tools));
    if (body.tool_choice !== undefined) units += bytesOf(JSON.stringify(body.tool_choice));
  }
  return BigInt(units);
}
