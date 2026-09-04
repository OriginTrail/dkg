import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiQueryPriority } from './api-query-priority.js';
import { getApiQueryPriority } from './api-query-priority.js';

export const API_QUERY_CALLER_DISCONNECTED = 'API_QUERY_CALLER_DISCONNECTED';

export interface StoreQueryRequestLifecycle {
  readonly signal: AbortSignal;
  readonly priority: ApiQueryPriority;
  readonly source: string;
  dispose(): void;
}

class ApiQueryCallerDisconnectedError extends Error {
  readonly code = API_QUERY_CALLER_DISCONNECTED;

  constructor() {
    super('API query caller disconnected');
    this.name = 'ApiQueryCallerDisconnectedError';
  }
}

export function isApiQueryCallerDisconnected(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && (err as { code?: unknown }).code === API_QUERY_CALLER_DISCONNECTED,
  );
}

/** Share the admission lane and HTTP disconnect lifecycle across query routes. */
export function createStoreQueryRequestLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  source: string,
): StoreQueryRequestLifecycle {
  const controller = new AbortController();
  const abortDisconnectedQuery = () => {
    if (!controller.signal.aborted) {
      controller.abort(new ApiQueryCallerDisconnectedError());
    }
  };
  req.once('aborted', abortDisconnectedQuery);
  res.once('close', abortDisconnectedQuery);
  if (req.aborted || res.destroyed) abortDisconnectedQuery();

  return {
    signal: controller.signal,
    priority: getApiQueryPriority(),
    source,
    dispose() {
      req.removeListener('aborted', abortDisconnectedQuery);
      res.removeListener('close', abortDisconnectedQuery);
    },
  };
}
