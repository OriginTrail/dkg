// SPDX-License-Identifier: Apache-2.0

import { hostOnlyRpcText } from '@origintrail-official/dkg-chain';

/**
 * The longest reason a job failure carries, in UTF-16 code units (and therefore in characters):
 * the `failure.message` of a publish job and the `lastError.message` of a share job, in the stored
 * record and in every job and status view. The failure's machine code stays beside it unchanged.
 */
export const JOB_FAILURE_REASON_MAX_LENGTH = 512;

/** How much of a failure's text is read at all: the rest is dropped before anything else runs. */
const JOB_FAILURE_TEXT_READ_LIMIT = 65_536;

/**
 * The keys ethers v6 writes into the detail block it appends to an error message:
 * `<short message> (<key>=<JSON>, …, code=<CODE>, version=<x.y.z>)`. The block holds the
 * transaction, the JSON-RPC payload, the request and the response, and the request URL.
 */
const ETHERS_DETAIL_KEYS = [
  'action', 'argument', 'buffer', 'cancelled', 'code', 'count', 'data', 'error', 'event', 'expectedCount',
  'fault', 'hash', 'info', 'invocation', 'length', 'offset', 'operation', 'payload', 'reason', 'receipt',
  'replacement', 'request', 'response', 'revert', 'timeout', 'transaction', 'value',
].join('|');
/**
 * The close of a detail block: ethers always ends it with the error code and its own version. No two
 * quantifiers in it can take the same character, so a close that never comes costs linear work.
 */
const ETHERS_DETAIL_CLOSE = String.raw`code=([A-Z][A-Z0-9_]*), version=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*)?\)`;
const ETHERS_DETAIL_START = String.raw` \((?=(?:${ETHERS_DETAIL_KEYS})=)`;
const ETHERS_DETAIL_END = new RegExp(String.raw`\b${ETHERS_DETAIL_CLOSE}`, 'g');
const ETHERS_DETAIL_BLOCK = new RegExp(String.raw`${ETHERS_DETAIL_START}[\s\S]*?\b${ETHERS_DETAIL_CLOSE}`, 'g');
const ETHERS_DETAIL_OPEN = new RegExp(ETHERS_DETAIL_START);
/** The first JSON `"message"` in a detail block: the RPC node's own words, such as why it refused a transaction. */
const NODE_MESSAGE = /"message":\s*"((?:[^"\\]|\\.)*)"/;
/** Hex longer than a 32-byte hash: a signed transaction, calldata, revert data, a signature. */
const LONG_HEX_RUN = /(?:0x)?[0-9a-f]{65,}/gi;
const SPACE_OR_CONTROL_RUN = /[\s\p{Cc}]+/gu;

/** What a job failure records and shows (`reason`), and the text the local log may keep (`detail`). */
export interface JobFailureText {
  /** At most {@link JOB_FAILURE_REASON_MAX_LENGTH} characters: `detail`, cut with a trailing `…` when longer. */
  readonly reason: string;
  /** The whole failure text with the same parts taken out. Equal to `reason` unless the reason was cut. */
  readonly detail: string;
}

/**
 * A job failure's text, reduced to what a client may see. An ethers detail block (the transaction,
 * the JSON-RPC payload, the request and the response) is replaced by the RPC node's own message,
 * when it holds one, and its error code; every URL by its host; hex longer than 32 bytes by its
 * length; runs of whitespace and control characters by one space. A detail block that the read
 * limit cut before its close is dropped from its start. Linear in the text, and it never throws.
 */
export function jobFailureText(value: unknown): JobFailureText {
  let text = textOf(value);
  if (text.length > JOB_FAILURE_TEXT_READ_LIMIT) {
    text = `${withoutUnclosedDetails(text.slice(0, JOB_FAILURE_TEXT_READ_LIMIT))}…`;
  }
  const detail = hostOnlyRpcText(withoutEthersDetails(text))
    .replace(LONG_HEX_RUN, (run) => `[hex, ${Math.ceil(run.replace(/^0x/i, '').length / 2)} bytes]`)
    .replace(SPACE_OR_CONTROL_RUN, ' ')
    .trim();
  return { reason: cut(detail), detail };
}

/** The short reason a job failure records and shows: see {@link jobFailureText}. */
export function jobFailureReason(value: unknown): string {
  return jobFailureText(value).reason;
}

function textOf(value: unknown): string {
  try {
    return String(typeof value === 'string' ? value : value instanceof Error ? value.message : value ?? '');
  } catch {
    return '';
  }
}

/**
 * Replaces each ethers detail block with the RPC node's message, when the block holds one, and
 * ` (code=<CODE>)`. Only the text up to the last block's close is searched, so every block start
 * the search meets has a close after it, and the search stays linear in the length of the text.
 */
function withoutEthersDetails(text: string): string {
  const end = lastDetailEnd(text);
  if (end < 0) return text;
  return text.slice(0, end).replace(ETHERS_DETAIL_BLOCK, (block, code: string) => {
    const nodeMessage = NODE_MESSAGE.exec(block)?.[1];
    return `${nodeMessage === undefined ? '' : `: ${jsonStringText(nodeMessage)}`} (code=${code})`;
  }) + text.slice(end);
}

/**
 * Text cut at the read limit: a detail block opened after the last complete one lost its close to the
 * cut, so it cannot be told apart from the rest. Everything from its start is dropped.
 */
function withoutUnclosedDetails(text: string): string {
  const searched = Math.max(0, lastDetailEnd(text));
  const open = text.slice(searched).search(ETHERS_DETAIL_OPEN);
  return open < 0 ? text : text.slice(0, searched + open);
}

function lastDetailEnd(text: string): number {
  let end = -1;
  for (const match of text.matchAll(ETHERS_DETAIL_END)) end = (match.index ?? 0) + match[0].length;
  return end;
}

function jsonStringText(escaped: string): string {
  try {
    return String(JSON.parse(`"${escaped}"`));
  } catch {
    return escaped;
  }
}

function cut(text: string): string {
  if (text.length <= JOB_FAILURE_REASON_MAX_LENGTH) return text;
  let end = JOB_FAILURE_REASON_MAX_LENGTH - 1;
  const last = text.charCodeAt(end - 1);
  // Never split a surrogate pair: a lone half is not a character.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}
