export const DEFAULT_MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;

function responseTooLarge(maxBytes: number): Error {
  return new Error(`Local LLM response exceeds ${maxBytes} bytes`);
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Read one model response while enforcing the limit on encoded bytes. */
export async function readModelResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    if (BigInt(contentLength) > BigInt(maxBytes)) {
      await cancelBody(response);
      throw responseTooLarge(maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw responseTooLarge(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
