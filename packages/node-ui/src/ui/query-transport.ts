/** Finite transport budgets for automatic reads; console execution opts out. */
export const AUTOMATIC_QUERY_TIMEOUT_MS = 60_000;
export const AUTOMATIC_QUERY_MAX_BYTES = 8 * 1024 * 1024;

export class QueryResponseLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Query response exceeded ${maxBytes} bytes. Use a narrower query to inspect further data.`);
    this.name = 'QueryResponseLimitError';
  }
}

export async function fetchQueryJson(
  url: string,
  init: RequestInit,
  limits: { timeoutMs: number | null; maxResponseBytes: number | null },
  onResponse: (response: Response) => void,
): Promise<{ response: Response; body: unknown }> {
  for (const limit of [limits.timeoutMs, limits.maxResponseBytes]) {
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) throw new RangeError('Query budgets must be positive and finite, or explicitly null.');
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = limits.timeoutMs === null ? undefined : setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${Math.round(limits.timeoutMs! / 1000)}s`));
  }, limits.timeoutMs);
  const guard = <T,>(promise: Promise<T>) => Promise.race([promise, aborted]);
  const checkBytes = (bytes: number) => {
    if (limits.maxResponseBytes !== null && bytes > limits.maxResponseBytes) {
      const error = new QueryResponseLimitError(limits.maxResponseBytes);
      controller.abort(error); throw error;
    }
  };
  try {
    const response = await guard(fetch(url, { ...init, signal: controller.signal }));
    onResponse(response);
    const declared = response.headers?.get('Content-Length');
    if (declared && Number.isFinite(Number(declared))) checkBytes(Number(declared));
    if (!response.body?.getReader) {
      const body: unknown = await guard(response.json());
      checkBytes(new TextEncoder().encode(JSON.stringify(body)).byteLength);
      return { response, body };
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await guard(reader.read());
      if (done) break;
      size += value.byteLength; checkBytes(size); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    try { return { response, body: JSON.parse(text) }; }
    catch (error) { if (!response.ok && error instanceof SyntaxError) return { response, body: {} }; throw error; }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (controller.signal.aborted) void reader?.cancel(controller.signal.reason).catch(() => {});
    try { reader?.releaseLock(); } catch { /* A canceled read may still be settling. */ }
  }
}
