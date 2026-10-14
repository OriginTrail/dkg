import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;

export class LocalModelContextLimitError extends Error {
  constructor(readonly contextTokens?: number) {
    super('LOCAL_LLM_CONTEXT_LIMIT');
  }
}

export function throwModelResponseError(status: number, body: string): never {
  // Only this explicit rejection is known to have occurred before inference.
  if (status === 400) {
    let failure: { error?: { type?: string; n_ctx?: number } } | undefined;
    try { failure = JSON.parse(body); } catch { /* Preserve the ordinary HTTP failure. */ }
    if (failure?.error?.type === 'exceed_context_size_error') {
      throw new LocalModelContextLimitError(failure.error.n_ctx);
    }
  }
  throw new Error(`Local LLM endpoint returned ${status}: ${body}`);
}

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

export function normalizeFinalAnswer(value: string): string {
  const withoutControls = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 0x08
        || codePoint === 0x0b
        || codePoint === 0x0c
        || (codePoint >= 0x0e && codePoint <= 0x1f)
        || codePoint === 0x7f
        || (codePoint >= 0x200b && codePoint <= 0x200d)
        || codePoint === 0x2060
        || codePoint === 0xfeff
      );
    })
    .join('');
  return withoutControls
    .replace(/<\|[^|>]{1,80}\|>/g, '')
    .split('\n')
    .filter((line) => !/^\s*[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\s]{2,}\s*$/u.test(line))
    .join('\n')
    .trim();
}
