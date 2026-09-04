import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;

function responseTooLarge(maxBytes: number): Error {
  return new Error(`Local LLM response exceeds ${maxBytes} bytes`);
}

/** Read one model response while enforcing the limit on encoded bytes. */
export async function readModelResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  try {
    const bytes = await readResponseBodyBytesBounded(response, maxBytes);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof BoundedResponseBodyLimitError) throw responseTooLarge(maxBytes);
    throw error;
  }
}
